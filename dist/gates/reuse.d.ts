import type { Git } from '../execution/git.js';
/**
 * Reuse of a successful check from one commit to another (docs/ACCELERATION-LOTS.md, part A): what a receipt `cached`
 * is checked against. Everything here is recomputed from Git, never read from the receipt.
 */
/** Oldest an origin receipt may be when its reuse is verified (`reuse.maxAgeMs`, 24 h when the check declares nothing). */
export declare const DEFAULT_REUSE_MAX_AGE_MS = 86400000;
/**
 * The tree of each commit of `commits` that the repository has (`git log --no-walk --ignore-missing`, one call): a commit
 * the repository does not have, or an object that is not a commit, is absent from the map. Only full hexadecimal SHAs are
 * asked (anything else is left out, never passed to Git).
 */
export declare function treesOf(git: Git, repo: string, commits: Iterable<string>): Promise<Map<string, string>>;
/** Digest of a list of ignore globs (`reuse.ignoreDigest`): sorted and deduplicated, so their order never matters. */
export declare function ignoreDigest(globs: readonly string[]): string;
/**
 * Digest of the inputs of a check at `commit` (`reuse.inputsDigest`): sha256 of the JSON of the list of `[path, mode, blob]`
 * of the tracked files of its tree (submodules included), sorted by path, minus those matching `ignore`. JSON encodes every
 * character of a path (a line feed or a tab in a file name included): two different lists never share an encoding. With no
 * glob, two commits have the same digest exactly when they have the same tree content. Fails when the commit is not in the
 * repository.
 */
export declare function inputsDigest(git: Git, repo: string, commit: string, ignore?: readonly string[]): Promise<{
    digest: string;
    files: number;
}>;
