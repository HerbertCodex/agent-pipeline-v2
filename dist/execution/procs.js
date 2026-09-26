import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../domain/errors.js';
import { gitRead } from '../run/git-probe.js';
export const PROC_ROOT = '/proc';
/** Refuses clearly on a system without `/proc` (macOS, Windows): nothing can be listed there. */
export function assertProcSupported(root = PROC_ROOT) {
    if (!existsSync(join(root, 'self', 'stat'))) {
        throw new PipelineError('PROCS_UNSUPPORTED', `Système sans ${root} (${process.platform}) : apv procs lit le répertoire courant et les ports des processus dans ${root}, disponible sous Linux seulement. Arrêtez les serveurs à la main (ps, lsof, kill).`);
    }
}
/** Fields of `/proc/<pid>/stat` after the command name, which may contain spaces and parentheses. */
function readStat(root, pid) {
    try {
        const text = readFileSync(join(root, String(pid), 'stat'), 'utf8');
        const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
        // fields[0] is the state (3rd field), fields[1] the parent (4th), fields[2] the process group (5th), fields[19] the start time (22nd).
        return { ppid: Number(fields[1]), pgid: Number(fields[2]), start: Number(fields[19]), zombie: fields[0] === 'Z' || fields[0] === 'X' };
    }
    catch {
        return null;
    }
}
/** Listening TCP sockets: inode to port, from `/proc/net/tcp` and `/proc/net/tcp6` (state 0A). */
export function listeningInodes(root = PROC_ROOT) {
    const inodes = new Map();
    for (const file of ['tcp', 'tcp6']) {
        let text;
        try {
            text = readFileSync(join(root, 'net', file), 'utf8');
        }
        catch {
            continue;
        }
        for (const line of text.split('\n').slice(1)) {
            const cols = line.trim().split(/\s+/);
            if (cols.length < 10 || cols[3] !== '0A')
                continue;
            const port = parseInt(cols[1].split(':').pop(), 16);
            if (Number.isInteger(port) && cols[9] && cols[9] !== '0')
                inodes.set(cols[9], port);
        }
    }
    return inodes;
}
function socketPorts(root, pid, inodes) {
    const ports = new Set();
    let fds;
    try {
        fds = readdirSync(join(root, String(pid), 'fd'));
    }
    catch {
        return [];
    }
    for (const fd of fds) {
        let target;
        try {
            target = readlinkSync(join(root, String(pid), 'fd', fd));
        }
        catch {
            continue;
        }
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
        const port = inode ? inodes.get(inode) : undefined;
        if (port !== undefined)
            ports.add(port);
    }
    return [...ports].sort((a, b) => a - b);
}
/** One process, or null when it is gone. */
export function readProcess(pid, root = PROC_ROOT, inodes) {
    const stat = readStat(root, pid);
    if (!stat)
        return null;
    let cwd = null;
    let cwdDeleted = false;
    try {
        const link = readlinkSync(join(root, String(pid), 'cwd'));
        cwdDeleted = link.endsWith(' (deleted)');
        cwd = cwdDeleted ? link.slice(0, -' (deleted)'.length) : link;
    }
    catch { /* another user's process, or gone */ }
    let command = '';
    try {
        command = readFileSync(join(root, String(pid), 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' ');
    }
    catch { /* gone */ }
    let comm = '';
    try {
        comm = readFileSync(join(root, String(pid), 'comm'), 'utf8').trim();
    }
    catch { /* gone */ }
    if (!command && comm)
        command = `[${comm}]`;
    let exe = null;
    try {
        exe = readlinkSync(join(root, String(pid), 'exe'));
    }
    catch { /* another user's process, a kernel thread, or gone */ }
    return { pid, ppid: stat.ppid, pgid: stat.pgid, start: stat.start, cwd, cwdDeleted, command, exe, comm, ports: inodes ? socketPorts(root, pid, inodes) : [], zombie: stat.zombie };
}
/** Every process visible in `/proc`, with its listening ports. */
export function listProcesses(root = PROC_ROOT) {
    assertProcSupported(root);
    const inodes = listeningInodes(root);
    const out = [];
    for (const name of readdirSync(root)) {
        if (!/^\d+$/.test(name))
            continue;
        const info = readProcess(Number(name), root, inodes);
        if (info)
            out.push(info);
    }
    return out;
}
/** The current process and its ancestors: never stopped (the session that runs the command, its shell). */
export function protectedPids(root = PROC_ROOT, self = process.pid) {
    const pids = new Set([self]);
    let pid = self;
    for (let i = 0; i < 1000 && pid > 1; i++) {
        const stat = readStat(root, pid);
        if (!stat)
            break;
        pid = stat.ppid;
        pids.add(pid);
    }
    pids.add(1);
    return pids;
}
/** Short names of the shells whose children may be the other commands of the pipeline that runs apv. */
const SHELL_COMM = /^-?(sh|bash|dash|zsh|ksh|mksh|ash|fish|busybox)$/;
/**
 * Ephemeral processes of the command line that runs apv: the other commands of its pipeline (`apv procs list | tail
 * | cut`), children of a shell among the ancestors of apv and in the same process group as apv. Never listed. Only
 * the children of a shell count: a program that spawns apv (a test runner, an editor) may have other children in
 * the same process group, which are not part of the command line.
 */
export function pipelineSiblings(processes, session, root = PROC_ROOT, self = process.pid) {
    const own = readStat(root, self);
    const out = new Set();
    if (!own)
        return out;
    const shells = new Set(processes.filter(p => p.pid !== 1 && session.has(p.pid) && SHELL_COMM.test(p.comm)).map(p => p.pid));
    for (const p of processes)
        if (p.pgid === own.pgid && shells.has(p.ppid) && !session.has(p.pid))
            out.add(p.pid);
    return out;
}
/**
 * Tools of the operator's editor and session, never stopped wherever they run and whatever port they hold: they are
 * often started in the main checkout (the folder open in the editor) and an interrupted test suite never leaves them
 * behind. Matched against the executable and the command line.
 */
export const PROTECTED_TOOLS = [
    { label: 'serveur d\'éditeur distant (VS Code, Cursor, Windsurf)', pattern: /\/\.(vscode|vscode-insiders|vscodium|cursor|windsurf)-server(-insiders)?\// },
    { label: 'extension d\'éditeur', pattern: /\/\.(vscode|vscode-insiders|vscodium|cursor|windsurf)\/extensions\// },
    { label: 'serveur de langage', pattern: /language-?server|langserver|\blsp\b|\btsserver\b|\bsvelteserver\b|eslintServer|\b(gopls|rust-analyzer|clangd|pylsp|jdtls)\b/i },
    { label: 'serveur MCP', pattern: /\bmcp\b|mcp[-_]?server|modelcontextprotocol/i },
    { label: 'session Claude Code', pattern: /(^|\/)claude(\s|$)|claude-code/ },
];
/** The protected tool the process is (label), or null. */
export function protectedTool(info) {
    const text = `${info.exe ?? ''}\n${info.command}`;
    return PROTECTED_TOOLS.find(t => t.pattern.test(text))?.label ?? null;
}
/** Worktrees of the repository that contains `path` (`git worktree list`), main checkout first, canonical paths. */
export function repositoryWorktrees(path) {
    const out = gitRead(path, ['worktree', 'list', '--porcelain']);
    if (out === null)
        throw new PipelineError('NOT_A_REPOSITORY', `Pas un dépôt Git : ${path}`);
    return out.split('\n').filter(line => line.startsWith('worktree ')).map(line => {
        const dir = line.slice('worktree '.length);
        try {
            return realpathSync(dir);
        }
        catch {
            return dir;
        }
    });
}
/** The worktree that contains `dir` (the deepest, for a worktree nested in another), or null. */
export function worktreeOf(dir, worktrees) {
    if (dir === null)
        return null;
    const inside = worktrees.filter(w => dir === w || dir.startsWith(w.endsWith('/') ? w : `${w}/`));
    return inside.sort((a, b) => b.length - a.length)[0] ?? null;
}
/** Whether the process is still the one that was listed (same pid, same start time) and not a zombie. */
export function sameProcessAlive(info, root = PROC_ROOT) {
    const stat = readStat(root, info.pid);
    return stat !== null && stat.start === info.start && !stat.zombie;
}
/**
 * Stops the processes: SIGTERM to all, then SIGKILL to those still alive after `graceMs`, then a short wait.
 * A signal goes only to the process that was listed (same start time): a pid reused meanwhile is left alone.
 */
export async function stopProcesses(targets, options) {
    const root = options.root ?? PROC_ROOT;
    const poll = options.pollMs ?? 100;
    const outcome = new Map();
    const signal = (info, name) => {
        if (!sameProcessAlive(info, root)) {
            outcome.set(info.pid, outcome.get(info.pid) ?? 'gone');
            return false;
        }
        try {
            process.kill(info.pid, name);
            return true;
        }
        catch (error) {
            const code = error.code;
            outcome.set(info.pid, code === 'ESRCH' ? 'gone' : 'denied');
            return false;
        }
    };
    const waitGone = async (list, ms) => {
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
    for (const p of termed)
        if (!afterTerm.includes(p))
            outcome.set(p.pid, 'terminated');
    const killed = afterTerm.filter(p => signal(p, 'SIGKILL'));
    const afterKill = await waitGone(killed, 2000);
    for (const p of killed)
        outcome.set(p.pid, afterKill.includes(p) ? 'survived' : 'killed');
    return outcome;
}
//# sourceMappingURL=procs.js.map