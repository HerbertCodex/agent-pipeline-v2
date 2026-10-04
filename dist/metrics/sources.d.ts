import { type RunState } from '../run/state.js';
import type { GhRunner } from '../stack/github.js';
import { type PrData, type ReviewSeen, type StackEvent, type SuiteSeen } from './pr.js';
import { type PullRequestEnd, type RunMetrics, type SuiteCount } from './run.js';
/**
 * Sources of `apv metrics`, read only: nothing is written, fetched or locked. The state of an execution lives in the
 * worktree of its project lead (often `.claude/worktrees/run-<id>`) until the delivery commits it: every worktree of the
 * repository is read, then the history of every branch, and the most recent copy wins.
 */
/** Roots of the worktrees of the repository (`git worktree list`), the repository first; those that exist only. */
export declare function worktreeRoots(repo: string): string[];
export interface FoundState {
    state: RunState;
    source: string;
}
/**
 * Every execution state the repository holds, one per spec id, the most recent copy of each: the `.apv/state/run-*.json`
 * of each worktree, then the versions committed on any branch. An unreadable copy is skipped and named in `skipped`.
 */
export declare function findRunStates(repo: string, only?: string): {
    states: Map<string, FoundState>;
    skipped: string[];
};
/** The Git common directory of `repo`, absolute; null outside a repository. */
export declare function commonDirOf(repo: string): string | null;
/**
 * Commits of an execution: those reachable from its branch, its tasks and the commits of its journal, and not from its
 * base. The receipts and reviews of these commits are the ones of the execution.
 */
export declare function runCommits(repo: string, state: RunState): Set<string>;
/** A run of the shared receipt store and the commit its manifest names. */
export interface StoredRun {
    runId: string;
    dir: string;
    sha: string;
}
/** Runs of the shared receipt store (`<git common dir>/apv/receipts`) by commit, read once: only their manifest. */
export declare function storedRuns(common: string | null): StoredRun[];
/**
 * Runs of `apv gates run` on `commits`: only runs whose copy is intact (manifest digests) count. Start: the time in the
 * run identifier; end: when the run was copied into the shared store, at its end.
 */
export declare function suitesOn(runs: readonly StoredRun[], commits: ReadonlySet<string>): SuiteSeen[];
export declare function suiteCount(suites: readonly SuiteSeen[]): SuiteCount;
/** Lines of `.apv/state/stack.log` of every worktree, each once, in time order. */
export declare function stackEvents(repo: string): StackEvent[];
/** Time of the signed merge trace of a pull request (`apv stack merge`, `apv stack batch --merge`), or null. */
export declare function tracedMerge(common: string | null, pr: number): string | null;
/** Latest review record of each domain at each of `commits` (src/rules/reviews.ts), sealed or not. */
export declare function reviewsOn(common: string, commits: readonly string[]): ReviewSeen[];
export declare const PR_FIELDS = "number,title,url,state,headRefName,baseRefName,createdAt,mergedAt,additions,deletions,changedFiles,commits";
/** One pull request by `gh pr view`; the reason when `gh` failed or answered something else. */
export declare function viewPr(gh: GhRunner, n: number): Promise<{
    pr: PrData | null;
    error: string | null;
}>;
/** Numbers of the pull requests merged since `since` (`gh pr list --state merged`), most recent first. */
export declare function mergedPrs(gh: GhRunner, since: string, limit: number): Promise<{
    numbers: number[];
    error: string | null;
}>;
/** The pull request of a branch (`gh pr list --head`): the merged one first, else the most recent. */
export declare function prOfBranch(gh: GhRunner, branch: string): Promise<number | null>;
/**
 * The end of an execution: its pull request (named by the delivery, else found by its branch) and its merge (GitHub,
 * else the signed trace of the tool, else stack.log). `gh` null: offline, the trace and stack.log only.
 */
export declare function pullRequestEnd(input: {
    gh: GhRunner | null;
    common: string | null;
    state: RunState;
    named: number | null;
    stack: readonly StackEvent[];
}): Promise<PullRequestEnd | null>;
/**
 * The end of an execution without `gh` (`apv status`): the pull request its delivery names, merged at the time of its
 * signed merge trace, else of its `batch-merge` line in stack.log.
 */
export declare function offlineEnd(common: string | null, named: number | null, stack: readonly StackEvent[]): PullRequestEnd | null;
/** Number of executions `apv status` shows the measure of (section 11: « les trois derniers chiffres »). */
export declare const STATUS_RUNS = 3;
/** The measure of the last STATUS_RUNS executions created, offline and without the receipt store (`apv status`). */
export declare function recentMeasures(repo: string, count?: number): RunMetrics[];
