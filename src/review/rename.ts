import { execFileSync } from 'node:child_process';

/**
 * Pure renames of class and id names, for `apv review plan` (docs/REGLES.md, « Renommage pur »). Pilot project, 8 October
 * 2026: a strict rename of CSS classes (`ad-*` to `art-*`) was asked for a fidelity review with captures, although its
 * diff was empty once the names were neutralized.
 *
 * A changed file is a candidate when its removed and added lines are the same line for line once every class and id
 * name is neutralized: in `class`, `className` and `id` attributes (outside `{...}` expressions), in the references to an
 * id (`for`, `htmlFor`, `aria-labelledby`, `aria-describedby`, `aria-controls`, `aria-owns`), in a Svelte `class:` directive,
 * in a line of selectors (style sheets, `<style>` of a component) and in a string that only repeats such names (a
 * selector of a test, `classList.add('art-grid')`). The diff is a pure rename only when, over every candidate:
 * - each old name has one new name and each new name one old name (no merge, no split);
 * - each renamed name is renamed in a selector too (a style the project defines, renamed with its definition: a utility
 *   class of a framework, defined nowhere in the project, is never « renamed »);
 * - no old name is left at the head and no new name was at the base, in the interface and code files outside the folder
 *   of the mockups (a rename to a name that already has a style changes the screen).
 * Anything else, anything unreadable: a content change. Limit: a new name styled by a sheet outside the repository
 * (a library under `node_modules`) is not seen.
 */

const NAME = '-?[A-Za-z_][\\w-]*';
/** What stands for a neutralized name in a compared line. */
const MARK = '\u0005';
const STYLE_FILE = /\.(?:css|scss|sass|less|styl)$/i;
const COMPONENT_FILE = /\.(?:svelte|vue|astro|html|htm|jsx|tsx)$/i;

interface Found { name: string; selector: boolean }
interface Neutral { line: string; names: Found[] }

/** Not preceded by a letter or `-`: `data-id` and `data-class` are no `id` nor `class`. */
const ATTRIBUTE = /((?<![\w-])(?:class|className|id|for|htmlFor|aria-labelledby|aria-describedby|aria-controls|aria-owns)\s*=\s*)(?:"([^"]*)"|'([^']*)')/g;
const DIRECTIVE = new RegExp(`((?<![\\w-])class:)(${NAME})`, 'g');
const STRING = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
/** A string that only repeats selectors (`'.art-grid'`, `'#art-bar .art-head'`) or one class-like name (`'art-grid'`). */
const SELECTOR_STRING = new RegExp(`^\\s*(?:[.#]${NAME}|${NAME}[.#]${NAME})(?:(?:\\s*[\\s,>+~]\\s*|(?=[.#]))[.#]?${NAME})*\\s*$`);
const CLASS_LIKE = /^-?[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+$/;

/** A name alone (not the end of a longer word), and a name after the `.` or `#` of a selector. */
const WORD = new RegExp(`(?<![\\w-])()(${NAME})`, 'g');
const SELECTED = new RegExp(`([.#])(${NAME})`, 'g');

/** The names a pattern (groups: what stays before the name, the name) finds in a text, each replaced by MARK, in order. */
function neutralizeNames(text: string, pattern: RegExp, out: Found[], selector: boolean): string {
  return text.replace(pattern, (_whole: string, prefix: string, name: string) => {
    out.push({ name, selector });
    return `${prefix}${MARK}`;
  });
}

/**
 * The part of a line that is a list of selectors, or null: the text before `{`, or a whole line ending with `,`, that
 * starts as a selector (`.`, `#`, `&`, `*`, `:global(`, or a tag name in a style sheet) and holds no markup, quote,
 * assignment, statement nor declaration (`prop: value`, `url(`), and no `(` but the one of a pseudo-class.
 */
export function selectorPart(line: string, styleSheet: boolean): string | null {
  const brace = line.indexOf('{');
  const part = brace >= 0 ? line.slice(0, brace) : /,\s*$/.test(line) ? line : null;
  if (part === null || !part.trim()) return null;
  const start = styleSheet ? /^\s*(?:[.#&*]|:global\(|[a-z][\w-]*(?=[.#:\s[,>+~]|$))/i : /^\s*(?:[.#&*]|:global\()/;
  if (!start.test(part)) return null;
  const bare = part.replace(/:[\w-]+\(/g, ':');
  if (/[<=;"'`(]|:\s|\burl\b/.test(bare)) return null;
  return part;
}

/** A changed line with its class and id names neutralized, and the names in order. */
export function neutralizeLine(line: string, path: string): Neutral {
  const names: Found[] = [];
  const style = STYLE_FILE.test(path);
  let text = line;
  if (!style) {
    // Attribute values: names outside `{...}`; what an expression holds is read by the string rule below.
    text = text.replace(ATTRIBUTE, (_whole: string, head: string, double: string | undefined, single: string | undefined) => {
      const value = double ?? single ?? '';
      const quote = double !== undefined ? '"' : '\'';
      const parts = value.split(/(\{[^}]*\})/);
      const kept = parts.map(p => (p.startsWith('{') ? p : neutralizeNames(p, WORD, names, false))).join('');
      return `${head}${quote}${kept}${quote}`;
    });
    text = text.replace(DIRECTIVE, (_whole: string, head: string, name: string) => { names.push({ name, selector: false }); return `${head}${MARK}`; });
  }
  if (style || COMPONENT_FILE.test(path)) {
    const part = selectorPart(text, style);
    if (part !== null) text = neutralizeNames(part, SELECTED, names, true) + text.slice(part.length);
  }
  if (!style) {
    text = text.replace(STRING, (whole: string, quote: string, body: string) => {
      if (!(SELECTOR_STRING.test(body) || CLASS_LIKE.test(body.trim()))) return whole;
      const found: Found[] = [];
      const inner = neutralizeNames(body, WORD, found, false);
      names.push(...found);
      return `${quote}${inner}${quote}`;
    });
  }
  return { line: text.trimEnd(), names };
}

export interface RenamePair { from: string; to: string; selector: boolean }

/**
 * The pairs of names of a file whose changed lines differ only by class and id names, or null when anything else
 * changes (a text, a structure, a declaration, a line added or removed).
 */
export function renamedNames(patch: { removed: readonly string[]; added: readonly string[] }, path: string): RenamePair[] | null {
  if (!patch.removed.length || patch.removed.length !== patch.added.length) return null;
  const pairs: RenamePair[] = [];
  for (let i = 0; i < patch.removed.length; i++) {
    const before = neutralizeLine(patch.removed[i]!, path);
    const after = neutralizeLine(patch.added[i]!, path);
    if (before.line !== after.line || before.names.length !== after.names.length) return null;
    before.names.forEach((n, k) => {
      const m = after.names[k]!;
      pairs.push({ from: n.name, to: m.name, selector: n.selector || m.selector });
    });
  }
  // Lines that changed nothing but their trailing spaces: not a rename, a content change.
  return pairs.some(p => p.from !== p.to) ? pairs : null;
}

/** Files searched for a name left behind or already there: interface and code, at any depth. */
const SEARCHED = ['*.svelte', '*.vue', '*.astro', '*.html', '*.htm', '*.jsx', '*.tsx', '*.css', '*.scss', '*.sass', '*.less', '*.styl',
  '*.ts', '*.js', '*.mjs', '*.cjs', '*.mts', '*.cts'];

/** The names found at a commit (word boundaries: letters, digits, `_` and `-`), or null when Git cannot say. */
function namesAt(repo: string, sha: string, names: readonly string[], designDir: string): Set<string> | null {
  if (!names.length) return new Set();
  const pattern = `(^|[^A-Za-z0-9_-])(${names.join('|')})($|[^A-Za-z0-9_-])`;
  try {
    const out = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'grep', '-h', '-o', '-I', '-E', '-e', pattern, sha, '--', ...SEARCHED, `:(exclude)${designDir}/**`], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
    });
    return new Set(out.split('\n').map(l => l.replace(/^[^A-Za-z0-9_-]+|[^A-Za-z0-9_-]+$/g, '')).filter(Boolean));
  } catch (error) {
    return (error as { status?: number }).status === 1 ? new Set() : null;
  }
}

export interface RenameInput { repo: string; base: string; head: string; designDir: string }

/**
 * Whether the pairs of every candidate file make one pure rename (see the head of this module): a one-to-one mapping,
 * each renamed name renamed in a selector, the old names gone from the head and the new ones absent from the base.
 */
export function pureRename(candidates: readonly RenamePair[][], input: RenameInput): boolean {
  const forward = new Map<string, string>();
  const backward = new Map<string, string>();
  const defined = new Set<string>();
  for (const pair of candidates.flat()) {
    if ((forward.get(pair.from) ?? pair.to) !== pair.to || (backward.get(pair.to) ?? pair.from) !== pair.from) return false;
    forward.set(pair.from, pair.to); backward.set(pair.to, pair.from);
    if (pair.selector && pair.from !== pair.to) defined.add(pair.from);
  }
  const renamed = [...forward].filter(([from, to]) => from !== to);
  if (!renamed.length || renamed.some(([from]) => !defined.has(from))) return false;
  // A name both old and new (a swap, a chain): never a pure rename.
  if (renamed.some(([from]) => backward.has(from) && backward.get(from) !== from)) return false;
  const left = namesAt(input.repo, input.head, renamed.map(([from]) => from), input.designDir);
  const there = namesAt(input.repo, input.base, renamed.map(([, to]) => to), input.designDir);
  return left !== null && there !== null && left.size === 0 && there.size === 0;
}
