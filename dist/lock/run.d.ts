import type { LockOwner, LockRecord, LockStore, WaitInfo } from './store.js';
export declare const LOCK_WAIT_TIMEOUT_EXIT = 75;
export interface RunLockedOptions {
    owner: LockOwner;
    ttlSeconds: number;
    waitSeconds: number;
    purpose: string;
    command: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    stderr: (s: string) => void;
    /** Delay between SIGTERM forwarded to the command and SIGKILL. */
    killGraceMs?: number;
    /** Heartbeat interval; defaults to a third of the lease, between 200 ms and 60 s. */
    heartbeatMs?: number;
}
export declare function signalExitCode(signal: NodeJS.Signals): number;
export declare function describeHolder(record: LockRecord | null): string;
/** Prints the holder and queue position when they change, and at most every 30 s otherwise. */
export declare function waitReporter(resource: string, stderr: (s: string) => void): (info: WaitInfo) => void;
/**
 * Acquires the lock, runs the command, keeps the lease alive while it runs and always releases:
 * normal exit, failure, spawn error, or SIGINT/SIGTERM/SIGHUP (forwarded to the command).
 * Returns the command's exit code (128 + signal when interrupted).
 */
export declare function runLocked(store: LockStore, resource: string, options: RunLockedOptions): Promise<number>;
