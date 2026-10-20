/** A style rule, its selector resolved against the enclosing rules (CSS nesting, `&`), and the line it starts on. */
export interface StyleRule {
    selector: string;
    line: number;
    topLevel: boolean;
    /** Properties the rule declares directly (`color`, `margin-top`), lower case, custom properties included. */
    properties: string[];
}
/**
 * Rules of a stylesheet (or of a `<style>` block, lines offset by `firstLine - 1`). Comments and strings are handled;
 * nested rules are flattened (`.card { .btn {} }` gives `.card .btn`, `&.active` gives `.card.active`). `@utility name`
 * (Tailwind 4) gives the rule `.name`. `topLevel` is false inside another rule.
 */
export declare function styleRules(text: string, firstLine?: number): StyleRule[];
/** `:global(x)`, `:deep(x)`, `::v-deep(x)` and `:is(x)` unwrapped to `x`; `::v-deep` and `>>>` alone dropped. */
export declare function unwrapScoping(selector: string): string;
/** Compounds of a selector, split on combinators (space, `>`, `+`, `~`) outside parentheses and brackets. */
export declare function compounds(selector: string): string[];
/** Class names of a compound (`.btn.btn--primary:hover` gives btn, btn--primary), pseudo-class arguments left out. */
export declare function classesOf(compound: string): string[];
/**
 * Primitives defined by a global stylesheet: the base class of each top-level rule (inside `@media`, `@layer` and the
 * like included), that is the first class of its first compound, `@utility` names too. `.btn:hover` and `.btn.active`
 * give `btn` only; a rule whose first compound is the document, a theme or a state (`:root`, `html.dark .x`, `.dark .x`,
 * `.is-open`) or has no class (`body`, `a:hover`) gives nothing.
 */
export declare function primitivesOf(text: string): string[];
/** A primitive list: exact class names and prefixes (`.pill--*`), minus the exceptions. */
export declare class Primitives {
    private readonly exact;
    private readonly prefixes;
    private readonly exceptExact;
    private readonly exceptPrefixes;
    constructor(classes: readonly string[], selectors: readonly string[], except: readonly string[]);
    private add;
    get size(): number;
    has(name: string): boolean;
}
export interface StyleHit {
    line: number;
    selector: string;
    primitive: string;
    nested: boolean;
    properties: string[];
}
export declare const isLayoutOnly: (properties: readonly string[]) => boolean;
/**
 * Local rules that restyle a primitive. The selector is unwrapped (`:global(.btn)` is `.btn`), then: a primitive
 * class in its first compound is a redefinition (`.btn`, `.btn.mine`, `.btn:hover`); a primitive that only follows a
 * class of the component (`.panel .btn`) is a nested adjustment, reported with `nested: true`.
 */
export declare function restyledPrimitives(rules: readonly StyleRule[], primitives: Primitives): StyleHit[];
