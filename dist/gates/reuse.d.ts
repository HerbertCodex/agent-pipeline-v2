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
/**
 * What Git ignores in a copy and a check still runs with (relecture sécurité de A1, M2, and of its delta, F-D1): the installed
 * dependencies, seen through the folder `node_modules` and the record each package manager writes there at every install
 * (npm, pnpm and its lock of the virtual store, Yarn Berry, Yarn 1), and every `.env*` file of the copy, at any depth (outside
 * `node_modules`, the `.git` of the copy and the worktrees Git has registered, such as those of `.worktrees/`). Two copies of the same tree
 * with other dependencies installed, or another `apps/web/.env.local`, are not the same environment. A `node_modules` with
 * none of these records (installed by another tool, or by hand) cannot be compared: never the same state as any other.
 */
export declare const LOCAL_STATE_FILES: readonly ["node_modules/.package-lock.json", "node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml", "node_modules/.yarn-state.yml", "node_modules/.yarn-integrity"];
/**
 * The worktrees Git has registered for the repository of `dir` (`git worktree list --porcelain -z`), real paths, `dir` itself
 * left out: the only folders of a copy that are another copy (relecture sécurité de A2, F1). Their `.env*` files are not
 * those of this copy (envFiles); the state of the copy measures them by their HEAD, their status and their files
 * (copyStateDigest, F1-bis). A folder that merely holds an entry named `.git` (a file or a folder written by a check, a
 * generator, a stray clone) is no worktree. None when Git cannot list them.
 */
export declare function registeredWorktrees(dir: string): Set<string>;
/**
 * Digest of the local state of a copy (LOCAL_STATE_FILES, `node_modules` present or not, each `.env*` at any depth), part
 * of the identity of the environment of every receipt: a check is reused only from an origin that ran with the same local
 * state. Contents are hashed, one digest for all: no value of a `.env*` file is ever written, in a receipt or an output.
 */
export declare function localStateDigest(dir: string): string;
/**
 * Digest of what Git ignores in a copy when a run starts there (att8 of the relecture of A1: a generated folder such as
 * `.svelte-kit`, a build left by an earlier run): every ignored file outside `node_modules` (LOCAL_STATE_FILES), `.git` and
 * `.apv/receipts/`, by its path and the sha256 of its content (a symbolic link by its target; beyond 64 MiB, or 1 GiB hashed
 * in all, by its size and date); each worktree Git has registered inside the copy, by its HEAD and its status too, its files
 * walked like the others (F1-bis); each submodule by its HEAD and its status (D2). Measured once per copy, before the first
 * check runs there: an origin is reused only by a copy that starts from the same ignored state (a fresh copy of a batch,
 * prepared by the same batch.setup, does). Not comparable (never equal) when Git cannot list it or the copy holds more than
 * MAX_WALKED entries.
 */
export declare function copyStateDigest(dir: string): Promise<string>;
/**
 * The state of a checkout inside a copy, a worktree Git has registered or a submodule: its HEAD and the sha256 of its
 * `git status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none` (never the content of a file: the walk of the
 * copy reads those). Not comparable (never equal) when Git cannot read it.
 */
export declare function checkoutState(dir: string): string;
/** Digest of a list of ignore globs (`reuse.ignoreDigest`): sorted and deduplicated, so their order never matters. */
export declare function ignoreDigest(globs: readonly string[]): string;
/** One file of the tree of a commit: its raw path, its mode and its object. */
interface TreeEntry {
    path: Buffer;
    mode: string;
    blob: string;
}
/**
 * The trees read from Git, kept for one decision of reuse (relecture sécurité de A2, F4): the files of the tree of each commit,
 * one `git ls-tree` per commit whatever the number of checks.
 */
export interface InputsCache {
    entries: Map<string, Promise<TreeEntry[]>>;
}
export declare const inputsCache: () => InputsCache;
/**
 * Digest of the inputs of a check at `commit` (`reuse.inputsDigest`): sha256 of the JSON of the list of `[path, mode, blob]`
 * of the tracked files of its tree (submodules included), sorted by the bytes of the path. The path enters the digest as the
 * hexadecimal of its raw bytes, read from Git without any decoding: two different paths (a line feed or a tab in a name, or
 * bytes that are not UTF-8, such as `f` followed by 0xff or by 0xfe) never share an encoding. Two commits have the same digest
 * exactly when they have the same tree content. Fails when the commit is not in the repository. Nothing is ignored: the reuse
 * by inputs (`reuse.ignore`) is disabled until its declaration is proven (INPUTS_REUSE_DISABLED, src/gates/reuse-proof.ts).
 */
export declare function inputsDigest(_git: Git, repo: string, commit: string, cache?: InputsCache): Promise<{
    digest: string;
    files: number;
}>;
export {};
