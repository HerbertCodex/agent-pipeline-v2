import { spawn } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { PipelineError } from '../domain/errors.js';
import { expandVars } from './env.js';
import type { PreviewCommand } from './config.js';

/** Grace period after a step exits for its pipes, possibly held by a detached grandchild, to close. */
const PIPE_GRACE_MS = 1000;

/** argv of a command: a string goes through `sh -c`, an array is expanded (`${NAME}`) and run as is. */
export function argv(command: PreviewCommand, env: NodeJS.ProcessEnv, where: string): string[] {
  if (typeof command === 'string') return ['sh', '-c', command];
  return command.map(part => expandVars(part, env, where));
}

/** Human form of a command, for logs (redacted by the caller). */
export function describeCommand(command: PreviewCommand): string {
  return typeof command === 'string' ? command : command.map(a => (/^[\w./:=@%+,-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
}

/**
 * Runs one step to completion, output streamed to `onOutput` (stdout and stderr interleaved).
 * Resolves with the exit status (null when killed by a signal, -1 when the command cannot start).
 */
export function runStep(args: string[], cwd: string, env: NodeJS.ProcessEnv, onOutput: (s: string) => void):
  Promise<{ status: number | null; signal: NodeJS.Signals | null; error?: string }> {
  return new Promise((resolve) => {
    const [file, ...rest] = args;
    if (!file) { resolve({ status: -1, signal: null, error: 'commande vide' }); return; }
    const child = spawn(file, rest, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    let exit: { status: number | null; signal: NodeJS.Signals | null } | null = null;
    let grace: NodeJS.Timeout | null = null;
    const finish = (value: { status: number | null; signal: NodeJS.Signals | null; error?: string }) => {
      if (done) return;
      done = true;
      if (grace) clearTimeout(grace);
      child.stdout?.destroy(); child.stderr?.destroy();
      resolve(value);
    };
    child.stdout.setEncoding('utf8').on('data', onOutput);
    child.stderr.setEncoding('utf8').on('data', onOutput);
    child.once('error', (error) => finish({ status: -1, signal: null, error: error.message }));
    child.once('exit', (status, signal) => {
      exit = { status, signal };
      grace = setTimeout(() => finish(exit!), PIPE_GRACE_MS);
    });
    child.once('close', (status: number | null, signal: NodeJS.Signals | null) => finish(exit ?? { status, signal }));
  });
}

/** Starts the server detached, in its own process group, stdout and stderr appended to `logFile`. */
export function startDetached(args: string[], cwd: string, env: NodeJS.ProcessEnv, logFile: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const [file, ...rest] = args;
    if (!file) { reject(new PipelineError('PREVIEW_SERVE', 'commande du serveur vide')); return; }
    const fd = openSync(logFile, 'a');
    try {
      const child = spawn(file, rest, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
      child.once('error', (error) => reject(new PipelineError('PREVIEW_SERVE', `Impossible de lancer le serveur : ${error.message}`)));
      child.once('spawn', () => { child.unref(); resolve(child.pid!); });
    } finally {
      closeSync(fd);
    }
  });
}

/** Linux `/proc/<pid>/stat`: start time (to detect a reused pid) and state (Z for a zombie). */
export function procStat(pid: number): { start: string; state: string } | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0] ?? '?', start: fields[19] ?? '' };
  } catch { return null; }
}

function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try { process.kill(-pgid, signal); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Whether a group has a live member. On Linux, `/proc` is scanned so that zombies (killed, not yet reaped
 * by their parent) do not count; elsewhere a signal 0 to the group decides.
 */
export function groupAlive(pgid: number): boolean {
  let entries: string[];
  try { entries = readdirSync('/proc'); } catch { return signalGroup(pgid, 0); }
  if (!entries.includes('self')) return signalGroup(pgid, 0);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const text = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pgid && fields[0] !== 'Z') return true;
    } catch { /* process gone meanwhile */ }
  }
  return false;
}

/**
 * Whether the recorded server is still the process group we started: a live member remains and, when
 * `/proc` shows the leader, the leader has the recorded start time (a reused pid is not ours).
 */
export function isOurs(pid: number, procStart: string | null): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const stat = procStat(pid);
  if (stat && procStart && stat.start !== procStart) return false;
  return groupAlive(pid);
}

/** SIGTERM to the whole group, SIGKILL after `graceMs`. Resolves true when the group is gone. */
export async function stopGroup(pgid: number, procStart: string | null, graceMs = 10_000): Promise<boolean> {
  if (!isOurs(pgid, procStart)) return true;
  signalGroup(pgid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isOurs(pgid, procStart)) return true;
    await sleep(100);
  }
  signalGroup(pgid, 'SIGKILL');
  for (let i = 0; i < 30; i++) {
    if (!isOurs(pgid, procStart)) return true;
    await sleep(100);
  }
  return !isOurs(pgid, procStart);
}

function canListen(port: number, host: string | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code !== 'EADDRINUSE'));
    server.listen({ port, ...(host ? { host } : {}), exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function accepts(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Whether something already listens on the port: a bind test on the served host, and a connection to the loopback. */
export async function portInUse(port: number, host: string | undefined): Promise<boolean> {
  const bindHost = host && host !== '[::]' ? host.replace(/^\[|\]$/g, '') : undefined;
  if (!(await canListen(port, bindHost))) return true;
  return accepts(port, '127.0.0.1');
}

/** One health request: true for a 2xx or 3xx answer (redirects are not followed). */
export async function healthy(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return response.status >= 200 && response.status < 400;
  } catch { return false; }
}

/** Polls the health URL until it answers, the server dies or the delay runs out. */
export async function waitHealthy(url: string, timeoutSec: number, alive: () => boolean, pollMs = 500): Promise<'ok' | 'dead' | 'timeout'> {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    if (!alive()) return 'dead';
    if (await healthy(url, Math.max(500, Math.min(3000, deadline - Date.now())))) return 'ok';
    if (Date.now() >= deadline) return 'timeout';
    await sleep(pollMs);
  }
}
