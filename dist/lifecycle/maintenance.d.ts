import type { Lifecycle } from './service.js';
export interface GarbageItem {
    kind: 'run-workspace' | 'review-workspace' | 'role-workspace';
    path: string;
    reason: string;
    bytes: number;
}
/**
 * Dry-run plan of operational material no longer needed: workspaces of closed/rejected specs,
 * superseded baseline (doctor) runs, failed/rejected standalone runs, review workspaces of
 * closed/rejected specs and stale role workspaces. Never the SQLite history, deliveries or source.
 */
export declare function planGarbage(life: Lifecycle, now?: number): GarbageItem[];
export interface PurgeItem {
    id: string;
    kind: 'spec' | 'bootstrap' | 'install';
    label: string;
    status: string;
    reason: string;
    lastEventAt: number;
    runIds: string[];
    workspaces: GarbageItem[];
    bytes: number;
}
/**
 * Dry-run plan of lifecycle documents that can leave the store: terminal or abandoned specs, and plan
 * documents that were never applied. It lists the runs and workspaces that go with them, so the operator
 * sees the whole cost before confirming. Applied plans, approved specs still in flight and anything with a
 * live process or lease are never proposed; `ids` targets a document explicitly but keeps those guards.
 */
export declare function planPurge(life: Lifecycle, options?: {
    ids?: readonly string[];
    olderThanDays?: number;
    now?: number;
}): PurgeItem[];
/**
 * Terminal documents a purge must keep because later work still reads them: for each repository, the spec
 * holding the visual direction that the next design continues.
 */
export declare function purgeProtections(life: Lifecycle): {
    id: string;
    reason: string;
}[];
/** Removes planned documents: their workspaces first, then their runs, then the document itself. */
export declare function purgeDocuments(life: Lifecycle, items: readonly PurgeItem[]): Promise<{
    purged: PurgeItem[];
    failed: {
        id: string;
        error: string;
    }[];
}>;
/** Removes planned items: registered worktrees through Git first, then the owned directory. */
export declare function collectGarbage(life: Lifecycle, items: GarbageItem[]): Promise<{
    removed: GarbageItem[];
    failed: {
        path: string;
        error: string;
    }[];
}>;
