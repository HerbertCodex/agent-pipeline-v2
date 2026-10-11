import type { Decision } from '../lifecycle/decisions.js';
import { reducedProofPrint, reducedProofWidening, type ReducedProofDeclaration } from '../orders/config.js';
import { anchoredQuote, type OperatorMessage } from './operator.js';

/**
 * The reduced proof (docs/PREUVE-REDUITE.md): the check run of the job `rules.operatorOrders.reducedProof` declares, in
 * place of the full suite, for a merge on a signed order only.
 */

/** The sentence the operator types himself to validate the declaration of fingerprint `print` (shown in the refusal). */
export function reducedProofSentence(print: string): string {
  return `Je valide la preuve réduite ${print} pour les fusions sur ordre.`;
}

/**
 * The decision of the operator that validates a declaration of fingerprint `print` (section 4.3, finding E1), or null:
 * a decision of the ledger of the head absent from the base, of source `operator`, confirmed, whose quote holds the
 * fingerprint and is found word for word among the messages the operator typed (anchor key `key`, checked by the
 * caller). A decision an agent wrote alone, or an old sentence without the fingerprint, never counts.
 */
export function anchoredDecision(atBase: readonly Decision[], atHead: readonly Decision[], messages: readonly OperatorMessage[], key: Buffer | null, print: string): Decision | null {
  const before = new Set(atBase.map(d => d.id));
  return atHead.find(d => !before.has(d.id) && d.source === 'operator' && d.status === 'confirmed'
    && d.sourceQuote.toLowerCase().includes(print) && anchoredQuote(messages, d.sourceQuote, key) !== null) ?? null;
}

/** What the rule preuve says of the declaration a change brings: nothing, a note (anchored), or a refusal with what to do. */
export type DeclarationVerdict = { kind: 'unchanged' } | { kind: 'anchored'; note: string } | { kind: 'refused'; problem: string; todo: string[] };

/**
 * The declaration of the head against the one of the base (section 4.3): widened without the anchored decision, the rule
 * preuve refuses, whatever proves the checks (a batch too). `decisions` reads the ledgers; an unreadable ledger holds no
 * decision.
 */
export async function declarationVerdict(base: ReducedProofDeclaration | undefined, head: ReducedProofDeclaration | undefined,
  decisions: () => Promise<{ atBase: readonly Decision[]; atHead: readonly Decision[] }>, messages: readonly OperatorMessage[], key: Buffer | null): Promise<DeclarationVerdict> {
  const widening = reducedProofWidening(base, head);
  if (!widening.length || !head) return { kind: 'unchanged' };
  const print = reducedProofPrint(head);
  let read: { atBase: readonly Decision[]; atHead: readonly Decision[] };
  try { read = await decisions(); } catch { read = { atBase: [], atHead: [] }; }
  const found = anchoredDecision(read.atBase, read.atHead, messages, key, print);
  const why = widening.join(' ; ');
  if (found) return { kind: 'anchored', note: `preuve réduite élargie (${why}), décision ${found.id} de l'opérateur ancrée (empreinte ${print})` };
  return {
    kind: 'refused',
    problem: `déclaration de preuve réduite élargie sans décision de l'opérateur ancrée (${why}) ; empreinte ${print} (rules.operatorOrders.reducedProof lève des contrôles : docs/PREUVE-REDUITE.md, section 4.3)`,
    todo: [
      `L'opérateur tape lui-même dans la session : « ${reducedProofSentence(print)} »`,
      `Puis verse la décision dans .apv/DECISIONS.json : source operator, statut confirmed, cette phrase mot pour mot en sourceQuote (sujet rules.operatorOrders.reducedProof), commite et relance apv rules check.`,
    ],
  };
}
