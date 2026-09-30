/**
 * Readers of interface files shared by the reuse rules: comments blanked (lines kept), `<script>` and `<style>` blocks
 * located, native elements found. Plain text scanning, the same for every framework: nothing is compiled or executed.
 */
/** The text with `<!-- -->` and `/* *\/` comments replaced by spaces, newlines kept (line numbers stay exact). */
export declare function blankComments(text: string): string;
/** 1-based line of an offset. */
export declare function lineAt(text: string, offset: number): number;
export interface Block {
    content: string;
    line: number;
    start: number;
    end: number;
}
/** `<tag ...>content</tag>` blocks (`style`, `script`), with the line where their content starts. */
export declare function blocks(text: string, tag: 'style' | 'script'): Block[];
/** Ranges of a file that hold code rather than markup: `<script>` blocks and an Astro frontmatter. */
export declare function scriptRanges(text: string, ext: string): [number, number][];
/** Ranges of the `<style>` blocks of a file. */
export declare function styleRanges(text: string): [number, number][];
export interface ElementRule {
    selector: string;
    tag: string;
    attribute: {
        name: string;
        value: string;
    } | null;
}
export declare function elementRule(selector: string): ElementRule;
export interface ElementHit {
    selector: string;
    line: number;
    excerpt: string;
}
/**
 * Native elements of `rules` written in the markup of a file (lower-case tags only: `<Select>` is a component). An
 * attribute rule (`input[type=date]`) matches the value quoted or in a constant expression (`type={'date'}`).
 */
export declare function findElements(text: string, rules: readonly ElementRule[]): ElementHit[];
