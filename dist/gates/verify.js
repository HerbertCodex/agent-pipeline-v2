import { invariant } from '../domain/errors.js';
import { Git } from '../execution/git.js';
import { success } from '../engine/scheduler.js';
import { gatesConfigHash, stageGates } from './run.js';
import { mergeBase, repeatProofGap, resolveReference } from './repeat.js';
import { planScope } from './proof-scope.js';
import { sharedStore } from './store.js';
import { checkReuse, latest, readLocal, readShared, reuseContext, reuseReason } from './reuse-proof.js';
import { auditBase, changedBetween, webAuditGate, webImpact } from '../web/impact.js';
/**
 * Whether the receipts prove that every required check passed on this exact commit, on a clean tree and with
 * the current configuration of the checks. Receipts of any run count (a task run proves its checks as well as a
 * full one), but for each check only the latest such receipt does: a failure is never hidden by an older success.
 * At stage full, receipts of a targeted run (`targeted`, the `affected` command of a full check) never count.
 * At stage task, a full check that declares `affected` is required too: its targeted receipts count when their
 * run's base covers `base` (mandatory then), and so do its complete receipts; the latest of them decides.
 * Receipts are read from the worktree (`.apv/receipts/`), then from the shared store of the repository for the
 * runs the worktree does not have (a run proven in a worktree since removed): same requirements, and a shared
 * run counts only when intact (src/gates/store.ts).
 */
export async function verifyGates(options) {
    const git = new Git();
    const repo = await git.root(options.repo);
    const commit = await git.sha(repo, options.commit);
    const stage = options.stage ?? 'full';
    invariant(options.config.gates.length > 0, 'NO_GATES', 'No checks configured; declare gates in .apv/config.json');
    const staged = stageGates(options.config.gates, stage);
    const viaTargeted = new Set(staged.targeted.map(g => g.id));
    // Configuration order, the targeted checks in their place.
    const required = options.config.gates.filter(g => staged.run.includes(g) || viaTargeted.has(g.id)).map(g => g.id);
    invariant(required.length > 0, 'NO_GATES', `No check of stage ${stage} is configured: nothing to verify`);
    invariant(!viaTargeted.size || options.base, 'GATE_BASE', `Targeted checks (${[...viaTargeted].join(', ')}) are verified against a base: pass --base <ref> (the last commit the full suite proved)`);
    const base = viaTargeted.size && options.base ? await git.sha(repo, options.base) : null;
    const configHash = gatesConfigHash(options.config);
    const local = readLocal(repo);
    const store = await sharedStore(git, repo);
    const shared = readShared(store, local.runs, named => named === null || named === commit);
    const found = [...local.found, ...shared.found];
    const { unreadable } = local;
    const atCommit = found.filter(f => f.receipt.candidateSha === commit);
    // Whether a targeted run from `runBase` covered the changes since `base`: same commit, or an ancestor of it.
    const covered = new Map();
    const covers = async (runBase) => {
        if (!runBase || !base)
            return false;
        if (!covered.has(runBase))
            covered.set(runBase, runBase === base || await git.contains(repo, base, runBase));
        return covered.get(runBase);
    };
    /**
     * Why a successful receipt of a check that declares `repeatChanged` does not prove the repetition of the changed test
     * files at this commit, or null when it does. The files are recomputed here, from the commit, against the base the
     * run recorded and, for a complete receipt at stage full, against the reference: a run without a base, with a base
     * equal to the commit, or with a base too close to leave out some changed tests never proves the check.
     */
    const references = new Map();
    const repeatGap = async (settings, receipt, full) => {
        let reference = null;
        if (full) {
            const name = options.repeatReference ?? settings.reference;
            if (!references.has(name))
                references.set(name, await resolveReference(git, repo, name));
            reference = { name, ...references.get(name) };
        }
        return repeatProofGap(git, repo, commit, settings, receipt.repeat, reference);
    };
    /**
     * The scope of a receipt `not_required`, recomputed here from the commit: never taken from the receipt. The base the run
     * recorded (it must not be the commit, nor below it), the reference of the configuration (or the one passed), the paths
     * read at that reference: the check is proven not required only when this recomputation says so.
     */
    const scopeGap = async (gate, receipt) => {
        const need = (reason) => ({ required: true, reason, files: [], blocking: [] });
        if (!gate.skipWhenOnly)
            return need('le contrôle ne déclare plus skipWhenOnly : il est requis');
        const base = receipt.scope?.base;
        if (!base)
            return need('reçu sans base : la portée ne se recompte pas');
        if (base === commit || await mergeBase(git, repo, base, commit) === commit)
            return need('base égale au commit ou en aval : aucun changement à comparer');
        const name = options.reference ?? gate.skipWhenOnly.reference;
        const resolved = await resolveReference(git, repo, name);
        if (!resolved.sha)
            return need(`référence ${name} ${resolved.reason} (skipWhenOnly.reference) : la portée ne se recompte pas`);
        const d = (await planScope(git, repo, options.config, { base, head: commit, reference: name, configFile: options.configFile ?? null })).get(gate.id);
        if (!d)
            return need('portée non recalculée');
        return { required: d.required, reason: d.reason, files: d.files, blocking: d.blocking };
    };
    /**
     * Why a successful receipt of a check that runs `apv web audit --preview --base <ref>` does not prove the audit, or null.
     * An audit made proves itself (its exit code is the receipt's); « not required » is recomputed here from the commit,
     * against the reference of the command and the base the run recorded: a file with a web effect changed since either,
     * a reference that no longer resolves, or a receipt without record, and nothing is proven.
     */
    const webGap = (receipt, declared) => {
        const record = receipt.web;
        // No record: only a check whose command shows an audit with --base could have skipped it (fallback on the argv).
        if (!record)
            return declared?.base ? { files: [], reason: 'reçu sans relevé de l\'audit web (APV_WEB_RECORD) : relancer le contrôle avec cette version' } : null;
        if (record.required && record.auditId !== null)
            return null;
        // « Not required », whatever the command (wrapped in `apv lock run`, a script...): recomputed from the recorded reference and base.
        const bases = [];
        if (record.reference) {
            const recomputed = auditBase(repo, record.reference, commit);
            if (!recomputed.ok)
                return { files: [], reason: `« non requis » invérifiable : ${recomputed.message}` };
            bases.push(recomputed.base);
        }
        if (record.base) {
            if (record.base === commit)
                return { files: [], reason: 'base enregistrée égale au commit : « non requis » ne prouve rien' };
            bases.push(record.base);
        }
        if (!bases.length)
            return { files: [], reason: '« non requis » sans référence ni base enregistrées : invérifiable' };
        const changed = new Set();
        for (const base of bases)
            for (const f of changedBetween(repo, base, commit) ?? [])
                changed.add(f);
        const impact = webImpact([...changed].sort(), options.config.web);
        return impact.required ? { files: impact.files, reason: `audit requis au commit (${impact.files.length} fichier(s) à effet web modifié(s) depuis ${bases[0].slice(0, 12)}), reçu « non requis »` } : null;
    };
    const now = options.now ?? Date.now();
    // The check of a receipt `cached`: the very one `apv gates run` passes before writing one (src/gates/reuse-proof.ts).
    const reuseCheck = reuseContext({ git, repo, commit, configHash, now, store, local, reference: options.reuseReference ?? options.reference ?? null });
    const gates = [];
    const near = [];
    for (const gateId of required) {
        // A receipt of an early check (`early`) is feedback of the task stage, never proof of any check, whatever its id.
        const all = atCommit.filter(f => f.receipt.gateId === gateId && !f.receipt.early);
        const targetedOnes = all.filter(f => f.receipt.targeted === true);
        const targeted = targetedOnes.length;
        const via = viaTargeted.has(gateId);
        // A targeted run only covered the tests concerned by some changes: it proves nothing about the whole check,
        // and at the task stage it counts only when its base covers the changes since `base`.
        const accepted = all.filter(f => f.receipt.targeted !== true);
        let otherBase = 0;
        if (via)
            for (const f of targetedOnes) {
                if (await covers(f.baseSha))
                    accepted.push(f);
                else
                    otherBase += 1;
            }
        const current = accepted.filter(f => f.receipt.configHash === configHash);
        const otherConfig = accepted.length - current.length;
        const clean = current.filter(f => f.dirty === false);
        if (!clean.length) {
            const state = current.length ? 'dirty' : 'missing';
            gates.push({ gateId, state, status: null, receipt: null, runId: null, otherConfig, targeted, viaTargeted: via, proof: null, otherBase, source: null, repeat: null, scope: null, web: null, reuse: null });
            continue;
        }
        const last = clean.reduce(latest);
        if (last.receipt.nearTimeout)
            near.push({ gateId, ...last.receipt.nearTimeout });
        const proof = last.receipt.targeted === true ? 'targeted' : 'full';
        const gate = options.config.gates.find(g => g.id === gateId);
        const common = { status: last.receipt.status, receipt: last.receipt.id, runId: last.receipt.runId, otherConfig, targeted, viaTargeted: via, proof, otherBase, source: last.source };
        if (last.receipt.status === 'not_required') {
            const scope = await scopeGap(gate, last.receipt);
            gates.push({ gateId, state: scope.required ? 'required' : 'passed', ...common, repeat: null, scope, web: null, reuse: null });
            continue;
        }
        // A receipt `cached` proves nothing by itself: its reuse is checked, then the repetition and the web audit are judged on
        // what its origin recorded (the copy in the receipt `cached` is never read), recomputed at this commit as for any receipt.
        let proven = last;
        let reuse = null;
        if (last.receipt.status === 'cached') {
            const declared = last.receipt.reuse;
            const about = { fromRun: declared?.fromRun ?? null, fromCommit: declared?.fromCommit ?? null, basis: declared?.basis ?? null, origin: last.receipt.reusedFrom };
            const checked = await checkReuse(reuseCheck, gate, last);
            if ('reason' in checked) {
                gates.push({ gateId, state: 'reuse', ...common, repeat: null, scope: null, web: null, reuse: { proven: false, reason: checked.reason, ...about } });
                continue;
            }
            proven = checked.origin;
            reuse = { proven: true, reason: reuseReason(checked), ...about };
        }
        // `success` never counts a receipt `cached` by itself: here it counts once its reuse is proven just above.
        const succeeded = reuse?.proven === true || success(last.receipt);
        const repeat = succeeded && gate.repeatChanged ? await repeatGap(gate.repeatChanged, proven.receipt, stage === 'full' && proof === 'full') : null;
        const audit = webAuditGate(proof === 'targeted' ? gate.affected ?? gate.command : gate.command);
        const web = succeeded ? webGap(proven.receipt, audit) : null;
        gates.push({ gateId, state: !succeeded ? 'failed' : repeat ? 'unrepeated' : web ? 'unaudited' : 'passed', ...common, repeat, scope: null, web, reuse });
    }
    return { repo, commit, stage, base, configHash, required, targeted: [...viaTargeted], reserved: staged.reserved.map(g => g.id), gates, unreadable, store, altered: shared.altered,
        flaky: gates.filter(g => g.state === 'passed' && g.status === 'passed_after_retry').map(g => g.gateId), nearTimeout: near,
        repeating: required.filter(id => options.config.gates.some(g => g.id === id && g.repeatChanged)),
        notRequired: gates.filter(g => g.state === 'passed' && g.status === 'not_required').map(g => g.gateId),
        scoped: required.filter(id => options.config.gates.some(g => g.id === id && g.skipWhenOnly)),
        auditing: [...new Set([...required.filter(id => options.config.gates.some(g => g.id === id && webAuditGate(g.command)?.base)),
                ...gates.filter(g => g.state === 'unaudited' || (g.web === null && atCommit.some(f => f.receipt.gateId === g.gateId && f.receipt.web))).map(g => g.gateId)])],
        reused: gates.filter(g => g.state === 'passed' && g.reuse?.proven === true).map(g => g.gateId), ok: gates.every(g => g.state === 'passed') };
}
//# sourceMappingURL=verify.js.map