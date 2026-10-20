import type { Git } from '../execution/git.js';
/**
 * Shared receipt store of a repository: `<git common dir>/apv/receipts/<run>/`, common to every worktree of the
 * repository and never versioned (it lives inside the Git directory). `apv gates run` copies each run there, so
 * that its receipts survive the removal of the worktree (a detached delivery copy, for instance) and
 * `apv gates verify --commit <sha>` proves the commit from any checkout of the repository.
 */
export declare const SHARED_RECEIPTS_DIR: string;
/** Digests of the files of a run in the shared store (or an export), written last. */
export declare const MANIFEST = "manifest.json";
/** Retention of the shared store (`receipts` of `.apv/config.json`): runs younger than `keepDays`, `keepRuns` at most. */
export declare const DEFAULT_RECEIPT_RETENTION: {
    readonly keepDays: 30;
    readonly keepRuns: 1000;
};
export interface ReceiptRetention {
    keepDays: number;
    keepRuns: number;
}
/** Identifier of a run of `apv gates run`: its UTC start (to the second) and 8 random hexadecimal digits. */
export declare const RUN_DIR: RegExp;
export interface Manifest {
    version: 1;
    runId: string;
    /** Commit of the run (from its summary), checked against each receipt. */
    candidateSha: string;
    /** Worktree the run happened in (may no longer exist). */
    worktree: string;
    copiedAt: string;
    /** sha256 of each file of the run, manifest excluded. */
    files: Record<string, string>;
}
/** The retention a configuration asks for: `receipts`, defaults for what is absent. */
export declare const receiptRetention: (config: {
    receipts?: Partial<ReceiptRetention> | undefined;
}) => ReceiptRetention;
/** Absolute path of the shared store of the repository `repo` belongs to (not created). */
export declare function sharedStore(git: Git, repo: string): Promise<string>;
/** Start of a run from its identifier, in milliseconds; null when the name is not a run identifier. */
export declare function runTime(runId: string): number | null;
/** The manifest of a run directory, computed from its files (the manifest itself excluded). */
export declare function manifestOf(dir: string, runId: string, candidateSha: string, worktree: string, now?: Date): Manifest;
/**
 * Copies the run directory `local` into the shared store `store`, with its manifest, through a temporary
 * directory renamed at the end: a reader never sees a partial copy. A run already there is left as is.
 * Returns the directory of the copy.
 */
export declare function publishRun(store: string, local: string, runId: string, candidateSha: string, worktree: string): string;
export type SharedRun = {
    runId: string;
    dir: string;
    intact: true;
    manifest: Manifest;
    files: Map<string, Buffer>;
} | {
    runId: string;
    dir: string;
    intact: false;
    reason: string;
};
/**
 * Reads a run of the shared store and checks it against its manifest: the manifest names this run, lists
 * exactly the files present, and each file has the digest the manifest gives. Anything else: not intact,
 * with the reason; none of its receipts may count.
 */
export declare function readSharedRun(dir: string): SharedRun;
/** The commit a run of the shared store names in its manifest, or null when the manifest is absent or invalid. */
export declare function manifestCommit(dir: string): string | null;
/** Run directories of the shared store, by identifier (temporary copies and foreign entries left out). */
export declare function sharedRunIds(store: string): string[];
export interface PruneResult {
    removed: string[];
    kept: number;
    temporary: number;
}
/**
 * Bounded retention of the shared store: keeps the `keepRuns` most recent runs younger than `keepDays` (by the
 * start written in their identifier), removes the others, and the temporary copies older than an hour. Entries
 * that are not runs are never touched.
 */
export declare function pruneStore(store: string, retention: ReceiptRetention, now?: number): PruneResult;
/** A run known to the worktree, the shared store, or both. */
export interface RunEntry {
    runId: string;
    candidateSha: string | null;
    stage: string | null;
    ok: boolean | null;
    dirty: boolean | null;
    /** Directory in the worktree (`.apv/receipts/<run>`), or null. */
    local: string | null;
    /** Directory in the shared store, or null. */
    shared: string | null;
    /** Shared copy intact (digests of its manifest), null without a shared copy; `reason` when not intact. */
    intact: boolean | null;
    reason: string | null;
}
/** Runs of the worktree (`localRoot`, its `.apv/receipts`) and of the shared store, most recent first. */
export declare function listRuns(localRoot: string, store: string): RunEntry[];
export interface ExportResult {
    runId: string;
    directory: string;
    source: 'local' | 'shared';
    files: string[];
}
/**
 * Copies a run into `<out>/<run>/` with its manifest (digests of each file): from the worktree when it has the
 * run, else from the shared store, whose copy must be intact. The destination must not exist yet.
 */
export declare function exportRun(worktree: string, localRoot: string, store: string, runId: string, out: string): ExportResult;
