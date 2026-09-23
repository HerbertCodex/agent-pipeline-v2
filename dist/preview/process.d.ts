import type { PreviewCommand } from './config.js';
/** argv of a command: a string goes through `sh -c`, an array is expanded (`${NAME}`) and run as is. */
export declare function argv(command: PreviewCommand, env: NodeJS.ProcessEnv, where: string): string[];
/** Human form of a command, for logs (redacted by the caller). */
export declare function describeCommand(command: PreviewCommand): string;
/**
 * Runs one step to completion, output streamed to `onOutput` (stdout and stderr interleaved).
 * Resolves with the exit status (null when killed by a signal, -1 when the command cannot start).
 */
export declare function runStep(args: string[], cwd: string, env: NodeJS.ProcessEnv, onOutput: (s: string) => void): Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    error?: string;
}>;
/** Starts the server detached, in its own process group, stdout and stderr appended to `logFile`. */
export declare function startDetached(args: string[], cwd: string, env: NodeJS.ProcessEnv, logFile: string): Promise<number>;
/** Linux `/proc/<pid>/stat`: start time (to detect a reused pid) and state (Z for a zombie). */
export declare function procStat(pid: number): {
    start: string;
    state: string;
} | null;
/**
 * Whether a group has a live member. On Linux, `/proc` is scanned so that zombies (killed, not yet reaped
 * by their parent) do not count; elsewhere a signal 0 to the group decides.
 */
export declare function groupAlive(pgid: number): boolean;
/**
 * Whether the recorded server is still the process group we started: a live member remains and, when
 * `/proc` shows the leader, the leader has the recorded start time (a reused pid is not ours).
 */
export declare function isOurs(pid: number, procStart: string | null): boolean;
/** SIGTERM to the whole group, SIGKILL after `graceMs`. Resolves true when the group is gone. */
export declare function stopGroup(pgid: number, procStart: string | null, graceMs?: number): Promise<boolean>;
/** Whether something already listens on the port: a bind test on the served host, and a connection to the loopback. */
export declare function portInUse(port: number, host: string | undefined): Promise<boolean>;
/** One health request: true for a 2xx or 3xx answer (redirects are not followed). */
export declare function healthy(url: string, timeoutMs?: number): Promise<boolean>;
/** Polls the health URL until it answers, the server dies or the delay runs out. */
export declare function waitHealthy(url: string, timeoutSec: number, alive: () => boolean, pollMs?: number): Promise<'ok' | 'dead' | 'timeout'>;
