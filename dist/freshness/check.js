import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { errorMessage } from '../domain/errors.js';
import { matches } from '../policy/policy.js';
import { loadConfig } from '../config/load.js';
import { DEFAULT_FRESHNESS, DEFAULT_FRESHNESS_PATHS, freshnessSchema, splitArchive, splitPattern } from './config.js';
const DAY_MS = 86_400_000;
/** Bounds of the walk of one glob: entries visited, files kept, depth below `**`. */
const MAX_VISITED = 5000;
const MAX_MATCHED = 200;
const MAX_DEPTH = 12;
/** Folders never walked by a glob. */
const SKIPPED = new Set(['node_modules', '.git']);
/**
 * A name that looks like a secret holder (`.env*`, `*key*`, `*secret*`, `*token*`, credentials, passwords,
 * certificates): only its date is read, never a byte of its content (no line count).
 */
export function secretLike(path) {
    const name = basename(path).toLowerCase();
    return name.startsWith('.env') || /key|secret|token|credential|password|passwd|\.pem$|\.p12$|\.pfx$/.test(name);
}
function rootDir(root, repo, home) {
    return root === 'repo' ? repo : root === 'home' ? home : sep;
}
/** `path` relative to `base` with `/` separators, or null when it is outside. */
function inside(base, path) {
    const rel = relative(base, path);
    if (rel === '' || rel.startsWith('..') || rel.startsWith(sep) || /^[a-zA-Z]:/.test(rel))
        return null;
    return rel.split(sep).join('/');
}
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
/** Existing files matched by one pattern, bounded; a missing folder or file is simply nothing. */
export function expandPattern(pattern, repo, home) {
    const base = rootDir(pattern.root, repo, home);
    const segments = pattern.rest.split('/');
    const first = segments.findIndex(x => /[*?]/.test(x));
    if (first < 0) {
        const path = join(base, ...segments);
        return isFile(path) ? [path] : [];
    }
    const start = join(base, ...segments.slice(0, first));
    const tail = segments.slice(first);
    const maxDepth = tail.some(x => x.includes('**')) ? MAX_DEPTH : tail.length;
    const out = [];
    let visited = 0;
    const walk = (dir, depth) => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (++visited > MAX_VISITED || out.length >= MAX_MATCHED)
                return;
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (depth < maxDepth && !SKIPPED.has(entry.name))
                    walk(path, depth + 1);
                continue;
            }
            if (!entry.isFile() && !(entry.isSymbolicLink() && isFile(path)))
                continue;
            const rel = inside(base, path);
            if (rel !== null && matches(rel, pattern.rest))
                out.push(path);
        }
    };
    walk(start, 1);
    return out;
}
/** Line count read by chunks (the content is never kept). */
function countLines(path) {
    let fd;
    try {
        fd = openSync(path, 'r');
        const buffer = Buffer.alloc(65_536);
        let lines = 0;
        let last = -1;
        for (let read = readSync(fd, buffer, 0, buffer.length, null); read > 0; read = readSync(fd, buffer, 0, buffer.length, null)) {
            for (let i = 0; i < read; i++)
                if (buffer[i] === 10)
                    lines++;
            last = buffer[read - 1];
        }
        return last !== -1 && last !== 10 ? lines + 1 : lines;
    }
    catch {
        return null;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
function shown(path, repo, home) {
    const inRepo = inside(repo, path);
    if (inRepo !== null)
        return inRepo;
    const inHome = inside(home, path);
    return inHome !== null ? `~/${inHome}` : path;
}
/**
 * Freshness of the living files of a project: `.apv/state/resume.md`, the `.apv/state/*.md` files and the
 * `freshness.paths` of the configuration, minus `freshness.ignore` and the archive folder. Read-only: only the date
 * and the line count of each file are read (only the date for a secret-like name); a missing file is ignored.
 */
export function freshnessReport(repo, settings, options = {}) {
    const config = settings ?? freshnessSchema.parse({});
    const home = options.home || homedir();
    const now = (options.now ?? new Date()).getTime();
    const archive = config.archive ?? DEFAULT_FRESHNESS.archive;
    const archiveParts = splitArchive(archive);
    const archiveDir = join(rootDir(archiveParts.root, repo, home), ...archiveParts.rest.split('/'));
    const ignored = config.ignore.map(p => splitPattern(p, 'freshness.ignore'));
    const skip = (path) => inside(archiveDir, path) !== null
        || ignored.some(p => { const rel = inside(rootDir(p.root, repo, home), path); return rel !== null && matches(rel, p.rest); });
    const seen = new Set();
    const entries = [];
    for (const pattern of [...DEFAULT_FRESHNESS_PATHS, ...config.paths]) {
        for (const path of expandPattern(splitPattern(pattern, 'freshness.paths'), repo, home)) {
            if (seen.has(path) || skip(path))
                continue;
            seen.add(path);
            let mtime;
            try {
                mtime = statSync(path).mtime;
            }
            catch {
                continue;
            }
            const secret = secretLike(path);
            const lines = secret ? null : countLines(path);
            const age = now - mtime.getTime();
            entries.push({
                file: shown(path, repo, home), modifiedAt: mtime.toISOString(), ageDays: Math.max(0, Math.floor(age / DAY_MS)),
                lines, secret, stale: age > config.maxAgeDays * DAY_MS, long: lines !== null && lines > config.maxLines,
            });
        }
    }
    return {
        maxAgeDays: config.maxAgeDays, maxLines: config.maxLines, archive, checked: entries.length,
        stale: entries.filter(e => e.stale).sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt) || a.file.localeCompare(b.file)),
        long: entries.filter(e => e.long).sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0) || a.file.localeCompare(b.file)),
    };
}
/**
 * The report of a repository with its own configuration (`freshness`); an unreadable configuration falls back to the
 * defaults and says so in `configError`, so that the default living files are still watched.
 */
export function repoFreshness(repo, options = {}) {
    let settings;
    let configError = null;
    try {
        settings = loadConfig(repo).config.freshness;
    }
    catch (error) {
        configError = errorMessage(error);
    }
    return { ...freshnessReport(repo, settings, options), configError };
}
/** Text lines of the section « Fichiers d'état périmés » of `apv status`; `clean` bounds each file name. */
export function freshnessLines(report, clean, time) {
    const head = `Fichiers d'état périmés (au plus ${report.maxAgeDays} jour(s), ${report.maxLines} lignes ; ${report.checked} surveillé(s)) : `;
    if (!report.stale.length && !report.long.length)
        return [`${head}aucun`];
    const archive = clean(report.archive);
    return [
        head,
        ...report.stale.map(e => clean(`- ${e.file} : modifié il y a ${e.ageDays} jour(s) (${time(e.modifiedAt)}) ; réécrire l'état court ou archiver dans ${archive}`)),
        ...report.long.map(e => clean(`- ${e.file} : ${e.lines} lignes ; couper : état court + archive (${archive})`)),
    ];
}
/** One line for the SessionStart hook, or null when every watched file is fresh and short. */
export function freshnessSummary(report, clean) {
    if (!report.stale.length && !report.long.length)
        return null;
    const parts = [];
    if (report.stale.length)
        parts.push(`périmés (plus de ${report.maxAgeDays} j) : ${report.stale.slice(0, 8).map(e => `${clean(e.file)} (${e.ageDays} j)`).join(', ')}${report.stale.length > 8 ? `, et ${report.stale.length - 8} autre(s)` : ''}`);
    if (report.long.length)
        parts.push(`trop longs (plus de ${report.maxLines} lignes) : ${report.long.slice(0, 8).map(e => `${clean(e.file)} (${e.lines} lignes)`).join(', ')}${report.long.length > 8 ? `, et ${report.long.length - 8} autre(s)` : ''}`);
    return `Fichiers d'état à rafraîchir : ${parts.join(' ; ')}. Réécrire l'état court, archiver le terminé dans ${clean(report.archive)} ; détail : apv status.`;
}
//# sourceMappingURL=check.js.map