import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync, } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
let lastEnqueueMs = 0;
let enqueueSeq = 0;
const MUTEX_STALE_MS = 10_000;
const MUTEX_WAIT_MS = 30_000;
const LOG_MAX_BYTES = 1_000_000;
export function defaultLockDir(env) {
    if (env.APV_LOCK_DIR)
        return env.APV_LOCK_DIR;
    const state = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state');
    return join(state, 'apv', 'locks');
}
/** Maps a resource name to a safe file name. Distinct names may share a lock after sanitizing (safe side). */
export function sanitizeResource(resource) {
    const trimmed = resource.trim();
    if (!trimmed)
        throw new Error('nom de ressource vide');
    const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, (dots) => '_'.repeat(dots.length)).slice(0, 120);
    return safe;
}
/** Parses `900`, `900s`, `15m`, `2h` into seconds. */
export function parseDuration(value, name) {
    const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(value.trim());
    if (!match)
        throw new Error(`durée invalide pour ${name} : « ${value} » (exemples : 900, 15m, 2h)`);
    const factor = match[2] === 'h' ? 3600 : match[2] === 'm' ? 60 : 1;
    return Number(match[1]) * factor;
}
export function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return true;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
function errnoCode(error) {
    return error?.code;
}
function isOwner(value) {
    if (!value || typeof value !== 'object')
        return false;
    const owner = value;
    return (owner.pid === null || typeof owner.pid === 'number') && typeof owner.host === 'string' && typeof owner.label === 'string';
}
export function parseRecord(raw) {
    try {
        const value = JSON.parse(raw);
        if (typeof value.resource !== 'string' || typeof value.token !== 'string' || !isOwner(value.owner))
            return null;
        for (const key of ['acquiredAt', 'expiresAt', 'heartbeatAt']) {
            if (typeof value[key] !== 'string' || Number.isNaN(Date.parse(value[key])))
                return null;
        }
        return value;
    }
    catch {
        return null;
    }
}
export class LockStore {
    dir;
    host;
    pollMs;
    waiterStaleMs;
    initGraceMs;
    constructor(dir, options = {}) {
        this.dir = dir;
        this.host = options.host ?? hostname();
        this.pollMs = Math.max(10, options.pollMs ?? 500);
        this.waiterStaleMs = options.waiterStaleMs ?? Math.max(15_000, this.pollMs * 10);
        this.initGraceMs = options.initGraceMs ?? 10_000;
        mkdirSync(dir, { recursive: true });
    }
    lockPath(resource) { return join(this.dir, `${sanitizeResource(resource)}.lock`); }
    queueDir(resource) { return join(this.dir, `${sanitizeResource(resource)}.queue`); }
    mutexPath(resource) { return join(this.dir, `${sanitizeResource(resource)}.mutex`); }
    get logPath() { return join(this.dir, 'events.log'); }
    /** Appends one JSON line to the audit log (takeovers, forced releases, pruned waiters). */
    log(entry) {
        try {
            try {
                if (statSync(this.logPath).size > LOG_MAX_BYTES)
                    renameSync(this.logPath, `${this.logPath}.1`);
            }
            catch { /* no log yet */ }
            appendFileSync(this.logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
        }
        catch { /* the audit log never breaks a lock operation */ }
    }
    read(resource) {
        const path = this.lockPath(resource);
        try {
            const raw = readFileSync(path, 'utf8');
            const mtimeMs = statSync(path).mtimeMs;
            return { exists: true, raw, record: parseRecord(raw), mtimeMs };
        }
        catch (error) {
            if (errnoCode(error) === 'ENOENT')
                return { exists: false, raw: '', record: null, mtimeMs: 0 };
            throw error;
        }
    }
    /** Stale when expired, when the owner process is gone on this host, or unreadable past the grace period. */
    staleness(snapshot, now = Date.now()) {
        if (!snapshot.exists)
            return null;
        const record = snapshot.record;
        if (!record)
            return now - snapshot.mtimeMs > this.initGraceMs ? 'corrupt' : null;
        if (Date.parse(record.expiresAt) <= now)
            return 'expired';
        if (record.owner.host === this.host && record.owner.pid !== null && !isPidAlive(record.owner.pid))
            return 'owner_dead';
        return null;
    }
    /** Short critical section shared by every writer that removes or rewrites an existing lock file. */
    async withMutex(resource, fn) {
        const path = this.mutexPath(resource);
        const deadline = Date.now() + MUTEX_WAIT_MS;
        for (;;) {
            try {
                mkdirSync(path);
                break;
            }
            catch (error) {
                if (errnoCode(error) !== 'EEXIST')
                    throw error;
                try {
                    if (Date.now() - statSync(path).mtimeMs > MUTEX_STALE_MS) {
                        rmdirSync(path);
                        this.log({ event: 'mutex_broken', resource });
                        continue;
                    }
                }
                catch { /* removed meanwhile */ }
                if (Date.now() > deadline)
                    throw new Error(`section critique du verrou « ${resource} » bloquée depuis plus de ${MUTEX_WAIT_MS / 1000} s`);
                await sleep(5 + Math.random() * 20);
            }
        }
        try {
            return fn();
        }
        finally {
            try {
                rmdirSync(path);
            }
            catch { /* already broken by another process */ }
        }
    }
    /** One attempt, no queue. Takes over a stale lock (logged) before trying an exclusive create. */
    async tryAcquire(resource, owner, ttlSeconds, purpose = '') {
        const current = this.read(resource);
        let takeover = null;
        if (current.exists) {
            const reason = this.staleness(current);
            if (!reason)
                return { ok: false, holder: current.record, timedOut: false, aborted: false, position: 0 };
            const removed = await this.withMutex(resource, () => {
                const again = this.read(resource);
                if (!again.exists || again.raw !== current.raw)
                    return false;
                unlinkSync(this.lockPath(resource));
                return true;
            });
            if (removed) {
                takeover = { reason, previous: current.record };
                this.log({ event: 'takeover', resource, reason, previous: current.record, by: owner });
            }
        }
        const now = Date.now();
        const record = {
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
        let fd;
        try {
            fd = openSync(this.lockPath(resource), 'wx', 0o644);
        }
        catch (error) {
            if (errnoCode(error) === 'EEXIST')
                return { ok: false, holder: this.read(resource).record, timedOut: false, aborted: false, position: 0 };
            throw error;
        }
        try {
            writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        this.log({ event: 'acquire', resource, owner, expiresAt: record.expiresAt });
        return { ok: true, record, takeover };
    }
    /** Extends the lease. Returns false when the lock is no longer ours (taken over or force released). */
    async renew(resource, token, ttlSeconds) {
        return this.withMutex(resource, () => {
            const current = this.read(resource);
            if (!current.record || current.record.token !== token)
                return false;
            const now = Date.now();
            const next = {
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
    async release(resource, options = {}) {
        const result = await this.withMutex(resource, () => {
            const current = this.read(resource);
            if (!current.exists)
                return { status: 'not_held' };
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
        if (result.status === 'released')
            this.log({ event: 'release', resource, owner: result.previous?.owner ?? null });
        if (result.status === 'forced')
            this.log({ event: 'force_release', resource, reason: options.reason ?? '', previous: result.previous });
        return result;
    }
    enqueue(resource, owner) {
        const dir = this.queueDir(resource);
        mkdirSync(dir, { recursive: true });
        // Wall clock, shared by every process: performance.timeOrigin is estimated per process and may be off by a
        // few milliseconds, which let a later waiter sort before an earlier one (FIFO test failing intermittently).
        // Within one process, the monotonic clock breaks ties so that successive tickets keep their order.
        const now = Date.now();
        const micros = now * 1000 + (now === lastEnqueueMs ? ++enqueueSeq : (enqueueSeq = 0));
        lastEnqueueMs = now;
        const file = `${String(micros).padStart(17, '0')}-${process.pid}-${randomBytes(3).toString('hex')}.json`;
        writeFileSync(join(dir, file), `${JSON.stringify({ owner, enqueuedAt: new Date().toISOString() })}\n`, { flag: 'wx' });
        return join(dir, file);
    }
    /** Refreshes a waiter ticket. False when it was pruned (the caller must enqueue again). */
    touch(ticket) {
        try {
            const now = new Date();
            utimesSync(ticket, now, now);
            return true;
        }
        catch (error) {
            if (errnoCode(error) === 'ENOENT')
                return false;
            throw error;
        }
    }
    dequeue(ticket) {
        try {
            unlinkSync(ticket);
        }
        catch { /* already gone */ }
    }
    /** Live waiters in FIFO order. Tickets of dead processes or that stopped refreshing are removed. */
    waiters(resource) {
        const dir = this.queueDir(resource);
        let files;
        try {
            files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
        }
        catch (error) {
            if (errnoCode(error) === 'ENOENT')
                return [];
            throw error;
        }
        const live = [];
        const now = Date.now();
        // The holder's own ticket survives its acquisition for an instant (the lock is written, then the ticket
        // removed): it is not a waiter, and counting it put a new holder at the head of its own queue.
        const holder = this.read(resource).record?.owner ?? null;
        for (const file of files) {
            const path = join(dir, file);
            let owner = null;
            let enqueuedAt = '';
            let mtimeMs;
            try {
                const parsed = JSON.parse(readFileSync(path, 'utf8'));
                if (isOwner(parsed.owner))
                    owner = parsed.owner;
                if (typeof parsed.enqueuedAt === 'string')
                    enqueuedAt = parsed.enqueuedAt;
                mtimeMs = statSync(path).mtimeMs;
            }
            catch (error) {
                if (errnoCode(error) === 'ENOENT')
                    continue;
                mtimeMs = 0;
            }
            const dead = owner !== null && owner.pid !== null && owner.host === this.host && !isPidAlive(owner.pid);
            if (!owner || dead || now - mtimeMs > this.waiterStaleMs) {
                this.dequeue(path);
                this.log({ event: 'stale_waiter_removed', resource, owner, reason: dead ? 'owner_dead' : owner ? 'no_heartbeat' : 'corrupt' });
                continue;
            }
            if (holder && owner.pid === holder.pid && owner.host === holder.host && owner.label === holder.label)
                continue;
            live.push({ file, owner, enqueuedAt });
        }
        return live;
    }
    /** Waits in the FIFO queue until the lock is ours, `waitSeconds` elapse, or `signal` aborts. */
    async acquire(resource, options) {
        let ticket = this.enqueue(resource, options.owner);
        const deadline = Date.now() + options.waitSeconds * 1000;
        let holder = null;
        let position = 0;
        try {
            for (;;) {
                if (options.signal?.aborted)
                    return { ok: false, holder, timedOut: false, aborted: true, position };
                if (!this.touch(ticket)) {
                    ticket = this.enqueue(resource, options.owner);
                    options.onRequeue?.();
                }
                const queue = this.waiters(resource);
                const index = queue.findIndex((waiter) => waiter.file === basename(ticket));
                position = index + 1;
                if (index === 0) {
                    const attempt = await this.tryAcquire(resource, options.owner, options.ttlSeconds, options.purpose ?? '');
                    if (attempt.ok)
                        return attempt;
                    holder = attempt.holder;
                }
                else {
                    holder = this.read(resource).record;
                }
                options.onWait?.({ holder, position, queueLength: queue.length });
                const remaining = deadline - Date.now();
                if (remaining <= 0)
                    return { ok: false, holder, timedOut: true, aborted: false, position };
                const delay = Math.min(remaining, this.pollMs * (0.5 + Math.random()));
                try {
                    await sleep(delay, undefined, options.signal ? { signal: options.signal } : {});
                }
                catch {
                    return { ok: false, holder, timedOut: false, aborted: true, position };
                }
            }
        }
        finally {
            this.dequeue(ticket);
        }
    }
    /** Every lock and queue present in the directory. */
    list() {
        const names = new Set();
        for (const entry of readdirSync(this.dir)) {
            const match = /^(.+)\.(lock|queue)$/.exec(entry);
            if (match?.[1])
                names.add(match[1]);
        }
        const rows = [];
        for (const name of [...names].sort()) {
            const snapshot = this.read(name);
            const waiters = this.waiters(name);
            if (!snapshot.exists && waiters.length === 0)
                continue;
            rows.push({ resource: snapshot.record?.resource ?? name, snapshot, stale: this.staleness(snapshot), waiters });
        }
        return rows;
    }
}
//# sourceMappingURL=store.js.map