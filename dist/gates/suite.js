import { mkdirSync, readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { canonicalPath } from '../domain/paths.js';
import { PipelineError, errorMessage, invariant } from '../domain/errors.js';
import { describeHolder, waitReporter } from '../lock/run.js';
import { LockStore, defaultLockDir } from '../lock/store.js';
import { assertProcSupported, listProcesses, protectedTool, repositoryWorktrees, sessionPids, stopProcesses, stopRefusal, } from '../execution/procs.js';
/**
 * The full suite of `apv gates run` (docs/APV3-SPEC.md, section 17): the machine queue taken before its first check,
 * the load threshold, the ports freed from orphans of the same copy, and the locks of the checks that share a
 * resource with other copies (a test stack). Every wait happens before the timeout of a check starts.
 */
/** Lease of a lock held by apv itself: renewed every third, lost within this delay when apv dies without releasing. */
export const LEASE_TTL_SECONDS = 120;
const seconds = (ms) => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
/** A path of the configuration: absolute as is, else relative to the Git common directory of `repo`. */
export async function commonPath(git, repo, path) {
    if (isAbsolute(path))
        return path;
    const out = (await git.exec(repo, ['rev-parse', '--git-common-dir'])).trim();
    invariant(out.length > 0, 'GIT', 'git rev-parse --git-common-dir returned nothing');
    return resolve(isAbsolute(out) ? out : resolve(repo, out), path);
}
/** A lease of the `apv lock` store held until `release`, renewed meanwhile. */
async function holdLease(store, resource, options) {
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
    if (result.takeover)
        options.log(`Verrou « ${resource} » repris (${result.takeover.reason}) à ${describeHolder(result.takeover.previous)}.`);
    const token = result.record.token;
    const heartbeat = setInterval(() => {
        store.renew(resource, token, LEASE_TTL_SECONDS).then(ok => { if (!ok)
            options.log(`Attention : le verrou « ${resource} » n'est plus à nous (repris ou libéré de force).`); }, (error) => options.log(`Renouvellement du verrou « ${resource} » en échec : ${errorMessage(error)}`));
    }, (LEASE_TTL_SECONDS * 1000) / 3);
    heartbeat.unref();
    let released = false;
    return { ok: true, waitedMs, heldBy: waitedMs > 1000 ? before : null, release: async () => {
            if (released)
                return;
            released = true;
            clearInterval(heartbeat);
            try {
                await store.release(resource, { token });
            }
            catch (error) {
                options.log(`Libération du verrou « ${resource} » en échec : ${errorMessage(error)}`);
            }
        } };
}
/**
 * Enters the queue of the full suites: the lease `settings.lockFile` (FIFO of `apv lock`, the same store format), then,
 * lock held, the wait for the 1-minute load to drop under `maxLoad` (at most `loadWaitMs`, then the suite starts anyway,
 * noted). A lock not obtained within `waitMs` is a refusal (`SUITE_QUEUE`), nothing has run.
 */
export async function enterQueue(options) {
    const { settings, log } = options;
    const dir = dirname(options.lockFile);
    const resource = basename(options.lockFile).replace(/\.lock$/, '');
    const store = new LockStore(dir, options.hooks?.lockPollMs !== undefined ? { pollMs: options.hooks.lockPollMs } : {});
    const lease = await holdLease(store, resource, { label: `apv gates run (${options.repo})`, waitMs: settings.waitMs, purpose: 'suite complète', signal: options.signal, log });
    if (!lease.ok) {
        if (lease.aborted)
            throw new PipelineError('CANCELLED', `File des suites complètes : ${lease.reason}`);
        throw new PipelineError('SUITE_QUEUE', `File des suites complètes (${options.lockFile}) : ${lease.reason}. Rien n'a été exécuté. ` +
            'Relancer plus tard, ou voir le détenteur : apv lock status --dir ' + dir);
    }
    if (lease.waitedMs > 1000)
        log(`File des suites complètes : verrou obtenu après ${seconds(lease.waitedMs)}.`);
    const record = { lockFile: options.lockFile, waitedMs: lease.waitedMs, heldBy: lease.heldBy ? describeHolder(lease.heldBy) : null, load: null };
    try {
        if (settings.maxLoad !== undefined)
            record.load = await waitForLoad(settings.maxLoad, settings.loadWaitMs, log, options.signal, options.hooks);
    }
    catch (error) {
        await lease.release();
        throw error;
    }
    return { record, release: lease.release };
}
/** Waits for the 1-minute load average to drop under `max`, at most `limitMs`; journaled at most every minute. */
export async function waitForLoad(max, limitMs, log, signal, hooks) {
    const read = hooks?.loadAverage ?? (() => loadavg()[0] ?? 0);
    const poll = hooks?.loadPollMs ?? 15_000;
    const started = Date.now();
    let load = read();
    let lastLog = 0;
    while (load >= max) {
        const waited = Date.now() - started;
        if (waited >= limitMs) {
            log(`Charge moyenne sur 1 min encore à ${load.toFixed(2)} (seuil ${max}) après ${seconds(waited)} : la suite démarre quand même.`);
            return { max, atStart: load, waitedMs: waited, exceeded: true };
        }
        if (lastLog === 0 || Date.now() - lastLog >= 60_000) {
            log(`Charge moyenne sur 1 min à ${load.toFixed(2)}, seuil ${max} : démarrage différé (attente ${seconds(waited)}, au plus ${seconds(limitMs)}).`);
            lastLog = Date.now();
        }
        try {
            await sleep(Math.min(poll, Math.max(1, limitMs - waited)), undefined, signal ? { signal } : {});
        }
        catch {
            throw new PipelineError('CANCELLED', 'Attente de la charge annulée');
        }
        load = read();
    }
    const waitedMs = Date.now() - started;
    if (waitedMs > 1000)
        log(`Charge moyenne sur 1 min à ${load.toFixed(2)}, sous le seuil ${max} : la suite démarre (attente ${seconds(waitedMs)}).`);
    return { max, atStart: load, waitedMs, exceeded: false };
}
/**
 * Frees the declared ports from the orphans of the copy `repo` (a linked worktree): processes that listen there and
 * whose working directory is in that copy are stopped as `apv procs stop` does (SIGTERM, SIGKILL after the grace, a
 * reused pid spared). Never a process of another copy, of the main checkout, outside the repository, a protected tool
 * or the session: those are only reported.
 */
export async function freePorts(repo, ports, options) {
    const record = { ports: [...ports], stopped: [], left: [], unsupported: null };
    if (!ports.length)
        return record;
    try {
        assertProcSupported();
    }
    catch (error) {
        record.unsupported = errorMessage(error);
        options.log(`Ports de la suite non vérifiés : ${record.unsupported}`);
        return record;
    }
    const worktrees = repositoryWorktrees(repo);
    const copy = canonicalPath(repo);
    const all = listProcesses();
    const session = sessionPids(all);
    const targets = all.filter(p => !p.zombie && p.ports.some(port => ports.includes(port)));
    const stoppable = [];
    for (const info of targets) {
        const { worktree, refusal } = stopRefusal(info, { session, worktrees, copy });
        const entry = { pid: info.pid, ports: info.ports.filter(port => ports.includes(port)), command: info.command.slice(0, 300), worktree };
        if (refusal)
            record.left.push({ ...entry, reason: refusal });
        else
            stoppable.push({ info, entry });
    }
    if (stoppable.length) {
        const outcomes = await stopProcesses(stoppable.map(s => s.info), { graceMs: options.graceMs ?? 5000 });
        for (const { info, entry } of stoppable)
            record.stopped.push({ ...entry, outcome: outcomes.get(info.pid) ?? 'gone' });
    }
    for (const p of record.stopped)
        options.log(`Port ${p.ports.join(', ')} : orphelin de cette copie arrêté (pid ${p.pid}, ${p.outcome}) : ${p.command.slice(0, 120)}`);
    for (const p of record.left)
        options.log(`Port ${p.ports.join(', ')} : tenu par le pid ${p.pid} (${p.reason}${p.worktree ? `, ${p.worktree}` : ''}), non arrêté.`);
    return record;
}
/** Where the lock of a check lives: the `apv lock` store for a lease, the file (or its variable) for a flock. */
export async function resolveGateLock(git, repo, lock, env, source) {
    if ('resource' in lock)
        return { kind: 'lease', resource: lock.resource, dir: defaultLockDir(source), waitMs: lock.waitMs };
    const fromEnv = lock.fileEnv ? env[lock.fileEnv] : undefined;
    const file = fromEnv ? resolve(repo, fromEnv) : await commonPath(git, repo, lock.file);
    return { kind: 'flock', file, waitMs: lock.waitMs };
}
/**
 * Holds the lease of a check around `run`. Already held by an ancestor (`APV_LOCK_HELD` of the source environment,
 * as `apv lock run` sets it): not taken again. The command receives `APV_LOCK_HELD` with the resource, so that an
 * `apv lock run <resource>` inside it does not wait for its own parent.
 */
export async function withGateLease(lock, options, run, refused) {
    const held = (options.source['APV_LOCK_HELD'] ?? '').split(',').map(x => x.trim()).filter(Boolean);
    const env = { ...options.env, APV_LOCK_HELD: [...new Set([...held, lock.resource])].join(',') };
    if (held.includes(lock.resource))
        return run(env, 0);
    mkdirSync(lock.dir, { recursive: true });
    const store = new LockStore(lock.dir, options.hooks?.lockPollMs !== undefined ? { pollMs: options.hooks.lockPollMs } : {});
    const lease = await holdLease(store, lock.resource, { label: options.label, waitMs: lock.waitMs, purpose: options.label, signal: options.signal, log: options.log });
    if (!lease.ok)
        return refused(lease.reason, lease.waitedMs);
    try {
        return await run(env, lease.waitedMs);
    }
    finally {
        await lease.release();
    }
}
/** Exit code of `flock -E` when its wait expires. */
export const FLOCK_TIMEOUT_EXIT = 75;
/**
 * The command wrapped by `flock(1)`: the kernel lock of `file` is held by `flock`, an ancestor of the command (a
 * project script that proves the lock by an ancestor holder in `/proc/locks` sees it held); `sh` writes one byte on
 * fd 3 once the lock is held, then closes it and becomes the command (`runProcess` `waitReady`: the timeout starts
 * there).
 */
export function flockCommand(file, waitMs, command) {
    mkdirSync(join(file, '..'), { recursive: true });
    return ['flock', '-w', String(waitMs / 1000), '-E', String(FLOCK_TIMEOUT_EXIT), file, 'sh', '-c', 'printf 1 >&3 && exec 3>&- "$@"', 'apv-lock', ...command];
}
/** Variable that marks every command of a full suite: its processes, and those they start, are found by it at the end. */
export const SUITE_MARKER = 'APV_SUITE_RUN';
/** Processes of this user whose environment carries `<SUITE_MARKER>=<runId>` (read in `/proc/<pid>/environ`). */
export function markedProcesses(runId, processes, root = '/proc') {
    const needle = `${SUITE_MARKER}=${runId}`;
    return processes.filter(p => {
        if (p.zombie)
            return false;
        try {
            return readFileSync(join(root, String(p.pid), 'environ'), 'latin1').split('\0').includes(needle);
        }
        catch {
            return false;
        }
    });
}
/**
 * The end of a full suite, whatever its outcome (docs/APV3-SPEC.md, section 18.4): the processes it started that are
 * still alive (a server that left the process group of its check) are stopped as `apv procs stop` does, then the
 * orphans of this copy on `suite.ports`. Never the session, a protected tool, another copy or the main checkout.
 */
export async function cleanupSuite(repo, runId, ports, options) {
    const record = { stopped: [], left: [], ports: null, unsupported: null };
    try {
        assertProcSupported();
    }
    catch (error) {
        record.unsupported = errorMessage(error);
        options.log(`Fin de suite : processus non vérifiés (${record.unsupported}).`);
        return record;
    }
    const all = listProcesses();
    const session = sessionPids(all);
    const marked = markedProcesses(runId, all);
    const stoppable = [];
    for (const info of marked) {
        const entry = { pid: info.pid, ports: info.ports, command: info.command.slice(0, 300), worktree: null };
        if (session.has(info.pid) || protectedTool(info) !== null)
            record.left.push({ ...entry, reason: session.has(info.pid) ? 'protected' : 'tool' });
        else
            stoppable.push(info);
    }
    if (stoppable.length) {
        const outcomes = await stopProcesses(stoppable, { graceMs: options.graceMs ?? 5000 });
        for (const info of stoppable)
            record.stopped.push({ pid: info.pid, ports: info.ports, command: info.command.slice(0, 300), worktree: null, outcome: outcomes.get(info.pid) ?? 'gone' });
    }
    for (const p of record.stopped)
        options.log(`Fin de suite : processus lancé par la suite encore vivant, arrêté (pid ${p.pid}, ${p.outcome}${p.ports.length ? `, ports ${p.ports.join(', ')}` : ''}) : ${p.command.slice(0, 120)}`);
    if (ports.length)
        record.ports = await freePorts(repo, ports, { log: line => options.log(`Fin de suite : ${line}`), ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}) });
    return record;
}
//# sourceMappingURL=suite.js.map