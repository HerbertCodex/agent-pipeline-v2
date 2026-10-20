export interface Aliases {
    /** Repository paths a non-relative specifier written in `from` may designate (to resolve as files), or null when it is no alias. */
    targets(from: string, spec: string): string[] | null;
    /** Whether a bare specifier is a Node module, a virtual module or a package the root package.json declares. */
    isKnownPackage(spec: string): boolean;
    /** Files read to build the aliases that could not be parsed. */
    unreadable: string[];
}
export declare function readAliases(repo: string, base: string, tree: readonly string[]): Aliases;
