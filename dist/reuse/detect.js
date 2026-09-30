import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRead, resolveFullRef } from '../run/git-probe.js';
import { isComponentFile, routeOf } from '../knowledge/code-map.js';
import { componentName } from './names.js';
import { DEFAULT_NATIVE_ELEMENTS, DEFAULT_REUSE_IGNORE, DEFAULT_ROLE_FAMILIES, DEFAULT_STYLE_SOURCES, ELEMENT_FAMILIES, UI_EXTENSIONS, extensionOf, globMatcher } from './config.js';
/** The gate of `apv reuse check`, added by `apv init` and `apv onboard` to a web project (task stage: it also runs in the full suite). */
export const REUSE_GATE = { id: 'reuse', command: ['apv', 'reuse', 'check'], covers: ['architecture'], stage: 'task', readOnly: true, mandatory: true };
/** The gate of the code map, added to every project: it fails when `.apv/code-map.md` no longer matches the code. */
export const MAP_GATE = { id: 'code-map', command: ['apv', 'map', '--check'], covers: ['architecture'], stage: 'task', readOnly: true, mandatory: true };
/** Dependencies that make a project a web interface. */
const WEB_DEPENDENCIES = /^(?:svelte|@sveltejs\/kit|react|react-dom|next|vue|nuxt|astro|solid-js|@solidjs\/start|preact|lit|@angular\/core|@remix-run\/[\w-]+|@builder\.io\/qwik|@qwik\.dev\/core|htmx\.org|alpinejs)$/;
/** Folder names of shared components. */
const SHARED_NAMES = new Set(['components', 'ui', 'shared', 'common', 'widgets', 'primitives', 'design-system', 'designsystem', 'atoms', 'molecules', 'organisms', 'elements']);
/** Files that declare the language of the document. */
const LANG_FILES = ['src/app.html', 'index.html', 'src/index.html', 'public/index.html', 'app.html', 'src/app/layout.tsx', 'app/layout.tsx', 'src/app/layout.jsx', 'app/layout.jsx', 'src/layouts/Layout.astro', 'nuxt.config.ts', 'nuxt.config.js'];
function readJson(path) {
    try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }
    catch {
        return null;
    }
}
/** The branch changes go to: `origin/HEAD`, else `origin/main` or `origin/master`, else the current branch. */
export function detectReference(repo) {
    const head = gitRead(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    if (head?.startsWith('refs/remotes/'))
        return head.slice('refs/remotes/'.length);
    for (const name of ['origin/main', 'origin/master'])
        if (resolveFullRef(repo, name).sha)
            return name;
    const branch = gitRead(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return branch && resolveFullRef(repo, branch).sha ? branch : null;
}
/** The language of the interface texts, from the `lang` of the document (`<html lang="fr">`, `lang: 'fr'`). */
export function detectLocale(repo) {
    for (const file of LANG_FILES) {
        let text;
        try {
            text = readFileSync(join(repo, file), 'utf8');
        }
        catch {
            continue;
        }
        const lang = /<html[^>]*\slang=["']([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)["']/.exec(text)?.[1] ?? /\blang\s*:\s*["']([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)["']/.exec(text)?.[1];
        if (lang)
            return lang.toLowerCase().replace(/-([a-z0-9]+)$/, (_, r) => `-${r.toUpperCase()}`);
    }
    return null;
}
/**
 * What `apv init` and `apv onboard` propose for the reuse check: whether the project is a web interface, its shared
 * component folders (the highest folders named components, ui, shared... that hold components, outside the routes), the
 * primitives folder (`ui`, `primitives`) where native elements are allowed, the shared component that replaces each
 * reserved element, its global stylesheets, the language of its texts and the reference branch.
 */
export function detectReuse(repo, files) {
    const ignored = globMatcher([...DEFAULT_REUSE_IGNORE]);
    const kept = files.filter(f => !ignored(f));
    const signals = [];
    const pkg = readJson(join(repo, 'package.json'));
    const deps = Object.keys({ ...(pkg?.['dependencies'] ?? {}), ...(pkg?.['devDependencies'] ?? {}) }).filter(d => WEB_DEPENDENCIES.test(d)).sort();
    if (deps.length)
        signals.push(`package.json : ${deps.join(', ')}`);
    const ui = kept.filter(f => UI_EXTENSIONS.has(extensionOf(f)));
    if (ui.length)
        signals.push(`${ui.length} fichier(s) d'interface (${[...new Set(ui.map(extensionOf))].sort().map(x => `.${x}`).join(', ')})`);
    const components = kept.filter(isComponentFile);
    const routeRoots = new Set(kept.map(routeOf).filter(r => r !== null).map(r => r.root));
    const inRoutes = (path) => [...routeRoots].some(root => path.startsWith(`${root}/`));
    const sharedDirs = new Set();
    const primitiveDirs = new Set();
    for (const path of components) {
        if (inRoutes(path))
            continue;
        const parts = path.split('/').slice(0, -1);
        const first = parts.findIndex(p => SHARED_NAMES.has(p.toLowerCase()));
        if (first < 0)
            continue;
        sharedDirs.add(parts.slice(0, first + 1).join('/'));
        const primitive = parts.findIndex(p => p === 'ui' || p === 'primitives');
        if (primitive >= 0)
            primitiveDirs.add(parts.slice(0, primitive + 1).join('/'));
    }
    const shared = [...sharedDirs].sort().map(d => `${d}/**`);
    const primitives = [...primitiveDirs].sort().map(d => `${d}/**`);
    const sharedMatch = globMatcher(shared.length ? shared : ['**/components/**']);
    const sharedComponents = components.filter(sharedMatch).map(p => componentName(p, DEFAULT_ROLE_FAMILIES));
    const elements = {};
    for (const element of DEFAULT_NATIVE_ELEMENTS) {
        elements[element] = sharedComponents.find(c => c.family === ELEMENT_FAMILIES[element])?.path ?? null;
    }
    const present = new Set(files);
    const styleSources = DEFAULT_STYLE_SOURCES.filter(s => present.has(s));
    const locale = detectLocale(repo);
    const reference = detectReference(repo);
    const section = {
        ...(reference ? { reference } : {}),
        ...(shared.length ? { shared } : {}),
        native: { elements, ...(primitives.length ? { allowedPaths: primitives } : {}) },
        ...(locale ? { typography: { locale } } : {}),
    };
    return { web: deps.length > 0 || ui.length > 0, signals, section, shared, primitives, styleSources, locale, reference };
}
//# sourceMappingURL=detect.js.map