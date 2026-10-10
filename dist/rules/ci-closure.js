import { posix } from 'node:path';
import { gitRead } from '../run/git-probe.js';
/**
 * What runs inside the proof without being listed as protected (issue #130, security review): the files the workflow and the
 * scripts of package.json name (`uses: ./action`, `node scripts/x.mjs`), and every file those import by a relative path.
 * All read at the base commit: a change cannot widen or narrow what it is compared with.
 */
const SCRIPT_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.json'];
const PARSED = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** Files read in the closure at most; beyond, the closure is not trusted and the caller leaves the lane. */
const MAX_FILES = 3000;
const IMPORT_PATTERNS = [
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];
/** Every file of the commit, or null when the tree is unreadable. */
export function treeFiles(repo, sha) {
    const raw = gitRead(repo, ['ls-tree', '-r', '--name-only', '-z', sha]);
    return raw === null ? null : raw.split('\0').filter(Boolean);
}
/** Paths a workflow or a script line names: local actions (`uses: ./x`) and script files (`node scripts/x.mjs`) that exist. */
export function namedFiles(text, files) {
    const found = new Set();
    for (const m of text.matchAll(/\buses\s*:\s*['"]?(\.\/[^\s'"#]+)/g)) {
        const dir = posix.normalize(m[1]).replace(/\/$/, '');
        for (const f of files)
            if (f === dir || f.startsWith(`${dir}/`))
                found.add(f);
    }
    for (const m of text.matchAll(/(?:^|[\s"'=(:])((?:\.\/)?[\w@.\/-]+\.(?:[cm]?[jt]s|[jt]sx))(?=$|[\s"')]|\\)/gm)) {
        const file = posix.normalize(m[1]);
        if (files.has(file))
            found.add(file);
    }
    return [...found];
}
/**
 * Every path a relative specifier may designate at run time, existing or not: the loaders disagree on the order (Playwright
 * tries `.js` before `.ts`), so a file added next to the one the base resolves can shadow it. Also `x.js` for a base `x.ts`, the
 * `index.*` of a directory of that name (a file `x.js` hides the directory `x/`).
 */
export function resolutionCandidates(from, spec) {
    if (!spec.startsWith('.'))
        return [];
    const target = posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\/$/, '');
    const stem = target.replace(/\.[cm]?[jt]sx?$/, '');
    return [...new Set([target, ...SCRIPT_EXTENSIONS.map(e => target + e), ...SCRIPT_EXTENSIONS.map(e => stem + e),
            ...SCRIPT_EXTENSIONS.map(e => posix.join(target, `index${e}`))])];
}
/** Config files of the tools that load the tests (tsconfig `extends` chains, followed at the base): their relative targets. */
export function extendedConfigs(repo, base, configs, files) {
    const reached = new Set();
    const queue = [...configs];
    while (queue.length && reached.size <= MAX_FILES) {
        const file = queue.pop();
        if (reached.has(file))
            continue;
        reached.add(file);
        const text = gitRead(repo, ['show', `${base}:${file}`]) ?? '';
        const field = /"extends"\s*:\s*(\[[^\]]*\]|"[^"]*")/.exec(text)?.[1] ?? '';
        for (const m of field.matchAll(/"([^"]+)"/g)) {
            if (!m[1].startsWith('.'))
                continue;
            const target = posix.normalize(posix.join(posix.dirname(file), m[1]));
            for (const c of [target, `${target}.json`, posix.join(target, 'tsconfig.json')])
                if (files.has(c))
                    queue.push(c);
        }
    }
    return [...reached];
}
/**
 * The files reachable from `roots` by relative imports (import, export from, dynamic import, require), at `base`, and every
 * path those specifiers could designate (`shadows`, existing or not). `complete` is
 * false when a file could not be read or the closure is too large: the caller does not trust it.
 */
export function importClosure(repo, base, roots, files) {
    const reached = new Set();
    const shadows = new Set();
    const queue = [...roots];
    let complete = true;
    while (queue.length) {
        const file = queue.pop();
        if (reached.has(file))
            continue;
        reached.add(file);
        if (reached.size > MAX_FILES)
            return { reached, shadows, complete: false };
        if (!PARSED.test(file))
            continue;
        const text = gitRead(repo, ['show', `${base}:${file}`]);
        if (text === null) {
            complete = false;
            continue;
        }
        for (const re of IMPORT_PATTERNS) {
            for (const m of text.matchAll(re)) {
                for (const candidate of resolutionCandidates(file, m[1])) {
                    shadows.add(candidate);
                    if (files.has(candidate) && !reached.has(candidate))
                        queue.push(candidate);
                }
            }
        }
    }
    return { reached, shadows, complete };
}
//# sourceMappingURL=ci-closure.js.map