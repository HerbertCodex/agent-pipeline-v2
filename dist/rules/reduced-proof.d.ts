import type { ApvConfig } from '../config/load.js';
import type { VerifyResult } from '../gates/verify.js';
import type { Decision } from '../lifecycle/decisions.js';
import { type ReducedProofDeclaration } from '../orders/config.js';
import type { OrderStep } from '../orders/order.js';
import type { GhRunner } from '../stack/github.js';
import { type CiProofOutcome } from './ci-proof.js';
import { type OperatorMessage } from './operator.js';
/**
 * The reduced proof (docs/PREUVE-REDUITE.md): the check run of the job `rules.operatorOrders.reducedProof` declares, in
 * place of the full suite, for a merge on a signed order only.
 */
/** A file the verification command of the project regenerated, with the id of the blob it produced. */
export interface RegeneratedFile {
    path: string;
    blob: string;
}
/**
 * The context of the reduced lane (docs/PREUVE-REDUITE.md, 5.1): built by mergeOnOrder alone, after the verification of
 * the project of the same try, passed in memory to the rules; never read from the environment, a file or an argument.
 */
export interface OrderLane {
    /** The reference of the order (said in the output). */
    nonce: string;
    step: OrderStep;
    /** T, M and H of the try. */
    trusted: string;
    target: string;
    head: string;
    /** The slug the order signed. */
    slug: unknown;
    /** rules.operatorOrders.reducedProof read at T, or null. */
    declaration: ReducedProofDeclaration | null;
    /** rules.ciProof read at T (its red check runs at H are never hidden), or null. */
    ciProof: {
        workflow: string;
        name: string;
    } | null;
    /** Whether the configuration of M has the fingerprint of the one of T (always true when M is T). */
    sameConfigAsTrusted: boolean;
    /** The verification of the project of this try: the head and base it ran for, what it says it regenerated, the shape it checked. */
    verified: {
        head: string;
        base: string;
        regenerated: RegeneratedFile[] | null;
        shape: string | null;
    };
}
/** What the rule preuve learns from the reduced lane. */
export interface ReducedLane {
    /** Whether the check run of the reduced job stands in for the full suite; otherwise the full suite is required. */
    retained: boolean;
    /** Why it is not retained (empty when it is). */
    reasons: string[];
    /** The checks it lifts (empty when not retained). */
    waived: string[];
    /** The checks the check run proves (pending ones of `gates`). */
    proven: string[];
    /** The regenerated content the reduced job executes. */
    content: string[];
    /** The outcome of the reduced check run, when it was read. */
    outcome: CiProofOutcome | null;
    nonce: string;
    step: OrderStep;
    covers: string | null;
}
/**
 * Why the text of the reduced workflow, read at T, may test another commit than the one of its run, hide a failure, or
 * be cancelled by its concurrency group (docs/PREUVE-REDUITE.md 5.5, M1 and F5): empty when it may not. Whatever the
 * YAML form (quoted keys, explicit keys, flow mappings): the words are refused anywhere.
 */
export declare function workflowTextProblems(text: string): string[];
export interface LaneInput {
    repo: string;
    /** The commit and the target the rules are checked at (resolved). */
    commit: string;
    target: string;
    mergeBase: string;
    lane: OrderLane;
    proof: VerifyResult;
    config: ApvConfig;
    gh: GhRunner | null;
    repository: string | null;
}
/**
 * The reduced lane (docs/PREUVE-REDUITE.md, section 5): every condition, then the check run of the reduced job. The
 * conditions read from Git come first, the API only when they hold. Never throws: an unreadable fact is a reason.
 */
export declare function reducedLane(input: LaneInput): Promise<ReducedLane>;
/**
 * Outside the lane (5.1): the step whose list would hold the diff (`{slug}` read as one segment), to say « voie réduite
 * possible sur ordre signé seulement »; null when none would.
 */
export declare function laneWouldFit(decl: ReducedProofDeclaration, files: readonly string[]): OrderStep | null;
/** The sentence the operator types himself to validate the declaration of fingerprint `print` (shown in the refusal). */
export declare function reducedProofSentence(print: string): string;
/**
 * The decision of the operator that validates a declaration of fingerprint `print` (section 4.3, finding E1), or null:
 * a decision of the ledger of the head absent from the base, of source `operator`, confirmed, whose quote holds the
 * fingerprint and is found word for word among the messages the operator typed (anchor key `key`, checked by the
 * caller). A decision an agent wrote alone, or an old sentence without the fingerprint, never counts.
 */
export declare function anchoredDecision(atBase: readonly Decision[], atHead: readonly Decision[], messages: readonly OperatorMessage[], key: Buffer | null, print: string): Decision | null;
/** What the rule preuve says of the declaration a change brings: nothing, a note (anchored), or a refusal with what to do. */
export type DeclarationVerdict = {
    kind: 'unchanged';
} | {
    kind: 'anchored';
    note: string;
} | {
    kind: 'refused';
    problem: string;
    todo: string[];
};
/**
 * The declaration of the head against the one of the base (section 4.3): widened without the anchored decision, the rule
 * preuve refuses, whatever proves the checks (a batch too). `decisions` reads the ledgers; an unreadable ledger holds no
 * decision.
 */
export declare function declarationVerdict(base: ReducedProofDeclaration | undefined, head: ReducedProofDeclaration | undefined, decisions: () => Promise<{
    atBase: readonly Decision[];
    atHead: readonly Decision[];
}>, messages: readonly OperatorMessage[], key: Buffer | null): Promise<DeclarationVerdict>;
