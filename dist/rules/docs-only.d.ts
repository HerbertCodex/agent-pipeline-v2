import type { ReviewDomainName } from '../review/config.js';
import type { ReviewPlan } from '../review/plan.js';
import type { DocsOnlyKind, RulesSettings } from './config.js';
import { type OperatorMessage } from './operator.js';
/**
 * The lane without code (« voie sans code », docs/REGLES.md). Pilot project, 4 October 2026: a pull request of the
 * decision ledger, four mockups already validated by the operator and registered with their fingerprint, and the
 * pipeline journal was refused by `apv rules check` until a full suite and four reviews (security, fidelity with
 * captures, data, GDPR) were done. The operator: « pourquoi il faut tout ça pour une petite PR pareille ? », then
 * « Oui, PR à part » for a generic lane.
 *
 * The lane is decided by the tool, from the diff since the merge base with the target, never by an agent: EVERY changed
 * file (both sides of a rename, deletions included) is a regular file (mode 100644, never a link, a submodule or an
 * executable), outside `rules.docsOnly.exclude`, outside the sensitive paths, the instructions of the agents and the
 * configuration files, and of one of these kinds (a closed list, that a project can only narrow):
 * - `decisions`: `.apv/DECISIONS.json` (valid at the head) and `.apv/DECISIONS.md`, never deleted;
 * - `mockups`: a validated mockup under `design.dir` (drafts apart), added or modified, whose sha256 at the head is the
 *   one its decision records (the check of `apv design check`), never deleted;
 * - `drafts`: the drafts of the mockup loop, `<design.dir>/brouillons/**`;
 * - `specs`: `.apv/specs/**`; `journal`: `.apv/journal-pipeline.md`;
 * - `state`: `.apv/state/**`, never a script (`.sh`, `.js`, `.ts`, `.py`...);
 * - `docs`: Markdown the review plan reads as documentation (`*.md` of the neutral class, outside the served and
 *   routing folders, without a word of data or GDPR nor a real e-mail address in its changed lines), outside `.apv/`.
 * And every mockup decision the change adds or modifies in the ledger (confirmed, from the operator) has its quote
 * among the messages the operator typed (src/rules/operator.ts): a validation written by an agent alone never enters
 * the lane, since a decision merged becomes the base the rule `maquette` trusts. Anything else, anything unreadable,
 * and the normal rules apply.
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
/** The lane of a change (see above). Pure reading of the commits, the plan and the operator's journal. */
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
