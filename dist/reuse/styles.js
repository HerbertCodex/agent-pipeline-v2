import { blankComments } from './markup.js';
/** At-rules whose block holds ordinary rules (their selectors are read); every other at-rule block is skipped. */
const TRANSPARENT = new Set(['media', 'supports', 'layer', 'container', 'scope', 'document', 'starting-style']);
/** Splits on commas outside parentheses and brackets. */
function splitTop(text, separator) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '(' || c === '[')
            depth++;
        else if (c === ')' || c === ']')
            depth--;
        else if (c === separator && depth === 0) {
            out.push(text.slice(start, i));
            start = i + 1;
        }
    }
    out.push(text.slice(start));
    return out.map(x => x.trim()).filter(Boolean);
}
/**
 * Rules of a stylesheet (or of a `<style>` block, lines offset by `firstLine - 1`). Comments and strings are handled;
 * nested rules are flattened (`.card { .btn {} }` gives `.card .btn`, `&.active` gives `.card.active`). `@utility name`
 * (Tailwind 4) gives the rule `.name`. `topLevel` is false inside another rule.
 */
export function styleRules(text, firstLine = 1) {
    // Line comments of SCSS and Less (`// ...`), never the `//` of a URL (`url(//cdn)`, `https://`).
    const src = blankComments(text).replace(/(^|[^:("'/])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
    const rules = [];
    const stack = [];
    let prelude = '';
    let preludeLine = firstLine;
    let line = firstLine;
    const parent = () => [...stack].reverse().find(c => c.kind !== 'transparent');
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === '\n') {
            line++;
            prelude += ' ';
            continue;
        }
        if (c === '"' || c === '\'') {
            const quote = c;
            let j = i + 1;
            while (j < src.length && src[j] !== quote && src[j] !== '\n')
                j += src[j] === '\\' ? 2 : 1;
            prelude += src.slice(i, j + 1);
            i = j;
            continue;
        }
        if (!prelude.trim() && !/\s/.test(c))
            preludeLine = line;
        if (c === ';' || c === '}') {
            // A declaration (`color: red`) of the rule being read.
            const top = stack.at(-1);
            // `@apply x` (Tailwind) counts as a property of its own: never a layout one.
            const property = /^\s*(-{0,2}[A-Za-z][\w-]*)\s*:/.exec(prelude)?.[1]?.toLowerCase() ?? /^\s*(@[A-Za-z-]+)/.exec(prelude)?.[1]?.toLowerCase();
            if (top?.kind === 'rule' && property)
                for (const rule of top.rules)
                    if (!rule.properties.includes(property))
                        rule.properties.push(property);
            prelude = '';
            if (c === '}')
                stack.pop();
            continue;
        }
        if (c !== '{') {
            prelude += c;
            continue;
        }
        const head = prelude.trim();
        prelude = '';
        const enclosing = parent();
        if (enclosing?.kind === 'skip' || stack.some(s => s.kind === 'skip')) {
            stack.push({ kind: 'skip', selectors: [], rules: [] });
            continue;
        }
        if (head.startsWith('@')) {
            const name = /^@([a-zA-Z-]+)/.exec(head)?.[1]?.toLowerCase() ?? '';
            if (name === 'utility') {
                const utility = /^@utility\s+([A-Za-z_][\w-]*)/.exec(head)?.[1];
                if (utility)
                    rules.push({ selector: `.${utility}`, line: preludeLine, topLevel: !enclosing, properties: [] });
                stack.push({ kind: 'skip', selectors: [], rules: [] });
            }
            else
                stack.push({ kind: TRANSPARENT.has(name) ? 'transparent' : 'skip', selectors: [], rules: [] });
            continue;
        }
        const own = splitTop(head, ',');
        const selectors = enclosing?.kind === 'rule'
            ? enclosing.selectors.flatMap(p => own.map(s => (s.includes('&') ? s.replaceAll('&', p) : `${p} ${s}`)))
            : own;
        const ownRules = selectors.map(selector => ({ selector, line: preludeLine, topLevel: !enclosing, properties: [] }));
        rules.push(...ownRules);
        stack.push({ kind: 'rule', selectors, rules: ownRules });
    }
    return rules;
}
/** `:global(x)`, `:deep(x)`, `::v-deep(x)` and `:is(x)` unwrapped to `x`; `::v-deep` and `>>>` alone dropped. */
export function unwrapScoping(selector) {
    let out = selector;
    for (let guard = 0; guard < 10; guard++) {
        const next = out.replace(/:{1,2}(?:global|deep|v-deep|is|where)\(([^()]*)\)/g, '$1');
        if (next === out)
            break;
        out = next;
    }
    return out.replace(/::v-deep|>>>|\/deep\//g, ' ').replace(/:global\b/g, ' ').trim();
}
/** Compounds of a selector, split on combinators (space, `>`, `+`, `~`) outside parentheses and brackets. */
export function compounds(selector) {
    const out = [];
    let depth = 0;
    let current = '';
    for (const c of selector) {
        if (c === '(' || c === '[')
            depth++;
        if (c === ')' || c === ']')
            depth--;
        if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) {
            if (current.trim())
                out.push(current.trim());
            current = '';
            continue;
        }
        current += c;
    }
    if (current.trim())
        out.push(current.trim());
    return out;
}
/** Class names of a compound (`.btn.btn--primary:hover` gives btn, btn--primary), pseudo-class arguments left out. */
export function classesOf(compound) {
    const bare = compound.replace(/\([^()]*\)/g, '').replace(/\[[^\]]*\]/g, '');
    return [...bare.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map(m => m[1]);
}
/**
 * Selectors of a theme, a state or the document, never primitives: `html`, `:root`, `body`, `.dark`, `.light`,
 * `.theme-*`, `[data-theme]`, and state classes (`.active`, `.is-open`, `.has-error`, `.disabled`...).
 */
const THEME_OR_STATE = /^(?:dark|light|theme(?:-[\w-]+)?|[\w-]+-theme|active|inactive|open|opened|closed|selected|checked|disabled|enabled|current|visible|hidden|expanded|collapsed|focused|pressed|loading|error|success|warning|valid|invalid|(?:is|has|js|no|can)-[\w-]+)$/;
/**
 * Primitives defined by a global stylesheet: the base class of each top-level rule (inside `@media`, `@layer` and the
 * like included), that is the first class of its first compound, `@utility` names too. `.btn:hover` and `.btn.active`
 * give `btn` only; a rule whose first compound is the document, a theme or a state (`:root`, `html.dark .x`, `.dark .x`,
 * `.is-open`) or has no class (`body`, `a:hover`) gives nothing.
 */
export function primitivesOf(text) {
    const found = new Set();
    for (const rule of styleRules(text)) {
        if (!rule.topLevel)
            continue;
        const first = compounds(unwrapScoping(rule.selector))[0];
        if (!first || /^(?:html|:root|body)\b|\[data-(?:theme|mode|color-scheme)/i.test(first))
            continue;
        const base = classesOf(first)[0];
        if (base && !THEME_OR_STATE.test(base))
            found.add(base);
    }
    return [...found].sort();
}
/** A primitive list: exact class names and prefixes (`.pill--*`), minus the exceptions. */
export class Primitives {
    exact = new Set();
    prefixes = [];
    exceptExact = new Set();
    exceptPrefixes = [];
    constructor(classes, selectors, except) {
        for (const c of classes)
            this.exact.add(c);
        for (const s of selectors)
            this.add(s, this.exact, this.prefixes);
        for (const s of except)
            this.add(s, this.exceptExact, this.exceptPrefixes);
    }
    add(selector, exact, prefixes) {
        const name = selector.replace(/^\./, '');
        if (name.endsWith('*'))
            prefixes.push(name.slice(0, -1));
        else
            exact.add(name);
    }
    get size() { return this.exact.size + this.prefixes.length; }
    has(name) {
        if (this.exceptExact.has(name) || this.exceptPrefixes.some(p => name.startsWith(p)))
            return false;
        return this.exact.has(name) || this.prefixes.some(p => name.startsWith(p));
    }
}
/**
 * Properties that place a component without changing how it looks: margins, width, alignment, order, grid and flex
 * placement, position. A nested adjustment that declares only these is accepted with `styles.nested: "layout"`; colour,
 * border, radius, size, font, padding or shadow are a redefinition of the primitive.
 */
const LAYOUT = /^(?:margin(?:-[a-z-]+)?|width|min-width|max-width|min-height|white-space|inline-size|min-inline-size|max-inline-size|flex|flex-grow|flex-shrink|flex-basis|order|align-self|justify-self|place-self|grid-(?:area|column|row|column-start|column-end|row-start|row-end)|position|inset(?:-[a-z-]+)?|top|right|bottom|left|z-index|display|visibility)$/;
export const isLayoutOnly = (properties) => properties.every(p => LAYOUT.test(p));
/**
 * Local rules that restyle a primitive. The selector is unwrapped (`:global(.btn)` is `.btn`), then: a primitive
 * class in its first compound is a redefinition (`.btn`, `.btn.mine`, `.btn:hover`); a primitive that only follows a
 * class of the component (`.panel .btn`) is a nested adjustment, reported with `nested: true`.
 */
export function restyledPrimitives(rules, primitives) {
    const hits = [];
    for (const rule of rules) {
        const parts = compounds(unwrapScoping(rule.selector));
        const first = parts[0] ? classesOf(parts[0]).find(c => primitives.has(c)) : undefined;
        if (first) {
            hits.push({ line: rule.line, selector: rule.selector, primitive: first, nested: false, properties: rule.properties });
            continue;
        }
        const later = parts.slice(1).flatMap(classesOf).find(c => primitives.has(c));
        if (later)
            hits.push({ line: rule.line, selector: rule.selector, primitive: later, nested: true, properties: rule.properties });
    }
    return hits;
}
//# sourceMappingURL=styles.js.map