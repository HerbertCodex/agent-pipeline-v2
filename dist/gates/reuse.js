import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256 } from '../domain/hash.js';
import { environment } from '../execution/process.js';
import { matches } from '../policy/policy.js';
const execFileAsync = promisify(execFile);
/**
 * Reuse of a successful check from one commit to another (docs/ACCELERATION-LOTS.md, part A): what a receipt `cached`
 * is checked against. Everything here is recomputed from Git, never read from the receipt.
 */
/** Oldest an origin receipt may be when its reuse is verified (`reuse.maxAgeMs`, 24 h when the check declares nothing). */
export const DEFAULT_REUSE_MAX_AGE_MS = 86_400_000;
/**
 * `apv gates run` reuses an origin only when it is younger than the maximum age minus this margin (4 h): the receipt
 * `cached` must still check out when `apv gates verify` reads it at the end of the suite, of the batch and of its merge.
 */
export const REUSE_AGE_MARGIN_MS = 4 * 3_600_000;
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
    const wanted = new Set(asked);
    const parse = (out) => {
        for (const line of out.split('\n')) {
            const [commit, tree] = line.trim().split(' ');
            if (commit && tree && SHA.test(commit) && SHA.test(tree) && wanted.has(commit))
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
/** `git ls-tree` output as raw bytes: a path that is not valid UTF-8 is never decoded with loss. */
async function lsTreeBytes(repo, commit) {
    const { stdout } = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'ls-tree', '-r', '-z', '--full-tree', '--end-of-options', `${commit}^{tree}`], { cwd: repo, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 120_000,
        env: { ...environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'LANG']), GIT_TERMINAL_PROMPT: '0' } });
    return stdout;
}
/**
 * Digest of the inputs of a check at `commit` (`reuse.inputsDigest`): sha256 of the JSON of the list of `[path, mode, blob]`
 * of the tracked files of its tree (submodules included), sorted by the bytes of the path, minus those matching `ignore`.
 * The path enters the digest as the hexadecimal of its raw bytes, read from Git without any decoding: two different paths
 * (a line feed or a tab in a name, or bytes that are not UTF-8, such as `f` followed by 0xff or by 0xfe) never share an
 * encoding. Globs are compared to the path decoded as UTF-8. With no glob, two commits have the same digest exactly when
 * they have the same tree content. Fails when the commit is not in the repository.
 */
export async function inputsDigest(_git, repo, commit, ignore = []) {
    const out = await lsTreeBytes(repo, commit);
    const entries = [];
    let start = 0;
    while (start < out.length) {
        let end = out.indexOf(0, start);
        if (end < 0)
            end = out.length;
        const entry = out.subarray(start, end);
        start = end + 1;
        if (!entry.length)
            continue;
        const tab = entry.indexOf(0x09);
        const [mode, , blob] = entry.subarray(0, tab).toString('latin1').split(' ');
        const path = entry.subarray(tab + 1);
        if (ignore.length && ignore.some(glob => matches(path.toString('utf8'), glob)))
            continue;
        entries.push({ path, mode: mode, blob: blob });
    }
    entries.sort((a, b) => Buffer.compare(a.path, b.path));
    return { digest: sha256(JSON.stringify(entries.map(e => [e.path.toString('hex'), e.mode, e.blob]))), files: entries.length };
}
//# sourceMappingURL=reuse.js.map