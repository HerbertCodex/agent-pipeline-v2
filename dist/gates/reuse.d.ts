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
 * `node_modules`, `.git` and the nested repositories, such as the worktrees of `.worktrees/`). Two copies of the same tree
 * with other dependencies installed, or another `apps/web/.env.local`, are not the same environment. A `node_modules` with
 * none of these records (installed by another tool, or by hand) cannot be compared: never the same state as any other.
 */
export declare const LOCAL_STATE_FILES: readonly ["node_modules/.package-lock.json", "node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml", "node_modules/.yarn-state.yml", "node_modules/.yarn-integrity"];
/**
 * Digest of the local state of a copy (LOCAL_STATE_FILES, `node_modules` present or not, each `.env*` at any depth), part
 * of the identity of the environment of every receipt: a check is reused only from an origin that ran with the same local
 * state. Contents are hashed, one digest for all: no value of a `.env*` file is ever written, in a receipt or an output.
 */
export declare function localStateDigest(dir: string): string;
/**
 * Digest of what Git ignores in a copy when a run starts there (att8 of the relecture of A1: a generated folder such as
 * `.svelte-kit`, a build left by an earlier run): every ignored file outside `node_modules` (LOCAL_STATE_FILES), `.git`, the
 * nested repositories and `.apv/receipts/`, by its path and the sha256 of its content (a symbolic link by its target; beyond
 * 64 MiB, or 1 GiB hashed in all, by its size and date). Measured once per copy, before the first check runs there: an origin
 * is reused only by a copy that starts from the same ignored state (a fresh copy of a batch, prepared by the same
 * batch.setup, does). Not comparable (never equal) when Git cannot list it or the copy holds more than MAX_WALKED entries.
 */
export declare function copyStateDigest(dir: string): Promise<string>;
/** Digest of a list of ignore globs (`reuse.ignoreDigest`): sorted and deduplicated, so their order never matters. */
export declare function ignoreDigest(globs: readonly string[]): string;
/** Globs of ALWAYS_REQUIRED that only name tests: a check may ignore the tests of another check (docs/ACCELERATION-LOTS.md, 5.2 A2). */
export declare const TEST_GLOBS: readonly string[];
/**
 * What `reuse.ignore` never takes out of the inputs of a check, whatever it says (docs/ACCELERATION-LOTS.md, 5.2 A2): the list
 * ALWAYS_REQUIRED of src/gates/proof-scope.ts without the test folders (configuration of the checks, manifests and lock files,
 * build, test and run settings, CI, migrations, scripts/**, .env*, content the application compiles or serves). The run and
 * verify add the check's own test paths, the files its commands name, the design folder and the configuration file read.
 */
export declare const NEVER_IGNORED: readonly string[];
/**
 * The rule that takes files out of the inputs of a check (A2): `ignore` (globs read at the base), `keep` (globs never
 * ignorable, NEVER_IGNORED and the check's own, compared case ignored). A path is ignored only when it is valid UTF-8 without
 * a line terminator (the matcher never crosses one), matches a glob of `ignore`, and none of `keep`.
 */
export interface InputsRule {
    ignore: readonly string[];
    keep: readonly string[];
}
/**
 * Digest of the inputs of a check at `commit` (`reuse.inputsDigest`): sha256 of the JSON of the list of `[path, mode, blob]`
 * of the tracked files of its tree (submodules included), sorted by the bytes of the path, minus those `rule` ignores. The
 * path enters the digest as the hexadecimal of its raw bytes, read from Git without any decoding: two different paths (a
 * line feed or a tab in a name, or bytes that are not UTF-8, such as `f` followed by 0xff or by 0xfe) never share an
 * encoding. Without a rule, two commits have the same digest exactly when they have the same tree content. Fails when the
 * commit is not in the repository. The `ignore` of a former signature is a rule without any glob kept.
 */
export declare function inputsDigest(_git: Git, repo: string, commit: string, rule?: InputsRule | readonly string[] | null): Promise<{
    digest: string;
    files: number;
}>;
/** What two commits differ by, for a check that ignores some files (A2): digests of its inputs, files changed, links among its inputs. */
export interface InputsComparison {
    from: string;
    to: string;
    /** Paths (decoded as UTF-8) that differ between the two trees: added, removed, or another mode or object. */
    changed: string[];
    /** Those of them that are inputs of the check (none when the digests are equal). */
    inputs: string[];
    /** Symbolic links among the inputs of either commit (their target may be an ignored file: a reuse by inputs never trusts them). */
    links: string[];
}
/** Compares the inputs of a check at two commits with `rule` (verify recomputes this from Git, never from the receipt). */
export declare function compareInputs(repo: string, from: string, to: string, rule: InputsRule): Promise<InputsComparison>;
