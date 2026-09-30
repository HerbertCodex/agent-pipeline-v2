/**
 * Detection of copied blocks: a token-based clone detector (exact copies, whitespace and comments ignored), the
 * method of jscpd (Rabin-Karp windows of `minTokens` tokens, extended to the longest common run), written in the tool
 * so that it runs without a dependency, without network, the same way on every stack, and on the files of any commit.
 */
const blank = (m) => m.replace(/[^\n]/g, ' ');
/**
 * Import and re-export statements blanked (lines kept): two pages that import the same components are not a copy.
 * ECMAScript (`import ... from '...'`, `import '...'`, `export ... from '...'`, multi-line included) and Python.
 */
export function blankImports(text, ext) {
    if (ext === 'py')
        return text.replace(/^[ \t]*(?:from[ \t]+[\w.]+[ \t]+import[ \t]+(?:\([^)]*\)|[^\n]*)|import[ \t]+[^\n]*)/gm, blank);
    // Between the keyword and `from`: an import clause only (names, `* as x`, one `{ ... }`), never another statement.
    const clause = `(?:(?!\\b(?:import|export|const|let|var|function|class|default)\\b)[^;'"\`=(){}:])*?`;
    const statement = new RegExp(`^[ \\t]*(?:import|export)\\b${clause}(?:\\{[^;'"\`=(){}]*\\}${clause})?\\bfrom[ \\t]*(['"])[^'"\\n]*\\1[ \\t]*;?|^[ \\t]*import[ \\t]*(['"])[^'"\\n]*\\2[ \\t]*;?`, 'gm');
    return text.replace(statement, blank);
}
/** Interns token texts as integers shared by every file of one analysis (a copy has the same ids everywhere). */
export class TokenTable {
    ids = new Map();
    id(text) {
        let id = this.ids.get(text);
        if (id === undefined) {
            id = this.ids.size + 1;
            this.ids.set(text, id);
        }
        return id;
    }
}
const HASH_COMMENT = new Set(['py', 'rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'r', 'pl', 'ex', 'exs']);
const NO_LINE_COMMENT = new Set(['css', 'html', 'htm']);
const IDENT = /[A-Za-z0-9_$\u00C0-\uFFFF]/;
const OPERATOR = '=!<>&|?+-*%^~:.';
/**
 * Tokens of a source file, language-agnostic: identifiers and numbers, strings (quoted strings end at the end of their
 * line, template strings may span lines), operators (`=>`, `===`), and every other character alone. Whitespace and comments are dropped:
 * `//` and `/* *\/` (except in CSS and HTML for `//`), `<!-- -->`, `#` for the languages that use it.
 */
export function tokenize(text, ext, table) {
    const out = [];
    const hash = HASH_COMMENT.has(ext);
    const slashes = !NO_LINE_COMMENT.has(ext) && !hash;
    let line = 1;
    let i = 0;
    const n = text.length;
    while (i < n) {
        const c = text[i];
        if (c === '\n') {
            line++;
            i++;
            continue;
        }
        if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
            i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            const stop = end < 0 ? n : end + 2;
            for (let k = i; k < stop; k++)
                if (text[k] === '\n')
                    line++;
            i = stop;
            continue;
        }
        if (c === '<' && text.startsWith('<!--', i)) {
            const end = text.indexOf('-->', i + 4);
            const stop = end < 0 ? n : end + 3;
            for (let k = i; k < stop; k++)
                if (text[k] === '\n')
                    line++;
            i = stop;
            continue;
        }
        if ((slashes && c === '/' && text[i + 1] === '/' && text[i - 1] !== ':') || (hash && c === '#')) {
            while (i < n && text[i] !== '\n')
                i++;
            continue;
        }
        if (c === '"' || c === '\'' || c === '`') {
            const start = i;
            const startLine = line;
            i++;
            while (i < n) {
                const d = text[i];
                if (d === '\\') {
                    i += 2;
                    continue;
                }
                if (d === '\n') {
                    if (c !== '`')
                        break;
                    line++;
                }
                i++;
                if (d === c)
                    break;
            }
            out.push({ id: table.id(text.slice(start, i)), line: startLine });
            continue;
        }
        if (IDENT.test(c)) {
            const start = i;
            while (i < n && IDENT.test(text[i]))
                i++;
            out.push({ id: table.id(text.slice(start, i)), line });
            continue;
        }
        // An operator is one token (`=>`, `===`, `?.`, `...`), as in jscpd: brackets and separators stay alone.
        const start = i;
        while (i < n && OPERATOR.includes(text[i]) && i - start < 4 && !(i > start && text.startsWith('<!--', i)))
            i++;
        if (i === start)
            i++;
        out.push({ id: table.id(text.slice(start, i)), line });
    }
    return out;
}
const BASE = 1_000_003;
const MAX_CANDIDATES = 64;
function power(k) {
    let p = 1;
    for (let i = 0; i < k - 1; i++)
        p = Math.imul(p, BASE);
    return p;
}
/** Rolling hashes of every window of `k` tokens. */
function windows(ids, k) {
    const count = ids.length - k + 1;
    const out = new Uint32Array(Math.max(0, count));
    if (count <= 0)
        return out;
    const top = power(k);
    let h = 0;
    for (let i = 0; i < k; i++)
        h = (Math.imul(h, BASE) + ids[i]) | 0;
    out[0] = h >>> 0;
    for (let p = 1; p < count; p++) {
        h = (Math.imul((h - Math.imul(ids[p - 1], top)) | 0, BASE) + ids[p + k - 1]) | 0;
        out[p] = h >>> 0;
    }
    return out;
}
/**
 * Clones between files (and inside one file, never overlapping): for each place of each file, in path order, the
 * earliest identical window of `minTokens` tokens is extended as far as both copies stay equal; a clone is kept when
 * both copies span at least `minLines` lines. Each place belongs to one clone at most (a block copied three times
 * gives two clones, each with the first copy).
 */
export function findClones(files, options) {
    const k = options.minTokens;
    const paths = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const ids = new Map();
    for (const path of paths)
        ids.set(path, Int32Array.from(files.get(path), t => t.id));
    const index = new Map();
    const clones = [];
    for (const path of paths) {
        const own = ids.get(path);
        const tokens = files.get(path);
        if (own.length < k)
            continue;
        const hashes = windows(own, k);
        let p = 0;
        const indexed = (q) => {
            const list = index.get(hashes[q]);
            if (!list)
                index.set(hashes[q], [{ path, pos: q }]);
            else if (list.length < MAX_CANDIDATES)
                list.push({ path, pos: q });
        };
        while (p < hashes.length) {
            let best = null;
            for (const candidate of index.get(hashes[p]) ?? []) {
                const other = ids.get(candidate.path);
                const same = candidate.path === path;
                let length = 0;
                while (p + length < own.length && candidate.pos + length < other.length && own[p + length] === other[candidate.pos + length]
                    && (!same || candidate.pos + length < p))
                    length++;
                if (length >= k && (!best || length > best.length))
                    best = { ...candidate, length };
            }
            if (!best) {
                indexed(p);
                p++;
                continue;
            }
            const other = files.get(best.path);
            // Whole lines only: a copy that starts or ends in the middle of a line (the `;` before it, the `<` after it)
            // is trimmed to the lines it covers entirely, on both sides.
            let from = 0;
            let length = best.length;
            const midStart = (t, at) => at > 0 && t[at - 1].line === t[at].line;
            const midEnd = (t, at) => at + 1 < t.length && t[at + 1].line === t[at].line;
            while (length > 0 && (midStart(tokens, p + from) || midStart(other, best.pos + from))) {
                from++;
                length--;
            }
            while (length > 0 && (midEnd(tokens, p + from + length - 1) || midEnd(other, best.pos + from + length - 1)))
                length--;
            if (length >= k) {
                const s = p + from;
                const o = best.pos + from;
                const a = { path, start: s, end: s + length - 1, startLine: tokens[s].line, endLine: tokens[s + length - 1].line };
                const b = { path: best.path, start: o, end: o + length - 1, startLine: other[o].line, endLine: other[o + length - 1].line };
                const lines = Math.min(a.endLine - a.startLine + 1, b.endLine - b.startLine + 1);
                if (lines >= options.minLines)
                    clones.push({ a, b, tokens: length, lines });
            }
            const stop = Math.min(p + best.length, hashes.length);
            for (let q = p; q < stop; q++)
                indexed(q);
            p = stop;
        }
    }
    return clones;
}
/** True when `needle` occurs in `haystack` (twice, without overlap, when `twice`). */
export function occurs(haystack, needle, twice = false) {
    if (!needle.length)
        return true;
    let found = 0;
    for (let i = 0; i + needle.length <= haystack.length; i++) {
        let j = 0;
        while (j < needle.length && haystack[i + j] === needle[j])
            j++;
        if (j === needle.length) {
            found++;
            if (!twice || found === 2)
                return true;
            i += needle.length - 1;
        }
    }
    return false;
}
//# sourceMappingURL=duplicates.js.map