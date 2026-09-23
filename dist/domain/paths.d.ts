/**
 * Absolute path with every symlink of its longest existing ancestor resolved, the missing tail kept as
 * written. Git reports resolved roots (macOS: /var is /private/var), so paths compared with a repository
 * root, or displayed relative to it, must be resolved the same way, including paths that do not exist yet.
 */
export declare function canonicalPath(path: string): string;
