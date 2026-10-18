import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { sha256 } from '../domain/hash.js';
import type { Git } from '../execution/git.js';
import { environment } from '../execution/process.js';
import { matches } from '../policy/policy.js';
import { ALWAYS_REQUIRED } from './proof-scope.js';

const execFileAsync = promisify(execFile);

/**
 * Reuse of a successful check from one commit to another (docs/ACCELERATION-LOTS.md, part A): what a receipt `cached`
 * is checked against. Everything here is recomputed from Git, never read from the receipt.
 */

/** Oldest an origin receipt may be when its reuse is verified (`reuse.maxAgeMs`, 24 h when the check declares nothing). */
export const DEFAULT_REUSE_MAX_AGE_MS = 86_400_000;
/**
 * `apv gates run` reuses an origin only when it is younger than the maximum age minus this margin (4 h): the receipt
 * `cached` must still check out when `apv gates verify` reads it at the end of the suite, of the batch and of its merge.
 */
export const REUSE_AGE_MARGIN_MS = 4 * 3_600_000;

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const GIT_ENV = (): NodeJS.ProcessEnv => ({ ...environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'LANG']), GIT_TERMINAL_PROMPT: '0' });

/**
 * The tree of each commit of `commits` that the repository has (`git log --no-walk --ignore-missing`, one call): a commit
 * the repository does not have, or an object that is not a commit, is absent from the map. Only full hexadecimal SHAs are
 * asked (anything else is left out, never passed to Git).
 */
export async function treesOf(git: Git, repo: string, commits: Iterable<string>): Promise<Map<string, string>> {
  const asked = [...new Set([...commits].filter(c => SHA.test(c)))];
  const trees = new Map<string, string>();
  if (!asked.length) return trees;
  const wanted = new Set(asked);
  const parse = (out: string): void => {
    for (const line of out.split('\n')) {
      const [commit, tree] = line.trim().split(' ');
      if (commit && tree && SHA.test(commit) && SHA.test(tree) && wanted.has(commit)) trees.set(commit, tree);
    }
  };
  const log = (list: string[]): Promise<string> => git.exec(repo, ['log', '--no-walk=unsorted', '--ignore-missing', '--format=%H %T', ...list]);
  try { parse(await log(asked)); }
  catch {
    // One object that is not a commit fails the whole call: each commit alone, the unreadable ones left out.
    for (const commit of asked) { try { parse(await log([commit])); } catch { /* Not a commit of this repository. */ } }
  }
  return trees;
}

/**
 * What Git ignores in a copy and a check still runs with (relecture sécurité de A1, M2, and of its delta, F-D1): the installed
 * dependencies, seen through the folder `node_modules` and the record each package manager writes there at every install
 * (npm, pnpm and its lock of the virtual store, Yarn Berry, Yarn 1), and every `.env*` file of the copy, at any depth (outside
 * `node_modules`, the `.git` of the copy and the worktrees Git has registered, such as those of `.worktrees/`). Two copies of the same tree
 * with other dependencies installed, or another `apps/web/.env.local`, are not the same environment. A `node_modules` with
 * none of these records (installed by another tool, or by hand) cannot be compared: never the same state as any other.
 */
export const LOCAL_STATE_FILES = ['node_modules/.package-lock.json', 'node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml', 'node_modules/.yarn-state.yml', 'node_modules/.yarn-integrity'] as const;
/** Largest file of the local state read for its digest (64 MiB): beyond, its size and date stand for its content. */
const LOCAL_STATE_MAX_BYTES = 64 * 1024 * 1024;
/** Most entries of a copy walked to find its `.env*` files, or its ignored files read: beyond, the state is not comparable. */
const MAX_WALKED = 200_000;
/** Most bytes of ignored files hashed in one copy (1 GiB): beyond, each further file counts by its size and date. */
const MAX_HASHED_BYTES = 1024 * 1024 * 1024;

/** What a path of the local state is: absent, a folder, unreadable, or the sha256 of its content (never the content). */
function stateOf(path: string): string {
  let info;
  try { info = statSync(path); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'illisible'; }
  if (info.isDirectory()) return 'dossier';
  if (!info.isFile()) return 'autre';
  if (info.size > LOCAL_STATE_MAX_BYTES) return `taille:${info.size}:${Math.round(info.mtimeMs)}`;
  try { return sha256(readFileSync(path)); } catch { return 'illisible'; }
}

/** A value no other measure ever equals: a state that cannot be compared is never the state of an origin. */
const unique = (why: string): string => `${why}:${randomUUID()}`;

/** A path as the file system resolves it (symbolic links followed), or the path itself when it cannot be resolved. */
const realOf = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };

/**
 * The worktrees Git has registered for the repository of `dir` (`git worktree list --porcelain -z`), real paths, `dir` itself
 * left out: the only folders of a copy that are another copy and never part of its state (relecture sécurité de A2, F1). A
 * folder that merely holds an entry named `.git` (a file or a folder written by a check, a generator, a stray clone) is
 * walked like any other. None when Git cannot list them: every folder is then walked.
 */
export function registeredWorktrees(dir: string): Set<string> {
  let out: string;
  try {
    out = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'worktree', 'list', '--porcelain', '-z'],
      { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000, env: GIT_ENV(), stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return new Set(); }
  const self = realOf(dir);
  return new Set(out.split('\0').filter(line => line.startsWith('worktree ')).map(line => realOf(line.slice('worktree '.length))).filter(path => path !== self));
}

/**
 * The `.env*` files of a copy at any depth, relative paths sorted, outside `node_modules`, the `.git` of the copy and the
 * worktrees Git has registered (registeredWorktrees); symbolic links to folders are not followed. Null beyond MAX_WALKED.
 */
function envFiles(dir: string): string[] | null {
  const worktrees = registeredWorktrees(dir);
  const found: string[] = [];
  const stack: string[] = [''];
  let walked = 0;
  while (stack.length) {
    const rel = stack.pop()!;
    let entries;
    try { entries = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { found.push(`${rel}(dossier illisible)`); continue; }
    if (rel && worktrees.size && entries.some(e => e.name === '.git') && worktrees.has(realOf(join(dir, rel)))) continue;
    for (const entry of entries) {
      if ((walked += 1) > MAX_WALKED) return null;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.env')) found.push(path);
      if (entry.isDirectory() && entry.name !== 'node_modules' && path !== '.git') stack.push(path);
    }
  }
  return found.sort();
}

/**
 * Digest of the local state of a copy (LOCAL_STATE_FILES, `node_modules` present or not, each `.env*` at any depth), part
 * of the identity of the environment of every receipt: a check is reused only from an origin that ran with the same local
 * state. Contents are hashed, one digest for all: no value of a `.env*` file is ever written, in a receipt or an output.
 */
export function localStateDigest(dir: string): string {
  const modules = stateOf(join(dir, 'node_modules'));
  const entries: [string, string][] = [['node_modules', modules]];
  const records = LOCAL_STATE_FILES.map(file => [file, stateOf(join(dir, file))] as [string, string]);
  entries.push(...records);
  if (modules === 'dossier' && records.every(([, state]) => state === 'absent')) entries.push(['node_modules sans enregistrement', unique('non comparable')]);
  const names = envFiles(dir);
  if (names === null) entries.push(['.env*', unique(`plus de ${MAX_WALKED} entrées`)]);
  else for (const name of names) entries.push([name, stateOf(join(dir, name))]);
  return sha256(JSON.stringify({ version: 2, entries }));
}

/** The files Git ignores in a copy, folders collapsed (`git ls-files --others --ignored --exclude-standard --directory`). */
async function ignoredEntries(dir: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
    { cwd: dir, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 120_000, env: GIT_ENV() });
  return stdout.toString('utf8').split('\0').filter(Boolean).sort();
}

/** Ignored paths left out of the state of a copy: the receipts of APV (written by the run itself), and `node_modules` (LOCAL_STATE_FILES). */
const outOfCopyState = (path: string): boolean => path === '.apv/receipts/' || path.startsWith('.apv/receipts/') || path.split('/').includes('node_modules') || path === '.git' || path.startsWith('.git/');

/**
 * Digest of what Git ignores in a copy when a run starts there (att8 of the relecture of A1: a generated folder such as
 * `.svelte-kit`, a build left by an earlier run): every ignored file outside `node_modules` (LOCAL_STATE_FILES), `.git`, the
 * worktrees Git has registered (registeredWorktrees) and `.apv/receipts/`, by its path and the sha256 of its content (a symbolic link by its target; beyond
 * 64 MiB, or 1 GiB hashed in all, by its size and date). Measured once per copy, before the first check runs there: an origin
 * is reused only by a copy that starts from the same ignored state (a fresh copy of a batch, prepared by the same
 * batch.setup, does). Not comparable (never equal) when Git cannot list it or the copy holds more than MAX_WALKED entries.
 */
export async function copyStateDigest(dir: string): Promise<string> {
  let listed: string[];
  try { listed = await ignoredEntries(dir); } catch (error) { return sha256(unique(`git ls-files : ${(error as Error).message}`)); }
  const worktrees = registeredWorktrees(dir);
  const entries: [string, string][] = [];
  let walked = 0;
  let hashed = 0;
  const fileState = (path: string): string => {
    let info;
    try { info = lstatSync(path); } catch { return 'illisible'; }
    if (info.isSymbolicLink()) { try { return `lien:${readlinkSync(path)}`; } catch { return 'lien illisible'; } }
    if (!info.isFile()) return info.isDirectory() ? 'dossier' : 'autre';
    if (info.size > LOCAL_STATE_MAX_BYTES || hashed + info.size > MAX_HASHED_BYTES) return `taille:${info.size}:${Math.round(info.mtimeMs)}`;
    hashed += info.size;
    try { return sha256(readFileSync(path)); } catch { return 'illisible'; }
  };
  // Files only (a folder counts through the files it holds), each once: Git may list a folder and some of its files.
  const seen = new Set<string>();
  const stack = listed.filter(path => !outOfCopyState(path)).reverse();
  while (stack.length) {
    if ((walked += 1) > MAX_WALKED) return sha256(unique(`plus de ${MAX_WALKED} entrées ignorées`));
    const rel = stack.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!rel.endsWith('/')) { entries.push([rel, fileState(join(dir, rel))]); continue; }
    let children;
    try { children = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { entries.push([rel, 'dossier illisible']); continue; }
    // A worktree Git has registered (`.worktrees/x`): another copy, never part of this one. Any other folder that holds a
    // `.git` is walked, that entry included (relecture sécurité de A2, F1).
    if (worktrees.size && children.some(e => e.name === '.git') && worktrees.has(realOf(join(dir, rel)))) continue;
    for (const child of children.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))) {
      const path = `${rel}${child.name}${child.isDirectory() ? '/' : ''}`;
      if (!outOfCopyState(path)) stack.push(path);
    }
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(JSON.stringify({ version: 1, entries }));
}

/** Digest of a list of ignore globs (`reuse.ignoreDigest`): sorted and deduplicated, so their order never matters. */
export function ignoreDigest(globs: readonly string[]): string {
  return sha256(JSON.stringify([...new Set(globs)].sort()));
}

/** Globs of ALWAYS_REQUIRED that only name tests: a check may ignore the tests of another check (docs/ACCELERATION-LOTS.md, 5.2 A2). */
export const TEST_GLOBS: readonly string[] = ['test/**', 'tests/**', 'e2e/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*.e2e.*'];
/**
 * What `reuse.ignore` never takes out of the inputs of a check, whatever it says (docs/ACCELERATION-LOTS.md, 5.2 A2): the list
 * ALWAYS_REQUIRED of src/gates/proof-scope.ts without the test folders (configuration of the checks, manifests and lock files,
 * build, test and run settings, CI, migrations, scripts/**, .env*, content the application compiles or serves). The run and
 * verify add the check's own test paths, the files its commands name, the design folder and the configuration file read.
 */
export const NEVER_IGNORED: readonly string[] = ALWAYS_REQUIRED.filter(glob => !TEST_GLOBS.includes(glob));

/** One file of the tree of a commit: its raw path, its mode and its object. */
interface TreeEntry { path: Buffer; mode: string; blob: string }

/**
 * What the inputs of the checks read from Git, kept for one decision of reuse (relecture sécurité de A2, F4): the files of the
 * tree of each commit (one `git ls-tree` per commit, whatever the number of checks and rules), the files that differ between
 * two commits (one walk per pair, whatever the rule), and which paths match the ignored globs of a rule (one match per path and
 * per list of globs, whatever the number of commits).
 */
export interface InputsCache { entries: Map<string, Promise<TreeEntry[]>>; diffs: Map<string, Promise<TreeEntry[]>>; hits: Map<string, Map<string, boolean>> }
export const inputsCache = (): InputsCache => ({ entries: new Map(), diffs: new Map(), hits: new Map() });

/** `git ls-tree` output as raw bytes: a path that is not valid UTF-8 is never decoded with loss. */
async function lsTreeBytes(repo: string, commit: string): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'ls-tree', '-r', '-z', '--full-tree', '--end-of-options', `${commit}^{tree}`],
    { cwd: repo, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 120_000, env: GIT_ENV() });
  return stdout;
}

/** Every file of the tree of `commit` (submodules included), sorted by the bytes of its path. Fails when the commit is not in the repository. */
async function readTreeEntries(repo: string, commit: string): Promise<TreeEntry[]> {
  const out = await lsTreeBytes(repo, commit);
  const entries: TreeEntry[] = [];
  let start = 0;
  while (start < out.length) {
    let end = out.indexOf(0, start);
    if (end < 0) end = out.length;
    const entry = out.subarray(start, end);
    start = end + 1;
    if (!entry.length) continue;
    const tab = entry.indexOf(0x09);
    const [mode, , blob] = entry.subarray(0, tab).toString('latin1').split(' ');
    entries.push({ path: entry.subarray(tab + 1), mode: mode!, blob: blob! });
  }
  return entries.sort((a, b) => Buffer.compare(a.path, b.path));
}

/** The files of the tree of `commit`, read once per cache (a failure is kept too: the commit stays unreadable). */
function treeEntries(repo: string, commit: string, cache?: InputsCache): Promise<TreeEntry[]> {
  if (!cache) return readTreeEntries(repo, commit);
  if (!cache.entries.has(commit)) cache.entries.set(commit, readTreeEntries(repo, commit));
  return cache.entries.get(commit)!;
}

/** The digest of a list of entries: sha256 of the JSON of `[hex of the path, mode, object]`. */
const digestOf = (entries: readonly TreeEntry[]): string => sha256(JSON.stringify(entries.map(e => [e.path.toString('hex'), e.mode, e.blob])));

/**
 * The rule that takes files out of the inputs of a check (A2): `ignore` (globs read at the base), `keep` (globs never
 * ignorable, NEVER_IGNORED and the check's own, compared case ignored). A path is ignored only when it is valid UTF-8 without
 * a line terminator (the matcher never crosses one), matches a glob of `ignore`, and none of `keep`.
 */
export interface InputsRule { ignore: readonly string[]; keep: readonly string[] }

function ignoredBy(rule: InputsRule | null, cache?: InputsCache): (path: Buffer) => boolean {
  if (!rule || !rule.ignore.length) return () => false;
  const keep = rule.keep.map(g => g.toLowerCase());
  const safe = (path: string, glob: string): boolean => { try { return matches(path, glob); } catch { return false; } };
  // Whether a path matches the ignored globs, once per list of globs (most paths match none: `keep` is then never read).
  const hitKey = JSON.stringify(rule.ignore);
  let hits = cache?.hits.get(hitKey);
  if (!hits) { hits = new Map(); cache?.hits.set(hitKey, hits); }
  const memo = hits;
  return raw => {
    const key = raw.toString('latin1');
    let hit = memo.get(key);
    if (hit === undefined) {
      const path = raw.toString('utf8');
      hit = Buffer.from(path, 'utf8').equals(raw) && !/[\n\r\u2028\u2029]/.test(path) && rule.ignore.some(glob => safe(path, glob));
      memo.set(key, hit);
    }
    if (!hit) return false;
    const lower = raw.toString('utf8').toLowerCase();
    return !keep.some(glob => safe(lower, glob));
  };
}

/**
 * Digest of the inputs of a check at `commit` (`reuse.inputsDigest`): sha256 of the JSON of the list of `[path, mode, blob]`
 * of the tracked files of its tree (submodules included), sorted by the bytes of the path, minus those `rule` ignores. The
 * path enters the digest as the hexadecimal of its raw bytes, read from Git without any decoding: two different paths (a
 * line feed or a tab in a name, or bytes that are not UTF-8, such as `f` followed by 0xff or by 0xfe) never share an
 * encoding. Without a rule, two commits have the same digest exactly when they have the same tree content. Fails when the
 * commit is not in the repository. The `ignore` of a former signature is a rule without any glob kept.
 */
export async function inputsDigest(_git: Git, repo: string, commit: string, rule: InputsRule | readonly string[] | null = null, cache?: InputsCache):
  Promise<{ digest: string; files: number }> {
  const ignored = ignoredBy(Array.isArray(rule) ? { ignore: rule, keep: [] } : rule as InputsRule | null, cache);
  const inputs = (await treeEntries(repo, commit, cache)).filter(e => !ignored(e.path));
  return { digest: digestOf(inputs), files: inputs.length };
}

/** The entries that differ between two lists sorted by path (added, removed, or another mode or object): one walk of both. */
function differing(a: readonly TreeEntry[], b: readonly TreeEntry[]): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    const order = !x ? 1 : !y ? -1 : Buffer.compare(x.path, y.path);
    if (order < 0) { out.push(x!); i += 1; continue; }
    if (order > 0) { out.push(y!); j += 1; continue; }
    if (x!.mode !== y!.mode || x!.blob !== y!.blob) out.push(x!);
    i += 1;
    j += 1;
  }
  return out;
}

/** The files that differ between the trees of two commits, once per pair and cache (they do not depend on any rule). */
function differences(repo: string, from: string, to: string, cache?: InputsCache): Promise<TreeEntry[]> {
  const walk = async (): Promise<TreeEntry[]> => {
    const [a, b] = await Promise.all([treeEntries(repo, from, cache), treeEntries(repo, to, cache)]);
    return differing(a, b);
  };
  if (!cache) return walk();
  const key = `${from}\0${to}`;
  if (!cache.diffs.has(key)) cache.diffs.set(key, walk());
  return cache.diffs.get(key)!;
}

/**
 * The inputs of a check that differ between two commits under `rule` (none: the same digest of inputs on both sides), decoded
 * as UTF-8 and sorted. One walk of the two trees per pair, read once per cache: the cheap test of a candidate origin, and of
 * the base. Fails when either commit is not in the repository.
 */
export async function changedInputs(repo: string, from: string, to: string, rule: InputsRule, cache?: InputsCache): Promise<string[]> {
  const ignored = ignoredBy(rule, cache);
  return (await differences(repo, from, to, cache)).filter(e => !ignored(e.path)).map(e => e.path.toString('utf8')).sort();
}

/** What two commits differ by, for a check that ignores some files (A2): digests of its inputs, files changed, links among its inputs. */
export interface InputsComparison {
  from: string;
  to: string;
  /** Paths (decoded as UTF-8) that differ between the two trees: added, removed, or another mode or object. */
  changed: string[];
  /** Those of them that are inputs of the check (none when the digests are equal). */
  inputs: string[];
  /** Symbolic links among the inputs of either commit (their target may be an ignored file: a reuse by inputs never trusts them). */
  links: string[];
}

/** Compares the inputs of a check at two commits with `rule` (verify recomputes this from Git, never from the receipt). */
export async function compareInputs(repo: string, from: string, to: string, rule: InputsRule, cache?: InputsCache): Promise<InputsComparison> {
  const ignored = ignoredBy(rule, cache);
  const [a, b] = await Promise.all([treeEntries(repo, from, cache), treeEntries(repo, to, cache)]);
  const changed: string[] = [];
  const inputs: string[] = [];
  for (const e of await differences(repo, from, to, cache)) {
    changed.push(e.path.toString('utf8'));
    if (!ignored(e.path)) inputs.push(e.path.toString('utf8'));
  }
  const links = [...new Set([...a, ...b].filter(e => e.mode === '120000' && !ignored(e.path)).map(e => e.path.toString('utf8')))].sort();
  return { from: digestOf(a.filter(e => !ignored(e.path))), to: digestOf(b.filter(e => !ignored(e.path))), changed: changed.sort(), inputs: inputs.sort(), links };
}
