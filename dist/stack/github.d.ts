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
export declare const VIEW_FIELDS = "number,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,url";
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
    /** Web address of the pull request: its host, owner and repository name the REST calls. */
    url: string;
}
/** Check runs and commit statuses of `statusCheckRollup`, reduced to success, pending or failure. */
export declare function readChecks(rollup: unknown): CheckItem[];
export declare function parsePullRequest(text: string): PullRequest;
/** Where the REST API reaches a pull request: `repos/<owner>/<repo>/pulls/<n>` on its host, and its repository `repos/<owner>/<repo>`. */
export interface PullRequestPath {
    host: string;
    path: string;
    repo: string;
}
/**
 * The REST path of a pull request, read from the web address `gh pr view` gives for it: the same repository
 * that answered the read, host included (GitHub Enterprise). Null when the address is not the one of pull
 * request `n` (another number, unexpected form, owner or name with other characters than GitHub allows).
 */
export declare function pullRequestPath(pr: PullRequest): PullRequestPath | null;
/**
 * Arguments of the retarget: `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -f base=<target>`. The REST API
 * and not `gh pr edit --base`, whose GraphQL query also reads the classic projects of the pull request and
 * fails since their deprecation (seen on the real merge of PR #70 and #71).
 */
export declare function retargetArgs(where: PullRequestPath, target: string): string[];
/**
 * What the compare call keeps of the answer: the number of commits of the base the head lacks, how many of them
 * GitHub listed and how many are merge commits, the files they change since the merge base (null when GitHub did
 * not list them) and the merge base itself.
 */
export declare const FRESHNESS_JQ: string;
/**
 * Arguments of the freshness read: `gh api repos/<owner>/<repo>/compare/<head sha>...<base>`. In this order,
 * GitHub's `ahead_by` counts the commits of the base the head of the pull request does not contain, and `files`
 * lists what these commits change since the merge base: exactly what merging the base into the head would bring.
 */
export declare function compareArgs(where: PullRequestPath, head: string, base: string): string[];
/**
 * Whether the head of a pull request contains the current head of its base, read from GitHub:
 * - `up_to_date`: every commit of the base is in the head (`ahead_by` 0);
 * - `same_content`: the base has commits the head lacks, but they are all merge commits, all listed, and change no
 *   file since the merge base (the merge commit of the previous pull request of the stack, merged with
 *   `--merge`): merging the base into the head changes nothing, so the checks of the head bear on the result;
 * - `behind`: the base brings changes the head never saw (or GitHub did not list them): refused;
 * - `unknown`: the compare call failed or its answer is unreadable: refused, never taken as up to date.
 */
export type FreshnessState = 'up_to_date' | 'same_content' | 'behind' | 'unknown';
export interface Freshness {
    base: string;
    head: string;
    state: FreshnessState;
    /** Commits of the base the head does not contain; null when unknown. */
    missing: number | null;
    /** Files these commits change since the merge base (at most the first page GitHub lists); null when unknown. */
    files: string[] | null;
    mergeBase: string | null;
    error: string | null;
}
/** Reads the answer of the compare call (the object `FRESHNESS_JQ` builds). */
export declare function parseFreshness(text: string, base: string, head: string): Freshness;
/** Refusal of a pull request whose head lacks changes of its base, with the way to update it. */
export declare function behindReason(n: number, pr: PullRequest, f: Freshness): string;
/** Refusal of a pull request whose base could not be compared with its head. */
export declare function unknownReason(n: number, f: Freshness): string;
/** A pull request merged although its head lacks changes of its base (`--allow-behind`), journaled. */
export interface Derogation {
    pr: number;
    head: string;
    base: string;
    missing: number | null;
    files: string[] | null;
    reason: string;
}
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
    /**
     * `--allow-behind --reason`: exceptional waiver of the freshness rule. A pull request whose head lacks changes of
     * its base is then merged, never silently: `onDerogation` journals it first, and a failure to journal stops the stack.
     */
    allowBehind?: {
        reason: string;
    };
    /** Journals a waiver before the merge it allows; returns an error message when it could not. */
    onDerogation?: (derogation: Derogation) => string | null;
}
export interface PlannedPr {
    number: number;
    pr: PullRequest | null;
    expectedBase: string | null;
    anomalies: string[];
    /** Whether the head contains its expected base (null when not compared: PR unread, base unknown, address unreadable). */
    freshness: Freshness | null;
}
export interface StackPlan {
    target: string | null;
    prs: PlannedPr[];
    ok: boolean;
}
/**
 * `apv stack plan`: reads every pull request and checks the stack. Each one open, the base of PR n+1 is the
 * head of PR n (the target for the first), mergeable, checks green or absent, and its head contains the current
 * head of that base (compare of the REST API; see `Freshness`). All anomalies are listed.
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
    /** Freshness of each pull request against the target, read just before its merge. */
    freshness: Array<{
        pr: number;
    } & Freshness>;
    /** Pull requests merged behind their base by waiver (`--allow-behind`), each journaled before its merge. */
    derogations: Derogation[];
}
/**
 * `apv stack merge`: merges the stack in order and stops at the first anomaly. Before each merge the pull
 * request is read again and checked; once the previous one is merged, the next one is retargeted onto the
 * target by the REST API and the new base is verified by a new read, never trusted from an exit code (incident 30). The
 * merge passes `--match-head-commit`, so a head that moved since the check is refused by GitHub itself.
 */
export declare function mergeStack(numbers: number[], method: 'merge' | 'squash' | 'rebase', options: StackOptions): Promise<MergeReport>;
