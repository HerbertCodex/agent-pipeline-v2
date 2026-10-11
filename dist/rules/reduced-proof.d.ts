import type { Decision } from '../lifecycle/decisions.js';
import { type ReducedProofDeclaration } from '../orders/config.js';
import { type OperatorMessage } from './operator.js';
/**
 * The reduced proof (docs/PREUVE-REDUITE.md): the check run of the job `rules.operatorOrders.reducedProof` declares, in
 * place of the full suite, for a merge on a signed order only.
 */
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
