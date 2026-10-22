import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ApvConfig } from '../config/load.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { LockStore } from '../lock/store.js';
import { flockFree, resolveStacks } from '../stacks/idle.js';

/**
 * The fresh copy of the full suite of the release (docs/UNE-SUITE-PAR-PR.md): a detached worktree of the commit under the Git
 * common directory, prepared by `batch.setup` (runGates with `batchSetup`), removed at the end, at the same path for the same
 * tree (`<git common dir>/apv/fresh/<tree>`): a release run again at the same tree finds the same local state Git ignores and
 * can reuse its own green receipts. One copy of a tree at a time (lease `fresh-<tree>` of the lock folder of the repository).
 */

interface Run { status: number; stdout: string; stderr: string }
function git(repo: string, args: string[]): Run {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 300_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? errorMessage(r.error) : '') };
}

/** The directory of the fresh copy of `tree` (40 or 64 hexadecimal characters): `<common>/apv/fresh/<16 first>`. */
export const freshCopyDir = (common: string, tree: string, slot = ''): string => join(common, 'apv', 'fresh', `${tree.slice(0, 16)}${slot}`);

/** Removes a copy, even a locked one (`git worktree lock` by a suite that wanted its copy to stay): unlock first, then remove. */
function removeCopy(repo: string, dir: string): Run {
  git(repo, ['worktree', 'unlock', dir]);
  return git(repo, ['worktree', 'remove', '--force', '--force', dir]);
}

/**
 * Removes the copies left in `<common>/apv/fresh` by an earlier pass (a removal that failed, a pass killed), locked ones included,
 * at the start of `apv release auto`. A copy whose lease is held (another release at work) is left alone. Returns the removed ones.
 */
export async function removeStaleCopies(repo: string, common: string, log: (line: string) => void = () => undefined): Promise<string[]> {
  const root = join(common, 'apv', 'fresh');
  if (!existsSync(root)) return [];
  const store = new LockStore(join(common, 'apv', 'locks'));
  const removed: string[] = [];
  for (const entry of readdirSync(root)) {
    const name = `fresh-${entry}`;
    const lock = await store.tryAcquire(name, { pid: process.pid, host: store.host, label: `nettoyage de ${entry}` }, 600, 'nettoyage des copies neuves');
    if (!lock.ok) continue;
    try {
      const dir = join(root, entry);
      const r = removeCopy(repo, dir);
      rmSync(dir, { recursive: true, force: true });
      if (r.status !== 0) log(`Copie ${dir} laissée par une passe précédente : retrait forcé après git : ${r.stderr.trim().slice(0, 200)}`);
      removed.push(dir);
    } finally { await store.release(name, { token: lock.record.token }).catch(() => undefined); }
  }
  if (removed.length) git(repo, ['worktree', 'prune']);
  return removed;
}

/**
 * Runs `fn` in the fresh copy of `sha` (made, then removed whatever happens), or returns `busy` when another copy of the
 * same tree is in use. A directory left by an interrupted run is removed first (it is a copy, never a working tree).
 */
export async function withFreshCopy<T>(repo: string, common: string, sha: string, fn: (dir: string) => Promise<T>, log: (line: string) => void = () => undefined, slot = ''): Promise<T | { busy: string }> {
  const tree = git(repo, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`]).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new PipelineError('GATE_COPY', `arbre du commit ${sha.slice(0, 12)} illisible : copie neuve impossible`);
  const store = new LockStore(join(common, 'apv', 'locks'));
  const name = `fresh-${tree.slice(0, 16)}${slot}`;
  const lock = await store.tryAcquire(name, { pid: process.pid, host: store.host, label: `copie neuve ${sha.slice(0, 12)} (${repo})` }, 12 * 3600, 'copie neuve de la suite complète');
  if (!lock.ok) return { busy: `copie neuve de l'arbre ${tree.slice(0, 12)} déjà en cours (verrou ${name} tenu par le pid ${lock.holder?.owner.pid ?? '?'})` };
  const dir = freshCopyDir(common, tree, slot);
  try {
    mkdirSync(join(common, 'apv', 'fresh'), { recursive: true });
    if (existsSync(dir)) {
      removeCopy(repo, dir);
      rmSync(dir, { recursive: true, force: true });
      git(repo, ['worktree', 'prune']);
    }
    const added = git(repo, ['worktree', 'add', '--detach', dir, sha]);
    if (added.status !== 0) throw new PipelineError('GATE_COPY', `copie neuve ${dir} non créée : ${added.stderr.trim()}`);
    log(`Copie neuve de ${sha.slice(0, 12)} : ${dir} (préparée par batch.setup, retirée à la fin).`);
    try { return await fn(dir); }
    finally {
      const removed = removeCopy(repo, dir);
      if (removed.status !== 0) log(`Copie ${dir} non retirée : ${removed.stderr.trim()} (git worktree remove --force ${dir}).`);
    }
  } finally {
    await store.release(name, { token: lock.record.token }).catch(() => undefined);
  }
}

/**
 * The stacks a full suite in a fresh copy is given, as `apv gates run --stacks`: those forced, else the first declared whose
 * lock is free (a lock file held by someone else is busy); none declared: none given (`ids` undefined); all busy: `busy`,
 * with the first declared stack (the release comes back later).
 */
export function pickStacks(config: ApvConfig, common: string, forced: string[] | undefined): { ids: string[] | undefined } | { busy: string; first: string } {
  const declared = resolveStacks(config, common);
  if (!declared.length) {
    if (forced) throw new PipelineError('STACK_UNKNOWN', '--stacks : aucune pile déclarée (section stacks de .apv/config.json)');
    return { ids: undefined };
  }
  if (forced) {
    const unknown = forced.filter(id => !declared.some(s => s.id === id));
    if (unknown.length) throw new PipelineError('STACK_UNKNOWN', `--stacks : pile inconnue ${unknown.join(', ')} (déclarées : ${declared.map(s => s.id).join(', ')})`);
    return { ids: forced };
  }
  const free = declared.find(s => !s.lockFile || flockFree(s.lockFile) !== false);
  return free ? { ids: [free.id] } : { busy: declared.map(s => `${s.id} : verrou ${s.lockFile} tenu`).join(' ; '), first: declared[0]!.id };
}
