/**
 * Loads by a computed path in a file of the application (second security review of #141, M2): what such a load reaches
 * cannot be read from the text. Counted:
 * - `import.meta.glob`;
 * - `import`, `require` followed (spaces, line breaks, comments allowed, `?.` too) by a parenthesis whose argument is
 *   not one closed string literal (a concatenation, a template with `${`, a variable, a literal left open);
 * - `readFile`, `readFileSync`, `createReadStream`, with the same reading of their first argument (`read`).
 * No bound before the name in a script (a wrapper `_import(`, `$import(`, `myrequire(` may load a module, review of #141,
 * A9); a word bound in a SQL file (`confirm_application_import(` of the pilot project, #262, is a SQL function), where a
 * JavaScript `import(` still counts. In a script (`.js`, `.ts` and their variants) the comments are removed first, by two
 * readings (regular expressions literals recognized, or not) whose findings add up; a reading that ends inside a comment,
 * a string or a template does not remove them. Every other file (components, pages, Markdown, SQL...) is read as it is,
 * its comments counted: in doubt, a load.
 */
export type LoadKind = 'load' | 'read';

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/i;
const SQL = /\.sql$/i;
const NAME = /import|require|readFileSync|readFile|createReadStream/g;
const READS = new Set(['readFileSync', 'readFile', 'createReadStream']);
const WORD = /[A-Za-z0-9_$]/;
/** After these, a `/` opens a regular expression literal (or a word below); after anything else, it divides. */
const BEFORE_REGEX = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);

/**
 * The text of a script without its comments (a block comment becomes a space, a line comment nothing, line breaks kept);
 * null when the reading ends inside a comment, a template or an expression of a template: the text is then not trusted.
 * A quoted string ends at its line break (JavaScript allows none): a quote misread spoils one line at most.
 */
export function withoutComments(text: string, regexAware: boolean): string | null {
  let out = '';
  let state: 'code' | '"' | "'" | '`' = 'code';
  const braces: number[] = [];
  let last = '';
  let word = '';
  const n = text.length;
  for (let i = 0; i < n; i += 1) {
    const c = text[i]!;
    if (state === '"' || state === "'") {
      out += c;
      if (c === '\\' && i + 1 < n) { out += text[i + 1]; i += 1; }
      else if (c === state || c === '\n') { state = 'code'; last = c === '\n' ? '' : c; word = ''; }
      continue;
    }
    if (state === '`') {
      out += c;
      if (c === '\\' && i + 1 < n) { out += text[i + 1]; i += 1; }
      else if (c === '`') { state = 'code'; last = '`'; word = ''; }
      else if (c === '$' && text[i + 1] === '{') { out += '{'; i += 1; braces.push(0); state = 'code'; last = '{'; word = ''; }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      if (end < 0) break;
      i = end - 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return null;
      out += ' ';
      i = end + 1;
      continue;
    }
    if (c === '/' && regexAware && (BEFORE_REGEX.has(last) || (WORD.test(last) && REGEX_WORDS.has(word)))) {
      // A regular expression literal: to its closing `/` on the same line, outside a class `[...]`; none: a division.
      let j = i + 1; let inClass = false; let closed = -1;
      for (; j < n && text[j] !== '\n'; j += 1) {
        const r = text[j]!;
        if (r === '\\') { j += 1; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) { closed = j; break; }
      }
      if (closed > 0) { out += text.slice(i, closed + 1); i = closed; last = ')'; word = ''; continue; }
    }
    out += c;
    if (c === '"' || c === "'" || c === '`') { state = c; continue; }
    if (braces.length && c === '{') braces[braces.length - 1]! += 1;
    else if (braces.length && c === '}') {
      if (braces[braces.length - 1] === 0) { braces.pop(); state = '`'; continue; }
      braces[braces.length - 1]! -= 1;
    }
    if (/\s/.test(c)) continue;
    word = WORD.test(c) ? (WORD.test(last) ? word + c : c) : '';
    last = c;
  }
  if (state === '`' || braces.length) return null;
  return out;
}

/** The index after spaces, line breaks and comments from `i`. */
function skipBlank(text: string, i: number): number {
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); if (end < 0) return text.length; i = end + 2; continue; }
    if (text.startsWith('//', i)) { const end = text.indexOf('\n', i); if (end < 0) return text.length; i = end + 1; continue; }
    return i;
  }
}

/** Whether the argument that starts after the parenthesis at `open` is one closed string literal (then `)` or `,`). */
function literalArgument(text: string, open: number): boolean {
  let i = skipBlank(text, open + 1);
  const quote = text[i];
  if (quote !== '"' && quote !== "'" && quote !== '`') return false;
  for (i += 1; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === '\\') { i += 1; continue; }
    if (quote === '`' && c === '$' && text[i + 1] === '{') return false;
    if (quote !== '`' && c === '\n') return false;
    if (c === quote) break;
  }
  if (i >= text.length) return false;
  const after = text[skipBlank(text, i + 1)];
  return after === ')' || after === ',';
}

/** The loads of one text read as it is: `bounded`, a word character before the name is no call of it. */
function scan(text: string, bounded: boolean): Set<LoadKind> {
  const found = new Set<LoadKind>();
  if (/import\s*\.\s*meta\s*\.\s*glob/.test(text)) found.add('load');
  for (const m of text.matchAll(NAME)) {
    const at = m.index!;
    if (bounded && at > 0 && WORD.test(text[at - 1]!)) continue;
    let i = skipBlank(text, at + m[0].length);
    if (text.startsWith('?.', i)) i = skipBlank(text, i + 2);
    if (text[i] !== '(') continue;
    if (literalArgument(text, i)) continue;
    found.add(READS.has(m[0]) ? 'read' : 'load');
    if (found.size === 2) break;
  }
  return found;
}

/** The kinds of computed loads in the file `path` whose content is `text` (none: an empty set). */
export function computedLoads(path: string, text: string): Set<LoadKind> {
  if (!SCRIPT.test(path)) return scan(text, SQL.test(path));
  const found = new Set<LoadKind>();
  for (const regexAware of [true, false]) {
    const stripped = withoutComments(text, regexAware);
    for (const kind of scan(stripped ?? text, false)) found.add(kind);
  }
  return found;
}
