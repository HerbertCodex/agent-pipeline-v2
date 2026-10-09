import { execFileSync } from 'node:child_process';
/**
 * Pure renames of class and id names, for `apv review plan` (docs/REGLES.md, « Renommage pur »). Pilot project, 8 October
 * 2026: a strict rename of CSS classes (`ad-*` to `art-*`) was asked for a fidelity review with captures, although its
 * diff was empty once the names were neutralized.
 *
 * Only files of interface, of style and of tests are read (`renameKind`), and only in a diff where no other file but
 * documentation changes: a string of server code, of data or of configuration is never « a name » (security review of
 * PR #128: a cipher downgraded in server code, its name renamed in a style sheet, skipped the data and GDPR reviews).
 * A changed file is a candidate when its removed and added lines are the same line for line once every class and id
 * name is neutralized: in `class`, `className` and `id` attributes (outside `{...}` expressions), in the references to an
 * id (`for`, `htmlFor`, `aria-labelledby`, `aria-describedby`, `aria-controls`, `aria-owns`), in a Svelte `class:` directive,
 * in a line of selectors (style sheets, `<style>` of a component) and in a string that only repeats such names (a
 * selector of a test, `classList.add('art-grid')`). The diff is a pure rename only when, over every candidate:
 * - each old name has one new name and each new name one old name (no merge, no split);
 * - each renamed name is renamed in a selector too (a style the project defines, renamed with its definition: a utility
 *   class of a framework, defined nowhere in the project, is never « renamed »);
 * - each file keeps its lines in place: hunks of as many lines on each side, at the same line (no line moved);
 * - no old name is left at the head and no new name was at the base, in any text file outside `node_modules` and the
 *   folder of the mockups (a rename to a name that already has a style changes the screen).
 * Anything else, anything unreadable: a content change. Limit: a new name styled by a sheet outside the repository
 * (a library under `node_modules`) is not seen.
 */
const NAME = '-?[A-Za-z_][\\w-]*';
/** What stands for a neutralized name in a compared line. */
const MARK = '\u0005';
const STYLE_FILE = /\.(?:css|scss|sass|less|styl)$/i;
const COMPONENT_FILE = /\.(?:svelte|vue|astro|html|htm|jsx|tsx|md|svx|mdx)$/i;
/** Files of interface and of style a rename may touch; Markdown only as a page of a router (mdsvex, MDX). */
const INTERFACE_FILE = /\.(?:svelte|vue|astro|html|htm|jsx|tsx|css|scss|sass|less|styl)$/i;
const PAGE_MARKDOWN = /(?:^|\/)(?:routes|pages)\/(?:.*\/)?[^/]+\.(?:md|svx|mdx)$/i;
/** A path a pure rename may touch: interface, style, or a page in Markdown (tests are judged by the caller). */
export const renameKind = (path) => INTERFACE_FILE.test(path) || PAGE_MARKDOWN.test(path);
/**
 * The contexts of a class or id name, and only them (second security review of PR #128: a column of a query, a token of
 * `sandbox`, read as « names » in a component, skipped the data and GDPR reviews). Not preceded by a letter, `-` or `.`,
 * and `=` right after the name, as markup writes it: `data-id` is no `id`, `el.className =` and `const id = '…'` are no
 * attribute.
 */
const ATTRIBUTE = /((?<![\w.-])(class|className|id|for|htmlFor|aria-labelledby|aria-describedby|aria-controls)=)(?:"([^"]*)"|'([^']*)')/g;
/** `class={…}` and `className={…}`: the strings of the expression. */
const CLASS_EXPRESSION = /((?<![\w.-])(?:class|className)=)(\{[^}]*\})/g;
const DIRECTIVE = new RegExp(`((?<![\\w-])class:)(${NAME})`, 'g');
/**
 * Calls that take class or id names (`classList.add('art-grid')`, `getElementById('art-bar')`), and calls that take a
 * selector, read only when it starts with `.` or `#` (`querySelector('.art-grid')`, the `locator` of Playwright).
 */
const NAME_CALL = /(\b(?:classList\.(?:add|remove|toggle|contains|replace)|getElementById)\s*\()([^)]*)\)/g;
const SELECTOR_CALL = /(\b(?:querySelector|querySelectorAll|closest|matches|locator)\s*\()([^)]*)\)/g;
const STRING = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
/** A string of names only (`'art-grid art-wide'`), and a selector that starts with `.` or `#`. */
const NAMES_STRING = new RegExp(`^\\s*${NAME}(?:\\s+${NAME})*\\s*$`);
const SELECTOR_STRING = /^\s*[.#]/;
/** A name alone (not the end of a longer word), and a name after the `.` or `#` of a selector. */
const WORD = new RegExp(`(?<![\\w-])()(${NAME})`, 'g');
const SELECTED = new RegExp(`([.#])(${NAME})`, 'g');
/** The names a pattern (groups: what stays before the name, the name) finds in a text, each replaced by MARK, in order. */
function neutralizeNames(text, pattern, out, selector) {
    return text.replace(pattern, (_whole, prefix, name) => {
        out.push({ name, selector });
        return `${prefix}${MARK}`;
    });
}
/**
 * The part of a line that is a list of selectors, or null: the text before `{`, or a whole line ending with `,`, that
 * starts as a selector (`.`, `#`, `&`, `*`, `:global(`, or a tag name in a style sheet) and holds no markup, quote,
 * assignment, statement nor declaration (`prop: value`, `url(`), and no `(` but the one of a pseudo-class.
 */
export function selectorPart(line, styleSheet) {
    const brace = line.indexOf('{');
    const part = brace >= 0 ? line.slice(0, brace) : /,\s*$/.test(line) ? line : null;
    if (part === null || !part.trim())
        return null;
    const start = styleSheet ? /^\s*(?:[.#&*]|:global\(|[a-z][\w-]*(?=[.#:\s[,>+~]|$))/i : /^\s*(?:[.#&*]|:global\()/;
    if (!start.test(part))
        return null;
    const bare = part.replace(/:[\w-]+\(/g, ':');
    if (/[<=;"'`(]|:\s|\burl\b/.test(bare))
        return null;
    return part;
}
/** A changed line with its class and id names neutralized, and the names in order. */
export function neutralizeLine(line, path) {
    const names = [];
    const style = STYLE_FILE.test(path);
    let text = line;
    // The strings of a piece of code that `accepts` takes: names (`'art-grid'`) or a selector (`'.art-grid'`).
    const strings = (code, kind) => code.replace(STRING, (whole, quote, body) => {
        if (kind === 'names' ? !NAMES_STRING.test(body) : !SELECTOR_STRING.test(body))
            return whole;
        return `${quote}${neutralizeNames(body, kind === 'names' ? WORD : SELECTED, names, false)}${quote}`;
    });
    if (!style) {
        // Attribute values: names outside `{...}`; in the expressions of a class value (`{on ? 'art-x' : ''}`), the strings.
        text = text.replace(ATTRIBUTE, (_whole, head, attribute, double, single) => {
            const value = double ?? single ?? '';
            const quote = double !== undefined ? '"' : '\'';
            const classes = attribute === 'class' || attribute === 'className';
            const kept = value.split(/(\{[^}]*\})/).map(p => (p.startsWith('{') ? (classes ? strings(p, 'names') : p) : neutralizeNames(p, WORD, names, false))).join('');
            return `${head}${quote}${kept}${quote}`;
        });
        text = text.replace(CLASS_EXPRESSION, (_whole, head, expression) => `${head}${strings(expression, 'names')}`);
        text = text.replace(DIRECTIVE, (_whole, head, name) => { names.push({ name, selector: false }); return `${head}${MARK}`; });
        text = text.replace(NAME_CALL, (_whole, head, args) => `${head}${strings(args, 'names')})`);
        text = text.replace(SELECTOR_CALL, (_whole, head, args) => `${head}${strings(args, 'selector')})`);
    }
    if (style || COMPONENT_FILE.test(path)) {
        const part = selectorPart(text, style);
        if (part !== null)
            text = neutralizeNames(part, SELECTED, names, true) + text.slice(part.length);
    }
    return { line: text.trimEnd(), names };
}
/**
 * The pairs of names of a file whose changed lines differ only by class and id names, or null when anything else
 * changes (a text, a structure, a declaration, a line added, removed or moved). Each hunk replaces its lines in place,
 * as many on each side and at the same line (security review of PR #128: a rule moved after another and renamed
 * changes the cascade). Without `hunks`, the lines are taken as one hunk replaced in place.
 */
export function renamedNames(patch, path) {
    if (!patch.removed.length || patch.removed.length !== patch.added.length)
        return null;
    if (patch.hunks && (!patch.hunks.length || patch.hunks.some(h => h.oldCount !== h.newCount || h.oldStart !== h.newStart)))
        return null;
    const pairs = [];
    for (let i = 0; i < patch.removed.length; i++) {
        const before = neutralizeLine(patch.removed[i], path);
        const after = neutralizeLine(patch.added[i], path);
        if (before.line !== after.line || before.names.length !== after.names.length)
            return null;
        before.names.forEach((n, k) => {
            const m = after.names[k];
            pairs.push({ from: n.name, to: m.name, selector: n.selector || m.selector });
        });
    }
    // Lines that changed nothing but their trailing spaces: not a rename, a content change.
    return pairs.some(p => p.from !== p.to) ? pairs : null;
}
/**
 * Files searched for a name left behind or already there: every text file of the repository (Markdown pages of mdsvex,
 * SQL, configuration...), binaries apart, outside `node_modules` (and the mockups, excluded by the caller).
 */
const SEARCHED = ['.', ':(exclude,glob)**/node_modules/**'];
/** The names found at a commit (word boundaries: letters, digits, `_` and `-`), or null when Git cannot say. */
function namesAt(repo, sha, names, designDir) {
    if (!names.length)
        return new Set();
    const pattern = `(^|[^A-Za-z0-9_-])(${names.join('|')})($|[^A-Za-z0-9_-])`;
    try {
        const out = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'grep', '-h', '-o', '-I', '-E', '-e', pattern, sha, '--', ...SEARCHED, `:(exclude,glob)${designDir}/**`], {
            cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
        });
        return new Set(out.split('\n').map(l => l.replace(/^[^A-Za-z0-9_-]+|[^A-Za-z0-9_-]+$/g, '')).filter(Boolean));
    }
    catch (error) {
        return error.status === 1 ? new Set() : null;
    }
}
/**
 * Whether the pairs of every candidate file make one pure rename (see the head of this module): a one-to-one mapping,
 * each renamed name renamed in a selector, the old names gone from the head and the new ones absent from the base.
 */
export function pureRename(candidates, input) {
    const forward = new Map();
    const backward = new Map();
    const defined = new Set();
    for (const pair of candidates.flat()) {
        if ((forward.get(pair.from) ?? pair.to) !== pair.to || (backward.get(pair.to) ?? pair.from) !== pair.from)
            return false;
        forward.set(pair.from, pair.to);
        backward.set(pair.to, pair.from);
        if (pair.selector && pair.from !== pair.to)
            defined.add(pair.from);
    }
    const renamed = [...forward].filter(([from, to]) => from !== to);
    if (!renamed.length || renamed.some(([from]) => !defined.has(from)))
        return false;
    // A name both old and new (a swap, a chain): never a pure rename.
    if (renamed.some(([from]) => backward.has(from) && backward.get(from) !== from))
        return false;
    const left = namesAt(input.repo, input.head, renamed.map(([from]) => from), input.designDir);
    const there = namesAt(input.repo, input.base, renamed.map(([, to]) => to), input.designDir);
    return left !== null && there !== null && left.size === 0 && there.size === 0;
}
//# sourceMappingURL=rename.js.map