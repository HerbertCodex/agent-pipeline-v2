import { spawn } from 'node:child_process';
import { closeSync, fchmodSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { PipelineError } from '../domain/errors.js';
import { expandVars } from './env.js';
/** Grace period after a step exits for its pipes, possibly held by a detached grandchild, to close. */
const PIPE_GRACE_MS = 1000;
/** argv of a command: a string goes through `sh -c`, an array is expanded (`${NAME}`) and run as is. */
export function argv(command, env, where) {
    if (typeof command === 'string')
        return ['sh', '-c', command];
    return command.map(part => expandVars(part, env, where));
}
/** Human form of a command, for logs (redacted by the caller). */
export function describeCommand(command) {
    return typeof command === 'string' ? command : command.map(a => (/^[\w./:=@%+,-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
}
/** Grace between SIGTERM and SIGKILL when a step runs out of time. */
const STEP_KILL_GRACE_MS = 5000;
/** Signals forwarded to a running step: it has its own process group and no longer gets them from the terminal. */
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'];
/**
 * Runs one step to completion, output streamed to `onOutput` (stdout and stderr interleaved).
 * The step runs in its own process group: past `timeoutMs` (0: no limit) the whole group gets SIGTERM,
 * then SIGKILL, so no grandchild (npm, npx, docker client) keeps working in the copy. A signal that
 * reaches apv (Ctrl+C) is passed on to the group before apv stops.
 * Resolves with the exit status (null when killed by a signal, -1 when the command cannot start).
 */
export function runStep(args, cwd, env, onOutput, timeoutMs = 0) {
    return new Promise((resolve) => {
        const [file, ...rest] = args;
        if (!file) {
            resolve({ status: -1, signal: null, error: 'commande vide' });
            return;
        }
        const child = spawn(file, rest, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        let done = false;
        let timedOut = false;
        let exit = null;
        let grace = null;
        let kill = null;
        const timer = timeoutMs > 0 ? setTimeout(() => {
            timedOut = true;
            if (child.pid)
                signalGroup(child.pid, 'SIGTERM');
            kill = setTimeout(() => { if (child.pid)
                signalGroup(child.pid, 'SIGKILL'); }, STEP_KILL_GRACE_MS);
        }, timeoutMs) : null;
        const forward = (signal) => {
            if (child.pid)
                signalGroup(child.pid, signal);
            detach();
            process.kill(process.pid, signal);
        };
        const detach = () => { for (const signal of FORWARDED)
            process.removeListener(signal, forward); };
        for (const signal of FORWARDED)
            process.once(signal, forward);
        const finish = (value) => {
            if (done)
                return;
            done = true;
            for (const t of [grace, timer, kill])
                if (t)
                    clearTimeout(t);
            detach();
            // Out of time: nothing of the group survives, even a grandchild that ignored SIGTERM.
            if (timedOut && child.pid && groupAlive(child.pid))
                signalGroup(child.pid, 'SIGKILL');
            child.stdout?.destroy();
            child.stderr?.destroy();
            resolve(timedOut ? { ...value, timedOut: true } : value);
        };
        child.stdout.setEncoding('utf8').on('data', onOutput);
        child.stderr.setEncoding('utf8').on('data', onOutput);
        child.once('error', (error) => finish({ status: -1, signal: null, error: error.message }));
        child.once('exit', (status, signal) => {
            exit = { status, signal };
            grace = setTimeout(() => finish(exit), PIPE_GRACE_MS);
        });
        child.once('close', (status, signal) => finish(exit ?? { status, signal }));
    });
}
/**
 * Starts the server detached, in its own process group, stdout and stderr appended to `logFile`.
 * The server writes the log itself, unmasked: the file is created, or narrowed, to mode 600.
 */
export function startDetached(args, cwd, env, logFile) {
    return new Promise((resolve, reject) => {
        const [file, ...rest] = args;
        if (!file) {
            reject(new PipelineError('PREVIEW_SERVE', 'commande du serveur vide'));
            return;
        }
        const fd = openSync(logFile, 'a', 0o600);
        try {
            fchmodSync(fd, 0o600);
            const child = spawn(file, rest, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
            child.once('error', (error) => reject(new PipelineError('PREVIEW_SERVE', `Impossible de lancer le serveur : ${error.message}`)));
            child.once('spawn', () => { child.unref(); resolve(child.pid); });
        }
        finally {
            closeSync(fd);
        }
    });
}
/** Linux `/proc/<pid>/stat`: start time (to detect a reused pid) and state (Z for a zombie). */
export function procStat(pid) {
    try {
        const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
        return { state: fields[0] ?? '?', start: fields[19] ?? '' };
    }
    catch {
        return null;
    }
}
function signalGroup(pgid, signal) {
    try {
        process.kill(-pgid, signal);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
/**
 * Whether a group has a live member. On Linux, `/proc` is scanned so that zombies (killed, not yet reaped
 * by their parent) do not count; elsewhere a signal 0 to the group decides.
 */
export function groupAlive(pgid) {
    let entries;
    try {
        entries = readdirSync('/proc');
    }
    catch {
        return signalGroup(pgid, 0);
    }
    if (!entries.includes('self'))
        return signalGroup(pgid, 0);
    for (const entry of entries) {
        if (!/^\d+$/.test(entry))
            continue;
        try {
            const text = readFileSync(`/proc/${entry}/stat`, 'utf8');
            const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
            if (Number(fields[2]) === pgid && fields[0] !== 'Z')
                return true;
        }
        catch { /* process gone meanwhile */ }
    }
    return false;
}
/**
 * Whether the recorded server is still the process group we started: a live member remains and, when
 * `/proc` shows the leader, the leader has the recorded start time (a reused pid is not ours).
 */
export function isOurs(pid, procStart) {
    if (!Number.isInteger(pid) || pid <= 1)
        return false;
    const stat = procStat(pid);
    if (stat && procStart && stat.start !== procStart)
        return false;
    return groupAlive(pid);
}
/** SIGTERM to the whole group, SIGKILL after `graceMs`. Resolves true when the group is gone. */
export async function stopGroup(pgid, procStart, graceMs = 10_000) {
    if (!isOurs(pgid, procStart))
        return true;
    signalGroup(pgid, 'SIGTERM');
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
        if (!isOurs(pgid, procStart))
            return true;
        await sleep(100);
    }
    signalGroup(pgid, 'SIGKILL');
    for (let i = 0; i < 30; i++) {
        if (!isOurs(pgid, procStart))
            return true;
        await sleep(100);
    }
    return !isOurs(pgid, procStart);
}
function canListen(port, host) {
    return new Promise((resolve) => {
        const server = createServer();
        server.once('error', (error) => resolve(error.code !== 'EADDRINUSE'));
        server.listen({ port, ...(host ? { host } : {}), exclusive: true }, () => server.close(() => resolve(true)));
    });
}
function accepts(port, host) {
    return new Promise((resolve) => {
        const socket = connect({ port, host });
        const done = (value) => { socket.destroy(); resolve(value); };
        socket.setTimeout(500, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}
/** Whether something already listens on the port: a bind test on the served host, and a connection to the loopback. */
export async function portInUse(port, host) {
    const bindHost = host && host !== '[::]' ? host.replace(/^\[|\]$/g, '') : undefined;
    if (!(await canListen(port, bindHost)))
        return true;
    return accepts(port, '127.0.0.1');
}
/** One health request: true for a 2xx or 3xx answer (redirects are not followed). */
export async function healthy(url, timeoutMs = 3000) {
    try {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        await response.body?.cancel();
        return response.status >= 200 && response.status < 400;
    }
    catch {
        return false;
    }
}
/** Polls the health URL until it answers, the server dies or the delay runs out. */
export async function waitHealthy(url, timeoutSec, alive, pollMs = 500) {
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
        if (!alive())
            return 'dead';
        if (await healthy(url, Math.max(500, Math.min(3000, deadline - Date.now()))))
            return 'ok';
        if (Date.now() >= deadline)
            return 'timeout';
        await sleep(pollMs);
    }
}
//# sourceMappingURL=process.js.map