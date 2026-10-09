import type { GitProbe } from './state.js';
/**
 * Read-only Git call; null when Git refuses (unknown ref, not a repository). `GIT_NO_LAZY_FETCH` keeps a partial clone from
 * fetching a missing object from its remote: a read never touches the network nor writes into the repository, the object
 * is then simply unreadable.
 */
export declare function gitRead(cwd: string, args: string[]): string | null;
/** Root of the working tree that contains `path`; refuses outside a Git repository (exit 1). */
export declare function gitRoot(path: string): string;
/** Full commit id of a commit-ish, or null when it does not name a commit here. */
export declare function resolveCommit(repo: string, ref: string): string | null;
/**
 * The commit a reference NAME designates, by its full ref only (synchronous twin of `resolveReference`, src/gates/repeat.ts):
 * `refs/remotes/<name>`, `refs/heads/<name>`, `refs/tags/<name>` and `refs/<name>` are listed, and the name is refused
 * when none or several exist (a local branch or a tag `origin/main` never hides the remote-tracking one). A full ref, a
 * full commit id, `HEAD` or a revision expression (`HEAD~1`, `x^`, `@{u}`) is resolved as Git resolves it.
 */
export declare function resolveFullRef(repo: string, name: string): {
    sha: string | null;
    reason: string;
};
export declare function gitProbe(repo: string): GitProbe;
