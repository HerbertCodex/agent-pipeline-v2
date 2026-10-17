import { type ReviewDomainName } from '../review/config.js';
import { type ChainLink, type ChainNode } from './carry.js';
import type { WaiverTarget } from './operator.js';
import { type ReadRecord } from './reviews.js';
/**
 * Reviews carried over a delta that leaves their perimeter, and reviews of the delta (docs/ACCELERATION-LOTS.md, part B).
 *
 * A review recorded at C, a commit of the pull request below the head C', counts at C' for donnees and rgpd when every
 * step of the change from C to C' (each first-parent link, and each run of links as one change) is outside the perimeter
 * of the domain: the plan of the reviews (planReviews, settings read at the base of the pull request) does not retain the
 * domain for it. The chain is walked from the head, nearest first, MAX_REPORT_WALK commits at most (carry.ts); a blocking
 * review (a critical or high finding) of the domain at any commit of the walk blocks, and the first step that touches the
 * perimeter breaks the report: a new review is asked for, of the whole change or of the delta.
 *
 * securite and fidelite are never carried that way (NEVER_REPORTED). fidelite, and its captures with it, was carried
 * while its perimeter was read from the text of the application (touchesNoScreen, the loads by a computed path); the
 * third security review of #141 (M3, M4) showed that reading can be fooled, and the lead turned it off: it comes back
 * founded on the fingerprint of the build output (part A of docs/ACCELERATION-LOTS.md), not on a textual detection.
 *
 * Every domain has a review of the delta (`apv review record --delta-from C`), recorded at C' by its reviewer (with the
 * captures at C' for fidelite): it counts when C is an ancestor of C' on the branch, the files it recorded are the diff
 * C..C' recomputed, and the review it starts from is usable at C (itself a review of a delta, MAX_DELTA_CHAIN in a row at
 * most).
 *
 * The review of the head always decides; this only applies when the head has none of the domain.
 *
 * A waiver the operator typed for C counts at C' the same way (6.4, decision of the operator of 17 October 2026), for the
 * closed list WAIVER_PERIMETERS only: maquette (no screen, no mockup, no decision ledger touched), captures and the review
 * fidelite (the conditions of fidelite), the reviews donnees and rgpd (the plan does not retain them), controles (the
 * configuration of the checks and package.json untouched). Never securite, the rule relecture whole, preuve nor instable.
 * The waiver is still read from the journal of the operator by waiverFor, for its own commit C: nothing else creates one.
 */
/** Reviews of the delta in a row, each starting from the one before, until a review of the whole change. */
export declare const MAX_DELTA_CHAIN = 5;
/**
 * What a delta must leave untouched: a review domain (planReviews, and touchesNoScreen for fidelite), or the paths of a
 * rule: `maquette` (screens, the mockups folder, the decision ledger), `controles` (the configuration of the checks,
 * package.json).
 */
export type Perimeter = Exclude<ReviewDomainName, 'securite'> | 'maquette' | 'controles';
/**
 * The waivers carried over a delta outside their perimeter, and that perimeter: a closed list. Absent, never carried:
 * `relecture:securite`, `relecture` whole, `preuve`, `instable` (decision of the operator of 17 October 2026).
 */
export declare const WAIVER_PERIMETERS: Readonly<Partial<Record<WaiverTarget, Perimeter>>>;
/**
 * The domains never carried over a delta without a review: securite (decision of the operator of 17 October 2026), and
 * fidelite (decision of the lead on the third security review of #141: back with the fingerprint of the build output).
 * A review of the delta (`--delta-from`) stays open to both.
 */
export declare const NEVER_REPORTED: readonly ReviewDomainName[];
export interface DeltaContext {
    repo: string;
    common: string;
    /** The target, resolved; null: nothing is carried. */
    target: string | null;
    /** Why the change of a span touches the perimeter, one line per cause; empty when it touches nothing. */
    touches(perimeter: Perimeter, span: ChainLink): string[];
    /** The anchor key the seals of the reviews are checked with (tests); the key of the machine by default. */
    key?: Buffer | null;
}
/** What counts for one domain at a commit. */
export interface Picked {
    found: ReadRecord | undefined;
    /** The commit whose review counts, when not the commit itself. */
    from: string | null;
    /** `own`: recorded at the commit; `carried`: over merges of the target (carry.ts); `reported`: over a delta outside its perimeter. */
    how: 'own' | 'carried' | 'reported' | null;
    /** A review of the delta, verified: its starting commit and how many files it read. */
    delta?: {
        from: string;
        files: number;
    };
    /** A reported review: the files of the delta, none in the perimeter of the domain. */
    reported?: {
        files: string[];
    };
    /** The nearest review the chain had, not reported because a step touches the perimeter: its commit and the causes. */
    broken?: {
        from: string;
        reasons: string[];
    };
}
export declare const usableReview: (r: ReadRecord | undefined) => boolean;
export declare const blockingReview: (r: ReadRecord | undefined) => boolean;
export interface ReviewChain {
    /** The review of the domain at `commit`: its own, or carried over merges of the target; a review of the delta verified. */
    resolve(commit: string, domain: ReviewDomainName): Picked;
    /** A review of an earlier commit of the branch carried to the head over a delta outside the perimeter; never NEVER_REPORTED. */
    reported(domain: ReviewDomainName): Picked | null;
    /** The nearest commit of the branch below the head with a usable review of the domain: where a review of the delta starts. */
    deltaStart(domain: ReviewDomainName): string | null;
    /**
     * The waiver of `rule` typed for an earlier commit of the branch, carried to the head over a delta outside its
     * perimeter; `find` reads the waiver of a commit (waiverFor). Null for a rule outside WAIVER_PERIMETERS, or no waiver.
     */
    carriedWaiver<W>(rule: WaiverTarget, find: (commit: string) => W | null): CarriedWaiver<W> | null;
    /** The commits of the branch walked from the head (carry.ts, prChain). */
    chain(): ChainNode[];
}
/** A waiver of an earlier commit: carried (`files`: the delta), or not, with the step that touches the perimeter. */
export type CarriedWaiver<W> = {
    waiver: W;
    from: string;
    files: string[];
} | {
    waiver: null;
    from: string;
    reasons: string[];
};
export declare function reviewChain(ctx: DeltaContext, head: string): ReviewChain;
