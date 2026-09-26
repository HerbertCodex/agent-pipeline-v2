import { matches } from './policy.js';
/**
 * Whether two portable globs (the syntax of `allowedPaths`: `*`, `**`, `?`, everything else literal) can match
 * a common path. Exact: each glob is turned into the automaton of the regular expression `matches` builds, and
 * the product of the two automata is searched for a common accepted path. Used to decide whether a decision
 * scoped to some paths concerns a spec whose tasks may change other paths.
 */
export function globsOverlap(a, b) {
    // Same validation as the matcher: an unsupported glob is refused, never silently disjoint.
    matches('probe', a);
    matches('probe', b);
    const x = automaton(a);
    const y = automaton(b);
    const seen = new Set();
    const stack = [];
    const push = (p, q) => {
        for (const i of closure(x, p))
            for (const j of closure(y, q)) {
                const key = `${i},${j}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    stack.push([i, j]);
                }
            }
    };
    push(0, 0);
    while (stack.length) {
        const [i, j] = stack.pop();
        if (i === x.final && j === y.final)
            return true;
        for (const e of x.edges[i])
            for (const f of y.edges[j])
                if (compatible(e.on, f.on))
                    push(e.to, f.to);
    }
    return false;
}
function compatible(a, b) {
    if (a.kind === 'char' && b.kind === 'char')
        return a.char === b.char;
    if (a.kind === 'char')
        return b.kind === 'any' || a.char !== '/';
    if (b.kind === 'char')
        return a.kind === 'any' || b.char !== '/';
    return true;
}
/** Non-deterministic automaton of the regular expression built by `matches` (same tokens, same order). */
function automaton(pattern) {
    const edges = [[]];
    const epsilon = [[]];
    const state = () => { edges.push([]); epsilon.push([]); return edges.length - 1; };
    let current = 0;
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        const next = state();
        if (c === '*' && pattern[i + 1] === '*') {
            i++;
            if (pattern[i + 1] === '/') {
                // `(?:.*/)?`: nothing, or any characters ending with a slash.
                i++;
                const inner = state();
                epsilon[current].push(next);
                edges[current].push({ on: { kind: 'any' }, to: inner }, { on: { kind: 'char', char: '/' }, to: next });
                edges[inner].push({ on: { kind: 'any' }, to: inner }, { on: { kind: 'char', char: '/' }, to: next });
            }
            else {
                // `.*`
                epsilon[current].push(next);
                edges[current].push({ on: { kind: 'any' }, to: current });
            }
        }
        else if (c === '*') {
            // `[^/]*`
            epsilon[current].push(next);
            edges[current].push({ on: { kind: 'segment' }, to: current });
        }
        else if (c === '?')
            edges[current].push({ on: { kind: 'segment' }, to: next });
        else
            edges[current].push({ on: { kind: 'char', char: c }, to: next });
        current = next;
    }
    return { edges, epsilon, final: current };
}
function closure(a, start) {
    const out = new Set([start]);
    const stack = [start];
    while (stack.length)
        for (const n of a.epsilon[stack.pop()])
            if (!out.has(n)) {
                out.add(n);
                stack.push(n);
            }
    return [...out];
}
//# sourceMappingURL=overlap.js.map