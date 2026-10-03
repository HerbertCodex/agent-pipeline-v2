import { closeSync, openSync, opendirSync, readSync, realpathSync, statSync, type Dir } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { errorMessage } from '../domain/errors.js';
import { matches } from '../policy/policy.js';
import { loadConfig } from '../config/load.js';
import { DEFAULT_FRESHNESS, DEFAULT_FRESHNESS_IGNORE, DEFAULT_FRESHNESS_PATHS, freshnessSchema, splitArchive, splitPattern, type FreshnessSettings, type SplitPattern } from './config.js';

const DAY_MS = 86_400_000;
/** Bounds of the walk of one glob: entries visited, files kept, depth below `**`. */
const MAX_VISITED = 5000;
const MAX_MATCHED = 200;
const MAX_DEPTH = 12;
/** Folders never walked by a glob. */
const SKIPPED = new Set(['node_modules', '.git']);
/**
 * Bytes per line above which a file is « too long » from its size alone, without reading it: a state file of
 * `maxLines` lines never weighs `maxLines` × 4 KiB. Bounds what one file can make the status and the hook read.
 */
const BYTES_PER_LINE = 4096;

/** Folders that hold credentials: nothing under them is ever opened. */
const SECRET_FOLDERS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store']);
/** Files that hold credentials, by exact name. */
const SECRET_NAMES = new Set(['.npmrc', '.netrc', '.pgpass', '.git-credentials', 'hosts.yml', '.pypirc', '.htpasswd']);

/**
 * A path that looks like a secret holder: a name `.env*`, `id_*` (SSH keys), `*key*`, `*secret*`, `*token*`,
 * credentials or passwords, a known credential file (`.npmrc`, `.netrc`, `.pgpass`, `.git-credentials`, `hosts.yml`...),
 * a certificate or a password database (`.pem`, `.p12`, `.pfx`, `.kdbx`...), or anything under `.ssh/`, `.gnupg/`,
 * `.aws/`... Only its date is read, never a byte of its content (no line count).
 */
export function secretLike(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (path.split(/[\\/]/).some(segment => SECRET_FOLDERS.has(segment.toLowerCase()))) return true;
  return SECRET_NAMES.has(name) || name.startsWith('.env') || name.startsWith('id_')
    || /key|secret|token|credential|password|passwd/.test(name) || /\.(?:pem|p12|pfx|kdbx|keystore|jks|asc|gpg)$/.test(name);
}

export interface FreshnessEntry {
  /** Shown path: relative to the repository, `~/...` under the home folder, absolute otherwise. */
  file: string;
  /** True for a file outside the repository: the SessionStart hook counts it without naming it. */
  external: boolean;
  modifiedAt: string;
  /** Whole days since the last modification. */
  ageDays: number;
  /** Size in bytes (from the file system, the content is not read for it). */
  bytes: number;
  /**
   * Exact line count when the file has at most `maxLines` lines; null when it has more (the count stops at
   * `maxLines` + 1, or is not made above `maxLines` × 4 KiB), for a secret-like path (never opened) or an unreadable file.
   */
  lines: number | null;
  secret: boolean;
  stale: boolean;
  /** More than `maxLines` lines. */
  long: boolean;
}

export interface FreshnessReport {
  maxAgeDays: number;
  maxLines: number;
  /** Archive folder proposed in the messages (as configured, or the default). */
  archive: string;
  /** Existing files watched. */
  checked: number;
  /** Files not modified for more than `maxAgeDays` days, oldest first. */
  stale: FreshnessEntry[];
  /** Files longer than `maxLines` lines, biggest first. */
  long: FreshnessEntry[];
}

export interface FreshnessOptions { home?: string; now?: Date }

function rootDir(root: SplitPattern['root'], repo: string, home: string): string {
  return root === 'repo' ? repo : root === 'home' ? home : sep;
}

/** `path` relative to `base` with `/` separators, or null when it is outside (or is `base` itself). */
function inside(base: string, path: string): string | null {
  const rel = relative(base, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep) || /^[a-zA-Z]:/.test(rel)) return null;
  return rel.split(sep).join('/');
}

function real(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

/** The folder a pattern starts from: its part before the first wildcard (the parent folder of a plain file). */
function patternStart(pattern: SplitPattern, repo: string, home: string): string {
  const segments = pattern.rest.split('/');
  const first = segments.findIndex(x => /[*?]/.test(x));
  const fixed = first < 0 ? segments.slice(0, -1) : segments.slice(0, first);
  return join(rootDir(pattern.root, repo, home), ...fixed);
}

/**
 * Existing files matched by one pattern, bounded: the folder entries are read one by one (never a whole folder
 * loaded before the bound) and folder links are never followed. A missing folder or file is simply nothing.
 */
export function expandPattern(pattern: SplitPattern, repo: string, home: string): string[] {
  const base = rootDir(pattern.root, repo, home);
  const segments = pattern.rest.split('/');
  const first = segments.findIndex(x => /[*?]/.test(x));
  if (first < 0) { const path = join(base, ...segments); try { return statSync(path).isFile() ? [path] : []; } catch { return []; } }
  const tail = segments.slice(first);
  const maxDepth = tail.some(x => x.includes('**')) ? MAX_DEPTH : tail.length;
  const out: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    let handle: Dir;
    try { handle = opendirSync(dir); } catch { return; }
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (++visited > MAX_VISITED || out.length >= MAX_MATCHED) return;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (depth < maxDepth && !SKIPPED.has(entry.name)) walk(path, depth + 1); continue; }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        const rel = inside(base, path);
        if (rel !== null && matches(rel, pattern.rest)) out.push(path);
      }
    } catch { /* folder changed while read: what was read is kept */ } finally { handle.closeSync(); }
  };
  walk(join(base, ...segments.slice(0, first)), 1);
  return out.sort();
}

/** Line count read by chunks, stopped as soon as it exceeds `max` (the content is never kept). */
function countLines(path: string, max: number): number | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(65_536);
    let lines = 0;
    let last = -1;
    for (let read = readSync(fd, buffer, 0, buffer.length, null); read > 0; read = readSync(fd, buffer, 0, buffer.length, null)) {
      for (let i = 0; i < read; i++) if (buffer[i] === 10 && ++lines > max) return lines;
      last = buffer[read - 1]!;
    }
    return last !== -1 && last !== 10 ? lines + 1 : lines;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function shown(path: string, repo: string, home: string): { file: string; external: boolean } {
  const inRepo = inside(repo, path);
  if (inRepo !== null) return { file: inRepo, external: false };
  const inHome = inside(home, path);
  return { file: inHome !== null ? `~/${inHome}` : path, external: true };
}

/**
 * Freshness of the living files of a project: `.apv/state/resume.md`, the `.apv/state/*.md` files and the
 * `freshness.paths` of the configuration, minus `freshness.ignore`, the default exclusions and the archive folder.
 * Read-only: only the date, the size and a bounded line count of each file are read (only the date for a secret-like
 * path, judged on the name and on the real target); a missing file is ignored; a link whose target leaves the folder
 * of its pattern (the repository for the default patterns) is never followed.
 */
export function freshnessReport(repo: string, settings: FreshnessSettings | undefined, options: FreshnessOptions = {}): FreshnessReport {
  const config = settings ?? freshnessSchema.parse({});
  const home = options.home || homedir();
  const now = (options.now ?? new Date()).getTime();
  const archive = config.archive ?? DEFAULT_FRESHNESS.archive;
  const archiveParts = splitArchive(archive);
  const archiveDir = join(rootDir(archiveParts.root, repo, home), ...archiveParts.rest.split('/'));
  const ignored = [...DEFAULT_FRESHNESS_IGNORE, ...config.ignore].map(p => splitPattern(p, 'freshness.ignore'));
  const skip = (path: string): boolean => inside(archiveDir, path) !== null
    || ignored.some(p => { const rel = inside(rootDir(p.root, repo, home), path); return rel !== null && matches(rel, p.rest); });
  const repoReal = real(repo) ?? repo;
  const seen = new Set<string>();
  const entries: FreshnessEntry[] = [];
  const patterns = [...DEFAULT_FRESHNESS_PATHS.map(p => ({ pattern: p, own: false })), ...config.paths.map(p => ({ pattern: p, own: true }))];
  for (const { pattern, own } of patterns) {
    const split = splitPattern(pattern, 'freshness.paths');
    // The folder a link may lead to: the one of the pattern, or the repository for the default patterns.
    const fence = own ? real(patternStart(split, repo, home)) : repoReal;
    if (fence === null) continue;
    for (const path of expandPattern(split, repo, home)) {
      const target = real(path);
      if (target === null || seen.has(target) || skip(path)) continue;
      if (inside(fence, target) === null) continue;
      seen.add(target);
      let st;
      try { st = statSync(target); } catch { continue; }
      if (!st.isFile()) continue;
      const secret = secretLike(path) || secretLike(target);
      const tooBig = st.size > config.maxLines * BYTES_PER_LINE;
      const counted = secret || tooBig ? null : countLines(target, config.maxLines);
      const long = !secret && (tooBig || (counted !== null && counted > config.maxLines));
      const age = now - st.mtime.getTime();
      entries.push({
        ...shown(path, repo, home), modifiedAt: st.mtime.toISOString(), ageDays: Math.max(0, Math.floor(age / DAY_MS)), bytes: st.size,
        lines: long ? null : counted, secret, stale: age > config.maxAgeDays * DAY_MS, long,
      });
    }
  }
  return {
    maxAgeDays: config.maxAgeDays, maxLines: config.maxLines, archive, checked: entries.length,
    stale: entries.filter(e => e.stale).sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt) || a.file.localeCompare(b.file)),
    long: entries.filter(e => e.long).sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file)),
  };
}

/**
 * The report of a repository with its own configuration (`freshness`); an unreadable configuration falls back to the
 * defaults and says so in `configError`, so that the default living files are still watched.
 */
export function repoFreshness(repo: string, options: FreshnessOptions = {}): FreshnessReport & { configError: string | null } {
  let settings: FreshnessSettings | undefined;
  let configError: string | null = null;
  try { settings = loadConfig(repo).config.freshness; } catch (error) { configError = errorMessage(error); }
  return { ...freshnessReport(repo, settings, options), configError };
}

/** Text lines of the section « Fichiers d'état périmés » of `apv status`; `clean` bounds each file name. */
export function freshnessLines(report: FreshnessReport, clean: (value: string) => string, time: (iso: string) => string): string[] {
  const head = `Fichiers d'état périmés (au plus ${report.maxAgeDays} jour(s), ${report.maxLines} lignes ; ${report.checked} surveillé(s)) : `;
  if (!report.stale.length && !report.long.length) return [`${head}aucun`];
  const archive = clean(report.archive);
  return [
    head,
    ...report.stale.map(e => clean(`- ${e.file} : modifié il y a ${e.ageDays} jour(s) (${time(e.modifiedAt)}) ; réécrire l'état court ou archiver dans ${archive}`)),
    ...report.long.map(e => clean(`- ${e.file} : plus de ${report.maxLines} lignes ; couper : état court + archive (${archive})`)),
  ];
}

const MAX_NAMED = 8;
/** File names of the repository for the hook, at most MAX_NAMED; files outside the repository only counted. */
function hookList(entries: FreshnessEntry[], clean: (value: string) => string, detail: (e: FreshnessEntry) => string): string {
  const named = entries.filter(e => !e.external);
  const external = entries.length - named.length;
  const parts = named.slice(0, MAX_NAMED).map(e => `${clean(e.file)}${detail(e)}`);
  if (named.length > MAX_NAMED) parts.push(`et ${named.length - MAX_NAMED} autre(s)`);
  if (external) parts.push(`${external} fichier(s) hors du dépôt`);
  return parts.join(', ');
}

/**
 * One line for the SessionStart hook, or null when every watched file is fresh and short. Files outside the repository
 * are counted, never named: their names would enter the context of every session.
 */
export function freshnessSummary(report: FreshnessReport, clean: (value: string) => string): string | null {
  if (!report.stale.length && !report.long.length) return null;
  const parts: string[] = [];
  if (report.stale.length) parts.push(`périmés (plus de ${report.maxAgeDays} j) : ${hookList(report.stale, clean, e => ` (${e.ageDays} j)`)}`);
  if (report.long.length) parts.push(`trop longs (plus de ${report.maxLines} lignes) : ${hookList(report.long, clean, () => '')}`);
  return `Fichiers d'état à rafraîchir : ${parts.join(' ; ')}. Réécrire l'état court, archiver le terminé dans ${clean(report.archive)} ; détail : apv status.`;
}
