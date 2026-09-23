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
export declare const runStateSchema: import("../domain/schema.js").Schema<{
    readonly schemaVersion: 1;
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
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
        readonly plan: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
        readonly integration: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
        readonly reviews: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
        readonly fixes: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
        readonly delivery: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
    };
    readonly waves: {
        readonly index: number;
        readonly foundation: boolean;
        readonly tasks: string[];
    }[];
    readonly tasks: Record<string, {
        readonly title: string;
        readonly dependsOn: string[];
        readonly wave: number;
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
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
        readonly fidelite: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly findings: number | null;
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
        readonly donnees: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly findings: number | null;
            readonly note: string | null;
            readonly updatedAt: string | null;
        };
        readonly rgpd: {
            readonly status: "failed" | "pending" | "running" | "done" | "skipped";
            readonly findings: number | null;
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
}
export type RunState = Omit<Mutable<Infer<typeof runStateSchema>>, 'events'> & {
    events: RunEvent[];
};
export type TaskEntry = RunState['tasks'][string];
export interface SpecTaskInput {
    id: string;
    title: string;
    dependsOn: string[];
}
export interface Wave {
    index: number;
    foundation: boolean;
    tasks: string[];
}
/**
 * Waves by topological layers of `dependsOn`. The spec format has no « foundation » marker (its task schema
 * refuses unknown properties), so the foundations are the first-layer tasks other tasks depend on: they form
 * wave 0, alone, written before the parallel waves open (incident 24). The other first-layer tasks join
 * wave 1 with the tasks of depth 1; a task of depth d is in wave d. Without any dependency, every task is in
 * wave 0. Tasks keep the order of the spec inside a wave. The graph must be acyclic (validated spec).
 */
export declare function computeWaves(tasks: SpecTaskInput[]): Wave[];
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
    now?: Date;
}
/** Refused transition: exit 1 (a control failed), unlike a malformed call. */
export declare class TransitionError extends PipelineError {
    constructor(message: string);
}
/**
 * Applies `apv run set` to a copy of the state and returns it with the event it added. Checks the transition,
 * the dependencies of a task that starts (all `done`), and the commit of a task that ends (`--commit`).
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
    }[];
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
 * `apv run next`: what to do now, deterministic, the basis of resuming after an interruption. A running task
 * whose worktree is gone, or that has no commit after its base (`--base` given when it started, else the base
 * of the execution), is to relaunch if its agent no longer runs.
 */
export declare function computeNext(state: RunState, probe: GitProbe): NextPlan;
export declare function readRunState(file: string): RunState;
/** Parses and validates the text of a state file; `file` only names it in the errors. */
export declare function parseRunStateText(text: string, file: string): RunState;
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
