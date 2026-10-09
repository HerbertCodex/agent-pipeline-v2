/**
 * Class and id names hidden by the ad blockers (issue #124). Pilot project, 8 October 2026: an admin page whose classes
 * were `ad-page`, `ad-head`, `ad-bar`, `ad-grid` showed blank in production on the operator's computer, in two browsers:
 * an extension applied the generic hiding filters of EasyList to these names (`position: absolute` injected). Invisible
 * in the tests and in the captures of fidelity, which run without an extension; two hours of diagnosis.
 *
 * Refused names: those starting with `ad-`, `ads-`, `adv-`, `banner-ad` (then `-`, `s` or the end), `advert` or
 * `sponsor` (the prefixes of the generic filters). `add-on`, `advanced`, `adresse`, `badge` stay accepted. Read in the
 * `class`, `className` and `id` attributes (outside `{...}` expressions), the Svelte `class:` directives and the
 * selectors of the style sheets and of the `<style>` blocks; never in the text of a page, a script or a `data-*`.
 */

/** Files of interface where the names are read. */
export const ADBLOCK_FILES = /\.(?:svelte|vue|astro|tsx|jsx|html|htm|css|scss|sass|less)$/i;
const STYLE_FILE = /\.(?:css|scss|sass|less)$/i;

/** A name the generic filters hide. */
export const ADBLOCK_NAME = /^(?:(?:ad|ads|adv)-|banner-ads?(?:-|$)|advert|sponsor)/i;
export const ADBLOCK_MESSAGE = 'masqué par les filtres anti-pub du poste de l\'opérateur (préfixes des filtres génériques EasyList : ad-, ads-, adv-, advert, banner-ad, sponsor) ; le renommer (par exemple art-, item-)';

export interface AdBlockedName { line: number; kind: 'classe' | 'identifiant'; name: string }

const NAME = /-?[A-Za-z_][\w-]*/g;
/** Not preceded by a letter or `-`: `data-id` and `data-class` are no `id` nor `class`. */
const ATTRIBUTE = /(?<![\w-])(class|className|id)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const DIRECTIVE = /(?<![\w-])class:(-?[A-Za-z_][\w-]*)/g;
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
    let css: string | null = null;
    if (style) css = raw;
    else {
      for (const m of raw.matchAll(ATTRIBUTE)) {
        const value = m[2] ?? m[3] ?? '';
        const start = m.index! + m[0].indexOf(value);
        // Names outside the `{...}` expressions of the value.
        const plain = value.replace(/\{[^}]*\}/g, match => ' '.repeat(match.length));
        for (const n of plain.matchAll(NAME)) found(start + n.index!, m[1] === 'id' ? 'identifiant' : 'classe', n[0]);
      }
      for (const m of raw.matchAll(DIRECTIVE)) found(m.index!, 'classe', m[1]!);
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
