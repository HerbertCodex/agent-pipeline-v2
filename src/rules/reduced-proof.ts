import type { ApvConfig } from '../config/load.js';
import type { VerifyResult } from '../gates/verify.js';
import type { Decision } from '../lifecycle/decisions.js';
import { reducedProofPrint, reducedProofWidening, type ReducedProofDeclaration } from '../orders/config.js';
import type { OrderStep } from '../orders/order.js';
import { rawDiff, stepGlobs } from '../orders/paths.js';
import type { RegeneratedFile } from '../orders/verify-command.js';
import { matches } from '../policy/policy.js';
import { gitRead } from '../run/git-probe.js';
import type { GhRunner } from '../stack/github.js';
import { checkRunsNamed, redCheckRun, verifyCiProof, type CiProofOutcome } from './ci-proof.js';
import { CI_PROTECTED_DEFAULTS, type CiProofSettings } from './config.js';
import { anchoredQuote, type OperatorMessage } from './operator.js';

export type { RegeneratedFile };

/**
 * The reduced proof (docs/PREUVE-REDUITE.md): the check run of the job `rules.operatorOrders.reducedProof` declares, in
 * place of the full suite, for a merge on a signed order only.
 */

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
  ciProof: { workflow: string; name: string } | null;
  /** Whether the configuration of M has the fingerprint of the one of T (always true when M is T). */
  sameConfigAsTrusted: boolean;
  /** The verification of the project of this try: the head and base it ran for, what it says it regenerated, the shape it checked. */
  verified: { head: string; base: string; regenerated: RegeneratedFile[] | null; shape: string | null };
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

/** Words of the text of the reduced workflow that let it test another commit or hide a failure (M1 of the review). */
const WORKFLOW_REFUSED: readonly [RegExp, string][] = [
  [/\binputs\b/, 'le mot inputs (entrées de workflow_dispatch, github.event.inputs, inputs.x : une entrée peut faire tester un autre commit)'],
  [/\bvars\s*\./, 'vars. (variables du dépôt, modifiables hors du dépôt)'],
  [/(?:^|[\s{,?-])["']?(?:ref|repository)["']?\s*:/m, 'une clé ref ou repository (sous actions/checkout ou ailleurs : un autre commit ou un autre dépôt)'],
  [/continue-on-error/, 'continue-on-error (un échec masqué)'],
  [/\|\|\s*(?:true\b|:|exit\s+0\b)/, '|| true, || : ou || exit 0 (un échec masqué)'],
];

/**
 * Why the text of the reduced workflow, read at T, may test another commit than the one of its run, hide a failure, or
 * be cancelled by its concurrency group (docs/PREUVE-REDUITE.md 5.5, M1 and F5): empty when it may not. Whatever the
 * YAML form (quoted keys, explicit keys, flow mappings): the words are refused anywhere.
 */
export function workflowTextProblems(text: string): string[] {
  const problems = WORKFLOW_REFUSED.filter(([pattern]) => pattern.test(text)).map(([, why]) => `workflow réduit : ${why}`);
  for (const m of text.matchAll(/cancel-in-progress["']?\s*:\s*([^\s#]+)/g)) {
    const value = m[1]!.replace(/^["']|["']$/g, '');
    if (value !== 'false') { problems.push(`workflow réduit : cancel-in-progress: false exigé (valeur ${value.slice(0, 40)}) ; une annulation au commit signé serait irrécupérable`); break; }
  }
  if (/(?:^|[\s{,])["']?concurrency["']?\s*:/m.test(text) && !/cancel-in-progress["']?\s*:\s*["']?false\b/.test(text)) {
    problems.push('workflow réduit : concurrency sans cancel-in-progress: false (écrit explicitement)');
  }
  return problems;
}

const short = (sha: string): string => sha.slice(0, 12);
const BLOB = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

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
export async function reducedLane(input: LaneInput): Promise<ReducedLane> {
  const { repo, lane, commit, mergeBase } = input;
  const decl = lane.declaration;
  const out = (reasons: string[], extra: Partial<ReducedLane> = {}): ReducedLane =>
    ({ retained: false, reasons, waived: [], proven: [], content: [], outcome: null, nonce: lane.nonce, step: lane.step, covers: decl?.covers ?? null, ...extra });
  const reasons: string[] = [];
  // 5.1: bound to its commit and target (F4), to the verification of this very try (M10).
  if (lane.head !== commit) reasons.push(`contexte de voie réduite d'un autre commit (${short(lane.head)}, règles vérifiées à ${short(commit)})`);
  if (lane.target !== input.target) reasons.push(`contexte de voie réduite d'une autre cible (${short(lane.target)}, règles vérifiées contre ${short(input.target)})`);
  if (lane.verified.head !== lane.head || lane.verified.base !== lane.target) {
    reasons.push(`vérification du projet faite pour un autre essai (tête ${short(lane.verified.head)}, base ${short(lane.verified.base)}), pas pour ${short(lane.head)} sur ${short(lane.target)}`);
  }
  // 5.2: the declaration of T, M of the same fingerprint.
  if (!decl) return out([...reasons, `rules.operatorOrders.reducedProof non déclarée à la base de confiance ${short(lane.trusted)}`]);
  if (!lane.sameConfigAsTrusted) reasons.push(`configuration de la cible ${short(lane.target)} différente de celle de la base de confiance ${short(lane.trusted)} (empreinte)`);
  // 5.3: the diff, every path in the list, added or modified only, regular files; regenerated at the publication.
  const stepList = decl.paths[lane.step];
  const globs = stepList ? stepGlobs(stepList, lane.slug) : null;
  if (!stepList) reasons.push(`rules.operatorOrders.reducedProof.paths.${lane.step} non déclaré : aucune voie réduite à cette étape`);
  else if (!globs) reasons.push(`rules.operatorOrders.reducedProof.paths.${lane.step} nomme {slug} et l'ordre ne signe aucun slug lisible`);
  const raw = gitRead(repo, ['diff', '--raw', '--no-renames', '--no-abbrev', '-z', mergeBase, commit]);
  const entries = raw === null ? null : rawDiff(raw);
  if (!entries) reasons.push(`diff illisible entre ${short(mergeBase)} et ${short(commit)}`);
  for (const e of entries ?? []) {
    if (e.status !== 'A' && e.status !== 'M') reasons.push(`suppression, renommage ou changement de type hors de la voie réduite : ${e.path}`);
    else if (e.mode !== '100644') reasons.push(`fichier de mode ${e.mode} hors de la voie réduite : ${e.path}`);
    if (globs && !globs.some(glob => { try { return matches(e.path, glob); } catch { return false; } })) reasons.push(`hors de rules.operatorOrders.reducedProof.paths.${lane.step} : ${e.path}`);
  }
  if (lane.step === 'publication') reasons.push(...regenerationProblems(lane.verified, entries ?? []));
  // 5.5: the workflow, the same blob at T, B, H (and M), its text read at T.
  const blobAt = (sha: string): string | null => gitRead(repo, ['rev-parse', '--verify', '--quiet', `${sha}:${decl.workflow}`]);
  const atTrusted = blobAt(lane.trusted);
  if (atTrusted === null) reasons.push(`workflow réduit ${decl.workflow} absent de la base de confiance ${short(lane.trusted)}`);
  else {
    const commits = [mergeBase, commit, ...(lane.target !== lane.trusted ? [lane.target] : [])];
    if (commits.some(sha => blobAt(sha) !== atTrusted)) reasons.push(`workflow réduit ${decl.workflow} différent entre la base de confiance, la base commune et la tête (et la cible) : seul compte celui de la base de confiance`);
    reasons.push(...workflowTextProblems(gitRead(repo, ['show', `${lane.trusted}:${decl.workflow}`]) ?? ''));
  }
  // 5.4 (M2 of the review): a failed local receipt of a lifted check is never hidden.
  const failed = input.proof.gates.filter(g => g.state === 'failed' && decl.waives.includes(g.gateId)).map(g => g.gateId);
  if (failed.length) reasons.push(`reçu local en échec d'un contrôle levé : ${failed.join(', ')} (un rouge observé n'est jamais levé par la voie réduite)`);
  if (reasons.length) return out(reasons);

  // 5.4 (M2): a red check run of rules.ciProof at H is never hidden either.
  if (lane.ciProof && input.gh && input.repository) {
    const name = lane.ciProof.name;
    const read = await checkRunsNamed(input.gh, input.repository, commit, name);
    if (!read.ok) return out([`check runs « ${name} » illisibles à ${short(commit)} (${read.why}) : un rouge ne peut pas être exclu`]);
    const red = read.runs.filter(redCheckRun);
    if (red.length) return out(red.slice(0, 5).map(r => `un rouge observé n'est jamais levé par la voie réduite : check run « ${name} » ${r.id} (${r.status === 'completed' ? r.conclusion ?? 'inconnue' : r.status}) au commit ${short(commit)}`));
  }
  // 5.4 to 5.6: the check run of the reduced job, read as the proof by the CI, with the regenerated content exempted.
  const pending = input.proof.gates.filter(g => (g.state === 'missing' || g.state === 'dirty') && decl.gates.includes(g.gateId)).map(g => g.gateId);
  const settings: CiProofSettings = { workflow: decl.workflow, job: decl.job, name: decl.name, gates: [...new Set(decl.gates)],
    protectedPaths: [...new Set([decl.workflow, ...CI_PROTECTED_DEFAULTS, ...(decl.protectedPaths ?? [])])], artifact: decl.artifact ?? null };
  const outcome = await verifyCiProof({ repo, mergeBase, head: commit, settings, pending, config: input.config, gh: input.gh, repository: input.repository,
    options: { field: 'rules.operatorOrders.reducedProof', events: new Set(), requireRun: true, exempt: new Set((entries ?? []).map(e => e.path)) } });
  if (outcome.state !== 'accepted') return out([...outcome.reasons, ...outcome.excluded.map(e => `${e.gate} : ${e.reason}`)].map(r => `preuve réduite : ${r}`), { outcome });
  return { retained: true, reasons: [], waived: [...decl.waives], proven: outcome.gates, content: outcome.content ?? [], outcome, nonce: lane.nonce, step: lane.step, covers: decl.covers };
}

/**
 * The regeneration the verification command of the project says (5.3, E2 and M4 of the review): every path of the
 * diff with the blob it has at the head, and the shape checked from T without executing the head.
 */
function regenerationProblems(verified: OrderLane['verified'], entries: readonly { path: string; blob: string; status: string }[]): string[] {
  const problems: string[] = [];
  const list = verified.regenerated;
  if (!list) problems.push('la commande du projet ne dit pas les fichiers régénérés (regenerated) : la régénération n\'est pas observable par l\'outil');
  else {
    const seen = new Map<string, string>();
    for (const r of list) {
      if (seen.has(r.path)) problems.push(`chemin en double dans regenerated : ${r.path}`);
      else seen.set(r.path, r.blob);
    }
    for (const e of entries.filter(x => x.status === 'A' || x.status === 'M')) {
      const said = seen.get(e.path);
      if (said === undefined) problems.push(`contenu non régénéré par la commande du projet : ${e.path}`);
      else if (!BLOB.test(said) || said !== e.blob) problems.push(`contenu non régénéré par la commande du projet : ${e.path} (blob ${said.slice(0, 12)}, à la tête ${e.blob.slice(0, 12)})`);
    }
  }
  if (verified.shape !== 'literal') problems.push('forme des fichiers régénérés non vérifiée par la commande du projet (shape « literal » attendu : arbre syntaxique lu depuis la base de confiance, sans exécuter la tête)');
  return problems;
}

/**
 * Outside the lane (5.1): the step whose list would hold the diff (`{slug}` read as one segment), to say « voie réduite
 * possible sur ordre signé seulement »; null when none would.
 */
export function laneWouldFit(decl: ReducedProofDeclaration, files: readonly string[]): OrderStep | null {
  if (!files.length) return null;
  for (const step of ['publication', 'article'] as const) {
    const globs = (decl.paths[step] ?? []).map(g => g.replaceAll('{slug}', '*'));
    if (globs.length && files.every(f => globs.some(g => { try { return matches(f, g); } catch { return false; } }))) return step;
  }
  return null;
}

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
 * The declaration of the head against the one of the base, with the blobs of the workflow of each (section 4.3):
 * widened without the anchored decision, the rule
 * preuve refuses, whatever proves the checks (a batch too). `decisions` reads the ledgers; an unreadable ledger holds no
 * decision.
 */
export async function declarationVerdict(base: ReducedProofDeclaration | undefined, head: ReducedProofDeclaration | undefined,
  workflow: { base: string | null; head: string | null },
  decisions: () => Promise<{ atBase: readonly Decision[]; atHead: readonly Decision[] }>, messages: readonly OperatorMessage[], key: Buffer | null): Promise<DeclarationVerdict> {
  const widening = reducedProofWidening(base, head, workflow);
  if (!widening.length || !head) return { kind: 'unchanged' };
  const print = reducedProofPrint(head, workflow.head);
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
