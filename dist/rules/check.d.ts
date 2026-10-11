import { type RemoteCheck } from '../gates/base-gates.js';
import { type ReviewDomainName } from '../review/config.js';
import { type MergeRule } from './config.js';
import { type DocsOnlyLane } from './docs-only.js';
import { type CiProofOutcome } from './ci-proof.js';
import type { GhRunner } from '../stack/github.js';
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
    /** The proof by the CI (rules.ciProof of the base), when the local receipts left checks unproven; null otherwise. */
    ci: CiProofOutcome | null;
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
    /**
     * The API GitHub reads the proof by the CI with (rules.ciProof): `gh` itself, never APV_GH; null or absent, nothing is
     * read and the rule asks for the local proof. `repository` (owner/name) defaults to the origin on github.com.
     */
    ci?: {
        gh: GhRunner | null;
        repository?: string | null;
    };
}
/** Whether the commit is a web interface: web dependencies in its package.json, or tracked interface files. */
export declare function isWebAt(repo: string, sha: string): boolean;
export interface ScreenVerdict {
    /** Files of the change. */
    files: number;
    /** Why captures are needed, one line per file and cause (« <fichier> : <raison> »); empty when no screen is touched. */
    reasons: string[];
}
/**
 * Whether a change touches no screen, for the rule captures. Every file it adds, modifies, removes or renames (a rename is
 * a removal and an addition: both sides judged) must be, by its path, outside the interface (withoutScreenByPath), and
 * none may be brought to a screen another way: named by a file of the head that may show it (referenceTokens, a mention
 * in a comment, a test, the documentation or the code map aside), reached by a symbolic link, loaded by a pattern or a
 * computed path (a test or a document, when the application loads that way), or aimed at by an alias. Every cause found is
 * said, file by file; the tool also says when it cannot tell (diff, tree or search unreadable, a link that leaves the
 * repository, too many files): captures are then required.
 */
export declare function touchesNoScreen(repo: string, base: string, head: string, screens: readonly RegExp[]): ScreenVerdict;
/**
 * The rules checked before any merge (docs/REGLES.md). Each one says what it checked, why it refuses and what to do. A
 * refusal is lifted by the correction it asks for, or by the operator himself: « dérogation <règle> <commit> : <raison> »
 * typed in the session (operator journal); no option of the tool lifts it.
 */
export declare function checkMergeRules(input: RulesInput): Promise<RulesReport>;
/** Lines of a report, for the text output of `apv rules check` and of the stack commands. */
export declare function rulesLines(report: RulesReport, indent?: string): string[];
