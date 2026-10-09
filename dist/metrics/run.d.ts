import { type ReviewDomain, type RunState, type RunStatus } from '../run/state.js';
/**
 * Time measure of one spec execution (docs/SHIFT-LEFT.md, section 11), computed from what the tool already wrote: the
 * timestamped events of `.apv/state/run-<id>.json`, the receipts of the full suites and the merge of its pull request.
 * Nothing is typed by hand. Pure: the caller reads the sources (src/metrics/sources.ts).
 */
/** Phases of an execution, each ending at a milestone of the journal; the first starts when the execution is created. */
export declare const PHASES: readonly ["data-model", "plan", "code", "integration", "reviews", "fixes", "delivery", "merge-wait"];
export type PhaseName = typeof PHASES[number];
export declare const PHASE_LABEL: Record<PhaseName, string>;
export type PhaseStatus = 'done' | 'skipped' | 'running' | 'pending';
export interface PhaseMeasure {
    phase: PhaseName;
    status: PhaseStatus;
    /** End of the previous phase (or creation of the execution); null while an earlier phase is not finished. */
    startedAt: string | null;
    /** The milestone that ends it: last `done` (or `skipped`) of its step, last task finished, merge of the pull request. */
    endedAt: string | null;
    ms: number | null;
}
export interface TaskTiming {
    id: string;
    dependsOn: string[];
    wave: number;
    status: RunStatus;
    /** First move to `running`, last move to `done`; null when absent from the journal. */
    startedAt: string | null;
    endedAt: string | null;
    ms: number | null;
    /** Moves to `running` (1 for a task run once; more for a relaunch). */
    starts: number;
}
export interface CriticalPath {
    /** Longest chain of dependent tasks, weighted by their measured duration, from the first to the last. */
    chain: string[];
    /** Sum of the durations of the tasks of the chain. */
    workMs: number | null;
    /** First start to last end of the tasks: the code phase as it was lived. */
    spanMs: number | null;
    /** Span minus the work of the chain: waiting for an integration, an agent, a lock. */
    waitMs: number | null;
    /** False while a task is not finished: the chain is then measured on the finished tasks only. */
    complete: boolean;
}
export interface SuiteCount {
    /** Full suites (`apv gates run --stage full`) on a commit of the execution, their duration end to end, those that failed. */
    full: number;
    fullMs: number;
    fullFailed: number;
    /** Runs of the task level (`--stage task`), with `--since` or not. */
    task: number;
    /** Impact suites (section 9): the mechanism is not delivered yet; null until it is. */
    impact: number | null;
}
export interface PullRequestEnd {
    number: number;
    url: string | null;
    createdAt: string | null;
    mergedAt: string | null;
    source: string;
}
export interface RunMetrics {
    specId: string;
    /** Where the state was read: a file of a worktree, or a commit (`<sha>:<path>`). */
    source: string;
    createdAt: string;
    updatedAt: string;
    /** Spec validated (execution created) to merge; to the delivery, or the last event, while the merge is not known. */
    end: {
        at: string;
        kind: 'merge' | 'delivery' | 'last-event';
    };
    totalMs: number;
    finished: boolean;
    phases: PhaseMeasure[];
    tasks: TaskTiming[];
    waves: number;
    criticalPath: CriticalPath;
    /** Quota pauses (`apv run pause`), counted in the phases they fall in. */
    pausedMs: number;
    reviews: {
        domain: ReviewDomain;
        status: RunStatus;
        findings: number | null;
        launches: number;
    }[];
    /** Fix passes: moves of the `fixes` step to `running`. */
    fixPasses: number;
    /** Full suites launched out of the rhythm (`apv gates run --reason`, event `gates:full`). */
    fullSuiteOverrides: number;
    suites: SuiteCount | null;
    /** Contested tests and surviving mutations (sections 5.5 and 6): not measured before phase 5 delivers them. */
    contestations: number | null;
    survivingMutations: number | null;
    pr: PullRequestEnd | null;
}
export declare function taskTimings(state: RunState): TaskTiming[];
/**
 * Critical path of the code phase: the chain of dependencies whose summed measured durations is the longest. A task in
 * parallel with a longer one adds nothing to it. Ties go to the first task in spec order, then to the first dependency.
 */
export declare function criticalPath(tasks: readonly TaskTiming[]): CriticalPath;
/** Quota pauses of the journal: from each `pause` event to `pending` up to the next `pause` event to `running` (or `until`). */
export declare function pausedMs(state: RunState, now: string): number;
export interface MeasureInput {
    state: RunState;
    source: string;
    /** Full suites and task runs on the commits of the execution; null when the receipt store could not be read. */
    suites?: SuiteCount | null;
    pr?: PullRequestEnd | null;
}
/** The measure of one execution: phases chained milestone to milestone, the critical path of the code phase, the counts. */
export declare function measureRun(input: MeasureInput): RunMetrics;
/** The pull request a delivery names in its note: an address `…/pull/<n>` first, else « PR #<n> ». */
export declare function deliveredPullRequest(state: RunState): number | null;
export declare const median: (values: readonly number[]) => number | null;
/** Signed gap of `value` to `base`, in percent rounded to the unit; null without a base. */
export declare const gapPercent: (value: number | null, base: number | null) => number | null;
export interface RunBaseline {
    /** The executions it is computed on: the last `count` merged ones created before the one compared (or the last ones). */
    specs: string[];
    totalMs: number | null;
    criticalWorkMs: number | null;
    codeSpanMs: number | null;
}
/** Number of past executions of the comparison base (section 11: « les trois dernières specs »). */
export declare const BASELINE_RUNS = 3;
/**
 * Base of comparison: the median of the last BASELINE_RUNS executions merged before `target` was created (all merged
 * ones but `target` when none is older). Median, not mean: one execution stopped overnight does not move it.
 */
export declare function runBaseline(all: readonly RunMetrics[], target?: RunMetrics, count?: number): RunBaseline;
/** `1 h 05 min`, `42 min`, `36 s`; `?` for an unknown duration. */
export declare function duration(value: number | null): string;
export declare const signedPercent: (p: number | null) => string;
