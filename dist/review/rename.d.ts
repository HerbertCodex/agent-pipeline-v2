/** A path a pure rename may touch: interface, style, or a page in Markdown (tests are judged by the caller). */
export declare const renameKind: (path: string) => boolean;
interface Found {
    name: string;
    selector: boolean;
}
interface Neutral {
    line: string;
    names: Found[];
}
/**
 * The part of a line that is a list of selectors, or null: the text before `{`, or a whole line ending with `,`, that
 * starts as a selector (`.`, `#`, `&`, `*`, `:global(`, or a tag name in a style sheet) and holds no markup, quote,
 * assignment, statement nor declaration (`prop: value`, `url(`), and no `(` but the one of a pseudo-class.
 */
export declare function selectorPart(line: string, styleSheet: boolean): string | null;
/** A changed line with its class and id names neutralized, and the names in order. */
export declare function neutralizeLine(line: string, path: string): Neutral;
export interface RenamePair {
    from: string;
    to: string;
    selector: boolean;
}
/** Where the lines of a hunk start and how many, on each side (`@@ -a,b +c,d @@`). */
export interface HunkPlace {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
}
/**
 * The pairs of names of a file whose changed lines differ only by class and id names, or null when anything else
 * changes (a text, a structure, a declaration, a line added, removed or moved). Each hunk replaces its lines in place,
 * as many on each side and at the same line (security review of PR #128: a rule moved after another and renamed
 * changes the cascade). Without `hunks`, the lines are taken as one hunk replaced in place.
 */
export declare function renamedNames(patch: {
    removed: readonly string[];
    added: readonly string[];
    hunks?: readonly HunkPlace[];
}, path: string): RenamePair[] | null;
export interface RenameInput {
    repo: string;
    base: string;
    head: string;
    designDir: string;
}
/**
 * Whether the pairs of every candidate file make one pure rename (see the head of this module): a one-to-one mapping,
 * each renamed name renamed in a selector, the old names gone from the head and the new ones absent from the base.
 */
export declare function pureRename(candidates: readonly RenamePair[][], input: RenameInput): boolean;
export {};
