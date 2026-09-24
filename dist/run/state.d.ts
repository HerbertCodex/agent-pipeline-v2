import { PipelineError } from '../domain/errors.js';
import { type Infer } from '../domain/schema.js';
/** Resume state of a spec execution: `.apv/state/run-<spec-id>.json`, versioned with the project (spec section 8). */
export declare const RUN_STATE_DIR = ".apv/state";
export declare const runStateFile: (repo: string, specId: string) => string;
export declare const RUN_ID: RegExp;
export declare const STATUSES: readonly ["pending", "running", "done", "failed", "skipped"];
export type RunStatus = typeof STATUSES[number];
/** Steps of `/apv:run` in their order (spec section 8); the task waves happen between `plan` and `integration`. */
export declare const STEPS: readonly ["data-model", "plan", "integration", "reviews", "fixes", "delivery"];
export type StepName = typeof STEPS[number];
/** Independent reviews (spec section 8, step 5): security, fidelity, data, GDPR. */
export declare const REVIEWS: readonly ["securite", "fidelite", "donnees", "rgpd"];
export type ReviewDomain = typeof REVIEWS[number];
export declare const STATUS_LABEL: Record<RunStatus, string>;
export declare const STEP_LABEL: Record<StepName | 'waves', string>;
/**
 * Version 2: the foundation marker moved from the wave (v1, « the whole wave 0 ») to the task. A v1 state is
 * migrated when read (`migrateRunState`) and written back as v2 on its next write.
 */
export declare const RUN_STATE_VERSION = 2;
export declare const runStateSchema: import("../domain/schema.js").Schema<{
    readonly schemaVersion: 2;
    readonly specId: string;
    readonly specFile: string;
    readonly specSha256: string;
    readonly base: string;
    readonly baseSha: string;
    readonly branch: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly steps: {
        readonly 'data-model': {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly commit: string | null;
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
        readonly plan: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly commit: string | null;
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
        readonly integration: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly commit: string | null;
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
        readonly reviews: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly commit: string | null;
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
        readonly fixes: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly commit: string | null;
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
        readonly delivery: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly commit: string | null;
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
    };
    readonly waves: {
        readonly index: number;
        readonly tasks: string[];
    }[];
    readonly tasks: Record<string, {
        readonly title: string;
        readonly dependsOn: string[];
        readonly wave: number;
        readonly foundation: boolean;
        readonly status: "failed" | "pending" | "running" | "done" | "skipped";
        readonly branch: string | null;
        readonly worktree: string | null;
        readonly agentId: string | null;
        readonly base: string | null;
        readonly commit: string | null;
        readonly note: string | null;
        readonly updatedAt: string | null;
    }>;
    readonly reviews: {
        readonly securite: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly findings: number | null;
            readonly commit: string | null;
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
        readonly fidelite: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly findings: number | null;
            readonly commit: string | null;
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
        readonly donnees: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly findings: number | null;
            readonly commit: string | null;
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
        readonly rgpd: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly findings: number | null;
            readonly commit: string | null;
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
    };
    readonly events: {
        readonly at: string;
        readonly target: string;
        readonly from: "failed" | "pending" | "running" | "done" | "skipped" | null;
        readonly to: "failed" | "pending" | "running" | "done" | "skipped";
        readonly note: string | undefined;
        readonly commit: string | undefined;
        readonly agentId: string | undefined;
        readonly unintegrated: string[] | undefined;
    }[];
}>;
/** Plain mutable view of the parsed state (the schema types are read-only). */
type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? {
    -readonly [K in keyof T]: Mutable<T[K]>;
} : T;
export interface RunEvent {
    at: string;
    target: string;
    from: RunStatus | null;
    to: RunStatus;
    note?: string;
    commit?: string;
    agentId?: string;
    unintegrated?: string[];
}
export type RunState = Omit<Mutable<Infer<typeof runStateSchema>>, 'events'> & {
    events: RunEvent[];
};
export type TaskEntry = RunState['tasks'][string];
/**
 * A state of version 1 in the shape of version 2, the plan it recorded kept: under the v1 rule a wave marked
 * `foundation` held only foundations, so each of its tasks becomes a foundation task, every other task is not
 * one, and the wave loses its marker. Anything else is returned as is, for the schema to judge. Pure: the
 * input is never modified.
 */
export declare function migrateRunState(value: unknown): unknown;
export interface SpecTaskInput {
    id: string;
    title: string;
    dependsOn: string[];
}
export interface Wave {
    index: number;
    tasks: string[];
}
/** Least number of tasks that depend directly on a task for it to be a foundation. */
export declare const FOUNDATION_MIN_DEPENDENTS = 2;
/**
 * Waves: the topological layers of `dependsOn`. A task of depth d (0 without dependency, else one more than
 * its deepest dependency) is in wave d. Tasks keep the order of the spec inside a wave. The graph must be
 * acyclic (validated spec).
 */
export declare function computeWaves(tasks: SpecTaskInput[]): Wave[];
/**
 * The foundations: the tasks at least FOUNDATION_MIN_DEPENDENTS other tasks depend on directly, in spec order.
 * They write what several tasks share (incident 24); in their wave, one agent writes them while the other tasks
 * of the wave run in parallel. One dependent is not enough: a task that only one other task needs is an
 * ordinary dependency (the phase 3 trial had BIN wait alone because DOCS depended on it).
 */
export declare function computeFoundations(tasks: SpecTaskInput[]): string[];
/** The foundations and the other tasks of one wave, each in wave order. */
export declare function splitWave(state: Pick<RunState, 'tasks'>, wave: Wave): {
    foundations: string[];
    parallel: string[];
};
export interface NewRunInput {
    specId: string;
    specFile: string;
    specSha256: string;
    base: string;
    baseSha: string;
    tasks: SpecTaskInput[];
    now?: Date;
}
export declare function createRunState(input: NewRunInput): RunState;
export type Target = {
    kind: 'step';
    name: StepName;
} | {
    kind: 'task';
    id: string;
} | {
    kind: 'review';
    domain: ReviewDomain;
};
/** `data-model`, `task:<id>` or `review:<domaine>`; null when the text names none of them. */
export declare function parseTarget(value: string): Target | null;
export declare const targetName: (t: Target) => string;
export interface SetOptions {
    status: RunStatus;
    branch?: string;
    worktree?: string;
    agentId?: string;
    commit?: string;
    base?: string;
    note?: string;
    findings?: number;
    /** Where the commits of the dependencies of a task that starts must already be; absent: nowhere. */
    integration?: IntegrationCheck;
    /** Starts the task although a dependency is not integrated; needs `note`, journaled with the dependencies. */
    forceUnintegrated?: boolean;
    now?: Date;
}
/**
 * The integration head of an execution: the branch of the spec (`branch` of the state), or the base commit of
 * the execution while that branch does not exist yet. A dependency is integrated when its recorded commit is
 * an ancestor of that head.
 */
export interface IntegrationCheck {
    /** Commit of the head. */
    head: string;
    /** The head as shown to a human: the branch, or the base when the branch does not exist yet. */
    where: string;
    integrated(commit: string): boolean;
}
/** The integration head of `state` as the probe sees the repository. */
export declare function integrationCheck(state: RunState, probe: GitProbe): IntegrationCheck;
/**
 * The dependencies of a task split by readiness: `notDone` (not `done`) and `notIntegrated` (`done`, but their
 * commit is missing or not an ancestor of the integration head). A task is ready when both are empty.
 */
export declare function dependencyGaps(state: RunState, task: TaskEntry, integration: IntegrationCheck | undefined): {
    notDone: string[];
    notIntegrated: string[];
};
/** Refused transition: exit 1 (a control failed), unlike a malformed call. */
export declare class TransitionError extends PipelineError {
    constructor(message: string);
}
/**
 * Applies `apv run set` to a copy of the state and returns it with the event it added. Checks the transition,
 * the dependencies of a task that starts (all `done`, and integrated: their commit in the integration head,
 * unless `forceUnintegrated` with a note), and the commit of a task that ends (`--commit`).
 * Commit existence is checked by the caller, which owns the repository.
 */
export declare function applySet(state: RunState, target: Target, options: SetOptions): {
    state: RunState;
    from: RunStatus;
    event: RunEvent;
};
/** Where the execution stands: the first unfinished step, with the waves between `plan` and `integration`. */
export declare function currentStep(state: RunState): {
    step: StepName | 'waves' | null;
    wave: number | null;
};
/** Repository probes used by `next`; injected so the decision stays a pure function in tests. */
export interface GitProbe {
    exists(path: string): boolean;
    /** Commit a branch (or HEAD of a worktree when `worktree` is given) points to, or null. */
    resolve(ref: string, worktree?: string): string | null;
    /** Number of commits reachable from `head` and not from `base`, or null when unknown. */
    countAfter(base: string, head: string, worktree?: string): number | null;
    /** True when `commit` is an ancestor of `head` (`git merge-base --is-ancestor`); false when unknown. */
    isAncestor(commit: string, head: string): boolean;
}
export interface ResumeItem {
    id: string;
    branch: string | null;
    worktree: string | null;
    agentId: string | null;
    commit: string | null;
    head: string | null;
    commitsAfterBase: number | null;
    base: string;
}
export interface RelaunchItem extends ResumeItem {
    reason: string;
}
export interface NextPlan {
    specId: string;
    step: StepName | 'waves' | null;
    stepStatus: RunStatus | null;
    wave: number | null;
    finished: boolean;
    ready: {
        id: string;
        title: string;
        wave: number;
        foundation: boolean;
    }[];
    /** Dependencies all `done`, but some not integrated yet in the integration head. */
    awaitingIntegration: {
        id: string;
        wave: number;
        waitingOn: string[];
    }[];
    /** The integration head the readiness was measured on. */
    integration: {
        head: string;
        where: string;
    };
    resume: ResumeItem[];
    relaunch: RelaunchItem[];
    failed: {
        id: string;
        note: string | null;
    }[];
    blocked: {
        id: string;
        waitingOn: string[];
    }[];
    reviewsToLaunch: ReviewDomain[];
    reviewsRunning: ReviewDomain[];
    actions: string[];
}
/**
 * `apv run next`: what to do now, deterministic, the basis of resuming after an interruption. A task is ready
 * when its dependencies are `done` and their commits integrated in the branch of the spec (or in the base of
 * the execution while that branch does not exist); tasks are launched as soon as they are ready, not wave by
 * wave. A running task
 * whose worktree is gone, or that has no commit after its base (`--base` given when it started, else the base
 * of the execution), is to relaunch if its agent no longer runs.
 */
export declare function computeNext(state: RunState, probe: GitProbe): NextPlan;
/** How a state file is named in errors (path relative to the repository), and the spec id its name carries. */
export interface RunStateSource {
    shown?: string;
    specId?: string;
}
/**
 * Reads one state file (`apv run start|set|next|status <id>`) with the bounded read of the summary: a regular
 * file only (a FIFO named like the state never blocks), MAX_RUN_STATE_BYTES at most; errors name the file by
 * `shown` and never quote its content.
 */
export declare function readRunState(file: string, source?: RunStateSource): RunState;
/**
 * Parses and validates the text of a state file. `shown` names it in the errors, which never quote its content
 * (a JSON error keeps only its position). With `specId` (the id its file name carries), a state of another spec
 * is refused: the summary and `apv run next` would otherwise name one execution with the data of another.
 */
export declare function parseRunStateText(text: string, shown: string, specId?: string): RunState;
/** Atomic write: a temporary file in the same directory, flushed, then renamed over the target. */
export declare function writeRunState(file: string, state: RunState): void;
/** Every `run-<id>.json` of `.apv/state/`, in name order. */
export declare function listRunFiles(repo: string): {
    specId: string;
    file: string;
}[];
export interface RunSummary {
    specId: string;
    file: string;
    step: StepName | 'waves' | null;
    wave: number | null;
    finished: boolean;
    tasks: Record<RunStatus, number> & {
        total: number;
    };
    reviews: Record<ReviewDomain, RunStatus>;
    updatedAt: string;
    error: null;
}
export declare function summarize(state: RunState, file: string): RunSummary;
/**
 * One line for `apv status` and `apv run status`. `running` names the running tasks after their count
 * (ids of the state, already restricted to the task id pattern by the schema); the first ones only.
 */
export declare function summaryLine(sum: RunSummary, running?: readonly string[]): string;
/**
 * Runs `fn` under the lease lock `run:<spec-id>` (apv lock), so that two agents never interleave a
 * read-modify-write of the same state. The lock lives in the lock directory of the machine (APV_LOCK_DIR);
 * the wait is 60 s, or APV_RUN_LOCK_WAIT seconds.
 */
export declare function withRunLock<T>(specId: string, env: NodeJS.ProcessEnv, fn: () => T | Promise<T>): Promise<T>;
export {};
