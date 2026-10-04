import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SuiteQueueSettings } from '../config/load.js';
import type { Gate } from '../domain/contracts.js';
import { canonicalPath } from '../domain/paths.js';
import { PipelineError, errorMessage, invariant } from '../domain/errors.js';
import { describeHolder, waitReporter } from '../lock/run.js';
import { LockStore, defaultLockDir, type LockRecord } from '../lock/store.js';
import type { Git } from '../execution/git.js';
import type { ResolvedStack, StackContainer } from '../stacks/idle.js';
import {
  assertProcSupported, listProcesses, protectedTool, repositoryWorktrees, sessionPids, stopProcesses, stopRefusal,
  type ProcessInfo, type StopOutcome, type StopRefusal,
} from '../execution/procs.js';

/**
 * The full suite of `apv gates run` (docs/APV3-SPEC.md, section 17): the machine queue taken before its first check,
 * the load threshold, the ports freed from orphans of the same copy, and the locks of the checks that share a
 * resource with other copies (a test stack). Every wait happens before the timeout of a check starts.
 */

/** Lease of a lock held by apv itself: renewed every third, lost within this delay when apv dies without releasing. */
export const LEASE_TTL_SECONDS = 120;

/** What tests inject: the load average and the polling delays. */
export interface SuiteHooks {
  /** 1-minute load average; default `os.loadavg()[0]`. */
  loadAverage?: () => number;
  /** Delay between two readings of the load (default 15 s). */
  loadPollMs?: number;
  /** Polling of the lock queues (default: that of `apv lock`, 500 ms). */
  lockPollMs?: number;
  /** Delay between two readings of the ports of the suite held by another copy of the repository (default 5 s). */
  portsPollMs?: number;
  /** Tests only: the duration the near-timeout warning reads for a check, in place of the measured one (the receipt keeps the measure). */
  durationOf?: (gateId: string, measuredMs: number) => number;
  /** Tests only: the containers of a stack, in place of `docker ps -a` (read before the checks, and after a check interrupted under its lock). */
  stackContainers?: (stack: ResolvedStack) => Promise<{ containers: StackContainer[] } | { error: string }>;
}

export interface QueueRecord {
  lockFile: string;
  /** Time spent in the queue before holding its places. */
  waitedMs: number;
  /** Who held a place when the run arrived, when it had to wait. */
  heldBy: string | null;
  /** The load threshold, when `maxLoad` is set. */
  load: { max: number; atStart: number; waitedMs: number; exceeded: boolean } | null;
  /** `suite.queue.slots` of the run. */
  slots?: SuiteQueueSettings['slots'];
  /** The places of the queue held, in the order they were taken: the whole queue, a numbered place, the place of each stack. */
  places?: string[];
}
export interface QueueHandle { record: QueueRecord; release(): Promise<void> }

const seconds = (ms: number): string => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

/** A path of the configuration: absolute as is, else relative to the Git common directory of `repo`. */
export async function commonPath(git: Git, repo: string, path: string): Promise<string> {
  if (isAbsolute(path)) return path;
  const out = (await git.exec(repo, ['rev-parse', '--git-common-dir'])).trim();
  invariant(out.length > 0, 'GIT', 'git rev-parse --git-common-dir returned nothing');
  return resolve(isAbsolute(out) ? out : resolve(repo, out), path);
}

/** The place of a test stack in the queue `resource`: held by every full suite that uses the stack. */
export const stackPlace = (resource: string, stack: string): string => `${resource}-stack-${stack.replace(/[^A-Za-z0-9._-]/g, '_')}`;
/**
 * The place of a copy (a worktree, by its canonical path) in the queue `resource`: held by every full suite run there,
 * before any other place, so that two suites never run in the same copy (they would share node_modules and the build
 * folders, and each would stop the servers of the other as orphans of the copy), whatever `slots`.
 */
export const copyPlace = (resource: string, copy: string): string => `${resource}-copy-${createHash('sha256').update(canonicalPath(copy)).digest('hex').slice(0, 16)}`;
/** The numbered place `k` (1 to N) of the queue `resource` with `slots: N`. */
export const slotPlace = (resource: string, k: number): string => `${resource}-slot-${k}`;

/**
 * What a run takes in the queue (docs/SHIFT-LEFT.md, section 13), always in this order so that two runs never wait for
 * each other in a cycle: the place of its copy (a full suite, `enterQueue` `copy`), the whole queue, then a numbered
 * place (or every one, `all`), then the place of each stack, sorted. Every full suite holds the place of each stack it uses: two suites never share a stack, whatever `slots`.
 * - `slots: 1` (default): the whole queue too, one suite at a time as before;
 * - `per-stack`: the places of its stacks only; a suite that uses no declared stack takes the whole queue;
 * - a number N: one of N numbered places, then those of its stacks.
 * A check whose lock is no declared stack (`unmapped`) might share a stack the tool cannot name: the whole queue and the
 * place of every declared stack. `all` (a Lighthouse measure, which no suite may run beside): every place.
 */
export interface QueuePlaces { whole: boolean; slots: 'none' | 'one' | 'all'; stacks: string[] }
export function queuePlaces(slots: SuiteQueueSettings['slots'], options: { used: readonly string[]; declared: readonly string[]; unmapped?: boolean; all?: boolean }): QueuePlaces {
  const sorted = (ids: readonly string[]): string[] => [...new Set(ids)].sort();
  const numbered = typeof slots === 'number' && slots > 1;
  if (options.all) return { whole: true, slots: numbered ? 'all' : 'none', stacks: sorted(options.declared) };
  if (options.unmapped) return { whole: true, slots: numbered ? 'one' : 'none', stacks: sorted(options.declared) };
  return { whole: slots === 1 || (slots === 'per-stack' && options.used.length === 0), slots: numbered ? 'one' : 'none', stacks: sorted(options.used) };
}

/** Keeps a lease held by apv until the returned release: renewed every third of its life, released once. */
function keepLease(store: LockStore, resource: string, token: string, log: (line: string) => void): () => Promise<void> {
  const heartbeat = setInterval(() => {
    store.renew(resource, token, LEASE_TTL_SECONDS).then(ok => { if (!ok) log(`Attention : le verrou « ${resource} » n'est plus à nous (repris ou libéré de force).`); },
      (error: unknown) => log(`Renouvellement du verrou « ${resource} » en échec : ${errorMessage(error)}`));
  }, (LEASE_TTL_SECONDS * 1000) / 3);
  heartbeat.unref();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    try { await store.release(resource, { token }); }
    catch (error) { log(`Libération du verrou « ${resource} » en échec : ${errorMessage(error)}`); }
  };
}

type Lease = { ok: true; resource: string; waitedMs: number; heldBy: LockRecord | null; release(): Promise<void> } | { ok: false; waitedMs: number; reason: string; aborted: boolean };
interface LeaseOptions { label: string; waitMs: number; purpose: string; signal?: AbortSignal | undefined; log: (line: string) => void }

/** A lease of the `apv lock` store held until `release`, renewed meanwhile. */
async function holdLease(store: LockStore, resource: string, options: LeaseOptions): Promise<Lease> {
  const started = Date.now();
  const before = store.read(resource).record;
  const result = await store.acquire(resource, {
    owner: { pid: process.pid, host: store.host, label: options.label }, ttlSeconds: LEASE_TTL_SECONDS, waitSeconds: options.waitMs / 1000,
    purpose: options.purpose, ...(options.signal ? { signal: options.signal } : {}),
    onWait: waitReporter(resource, s => options.log(s.trimEnd())),
    onRequeue: () => options.log(`Ticket d'attente de « ${resource} » perdu (processus suspendu ?) : remis en fin de file.`),
  });
  const waitedMs = Date.now() - started;
  if (!result.ok) {
    return { ok: false, waitedMs, aborted: result.aborted,
      reason: result.aborted ? `attente du verrou « ${resource} » annulée` : `verrou « ${resource} » non obtenu après ${seconds(waitedMs)} : tenu par ${describeHolder(result.holder)}` };
  }
  if (result.takeover) options.log(`Verrou « ${resource} » repris (${result.takeover.reason}) à ${describeHolder(result.takeover.previous)}.`);
  return { ok: true, resource, waitedMs, heldBy: waitedMs > 1000 ? before : null, release: keepLease(store, resource, result.record.token, options.log) };
}

/**
 * The first free of the numbered places `resources`, read again every `pollMs` until one is free or `waitMs` elapses
 * (no order among the runs that wait: each takes the first place it finds free).
 */
async function holdAnyLease(store: LockStore, resources: readonly string[], options: LeaseOptions & { pollMs: number }): Promise<Lease> {
  const started = Date.now();
  const owner = { pid: process.pid, host: store.host, label: options.label };
  const cancelled = (): Lease => ({ ok: false, waitedMs: Date.now() - started, aborted: true, reason: 'attente d\'une place de la file annulée' });
  let first: LockRecord | null = null;
  let said = 0;
  for (;;) {
    if (options.signal?.aborted) return cancelled();
    const holders: (LockRecord | null)[] = [];
    for (const resource of resources) {
      const r = await store.tryAcquire(resource, owner, LEASE_TTL_SECONDS, options.purpose);
      if (r.ok) {
        if (r.takeover) options.log(`Verrou « ${resource} » repris (${r.takeover.reason}) à ${describeHolder(r.takeover.previous)}.`);
        const waitedMs = Date.now() - started;
        return { ok: true, resource, waitedMs, heldBy: waitedMs > 1000 ? first : null, release: keepLease(store, resource, r.record.token, options.log) };
      }
      holders.push(r.holder);
    }
    first ??= holders[0] ?? null;
    const waited = Date.now() - started;
    const who = holders.map(h => describeHolder(h)).join(' ; ');
    if (waited >= options.waitMs) return { ok: false, waitedMs: waited, aborted: false, reason: `aucune des ${resources.length} places de la file libre après ${seconds(waited)} : tenues par ${who}` };
    if (said === 0 || Date.now() - said >= 60_000) {
      options.log(`Les ${resources.length} places de la file des suites complètes sont prises (${who}) : attente d'une place libre, au plus ${seconds(options.waitMs - waited)}.`);
      said = Date.now();
    }
    try { await sleep(Math.min(options.pollMs, Math.max(1, options.waitMs - waited)), undefined, options.signal ? { signal: options.signal } : {}); }
    catch { return cancelled(); }
  }
}

/**
 * Enters the queue of the full suites: its places (`queuePlaces`, leases of the `apv lock` store format beside
 * `settings.lockFile`: FIFO for the whole queue and each stack, the first free for a numbered place), within `waitMs` in
 * all; then, places held, the wait for the 1-minute load to drop under `maxLoad` (at most `loadWaitMs`, then the suite
 * starts anyway, noted). A place not obtained in time is a refusal (`SUITE_QUEUE`): the places taken are released,
 * nothing has run.
 */
export async function enterQueue(options: { lockFile: string; settings: SuiteQueueSettings; repo: string; log: (line: string) => void; signal?: AbortSignal | undefined; hooks?: SuiteHooks | undefined;
  /** Who waits (`apv gates run` by default) and why: shown to the other runs of the queue. */
  label?: string; purpose?: string;
  /** The places to take; absent: the whole queue alone. */
  places?: QueuePlaces;
  /** The copy the run works in (a full suite): its place (`copyPlace`) is taken first. */
  copy?: string }): Promise<QueueHandle> {
  const { settings, log } = options;
  const dir = dirname(options.lockFile);
  const resource = basename(options.lockFile).replace(/\.lock$/, '');
  const store = new LockStore(dir, options.hooks?.lockPollMs !== undefined ? { pollMs: options.hooks.lockPollMs } : {});
  const places = options.places ?? { whole: true, slots: 'none', stacks: [] };
  const n = typeof settings.slots === 'number' ? settings.slots : 1;
  const numbered = Array.from({ length: n }, (_, i) => slotPlace(resource, i + 1));
  const steps: string[][] = [
    ...(options.copy !== undefined ? [[copyPlace(resource, options.copy)]] : []),
    ...(places.whole ? [[resource]] : []),
    ...(places.slots === 'one' ? [numbered] : places.slots === 'all' ? numbered.map(r => [r]) : []),
    ...places.stacks.map(id => [stackPlace(resource, id)]),
  ];
  const label = options.label ?? `apv gates run (${options.repo})`;
  const purpose = options.purpose ?? 'suite complète';
  const started = Date.now();
  const held: { resource: string; release(): Promise<void> }[] = [];
  let heldBy: LockRecord | null = null;
  const releaseAll = async (): Promise<void> => { for (const lease of [...held].reverse()) await lease.release(); };
  for (const step of steps) {
    const leaseOptions = { label, waitMs: Math.max(0, settings.waitMs - (Date.now() - started)), purpose, signal: options.signal, log };
    const lease = step.length === 1 ? await holdLease(store, step[0]!, leaseOptions)
      : await holdAnyLease(store, step, { ...leaseOptions, pollMs: options.hooks?.lockPollMs ?? 500 });
    if (!lease.ok) {
      await releaseAll();
      if (lease.aborted) throw new PipelineError('CANCELLED', `File des suites complètes : ${lease.reason}`);
      throw new PipelineError('SUITE_QUEUE', `File des suites complètes (${options.lockFile}) : ${lease.reason}. Rien n'a été exécuté. ` +
        'Relancer plus tard, ou voir le détenteur : apv lock status --dir ' + dir);
    }
    heldBy ??= lease.heldBy;
    held.push(lease);
  }
  const waitedMs = Date.now() - started;
  if (waitedMs > 1000) log(`File des suites complètes : ${held.length > 1 ? `places obtenues (${held.map(h => h.resource).join(', ')})` : 'verrou obtenu'} après ${seconds(waitedMs)}.`);
  const record: QueueRecord = { lockFile: options.lockFile, waitedMs, heldBy: heldBy ? describeHolder(heldBy) : null, load: null, slots: settings.slots, places: held.map(h => h.resource) };
  try {
    if (settings.maxLoad !== undefined) record.load = await waitForLoad(settings.maxLoad, settings.loadWaitMs, log, options.signal, options.hooks);
  } catch (error) { await releaseAll(); throw error; }
  return { record, release: releaseAll };
}

/** Waits for the 1-minute load average to drop under `max`, at most `limitMs`; journaled at most every minute. */
export async function waitForLoad(max: number, limitMs: number, log: (line: string) => void, signal?: AbortSignal, hooks?: SuiteHooks,
  /** What waits: `suite` starts anyway past the limit (never blocked forever); `measure` (a Lighthouse audit) is refused by its caller. */
  subject: 'suite' | 'measure' = 'suite'):
  Promise<{ max: number; atStart: number; waitedMs: number; exceeded: boolean }> {
  const read = hooks?.loadAverage ?? (() => loadavg()[0] ?? 0);
  const poll = hooks?.loadPollMs ?? 15_000;
  const started = Date.now();
  let load = read();
  let lastLog = 0;
  while (load >= max) {
    const waited = Date.now() - started;
    if (waited >= limitMs) {
      log(`Charge moyenne sur 1 min encore à ${load.toFixed(2)} (seuil ${max}) après ${seconds(waited)} : ${subject === 'suite' ? 'la suite démarre quand même' : 'mesure refusée (une mesure sous charge fausse la performance)'}.`);
      return { max, atStart: load, waitedMs: waited, exceeded: true };
    }
    if (lastLog === 0 || Date.now() - lastLog >= 60_000) {
      log(`Charge moyenne sur 1 min à ${load.toFixed(2)}, seuil ${max} : démarrage différé (attente ${seconds(waited)}, au plus ${seconds(limitMs)}).`);
      lastLog = Date.now();
    }
    try { await sleep(Math.min(poll, Math.max(1, limitMs - waited)), undefined, signal ? { signal } : {}); }
    catch { throw new PipelineError('CANCELLED', 'Attente de la charge annulée'); }
    load = read();
  }
  const waitedMs = Date.now() - started;
  if (waitedMs > 1000) log(`Charge moyenne sur 1 min à ${load.toFixed(2)}, sous le seuil ${max} : ${subject === 'suite' ? 'la suite démarre' : 'la mesure démarre'} (attente ${seconds(waitedMs)}).`);
  return { max, atStart: load, waitedMs, exceeded: false };
}

export interface PortProcess { pid: number; ports: number[]; command: string; worktree: string | null }
export interface PortsRecord {
  ports: number[];
  /** Orphans of this copy stopped, with the outcome of `apv procs stop`. */
  stopped: (PortProcess & { outcome: StopOutcome })[];
  /** Processes on these ports left running, with the reason (another copy, the main checkout, a protected tool...). */
  left: (PortProcess & { reason: StopRefusal })[];
  /** Why nothing could be read (a system without /proc), else null. */
  unsupported: string | null;
  /**
   * The wait for ports held by another copy of this repository (a review, a dynamic scan, another suite; src/gates/run.ts):
   * how long, who held them at the start, and how it ended (`freed`: the suite starts; `timeout`: the lock delay ran out,
   * refused; `foreign`: a process outside a copy of the repository took a port meanwhile, refused). Null without a wait.
   */
  wait: { ms: number; holders: PortProcess[]; outcome: 'freed' | 'timeout' | 'foreign' } | null;
}

/**
 * Frees the declared ports from the orphans of the copy `repo` (a linked worktree): processes that listen there and
 * whose working directory is in that copy are stopped as `apv procs stop` does (SIGTERM, SIGKILL after the grace, a
 * reused pid spared). Never a process of another copy, of the main checkout, outside the repository, a protected tool
 * or the session: those are only reported.
 */
export async function freePorts(repo: string, ports: readonly number[], options: { graceMs?: number; log: (line: string) => void }): Promise<PortsRecord> {
  const record: PortsRecord = { ports: [...ports], stopped: [], left: [], unsupported: null, wait: null };
  if (!ports.length) return record;
  try { assertProcSupported(); }
  catch (error) { record.unsupported = errorMessage(error); options.log(`Ports de la suite non vérifiés : ${record.unsupported}`); return record; }
  const worktrees = repositoryWorktrees(repo);
  const copy = canonicalPath(repo);
  const all = listProcesses();
  const session = sessionPids(all);
  const targets = all.filter(p => !p.zombie && p.ports.some(port => ports.includes(port)));
  const stoppable = [];
  for (const info of targets) {
    const { worktree, refusal } = stopRefusal(info, { session, worktrees, copy });
    const entry = { pid: info.pid, ports: info.ports.filter(port => ports.includes(port)), command: info.command.slice(0, 300), worktree };
    if (refusal) record.left.push({ ...entry, reason: refusal });
    else stoppable.push({ info, entry });
  }
  if (stoppable.length) {
    const outcomes = await stopProcesses(stoppable.map(s => s.info), { graceMs: options.graceMs ?? 5000 });
    for (const { info, entry } of stoppable) record.stopped.push({ ...entry, outcome: outcomes.get(info.pid) ?? 'gone' });
  }
  for (const p of record.stopped) options.log(`Port ${p.ports.join(', ')} : orphelin de cette copie arrêté (pid ${p.pid}, ${p.outcome}) : ${p.command.slice(0, 120)}`);
  for (const p of record.left) options.log(`Port ${p.ports.join(', ')} : tenu par le pid ${p.pid} (${p.reason}${p.worktree ? `, ${p.worktree}` : ''}), non arrêté.`);
  return record;
}

/** Lock of a check (`lock` of the gate), resolved to its absolute place. */
export type GateLock =
  | { kind: 'lease'; resource: string; dir: string; waitMs: number }
  | { kind: 'flock'; file: string; waitMs: number };

/** Where the lock of a check lives: the `apv lock` store for a lease, the file (or its variable) for a flock. */
export async function resolveGateLock(git: Git, repo: string, lock: NonNullable<Gate['lock']>, env: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv): Promise<GateLock> {
  if ('resource' in lock) return { kind: 'lease', resource: lock.resource, dir: defaultLockDir(source), waitMs: lock.waitMs };
  const fromEnv = lock.fileEnv ? env[lock.fileEnv] : undefined;
  const file = fromEnv ? resolve(repo, fromEnv) : await commonPath(git, repo, lock.file);
  return { kind: 'flock', file, waitMs: lock.waitMs };
}

/**
 * Holds the lease of a check around `run`. Already held by an ancestor (`APV_LOCK_HELD` of the source environment,
 * as `apv lock run` sets it): not taken again. The command receives `APV_LOCK_HELD` with the resource, so that an
 * `apv lock run <resource>` inside it does not wait for its own parent.
 */
export async function withGateLease<T>(lock: Extract<GateLock, { kind: 'lease' }>, options: { label: string; env: NodeJS.ProcessEnv; source: NodeJS.ProcessEnv; signal?: AbortSignal | undefined; log: (line: string) => void; hooks?: SuiteHooks | undefined },
  run: (env: NodeJS.ProcessEnv, waitedMs: number) => Promise<T>, refused: (reason: string, waitedMs: number) => T): Promise<T> {
  const held = (options.source['APV_LOCK_HELD'] ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const env = { ...options.env, APV_LOCK_HELD: [...new Set([...held, lock.resource])].join(',') };
  if (held.includes(lock.resource)) return run(env, 0);
  mkdirSync(lock.dir, { recursive: true });
  const store = new LockStore(lock.dir, options.hooks?.lockPollMs !== undefined ? { pollMs: options.hooks.lockPollMs } : {});
  const lease = await holdLease(store, lock.resource, { label: options.label, waitMs: lock.waitMs, purpose: options.label, signal: options.signal, log: options.log });
  if (!lease.ok) return refused(lease.reason, lease.waitedMs);
  try { return await run(env, lease.waitedMs); }
  finally { await lease.release(); }
}

/** Exit code of `flock -E` when its wait expires. */
export const FLOCK_TIMEOUT_EXIT = 75;
/**
 * The command wrapped by `flock(1)`: the kernel lock of `file` is held by `flock`, an ancestor of the command (a
 * project script that proves the lock by an ancestor holder in `/proc/locks` sees it held); `sh` writes one byte on
 * fd 3 once the lock is held, then closes it and becomes the command (`runProcess` `waitReady`: the timeout starts
 * there).
 */
export function flockCommand(file: string, waitMs: number, command: readonly string[]): string[] {
  mkdirSync(join(file, '..'), { recursive: true });
  return ['flock', '-w', String(waitMs / 1000), '-E', String(FLOCK_TIMEOUT_EXIT), file, 'sh', '-c', 'printf 1 >&3 && exec 3>&- "$@"', 'apv-lock', ...command];
}

/** Variable that marks every command of a full suite: its processes, and those they start, are found by it at the end. */
export const SUITE_MARKER = 'APV_SUITE_RUN';

/** Processes of this user whose environment carries `<marker>=<runId>` (read in `/proc/<pid>/environ`), `APV_SUITE_RUN` by default. */
export function markedProcesses(runId: string, processes: readonly ProcessInfo[], root = '/proc', marker = SUITE_MARKER): ProcessInfo[] {
  const needle = `${marker}=${runId}`;
  return processes.filter(p => {
    if (p.zombie) return false;
    try { return readFileSync(join(root, String(p.pid), 'environ'), 'latin1').split('\0').includes(needle); }
    catch { return false; }
  });
}

export interface CleanupRecord {
  /** Processes started by the suite (its marker) still alive at its end, stopped. */
  stopped: (PortProcess & { outcome: StopOutcome })[];
  /** Marked processes left running: the session (never stopped). */
  left: (PortProcess & { reason: StopRefusal })[];
  /** Orphans of this copy on `suite.ports`, after the suite. */
  ports: PortsRecord | null;
  unsupported: string | null;
}

/**
 * The end of a full suite, whatever its outcome (docs/APV3-SPEC.md, section 18.4): the processes it started that are
 * still alive (a server that left the process group of its check) are stopped as `apv procs stop` does, then the
 * orphans of this copy on `suite.ports`. Never the session, a protected tool, another copy or the main checkout.
 */
export async function cleanupSuite(repo: string, runId: string, ports: readonly number[], options: { graceMs?: number; log: (line: string) => void }): Promise<CleanupRecord> {
  const record: CleanupRecord = { stopped: [], left: [], ports: null, unsupported: null };
  try { assertProcSupported(); }
  catch (error) { record.unsupported = errorMessage(error); options.log(`Fin de suite : processus non vérifiés (${record.unsupported}).`); return record; }
  const all = listProcesses();
  const session = sessionPids(all);
  const marked = markedProcesses(runId, all);
  const stoppable: ProcessInfo[] = [];
  for (const info of marked) {
    const entry = { pid: info.pid, ports: info.ports, command: info.command.slice(0, 300), worktree: null };
    if (session.has(info.pid) || protectedTool(info) !== null) record.left.push({ ...entry, reason: session.has(info.pid) ? 'protected' : 'tool' });
    else stoppable.push(info);
  }
  if (stoppable.length) {
    const outcomes = await stopProcesses(stoppable, { graceMs: options.graceMs ?? 5000 });
    for (const info of stoppable) record.stopped.push({ pid: info.pid, ports: info.ports, command: info.command.slice(0, 300), worktree: null, outcome: outcomes.get(info.pid) ?? 'gone' });
  }
  for (const p of record.stopped) options.log(`Fin de suite : processus lancé par la suite encore vivant, arrêté (pid ${p.pid}, ${p.outcome}${p.ports.length ? `, ports ${p.ports.join(', ')}` : ''}) : ${p.command.slice(0, 120)}`);
  if (ports.length) record.ports = await freePorts(repo, ports, { log: line => options.log(`Fin de suite : ${line}`), ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}) });
  return record;
}
