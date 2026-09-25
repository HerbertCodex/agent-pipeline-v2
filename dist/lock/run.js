import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { localTime } from '../domain/time.js';
export const LOCK_WAIT_TIMEOUT_EXIT = 75;
/** Exit code of a command stopped by `timeoutMs` (the convention of GNU timeout). */
export const TIMEOUT_EXIT = 124;
const HANDLED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
export function signalExitCode(signal) {
    return 128 + (constants.signals[signal] ?? 0);
}
export function describeHolder(record) {
    if (!record)
        return 'détenteur inconnu (fichier en cours d\'écriture ou illisible)';
    const pid = record.owner.pid === null ? 'bail seul' : `pid ${record.owner.pid}`;
    const purpose = record.purpose ? `, pour « ${record.purpose} »` : '';
    return `${record.owner.label} (${pid} sur ${record.owner.host}${purpose}), expire à ${localTime(record.expiresAt)}`;
}
/** Prints the holder and queue position when they change, and at most every 30 s otherwise. */
export function waitReporter(resource, stderr) {
    let last = '';
    let lastAt = 0;
    return (info) => {
        const line = `Attente du verrou « ${resource} » : tenu par ${describeHolder(info.holder)} ; position ${info.position} sur ${info.queueLength} dans la file.`;
        const key = `${info.holder?.token ?? ''}:${info.position}:${info.queueLength}`;
        if (key !== last || Date.now() - lastAt > 30_000) {
            stderr(`${line}\n`);
            last = key;
            lastAt = Date.now();
        }
    };
}
/**
 * Acquires the lock, runs the command, keeps the lease alive while it runs and always releases:
 * normal exit, failure, spawn error, or SIGINT/SIGTERM/SIGHUP (forwarded to the command).
 * Returns the command's exit code (128 + signal when interrupted).
 */
export async function runLocked(store, resource, options) {
    const abort = new AbortController();
    let received = null;
    let child = null;
    let killTimer = null;
    const onSignal = (signal) => {
        if (!received)
            received = signal;
        abort.abort();
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill(signal);
            killTimer ??= setTimeout(() => { child?.kill('SIGKILL'); }, options.killGraceMs ?? 10_000);
        }
    };
    const handlers = HANDLED_SIGNALS.map((signal) => {
        const handler = () => onSignal(signal);
        process.on(signal, handler);
        return [signal, handler];
    });
    let heartbeat = null;
    let token = null;
    try {
        const result = await store.acquire(resource, {
            owner: options.owner,
            ttlSeconds: options.ttlSeconds,
            waitSeconds: options.waitSeconds,
            purpose: options.purpose,
            signal: abort.signal,
            onWait: waitReporter(resource, options.stderr),
            onRequeue: () => options.stderr(`Ticket d'attente de « ${resource} » perdu (processus suspendu ?) : remis en fin de file.\n`),
        });
        if (!result.ok) {
            if (result.aborted)
                return signalExitCode(received ?? 'SIGTERM');
            options.stderr(`Verrou « ${resource} » non obtenu après ${options.waitSeconds} s : tenu par ${describeHolder(result.holder)}.\n`);
            return LOCK_WAIT_TIMEOUT_EXIT;
        }
        token = result.record.token;
        if (result.takeover) {
            options.stderr(`Verrou « ${resource} » repris (${result.takeover.reason}) à ${describeHolder(result.takeover.previous)}.\n`);
        }
        if (received)
            return signalExitCode(received);
        let lost = false;
        const heartbeatMs = options.heartbeatMs ?? Math.min(60_000, Math.max(200, (options.ttlSeconds * 1000) / 3));
        const heldToken = token;
        heartbeat = setInterval(() => {
            store.renew(resource, heldToken, options.ttlSeconds).then((ok) => {
                if (!ok && !lost) {
                    lost = true;
                    options.stderr(`Attention : le verrou « ${resource} » n'est plus à nous (repris ou libéré de force) ; la commande continue sans protection.\n`);
                }
            }, (error) => options.stderr(`Renouvellement du verrou « ${resource} » en échec : ${String(error)}\n`));
        }, heartbeatMs);
        options.onAcquired?.();
        const held = (options.env.APV_LOCK_HELD ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const env = { ...options.env, APV_LOCK_HELD: [...held, resource].join(',') };
        const [file, ...args] = options.command;
        if (!file)
            throw new Error('commande vide');
        let timedOut = false;
        let timeout = null;
        const exit = await new Promise((resolve) => {
            const spawned = spawn(file, args, { cwd: options.cwd, env, stdio: options.stdio ?? 'inherit' });
            child = spawned;
            spawned.once('error', (error) => resolve({ status: null, signal: null, error }));
            spawned.once('exit', (status, signal) => resolve({ status, signal }));
            if (options.timeoutMs !== undefined) {
                timeout = setTimeout(() => {
                    timedOut = true;
                    spawned.kill('SIGTERM');
                    killTimer ??= setTimeout(() => { spawned.kill('SIGKILL'); }, options.killGraceMs ?? 10_000);
                }, options.timeoutMs);
            }
        });
        if (timeout)
            clearTimeout(timeout);
        if (exit.error) {
            options.stderr(`Impossible de lancer « ${file} » : ${exit.error.message}\n`);
            return 127;
        }
        if (received)
            return signalExitCode(received);
        if (timedOut)
            return TIMEOUT_EXIT;
        if (exit.status !== null)
            return exit.status;
        return signalExitCode(exit.signal ?? 'SIGTERM');
    }
    finally {
        if (heartbeat)
            clearInterval(heartbeat);
        if (killTimer)
            clearTimeout(killTimer);
        for (const [signal, handler] of handlers)
            process.off(signal, handler);
        if (token) {
            try {
                const released = await store.release(resource, { token });
                if (released.status !== 'released')
                    options.stderr(`Libération du verrou « ${resource} » : ${released.status}.\n`);
            }
            catch (error) {
                options.stderr(`Libération du verrou « ${resource} » en échec : ${String(error)}\n`);
            }
        }
    }
}
//# sourceMappingURL=run.js.map