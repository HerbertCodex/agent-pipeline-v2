import { type GateReceipt, type ReuseSettings } from '../domain/contracts.js';
import type { Git } from '../execution/git.js';
import { type ApvConfig } from '../config/load.js';
import { type InputsCache } from './reuse.js';
/**
 * What proves the reuse of a green receipt at another commit (docs/ACCELERATION-LOTS.md, 5.2 and 5.5), in one place for
 * the two sides: `apv gates run`, which writes a receipt `cached` only when this check accepts it, and `apv gates verify`,
 * which runs the very same check on every receipt `cached` it reads. Nothing of a receipt `cached` is trusted: its origin is
 * read again from the worktree or from the shared store (intact), the trees and the digest are recomputed from Git.
 */
/** Where a receipt was read: the `.apv/receipts/` of the worktree, or the shared store of the repository. */
export type ReceiptSource = 'local' | 'shared';
export interface Found {
    receipt: GateReceipt;
    dirty: boolean | null;
    baseSha: string | null;
    source: ReceiptSource;
}
/** A run of the shared store refused as a whole: its files no longer match its manifest, or contradict it. */
export interface AlteredRun {
    runId: string;
    reason: string;
}
/** The receipts of the worktree: every readable one, the unreadable files, and the runs it has. */
export interface LocalReceipts {
    found: Found[];
    unreadable: string[];
    runs: Set<string>;
}
/** Every readable receipt of `.apv/receipts/`, with the tree state from the receipt or, for older ones, its run summary. */
export declare function readLocal(repo: string): LocalReceipts;
/**
 * Receipts of the shared store for the runs absent from the worktree (a run present in both is read from the
 * worktree, as before the store existed). A run counts only when intact: its manifest names it and lists exactly
 * its files with their digests, its summary is there, and each receipt belongs to it (same run, same commit as
 * the manifest, file named after its check). Otherwise none of its receipts count, and the run is reported.
 * `keep` says which runs to read from the commit their manifest names (null: no readable manifest, always read).
 */
export declare function readShared(store: string, local: Set<string>, keep: (named: string | null) => boolean): {
    found: Found[];
    altered: AlteredRun[];
};
/**
 * The receipts of one run of the shared store, when the run is intact: its manifest names it and lists exactly its files
 * with their digests, its summary is there, and each receipt belongs to it (same run, same commit as the manifest, file
 * named after its check). Otherwise the reason, and none of its receipts count.
 */
export declare function sharedRunReceipts(store: string, runId: string): {
    found: Found[];
} | {
    reason: string;
};
/** The later of two receipts: by start, then by run identifier. */
export declare const latest: (a: Found, b: Found) => Found;
/** The identity of the environment a receipt records for a reuse (5.4): `reuseIdentity`, or `environmentHash` on older ones. */
export declare const reuseIdentityOf: (receipt: GateReceipt) => string;
/** Whether an argv runs `apv dast` (`dast run`, or `dast` right after the executable of the tool). */
export declare function runsDast(argv: readonly string[]): boolean;
/**
 * Whether an argv runs a dependency audit that reads the network (`npm audit`, `pnpm audit`, `yarn audit`, `yarn npm audit`,
 * `bun audit`, `outdated`, or `audit-ci`, `better-npm-audit`, `osv-scanner`, `snyk`, `npm-check-updates` and `ncu`,
 * `npm-check`): its result changes with the advisory database or the registry, never with the tree alone (relecture
 * sécurité de A1, M3, and of its delta, F-D2).
 */
export declare function runsNetworkAudit(argv: readonly string[]): boolean;
/**
 * Why an argv runs git in a way that is never reused, or null: gitRefusal on each call of git it holds (F-D2, F2 and F2-bis
 * of the relecture of A2). Only the closed list GIT_REUSABLE is reused: whatever else git does may read the history, an
 * object or a reference, which differ between two commits of the same tree.
 */
export declare function gitNeverReused(argv: readonly string[]): string | null;
/** The scripts of the package.json files of a commit, by name: every body of that name (root first), as `projectScripts` reads them. */
export type ProjectScripts = Readonly<Record<string, string | readonly string[]>>;
/**
 * Why a check is never reused, whatever its receipts say (docs/ACCELERATION-LOTS.md, 5.2 A3), or null: declared
 * `reuse: false` by the project, or a command that runs `apv web audit` or `apv dast` (they measure a state outside the
 * repository: the preview served, the network, the time), or a command (or its relaunch) that reads the commit itself
 * through `{{candidateSha}}`: two commits of the same tree are still two commits for it. Also, directly, in an inline
 * script or in a script of package.json it runs (`scripts`, read at the commit): a dependency audit that reads the network
 * (`npm audit` and equivalents), `apv dast`, `apv web audit`, Git asked for the history (externalState, a safety net).
 */
export declare function neverReused(gate: ReusableGate, scripts?: ProjectScripts): string | null;
/**
 * The scripts of every package.json of the tree of `commit` (the root first, then each workspace or sub-package, at most
 * MAX_PACKAGES), only the string ones, by name; none when absent or unreadable. A command that runs a script of another
 * package (`npm --prefix dir`, `pnpm -C dir`, `--filter`, `-w`) finds it among them (F-D2).
 */
export declare function projectScripts(git: Git, repo: string, commit: string): Promise<Record<string, string[]>>;
/** What the reuse reads of a declared check: its id, its commands, its `reuse` field, its test paths and early checks. */
export interface ReusableGate {
    id?: string;
    command: readonly string[];
    reuse?: boolean | ReuseSettings | undefined;
    retryFailed?: {
        command: readonly string[];
    } | undefined;
    testPaths?: readonly string[];
    repeatChanged?: {
        paths: readonly string[];
    } | undefined;
}
/** Whether the commands of a check read the base of their run (`{{baseSha}}`): its result then depends on that base too. */
export declare const readsBase: (gate: ReusableGate) => boolean;
/** `reuse` of a check as an object (A2), or null (`false`, absent). */
export declare const reuseSettingsOf: (gate: ReusableGate | undefined) => ReuseSettings | null;
/**
 * Every run of the shared store that can say something about one tree, read once for all the checks of a verification or
 * of a run of the checks. `block`: why a later failure on this tree cannot be excluded (null: it can).
 */
export interface TreeScan {
    tree: string;
    /** Receipts of the worktree (every commit), and of the intact shared runs whose manifest names a commit of this tree. */
    found: Found[];
    /** Tree of each commit those receipts and manifests name (absent: a commit the repository does not have). */
    trees: Map<string, string>;
    block: string | null;
    /** Cost of the scan: runs of the shared store looked at, receipt files read for the commit they claim, milliseconds. */
    runs: number;
    files: number;
    ms: number;
}
/** Where `reuse.maxAgeMs` is read (A2): the merge base of the commit and its target, and its configuration. */
export type ReuseBase = {
    mergeBase: string;
    reference: string;
    config: ApvConfig | null;
} | {
    reason: string;
};
/** What a check of reuse reads: the commit judged, the configuration of the checks, the clock, the receipts. */
export interface ReuseContext {
    git: Git;
    repo: string;
    /** Commit the receipt `cached` is (or would be) written at, full SHA. */
    commit: string;
    configHash: string;
    now: number;
    /** Shared store of the repository (`<git common dir>/apv/receipts`). */
    store: string;
    local: LocalReceipts;
    /**
     * The branch the change goes to, or a commit of it (`apv stack batch`: its target; `apv gates run` and `verify`: `--against`,
     * else `--base`): `reuse.maxAgeMs` is read at its merge base with the commit. Absent or null: the default branch of the
     * remote (origin/HEAD, origin/main, origin/master); none, and the maximum age of a check that declares one is 24 h.
     */
    reference?: string | null;
    /** Scans of the store by tree, made once per context. */
    scans: Map<string, Promise<TreeScan>>;
    /** Scripts of the package.json files of the commit judged (neverReused), read once per context. */
    scripts?: Promise<Record<string, string[]>>;
    /** The base where `reuse.maxAgeMs` is read, once per context. */
    base?: Promise<ReuseBase>;
    /** The trees read from Git (one `git ls-tree` per commit), once per context (F4). */
    inputs?: InputsCache;
}
export declare function reuseContext(input: Omit<ReuseContext, 'scans' | 'scripts' | 'base' | 'inputs'>): ReuseContext;
/**
 * Why a receipt `cached` by inputs (`basis: inputs`) never proves anything (decision of the project lead, 18 October, evening,
 * bis: M1 of the delta review of A2). `reuse.ignore` is a declaration nothing proves: wrong already at the base (a merged PR made
 * the check read a file it declares ignored), it would make a false proof. `apv gates run` never writes one, `verify` refuses
 * it, until a PR A2b proves the declaration (the check replayed in a copy without its ignored files, its receipt required).
 */
export declare const INPUTS_REUSE_DISABLED = "reprise par entr\u00E9es d\u00E9sactiv\u00E9e tant que la d\u00E9claration reuse.ignore n'est pas prouv\u00E9e (seule la reprise \u00E0 arbre identique vaut)";
/** The merge base of the commit with its target (ReuseContext.reference) and the configuration there, once per context. */
export declare function reuseBase(ctx: ReuseContext): Promise<ReuseBase>;
/**
 * The oldest origin a check reuses (5.5.1: `reuse.maxAgeMs` read at the base): 24 h, or less when the check declares less;
 * more only when the check declares it both at the base and in the configuration judged (the smaller of the two).
 */
export declare function maxAgeOf(ctx: ReuseContext, gate: ReusableGate | undefined): Promise<number>;
/** The scan of the store for `tree`, made once per context. */
export declare function treeScan(ctx: ReuseContext, tree: string): Promise<TreeScan>;
/** How a receipt `cached` was proven: at an identical tree, the only reuse proven (INPUTS_REUSE_DISABLED). */
export interface ReuseProof {
    origin: Found;
    basis: 'tree';
    changed: 0;
    scan: {
        runs: number;
        files: number;
        ms: number;
    };
}
/** The reason `verify` and `apv gates run` give for a proven reuse. */
export declare const reuseReason: (proof: {
    basis: "tree" | "inputs";
    changed: number;
}) => string;
/**
 * Whether a receipt `cached` proves its check at `ctx.commit` (docs/ACCELERATION-LOTS.md, 5.5). Nothing of it is trusted:
 * the check must not be one that is never reused (`gate`, from the configuration judged); its origin is read again (the
 * worktree when it has the run, else the run of the shared store, intact), must be the same check, `passed` at first pass
 * (never `cached`: no chain), complete, on a clean tree, of the current configuration, of the same reuse identity of the
 * environment, younger than the maximum age (`reuse.maxAgeMs` read at the base, maxAgeOf), with the same output digests,
 * without a record of `apv web audit`; a command that reads `{{baseSha}}` needs the same base and a merge base of the same
 * tree on both sides. Only `basis: tree` proves anything: the trees of both commits are recomputed and so is the digest of
 * the inputs; the store is scanned for the tree (TreeScan); no receipt of the check later than the origin on the same tree
 * failed: complete, targeted or of one of its early checks. A receipt `basis: inputs` is refused whatever it says
 * (INPUTS_REUSE_DISABLED). The environment compared includes the local state of the copy (localStateDigest, copyStateDigest).
 * Returns the proof, or why the receipt proves nothing.
 */
export declare function checkReuse(ctx: ReuseContext, gate: ReusableGate | undefined, cached: Found): Promise<ReuseProof | {
    reason: string;
}>;
/** The environment a check would run in now, for one stack (null: none), as its receipt would record it. */
export interface ReuseEnvironment {
    /** `environmentHash` the receipt would carry. */
    hash: string;
    /** `reuseIdentity` the receipt would carry (5.4): compared to the origin's. */
    identity: string;
    stack: string | null;
    /** The parts of that identity (`identityParts` the receipt would carry), to name what differs; null or absent: not said. */
    parts?: IdentityParts | null;
}
/** What a receipt records of the parts of its identity of reuse (`identityParts`): a digest each, never a value. */
export interface IdentityParts {
    env: Record<string, string>;
    executable: string;
    local: string;
    copy: string;
    system: string;
    stack: string | null;
}
/** The names of the parts that differ between two records of identity parts, as said to the operator (at most 10 variables named). */
export declare function partsDiffer(a: IdentityParts, b: IdentityParts): string[];
/** The receipt `cached` a run may write for a check: its origin, the record of the reuse, the stack of its environment. */
export interface ReuseChoice {
    origin: Found;
    reuse: NonNullable<GateReceipt['reuse']>;
    stack: string | null;
    identity: string;
    changed: number;
}
/**
 * The origin `apv gates run` may reuse for `gate` at `ctx.commit` (docs/ACCELERATION-LOTS.md, A1), or why none: the latest
 * receipt of the check on an identical tree (worktree, then shared store, intact), at the same configuration, in one of the
 * environments the check would run in now (`environments`: its variables, executable, stack, compared by their reuse
 * identity), `passed` at first pass, clean, complete, younger than the maximum age minus REUSE_AGE_MARGIN_MS, without a
 * record of `apv web audit`. Never by inputs (INPUTS_REUSE_DISABLED), whatever `reuse.ignore` says. The receipt about to be
 * written is checked by `checkReuse`, the very check `apv gates verify` runs: a receipt it would refuse is never written.
 * `candidate`: false when no receipt was even considered (nothing to say).
 */
export declare function findOrigin(ctx: ReuseContext, gate: ReusableGate & {
    id: string;
}, environments: readonly ReuseEnvironment[], base: string | null): Promise<ReuseChoice | {
    reason: string;
    candidate: boolean;
}>;
