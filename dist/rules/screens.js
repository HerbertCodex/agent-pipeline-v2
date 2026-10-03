import { globToRegExp } from '../db/glob.js';
import { mockupDecision, screenKey } from '../design/registry.js';
import { routeOf } from '../knowledge/code-map.js';
import { anchoredQuote } from './operator.js';
/**
 * Whether a file is a screen: a page, a layout or an error page of the routes the tool knows (SvelteKit `+page.svelte`,
 * Next `app/**\/page.tsx`, Remix `app/routes/*.tsx`, Nuxt, Astro, Vue `pages/**`), or a file of `rules.screens`. Server
 * code of a route (`+page.server.ts`, `+server.ts`, `pages/api/**`) is not a screen.
 */
export function isScreen(path, extra = []) {
    if (extra.some(re => re.test(path)))
        return true;
    const route = routeOf(path);
    if (!route)
        return false;
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (name.startsWith('+'))
        return /^\+(page|layout|error)(@[^.]*)?\.svelte$/.test(name);
    if (/(^|\/)(pages|routes)\/api(\/|\.)/.test(path) || /(^|\/)app\/api\//.test(path))
        return false;
    if (/^(page|layout|template|not-found|error|loading|default)\.(tsx|jsx|js|mdx)$/.test(name))
        return true;
    return /\.(svelte|vue|astro|tsx|jsx|mdx)$/.test(name);
}
/**
 * The confirmed operator mockups of a ledger, read by the registry's parser (`mockupDecision`): the screens of a
 * registered mockup are those `apv design register` wrote after its file and fingerprint, never words of its title.
 */
export function mockupsOf(decisions) {
    const out = [];
    for (const d of decisions) {
        if (d.source !== 'operator')
            continue;
        const mockup = mockupDecision(d);
        if (mockup)
            out.push({ id: d.id, slug: mockup.slug, screens: mockup.screens, paths: d.scope?.paths ?? [], sourceQuote: d.sourceQuote });
    }
    return out;
}
/** Keys a route answers to: the whole route and each of its fixed segments (`/admin/articles`: admin-articles, admin, articles). */
function routeKeys(path) {
    const route = routeOf(path)?.route ?? null;
    if (!route)
        return [];
    const segments = route.split('/').filter(s => s && !/^[[:]/.test(s));
    const keys = [screenKey(route), ...segments.map(screenKey)];
    if (route === '/')
        keys.push('accueil', 'home', 'index');
    return [...new Set(keys.filter(Boolean))];
}
/** Whether a mockup covers a screen file: a path of its scope matches the file, or its name or one of its screens names its route. */
export function covers(mockup, path) {
    for (const glob of mockup.paths) {
        try {
            if (globToRegExp(glob).test(path))
                return true;
        }
        catch { /* invalid glob: ignored */ }
    }
    const keys = routeKeys(path);
    return [mockup.slug, ...mockup.screens].some(s => keys.includes(screenKey(s)));
}
/**
 * For each screen the change adds or modifies, the validated mockup that covers it. A mockup counts when it is in the
 * ledger of the base (merged, so reviewed), or when the change brings it and its quote is found word for word among the
 * messages the operator typed (src/rules/operator.ts): a validation an agent wrote in the ledger alone never counts.
 */
export function screenCoverage(files, atBase, atHead, messages) {
    const base = mockupsOf(atBase);
    const baseIds = new Set(base.map(m => m.id));
    const added = mockupsOf(atHead).filter(m => !baseIds.has(m.id));
    return files.map(file => {
        const fromBase = base.find(m => covers(m, file));
        if (fromBase)
            return { file, mockup: { id: fromBase.id, anchor: 'base' }, unanchored: [] };
        const candidates = added.filter(m => covers(m, file));
        const anchored = candidates.find(m => anchoredQuote(messages, m.sourceQuote) !== null);
        if (anchored)
            return { file, mockup: { id: anchored.id, anchor: 'operator' }, unanchored: [] };
        return { file, mockup: null, unanchored: candidates.map(m => m.id) };
    });
}
export function screenMatchers(globs) {
    return globs.map(g => globToRegExp(g));
}
//# sourceMappingURL=screens.js.map