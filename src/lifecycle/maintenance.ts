import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { environment, runProcess } from '../execution/process.js';
import { isInside } from '../execution/git.js';
import type { Lifecycle } from './service.js';
import type { SpecRecord } from './contracts.js';

export interface GarbageItem {
  kind: 'run-workspace' | 'review-workspace' | 'role-workspace';
  path: string;
  reason: string;
  bytes: number;
}

const TERMINAL_SPEC = new Set(['closed', 'rejected']);
const TERMINAL_STANDALONE_RUN = new Set(['failed', 'rejected']);
const ROLE_LEFTOVER_AGE_MS = 24 * 60 * 60 * 1000;

function sizeOf(path: string): number {
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) return st.size;
  return readdirSync(path).reduce((n, entry) => n + sizeOf(join(path, entry)), 0);
}

/** Git worktrees nested (up to two levels) in an owned directory, with the repository they belong to. */
function nestedWorktrees(path: string, depth = 2): { worktree: string; repo: string }[] {
  const out: { worktree: string; repo: string }[] = [];
  const gitFile = join(path, '.git');
  if (existsSync(gitFile) && lstatSync(gitFile).isFile()) {
    const gitdir = readFileSync(gitFile, 'utf8').trim().replace(/^gitdir:\s*/, '');
    const marker = gitdir.lastIndexOf('/.git/worktrees/');
    if (marker > 0) out.push({ worktree: path, repo: gitdir.slice(0, marker) });
    return out;
  }
  if (depth === 0) return out;
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    if (lstatSync(child).isDirectory()) out.push(...nestedWorktrees(child, depth - 1));
  }
  return out;
}

/**
 * Dry-run plan of operational material no longer needed: workspaces of closed/rejected specs,
 * superseded baseline (doctor) runs, failed/rejected standalone runs, review workspaces of
 * closed/rejected specs and stale role workspaces. Never the SQLite history, deliveries or source.
 */
export function planGarbage(life: Lifecycle, now = Date.now()): GarbageItem[] {
  const store = life.store;
  const items: GarbageItem[] = [];
  const specs = store.documents<SpecRecord>('spec');
  const referenced = new Map<string, { specId: string; status: string; active: boolean }>();
  for (const doc of specs) {
    const r = doc.data;
    const active = !TERMINAL_SPEC.has(r.status) || Boolean(r.activeRunId) || store.documentProcesses(doc.id).some(p => p.alive);
    const runs = [...(r.attempts ?? []).map(a => a.runId), ...(r.validationRunIds ?? []), r.finalRunId, r.activeRunId].filter((x): x is string => Boolean(x));
    for (const runId of runs) {
      const previous = referenced.get(runId);
      referenced.set(runId, { specId: doc.id, status: r.status, active: active || Boolean(previous?.active) });
    }
    if (!active && r.repo) {
      const review = resolve(dirname(r.repo), `${basename(r.repo)}-review`, doc.id);
      if (existsSync(review) && !lstatSync(review).isSymbolicLink()) items.push({ kind: 'review-workspace', path: review, reason: `review material of ${r.status} spec ${doc.id}`, bytes: sizeOf(review) });
    }
  }

  const workspaces = join(store.root, 'workspaces');
  const baselines = new Map<string, { runId: string; at: number }[]>();
  const standalone: { runId: string; reason: string }[] = [];
  if (existsSync(workspaces)) for (const runId of readdirSync(workspaces)) {
    const ref = referenced.get(runId);
    if (ref) {
      if (!ref.active) standalone.push({ runId, reason: `run of ${ref.status} spec ${ref.specId}` });
      continue;
    }
    let run;
    try { run = life.pipeline.store.get(runId); } catch { continue; } // unknown directory: never guessed
    if (life.pipeline.store.activeProcesses(runId).some(p => p.alive)) continue;
    if (run.task.id === 'BASELINE') {
      const at = life.pipeline.store.events(runId)[0]?.at ?? 0;
      baselines.set(run.repo, [...(baselines.get(run.repo) ?? []), { runId, at }]);
    } else if (TERMINAL_STANDALONE_RUN.has(run.state)) standalone.push({ runId, reason: `standalone ${run.state} run` });
  }
  for (const runs of baselines.values()) {
    runs.sort((a, b) => b.at - a.at);
    for (const old of runs.slice(1)) standalone.push({ runId: old.runId, reason: `baseline check superseded by ${runs[0]!.runId}` });
  }
  for (const { runId, reason } of standalone) {
    const path = join(workspaces, runId);
    if (existsSync(path) && !lstatSync(path).isSymbolicLink()) items.push({ kind: 'run-workspace', path, reason, bytes: sizeOf(path) });
  }

  const roles = join(store.root, 'roles');
  if (existsSync(roles)) for (const entry of readdirSync(roles)) {
    const path = join(roles, entry);
    const st = lstatSync(path);
    if (st.isDirectory() && !st.isSymbolicLink() && now - statSync(path).mtimeMs > ROLE_LEFTOVER_AGE_MS)
      items.push({ kind: 'role-workspace', path, reason: 'role workspace left by an interrupted invocation', bytes: sizeOf(path) });
  }
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

/** Removes planned items: registered worktrees through Git first, then the owned directory. */
export async function collectGarbage(life: Lifecycle, items: GarbageItem[]): Promise<{ removed: GarbageItem[]; failed: { path: string; error: string }[] }> {
  const env = environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'LANG']);
  const removed: GarbageItem[] = []; const failed: { path: string; error: string }[] = [];
  const repos = new Set<string>();
  const specIds = new Set(life.store.documents<SpecRecord>('spec').map(d => d.id));
  for (const item of items) {
    const owned = item.kind === 'review-workspace'
      ? basename(dirname(item.path)).endsWith('-review') && specIds.has(basename(item.path))
      : isInside(life.store.root, item.path) && resolve(item.path) !== resolve(life.store.root);
    if (!owned || !existsSync(item.path) || lstatSync(item.path).isSymbolicLink()) { failed.push({ path: item.path, error: 'not an owned directory' }); continue; }
    try {
      for (const { worktree, repo } of nestedWorktrees(item.path)) {
        repos.add(repo);
        if (existsSync(repo)) await runProcess({ command: ['git', 'worktree', 'remove', '--force', worktree], cwd: repo, env, timeoutMs: 60000 });
      }
      rmSync(item.path, { recursive: true, force: true });
      removed.push(item);
    } catch (error) { failed.push({ path: item.path, error: error instanceof Error ? error.message : String(error) }); }
  }
  for (const repo of repos) if (existsSync(repo)) await runProcess({ command: ['git', 'worktree', 'prune'], cwd: repo, env, timeoutMs: 60000 });
  for (const item of removed) if (item.kind === 'review-workspace') {
    const parent = dirname(item.path);
    if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });
  }
  return { removed, failed };
}
