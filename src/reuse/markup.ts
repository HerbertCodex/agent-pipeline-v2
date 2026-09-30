/**
 * Readers of interface files shared by the reuse rules: comments blanked (lines kept), `<script>` and `<style>` blocks
 * located, native elements found. Plain text scanning, the same for every framework: nothing is compiled or executed.
 */

/** The text with `<!-- -->` and `/* *\/` comments replaced by spaces, newlines kept (line numbers stay exact). */
export function blankComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)|\/\*[\s\S]*?(?:\*\/|$)/g, m => m.replace(/[^\n]/g, ' '));
}

/** 1-based line of an offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export interface Block { content: string; line: number; start: number; end: number }

/** `<tag ...>content</tag>` blocks (`style`, `script`), with the line where their content starts. */
export function blocks(text: string, tag: 'style' | 'script'): Block[] {
  const out: Block[] = [];
  const re = new RegExp(`<${tag}(?=[\\s>])[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'gi');
  for (const m of text.matchAll(re)) {
    const start = m.index + m[0].indexOf('>') + 1;
    out.push({ content: m[1] ?? '', line: lineAt(text, start), start, end: start + (m[1] ?? '').length });
  }
  return out;
}

/** Ranges of a file that hold code rather than markup: `<script>` blocks and an Astro frontmatter. */
export function scriptRanges(text: string, ext: string): [number, number][] {
  const ranges: [number, number][] = blocks(text, 'script').map(b => [b.start, b.end]);
  if (ext === 'astro') {
    const front = /^---\r?\n[\s\S]*?\r?\n---/.exec(text);
    if (front) ranges.push([0, front[0].length]);
  }
  return ranges;
}

/** Line ranges (first and last line, inclusive) of the `<style>` or `<script>` blocks of a file. */
export function rangesOf(text: string, tag: 'style' | 'script'): [number, number][] {
  return blocks(text, tag).map(b => [b.line, b.line + (b.content.match(/\n/g)?.length ?? 0)]);
}

/** Ranges of the `<style>` blocks of a file. */
export function styleRanges(text: string): [number, number][] {
  return blocks(text, 'style').map(b => [b.start, b.end]);
}

const spaces = (m: string): string => m.replace(/[^\n]/g, ' ');

/**
 * The markup of an interface file, everything else blanked (lines kept): comments, and the code, where a tag is only
 * text (`// <select>`, `'<dialog>'`). In a file with `<script>` blocks (Svelte, Vue, Astro, HTML), those blocks and an
 * Astro frontmatter are code; in a JSX file, line comments and the string literals that are not attribute values.
 */
export function markupOnly(text: string, ext: string): string {
  let out = blankComments(text);
  if (ext === 'tsx' || ext === 'jsx') {
    out = out.replace(/(^|[^:\\])\/\/[^\n]*/g, (m, lead: string) => lead + spaces(m.slice(lead.length)));
    // A string is markup only as an attribute value: `type="date"` (no space before `=`) or `type={'date'}`.
    return out.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (m, offset: number) => {
      const before = out[offset - 1] ?? '';
      const attribute = before === '{' || (before === '=' && /[\w-]/.test(out[offset - 2] ?? ''));
      return attribute ? m : spaces(m);
    });
  }
  for (const [start, end] of scriptRanges(out, ext)) out = out.slice(0, start) + spaces(out.slice(start, end)) + out.slice(end);
  return out;
}

export interface ElementRule { selector: string; tag: string; attribute: { name: string; value: string } | null }

export function elementRule(selector: string): ElementRule {
  const m = /^([a-z][a-z0-9-]*)(?:\[([a-z][a-z0-9-]*)=([A-Za-z0-9_-]+)\])?$/.exec(selector);
  if (!m) throw new Error(`invalid element selector ${selector}`);
  return { selector, tag: m[1]!, attribute: m[2] ? { name: m[2], value: m[3]! } : null };
}

export interface ElementHit { selector: string; line: number; excerpt: string }

/**
 * Native elements of `rules` written in the markup of a file (lower-case tags only: `<Select>` is a component; comments
 * and code left out, see markupOnly). An
 * attribute rule (`input[type=date]`) matches the value quoted or in a constant expression (`type={'date'}`).
 */
export function findElements(text: string, rules: readonly ElementRule[], ext = 'html'): ElementHit[] {
  const clean = markupOnly(text, ext);
  const hits: ElementHit[] = [];
  for (const rule of rules) {
    const re = new RegExp(`<${rule.tag}(?=[\\s/>])[^>]*>?`, 'g');
    for (const m of clean.matchAll(re)) {
      if (rule.attribute) {
        const { name, value } = rule.attribute;
        const attr = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"${value}"|'${value}'|\\{\\s*["'\`]${value}["'\`]\\s*\\})`);
        if (!attr.test(m[0])) continue;
      }
      const line = lineAt(clean, m.index);
      hits.push({ selector: rule.selector, line, excerpt: text.split('\n')[line - 1]?.trim().slice(0, 120) ?? '' });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}
