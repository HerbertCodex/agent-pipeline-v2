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
/**
 * The pairs of names of a file whose changed lines differ only by class and id names, or null when anything else
 * changes (a text, a structure, a declaration, a line added or removed).
 */
export declare function renamedNames(patch: {
    removed: readonly string[];
    added: readonly string[];
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
