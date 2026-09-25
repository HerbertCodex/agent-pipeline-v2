import type { ChangeSet } from '../domain/contracts.js';
import { type ProcessHooks } from './process.js';
export interface GitIdentity {
    name: string;
    email: string;
}
export interface CommitMessage {
    subject: string;
    body?: string;
    /** The tool command that created the commit, written as the `Generated-by` trailer. */
    generatedBy: string;
    trailers?: Record<string, string>;
}
export declare function isInside(parent: string, child: string): boolean;
export declare class Git {
    private readonly signal?;
    private readonly hooks;
    constructor(signal?: AbortSignal | undefined, hooks?: ProcessHooks);
    exec(cwd: string, args: string[]): Promise<string>;
    /**
     * Reads one Git configuration value. Unlike every mutating Git call, this one passes HOME (and the
     * config overrides Git itself documents), because the operator identity used for an approval usually
     * lives in the global ~/.gitconfig, not in the repository. Without it the identity fallback could never
     * succeed and every approval had to repeat --reviewer.
     */
    configValue(repo: string, key: string): Promise<string | null>;
    /**
     * The identity Git itself would use for a commit in this repository (`user.name` and `user.email`, from
     * the repository, global or system configuration). There is no invented fallback: a commit authored by an
     * address that belongs to nobody is refused by hosts that check authors (a Vercel preview deployment is
     * blocked when the commit author is not a team member).
     */
    identity(repo: string): Promise<GitIdentity>;
    /**
     * Commits as `identity` (author and committer), never as an invented author. The tool that made the
     * commit is recorded as a `Generated-by` trailer (last paragraph), so `git log` still tells it apart.
     */
    commit(repo: string, identity: GitIdentity, message: CommitMessage, paths?: readonly string[]): Promise<string>;
    root(path: string): Promise<string>;
    sha(repo: string, ref?: string): Promise<string>;
    clean(repo: string, expectedSha?: string): Promise<void>;
    /** True when `commit` already contains `ancestor`; false when it does not, or is unknown here. */
    contains(repo: string, commit: string, ancestor: string): Promise<boolean>;
    compatible(repo: string, sha: string): Promise<void>;
    workspace(repo: string, path: string, sha: string): Promise<void>;
    removeWorkspace(repo: string, path: string, ownedRoot: string): Promise<void>;
    changes(repo: string, base: string, candidate?: string): Promise<ChangeSet>;
    snapshot(repo: string, base: string, runId: string, title?: string): Promise<string>;
    patch(repo: string, base: string, sha: string): Promise<string>;
    assertNoNestedGit(path: string): Promise<void>;
}
/** Readable single-line candidate subject derived from the task title; the run id stays in a trailer. */
export declare function candidateSubject(title: string | undefined, runId: string): string;
