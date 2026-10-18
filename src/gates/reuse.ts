import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sha256 } from '../domain/hash.js';
import type { Git } from '../execution/git.js';
import { environment } from '../execution/process.js';
import { matches } from '../policy/policy.js';

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
 * What Git ignores in a copy and a check still runs with (relecture sécurité de A1, M2): the installed dependencies, seen
 * through the folder `node_modules` and the record each package manager writes there at every install (npm, pnpm, Yarn
 * Berry, Yarn 1), and the `.env*` files at the root of the copy. Two copies of the same tree with other dependencies
 * installed, or another `.env.local`, are not the same environment.
 */
export const LOCAL_STATE_FILES = ['node_modules/.package-lock.json', 'node_modules/.modules.yaml', 'node_modules/.yarn-state.yml', 'node_modules/.yarn-integrity'] as const;
/** Largest file of the local state read for its digest (64 MiB): beyond, its size and date stand for its content. */
const LOCAL_STATE_MAX_BYTES = 64 * 1024 * 1024;

/** What a path of the local state is: absent, a folder, unreadable, or the sha256 of its content (never the content). */
function stateOf(path: string): string {
  let info;
  try { info = statSync(path); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'illisible'; }
  if (info.isDirectory()) return 'dossier';
  if (!info.isFile()) return 'autre';
  if (info.size > LOCAL_STATE_MAX_BYTES) return `taille:${info.size}:${Math.round(info.mtimeMs)}`;
  try { return sha256(readFileSync(path)); } catch { return 'illisible'; }
}

/**
 * Digest of the local state of a copy (LOCAL_STATE_FILES, `node_modules` present or not, each `.env*` at its root), part of
 * the identity of the environment of every receipt: a check is reused only from an origin that ran with the same local
 * state. Contents are hashed, one digest for all: no value of a `.env*` file is ever written, in a receipt or an output.
 */
export function localStateDigest(dir: string): string {
  const entries: [string, string][] = [['node_modules', stateOf(join(dir, 'node_modules'))]];
  for (const file of LOCAL_STATE_FILES) entries.push([file, stateOf(join(dir, file))]);
  let names: string[] = [];
  try { names = readdirSync(dir).filter(name => name.startsWith('.env')).sort(); } catch { names = ['(racine illisible)']; }
  for (const name of names) entries.push([name, stateOf(join(dir, name))]);
  return sha256(JSON.stringify({ version: 1, entries }));
}

/** Digest of a list of ignore globs (`reuse.ignoreDigest`): sorted and deduplicated, so their order never matters. */
export function ignoreDigest(globs: readonly string[]): string {
  return sha256(JSON.stringify([...new Set(globs)].sort()));
}

/** `git ls-tree` output as raw bytes: a path that is not valid UTF-8 is never decoded with loss. */
async function lsTreeBytes(repo: string, commit: string): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'ls-tree', '-r', '-z', '--full-tree', '--end-of-options', `${commit}^{tree}`],
    { cwd: repo, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 120_000,
      env: { ...environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'LANG']), GIT_TERMINAL_PROMPT: '0' } });
  return stdout;
}

/**
 * Digest of the inputs of a check at `commit` (`reuse.inputsDigest`): sha256 of the JSON of the list of `[path, mode, blob]`
 * of the tracked files of its tree (submodules included), sorted by the bytes of the path, minus those matching `ignore`.
 * The path enters the digest as the hexadecimal of its raw bytes, read from Git without any decoding: two different paths
 * (a line feed or a tab in a name, or bytes that are not UTF-8, such as `f` followed by 0xff or by 0xfe) never share an
 * encoding. Globs are compared to the path decoded as UTF-8. With no glob, two commits have the same digest exactly when
 * they have the same tree content. Fails when the commit is not in the repository.
 */
export async function inputsDigest(_git: Git, repo: string, commit: string, ignore: readonly string[] = []): Promise<{ digest: string; files: number }> {
  const out = await lsTreeBytes(repo, commit);
  const entries: { path: Buffer; mode: string; blob: string }[] = [];
  let start = 0;
  while (start < out.length) {
    let end = out.indexOf(0, start);
    if (end < 0) end = out.length;
    const entry = out.subarray(start, end);
    start = end + 1;
    if (!entry.length) continue;
    const tab = entry.indexOf(0x09);
    const [mode, , blob] = entry.subarray(0, tab).toString('latin1').split(' ');
    const path = entry.subarray(tab + 1);
    if (ignore.length && ignore.some(glob => matches(path.toString('utf8'), glob))) continue;
    entries.push({ path, mode: mode!, blob: blob! });
  }
  entries.sort((a, b) => Buffer.compare(a.path, b.path));
  return { digest: sha256(JSON.stringify(entries.map(e => [e.path.toString('hex'), e.mode, e.blob]))), files: entries.length };
}
