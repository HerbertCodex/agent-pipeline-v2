import { type GateReceipt } from '../domain/contracts.js';
import type { Git } from '../execution/git.js';
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
/** Whether an argv runs `apv dast` (`dast run`, or `dast` right after the executable of the tool). */
export declare function runsDast(argv: readonly string[]): boolean;
/**
 * Why a check is never reused, whatever its receipts say (docs/ACCELERATION-LOTS.md, 5.2 A3), or null: declared
 * `reuse: false` by the project, or a command that runs `apv web audit` or `apv dast` (they measure a state outside the
 * repository: the preview served, the network, the time), or a command (or its relaunch) that reads the commit itself
 * through `{{candidateSha}}`: two commits of the same tree are still two commits for it.
 */
export declare function neverReused(gate: ReusableGate): string | null;
/** What the reuse reads of a declared check: its id, its commands, its `reuse` field. */
export interface ReusableGate {
    id?: string;
    command: readonly string[];
    reuse?: boolean | undefined;
    retryFailed?: {
        command: readonly string[];
    } | undefined;
}
/** Whether the commands of a check read the base of their run (`{{baseSha}}`): its result then depends on that base too. */
export declare const readsBase: (gate: ReusableGate) => boolean;
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
    /** Scans of the store by tree, made once per context. */
    scans: Map<string, Promise<TreeScan>>;
}
export declare function reuseContext(input: Omit<ReuseContext, 'scans'>): ReuseContext;
/** The scan of the store for `tree`, made once per context. */
export declare function treeScan(ctx: ReuseContext, tree: string): Promise<TreeScan>;
/**
 * Whether a receipt `cached` proves its check at `ctx.commit` (docs/ACCELERATION-LOTS.md, 5.5). Nothing of it is trusted:
 * the check must not be one that is never reused (`gate`, from the configuration judged); its origin is read again (the
 * worktree when it has the run, else the run of the shared store, intact), must be the same check, `passed` at first pass
 * (never `cached`: no chain), complete, on a clean tree, of the current configuration, of the same environment, younger
 * than the maximum age, with the same output digests, without a record of `apv web audit`; the trees of both commits are
 * recomputed (`basis: tree`) and so is the digest of the inputs; the store is scanned for the tree (TreeScan), and no
 * receipt of the check on the same tree, later than the origin, failed. Returns the origin, or why the receipt proves nothing.
 */
export declare function checkReuse(ctx: ReuseContext, gate: ReusableGate | undefined, cached: Found): Promise<{
    origin: Found;
    scan: TreeScan;
} | {
    reason: string;
}>;
/** The environment a check would run in now, for one stack (null: none), as its receipt would record it. */
export interface ReuseEnvironment {
    hash: string;
    stack: string | null;
}
/** The receipt `cached` a run may write for a check: its origin, the record of the reuse, the stack of its environment. */
export interface ReuseChoice {
    origin: Found;
    reuse: NonNullable<GateReceipt['reuse']>;
    stack: string | null;
    scan: TreeScan;
}
/**
 * The origin `apv gates run` may reuse for `gate` at `ctx.commit` (docs/ACCELERATION-LOTS.md, A1), or why none:
 * the latest receipt of the check on an identical tree (worktree, then shared store, intact), at the same configuration,
 * in one of the environments the check would run in now (`environments`: its variables, executable, stack), `passed` at
 * first pass, clean, complete, younger than the maximum age minus REUSE_AGE_MARGIN_MS, without a record of `apv web audit`.
 * The receipt about to be written is then checked by `checkReuse`, the very check `apv gates verify` runs: a receipt it
 * would refuse is never written. `candidate`: false when no receipt of an identical tree was even considered (nothing to say).
 */
export declare function findOrigin(ctx: ReuseContext, gate: ReusableGate & {
    id: string;
}, environments: readonly ReuseEnvironment[], base: string | null): Promise<ReuseChoice | {
    reason: string;
    candidate: boolean;
}>;
