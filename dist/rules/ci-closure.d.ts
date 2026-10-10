/** Every file of the commit, or null when the tree is unreadable. */
export declare function treeFiles(repo: string, sha: string): string[] | null;
/** Paths a workflow or a script line names: local actions (`uses: ./x`) and script files (`node scripts/x.mjs`) that exist. */
export declare function namedFiles(text: string, files: ReadonlySet<string>): string[];
/**
 * The files reachable from `roots` by relative imports (import, export from, dynamic import, require), at `base`. `complete` is
 * false when a file could not be read or the closure is too large: the caller does not trust it.
 */
export declare function importClosure(repo: string, base: string, roots: readonly string[], files: ReadonlySet<string>): {
    reached: Set<string>;
    complete: boolean;
};
