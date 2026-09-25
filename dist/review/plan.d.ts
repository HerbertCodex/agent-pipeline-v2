import { type PathClass, type ReviewDomainName, type ReviewPlanSettings } from './config.js';
/**
 * `apv review plan`: the review domains proposed from the nature of a diff. Pilot project, 25 September 2026: a
 * spec of pure tidying (77 renames, rewritten imports, no behavior change, no migration, no screen) went through the
 * four default reviews (40 to 70 minutes), three of which had nothing to read. The rule, for every project:
 * - `securite` is always kept, without exception (no diff, key or option skips it);
 * - another domain is skipped only on a positive proof that it has nothing to read: every changed file is
 *   classified, and none of them touches the domain; a file that no class describes, with a changed content,
 *   keeps every domain (prudence);
 * - a pure rename (similarity 100 %) or a change that only rewrites import paths does not change content, except
 *   for a migration, whose name is what the migration tool records.
 */
/** How the content of a changed file changed. */
/**
 * - `none`: pure rename (similarity 100 %) or mode change;
 * - `paths`: only references to moved files rewritten (imports, paths in comments), imports reordered or rewrapped;
 * - `content`: anything else (added, deleted, binary, any other changed line).
 */
export type ChangeKind = 'none' | 'paths' | 'content';
export interface PlannedFile {
    path: string;
    /** Former path of a renamed file. */
    from?: string;
    /** Git status letter with its score (`M`, `A`, `D`, `R100`, `R087`, `T`). */
    status: string;
    change: ChangeKind;
    classes: PathClass[];
    /** Domains this file keeps, with the reason. */
    keeps: {
        domain: ReviewDomainName;
        why: string;
    }[];
}
export interface DomainDecision {
    domain: ReviewDomainName;
    decision: 'retained' | 'skipped';
    /** One sentence; for a skipped domain, the note to record (`apv run set <id> review:<domaine> skipped --note`). */
    reason: string;
    /** Files that decide (at most FILES_SHOWN), and how many in all. */
    files: string[];
    fileCount: number;
    forced: 'config' | 'operator' | null;
}
export interface ReviewPlan {
    tool: 'apv review plan';
    base: {
        ref: string;
        sha: string;
    };
    head: {
        ref: string;
        sha: string;
    };
    mergeBase: string;
    counts: {
        files: number;
        renames: number;
        paths: number;
        content: number;
        neutral: number;
        unclassified: number;
    };
    domains: DomainDecision[];
    retained: ReviewDomainName[];
    skipped: {
        domain: ReviewDomainName;
        reason: string;
    }[];
    files: PlannedFile[];
}
interface NameStatus {
    status: string;
    path: string;
    from?: string;
}
/** `git diff --name-status -z -M`: one entry per changed file, the former path of a rename kept. */
export declare function parseNameStatus(raw: string): NameStatus[];
interface FilePatch {
    binary: boolean;
    removed: string[];
    added: string[];
}
/** Changed lines of each file of a `--unified=0` patch, keyed by the new path (the old one for a deletion). */
export declare function parsePatch(raw: string): Map<string, FilePatch>;
export interface Rename {
    from: string;
    path: string;
}
/** One side of a changed file: its path on that side, and the renames of the diff. */
export interface ReferenceSide {
    renames: Rename[];
    file: string;
    side: 'from' | 'path';
}
/**
 * True when the changed lines of a file only rewrite references to moved files (imports, paths in comments or
 * texts), reorder its imports or rewrap them: once each such reference is named the same way before and after,
 * the removed and added lines are identical. Any other change is a content change.
 */
export declare function referencesOnly(patch: {
    removed: string[];
    added: string[];
}, file: {
    path: string;
    from?: string | undefined;
}, renames: Rename[]): boolean;
export interface PlanInput {
    repo: string;
    base: string;
    head: string;
    settings: ReviewPlanSettings;
    /** Migration globs the project declares elsewhere (`db.migrations`), added to `review.paths.migrations`. */
    migrations: string[];
    /** Folder of validated mockups (`design.dir`): a changed mockup keeps the fidelity review. */
    designDir: string;
    /** Paths the lane policy treats as sensitive (`sensitivePaths` and `risk.highPaths`), cited for the security review. */
    sensitive: string[];
    /** Domains the operator forces (`--force`). */
    force: ReviewDomainName[];
}
export declare function planReviews(input: PlanInput): ReviewPlan;
export {};
