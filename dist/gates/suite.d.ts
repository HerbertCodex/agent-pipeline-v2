import type { SuiteQueueSettings } from '../config/load.js';
import type { Gate } from '../domain/contracts.js';
import type { Git } from '../execution/git.js';
import { type StopOutcome, type StopRefusal } from '../execution/procs.js';
/**
 * The full suite of `apv gates run` (docs/APV3-SPEC.md, section 17): the machine queue taken before its first check,
 * the load threshold, the ports freed from orphans of the same copy, and the locks of the checks that share a
 * resource with other copies (a test stack). Every wait happens before the timeout of a check starts.
 */
/** Lease of a lock held by apv itself: renewed every third, lost within this delay when apv dies without releasing. */
export declare const LEASE_TTL_SECONDS = 120;
/** What tests inject: the load average and the polling delays. */
export interface SuiteHooks {
    /** 1-minute load average; default `os.loadavg()[0]`. */
    loadAverage?: () => number;
    /** Delay between two readings of the load (default 15 s). */
    loadPollMs?: number;
    /** Polling of the lock queues (default: that of `apv lock`, 500 ms). */
    lockPollMs?: number;
}
export interface QueueRecord {
    lockFile: string;
    /** Time spent in the queue before holding its lock. */
    waitedMs: number;
    /** Who held the lock when the run arrived, when it had to wait. */
    heldBy: string | null;
    /** The load threshold, when `maxLoad` is set. */
    load: {
        max: number;
        atStart: number;
        waitedMs: number;
        exceeded: boolean;
    } | null;
}
export interface QueueHandle {
    record: QueueRecord;
    release(): Promise<void>;
}
/** A path of the configuration: absolute as is, else relative to the Git common directory of `repo`. */
export declare function commonPath(git: Git, repo: string, path: string): Promise<string>;
/**
 * Enters the queue of the full suites: the lease `settings.lockFile` (FIFO of `apv lock`, the same store format), then,
 * lock held, the wait for the 1-minute load to drop under `maxLoad` (at most `loadWaitMs`, then the suite starts anyway,
 * noted). A lock not obtained within `waitMs` is a refusal (`SUITE_QUEUE`), nothing has run.
 */
export declare function enterQueue(options: {
    lockFile: string;
    settings: SuiteQueueSettings;
    repo: string;
    log: (line: string) => void;
    signal?: AbortSignal | undefined;
    hooks?: SuiteHooks | undefined;
}): Promise<QueueHandle>;
/** Waits for the 1-minute load average to drop under `max`, at most `limitMs`; journaled at most every minute. */
export declare function waitForLoad(max: number, limitMs: number, log: (line: string) => void, signal?: AbortSignal, hooks?: SuiteHooks): Promise<{
    max: number;
    atStart: number;
    waitedMs: number;
    exceeded: boolean;
}>;
export interface PortProcess {
    pid: number;
    ports: number[];
    command: string;
    worktree: string | null;
}
export interface PortsRecord {
    ports: number[];
    /** Orphans of this copy stopped, with the outcome of `apv procs stop`. */
    stopped: (PortProcess & {
        outcome: StopOutcome;
    })[];
    /** Processes on these ports left running, with the reason (another copy, the main checkout, a protected tool...). */
    left: (PortProcess & {
        reason: StopRefusal;
    })[];
    /** Why nothing could be read (a system without /proc), else null. */
    unsupported: string | null;
}
/**
 * Frees the declared ports from the orphans of the copy `repo` (a linked worktree): processes that listen there and
 * whose working directory is in that copy are stopped as `apv procs stop` does (SIGTERM, SIGKILL after the grace, a
 * reused pid spared). Never a process of another copy, of the main checkout, outside the repository, a protected tool
 * or the session: those are only reported.
 */
export declare function freePorts(repo: string, ports: readonly number[], options: {
    graceMs?: number;
    log: (line: string) => void;
}): Promise<PortsRecord>;
/** Lock of a check (`lock` of the gate), resolved to its absolute place. */
export type GateLock = {
    kind: 'lease';
    resource: string;
    dir: string;
    waitMs: number;
} | {
    kind: 'flock';
    file: string;
    waitMs: number;
};
/** Where the lock of a check lives: the `apv lock` store for a lease, the file (or its variable) for a flock. */
export declare function resolveGateLock(git: Git, repo: string, lock: NonNullable<Gate['lock']>, env: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv): Promise<GateLock>;
/**
 * Holds the lease of a check around `run`. Already held by an ancestor (`APV_LOCK_HELD` of the source environment,
 * as `apv lock run` sets it): not taken again. The command receives `APV_LOCK_HELD` with the resource, so that an
 * `apv lock run <resource>` inside it does not wait for its own parent.
 */
export declare function withGateLease<T>(lock: Extract<GateLock, {
    kind: 'lease';
}>, options: {
    label: string;
    env: NodeJS.ProcessEnv;
    source: NodeJS.ProcessEnv;
    signal?: AbortSignal | undefined;
    log: (line: string) => void;
    hooks?: SuiteHooks | undefined;
}, run: (env: NodeJS.ProcessEnv, waitedMs: number) => Promise<T>, refused: (reason: string, waitedMs: number) => T): Promise<T>;
/** Exit code of `flock -E` when its wait expires. */
export declare const FLOCK_TIMEOUT_EXIT = 75;
/**
 * The command wrapped by `flock(1)`: the kernel lock of `file` is held by `flock`, an ancestor of the command (a
 * project script that proves the lock by an ancestor holder in `/proc/locks` sees it held); `sh` writes one byte on
 * fd 3 once the lock is held, then closes it and becomes the command (`runProcess` `waitReady`: the timeout starts
 * there).
 */
export declare function flockCommand(file: string, waitMs: number, command: readonly string[]): string[];
