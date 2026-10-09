/**
 * Class and id names hidden by the ad blockers (issue #124). Pilot project, 8 October 2026: an admin page whose classes
 * were `ad-page`, `ad-head`, `ad-bar`, `ad-grid` showed blank in production on the operator's computer, in two browsers:
 * an extension applied the generic hiding filters of EasyList to these names (`position: absolute` injected). Invisible
 * in the tests and in the captures of fidelity, which run without an extension; two hours of diagnosis.
 *
 * Refused names (case ignored): `ad`, `ads`, `adsbygoogle`, those starting with `ad-`, `ads-`, `adv-` or the same with
 * `_`, `banner-ad` or `banner_ad` (then `-`, `_`, `s` or the end), `advert` or `sponsor` (the generic filters).
 * `add-on`, `advanced`, `adresse`, `badge` stay accepted. Read in the `class`, `className` and `id` attributes (quoted:
 * the names of the value and the strings of its `{...}` expressions, a ternary included; unquoted; `class={'…'}`), the
 * Svelte `class:` directives, the strings of `classList.add|remove|toggle|replace|contains(…)`, `getElementById(…)`,
 * `.className =` and `.id =`, the selector strings starting with `.` or `#` of `querySelector`, `querySelectorAll`,
 * `closest`, `matches` and `locator`, and the selectors of the style sheets and of the `<style>` blocks; never in the
 * text of a page, a `data-*`, another attribute or a string of a script outside these calls (security review of PR #128:
 * every form but the first ones passed; its second review: `const id = 'ad-hoc-report'` was refused).
 */

/** Files of interface where the names are read. */
export const ADBLOCK_FILES = /\.(?:svelte|vue|astro|tsx|jsx|html|htm|css|scss|sass|less)$/i;
const STYLE_FILE = /\.(?:css|scss|sass|less)$/i;

/** A name the generic filters hide. */
export const ADBLOCK_NAME = /^(?:(?:ad|ads|adv)[-_]|ads?$|adsbygoogle|banner[-_]ads?(?:[-_]|$)|advert|sponsor)/i;
export const ADBLOCK_MESSAGE = 'masqué par les filtres anti-pub du poste de l\'opérateur (filtres génériques EasyList : ad, ads, ad-, ads-, adv-, ad_, advert, banner-ad, sponsor) ; le renommer (par exemple art-, item-)';

export interface AdBlockedName { line: number; kind: 'classe' | 'identifiant'; name: string }
/** Not preceded by a letter, `-` or `.`, `=` right after the name: `data-id` is no `id`, `const id = …` no attribute. */
const NAME = /-?[A-Za-z_][\w-]*/g;
/** Not preceded by a letter, `-` or `.`: `data-id` is no `id`, `el.className =` is read as a script. */
const ATTRIBUTE = /(?<![\w.-])(class|className|id)=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s"'{>/]+))/g;
const DIRECTIVE = /(?<![\w-])class:(-?[A-Za-z_][\w-]*)/g;
const SCRIPT = /(?:\b(?:classList\.(?:add|remove|toggle|replace|contains)|getElementById)\s*\(([^)]*)\)|\.(className|id)\s*\+?=\s*(["'`][^"'`]*["'`]))/g;
/** Calls that take a selector, read when it starts with `.` or `#` (`querySelector('.ad-box')`, the `locator` of Playwright). */
const SELECTOR_CALL = /\b(?:querySelector|querySelectorAll|closest|matches|locator)\s*\(([^)]*)\)/g;
const STRING = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const SELECTOR = /([.#])(-?[A-Za-z_][\w-]*)/g;

/** The part of a line of CSS that holds selectors: before `{`, or a whole line ending with `,`, without a declaration. */
function selectors(line: string): string | null {
  const brace = line.indexOf('{');
  const part = brace >= 0 ? line.slice(0, brace) : /,\s*$/.test(line) ? line : null;
  if (part === null || /:\s|;|\burl\(|["'`]/.test(part)) return null;
  return part;
}

/** Every class and id name of a file of interface hidden by the generic ad filters, with its line, in order. */
export function adBlockedNames(text: string, path: string): AdBlockedName[] {
  if (!ADBLOCK_FILES.test(path)) return [];
  const style = STYLE_FILE.test(path);
  const out: { line: number; column: number; kind: AdBlockedName['kind']; name: string }[] = [];
  let inStyle = false;
  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    const found = (column: number, kind: AdBlockedName['kind'], name: string): void => { if (ADBLOCK_NAME.test(name)) out.push({ line, column, kind, name }); };
    const names = (segment: string, offset: number, kind: AdBlockedName['kind']): void => { for (const n of segment.matchAll(NAME)) found(offset + n.index!, kind, n[0]); };
    // The names of the string literals of a piece of code (an expression, the arguments of a call).
    const strings = (code: string, offset: number, kind: AdBlockedName['kind']): void => {
      for (const s of code.matchAll(STRING)) names(s[2]!, offset + s.index! + 1, kind);
    };
    let css: string | null = null;
    if (style) css = raw;
    else {
      for (const m of raw.matchAll(ATTRIBUTE)) {
        const kind = m[1] === 'id' ? 'identifiant' : 'classe';
        const value = m[2] ?? m[3] ?? m[4] ?? m[5] ?? '';
        const start = m.index! + m[0].lastIndexOf(value);
        if (m[4] !== undefined) { strings(value, start, kind); continue; }
        // Names outside the `{...}` expressions of the value; inside them, the strings (`{on ? 'ad-x' : ''}`).
        names(value.replace(/\{[^}]*\}/g, match => ' '.repeat(match.length)), start, kind);
        for (const e of value.matchAll(/\{[^}]*\}/g)) strings(e[0], start + e.index!, kind);
      }
      for (const m of raw.matchAll(DIRECTIVE)) found(m.index!, 'classe', m[1]!);
      for (const m of raw.matchAll(SCRIPT)) {
        const code = m[1] ?? m[3] ?? '';
        strings(code, m.index! + m[0].lastIndexOf(code), m[2] === 'id' || m[0].startsWith('getElementById') ? 'identifiant' : 'classe');
      }
      for (const m of raw.matchAll(SELECTOR_CALL)) {
        const start = m.index! + m[0].lastIndexOf(m[1]!);
        for (const s of m[1]!.matchAll(STRING)) {
          if (!/^\s*[.#]/.test(s[2]!)) continue;
          for (const n of s[2]!.matchAll(SELECTOR)) found(start + s.index! + 1 + n.index!, n[1] === '#' ? 'identifiant' : 'classe', n[2]!);
        }
      }
      // A `<style>` block of a component or a page: its lines are CSS.
      const open = raw.search(/<style\b[^>]*>/i);
      const close = raw.search(/<\/style>/i);
      if (inStyle || open >= 0) css = raw.slice(open >= 0 ? raw.indexOf('>', open) + 1 : 0, close >= 0 ? close : undefined);
      if (open >= 0 && close < 0) inStyle = true;
      else if (close >= 0) inStyle = false;
    }
    const part = css === null ? null : selectors(css);
    if (part !== null) {
      const offset = raw.indexOf(part);
      for (const m of part.matchAll(SELECTOR)) found(offset + m.index!, m[1] === '#' ? 'identifiant' : 'classe', m[2]!);
    }
  });
  return out.sort((a, b) => a.line - b.line || a.column - b.column).map(({ line, kind, name }) => ({ line, kind, name }));
}
