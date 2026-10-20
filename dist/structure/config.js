import { isAbsolute, posix } from 'node:path';
import { s } from '../domain/schema.js';
import { invariant } from '../domain/errors.js';
import { globToRegExp } from '../db/glob.js';
/** Codes of the tree findings of `apv structure check`. */
export const FINDING_CODES = ['flat-folder', 'repeated-prefix', 'mixed-roles', 'stray-file'];
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
 * Paths never analysed, whatever the configuration: dependencies, build outputs and tool folders
 * (a path segment that starts with a dot: `.github`, `.claude`, `.svelte-kit`).
 */
export const DEFAULT_IGNORE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/vendor/**', '**/.*/**'];
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
    /** Severity of every finding, or per finding code; `warning` by default (exit 0). */
    severity: s.optional(s.union(severitySchema, s.record(/^(?:flat-folder|repeated-prefix|mixed-roles|stray-file)$/, severitySchema, 4))),
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
    const severity = Object.fromEntries(FINDING_CODES.map(code => {
        const value = section?.severity;
        return [code, typeof value === 'string' ? value : value?.[code] ?? 'warning'];
    }));
    const ignore = [...DEFAULT_IGNORE, ...(section?.ignore ?? []).map(glob => relativeInside(glob, 'ignore'))];
    return {
        roots: [...new Set((section?.roots ?? ['.']).map(root => relativeInside(root, 'roots')))],
        maxFlatFiles: section?.maxFlatFiles ?? DEFAULT_MAX_FLAT_FILES,
        roles,
        domains: [...new Set(section?.domains ?? [])],
        ignore: ignore.map(glob => globToRegExp(glob)),
        severity,
    };
}
//# sourceMappingURL=config.js.map