import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
 * `node_modules`, `.git` and the nested repositories, such as the worktrees of `.worktrees/`). Two copies of the same tree
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

/**
 * The `.env*` files of a copy at any depth, relative paths sorted, outside `node_modules`, `.git` and the folders that are
 * another repository or worktree (they hold a `.git`); symbolic links to folders are not followed. Null beyond MAX_WALKED.
 */
function envFiles(dir: string): string[] | null {
  const found: string[] = [];
  const stack: string[] = [''];
  let walked = 0;
  while (stack.length) {
    const rel = stack.pop()!;
    let entries;
    try { entries = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { found.push(`${rel}(dossier illisible)`); continue; }
    if (rel && entries.some(e => e.name === '.git')) continue;
    for (const entry of entries) {
      if ((walked += 1) > MAX_WALKED) return null;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.env')) found.push(path);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') stack.push(path);
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
const outOfCopyState = (path: string): boolean => path === '.apv/receipts/' || path.startsWith('.apv/receipts/') || path.split('/').includes('node_modules') || path.split('/').includes('.git');

/**
 * Digest of what Git ignores in a copy when a run starts there (att8 of the relecture of A1: a generated folder such as
 * `.svelte-kit`, a build left by an earlier run): every ignored file outside `node_modules` (LOCAL_STATE_FILES), `.git`, the
 * nested repositories and `.apv/receipts/`, by its path and the sha256 of its content (a symbolic link by its target; beyond
 * 64 MiB, or 1 GiB hashed in all, by its size and date). Measured once per copy, before the first check runs there: an origin
 * is reused only by a copy that starts from the same ignored state (a fresh copy of a batch, prepared by the same
 * batch.setup, does). Not comparable (never equal) when Git cannot list it or the copy holds more than MAX_WALKED entries.
 */
export async function copyStateDigest(dir: string): Promise<string> {
  let listed: string[];
  try { listed = await ignoredEntries(dir); } catch (error) { return sha256(unique(`git ls-files : ${(error as Error).message}`)); }
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
    // Another repository or worktree (`.worktrees/x`): another copy, never part of this one.
    if (children.some(e => e.name === '.git')) continue;
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

/** `git ls-tree` output as raw bytes: a path that is not valid UTF-8 is never decoded with loss. */
async function lsTreeBytes(repo: string, commit: string): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'ls-tree', '-r', '-z', '--full-tree', '--end-of-options', `${commit}^{tree}`],
    { cwd: repo, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 120_000, env: GIT_ENV() });
  return stdout;
}

/** Every file of the tree of `commit` (submodules included), sorted by the bytes of its path. Fails when the commit is not in the repository. */
async function treeEntries(repo: string, commit: string): Promise<TreeEntry[]> {
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

/** The digest of a list of entries: sha256 of the JSON of `[hex of the path, mode, object]`. */
const digestOf = (entries: readonly TreeEntry[]): string => sha256(JSON.stringify(entries.map(e => [e.path.toString('hex'), e.mode, e.blob])));

/**
 * The rule that takes files out of the inputs of a check (A2): `ignore` (globs read at the base), `keep` (globs never
 * ignorable, NEVER_IGNORED and the check's own, compared case ignored). A path is ignored only when it is valid UTF-8 without
 * a line terminator (the matcher never crosses one), matches a glob of `ignore`, and none of `keep`.
 */
export interface InputsRule { ignore: readonly string[]; keep: readonly string[] }

function ignoredBy(rule: InputsRule | null): (path: Buffer) => boolean {
  if (!rule || !rule.ignore.length) return () => false;
  const keep = rule.keep.map(g => g.toLowerCase());
  const safe = (path: string, glob: string): boolean => { try { return matches(path, glob); } catch { return false; } };
  return raw => {
    const path = raw.toString('utf8');
    if (!Buffer.from(path, 'utf8').equals(raw) || /[\n\r\u2028\u2029]/.test(path)) return false;
    if (!rule.ignore.some(glob => safe(path, glob))) return false;
    const lower = path.toLowerCase();
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
export async function inputsDigest(_git: Git, repo: string, commit: string, rule: InputsRule | readonly string[] | null = null): Promise<{ digest: string; files: number }> {
  const ignored = ignoredBy(Array.isArray(rule) ? { ignore: rule, keep: [] } : rule as InputsRule | null);
  const inputs = (await treeEntries(repo, commit)).filter(e => !ignored(e.path));
  return { digest: digestOf(inputs), files: inputs.length };
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
export async function compareInputs(repo: string, from: string, to: string, rule: InputsRule): Promise<InputsComparison> {
  const ignored = ignoredBy(rule);
  const [a, b] = await Promise.all([treeEntries(repo, from), treeEntries(repo, to)]);
  const key = (e: TreeEntry): string => e.path.toString('hex');
  const at = new Map(a.map(e => [key(e), e]));
  const bt = new Map(b.map(e => [key(e), e]));
  const changed: string[] = [];
  const inputs: string[] = [];
  for (const k of new Set([...at.keys(), ...bt.keys()])) {
    const x = at.get(k);
    const y = bt.get(k);
    if (x && y && x.mode === y.mode && x.blob === y.blob) continue;
    const path = (x ?? y)!.path;
    changed.push(path.toString('utf8'));
    if (!ignored(path)) inputs.push(path.toString('utf8'));
  }
  const links = [...new Set([...a, ...b].filter(e => e.mode === '120000' && !ignored(e.path)).map(e => e.path.toString('utf8')))].sort();
  return { from: digestOf(a.filter(e => !ignored(e.path))), to: digestOf(b.filter(e => !ignored(e.path))), changed: changed.sort(), inputs: inputs.sort(), links };
}
