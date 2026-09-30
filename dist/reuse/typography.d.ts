/**
 * Typographic values that must not break at the end of a line, per language: an hour (`14 h 47`), a date
 * (`30 septembre`), an amount or a number with its unit (`12 €`, `50 %`, `3 km`), a number with a thousands separator
 * (`1 000`). Only French requires it among the languages known here: the rule is inactive for the others.
 */
export interface TypographyPattern {
    id: string;
    label: string;
    re: RegExp;
}
export declare const TYPOGRAPHY_PATTERNS: Readonly<Record<string, readonly TypographyPattern[]>>;
/** The patterns of a locale (`fr`, `fr-CA` use `fr`), or null when the language does not require non-breaking spaces. */
export declare function typographyPatterns(locale: string | null): readonly TypographyPattern[] | null;
export interface TypographyHit {
    line: number;
    values: string[];
}
/**
 * Breakable spaces in typographic values of a file. Markup lines (outside `<script>`, `<style>` and an Astro
 * frontmatter) are read whole; code lines (scripts, `.ts`, `.js`, JSX files, locale JSON files) only in their string
 * literals and their JSX text. `lines` restricts the search to these line numbers (the lines a change adds).
 */
export declare function breakableValues(text: string, ext: string, patterns: readonly TypographyPattern[], markup: boolean, lines?: ReadonlySet<number>): TypographyHit[];
