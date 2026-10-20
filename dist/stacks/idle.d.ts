import { type ApvConfig } from '../config/load.js';
import { type StackConfig } from './config.js';
/**
 * Idle test stacks (docs/APV3-SPEC.md, section 18.4): a stack is stopped only on the evidence of a continuous series
 * of observations that found it free (no lock of the stack held, no full suite running, nothing listening on its
 * ports) for at least the idle delay, with no known use since the series started. A single observation never stops
 * anything; two observations further apart than `MAX_GAP_MS` restart the series (nothing proves the stack stayed free
 * in between). The stop runs under the lock of the stack and of the suite queue, both taken without waiting.
 */
/** Longest gap between two observations of one idle series. */
export declare const MAX_GAP_MS = 120000;
/** Delay between two observations of `apv stacks idle-stop --watch`. */
export declare const WATCH_INTERVAL_MS = 30000;
/** A declared stack with its paths made absolute. */
export interface ResolvedStack {
    config: StackConfig;
    id: string;
    lockFile: string | null;
    resource: string | null;
    envFile: string | null;
}
/** What is kept between two passes, in `<git common dir>/apv/stacks/<id>.json`. */
export interface StackRecord {
    version: 1;
    id: string;
    lastObservedAt: string | null;
    /** Last time the stack was seen or known in use (lock held, ports listening, a check of apv gates run under its lock). */
    lastUsedAt: string | null;
    /** Start of the current series of observations that found it free; null when it is busy or unknown. */
    freeSince: string | null;
    stoppedAt: string | null;
    startedAt: string | null;
    /** Last check of `apv gates run` that passed under its lock: the stack answered then. */
    upAt: string | null;
}
export interface Observation {
    id: string;
    /** Why the stack is busy now (lock held, suite running, port listening), empty when free. */
    busy: string[];
    /** Time the stack has been free by the series of observations; 0 when busy or the series just started. */
    idleMs: number;
    record: StackRecord;
}
/** The Git common directory of `repo`, absolute. */
export declare function commonDir(repo: string): string;
export declare function resolveStacks(config: ApvConfig, common: string): ResolvedStack[];
export declare const stacksDir: (common: string) => string;
export declare function readRecord(common: string, id: string): StackRecord;
export declare function writeRecord(common: string, record: StackRecord): void;
/** Appends one decision to `<git common dir>/apv/stacks/events.log` (one JSON object per line, rotated at 1 MB). */
export declare function journal(common: string, entry: Record<string, unknown>): void;
/** Notes a known use of the stacks (a check of `apv gates run` under their lock that just ended). */
export declare function markStacksUsed(common: string, ids: readonly string[], passed?: boolean, at?: Date): void;
/** The stacks whose lock is the lock of this check (same flock file, or same lease resource). */
export declare function stacksOfLock(stacks: readonly ResolvedStack[], lock: {
    kind: 'lease';
    resource: string;
} | {
    kind: 'flock';
    file: string;
}): string[];
/**
 * Whether a kernel lock (`flock`) on `file` is held by this process or one of its ancestors (read in `/proc/locks`):
 * a suite launched under the lock of its stack (`flock <lockFile> apv gates run ...`) holds it already. The lock is the
 * same inode on the same device; some file systems print another device there than `stat` gives (btrfs subvolumes), and
 * the same inode then counts when that ancestor holds the file open. Init (pid 1) is never counted. False when
 * unreadable (another system, file absent): the lock then counts as another's.
 */
export declare function flockHeldByAncestor(file: string, ancestors?: ReadonlySet<number>, locksPath?: string, procRoot?: string): boolean;
/** Whether the flock of `file` is free now: taken and released at once (`flock -n`). Null when unknown. */
export declare function flockFree(file: string): boolean | null;
export interface ProbeContext {
    repo: string;
    common: string;
    config: ApvConfig;
    env: NodeJS.ProcessEnv;
}
/** Why the stack is busy now; empty when it is free. */
export declare function probe(stack: ResolvedStack, context: ProbeContext): string[];
/**
 * One observation of a stack: busy now, or free, and since when by the series of observations. Writes the record.
 * A known use after the start of the series (a lease event, a check of apv gates run) moves its start there.
 */
export declare function observe(stack: ResolvedStack, context: ProbeContext, now?: number): Observation;
export type IdleDecision = {
    id: string;
    action: 'stopped';
    idleMs: number;
    output: string;
} | {
    id: string;
    action: 'failed';
    idleMs: number;
    output: string;
} | {
    id: string;
    action: 'would-stop';
    idleMs: number;
} | {
    id: string;
    action: 'kept';
    idleMs: number;
    reason: string;
};
/**
 * Runs `argv` under the lock of the stack and the suite queue, both taken without waiting: `null` when one is held
 * (the stack is in use, nothing ran), else the outcome of the command.
 */
export declare function underStackLock(stack: ResolvedStack, context: ProbeContext, argv: readonly string[], label: string): Promise<{
    ok: boolean;
    output: string;
} | null>;
/**
 * One pass of `apv stacks idle-stop`: observes each stack, and stops those free for at least `afterMs` (the stack's
 * `idleAfterMs`, else the option, else 30 min) and not already stopped since their last use. Every decision is journaled.
 */
export declare function idlePass(stacks: readonly ResolvedStack[], context: ProbeContext, options: {
    afterMs?: number;
    dryRun: boolean;
    now?: number;
}): Promise<IdleDecision[]>;
/**
 * The stop by `apv stacks idle-stop` not followed by a restart: `stoppedAt` later than `apv stacks start` and than
 * the last check that passed under its lock. Null when the stack is not known to be stopped.
 */
export declare function stoppedSince(common: string, id: string): string | null;
/** What `stackHealth` found: every container running, some stopped or gone, none, or nothing readable. */
export interface StackHealth {
    state: 'running' | 'degraded' | 'absent' | 'unknown';
    detail: string;
    containers: StackContainer[];
    missing: string[];
}
export interface StackContainer {
    name: string;
    state: string;
}
/** The line format of `docker ps` read for a stack: name, state, then the two project labels. */
export declare const DOCKER_PS_FORMAT = "{{.Names}}\t{{.State}}\t{{.Label \"com.docker.compose.project\"}}\t{{.Label \"com.supabase.cli.project\"}}";
/** The containers of `project` in a `docker ps -a --format DOCKER_PS_FORMAT` output: a project label equal to it, or a name ending in `_<project>`. */
export declare function stackContainers(output: string, project: string): StackContainer[];
/** The containers of the stack now (`docker ps -a`, bounded, never changed), or why they cannot be read. */
export declare function readStackContainers(stack: ResolvedStack, repo: string, env: NodeJS.ProcessEnv, timeoutMs?: number): Promise<{
    containers: StackContainer[];
} | {
    error: string;
}>;
/**
 * The state of a stack after a check was interrupted under its lock (a cancelled suite, a timeout: a reset of its
 * database may have been cut halfway), from its containers now and, when read at the start of the suite, then: a
 * container gone since (a reset removes and recreates the database container) or not running is said.
 */
export declare function judgeStack(now: {
    containers: StackContainer[];
} | {
    error: string;
}, before: StackContainer[] | null): StackHealth;
