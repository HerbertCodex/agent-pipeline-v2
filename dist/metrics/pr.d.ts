/**
 * Time measure of one pull request (docs/SHIFT-LEFT.md, section 11): opened, ready, first merge attempt, merged, with
 * the reviews recorded and the full suites run on its commits. From `gh pr view`, `.apv/state/stack.log`, the signed
 * merge traces, the review records and the receipt store; nothing typed by hand. Pure.
 */
export interface PrCommit {
    oid: string;
    committedDate: string;
}
export interface PrData {
    number: number;
    title: string;
    url: string;
    state: string;
    headRefName: string;
    baseRefName: string;
    createdAt: string;
    mergedAt: string | null;
    additions: number;
    deletions: number;
    changedFiles: number;
    commits: PrCommit[];
}
/** A line of `.apv/state/stack.log` that names the pull request (`pr`, or in `prs`). */
export interface StackEvent {
    at: string;
    event: string;
    pr: number | null;
    prs: number[];
    /** Lot branch and commit that carried the pull request (`batch-merge`): the suite of the lot proved the merge. */
    lot: string | null;
    lotCommit: string | null;
}
export interface ReviewSeen {
    commit: string;
    domain: string;
    at: string;
    sealed: boolean;
}
export interface SuiteSeen {
    runId: string;
    candidateSha: string;
    stage: string | null;
    full: boolean;
    ok: boolean | null;
    startedAt: string;
    endedAt: string | null;
}
export type PrKind = 'spec' | 'minime';
export interface PrMetrics {
    number: number;
    title: string;
    url: string;
    state: string;
    headRefName: string;
    /** `spec` when its head is the branch of a spec execution, `minime` otherwise (configuration, registre, maquette, docs). */
    kind: PrKind;
    spec: string | null;
    size: {
        files: number;
        additions: number;
        deletions: number;
        commits: number;
    };
    createdAt: string;
    mergedAt: string | null;
    /** Ready: its content final, the latest of its opening and of its last commit. */
    readyAt: string;
    /** First run of `apv stack merge` or `apv stack batch` that named it (the merge was asked), from stack.log; null when absent. */
    firstMergeAttemptAt: string | null;
    openToMergeMs: number | null;
    /** Ready to merged: the target of section 11 (30 min for the lane without code, 40 for the settings lane). */
    readyToMergeMs: number | null;
    /** Ready to the first merge attempt: waiting for the operator's order. Null without an attempt in stack.log. */
    orderWaitMs: number | null;
    /** First merge attempt to merged: the batch, its suite, a stop and a new attempt. */
    mergeMs: number | null;
    batchStops: number;
    reviews: {
        count: number;
        sealed: number;
        domains: string[];
        firstAt: string | null;
        lastAt: string | null;
    };
    suites: {
        full: number;
        fullMs: number;
        fullFailed: number;
        task: number;
    } | null;
}
export declare function measurePr(input: {
    pr: PrData;
    spec: string | null;
    stack: readonly StackEvent[];
    reviews: readonly ReviewSeen[] | null;
    suites: readonly SuiteSeen[] | null;
}): PrMetrics;
/**
 * Commits of the lots that merged pull request `n` (stack.log, `batch-merge`): every commit of such a lot, since its
 * suite runs once at the top of the lot and proves each pull request it carries.
 */
export declare function lotCommits(stack: readonly StackEvent[], n: number): string[];
/** Number of past minimal pull requests of the comparison base (section 11: « les cinq dernières PR minimes »). */
export declare const BASELINE_PRS = 5;
export interface PrBaseline {
    prs: number[];
    readyToMergeMs: number | null;
    openToMergeMs: number | null;
    orderWaitMs: number | null;
    mergeMs: number | null;
}
/** Median of the last BASELINE_PRS merged minimal pull requests (by merge date). */
export declare function prBaseline(all: readonly PrMetrics[], count?: number): PrBaseline;
/** Reads one `gh pr view --json` answer; null when it is not a pull request. */
export declare function parsePrData(text: string): PrData | null;
/** Reads the lines of `.apv/state/stack.log` that name pull requests; unreadable lines are left out. */
export declare function parseStackLog(text: string): StackEvent[];
