import { posix } from 'node:path';

/** Extensions of source code files; everything else (docs, data, assets, SQL) is left out of the analysis. */
export const CODE_EXTENSIONS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'svelte', 'vue', 'astro',
  'py', 'go', 'rs', 'java', 'kt', 'kts', 'cs', 'rb', 'php', 'swift', 'scala', 'dart', 'ex', 'exs', 'erl', 'lua',
  'c', 'h', 'cc', 'cpp', 'hpp', 'm', 'mm',
]);
/** Extensions whose capitalized files are UI components: their shared prefix is a naming convention. */
const COMPONENT_EXTENSIONS = new Set(['svelte', 'vue', 'tsx', 'jsx', 'astro']);
/** Name parts that mark a test or test support file (`x.test.ts`, `x.spec.ts`, `x.fixture.ts`, `x.stories.tsx`). */
const TEST_INFIXES = new Set(['test', 'tests', 'spec', 'specs', 'e2e', 'bench', 'fixture', 'fixtures', 'mock', 'mocks', 'stories', 'story']);
/** Test folders (`tests/`, `__tests__/`, `e2e/`) and test file names of other ecosystems (`test_x.py`, `x_test.go`). */
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|__mocks__|testdata|e2e|fixtures)\/|(?:^|\/)test_[^/]+$|_test\.[a-z]+$/i;
/** Entry points of a folder: never grouped nor renamed. */
const ENTRY_STEMS = new Set(['index', 'main', 'mod', 'lib', 'init']);

export interface FileName {
  /** Repository-relative path, `/` separated. */
  path: string;
  dir: string;
  name: string;
  /** Name before its first dot (`cookie-notice` for `cookie-notice.svelte.ts`). */
  stem: string;
  /** Name parts between the stem and the extension (`['svelte']`, `['test']`). */
  infixes: string[];
  ext: string;
  test: boolean;
  /** Capitalized UI component (`QuickAddDialog.svelte`). */
  component: boolean;
  /** Framework or entry file (`+page.svelte`, `[id].ts`, `_app.tsx`, `index.ts`): counted, never grouped. */
  reserved: boolean;
  /** Lower-case words of the stem (`QuickAddDialog`: quick, add, dialog; `sign-in-origin`: sign, in, origin). */
  tokens: string[];
}

/** Lower-case words of a name: split on separators and on camelCase or PascalCase boundaries. */
export function tokenize(stem: string): string[] {
  return stem.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/).filter(Boolean).map(t => t.toLowerCase());
}

/** A code file's name, parsed; null for anything that is not source code. */
export function parseName(path: string): FileName | null {
  const name = posix.basename(path);
  const dir = posix.dirname(path);
  const parts = name.split('.');
  if (parts.length < 2 || parts[0] === '') return null;
  const ext = parts.at(-1)!.toLowerCase();
  if (!CODE_EXTENSIONS.has(ext)) return null;
  const stem = parts[0]!;
  const infixes = parts.slice(1, -1).map(p => p.toLowerCase());
  const tokens = tokenize(stem);
  return {
    path, dir, name, stem, infixes, ext, tokens,
    test: infixes.some(i => TEST_INFIXES.has(i)) || TEST_PATH.test(path),
    component: COMPONENT_EXTENSIONS.has(ext) && /^[A-Z]/.test(stem),
    reserved: !/^[A-Za-z0-9]/.test(stem) || ENTRY_STEMS.has(stem.toLowerCase()) || tokens.length === 0,
  };
}

/** Singular of an English word by its regular endings (`applications`, `addresses`, `categories`). */
export function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:s|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Two words name the same thing: equal, singular and plural (`application`, `applications`), or a regular
 * participle (`schedule`, `scheduled`).
 */
export function related(a: string, b: string): boolean {
  const left = new Set([a, singular(a)]);
  for (const y of [b, singular(b)]) {
    for (const x of left) {
      if (x === y) return true;
      // Participles only between real words: `in` and `ind` are not the same thing.
      if (Math.min(x.length, y.length) >= 4 && (x === `${y}d` || y === `${x}d` || x === `${y}ed` || y === `${x}ed`)) return true;
    }
  }
  return false;
}

/** True when `prefix` words start `tokens`, the words compared with `related`. */
export function startsWith(tokens: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.length <= tokens.length && prefix.every((p, i) => related(tokens[i]!, p));
}

/** Separator of a module name: `-` (kebab-case, the default), `_` (snake_case) or `` (camelCase). */
function separator(stem: string): string {
  if (stem.includes('-')) return '-';
  if (stem.includes('_')) return '_';
  return /[A-Z]/.test(stem) ? '' : '-';
}

/** Joins words in the style of `stem` (`events-repository`, `events_repository`, `eventsRepository`). */
export function joinLike(stem: string, words: readonly string[]): string {
  const sep = separator(stem);
  if (sep !== '') return words.join(sep);
  return words.map((w, i) => (i === 0 ? w : `${w[0]!.toUpperCase()}${w.slice(1)}`)).join('');
}

/** A folder name for words: kebab-case, or snake_case when the files use it. */
export function folderName(words: readonly string[], sample: string): string {
  return words.join(separator(sample) === '_' ? '_' : '-');
}
