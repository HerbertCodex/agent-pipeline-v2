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
        if (c === ';') {
            prelude = '';
            continue;
        }
        if (c === '}') {
            stack.pop();
            prelude = '';
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
            stack.push({ kind: 'skip', selectors: [] });
            continue;
        }
        if (head.startsWith('@')) {
            const name = /^@([a-zA-Z-]+)/.exec(head)?.[1]?.toLowerCase() ?? '';
            if (name === 'utility') {
                const utility = /^@utility\s+([A-Za-z_][\w-]*)/.exec(head)?.[1];
                if (utility)
                    rules.push({ selector: `.${utility}`, line: preludeLine, topLevel: !enclosing });
                stack.push({ kind: 'skip', selectors: [] });
            }
            else
                stack.push({ kind: TRANSPARENT.has(name) ? 'transparent' : 'skip', selectors: [] });
            continue;
        }
        const own = splitTop(head, ',');
        const selectors = enclosing?.kind === 'rule'
            ? enclosing.selectors.flatMap(p => own.map(s => (s.includes('&') ? s.replaceAll('&', p) : `${p} ${s}`)))
            : own;
        for (const selector of selectors)
            rules.push({ selector, line: preludeLine, topLevel: !enclosing });
        stack.push({ kind: 'rule', selectors });
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
 * Primitives defined by a global stylesheet: the classes of the first compound of its top-level rules (inside
 * `@media`, `@layer` and the like included), `@utility` names too. `.btn:hover` and `.btn--primary` count; the classes
 * that only follow a combinator (`.card .title`) do not.
 */
export function primitivesOf(text) {
    const found = new Set();
    for (const rule of styleRules(text)) {
        if (!rule.topLevel)
            continue;
        const first = compounds(unwrapScoping(rule.selector))[0];
        if (first)
            for (const c of classesOf(first))
                found.add(c);
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
            hits.push({ line: rule.line, selector: rule.selector, primitive: first, nested: false });
            continue;
        }
        const later = parts.slice(1).flatMap(classesOf).find(c => primitives.has(c));
        if (later)
            hits.push({ line: rule.line, selector: rule.selector, primitive: later, nested: true });
    }
    return hits;
}
//# sourceMappingURL=styles.js.map