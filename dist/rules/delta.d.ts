import { type ReviewDomainName } from '../review/config.js';
import { type ChainLink, type ChainNode } from './carry.js';
import { type ReadRecord } from './reviews.js';
/**
 * Reviews carried over a delta that leaves their perimeter, and reviews of the delta (docs/ACCELERATION-LOTS.md, part B).
 *
 * A review recorded at C, a commit of the pull request below the head C', counts at C' for a domain other than securite
 * when every step of the change from C to C' (each first-parent link, and each run of links as one change) is outside
 * the perimeter of the domain: the plan of the reviews (planReviews, settings read at the base of the pull request)
 * does not retain the domain for it, and, for fidelite, it touches no screen (touchesNoScreen). The chain is walked from
 * the head, nearest first, MAX_REPORT_WALK commits at most (carry.ts); a blocking review (a critical or high finding) of
 * the domain at any commit of the walk blocks, and the first step that touches the perimeter breaks the report: a new
 * review is asked for, of the whole change or of the delta.
 *
 * securite is never carried that way: a review of the delta (`apv review record --delta-from C`) is recorded at C' by
 * its reviewer, and counts when C is an ancestor of C' on the branch, the files it recorded are the diff C..C'
 * recomputed, and the review it starts from is usable at C (itself a review of a delta, MAX_DELTA_CHAIN in a row at
 * most). Every domain has the same review of the delta, for a delta that touches its perimeter.
 *
 * The review of the head always decides; this only applies when the head has none of the domain.
 */
/** Reviews of the delta in a row, each starting from the one before, until a review of the whole change. */
export declare const MAX_DELTA_CHAIN = 5;
export interface DeltaContext {
    repo: string;
    common: string;
    /** The target, resolved; null: nothing is carried. */
    target: string | null;
    /** Why the change of a span touches the perimeter of the domain, one line per cause; empty when it touches nothing. */
    touches(domain: ReviewDomainName, span: ChainLink): string[];
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
    /** A review of an earlier commit of the branch carried to the head over a delta outside the perimeter; never securite. */
    reported(domain: ReviewDomainName): Picked | null;
    /** The nearest commit of the branch below the head with a usable review of the domain: where a review of the delta starts. */
    deltaStart(domain: ReviewDomainName): string | null;
    /** The commits of the branch walked from the head (carry.ts, prChain). */
    chain(): ChainNode[];
}
export declare function reviewChain(ctx: DeltaContext, head: string): ReviewChain;
