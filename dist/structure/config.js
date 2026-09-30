import { isAbsolute, posix } from 'node:path';
import { s } from '../domain/schema.js';
import { invariant } from '../domain/errors.js';
import { globToRegExp } from '../db/glob.js';
/** Codes of the tree findings of `apv structure check`. */
export const FINDING_CODES = ['flat-folder', 'repeated-prefix', 'mixed-roles', 'stray-file'];
/**
 * Codes of the findings that compare the change with its base (`--base`): a code file added to a flat folder, and the
 * architecture map (a folder, route or entry point without description, a broken link). `error` by default: new ones block.
 */
export const CHANGE_CODES = ['flat-growth', 'architecture-map'];
/** Default path of the architecture map (docs/STRUCTURE.md, « Carte de l'architecture »). */
export const DEFAULT_ARCHITECTURE_MAP = 'docs/carte-architecture.md';
/** Stack profiles (src/structure/profiles.ts). */
export const PROFILE_IDS = ['sveltekit', 'nextjs', 'nuxt', 'astro', 'angular', 'vue', 'react', 'python', 'go', 'generic'];
/** Default number of code files a folder may hold directly before `flat-folder`. */
export const DEFAULT_MAX_FLAT_FILES = 12;
/**
 * Default roles. A key starting with `-` is a name suffix (`application-actions.ts`: role `actions`, domain
 * `application`); any other key is a name part anywhere in the name (`security-headers.ts`: role `http`),
 * for cross-cutting concerns that have no domain of their own. A key may hold several words (`sign-in`).
 */
export const DEFAULT_ROLES = {
    '-actions': 'actions', '-action': 'actions',
    '-repository': 'repository', '-repositories': 'repository', '-repo': 'repository',
    '-client': 'client',
    '-service': 'service', '-services': 'service',
    '-controller': 'controller', '-controllers': 'controller',
    '-handler': 'handler', '-handlers': 'handler',
    '-middleware': 'middleware',
    '-utils': 'utilities', '-helpers': 'utilities',
    http: 'http', https: 'http', header: 'http', headers: 'http', cookie: 'http', cookies: 'http', cors: 'http', csrf: 'http',
    request: 'http', response: 'http', body: 'http', ip: 'http',
    auth: 'auth', oauth: 'auth', login: 'auth', logout: 'auth', 'sign-in': 'auth', 'sign-out': 'auth', 'sign-up': 'auth',
    session: 'auth', sessions: 'auth', password: 'auth',
};
/**
 * Folders left out by default (docs: « exclusions par défaut »): dependencies anywhere (`node_modules`), build outputs and
 * tool folders (`dist`, `build`, `coverage`, `vendor`, a name that starts with a dot) only at the root of the repository
 * or of a package (a folder with its own `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `composer.json`).
 * A folder of that name deeper in the sources (`src/lib/x/vendor/`) is code like any other. With `--base`, what the change
 * creates is always analysed, default exclusions or not: only `structure.ignore` (of the base) leaves it out.
 */
export const DEFAULT_IGNORE = ['**/node_modules/**', 'dist/**', 'build/**', 'coverage/**', 'vendor/**', '.*/**'];
const OUTPUT_NAMES = new Set(['dist', 'build', 'coverage', 'vendor']);
const PACKAGE_FILES = /(?:^|\/)(?:package\.json|pyproject\.toml|go\.mod|Cargo\.toml|composer\.json)$/;
/** Roots of the packages of a file list (folders with a manifest), node_modules left out. */
export function packageRoots(paths) {
    const out = new Set();
    for (const p of paths)
        if (PACKAGE_FILES.test(p) && !p.split('/').includes('node_modules'))
            out.add(posix.dirname(p));
    return out;
}
/** Left out by the default exclusions: `node_modules` anywhere, outputs and tool folders at the root of the repository or of a package. */
export function defaultIgnored(path, roots) {
    const parts = path.split('/');
    if (parts.includes('node_modules'))
        return true;
    for (let i = 0; i < parts.length - 1; i++) {
        const parent = i === 0 ? '.' : parts.slice(0, i).join('/');
        if ((parent === '.' || roots.has(parent)) && (OUTPUT_NAMES.has(parts[i]) || parts[i].startsWith('.')))
            return true;
    }
    return false;
}
/**
 * The exclusion test of a file list: `structure.ignore` always, the default exclusions for what is not in `always` (the
 * files the change creates, which are always analysed).
 */
export function ignoreTest(settings, paths, always = new Set()) {
    const roots = packageRoots(paths);
    return path => settings.ignore.some(re => re.test(path)) || (!always.has(path) && defaultIgnored(path, roots));
}
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROLE_KEY = /^-?[a-z0-9]+(?:-[a-z0-9]+)*$/;
const severitySchema = s.enum(['warning', 'error']);
/** The `structure` section of `.apv/config.json` (docs/CONFIGURATION.md, « Arborescence »). */
export const structureSchema = s.object({
    /** Folders analysed, relative to the repository root; absent: the whole repository. */
    roots: s.optional(s.array(s.string(1, 4096), 1, 100)),
    /** Code files a folder may hold directly (tests and companion files apart). */
    maxFlatFiles: s.optional(s.number(2, 1000)),
    /** Roles added to the defaults (`"-gateway": "client"`); `null` removes a default. */
    roles: s.optional(s.record(ROLE_KEY, s.nullable(s.string(1, 50, NAME)), 200)),
    /** Known domain names, in kebab-case (`offer-prefill`): grouped even when one or two files share them. */
    domains: s.optional(s.array(s.string(1, 100, NAME), 0, 500)),
    /** Globs (`*`, `**`, `?`, `{a,b}`) of paths left out of the analysis (`src/generated/**`), added to the defaults. */
    ignore: s.optional(s.array(s.string(1, 4096), 0, 200)),
    /**
     * Severity of every finding, or per finding code; `warning` by default for the analysis (exit 0), `error` for the
     * comparison with the base (`flat-growth`, `architecture-map`: only what the change adds blocks).
     */
    severity: s.optional(s.union(severitySchema, s.record(/^(?:flat-folder|repeated-prefix|mixed-roles|stray-file|flat-growth|architecture-map)$/, severitySchema, 6))),
    /** The architecture map, relative to the repository root (Markdown). */
    architectureMap: s.optional(s.string(1, 4096, /^[^\0]+\.md$/)),
    /** The stack profile whose conventions apply; detected from the dependencies when absent. */
    profile: s.optional(s.enum(PROFILE_IDS)),
});
/** A relative folder or glob inside the repository, normalized with `/` and without trailing slash. */
function relativeInside(value, field) {
    const clean = posix.normalize(value.trim().replace(/\\/g, '/')).replace(/\/+$/, '') || '.';
    invariant(value.trim() !== '' && !isAbsolute(clean) && !clean.startsWith('/') && clean !== '..' && !clean.startsWith('../'), 'CONFIG', `structure.${field} : chemin relatif dans le dépôt attendu (${value})`);
    return clean;
}
/** Effective settings of a `structure` section: defaults completed, paths checked. Throws a CONFIG error. */
export function structureSettings(section) {
    const roles = { ...DEFAULT_ROLES };
    for (const [key, role] of Object.entries(section?.roles ?? {})) {
        if (role === null)
            delete roles[key];
        else
            roles[key] = role;
    }
    const severity = Object.fromEntries([...FINDING_CODES, ...CHANGE_CODES].map(code => {
        const value = section?.severity;
        const fallback = CHANGE_CODES.includes(code) ? 'error' : 'warning';
        return [code, typeof value === 'string' ? value : value?.[code] ?? fallback];
    }));
    // Declared exclusions only: the default ones are applied by `ignoreTest` (root and package roots, existing files).
    const ignore = (section?.ignore ?? []).map(glob => relativeInside(glob, 'ignore'));
    return {
        roots: [...new Set((section?.roots ?? ['.']).map(root => relativeInside(root, 'roots')))],
        maxFlatFiles: section?.maxFlatFiles ?? DEFAULT_MAX_FLAT_FILES,
        roles,
        domains: [...new Set(section?.domains ?? [])],
        ignore: ignore.map(glob => globToRegExp(glob)),
        severity,
        architectureMap: relativeInside(section?.architectureMap ?? DEFAULT_ARCHITECTURE_MAP, 'architectureMap'),
        profile: section?.profile ?? null,
    };
}
//# sourceMappingURL=config.js.map