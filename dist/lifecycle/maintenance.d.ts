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
/** Removes planned items: registered worktrees through Git first, then the owned directory. */
export declare function collectGarbage(life: Lifecycle, items: GarbageItem[]): Promise<{
    removed: GarbageItem[];
    failed: {
        path: string;
        error: string;
    }[];
}>;
