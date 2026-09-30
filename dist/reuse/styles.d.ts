/** A style rule, its selector resolved against the enclosing rules (CSS nesting, `&`), and the line it starts on. */
export interface StyleRule {
    selector: string;
    line: number;
    topLevel: boolean;
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
 * Primitives defined by a global stylesheet: the classes of the first compound of its top-level rules (inside
 * `@media`, `@layer` and the like included), `@utility` names too. `.btn:hover` and `.btn--primary` count; the classes
 * that only follow a combinator (`.card .title`) do not.
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
}
/**
 * Local rules that restyle a primitive. The selector is unwrapped (`:global(.btn)` is `.btn`), then: a primitive
 * class in its first compound is a redefinition (`.btn`, `.btn.mine`, `.btn:hover`); a primitive that only follows a
 * class of the component (`.panel .btn`) is a nested adjustment, reported with `nested: true`.
 */
export declare function restyledPrimitives(rules: readonly StyleRule[], primitives: Primitives): StyleHit[];
