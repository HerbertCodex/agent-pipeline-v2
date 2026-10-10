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
export function treeFiles(repo: string, sha: string): string[] | null {
  const raw = gitRead(repo, ['ls-tree', '-r', '--name-only', '-z', sha]);
  return raw === null ? null : raw.split('\0').filter(Boolean);
}

/** Paths a workflow or a script line names: local actions (`uses: ./x`) and script files (`node scripts/x.mjs`) that exist. */
export function namedFiles(text: string, files: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\buses\s*:\s*['"]?(\.\/[^\s'"#]+)/g)) {
    const dir = posix.normalize(m[1]!).replace(/\/$/, '');
    for (const f of files) if (f === dir || f.startsWith(`${dir}/`)) found.add(f);
  }
  for (const m of text.matchAll(/(?:^|[\s"'=(:])((?:\.\/)?[\w@.\/-]+\.(?:[cm]?[jt]s|[jt]sx))(?=$|[\s"')]|\\)/gm)) {
    const file = posix.normalize(m[1]!);
    if (files.has(file)) found.add(file);
  }
  return [...found];
}

/** The file a relative specifier designates, among the files of the tree, or null. */
function resolveSpecifier(from: string, spec: string, files: ReadonlySet<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const target = posix.normalize(posix.join(posix.dirname(from), spec));
  const stem = target.replace(/\.[cm]?js$/, '');
  const candidates = [target, ...SCRIPT_EXTENSIONS.map(e => target + e), ...(stem === target ? [] : SCRIPT_EXTENSIONS.map(e => stem + e)),
    ...SCRIPT_EXTENSIONS.map(e => posix.join(target, `index${e}`))];
  return candidates.find(c => files.has(c)) ?? null;
}

/**
 * The files reachable from `roots` by relative imports (import, export from, dynamic import, require), at `base`. `complete` is
 * false when a file could not be read or the closure is too large: the caller does not trust it.
 */
export function importClosure(repo: string, base: string, roots: readonly string[], files: ReadonlySet<string>): { reached: Set<string>; complete: boolean } {
  const reached = new Set<string>();
  const queue = [...roots];
  let complete = true;
  while (queue.length) {
    const file = queue.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    if (reached.size > MAX_FILES) return { reached, complete: false };
    if (!PARSED.test(file)) continue;
    const text = gitRead(repo, ['show', `${base}:${file}`]);
    if (text === null) { complete = false; continue; }
    for (const re of IMPORT_PATTERNS) {
      for (const m of text.matchAll(re)) {
        const next = resolveSpecifier(file, m[1]!, files);
        if (next && !reached.has(next)) queue.push(next);
      }
    }
  }
  return { reached, complete };
}
