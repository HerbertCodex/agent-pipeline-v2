import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfigAtCommit } from '../config/load.js';
import { sharedRunIds } from './store.js';
import { sharedRunReceipts } from './reuse-proof.js';
const FAILED_REPETITION = ['failed', 'timed_out', 'cancelled', 'spawn_error'];
/** Mode and blob of each of `files` at `commit` (the whole tree listed once, no pattern), regular files only; absent: not in the commit. */
async function blobsAt(git, repo, commit, files) {
    const out = new Map();
    if (!files.length)
        return out;
    const wanted = new Set(files);
    let listed;
    try {
        listed = await git.exec(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]);
    }
    catch {
        return out;
    }
    for (const entry of listed.split('\0')) {
        const m = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/s.exec(entry);
        if (m && wanted.has(m[3]))
            out.set(m[3], `${m[1]} ${m[2]}`);
    }
    return out;
}
/** The repetition a check declares, as a credit compares it: command, load, pattern (the reference and the ceiling do not change what ran). */
const repetitionOf = (settings) => JSON.stringify([settings.command, settings.stressArgs ?? [], settings.testPattern ?? null]);
/** A receipt of `gateId` whose repetition names one of `wanted`, read cheaply (no validation: a candidate is read again intact). */
function namesWanted(value, gateId, wanted) {
    const r = value;
    return !!r && r.gateId === gateId && Array.isArray(r.repeat?.files) && r.repeat.files.some(f => typeof f === 'string' && wanted.has(f));
}
/**
 * The credits of `files` (changed test files the check would repeat at `commit`) for the check `gateId`: a map from each
 * credited file to the receipt that repeated it at the same content. A file without a credit is repeated.
 */
export async function repeatCredits(input) {
    const { git, repo, gateId, settings } = input;
    const credits = new Map();
    const here = await blobsAt(git, repo, input.commit, input.files);
    const wanted = new Set(input.files.filter(f => here.has(f)));
    if (!wanted.size)
        return credits;
    // Every receipt of the check that repeated one of the files: the worktree, then the runs of the store it does not have.
    const found = input.local.found.filter(f => namesWanted(f.receipt, gateId, wanted));
    for (const runId of sharedRunIds(input.store)) {
        if (input.local.runs.has(runId))
            continue;
        let value;
        try {
            value = JSON.parse(readFileSync(join(input.store, runId, `${gateId}.json`), 'utf8'));
        }
        catch {
            continue;
        }
        if (!namesWanted(value, gateId, wanted))
            continue;
        const run = sharedRunReceipts(input.store, runId);
        // An altered run proves nothing; a failure it would hold is not looked for (the repetition then simply runs again or not).
        if ('reason' in run)
            continue;
        found.push(...run.found.filter(f => f.receipt.gateId === gateId));
    }
    const blobs = new Map();
    const blobsOf = (r) => {
        if (!blobs.has(r.candidateSha))
            blobs.set(r.candidateSha, blobsAt(git, repo, r.candidateSha, [...wanted]));
        return blobs.get(r.candidateSha);
    };
    // A repetition of a file that failed at the same content, in any receipt of the check: never credited.
    const unstable = new Set();
    for (const f of found) {
        const repeat = f.receipt.repeat;
        if (!repeat || !FAILED_REPETITION.includes(repeat.status))
            continue;
        const at = await blobsOf(f.receipt);
        for (const file of repeat.files)
            if (wanted.has(file) && at.get(file) === here.get(file))
                unstable.add(file);
    }
    const configs = new Map();
    const repetitionAt = (commit) => {
        if (!configs.has(commit)) {
            let declared = null;
            try {
                const s = loadConfigAtCommit(repo, commit).config.gates.find(g => g.id === gateId)?.repeatChanged;
                declared = s ? repetitionOf(s) : null;
            }
            catch { /* unreadable: no credit */ }
            configs.set(commit, declared);
        }
        return configs.get(commit);
    };
    const expected = repetitionOf(settings);
    for (const f of found) {
        const r = f.receipt;
        const repeat = r.repeat;
        if (r.status !== 'passed' || r.targeted === true || r.early || r.stage !== 'full' || f.dirty !== false)
            continue;
        if (!repeat || repeat.status !== 'passed' || repeat.times < settings.times)
            continue;
        if (repetitionAt(r.candidateSha) !== expected)
            continue;
        const at = await blobsOf(r);
        for (const file of repeat.files) {
            if (!wanted.has(file) || unstable.has(file) || credits.has(file) || at.get(file) !== here.get(file))
                continue;
            credits.set(file, { file, blob: here.get(file).split(' ')[1], runId: r.runId, receipt: r.id, commit: r.candidateSha });
        }
    }
    return credits;
}
//# sourceMappingURL=repeat-credit.js.map