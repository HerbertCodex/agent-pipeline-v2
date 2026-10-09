import type { ReviewDomainName } from '../review/config.js';
import type { ReviewPlan } from '../review/plan.js';
import type { DocsOnlyKind, RulesSettings } from './config.js';
import { type OperatorMessage } from './operator.js';
/**
 * The lane without code (« voie sans code », docs/REGLES.md): a pull request of the ledger, registered mockups, specs,
 * the journal or documentation needs no review. Pilot project, 4 October 2026: such a pull request was asked for a
 * full suite and four reviews; the operator: « pourquoi il faut tout ça pour une petite PR pareille ? ».
 */
export interface LaneFile {
    path: string;
    kind: DocsOnlyKind;
}
export interface DocsOnlyLane {
    /** Whether the change takes the lane without code. */
    eligible: boolean;
    /** One sentence: why it does, or the first reason it does not. */
    reason: string;
    /** The files that allowed it, with their kind (every file when eligible). */
    files: LaneFile[];
    /** The files that keep the normal rules, with the reason (50 at most). */
    blocking: {
        path: string;
        why: string;
    }[];
}
/** Name of the lane in the reports. */
export declare const LANE_NAME = "voie sans code";
export declare const KIND_LABEL: Readonly<Record<DocsOnlyKind, string>>;
export interface LaneInput {
    repo: string;
    mergeBase: string;
    head: string;
    /** The review plan of the same diff (its classes and its per-file risk decide what documentation is). */
    plan: ReviewPlan;
    settings: RulesSettings['docsOnly'];
    designDir: string;
    /** Sensitive paths of the high lane (`sensitivePaths` and `risk.highPaths`). */
    sensitive: readonly string[];
    messages: readonly OperatorMessage[];
    /** The anchor key (tests); default: the key of the account. */
    key?: Buffer | null;
}
/**
 * The lane of a change. Decided by the tool, from the diff since the merge base with the target, never by an agent:
 * EVERY changed file (both sides of a rename, deletions included) is a regular file (mode 100644, never a link, a
 * submodule or an executable), outside `rules.docsOnly.exclude`, the sensitive paths, the instructions of the agents
 * (compared without case, and what they import by `@path`) and the configuration files, and of one of these kinds (a
 * closed list, that a project can only narrow), with an extension of its kind:
 * - `decisions`: `.apv/DECISIONS.json` (valid at the head, see `ledgerBlocking`) and `.apv/DECISIONS.md` (exactly the
 *   rendering of the JSON at the head), never deleted;
 * - `mockups`: a validated mockup under `design.dir` (drafts apart) at the sha256 its decision records, never deleted;
 * - `drafts`: `<design.dir>/brouillons/**`; `journal`: `.apv/journal-pipeline.md`;
 * - `specs`: a spec ADDED under `.apv/specs/` (`.json`);
 * - `docs`: Markdown the review plan reads as documentation, outside `.apv/`.
 * `.apv/state/**` is never in the lane: the session hook injects it into every session. Anything else, anything
 * unreadable, and the normal rules apply. Pure reading of the commits, the plan and the operator's journal.
 */
export declare function docsOnlyLane(input: LaneInput): Promise<DocsOnlyLane>;
/**
 * The review plan in the lane without code: no domain is required by the diff, the security review included; only the
 * domains forced by the configuration (`review.always`) or by the operator (`--force`) stay. Outside the lane, the plan
 * is returned unchanged.
 */
export declare function planInLane(plan: ReviewPlan, lane: DocsOnlyLane, forced: {
    always: readonly ReviewDomainName[];
    operator: readonly ReviewDomainName[];
}): ReviewPlan & {
    lane: DocsOnlyLane;
};
/** Lines of a lane for the text reports (`apv rules check`, `apv stack plan`, `apv review plan`). */
export declare function laneLines(lane: DocsOnlyLane, indent?: string): string[];
