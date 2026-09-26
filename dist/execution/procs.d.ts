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
export declare const PROC_ROOT = "/proc";
/** Refuses clearly on a system without `/proc` (macOS, Windows): nothing can be listed there. */
export declare function assertProcSupported(root?: string): void;
/** Listening TCP sockets: inode to port, from `/proc/net/tcp` and `/proc/net/tcp6` (state 0A). */
export declare function listeningInodes(root?: string): Map<string, number>;
/** One process, or null when it is gone. */
export declare function readProcess(pid: number, root?: string, inodes?: Map<string, number>): ProcessInfo | null;
/** Every process visible in `/proc`, with its listening ports. */
export declare function listProcesses(root?: string): ProcessInfo[];
/** The current process and its ancestors: never stopped (the session that runs the command, its shell). */
export declare function protectedPids(root?: string, self?: number): Set<number>;
/** Worktrees of the repository that contains `path` (`git worktree list`), main checkout first, canonical paths. */
export declare function repositoryWorktrees(path: string): string[];
/** The worktree that contains `dir` (the deepest, for a worktree nested in another), or null. */
export declare function worktreeOf(dir: string | null, worktrees: readonly string[]): string | null;
/** Whether the process is still the one that was listed (same pid, same start time) and not a zombie. */
export declare function sameProcessAlive(info: Pick<ProcessInfo, 'pid' | 'start'>, root?: string): boolean;
export type StopOutcome = 'terminated' | 'killed' | 'survived' | 'gone' | 'denied';
/**
 * Stops the processes: SIGTERM to all, then SIGKILL to those still alive after `graceMs`, then a short wait.
 * A signal goes only to the process that was listed (same start time): a pid reused meanwhile is left alone.
 */
export declare function stopProcesses(targets: readonly ProcessInfo[], options: {
    graceMs: number;
    pollMs?: number;
    root?: string;
}): Promise<Map<number, StopOutcome>>;
