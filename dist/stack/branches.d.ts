import { type GhCall, type GhRunner, type MergedHead, type PullRequestPath } from './github.js';
/**
 * Deletion of the head branches of the pull requests `apv stack merge` and `apv stack batch --merge` merged (pilot
 * project, 1 October 2026: 54 merged branches had piled up on a repository without GitHub's « delete branch after merge »).
 * After the merges, each branch is deleted through the REST API, never through a shell, unless a rule keeps it:
 * `--keep-branches`; a pull request from a fork (or whose origin GitHub did not give); a repository that is itself a fork
 * (its branches may be the head of pull requests of the parent repository); the target or the default branch; a branch
 * named by `stack.keepBranches` (long-lived branches: develop, release/*...); a branch that is the base or the head of a
 * pull request still open, or that already was the base of a pull request (a long-lived branch; in a stack, the next pull
 * request was retargeted before, so its base is no longer this branch); a protected branch; a branch whose head is no
 * longer the commit that was merged. A branch already gone (404) is noted, without error. A failure never undoes nor
 * fails the merge: it is reported as a warning.
 */
export type BranchStatus = 'deleted' | 'kept' | 'absent' | 'failed';
export interface BranchOutcome {
    pr: number;
    branch: string;
    /** The head the merge carried: the commit the branch pointed to, to recreate it if needed. */
    head: string;
    status: BranchStatus;
    reason: string;
}
/** What the cleanup read of a repository: its default branch, whether it is a fork, whether GitHub deletes merged branches itself. */
export interface RepositorySettings {
    host: string;
    /** `<owner>/<name>`. */
    repo: string;
    defaultBranch: string | null;
    /** Null when the answer does not carry it. */
    fork: boolean | null;
    /** Null when the answer does not carry it (read without the rights to see the merge settings). */
    deleteBranchOnMerge: boolean | null;
    error: string | null;
}
export interface BranchCleanup {
    branches: BranchOutcome[];
    repositories: RepositorySettings[];
}
/** Long-lived branches never deleted by the cleanup when `stack.keepBranches` is absent (globs: `*` within a segment, `**` across). */
export declare const DEFAULT_KEEP_BRANCHES: readonly ["develop", "development", "release/*", "releases/*", "staging", "hotfix/*"];
export declare const REPOSITORY_JQ = "{default_branch, fork, delete_branch_on_merge}";
type Where = Pick<PullRequestPath, 'host' | 'repo'>;
/** `gh api repos/<owner>/<repo> --jq …`: the default branch, `fork` and `delete_branch_on_merge`. */
export declare function repositoryArgs(where: Where): string[];
/** `gh api repos/<owner>/<repo>/branches/<branch> --jq …`: the head of the branch and whether it is protected. */
export declare function branchArgs(where: Where, branch: string): string[];
/**
 * `gh api -X GET repos/<owner>/<repo>/pulls -f state=<state> -f <field>=<value>`: the pull requests with this base or
 * head, open ones (all of them, up to 100) or of any state (one is enough).
 */
export declare function pullsArgs(where: Where, state: 'open' | 'all', field: 'base' | 'head', value: string): string[];
/** `gh api -X DELETE repos/<owner>/<repo>/git/refs/heads/<branch>`. */
export declare function deleteBranchArgs(where: Where, branch: string): string[];
/** The command that makes GitHub delete the head branch of each merged pull request itself. Given, never run. */
export declare function deleteOnMergeCommand(where: Where): string;
/** Reads the answer of `repositoryArgs`. */
export declare function parseRepositorySettings(text: string): {
    defaultBranch: string | null;
    fork: boolean | null;
    deleteBranchOnMerge: boolean | null;
};
export interface CleanupOptions {
    /** One `gh` call, shown and recorded by the caller like every other call of the command. */
    run: (args: string[]) => Promise<GhCall>;
    /** The branch the pull requests landed on: never deleted. */
    target: string | null;
    /** Why every branch is kept (`--keep-branches`, an interrupted or stopped batch): nothing is deleted, nothing is called. Null otherwise. */
    keep: string | null;
    /** Globs of the branches never deleted (`stack.keepBranches`); `DEFAULT_KEEP_BRANCHES` when absent. */
    keepPatterns?: readonly string[];
}
/** Deletes the head branch of each merged pull request, in order, under the rules above; one outcome per branch. */
export declare function cleanMergedBranches(merged: MergedHead[], options: CleanupOptions): Promise<BranchCleanup>;
/** One line per branch, then the advice for a repository that does not delete merged branches itself. */
export declare function cleanupLines(cleanup: BranchCleanup): string[];
/**
 * The GitHub repository of a remote address: `https://<host>/<owner>/<name>(.git)`, `ssh://[user@]<host>[:port]/<owner>/<name>(.git)`
 * or `[user@]<host>:<owner>/<name>(.git)`. Null for anything else (a local path, another form).
 */
export declare function remoteRepository(url: string): Where | null;
/** What `apv init` says about the setting « delete head branches after merge » of the GitHub repository of `origin`. */
export interface DeleteOnMergeCheck {
    /** `<owner>/<name>`, or null when `origin` is not a GitHub address. */
    repo: string | null;
    host: string | null;
    deleteBranchOnMerge: boolean | null;
    /** The command that sets it, when it is false. Never run by the tool. */
    command: string | null;
    /** Why the setting was not read. */
    note: string | null;
}
/** A remote address with any credentials or user name (`user:token@`) masked: what may be shown or written. */
export declare function maskRemote(url: string): string;
/**
 * Reads `delete_branch_on_merge` of the repository of the `origin` address (`gh api repos/<owner>/<repo>`). Never changes
 * it. Only github.com, or a host `gh` is logged in to (`gh auth status --hostname <host>`), is asked: the address of
 * another server is never sent anywhere.
 */
export declare function checkDeleteOnMerge(origin: string | null, gh: GhRunner): Promise<DeleteOnMergeCheck>;
export {};
