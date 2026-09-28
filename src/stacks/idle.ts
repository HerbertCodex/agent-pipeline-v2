import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { suiteSettings, type ApvConfig } from '../config/load.js';
import { errorMessage } from '../domain/errors.js';
import { listeningInodes } from '../execution/procs.js';
import { runProcess } from '../execution/process.js';
import { LockStore, defaultLockDir } from '../lock/store.js';
import { gitRead } from '../run/git-probe.js';
import { DEFAULT_IDLE_AFTER_MS, stackPath, type StackConfig } from './config.js';

/**
 * Idle test stacks (docs/APV3-SPEC.md, section 18.4): a stack is stopped only on the evidence of a continuous series
 * of observations that found it free (no lock of the stack held, no full suite running, nothing listening on its
 * ports) for at least the idle delay, with no known use since the series started. A single observation never stops
 * anything; two observations further apart than `MAX_GAP_MS` restart the series (nothing proves the stack stayed free
 * in between). The stop runs under the lock of the stack and of the suite queue, both taken without waiting.
 */

/** Longest gap between two observations of one idle series. */
export const MAX_GAP_MS = 120_000;
/** Delay between two observations of `apv stacks idle-stop --watch`. */
export const WATCH_INTERVAL_MS = 30_000;
/** Exit code of `flock -n -E` when the lock is held by another process. */
const FLOCK_BUSY = 75;

/** A declared stack with its paths made absolute. */
export interface ResolvedStack {
  config: StackConfig;
  id: string;
  lockFile: string | null;
  resource: string | null;
  envFile: string | null;
}

/** What is kept between two passes, in `<git common dir>/apv/stacks/<id>.json`. */
export interface StackRecord {
  version: 1;
  id: string;
  lastObservedAt: string | null;
  /** Last time the stack was seen or known in use (lock held, ports listening, a check of apv gates run under its lock). */
  lastUsedAt: string | null;
  /** Start of the current series of observations that found it free; null when it is busy or unknown. */
  freeSince: string | null;
  stoppedAt: string | null;
  startedAt: string | null;
}

export interface Observation {
  id: string;
  /** Why the stack is busy now (lock held, suite running, port listening), empty when free. */
  busy: string[];
  /** Time the stack has been free by the series of observations; 0 when busy or the series just started. */
  idleMs: number;
  record: StackRecord;
}

/** The Git common directory of `repo`, absolute. */
export function commonDir(repo: string): string {
  const out = gitRead(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!out) throw new Error(`Pas un dépôt Git : ${repo}`);
  return out;
}

export function resolveStacks(config: ApvConfig, common: string): ResolvedStack[] {
  return (config.stacks ?? []).map(stack => ({
    config: stack, id: stack.id,
    lockFile: stack.lockFile ? stackPath(common, stack.lockFile) : null,
    resource: stack.resource ?? null,
    envFile: stack.envFile ? stackPath(common, stack.envFile) : null,
  }));
}

export const stacksDir = (common: string): string => join(common, 'apv', 'stacks');
const recordPath = (common: string, id: string): string => join(stacksDir(common), `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

export function readRecord(common: string, id: string): StackRecord {
  const empty: StackRecord = { version: 1, id, lastObservedAt: null, lastUsedAt: null, freeSince: null, stoppedAt: null, startedAt: null };
  try {
    const raw = JSON.parse(readFileSync(recordPath(common, id), 'utf8')) as Partial<StackRecord>;
    const at = (v: unknown): string | null => typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
    return { ...empty, lastObservedAt: at(raw.lastObservedAt), lastUsedAt: at(raw.lastUsedAt), freeSince: at(raw.freeSince), stoppedAt: at(raw.stoppedAt), startedAt: at(raw.startedAt) };
  } catch { return empty; }
}

export function writeRecord(common: string, record: StackRecord): void {
  mkdirSync(stacksDir(common), { recursive: true });
  const file = recordPath(common, record.id);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Appends one decision to `<git common dir>/apv/stacks/events.log` (one JSON object per line, rotated at 1 MB). */
export function journal(common: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(stacksDir(common), { recursive: true });
    const file = join(stacksDir(common), 'events.log');
    try { if (statSync(file).size > 1_000_000) renameSync(file, `${file}.1`); } catch { /* no log yet */ }
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch { /* the journal never breaks a decision */ }
}

/** Notes a known use of the stacks (a check of `apv gates run` under their lock that just ended). */
export function markStacksUsed(common: string, ids: readonly string[], at = new Date()): void {
  for (const id of ids) {
    try {
      const record = readRecord(common, id);
      writeRecord(common, { ...record, lastUsedAt: at.toISOString(), freeSince: null });
    } catch { /* a missing note only delays an idle stop */ }
  }
}

/** The stacks whose lock is the lock of this check (same flock file, or same lease resource). */
export function stacksOfLock(stacks: readonly ResolvedStack[], lock: { kind: 'lease'; resource: string } | { kind: 'flock'; file: string }): string[] {
  return stacks.filter(s => lock.kind === 'lease' ? s.resource === lock.resource : s.lockFile !== null && s.lockFile === lock.file).map(s => s.id);
}

/** Last event of `resource` in the journal of `apv lock` (its tail), or null. */
function lastLeaseEvent(dir: string, resource: string): number | null {
  const file = join(dir, 'events.log');
  let text = '';
  try {
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
    } finally { closeSync(fd); }
  } catch { return null; }
  let last: number | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes(resource)) continue;
    try {
      const e = JSON.parse(line) as { at?: string; resource?: string };
      const t = e.resource === resource && e.at ? Date.parse(e.at) : NaN;
      if (!Number.isNaN(t) && (last === null || t > last)) last = t;
    } catch { /* a truncated first line */ }
  }
  return last;
}

/** Whether the flock of `file` is free now: taken and released at once (`flock -n`). Null when unknown. */
export function flockFree(file: string): boolean | null {
  if (!existsSync(file)) return true;
  const r = spawnSync('flock', ['-n', '-E', String(FLOCK_BUSY), file, 'true'], { stdio: 'ignore', timeout: 10_000 });
  if (r.error || r.status === null) return null;
  return r.status === 0 ? true : r.status === FLOCK_BUSY ? false : null;
}

/** A lease of `apv lock` held by a live owner. */
function leaseHeld(store: LockStore, resource: string): boolean {
  const snapshot = store.read(resource);
  return snapshot.exists && store.staleness(snapshot) === null;
}

export interface ProbeContext { repo: string; common: string; config: ApvConfig; env: NodeJS.ProcessEnv }

/** The suite queue of the repository: its lease store and resource. */
function suiteQueue(context: ProbeContext): { store: LockStore; resource: string } | null {
  const settings = suiteSettings(context.config).queue;
  if (!settings.enabled) return null;
  const file = stackPath(context.common, settings.lockFile);
  return { store: new LockStore(dirname(file)), resource: basename(file).replace(/\.lock$/, '') };
}

/** Why the stack is busy now; empty when it is free. */
export function probe(stack: ResolvedStack, context: ProbeContext): string[] {
  const busy: string[] = [];
  if (stack.lockFile) {
    const free = flockFree(stack.lockFile);
    if (free === false) busy.push(`verrou ${stack.lockFile} tenu`);
    if (free === null) busy.push(`verrou ${stack.lockFile} illisible (flock absent ?)`);
  }
  if (stack.resource && leaseHeld(new LockStore(defaultLockDir(context.env)), stack.resource)) busy.push(`bail ${stack.resource} tenu`);
  const queue = suiteQueue(context);
  if (queue && leaseHeld(queue.store, queue.resource)) busy.push('suite complète en cours (file suite.queue tenue)');
  const ports = stack.config.ports ?? [];
  if (ports.length) {
    try {
      const listening = new Set(listeningInodes().values());
      const open = ports.filter(p => listening.has(p));
      if (open.length) busy.push(`port(s) à l'écoute : ${open.join(', ')}`);
    } catch { /* no /proc: the locks decide */ }
  }
  return busy;
}

/**
 * One observation of a stack: busy now, or free, and since when by the series of observations. Writes the record.
 * A known use after the start of the series (a lease event, a check of apv gates run) moves its start there.
 */
export function observe(stack: ResolvedStack, context: ProbeContext, now = Date.now()): Observation {
  const record = readRecord(context.common, stack.id);
  const busy = probe(stack, context);
  const iso = new Date(now).toISOString();
  const previous = record.lastObservedAt ? Date.parse(record.lastObservedAt) : null;
  if (busy.length) {
    const next = { ...record, lastObservedAt: iso, lastUsedAt: iso, freeSince: null };
    writeRecord(context.common, next);
    return { id: stack.id, busy, idleMs: 0, record: next };
  }
  const leaseUse = stack.resource ? lastLeaseEvent(defaultLockDir(context.env), stack.resource) : null;
  const knownUse = Math.max(record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0, leaseUse ?? 0);
  let freeSince = record.freeSince ? Date.parse(record.freeSince) : null;
  const continuous = previous !== null && now - previous <= MAX_GAP_MS;
  if (freeSince === null || !continuous) freeSince = now;
  else if (knownUse > freeSince) freeSince = Math.min(knownUse, now);
  const next = { ...record, lastObservedAt: iso, freeSince: new Date(freeSince).toISOString() };
  writeRecord(context.common, next);
  return { id: stack.id, busy, idleMs: now - freeSince, record: next };
}

export type IdleDecision =
  | { id: string; action: 'stopped'; idleMs: number; output: string }
  | { id: string; action: 'failed'; idleMs: number; output: string }
  | { id: string; action: 'would-stop'; idleMs: number }
  | { id: string; action: 'kept'; idleMs: number; reason: string };

const minutes = (ms: number): string => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min`;

/** Runs `argv` from the root of the repository, bounded, output kept (last 4000 characters). */
async function runStackCommand(repo: string, argv: readonly string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  const r = await runProcess({ command: argv, cwd: repo, env, timeoutMs, maxOutputBytes: 64 * 1024 });
  return { ok: r.status === 'passed', output: `${r.stdout}\n${r.stderr}`.trim().slice(-4000) || `(${r.status}, code ${r.exitCode ?? '-'})` };
}

/**
 * Runs `argv` under the lock of the stack and the suite queue, both taken without waiting: `null` when one is held
 * (the stack is in use, nothing ran), else the outcome of the command.
 */
export async function underStackLock(stack: ResolvedStack, context: ProbeContext, argv: readonly string[], label: string): Promise<{ ok: boolean; output: string } | null> {
  const owner = { pid: process.pid, host: hostname(), label: `apv stacks ${label} ${stack.id}` };
  const queue = suiteQueue(context);
  const held: (() => Promise<unknown>)[] = [];
  try {
    if (queue) {
      const q = await queue.store.tryAcquire(queue.resource, owner, 3600, `apv stacks ${label}`);
      if (!q.ok) return null;
      held.push(() => queue.store.release(queue.resource, { token: q.record.token }));
    }
    if (stack.resource) {
      const store = new LockStore(defaultLockDir(context.env));
      const r = await store.tryAcquire(stack.resource, owner, 3600, `apv stacks ${label}`);
      if (!r.ok) return null;
      held.push(() => store.release(stack.resource!, { token: r.record.token }));
    }
    const timeoutMs = stack.config.commandTimeoutMs;
    if (stack.lockFile) {
      mkdirSync(dirname(stack.lockFile), { recursive: true });
      const r = await runProcess({ command: ['flock', '-n', '-E', String(FLOCK_BUSY), stack.lockFile, ...argv], cwd: context.repo, env: context.env, timeoutMs, maxOutputBytes: 64 * 1024 });
      if (r.exitCode === FLOCK_BUSY && r.status === 'failed') return null;
      return { ok: r.status === 'passed', output: `${r.stdout}\n${r.stderr}`.trim().slice(-4000) || `(${r.status}, code ${r.exitCode ?? '-'})` };
    }
    return await runStackCommand(context.repo, argv, timeoutMs, context.env);
  } finally {
    for (const release of held.reverse()) { try { await release(); } catch { /* expires with its lease */ } }
  }
}

/**
 * One pass of `apv stacks idle-stop`: observes each stack, and stops those free for at least `afterMs` (the stack's
 * `idleAfterMs`, else the option, else 30 min) and not already stopped since their last use. Every decision is journaled.
 */
export async function idlePass(stacks: readonly ResolvedStack[], context: ProbeContext, options: { afterMs?: number; dryRun: boolean; now?: number }): Promise<IdleDecision[]> {
  const out: IdleDecision[] = [];
  for (const stack of stacks) {
    const seen = observe(stack, context, options.now ?? Date.now());
    const after = options.afterMs ?? stack.config.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
    const r = seen.record;
    const kept = (reason: string): void => { out.push({ id: stack.id, action: 'kept', idleMs: seen.idleMs, reason }); };
    if (seen.busy.length) { kept(`occupée : ${seen.busy.join(' ; ')}`); continue; }
    if (!stack.config.stop) { kept('aucune commande stop déclarée'); continue; }
    const stoppedAt = r.stoppedAt ? Date.parse(r.stoppedAt) : 0;
    const lastStart = Math.max(r.lastUsedAt ? Date.parse(r.lastUsedAt) : 0, r.startedAt ? Date.parse(r.startedAt) : 0);
    if (stoppedAt && stoppedAt >= lastStart) { kept(`déjà arrêtée le ${r.stoppedAt} (aucune utilisation connue depuis)`); continue; }
    if (seen.idleMs < after) { kept(`libre depuis ${minutes(seen.idleMs)} d'observations suivies (seuil ${minutes(after)})`); continue; }
    if (options.dryRun) { out.push({ id: stack.id, action: 'would-stop', idleMs: seen.idleMs }); continue; }
    let result: { ok: boolean; output: string } | null;
    try { result = await underStackLock(stack, context, stack.config.stop, 'idle-stop'); }
    catch (error) { result = { ok: false, output: errorMessage(error) }; }
    if (result === null) {
      writeRecord(context.common, { ...readRecord(context.common, stack.id), lastUsedAt: new Date().toISOString(), freeSince: null });
      kept('verrou de la pile ou file des suites pris entre-temps : pile en usage, non arrêtée');
      journal(context.common, { event: 'kept', stack: stack.id, reason: 'verrou pris au moment de l\'arrêt' });
      continue;
    }
    if (result.ok) writeRecord(context.common, { ...readRecord(context.common, stack.id), stoppedAt: new Date().toISOString(), freeSince: null });
    out.push({ id: stack.id, action: result.ok ? 'stopped' : 'failed', idleMs: seen.idleMs, output: result.output });
    journal(context.common, { event: result.ok ? 'stopped' : 'stop-failed', stack: stack.id, idleMs: seen.idleMs, command: stack.config.stop, output: result.output.slice(-1000) });
  }
  return out;
}
