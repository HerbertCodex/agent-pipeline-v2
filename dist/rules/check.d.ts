import { type RemoteCheck } from '../gates/base-gates.js';
import { type ReviewDomainName } from '../review/config.js';
import { type MergeRule } from './config.js';
import { type DocsOnlyLane } from './docs-only.js';
export type RuleStatus = 'ok' | 'refused' | 'waived' | 'not_applicable';
export interface RuleOutcome {
    rule: MergeRule;
    title: string;
    status: RuleStatus;
    /** What was checked, in one sentence. */
    detail: string;
    /** Why the rule refuses (empty when it does not). */
    problems: string[];
    /** What to do to pass, in order; the last line is the only waiver there is. */
    todo: string[];
    /** The operator's own waiver, when there is one: when he typed it and his reason. */
    waiver: {
        at: string;
        reason: string;
    } | null;
    /** The rule `relecture` only: each domain the plan retains, recorded, waived for that domain alone, or missing. */
    domains?: DomainReview[];
}
/**
 * The review of one retained domain: `recorded` at the commit without a critical or high finding; `waived` by the
 * operator for that domain (`dérogation relecture:<domaine>`); `missing` (absent, unusable, or a critical or high finding).
 */
export interface DomainReview {
    domain: ReviewDomainName;
    status: 'recorded' | 'waived' | 'missing';
    detail: string;
    waiver: {
        at: string;
        reason: string;
    } | null;
}
export interface RulesReport {
    commit: string;
    target: string;
    mergeBase: string | null;
    ok: boolean;
    rules: RuleOutcome[];
    /** The lane without code (src/rules/docs-only.ts): whether the change takes it, why, and the files that allowed it. */
    lane: DocsOnlyLane;
    /** What could not be verified about the target (remote unreadable...), from the base of the checks. */
    warnings: string[];
}
export interface RulesInput {
    repo: string;
    commit: string;
    /** The branch the change goes to, as a reference of this repository (`origin/main`). */
    target: string;
    /** Rules proven elsewhere (`apv stack batch` proves the batch itself: `preuve` and `instable`). */
    skip?: readonly MergeRule[];
    /** How the target is checked against the remote (`apv gates verify`: strict; tests inject `lsRemote`). */
    remote?: RemoteCheck;
}
/** Whether the commit is a web interface: web dependencies in its package.json, or tracked interface files. */
export declare function isWebAt(repo: string, sha: string): boolean;
/**
 * The rules checked before any merge (docs/REGLES.md). Each one says what it checked, why it refuses and what to do. A
 * refusal is lifted by the correction it asks for, or by the operator himself: « dérogation <règle> <commit> : <raison> »
 * typed in the session (operator journal); no option of the tool lifts it.
 */
export declare function checkMergeRules(input: RulesInput): Promise<RulesReport>;
/** Lines of a report, for the text output of `apv rules check` and of the stack commands. */
export declare function rulesLines(report: RulesReport, indent?: string): string[];
