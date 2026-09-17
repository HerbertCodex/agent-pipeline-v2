import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { environment, runProcess } from '../execution/process.js';
import { isInside } from '../execution/git.js';
import { invariant, PipelineError } from '../domain/errors.js';
import type { Document } from '../persistence/store.js';
import type { Lifecycle } from './service.js';
import type { SpecRecord } from './contracts.js';

export interface GarbageItem {
  kind: 'run-workspace' | 'review-workspace' | 'role-workspace';
  path: string;
  reason: string;
  bytes: number;
}

const TERMINAL_SPEC = new Set(['closed', 'rejected']);

/**
 * Whether a spec still has work in flight. For a terminal spec, a leftover `activeRunId` counts only while
 * that run has a live process: specs rejected before the pointer was cleared would otherwise stay "active"
 * forever and their workspaces would never be collected.
 */
function specActive(life: Lifecycle, doc: Document<SpecRecord>): boolean {
  const r = doc.data;
  if (life.store.documentProcesses(doc.id).some(p => p.alive)) return true;
  if (!TERMINAL_SPEC.has(r.status)) return true;
  return Boolean(r.activeRunId) && life.pipeline.store.activeProcesses(r.activeRunId!).some(p => p.alive);
}
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
    const active = specActive(life, doc);
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

export interface PurgeItem {
  id: string;
  kind: 'spec' | 'bootstrap' | 'install';
  label: string;
  status: string;
  reason: string;
  lastEventAt: number;
  runIds: string[];
  workspaces: GarbageItem[];
  bytes: number;
}

const DEFAULT_PURGE_AGE_DAYS = 30;

/** Documents whose history is worth keeping are never proposed: only terminal or abandoned ones. */
function purgeReason(doc: Document<SpecRecord>, idle: boolean): string | null {
  const r = doc.data;
  if (TERMINAL_SPEC.has(r.status)) return `${r.status} spec`;
  if (!idle) return null;
  if (r.status === 'draft' && !r.approval && (r.attempts ?? []).length === 0) return 'draft never approved, abandoned';
  return null;
}

/**
 * Dry-run plan of lifecycle documents that can leave the store: terminal or abandoned specs, and plan
 * documents that were never applied. It lists the runs and workspaces that go with them, so the operator
 * sees the whole cost before confirming. Applied plans, approved specs still in flight and anything with a
 * live process or lease are never proposed; `ids` targets a document explicitly but keeps those guards.
 */
export function planPurge(life: Lifecycle, options: { ids?: readonly string[]; olderThanDays?: number; now?: number } = {}): PurgeItem[] {
  const store = life.store;
  const now = options.now ?? Date.now();
  const explicit = options.ids?.length ? new Set(options.ids) : null;
  const age = Math.max(0, options.olderThanDays ?? DEFAULT_PURGE_AGE_DAYS) * 24 * 60 * 60 * 1000;
  const garbage = planGarbage(life, now);
  const items: PurgeItem[] = [];
  const lastEvent = (id: string): number => store.documentEvents(id).reduce((n, e) => Math.max(n, e.at), 0);
  const kept = new Set(purgeProtections(life).map(x => x.id));
  for (const doc of store.documents<SpecRecord>('spec')) {
    if (explicit && !explicit.has(doc.id)) continue;
    if (kept.has(doc.id)) continue;
    const r = doc.data;
    if (TERMINAL_SPEC.has(r.status) ? specActive(life, doc) : (Boolean(r.activeRunId) || store.documentProcesses(doc.id).some(p => p.alive))) continue;
    const at = lastEvent(doc.id);
    const reason = purgeReason(doc, now - at >= age);
    if (!reason) continue;
    if (!explicit && now - at < age) continue;
    const runIds = [...new Set([...(r.attempts ?? []).map(a => a.runId), ...(r.validationRunIds ?? []), r.finalRunId].filter((x): x is string => Boolean(x)))];
    const workspaces = garbage.filter(g => g.path.endsWith(`/${doc.id}`) || runIds.some(runId => g.path.endsWith(`/${runId}`)));
    items.push({ id: doc.id, kind: 'spec', label: r.content?.title ?? '(no spec content)', status: r.status, reason, lastEventAt: at, runIds, workspaces,
      bytes: workspaces.reduce((n, g) => n + g.bytes, 0) });
  }
  for (const kind of ['bootstrap', 'install'] as const) {
    for (const doc of store.documents<{ applied?: boolean; directory?: string; repo?: string }>(kind)) {
      if (explicit && !explicit.has(doc.id)) continue;
      if (doc.data.applied) continue; // An applied plan is the record of a change made to a repository.
      if (store.documentProcesses(doc.id).some(p => p.alive)) continue;
      const at = lastEvent(doc.id);
      if (!explicit && now - at < age) continue;
      items.push({ id: doc.id, kind, label: doc.data.directory ?? doc.data.repo ?? '', status: 'never applied', reason: `${kind} plan never applied`, lastEventAt: at, runIds: [], workspaces: [], bytes: 0 });
    }
  }
  return items.sort((a, b) => a.lastEventAt - b.lastEventAt);
}

/**
 * Terminal documents a purge must keep because later work still reads them: for each repository, the spec
 * holding the visual direction that the next design continues.
 */
export function purgeProtections(life: Lifecycle): { id: string; reason: string }[] {
  const repos = new Set(life.store.documents<SpecRecord>('spec').map(d => d.data.repo).filter(Boolean));
  const out: { id: string; reason: string }[] = [];
  for (const repo of repos) {
    const reference = life.designReference(repo);
    if (reference) out.push({ id: reference.id, reason: `approved visual direction continued by the next design of ${repo}` });
  }
  return out;
}

/** Removes planned documents: their workspaces first, then their runs, then the document itself. */
export async function purgeDocuments(life: Lifecycle, items: readonly PurgeItem[]): Promise<{ purged: PurgeItem[]; failed: { id: string; error: string }[] }> {
  const purged: PurgeItem[] = []; const failed: { id: string; error: string }[] = [];
  for (const item of items) {
    try {
      const workspaces = await collectGarbage(life, item.workspaces);
      invariant(workspaces.failed.length === 0, 'PURGE', `Workspaces of ${item.id} could not be removed: ${workspaces.failed.map(f => f.path).join(', ')}`);
      for (const runId of item.runIds) {
        try { life.pipeline.store.deleteRun(runId); }
        catch (error) { if (!(error instanceof PipelineError && error.code === 'NOT_FOUND')) throw error; }
      }
      life.store.deleteDocument(item.id, item.kind);
      purged.push(item);
    } catch (error) { failed.push({ id: item.id, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { purged, failed };
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
