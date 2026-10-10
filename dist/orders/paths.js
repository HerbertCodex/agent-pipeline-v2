import { matches } from '../policy/policy.js';
/**
 * The paths a pull request merged on order may change (docs/REGLES.md, section 3 ter), at both steps:
 * - never a path of the fixed refusal list of APV, whatever the project declares: what APV, the agents' sessions, the
 *   CI, Git or the package manager read as configuration or run (`.apv/**`, `.claude/**`, `.github/**`, hooks, Git
 *   attributes and submodules, `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, package manifests and lock files, at any depth);
 * - only paths of the allow list the trusted base declares for the step (`rules.operatorOrders.paths.publication` and
 *   `.article`, globs with `{slug}` replaced by the slug the order signed). No list declared: no merge on order.
 */
/** Folders refused at any depth: one of the segments of the path. */
const REFUSED_FOLDERS = ['.apv', '.claude', '.github', '.githooks', '.husky', '.vscode', '.devcontainer'];
/** Files refused at any depth: the last segment of the path, exactly or by its pattern. */
const REFUSED_FILES = ['pipeline.v2.json', 'CLAUDE.md', 'AGENTS.md', '.mcp.json', '.gitattributes', '.gitmodules',
    'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
    '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', 'vercel.json', '.env', '.envrc', 'tsconfig.json', 'jsconfig.json'];
const REFUSED_FILE_PATTERNS = [/^\.env\..+$/, /^svelte\.config\..+$/, /^vite\.config\..+$/, /^hooks\.(server|client)\..+$/];
/**
 * A segment a disk may read as another name: anything but printable ASCII (an invisible joiner, a letter with an
 * accent folded by the disk), a trailing dot or space (dropped by Windows), a short 8.3 name (`PROGRA~1`). Never in a
 * pull request merged on order, whatever the lists say.
 */
function foldableSegment(segment) {
    return !/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(segment) || segment.endsWith('.') || /~\d/.test(segment);
}
/** True when `path` is on the fixed refusal list of APV, compared without case (a checkout on a case-insensitive disk). */
export function refusedPath(path) {
    const original = path.split('/');
    if (original.some(foldableSegment))
        return true;
    const segments = path.toLowerCase().split('/');
    const last = segments[segments.length - 1];
    return segments.some(segment => REFUSED_FOLDERS.some(f => f.toLowerCase() === segment))
        || REFUSED_FILES.some(f => f.toLowerCase() === last) || REFUSED_FILE_PATTERNS.some(pattern => pattern.test(last));
}
/** Paths of the refusal list a declared glob must never cover (checked by the loader). */
export const REFUSED_PROBES = [
    ...REFUSED_FOLDERS.flatMap(folder => [`${folder}/x`, `x/${folder}/x`]),
    ...[...REFUSED_FILES, '.env.local', 'svelte.config.js', 'vite.config.ts', 'hooks.server.ts', 'hooks.client.ts'].flatMap(file => [file, `x/${file}`, `src/${file}`]),
];
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A slug used in the probes of the loader: any slug the order may sign is replaced the same way. */
export const PROBE_SLUG = 'exemple';
/** The globs of a step with `{slug}` replaced; null when a glob names `{slug}` and the order signed no readable slug. */
export function stepGlobs(globs, slug) {
    const readable = typeof slug === 'string' && slug.length <= 80 && SLUG.test(slug) ? slug : null;
    const out = [];
    for (const glob of globs) {
        if (glob.includes('{slug}') && readable === null)
            return null;
        out.push(readable === null ? glob : glob.replaceAll('{slug}', readable));
    }
    return out;
}
/** The changed paths a step may not merge: refused by APV, or outside the allow list. */
export function forbiddenPaths(changed, allowed) {
    const refused = changed.filter(refusedPath);
    const outside = changed.filter(path => !refusedPath(path) && !allowed.some(glob => matches(path, glob)));
    return { refused, outside };
}
//# sourceMappingURL=paths.js.map