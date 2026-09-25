import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateReceipt } from '../domain/contracts.js';
import { invariant } from '../domain/errors.js';
import { Git } from '../execution/git.js';
import { success } from '../engine/scheduler.js';
import { RECEIPTS_DIR, gatesConfigHash, stageGates } from './run.js';
import { manifestCommit, readSharedRun, sharedRunIds, sharedStore } from './store.js';
/** Tree state and base of a run, from its summary (null when unknown). */
function summaryOf(text) {
    let dirty = null;
    let baseSha = null;
    if (text === null)
        return { dirty, baseSha };
    try {
        const summary = JSON.parse(text);
        if (typeof summary.dirty === 'boolean')
            dirty = summary.dirty;
        if (typeof summary.baseSha === 'string' && /^[a-f0-9]{40,64}$/.test(summary.baseSha))
            baseSha = summary.baseSha;
    }
    catch { /* No summary: the tree state comes from the receipts or stays unknown, the base stays unknown. */ }
    return { dirty, baseSha };
}
/** Every readable receipt of `.apv/receipts/`, with the tree state from the receipt or, for older ones, its run summary. */
function readLocal(repo) {
    const root = join(repo, RECEIPTS_DIR);
    const found = [];
    const unreadable = [];
    const runs = new Set();
    if (!existsSync(root))
        return { found, unreadable, runs };
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        runs.add(entry.name);
        const dir = join(root, entry.name);
        let text = null;
        try {
            text = readFileSync(join(dir, 'summary.json'), 'utf8');
        }
        catch { /* Older run without summary. */ }
        const summary = summaryOf(text);
        for (const file of readdirSync(dir)) {
            if (!file.endsWith('.json') || file === 'summary.json')
                continue;
            try {
                const receipt = validateReceipt(JSON.parse(readFileSync(join(dir, file), 'utf8')));
                found.push({ receipt, dirty: receipt.dirty ?? summary.dirty, baseSha: summary.baseSha, source: 'local' });
            }
            catch {
                unreadable.push(join(RECEIPTS_DIR, entry.name, file));
            }
        }
    }
    return { found, unreadable, runs };
}
/**
 * Receipts of the shared store for the runs absent from the worktree (a run present in both is read from the
 * worktree, as before the store existed). A run counts only when intact: its manifest names it and lists exactly
 * its files with their digests, its summary is there, and each receipt belongs to it (same run, same commit as
 * the manifest, file named after its check). Otherwise none of its receipts count, and the run is reported.
 */
function readShared(store, local, commit) {
    const found = [];
    const altered = [];
    for (const runId of sharedRunIds(store)) {
        if (local.has(runId))
            continue;
        // Runs of another commit cannot prove this one: their files are not read (a thousand runs stay cheap). A
        // manifest that names another commit while its receipts claim this one would be refused below anyway.
        const named = manifestCommit(join(store, runId));
        if (named !== null && named !== commit)
            continue;
        const run = readSharedRun(join(store, runId));
        if (!run.intact) {
            altered.push({ runId, reason: run.reason });
            continue;
        }
        const summaryBytes = run.files.get('summary.json');
        if (!summaryBytes) {
            altered.push({ runId, reason: 'summary.json absent' });
            continue;
        }
        const summary = summaryOf(summaryBytes.toString('utf8'));
        const receipts = [];
        let reason = null;
        for (const [name, bytes] of run.files) {
            if (name === 'summary.json')
                continue;
            let receipt;
            try {
                receipt = validateReceipt(JSON.parse(bytes.toString('utf8')));
            }
            catch {
                reason = `${name} n'est pas un reçu valide`;
                break;
            }
            if (receipt.runId !== runId || `${receipt.gateId}.json` !== name || receipt.candidateSha !== run.manifest.candidateSha) {
                reason = `${name} contredit son exécution (exécution, contrôle ou commit)`;
                break;
            }
            receipts.push({ receipt, dirty: receipt.dirty ?? summary.dirty, baseSha: summary.baseSha, source: 'shared' });
        }
        if (reason)
            altered.push({ runId, reason });
        else
            found.push(...receipts);
    }
    return { found, altered };
}
const latest = (a, b) => b.receipt.startedAt > a.receipt.startedAt || (b.receipt.startedAt === a.receipt.startedAt && b.receipt.runId > a.receipt.runId) ? b : a;
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
    const shared = readShared(store, local.runs, commit);
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
    const gates = [];
    for (const gateId of required) {
        const all = atCommit.filter(f => f.receipt.gateId === gateId);
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
            gates.push({ gateId, state, status: null, receipt: null, runId: null, otherConfig, targeted, viaTargeted: via, proof: null, otherBase, source: null });
            continue;
        }
        const last = clean.reduce(latest);
        gates.push({ gateId, state: success(last.receipt) ? 'passed' : 'failed', status: last.receipt.status, receipt: last.receipt.id,
            runId: last.receipt.runId, otherConfig, targeted, viaTargeted: via, proof: last.receipt.targeted === true ? 'targeted' : 'full', otherBase, source: last.source });
    }
    return { repo, commit, stage, base, configHash, required, targeted: [...viaTargeted], reserved: staged.reserved.map(g => g.id), gates, unreadable, store, altered: shared.altered, ok: gates.every(g => g.state === 'passed') };
}
//# sourceMappingURL=verify.js.map