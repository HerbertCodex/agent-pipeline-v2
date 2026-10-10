import type { Aliases } from './ci-aliases.js';
/** Every file of the commit, or null when the tree is unreadable. */
export declare function treeFiles(repo: string, sha: string): string[] | null;
/** Paths a workflow or a script line names: local actions (`uses: ./x`) and script files (`node scripts/x.mjs`) that exist. */
export declare function namedFiles(text: string, files: ReadonlySet<string>): string[];
/**
 * Every path a relative specifier may designate at run time, existing or not: the loaders disagree on the order (Playwright
 * tries `.js` before `.ts`), so a file added next to the one the base resolves can shadow it. Also `x.js` for a base `x.ts`, the
 * `index.*` of a directory of that name (a file `x.js` hides the directory `x/`).
 */
export declare function resolutionCandidates(from: string, spec: string): string[];
/** The paths a module path (without extension or with one, or a directory) may designate. */
export declare function candidatesOf(path: string): string[];
/** Config files of the tools that load the tests (tsconfig `extends` chains, followed at the base): their relative targets. */
export declare function extendedConfigs(repo: string, base: string, configs: readonly string[], files: ReadonlySet<string>): string[];
/**
 * The files reachable from `roots` by relative imports (import, export from, dynamic import, require), at `base`, and every
 * path those specifiers could designate (`shadows`, existing or not). `complete` is
 * false when a file could not be read or the closure is too large: the caller does not trust it.
 */
export declare function importClosure(repo: string, base: string, roots: readonly string[], files: ReadonlySet<string>, aliases: Aliases): {
    reached: Set<string>;
    shadows: Set<string>;
    unresolved: string[];
    complete: boolean;
};
