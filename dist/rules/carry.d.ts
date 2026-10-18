/** Whether `ancestor` is an ancestor of `of` (or the same commit). */
export declare function isAncestor(repo: string, ancestor: string, of: string): boolean;
/** The files of a delta, or why it cannot be read: `problem` says it in full (« delta illisible : … ; relecture complète exigée »). */
export type DeltaFiles = {
    files: string[];
    problem: null;
    cause: null;
} | {
    files: null;
    problem: string;
    cause: string;
};
/**
 * The files of the delta between two commits, both sides of a rename, every submodule seen. Refused (security review
 * of #141, A1) when Git cannot read it, when a submodule link (mode 160000) changes in it (what the link brings is
 * another repository the tool does not read), or when the two trees differ and no file is listed: a delta that hides
 * what it changes carries no review, no captures and no waiver.
 */
export declare function deltaFiles(repo: string, from: string, to: string): DeltaFiles;
/** The head T1 whose reviews count for `head` (one update with the base), with the commit of the target merged; or null. */
export declare function carriedHeadOnce(repo: string, head: string, target: string): {
    from: string;
    base: string;
} | null;
/** The heads whose reviews count for `head`, nearest first (T1, then T0...): empty when `head` is no such update. */
export declare function carriedHeads(repo: string, head: string, target: string | null): string[];
/** Commits of the pull request walked back from its head to find an earlier review or waiver (docs/ACCELERATION-LOTS.md, 6.2). */
export declare const MAX_REPORT_WALK = 10;
/** One step of the change between two commits of the pull request: `to` has `from` as its first parent. */
export interface ChainLink {
    from: string;
    to: string;
}
/**
 * A commit C of the pull request below the head, with the links that lead from it to the head: the first-parent steps,
 * walked one by one. A merge of the target that carry.ts carries (diff identical byte for byte) adds no link: what it
 * brings is the target's, merged under the rules, and the diff of the pull request stays the same over it.
 */
export interface ChainNode {
    commit: string;
    links: ChainLink[];
}
/**
 * The commits of the pull request below `head`, nearest first: first parent after first parent, a merge of the target
 * carried by carry.ts followed to the head it carries, MAX_REPORT_WALK steps at most, never a commit of the target (an
 * ancestor of it holds the reviews of another change). Empty without a target. A commit that is not an ancestor of the
 * head (a rebase) is never in it: nothing is carried to a rewritten history.
 */
export declare function prChain(repo: string, head: string, target: string | null, max?: number): ChainNode[];
/**
 * The spans of a chain node: each run of links that follow one another (a carried merge cuts the run), as one change from
 * the bottom of the run to its top. Without a carried merge, the one span is C..head.
 */
export declare function chainSpans(links: readonly ChainLink[]): ChainLink[];
