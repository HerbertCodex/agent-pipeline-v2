import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../domain/errors.js';
import { gitRead } from '../run/git-probe.js';

/**
 * Processes of a repository, read from `/proc` (Linux): the working directory of each process, the TCP ports it
 * listens on, its parent. `apv procs` uses them to find the servers an interrupted test suite left behind (a Bash
 * call cut at its time limit leaves the children of `vite preview` or `playwright` listening on the ports of the test
 * stack) and to stop only those started inside a worktree of the repository.
 */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Start time in clock ticks since boot: with the pid, identifies the process (a reused pid has another). */
  start: number;
  /** Working directory, or null when unreadable (another user's process, a process gone meanwhile). */
  cwd: string | null;
  /** True when the working directory was removed (`/proc/<pid>/cwd` ends with ` (deleted)`). */
  cwdDeleted: boolean;
  command: string;
  /** TCP ports (IPv4 and IPv6) the process listens on. */
  ports: number[];
  zombie: boolean;
}

export const PROC_ROOT = '/proc';

/** Refuses clearly on a system without `/proc` (macOS, Windows): nothing can be listed there. */
export function assertProcSupported(root = PROC_ROOT): void {
  if (!existsSync(join(root, 'self', 'stat'))) {
    throw new PipelineError('PROCS_UNSUPPORTED', `Système sans ${root} (${process.platform}) : apv procs lit le répertoire courant et les ports des processus dans ${root}, disponible sous Linux seulement. Arrêtez les serveurs à la main (ps, lsof, kill).`);
  }
}

/** Fields of `/proc/<pid>/stat` after the command name, which may contain spaces and parentheses. */
function readStat(root: string, pid: number): { ppid: number; start: number; zombie: boolean } | null {
  try {
    const text = readFileSync(join(root, String(pid), 'stat'), 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    // fields[0] is the state (3rd field), fields[1] the parent (4th), fields[19] the start time (22nd).
    return { ppid: Number(fields[1]), start: Number(fields[19]), zombie: fields[0] === 'Z' || fields[0] === 'X' };
  } catch { return null; }
}

/** Listening TCP sockets: inode to port, from `/proc/net/tcp` and `/proc/net/tcp6` (state 0A). */
export function listeningInodes(root = PROC_ROOT): Map<string, number> {
  const inodes = new Map<string, number>();
  for (const file of ['tcp', 'tcp6']) {
    let text: string;
    try { text = readFileSync(join(root, 'net', file), 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== '0A') continue;
      const port = parseInt(cols[1]!.split(':').pop()!, 16);
      if (Number.isInteger(port) && cols[9] && cols[9] !== '0') inodes.set(cols[9], port);
    }
  }
  return inodes;
}

function socketPorts(root: string, pid: number, inodes: Map<string, number>): number[] {
  const ports = new Set<number>();
  let fds: string[];
  try { fds = readdirSync(join(root, String(pid), 'fd')); } catch { return []; }
  for (const fd of fds) {
    let target: string;
    try { target = readlinkSync(join(root, String(pid), 'fd', fd)); } catch { continue; }
    const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
    const port = inode ? inodes.get(inode) : undefined;
    if (port !== undefined) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** One process, or null when it is gone. */
export function readProcess(pid: number, root = PROC_ROOT, inodes?: Map<string, number>): ProcessInfo | null {
  const stat = readStat(root, pid);
  if (!stat) return null;
  let cwd: string | null = null; let cwdDeleted = false;
  try {
    const link = readlinkSync(join(root, String(pid), 'cwd'));
    cwdDeleted = link.endsWith(' (deleted)');
    cwd = cwdDeleted ? link.slice(0, -' (deleted)'.length) : link;
  } catch { /* another user's process, or gone */ }
  let command = '';
  try { command = readFileSync(join(root, String(pid), 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' '); } catch { /* gone */ }
  if (!command) { try { command = `[${readFileSync(join(root, String(pid), 'comm'), 'utf8').trim()}]`; } catch { /* gone */ } }
  return { pid, ppid: stat.ppid, start: stat.start, cwd, cwdDeleted, command, ports: inodes ? socketPorts(root, pid, inodes) : [], zombie: stat.zombie };
}

/** Every process visible in `/proc`, with its listening ports. */
export function listProcesses(root = PROC_ROOT): ProcessInfo[] {
  assertProcSupported(root);
  const inodes = listeningInodes(root);
  const out: ProcessInfo[] = [];
  for (const name of readdirSync(root)) {
    if (!/^\d+$/.test(name)) continue;
    const info = readProcess(Number(name), root, inodes);
    if (info) out.push(info);
  }
  return out;
}

/** The current process and its ancestors: never stopped (the session that runs the command, its shell). */
export function protectedPids(root = PROC_ROOT, self = process.pid): Set<number> {
  const pids = new Set<number>([self]);
  let pid = self;
  for (let i = 0; i < 1000 && pid > 1; i++) {
    const stat = readStat(root, pid);
    if (!stat) break;
    pid = stat.ppid;
    pids.add(pid);
  }
  pids.add(1);
  return pids;
}

/** Worktrees of the repository that contains `path` (`git worktree list`), main checkout first, canonical paths. */
export function repositoryWorktrees(path: string): string[] {
  const out = gitRead(path, ['worktree', 'list', '--porcelain']);
  if (out === null) throw new PipelineError('NOT_A_REPOSITORY', `Pas un dépôt Git : ${path}`);
  return out.split('\n').filter(line => line.startsWith('worktree ')).map(line => {
    const dir = line.slice('worktree '.length);
    try { return realpathSync(dir); } catch { return dir; }
  });
}

/** The worktree that contains `dir` (the deepest, for a worktree nested in another), or null. */
export function worktreeOf(dir: string | null, worktrees: readonly string[]): string | null {
  if (dir === null) return null;
  const inside = worktrees.filter(w => dir === w || dir.startsWith(w.endsWith('/') ? w : `${w}/`));
  return inside.sort((a, b) => b.length - a.length)[0] ?? null;
}

/** Whether the process is still the one that was listed (same pid, same start time) and not a zombie. */
export function sameProcessAlive(info: Pick<ProcessInfo, 'pid' | 'start'>, root = PROC_ROOT): boolean {
  const stat = readStat(root, info.pid);
  return stat !== null && stat.start === info.start && !stat.zombie;
}

export type StopOutcome = 'terminated' | 'killed' | 'survived' | 'gone' | 'denied';

/**
 * Stops the processes: SIGTERM to all, then SIGKILL to those still alive after `graceMs`, then a short wait.
 * A signal goes only to the process that was listed (same start time): a pid reused meanwhile is left alone.
 */
export async function stopProcesses(targets: readonly ProcessInfo[], options: { graceMs: number; pollMs?: number; root?: string }): Promise<Map<number, StopOutcome>> {
  const root = options.root ?? PROC_ROOT;
  const poll = options.pollMs ?? 100;
  const outcome = new Map<number, StopOutcome>();
  const signal = (info: ProcessInfo, name: NodeJS.Signals): boolean => {
    if (!sameProcessAlive(info, root)) { outcome.set(info.pid, outcome.get(info.pid) ?? 'gone'); return false; }
    try { process.kill(info.pid, name); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      outcome.set(info.pid, code === 'ESRCH' ? 'gone' : 'denied');
      return false;
    }
  };
  const waitGone = async (list: ProcessInfo[], ms: number): Promise<ProcessInfo[]> => {
    const deadline = Date.now() + ms;
    let alive = list.filter(p => sameProcessAlive(p, root));
    while (alive.length && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, poll));
      alive = alive.filter(p => sameProcessAlive(p, root));
    }
    return alive;
  };
  const termed = targets.filter(p => signal(p, 'SIGTERM'));
  const afterTerm = await waitGone(termed, options.graceMs);
  for (const p of termed) if (!afterTerm.includes(p)) outcome.set(p.pid, 'terminated');
  const killed = afterTerm.filter(p => signal(p, 'SIGKILL'));
  const afterKill = await waitGone(killed, 2000);
  for (const p of killed) outcome.set(p.pid, afterKill.includes(p) ? 'survived' : 'killed');
  return outcome;
}
