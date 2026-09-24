import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateReceipt } from '../domain/contracts.js';
import { invariant } from '../domain/errors.js';
import { Git } from '../execution/git.js';
import { success } from '../engine/scheduler.js';
import { RECEIPTS_DIR, gatesConfigHash, stageGates } from './run.js';
/** Every readable receipt of `.apv/receipts/`, with the tree state from the receipt or, for older ones, its run summary. */
function readReceipts(repo) {
    const root = join(repo, RECEIPTS_DIR);
    const found = [];
    const unreadable = [];
    if (!existsSync(root))
        return { found, unreadable };
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        const dir = join(root, entry.name);
        let summaryDirty = null;
        let baseSha = null;
        try {
            const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
            if (typeof summary.dirty === 'boolean')
                summaryDirty = summary.dirty;
            if (typeof summary.baseSha === 'string' && /^[a-f0-9]{40,64}$/.test(summary.baseSha))
                baseSha = summary.baseSha;
        }
        catch { /* No summary: the tree state comes from the receipts or stays unknown, the base stays unknown. */ }
        for (const file of readdirSync(dir)) {
            if (!file.endsWith('.json') || file === 'summary.json')
                continue;
            try {
                const receipt = validateReceipt(JSON.parse(readFileSync(join(dir, file), 'utf8')));
                found.push({ receipt, dirty: receipt.dirty ?? summaryDirty, baseSha });
            }
            catch {
                unreadable.push(join(RECEIPTS_DIR, entry.name, file));
            }
        }
    }
    return { found, unreadable };
}
const latest = (a, b) => b.receipt.startedAt > a.receipt.startedAt || (b.receipt.startedAt === a.receipt.startedAt && b.receipt.runId > a.receipt.runId) ? b : a;
/**
 * Whether the receipts prove that every required check passed on this exact commit, on a clean tree and with
 * the current configuration of the checks. Receipts of any run count (a task run proves its checks as well as a
 * full one), but for each check only the latest such receipt does: a failure is never hidden by an older success.
 * At stage full, receipts of a targeted run (`targeted`, the `affected` command of a full check) never count.
 * At stage task, a full check that declares `affected` is required too: its targeted receipts count when their
 * run's base covers `base` (mandatory then), and so do its complete receipts; the latest of them decides.
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
    const { found, unreadable } = readReceipts(repo);
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
            gates.push({ gateId, state, status: null, receipt: null, runId: null, otherConfig, targeted, viaTargeted: via, proof: null, otherBase });
            continue;
        }
        const last = clean.reduce(latest);
        gates.push({ gateId, state: success(last.receipt) ? 'passed' : 'failed', status: last.receipt.status, receipt: last.receipt.id,
            runId: last.receipt.runId, otherConfig, targeted, viaTargeted: via, proof: last.receipt.targeted === true ? 'targeted' : 'full', otherBase });
    }
    return { repo, commit, stage, base, configHash, required, targeted: [...viaTargeted], reserved: staged.reserved.map(g => g.id), gates, unreadable, ok: gates.every(g => g.state === 'passed') };
}
//# sourceMappingURL=verify.js.map