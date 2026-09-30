import { scriptRanges, styleRanges } from './markup.js';

/**
 * Typographic values that must not break at the end of a line, per language: an hour (`14 h 47`), a date
 * (`30 septembre`), an amount or a number with its unit (`12 €`, `50 %`, `3 km`), a number with a thousands separator
 * (`1 000`). Only French requires it among the languages known here: the rule is inactive for the others.
 */
export interface TypographyPattern { id: string; label: string; re: RegExp }

const MONTHS_FR = 'janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|janv\\.|févr\\.|avr\\.|juil\\.|sept\\.|oct\\.|nov\\.|déc\\.';
const UNITS_FR = '%|€|\\$|£|¥|k€|M€|Md€|km|m|cm|mm|kg|g|mg|ml|cl|min|ms|Ko|Mo|Go|To|ko|mo|go|°C|°F|px|pts?';
const END = '(?=$|[\\s.,;:!?)\\]<"\'`/»])';
/** An interpolated value: `{h}` (Svelte, JSX, Vue `{{ h }}`) or `${h}` (template string). */
const EXPR = '\\$?\\{\\{?[^{}]*\\}\\}?';

export const TYPOGRAPHY_PATTERNS: Readonly<Record<string, readonly TypographyPattern[]>> = {
  fr: [
    { id: 'hour', label: 'heure', re: new RegExp(`(?:\\d{1,2}|${EXPR})\\x20h(?:\\x20(?:\\d{2}|${EXPR})|${END})`, 'g') },
    { id: 'date', label: 'date', re: new RegExp(`(?:\\d{1,2}|${EXPR})\\x20(?:${MONTHS_FR})${END}`, 'g') },
    { id: 'unit', label: 'nombre et unité', re: new RegExp(`(?:\\d+(?:[.,]\\d+)?|${EXPR})\\x20(?:${UNITS_FR})${END}`, 'g') },
    { id: 'thousands', label: 'séparateur de milliers', re: /(?<![\d.,])\d{1,3}(?:\x20\d{3})+(?![\d])/g },
  ],
};

/** The patterns of a locale (`fr`, `fr-CA` use `fr`), or null when the language does not require non-breaking spaces. */
export function typographyPatterns(locale: string | null): readonly TypographyPattern[] | null {
  if (!locale) return null;
  return TYPOGRAPHY_PATTERNS[locale.split('-')[0]!.toLowerCase()] ?? null;
}

/** Segments of a line that are text shown to people: string literals, and text between `>` and `<`. */
function textSegments(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`|>([^<>]+)</g)) {
    const text = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (text) out.push(text);
  }
  return out;
}

export interface TypographyHit { line: number; values: string[] }

/**
 * Breakable spaces in typographic values of a file. Markup lines (outside `<script>`, `<style>` and an Astro
 * frontmatter) are read whole; code lines (scripts, `.ts`, `.js`, JSX files, locale JSON files) only in their string
 * literals and their JSX text. `lines` restricts the search to these line numbers (the lines a change adds).
 */
export function breakableValues(text: string, ext: string, patterns: readonly TypographyPattern[], markup: boolean, lines?: ReadonlySet<number>): TypographyHit[] {
  const hits: TypographyHit[] = [];
  const scripts = markup ? scriptRanges(text, ext) : [];
  const styles = markup ? styleRanges(text) : [];
  const jsx = ext === 'tsx' || ext === 'jsx';
  const inside = (ranges: [number, number][], at: number): boolean => ranges.some(([a, b]) => at >= a && at < b);
  let offset = 0;
  text.split('\n').forEach((line, index) => {
    const number = index + 1;
    const start = offset;
    offset += line.length + 1;
    if (lines && !lines.has(number)) return;
    if (inside(styles, start)) return;
    const inCode = !markup || jsx || inside(scripts, start);
    const segments = inCode ? textSegments(line) : [line];
    const found: string[] = [];
    for (const segment of segments) {
      for (const pattern of patterns) {
        for (const m of segment.matchAll(pattern.re)) found.push(`${pattern.label} « ${m[0].trim()} »`);
      }
    }
    if (found.length) hits.push({ line: number, values: [...new Set(found)] });
  });
  return hits;
}
