/**
 * Merge traces: `apv stack merge` and `apv stack batch --merge` write one per merge, signed with the anchor key kept
 * outside the repository, in `<git common dir>/apv/merges/`. `apv audit merges` walks the default branch and names every
 * commit no trace accounts for: a merge or a push that did not go through the tool (and so skipped its rules). It is the
 * check after the fact that makes up for a branch protection GitHub does not offer (a private repository on the free plan).
 */
export declare const MERGES_DIR: readonly ["apv", "merges"];
export interface MergeTraceBody {
    v: 1;
    pr: number;
    head: string;
    target: string;
    method: string;
    mergeCommit: string | null;
    at: string;
    /** A rebase merge: the number of commits it landed, `mergeCommit` the last one (absent: one commit). */
    commits?: number;
}
export interface MergeTrace extends MergeTraceBody {
    sig: string;
}
export declare function writeMergeTrace(common: string, body: Omit<MergeTraceBody, 'v'>, key: Buffer): string;
/** The signed traces; unsigned, altered or unreadable files are ignored. */
export declare function readMergeTraces(common: string, key?: Buffer<ArrayBufferLike> | null): MergeTrace[];
export interface UnaccountedCommit {
    sha: string;
    date: string;
    subject: string;
    merge: boolean;
}
export interface MergeAudit {
    /** The branch audited (`origin/main`), and the commit it pointed to; null when it does not resolve. */
    ref: string;
    head: string | null;
    since: string;
    /** Why the audit starts there: the first trace, the option, or the default window. */
    sinceReason: string;
    commits: number;
    traces: number;
    unaccounted: UnaccountedCommit[];
}
/** Default window when no trace exists yet: 30 days. */
export declare const DEFAULT_AUDIT_DAYS = 30;
/**
 * Walks the first-parent history of `ref` since `since` (default: the first trace, else 30 days) and lists the commits
 * no signed trace accounts for: a merge commit is accounted for by the trace of its merge commit or of the head it
 * merged (second parent); a squash by the trace of its merge commit; a rebase by the trace of its last commit, which
 * also accounts for the commits before it that the same merge landed (`commits`).
 */
export declare function auditMerges(repo: string, common: string, ref: string, options?: {
    since?: string;
    now?: Date;
}): MergeAudit;
/** Lines of an audit, for `apv status`, `apv audit merges` and the head of the report of `apv stack merge`. */
export declare function auditLines(audit: MergeAudit): string[];
