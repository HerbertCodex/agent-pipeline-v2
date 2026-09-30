import { lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Git } from '../execution/git.js';
import { PipelineError } from '../domain/errors.js';
import { worktreeFiles } from '../knowledge/inventory.js';
import { resolveCommit, resolveFullRef } from '../run/git-probe.js';

/** Where the base of the comparison comes from: `--base`, the configured reference, or none (everything counts as new). */
export type BaseSource = 'option' | 'reference' | 'none';

export interface ChangeBase {
  source: BaseSource;
  /** The ref as given (`origin/main`), or null without base. */
  ref: string | null;
  /** Merge base of the ref and HEAD: what the change adds is counted from it. */
  mergeBase: string | null;
}

/**
 * What the working tree changes since the merge base: the lines it adds or modifies per file, the files it creates
 * (added, or untracked and not ignored; a renamed file is not new) and the renames. Without base, `all` is true:
 * every line of every file counts as added (a project without history, or a check run without reference).
 */
export interface Changes {
  base: ChangeBase;
  /** Files of the working tree (tracked ones present, untracked ones not ignored), sorted. */
  files: string[];
  all: boolean;
  added: Map<string, Set<number>>;
  created: Set<string>;
  /** New path -> path at the merge base. */
  renamed: Map<string, string>;
  /** Paths the change turns into a symbolic link or a submodule: never read as files, reported by the check. */
  special: { path: string; kind: 'lien symbolique' | 'sous-module' }[];
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Content of a working tree file, or null when it is unreadable, binary-looking or larger than 2 MB. */
export function readWorktree(repo: string, path: string): string | null {
  return readWorktreeStatus(repo, path).text;
}

/** A working tree file as text, or why it cannot be read as text: too large, a NUL byte, not UTF-8, unreadable. */
export function readWorktreeStatus(repo: string, path: string): { text: string | null; reason: string | null } {
  try {
    const full = join(repo, path);
    if (statSync(full).size > MAX_FILE_BYTES) return { text: null, reason: 'plus de 2 Mo' };
    const bytes = readFileSync(full);
    if (bytes.includes(0)) return { text: null, reason: 'octet nul' };
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), reason: null }; }
    catch { return { text: null, reason: 'encodage invalide (pas de l\'UTF-8)' }; }
  } catch { return { text: null, reason: 'illisible' }; }
}

/** The line is added or modified by the change (always true without base, and in a created file). */
export function isAdded(changes: Changes, path: string, line: number): boolean {
  if (changes.all || changes.created.has(path)) return true;
  return changes.added.get(path)?.has(line) ?? false;
}

/** Resolves the base of the comparison: `--base` (any commit-ish), else the configured reference (full ref), else none. */
export function resolveBase(repo: string, option: string | undefined, reference: string | null): { source: BaseSource; ref: string | null; sha: string | null } {
  if (option !== undefined) {
    const sha = resolveCommit(repo, option);
    if (!sha) throw new PipelineError('REUSE_BASE', `--base ${option} : commit introuvable dans ce dépôt.`);
    return { source: 'option', ref: option, sha };
  }
  if (reference !== null) {
    const { sha, reason } = resolveFullRef(repo, reference);
    if (!sha) throw new PipelineError('REUSE_BASE', `reuse.reference « ${reference} » ${reason} : récupérez-la (git fetch) ou corrigez .apv/config.json. Sans elle, le contrôle ne sait pas ce que le changement ajoute.`);
    return { source: 'reference', ref: reference, sha };
  }
  return { source: 'none', ref: null, sha: null };
}

/** Unquotes a path as `git diff` prints it (C-style quotes when it has unusual characters). */
function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  try { return JSON.parse(path) as string; } catch { return path.slice(1, -1); }
}

/** Added lines per file from a `git diff -U0` output. */
export function parseAddedLines(diff: string): Map<string, Set<number>> {
  const added = new Map<string, Set<number>>();
  let current: Set<number> | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      if (target === '/dev/null') { current = null; continue; }
      const path = unquote(target).replace(/^b\//, '');
      current = added.get(path) ?? new Set<number>();
      added.set(path, current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = 0; i < count; i++) current.add(start + i);
    }
  }
  return added;
}

/** Changes of the working tree since the merge base of `baseSha` and HEAD. */
export async function collectChanges(repo: string, base: { source: BaseSource; ref: string | null; sha: string | null }, git = new Git()): Promise<Changes> {
  const files = await worktreeFiles(repo);
  if (!base.sha) return { base: { source: 'none', ref: null, mergeBase: null }, files, all: true, added: new Map(), created: new Set(), renamed: new Map(), special: [] };
  const head = await git.sha(repo);
  let mergeBase: string;
  try { mergeBase = (await git.exec(repo, ['merge-base', base.sha, head])).trim(); }
  catch { mergeBase = ''; }
  if (!/^[0-9a-f]{40,64}$/.test(mergeBase)) {
    throw new PipelineError('REUSE_BASE', `aucune base commune entre ${base.ref} et HEAD : clone superficiel (git fetch --unshallow, ou un clone avec l'historique) ou historiques sans lien. Sans elle, le contrôle ne sait pas ce que le changement ajoute.`);
  }
  const diff = await git.exec(repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', '-M', '--src-prefix=a/', '--dst-prefix=b/', mergeBase, '--']);
  const status = (await git.exec(repo, ['diff', '--name-status', '-z', '-M', mergeBase, '--'])).split('\0');
  const created = new Set<string>();
  const renamed = new Map<string, string>();
  for (let i = 0; i < status.length;) {
    const code = status[i] ?? '';
    if (!code) { i++; continue; }
    if (code.startsWith('R') || code.startsWith('C')) {
      const from = status[i + 1]; const to = status[i + 2];
      if (from && to) { if (code.startsWith('R')) renamed.set(to, from); else created.add(to); }
      i += 3;
    } else {
      const path = status[i + 1];
      if (path && code === 'A') created.add(path);
      i += 2;
    }
  }
  const untracked = (await git.exec(repo, ['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
  for (const path of untracked) created.add(path);
  // Links and submodules the change adds or makes (mode 120000, 160000), committed or not: never skipped silently.
  const special: Changes['special'] = [];
  // Against the working tree and against the index (a submodule not checked out is only in the index).
  for (const scope of [[], ['--cached']]) {
    const raw = (await git.exec(repo, ['diff', '--raw', '-z', '--no-renames', ...scope, mergeBase, '--'])).split('\0');
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const m = /^:\d{6} (\d{6}) \S+ \S+ ([A-Z])/.exec(raw[i] ?? '');
      const path = raw[i + 1];
      if (!m || !path || m[2] === 'D' || special.some(x => x.path === path)) continue;
      if (m[1] === '120000') special.push({ path, kind: 'lien symbolique' });
      if (m[1] === '160000') special.push({ path, kind: 'sous-module' });
    }
  }
  for (const path of untracked) {
    if (path.endsWith('/')) { special.push({ path: path.slice(0, -1), kind: 'sous-module' }); continue; }
    try { if (lstatSync(join(repo, path)).isSymbolicLink() && !special.some(s => s.path === path)) special.push({ path, kind: 'lien symbolique' }); } catch { /* gone */ }
  }
  return { base: { source: base.source, ref: base.ref, mergeBase }, files, all: false, added: parseAddedLines(diff), created, renamed, special };
}

/** Content of a file at the merge base (following a rename), or null when it did not exist there. */
export function readAtBase(repo: string, changes: Changes, path: string, read: (repo: string, spec: string) => string | null): string | null {
  if (!changes.base.mergeBase || changes.created.has(path)) return null;
  const old = changes.renamed.get(path) ?? path;
  return read(repo, `${changes.base.mergeBase}:${old}`);
}
