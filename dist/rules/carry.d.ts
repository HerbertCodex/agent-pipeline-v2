/** The head T1 whose reviews count for `head` (one update with the base), with the commit of the target merged; or null. */
export declare function carriedHeadOnce(repo: string, head: string, target: string): {
    from: string;
    base: string;
} | null;
/** The heads whose reviews count for `head`, nearest first (T1, then T0...): empty when `head` is no such update. */
export declare function carriedHeads(repo: string, head: string, target: string | null): string[];
