/** Converts a glob (`**`, `*`, `?`, `{a,b}`) into an anchored regular expression over `/` paths. */
export declare function globToRegExp(glob: string): RegExp;
/** Files under `root` matching any of the globs, as sorted `/` relative paths. */
export declare function expandGlobs(root: string, globs: readonly string[]): string[];
