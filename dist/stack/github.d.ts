/**
 * Message of a merge refused for lack of authorisation. Same text as `REASONS.merge` of the Bash hook
 * (hooks/scripts/bash-guard.mjs); a test keeps both equal.
 */
export declare const MERGE_REFUSED: string;
/** One `gh` call, kept whole: the command never hides the output of a call (incident 30). */
export interface GhCall {
    args: string[];
    status: number | null;
    stdout: string;
    stderr: string;
    error: string | null;
}
export type GhRunner = (args: string[]) => Promise<GhCall>;
/** Runs `gh` (or `APV_GH`) without a shell, with the caller's environment. */
export declare function processGh(bin: string, env: NodeJS.ProcessEnv, cwd: string): GhRunner;
export declare const VIEW_FIELDS = "number,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup";
export interface CheckItem {
    name: string;
    state: 'success' | 'pending' | 'failure';
}
export interface PullRequest {
    number: number;
    state: string;
    isDraft: boolean;
    baseRefName: string;
    headRefName: string;
    headRefOid: string;
    mergeable: string;
    mergeStateStatus: string;
    checks: CheckItem[];
}
/** Check runs and commit statuses of `statusCheckRollup`, reduced to success, pending or failure. */
export declare function readChecks(rollup: unknown): CheckItem[];
export declare function parsePullRequest(text: string): PullRequest;
/**
 * Every reason not to merge this pull request onto `expectedBase` now. Waiting states (`UNKNOWN`) count as
 * anomalies here: the caller polls them first.
 */
export declare function anomalies(pr: PullRequest, expectedBase: string, allowDraft: boolean): string[];
export interface StackOptions {
    gh: GhRunner;
    /** Called after each `gh` call with the whole call. */
    onCall: (call: GhCall) => void;
    /** Branch the whole stack lands on; the base of the first pull request when absent. */
    target?: string;
    /** Removes the draft status (`gh pr ready`) before merging. */
    ready: boolean;
    pollMs: number;
    pollAttempts: number;
}
export interface PlannedPr {
    number: number;
    pr: PullRequest | null;
    expectedBase: string | null;
    anomalies: string[];
}
export interface StackPlan {
    target: string | null;
    prs: PlannedPr[];
    ok: boolean;
}
/**
 * `apv stack plan`: reads every pull request and checks the stack. Each one open, the base of PR n+1 is the
 * head of PR n (the target for the first), mergeable, checks green or absent. All anomalies are listed.
 */
export declare function planStack(numbers: number[], options: StackOptions): Promise<StackPlan>;
export interface MergeReport {
    target: string | null;
    method: string;
    merged: number[];
    stopped: {
        pr: number;
        reasons: string[];
    } | null;
    plan: StackPlan;
}
/**
 * `apv stack merge`: merges the stack in order and stops at the first anomaly. Before each merge the pull
 * request is read again and checked; once the previous one is merged, the next one is retargeted onto the
 * target and the new base is verified by a new read, never trusted from an exit code (incident 30). The
 * merge passes `--match-head-commit`, so a head that moved since the check is refused by GitHub itself.
 */
export declare function mergeStack(numbers: number[], method: 'merge' | 'squash' | 'rebase', options: StackOptions): Promise<MergeReport>;
