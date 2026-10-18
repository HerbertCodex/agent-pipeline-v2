import type { Git } from '../execution/git.js';
/**
 * Reuse of a successful check from one commit to another (docs/ACCELERATION-LOTS.md, part A): what a receipt `cached`
 * is checked against. Everything here is recomputed from Git, never read from the receipt.
 */
/** Oldest an origin receipt may be when its reuse is verified (`reuse.maxAgeMs`, 24 h when the check declares nothing). */
export declare const DEFAULT_REUSE_MAX_AGE_MS = 86400000;
/**
 * `apv gates run` reuses an origin only when it is younger than the maximum age minus this margin (4 h): the receipt
 * `cached` must still check out when `apv gates verify` reads it at the end of the suite, of the batch and of its merge.
 */
export declare const REUSE_AGE_MARGIN_MS: number;
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
 * of the tracked files of its tree (submodules included), sorted by the bytes of the path, minus those matching `ignore`.
 * The path enters the digest as the hexadecimal of its raw bytes, read from Git without any decoding: two different paths
 * (a line feed or a tab in a name, or bytes that are not UTF-8, such as `f` followed by 0xff or by 0xfe) never share an
 * encoding. Globs are compared to the path decoded as UTF-8. With no glob, two commits have the same digest exactly when
 * they have the same tree content. Fails when the commit is not in the repository.
 */
export declare function inputsDigest(_git: Git, repo: string, commit: string, ignore?: readonly string[]): Promise<{
    digest: string;
    files: number;
}>;
