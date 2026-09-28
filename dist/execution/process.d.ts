import type { ProcessResult } from '../domain/contracts.js';
export interface ProcessHooks {
    onStart?: (pid: number) => void;
    onFinish?: (pid: number) => void;
}
export interface ProcessOptions extends ProcessHooks {
    command: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    input?: string;
    maxOutputBytes?: number;
    /**
     * The command signals on file descriptor 3 (a pipe) when its real work starts, for instance once a wrapper holds
     * a lock: `timeoutMs` starts at the first byte read there, not at the spawn. The wait before it is unbounded here
     * (the wrapper bounds it). `readyMs` of the result says when it came.
     */
    waitReady?: boolean;
}
export declare function environment(names: readonly string[], source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function redact(text: string, env: NodeJS.ProcessEnv): string;
/** No shell expansion. POSIX process groups are terminated on cancellation AND
 * normal leader exit, so ordinary background children cannot outlive the task.
 * This is lifecycle management, not a sandbox against a hostile setsid() child. */
/** Delay after the direct child exits before stdio pipes still held by escaped descendants are closed. */
export declare const PIPE_GRACE_MS = 1000;
export declare function runProcess(options: ProcessOptions): Promise<ProcessResult>;
/** Only whole-argument substitutions are supported; never shell interpolation. */
export declare function expandCommand(command: readonly string[], context: Record<string, string>): string[];
