import {
  appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

/** Who holds (or waits for) a lock. `pid` null means the lease alone protects the lock. */
export interface LockOwner { pid: number | null; host: string; label: string }

export interface LockRecord {
  version: 1;
  resource: string;
  owner: LockOwner;
  token: string;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
  ttlSeconds: number;
  purpose: string;
}

export type StaleReason = 'expired' | 'owner_dead' | 'corrupt';

export interface LockSnapshot {
  exists: boolean;
  raw: string;
  record: LockRecord | null;
  mtimeMs: number;
}

export interface Waiter { file: string; owner: LockOwner; enqueuedAt: string }

export type AcquireResult =
  | { ok: true; record: LockRecord; takeover: { reason: StaleReason; previous: LockRecord | null } | null }
  | { ok: false; holder: LockRecord | null; timedOut: boolean; aborted: boolean; position: number };

export interface WaitInfo { holder: LockRecord | null; position: number; queueLength: number }

export type ReleaseResult =
  | { status: 'released' | 'forced'; previous: LockRecord | null }
  | { status: 'not_held' }
  | { status: 'refused'; holder: LockRecord | null };

export interface LockEvent { event: string; resource: string; [key: string]: unknown }

export interface LockStoreOptions {
  host?: string;
  /** Base polling interval in ms (jitter of plus or minus 50 % is applied). */
  pollMs?: number;
  /** Age after which a waiter ticket that stopped refreshing is removed. */
  waiterStaleMs?: number;
  /** Age after which an unreadable lock file (crash between create and write) is stale. */
  initGraceMs?: number;
}

const MUTEX_STALE_MS = 10_000;
const MUTEX_WAIT_MS = 30_000;
const LOG_MAX_BYTES = 1_000_000;

export function defaultLockDir(env: NodeJS.ProcessEnv): string {
  if (env.APV_LOCK_DIR) return env.APV_LOCK_DIR;
  const state = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state');
  return join(state, 'apv', 'locks');
}

/** Maps a resource name to a safe file name. Distinct names may share a lock after sanitizing (safe side). */
export function sanitizeResource(resource: string): string {
  const trimmed = resource.trim();
  if (!trimmed) throw new Error('nom de ressource vide');
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, (dots) => '_'.repeat(dots.length)).slice(0, 120);
  return safe;
}

/** Parses `900`, `900s`, `15m`, `2h` into seconds. */
export function parseDuration(value: string, name: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(value.trim());
  if (!match) throw new Error(`durée invalide pour ${name} : « ${value} » (exemples : 900, 15m, 2h)`);
  const factor = match[2] === 'h' ? 3600 : match[2] === 'm' ? 60 : 1;
  return Number(match[1]) * factor;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function isOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== 'object') return false;
  const owner = value as Record<string, unknown>;
  return (owner.pid === null || typeof owner.pid === 'number') && typeof owner.host === 'string' && typeof owner.label === 'string';
}

export function parseRecord(raw: string): LockRecord | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.resource !== 'string' || typeof value.token !== 'string' || !isOwner(value.owner)) return null;
    for (const key of ['acquiredAt', 'expiresAt', 'heartbeatAt'] as const) {
      if (typeof value[key] !== 'string' || Number.isNaN(Date.parse(value[key] as string))) return null;
    }
    return value as unknown as LockRecord;
  } catch {
    return null;
  }
}

export class LockStore {
  readonly dir: string;
  readonly host: string;
  readonly pollMs: number;
  readonly waiterStaleMs: number;
  readonly initGraceMs: number;

  constructor(dir: string, options: LockStoreOptions = {}) {
    this.dir = dir;
    this.host = options.host ?? hostname();
    this.pollMs = Math.max(10, options.pollMs ?? 500);
    this.waiterStaleMs = options.waiterStaleMs ?? Math.max(15_000, this.pollMs * 10);
    this.initGraceMs = options.initGraceMs ?? 10_000;
    mkdirSync(dir, { recursive: true });
  }

  lockPath(resource: string): string { return join(this.dir, `${sanitizeResource(resource)}.lock`); }
  queueDir(resource: string): string { return join(this.dir, `${sanitizeResource(resource)}.queue`); }
  private mutexPath(resource: string): string { return join(this.dir, `${sanitizeResource(resource)}.mutex`); }
  get logPath(): string { return join(this.dir, 'events.log'); }

  /** Appends one JSON line to the audit log (takeovers, forced releases, pruned waiters). */
  log(entry: LockEvent): void {
    try {
      try {
        if (statSync(this.logPath).size > LOG_MAX_BYTES) renameSync(this.logPath, `${this.logPath}.1`);
      } catch { /* no log yet */ }
      appendFileSync(this.logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    } catch { /* the audit log never breaks a lock operation */ }
  }

  read(resource: string): LockSnapshot {
    const path = this.lockPath(resource);
    try {
      const raw = readFileSync(path, 'utf8');
      const mtimeMs = statSync(path).mtimeMs;
      return { exists: true, raw, record: parseRecord(raw), mtimeMs };
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return { exists: false, raw: '', record: null, mtimeMs: 0 };
      throw error;
    }
  }

  /** Stale when expired, when the owner process is gone on this host, or unreadable past the grace period. */
  staleness(snapshot: LockSnapshot, now = Date.now()): StaleReason | null {
    if (!snapshot.exists) return null;
    const record = snapshot.record;
    if (!record) return now - snapshot.mtimeMs > this.initGraceMs ? 'corrupt' : null;
    if (Date.parse(record.expiresAt) <= now) return 'expired';
    if (record.owner.host === this.host && record.owner.pid !== null && !isPidAlive(record.owner.pid)) return 'owner_dead';
    return null;
  }

  /** Short critical section shared by every writer that removes or rewrites an existing lock file. */
  private async withMutex<T>(resource: string, fn: () => T): Promise<T> {
    const path = this.mutexPath(resource);
    const deadline = Date.now() + MUTEX_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(path);
        break;
      } catch (error) {
        if (errnoCode(error) !== 'EEXIST') throw error;
        try {
          if (Date.now() - statSync(path).mtimeMs > MUTEX_STALE_MS) {
            rmdirSync(path);
            this.log({ event: 'mutex_broken', resource });
            continue;
          }
        } catch { /* removed meanwhile */ }
        if (Date.now() > deadline) throw new Error(`section critique du verrou « ${resource} » bloquée depuis plus de ${MUTEX_WAIT_MS / 1000} s`);
        await sleep(5 + Math.random() * 20);
      }
    }
    try {
      return fn();
    } finally {
      try { rmdirSync(path); } catch { /* already broken by another process */ }
    }
  }

  /** One attempt, no queue. Takes over a stale lock (logged) before trying an exclusive create. */
  async tryAcquire(resource: string, owner: LockOwner, ttlSeconds: number, purpose = ''): Promise<AcquireResult> {
    const current = this.read(resource);
    let takeover: { reason: StaleReason; previous: LockRecord | null } | null = null;
    if (current.exists) {
      const reason = this.staleness(current);
      if (!reason) return { ok: false, holder: current.record, timedOut: false, aborted: false, position: 0 };
      const removed = await this.withMutex(resource, () => {
        const again = this.read(resource);
        if (!again.exists || again.raw !== current.raw) return false;
        unlinkSync(this.lockPath(resource));
        return true;
      });
      if (removed) {
        takeover = { reason, previous: current.record };
        this.log({ event: 'takeover', resource, reason, previous: current.record, by: owner });
      }
    }
    const now = Date.now();
    const record: LockRecord = {
      version: 1,
      resource,
      owner,
      token: randomBytes(12).toString('hex'),
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
      ttlSeconds,
      purpose,
    };
    let fd: number;
    try {
      fd = openSync(this.lockPath(resource), 'wx', 0o644);
    } catch (error) {
      if (errnoCode(error) === 'EEXIST') return { ok: false, holder: this.read(resource).record, timedOut: false, aborted: false, position: 0 };
      throw error;
    }
    try {
      writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.log({ event: 'acquire', resource, owner, expiresAt: record.expiresAt });
    return { ok: true, record, takeover };
  }

  /** Extends the lease. Returns false when the lock is no longer ours (taken over or force released). */
  async renew(resource: string, token: string, ttlSeconds: number): Promise<boolean> {
    return this.withMutex(resource, () => {
      const current = this.read(resource);
      if (!current.record || current.record.token !== token) return false;
      const now = Date.now();
      const next: LockRecord = {
        ...current.record,
        heartbeatAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
      };
      const tmp = `${this.lockPath(resource)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
      renameSync(tmp, this.lockPath(resource));
      return true;
    });
  }

  /** Only the owner (token, or same live pid on this host) may release, unless forced with a reason. */
  async release(resource: string, options: { token?: string; callerPids?: number[]; force?: boolean; reason?: string } = {}): Promise<ReleaseResult> {
    const result = await this.withMutex(resource, (): ReleaseResult => {
      const current = this.read(resource);
      if (!current.exists) return { status: 'not_held' };
      const record = current.record;
      const byToken = Boolean(options.token && record && record.token === options.token);
      const byPid = Boolean(record && record.owner.pid !== null && record.owner.host === this.host
        && (options.callerPids ?? []).includes(record.owner.pid));
      if (byToken || byPid) {
        unlinkSync(this.lockPath(resource));
        return { status: 'released', previous: record };
      }
      if (options.force) {
        unlinkSync(this.lockPath(resource));
        return { status: 'forced', previous: record };
      }
      return { status: 'refused', holder: record };
    });
    if (result.status === 'released') this.log({ event: 'release', resource, owner: result.previous?.owner ?? null });
    if (result.status === 'forced') this.log({ event: 'force_release', resource, reason: options.reason ?? '', previous: result.previous });
    return result;
  }

  enqueue(resource: string, owner: LockOwner): string {
    const dir = this.queueDir(resource);
    mkdirSync(dir, { recursive: true });
    const micros = Math.round((performance.timeOrigin + performance.now()) * 1000);
    const file = `${String(micros).padStart(17, '0')}-${process.pid}-${randomBytes(3).toString('hex')}.json`;
    writeFileSync(join(dir, file), `${JSON.stringify({ owner, enqueuedAt: new Date().toISOString() })}\n`, { flag: 'wx' });
    return join(dir, file);
  }

  /** Refreshes a waiter ticket. False when it was pruned (the caller must enqueue again). */
  touch(ticket: string): boolean {
    try {
      const now = new Date();
      utimesSync(ticket, now, now);
      return true;
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  dequeue(ticket: string): void {
    try { unlinkSync(ticket); } catch { /* already gone */ }
  }

  /** Live waiters in FIFO order. Tickets of dead processes or that stopped refreshing are removed. */
  waiters(resource: string): Waiter[] {
    const dir = this.queueDir(resource);
    let files: string[];
    try {
      files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return [];
      throw error;
    }
    const live: Waiter[] = [];
    const now = Date.now();
    for (const file of files) {
      const path = join(dir, file);
      let owner: LockOwner | null = null;
      let enqueuedAt = '';
      let mtimeMs: number;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { owner?: unknown; enqueuedAt?: unknown };
        if (isOwner(parsed.owner)) owner = parsed.owner;
        if (typeof parsed.enqueuedAt === 'string') enqueuedAt = parsed.enqueuedAt;
        mtimeMs = statSync(path).mtimeMs;
      } catch (error) {
        if (errnoCode(error) === 'ENOENT') continue;
        mtimeMs = 0;
      }
      const dead = owner !== null && owner.pid !== null && owner.host === this.host && !isPidAlive(owner.pid);
      if (!owner || dead || now - mtimeMs > this.waiterStaleMs) {
        this.dequeue(path);
        this.log({ event: 'stale_waiter_removed', resource, owner, reason: dead ? 'owner_dead' : owner ? 'no_heartbeat' : 'corrupt' });
        continue;
      }
      live.push({ file, owner, enqueuedAt });
    }
    return live;
  }

  /** Waits in the FIFO queue until the lock is ours, `waitSeconds` elapse, or `signal` aborts. */
  async acquire(resource: string, options: {
    owner: LockOwner;
    ttlSeconds: number;
    waitSeconds: number;
    purpose?: string;
    signal?: AbortSignal;
    onWait?: (info: WaitInfo) => void;
    onRequeue?: () => void;
  }): Promise<AcquireResult> {
    let ticket = this.enqueue(resource, options.owner);
    const deadline = Date.now() + options.waitSeconds * 1000;
    let holder: LockRecord | null = null;
    let position = 0;
    try {
      for (;;) {
        if (options.signal?.aborted) return { ok: false, holder, timedOut: false, aborted: true, position };
        if (!this.touch(ticket)) {
          ticket = this.enqueue(resource, options.owner);
          options.onRequeue?.();
        }
        const queue = this.waiters(resource);
        const index = queue.findIndex((waiter) => waiter.file === basename(ticket));
        position = index + 1;
        if (index === 0) {
          const attempt = await this.tryAcquire(resource, options.owner, options.ttlSeconds, options.purpose ?? '');
          if (attempt.ok) return attempt;
          holder = attempt.holder;
        } else {
          holder = this.read(resource).record;
        }
        options.onWait?.({ holder, position, queueLength: queue.length });
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { ok: false, holder, timedOut: true, aborted: false, position };
        const delay = Math.min(remaining, this.pollMs * (0.5 + Math.random()));
        try {
          await sleep(delay, undefined, options.signal ? { signal: options.signal } : {});
        } catch {
          return { ok: false, holder, timedOut: false, aborted: true, position };
        }
      }
    } finally {
      this.dequeue(ticket);
    }
  }

  /** Every lock and queue present in the directory. */
  list(): { resource: string; snapshot: LockSnapshot; stale: StaleReason | null; waiters: Waiter[] }[] {
    const names = new Set<string>();
    for (const entry of readdirSync(this.dir)) {
      const match = /^(.+)\.(lock|queue)$/.exec(entry);
      if (match?.[1]) names.add(match[1]);
    }
    const rows = [];
    for (const name of [...names].sort()) {
      const snapshot = this.read(name);
      const waiters = this.waiters(name);
      if (!snapshot.exists && waiters.length === 0) continue;
      rows.push({ resource: snapshot.record?.resource ?? name, snapshot, stale: this.staleness(snapshot), waiters });
    }
    return rows;
  }
}
