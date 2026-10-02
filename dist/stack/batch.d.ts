import { type GhCall, type GhRunner, type MergedHead, type PullRequest } from './github.js';
/**
 * Batch merge (docs/APV3-SPEC.md, section 18.5): several independent pull requests, each proven at the task level,
 * are merged into one integration branch made from the target, the full suite runs ONCE on its head, and, proven,
 * the pull requests are merged in the order of the batch. Each merge is checked by content: the tree of the target
 * before it must be the tree of the batch before that pull request, and after it the tree of the batch after it. The
 * head of each pull request lacks the merges of the batch before it: that gap is tolerated because the content merged
 * is the content proven. A failed suite can be bisected to put the faulty pull requests out of the batch.
 */
/** Git with the caller's environment (credentials of the remote, identity of the merges); never hides its output. */
export interface LotGit {
    run(cwd: string, args: string[]): Promise<{
        ok: boolean;
        stdout: string;
        stderr: string;
    }>;
}
export declare function processGit(env: NodeJS.ProcessEnv): LotGit;
/**
 * The proof of a batch head: its full suite and `apv gates verify` at 0. `refused`: the suite was refused before it ran
 * (a ceiling of the repetition of the changed test files, `GATE_REPEAT`, or a wrong `--stacks`), which says nothing about
 * the pull requests being faulty: never bisected. `infrastructure`: every failure of the suite is one of its
 * infrastructure (a variable of the environment absent, a test stack unreachable, src/gates/infrastructure.ts): never
 * bisected either, nothing is concluded about the code.
 */
export interface Proof {
    ok: boolean;
    runId: string | null;
    summary: string;
    refused?: string;
    infrastructure?: string;
}
/** Why a proof says nothing about the code of the pull requests (refused before it ran, or an infrastructure failure), or null. */
export declare function notAboutCode(proof: Proof | null): string | null;
export interface BatchOptions {
    /** Checkout of the repository (the batches are worktrees of it). */
    repo: string;
    /** Git common directory of the repository (default place of the batch worktrees). */
    common: string;
    prs: number[];
    target?: string;
    /** Worktree of the batch; sub-batches of a bisection get a suffix. */
    dir?: string;
    bisect: boolean;
    merge: boolean;
    ready: boolean;
    keep: boolean;
    remote: string;
    gh: GhRunner;
    onCall: (call: GhCall) => void;
    git: LotGit;
    log: (line: string) => void;
    pollMs: number;
    pollAttempts: number;
    /** `--wait-ci <minutes>`: how long a read waits for the pending checks of a pull request to end (absent: no wait). */
    ciWaitMs?: number;
    /** Interval between two reads while waiting for the checks. */
    ciPollMs?: number;
    /**
     * Proves a batch head in its worktree (setup, full suite, verify), with the configuration of the target at `base`:
     * a batch is never proven by the checks it brings.
     */
    prove: (worktree: string, head: string, base: string) => Promise<Proof>;
    /**
     * Why the head of a pull request changes the checks against the target at `base` (`gates`, `batch`, `stacks`,
     * `suite`, `environment` of `.apv/config.json`, or an unreadable configuration), or null when it does not.
     */
    configDrift: (base: string, head: string) => string | null;
    /**
     * Why the changed test files of a pull request (its head against its merge base with the target at `base`) exceed a
     * ceiling of `repeatChanged` in the checks of the target (`maxFiles`, a refused fixed wait), or null: applied pull
     * request by pull request, before anything is built. Absent: no such check.
     */
    repeatRefusal?: (base: string, head: string) => Promise<string | null>;
    /** Aborted by SIGINT, SIGTERM or SIGHUP: the batch stops at the next step, never between a check and a merge. */
    signal?: AbortSignal;
    /** Journals one merge or stop of the batch; returns an error message when it could not. */
    journal: (entry: Record<string, unknown>) => string | null;
    now?: () => Date;
}
export interface PlannedMember {
    number: number;
    pr: PullRequest | null;
    anomalies: string[];
}
export interface LotMember {
    number: number;
    headRefName: string;
    head: string;
    mergeCommit: string;
    tree: string;
}
export interface Lot {
    name: string;
    dir: string;
    base: string;
    baseTree: string;
    members: LotMember[];
    excluded: {
        pr: number;
        reason: string;
    }[];
    head: string | null;
    tree: string | null;
    proof: Proof | null;
    removed: boolean;
}
export interface BatchReport {
    target: string | null;
    base: string | null;
    prs: PlannedMember[];
    lots: Lot[];
    /** Pull requests isolated by the bisection as failing the suite (out of the batch). */
    culprits: number[];
    /** The whole failed while every half passed: the failure comes from their combination, nothing is merged. */
    interaction: boolean;
    /** The batch whose proof allows the merge, or null. */
    proven: Lot | null;
    merged: number[];
    /** Each pull request whose merge was seen, with the head it was merged at (the branch cleanup works from it). */
    mergedHeads: MergedHead[];
    stopped: {
        pr: number | null;
        reasons: string[];
    } | null;
    finalTree: {
        target: string;
        lot: string;
        identical: boolean;
    } | null;
    /** True when a signal stopped the batch (exit 128 + signal). */
    interrupted: boolean;
    /**
     * The pull requests asked for that the proven batch leaves out (in conflict, or isolated as faulty): the batch is
     * then partial, never a success (exit 1), even when the rest is proven and merged.
     */
    left: {
        pr: number;
        reason: string;
    }[];
}
/**
 * `apv stack batch`: reads the pull requests, builds the batch, proves it once, bisects on failure when asked, and,
 * proven and asked, merges its pull requests in order, each checked by content before and after its merge.
 */
export declare function batchMerge(options: BatchOptions): Promise<BatchReport>;
