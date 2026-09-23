import type { GitProbe } from './state.js';
/** Read-only Git call; null when Git refuses (unknown ref, not a repository). */
export declare function gitRead(cwd: string, args: string[]): string | null;
/** Root of the working tree that contains `path`; refuses outside a Git repository (exit 1). */
export declare function gitRoot(path: string): string;
/** Full commit id of a commit-ish, or null when it does not name a commit here. */
export declare function resolveCommit(repo: string, ref: string): string | null;
export declare function gitProbe(repo: string): GitProbe;
