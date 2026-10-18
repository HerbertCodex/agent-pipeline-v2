import { sha256 } from '../domain/hash.js';
import { matches } from '../policy/policy.js';
/**
 * Reuse of a successful check from one commit to another (docs/ACCELERATION-LOTS.md, part A): what a receipt `cached`
 * is checked against. Everything here is recomputed from Git, never read from the receipt.
 */
/** Oldest an origin receipt may be when its reuse is verified (`reuse.maxAgeMs`, 24 h when the check declares nothing). */
export const DEFAULT_REUSE_MAX_AGE_MS = 86_400_000;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
/**
 * The tree of each commit of `commits` that the repository has (`git log --no-walk --ignore-missing`, one call): a commit
 * the repository does not have, or an object that is not a commit, is absent from the map. Only full hexadecimal SHAs are
 * asked (anything else is left out, never passed to Git).
 */
export async function treesOf(git, repo, commits) {
    const asked = [...new Set([...commits].filter(c => SHA.test(c)))];
    const trees = new Map();
    if (!asked.length)
        return trees;
    const parse = (out) => {
        for (const line of out.split('\n')) {
            const [commit, tree] = line.trim().split(' ');
            if (commit && tree && SHA.test(commit) && SHA.test(tree) && asked.includes(commit))
                trees.set(commit, tree);
        }
    };
    const log = (list) => git.exec(repo, ['log', '--no-walk=unsorted', '--ignore-missing', '--format=%H %T', ...list]);
    try {
        parse(await log(asked));
    }
    catch {
        // One object that is not a commit fails the whole call: each commit alone, the unreadable ones left out.
        for (const commit of asked) {
            try {
                parse(await log([commit]));
            }
            catch { /* Not a commit of this repository. */ }
        }
    }
    return trees;
}
/** Digest of a list of ignore globs (`reuse.ignoreDigest`): sorted and deduplicated, so their order never matters. */
export function ignoreDigest(globs) {
    return sha256(JSON.stringify([...new Set(globs)].sort()));
}
/**
 * Digest of the inputs of a check at `commit` (`reuse.inputsDigest`): sha256 of the sorted list `mode blob<TAB>path` of the
 * tracked files of its tree (submodules included), minus those matching `ignore`. With no glob, two commits have the same
 * digest exactly when they have the same tree content. Fails when the commit is not in the repository.
 */
export async function inputsDigest(git, repo, commit, ignore = []) {
    const out = await git.exec(repo, ['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', `${commit}^{tree}`]);
    const lines = [];
    for (const entry of out.split('\0')) {
        if (!entry)
            continue;
        const tab = entry.indexOf('\t');
        const [mode, , blob] = entry.slice(0, tab).split(' ');
        const path = entry.slice(tab + 1);
        if (ignore.some(glob => matches(path, glob)))
            continue;
        lines.push(`${mode} ${blob}\t${path}`);
    }
    lines.sort((a, b) => {
        const pa = a.slice(a.indexOf('\t') + 1);
        const pb = b.slice(b.indexOf('\t') + 1);
        return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
    return { digest: sha256(lines.join('\n')), files: lines.length };
}
//# sourceMappingURL=reuse.js.map