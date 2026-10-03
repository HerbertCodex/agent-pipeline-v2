import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { suiteSettings } from '../config/load.js';
import { errorMessage } from '../domain/errors.js';
import { listeningInodes, protectedPids } from '../execution/procs.js';
import { runProcess } from '../execution/process.js';
import { LockStore, defaultLockDir } from '../lock/store.js';
import { gitRead } from '../run/git-probe.js';
import { DEFAULT_IDLE_AFTER_MS, stackPath } from './config.js';
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
/** The Git common directory of `repo`, absolute. */
export function commonDir(repo) {
    const out = gitRead(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!out)
        throw new Error(`Pas un dépôt Git : ${repo}`);
    return out;
}
export function resolveStacks(config, common) {
    return (config.stacks ?? []).map(stack => ({
        config: stack, id: stack.id,
        lockFile: stack.lockFile ? stackPath(common, stack.lockFile) : null,
        resource: stack.resource ?? null,
        envFile: stack.envFile ? stackPath(common, stack.envFile) : null,
    }));
}
export const stacksDir = (common) => join(common, 'apv', 'stacks');
const recordPath = (common, id) => join(stacksDir(common), `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
export function readRecord(common, id) {
    const empty = { version: 1, id, lastObservedAt: null, lastUsedAt: null, freeSince: null, stoppedAt: null, startedAt: null, upAt: null };
    try {
        const raw = JSON.parse(readFileSync(recordPath(common, id), 'utf8'));
        const at = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
        return { ...empty, lastObservedAt: at(raw.lastObservedAt), lastUsedAt: at(raw.lastUsedAt), freeSince: at(raw.freeSince), stoppedAt: at(raw.stoppedAt), startedAt: at(raw.startedAt), upAt: at(raw.upAt) };
    }
    catch {
        return empty;
    }
}
export function writeRecord(common, record) {
    mkdirSync(stacksDir(common), { recursive: true });
    const file = recordPath(common, record.id);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, file);
}
/** Appends one decision to `<git common dir>/apv/stacks/events.log` (one JSON object per line, rotated at 1 MB). */
export function journal(common, entry) {
    try {
        mkdirSync(stacksDir(common), { recursive: true });
        const file = join(stacksDir(common), 'events.log');
        try {
            if (statSync(file).size > 1_000_000)
                renameSync(file, `${file}.1`);
        }
        catch { /* no log yet */ }
        appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    }
    catch { /* the journal never breaks a decision */ }
}
/** Notes a known use of the stacks (a check of `apv gates run` under their lock that just ended). */
export function markStacksUsed(common, ids, passed = false, at = new Date()) {
    for (const id of ids) {
        try {
            const record = readRecord(common, id);
            writeRecord(common, { ...record, lastUsedAt: at.toISOString(), freeSince: null, ...(passed ? { upAt: at.toISOString() } : {}) });
        }
        catch { /* a missing note only delays an idle stop */ }
    }
}
/** The stacks whose lock is the lock of this check (same flock file, or same lease resource). */
export function stacksOfLock(stacks, lock) {
    return stacks.filter(s => lock.kind === 'lease' ? s.resource === lock.resource : s.lockFile !== null && s.lockFile === lock.file).map(s => s.id);
}
/** Last event of `resource` in the journal of `apv lock` (its tail), or null. */
function lastLeaseEvent(dir, resource) {
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
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return null;
    }
    let last = null;
    for (const line of text.split('\n')) {
        if (!line.includes(resource))
            continue;
        try {
            const e = JSON.parse(line);
            const t = e.resource === resource && e.at ? Date.parse(e.at) : NaN;
            if (!Number.isNaN(t) && (last === null || t > last))
                last = t;
        }
        catch { /* a truncated first line */ }
    }
    return last;
}
/** The device of a `stat` (bigint) as `/proc/locks` prints it: major and minor numbers. */
function lockDevice(dev) {
    const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
    const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
    return [Number(major), Number(minor)];
}
/** Whether process `pid` holds `file` open (an entry of `/proc/<pid>/fd` leads to it). */
function holdsOpen(pid, file, procRoot) {
    let real;
    let fds;
    try {
        real = realpathSync(file);
        fds = readdirSync(join(procRoot, String(pid), 'fd'));
    }
    catch {
        return false;
    }
    return fds.some(fd => { try {
        return readlinkSync(join(procRoot, String(pid), 'fd', fd)) === real;
    }
    catch {
        return false;
    } });
}
/**
 * Whether a kernel lock (`flock`) on `file` is held by this process or one of its ancestors (read in `/proc/locks`):
 * a suite launched under the lock of its stack (`flock <lockFile> apv gates run ...`) holds it already. The lock is the
 * same inode on the same device; some file systems print another device there than `stat` gives (btrfs subvolumes), and
 * the same inode then counts when that ancestor holds the file open. Init (pid 1) is never counted. False when
 * unreadable (another system, file absent): the lock then counts as another's.
 */
export function flockHeldByAncestor(file, ancestors = protectedPids(), locksPath = '/proc/locks', procRoot = '/proc') {
    let locks;
    let inode;
    let device;
    try {
        locks = readFileSync(locksPath, 'utf8');
        const st = statSync(file, { bigint: true });
        inode = st.ino;
        device = lockDevice(st.dev);
    }
    catch {
        return false;
    }
    for (const line of locks.split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields[1] !== 'FLOCK' || fields[3] !== 'WRITE')
            continue;
        const pid = Number(fields[4]);
        const [major, minor, ino] = (fields[5] ?? '').split(':');
        if (!(pid > 1 && ancestors.has(pid)) || ino === undefined || !/^\d+$/.test(ino) || BigInt(ino) !== inode)
            continue;
        if ((parseInt(major, 16) === device[0] && parseInt(minor, 16) === device[1]) || holdsOpen(pid, file, procRoot))
            return true;
    }
    return false;
}
/** Whether the flock of `file` is free now: taken and released at once (`flock -n`). Null when unknown. */
export function flockFree(file) {
    if (!existsSync(file))
        return true;
    const r = spawnSync('flock', ['-n', '-E', String(FLOCK_BUSY), file, 'true'], { stdio: 'ignore', timeout: 10_000 });
    if (r.error || r.status === null)
        return null;
    return r.status === 0 ? true : r.status === FLOCK_BUSY ? false : null;
}
/** A lease of `apv lock` held by a live owner. */
function leaseHeld(store, resource) {
    const snapshot = store.read(resource);
    return snapshot.exists && store.staleness(snapshot) === null;
}
/** The suite queue of the repository: its lease store and resource. */
function suiteQueue(context) {
    const settings = suiteSettings(context.config).queue;
    if (!settings.enabled)
        return null;
    const file = stackPath(context.common, settings.lockFile);
    return { store: new LockStore(dirname(file)), resource: basename(file).replace(/\.lock$/, '') };
}
/** Why the stack is busy now; empty when it is free. */
export function probe(stack, context) {
    const busy = [];
    if (stack.lockFile) {
        const free = flockFree(stack.lockFile);
        if (free === false)
            busy.push(`verrou ${stack.lockFile} tenu`);
        if (free === null)
            busy.push(`verrou ${stack.lockFile} illisible (flock absent ?)`);
    }
    if (stack.resource && leaseHeld(new LockStore(defaultLockDir(context.env)), stack.resource))
        busy.push(`bail ${stack.resource} tenu`);
    const queue = suiteQueue(context);
    if (queue && leaseHeld(queue.store, queue.resource))
        busy.push('suite complète en cours (file suite.queue tenue)');
    const ports = stack.config.ports ?? [];
    if (ports.length) {
        try {
            const listening = new Set(listeningInodes().values());
            const open = ports.filter(p => listening.has(p));
            if (open.length)
                busy.push(`port(s) à l'écoute : ${open.join(', ')}`);
        }
        catch { /* no /proc: the locks decide */ }
    }
    return busy;
}
/**
 * One observation of a stack: busy now, or free, and since when by the series of observations. Writes the record.
 * A known use after the start of the series (a lease event, a check of apv gates run) moves its start there.
 */
export function observe(stack, context, now = Date.now()) {
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
    if (freeSince === null || !continuous)
        freeSince = now;
    else if (knownUse > freeSince)
        freeSince = Math.min(knownUse, now);
    const next = { ...record, lastObservedAt: iso, freeSince: new Date(freeSince).toISOString() };
    writeRecord(context.common, next);
    return { id: stack.id, busy, idleMs: now - freeSince, record: next };
}
const minutes = (ms) => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min`;
/** Runs `argv` from the root of the repository, bounded, output kept (last 4000 characters). */
async function runStackCommand(repo, argv, timeoutMs, env) {
    const r = await runProcess({ command: argv, cwd: repo, env, timeoutMs, maxOutputBytes: 64 * 1024 });
    return { ok: r.status === 'passed', output: `${r.stdout}\n${r.stderr}`.trim().slice(-4000) || `(${r.status}, code ${r.exitCode ?? '-'})` };
}
/**
 * Runs `argv` under the lock of the stack and the suite queue, both taken without waiting: `null` when one is held
 * (the stack is in use, nothing ran), else the outcome of the command.
 */
export async function underStackLock(stack, context, argv, label) {
    const owner = { pid: process.pid, host: hostname(), label: `apv stacks ${label} ${stack.id}` };
    const queue = suiteQueue(context);
    const held = [];
    try {
        if (queue) {
            const q = await queue.store.tryAcquire(queue.resource, owner, 3600, `apv stacks ${label}`);
            if (!q.ok)
                return null;
            held.push(() => queue.store.release(queue.resource, { token: q.record.token }));
        }
        if (stack.resource) {
            const store = new LockStore(defaultLockDir(context.env));
            const r = await store.tryAcquire(stack.resource, owner, 3600, `apv stacks ${label}`);
            if (!r.ok)
                return null;
            held.push(() => store.release(stack.resource, { token: r.record.token }));
        }
        const timeoutMs = stack.config.commandTimeoutMs;
        if (stack.lockFile) {
            mkdirSync(dirname(stack.lockFile), { recursive: true });
            const r = await runProcess({ command: ['flock', '-n', '-E', String(FLOCK_BUSY), stack.lockFile, ...argv], cwd: context.repo, env: context.env, timeoutMs, maxOutputBytes: 64 * 1024 });
            if (r.exitCode === FLOCK_BUSY && r.status === 'failed')
                return null;
            return { ok: r.status === 'passed', output: `${r.stdout}\n${r.stderr}`.trim().slice(-4000) || `(${r.status}, code ${r.exitCode ?? '-'})` };
        }
        return await runStackCommand(context.repo, argv, timeoutMs, context.env);
    }
    finally {
        for (const release of held.reverse()) {
            try {
                await release();
            }
            catch { /* expires with its lease */ }
        }
    }
}
/**
 * One pass of `apv stacks idle-stop`: observes each stack, and stops those free for at least `afterMs` (the stack's
 * `idleAfterMs`, else the option, else 30 min) and not already stopped since their last use. Every decision is journaled.
 */
export async function idlePass(stacks, context, options) {
    const out = [];
    for (const stack of stacks) {
        const seen = observe(stack, context, options.now ?? Date.now());
        const after = options.afterMs ?? stack.config.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
        const r = seen.record;
        const kept = (reason) => { out.push({ id: stack.id, action: 'kept', idleMs: seen.idleMs, reason }); };
        if (seen.busy.length) {
            kept(`occupée : ${seen.busy.join(' ; ')}`);
            continue;
        }
        if (!stack.config.stop) {
            kept('aucune commande stop déclarée');
            continue;
        }
        const stoppedAt = r.stoppedAt ? Date.parse(r.stoppedAt) : 0;
        const lastStart = Math.max(r.lastUsedAt ? Date.parse(r.lastUsedAt) : 0, r.startedAt ? Date.parse(r.startedAt) : 0);
        if (stoppedAt && stoppedAt >= lastStart) {
            kept(`déjà arrêtée le ${r.stoppedAt} (aucune utilisation connue depuis)`);
            continue;
        }
        if (seen.idleMs < after) {
            kept(`libre depuis ${minutes(seen.idleMs)} d'observations suivies (seuil ${minutes(after)})`);
            continue;
        }
        if (options.dryRun) {
            out.push({ id: stack.id, action: 'would-stop', idleMs: seen.idleMs });
            continue;
        }
        let result;
        try {
            result = await underStackLock(stack, context, stack.config.stop, 'idle-stop');
        }
        catch (error) {
            result = { ok: false, output: errorMessage(error) };
        }
        if (result === null) {
            writeRecord(context.common, { ...readRecord(context.common, stack.id), lastUsedAt: new Date().toISOString(), freeSince: null });
            kept('verrou de la pile ou file des suites pris entre-temps : pile en usage, non arrêtée');
            journal(context.common, { event: 'kept', stack: stack.id, reason: 'verrou pris au moment de l\'arrêt' });
            continue;
        }
        if (result.ok)
            writeRecord(context.common, { ...readRecord(context.common, stack.id), stoppedAt: new Date().toISOString(), freeSince: null });
        out.push({ id: stack.id, action: result.ok ? 'stopped' : 'failed', idleMs: seen.idleMs, output: result.output });
        journal(context.common, { event: result.ok ? 'stopped' : 'stop-failed', stack: stack.id, idleMs: seen.idleMs, command: stack.config.stop, output: result.output.slice(-1000) });
    }
    return out;
}
/**
 * The stop by `apv stacks idle-stop` not followed by a restart: `stoppedAt` later than `apv stacks start` and than
 * the last check that passed under its lock. Null when the stack is not known to be stopped.
 */
export function stoppedSince(common, id) {
    const r = readRecord(common, id);
    if (!r.stoppedAt)
        return null;
    const stopped = Date.parse(r.stoppedAt);
    const up = Math.max(r.startedAt ? Date.parse(r.startedAt) : 0, r.upAt ? Date.parse(r.upAt) : 0);
    return stopped > up ? r.stoppedAt : null;
}
//# sourceMappingURL=idle.js.map