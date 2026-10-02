import type { GateReceipt } from '../domain/contracts.js';

/**
 * A check that failed because of its infrastructure, not of the code it tests: a variable of its environment absent,
 * a test stack or a service it reaches unreachable (refused connection, stopped container), a copy or an executable
 * missing. Told apart from a test that fails, so that a batch is never bisected nor a pull request blamed for it
 * (lessons of the night of 2 October 2026: `SUPABASE_TEST_URL` absent from a batch, a Docker container left
 * « Created » under load). It is a reading of the output, never a proof: the receipt keeps its status, the check stays
 * failed, only the next step changes (repair the infrastructure, then run again).
 */
export type InfrastructureKind = 'environment' | 'unreachable' | 'setup';
export interface InfrastructureCause {
  gateId: string;
  kind: InfrastructureKind;
  /** What was read, in a few words (the variable, the line of the output). */
  detail: string;
}

const NAME = String.raw`[A-Z][A-Z0-9_]{2,}`;
/** « Variable X absente », « environment variable X is not set », « missing environment variable: X », « X is not set ». */
const ENV_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\bvariables?(?:\s+d['’]environnement)?\s+[\x60"'«]?\s*(${NAME})\s*[\x60"'»]?\s+(?:absente|manquante|non\s+définie|vide|missing|is\s+not\s+set|not\s+set|is\s+not\s+defined|is\s+undefined|undefined|is\s+required|is\s+empty)`, 'i'),
  new RegExp(String.raw`\benv(?:ironment)?\s+var(?:iable)?s?\s+[\x60"']?(${NAME})[\x60"']?\s+(?:is\s+)?(?:missing|not\s+set|not\s+defined|undefined|required|empty)`, 'i'),
  new RegExp(String.raw`\b(?:missing|absente?s?|manquantes?)\s+(?:required\s+)?(?:environment\s+variables?|env(?:ironment)?\s+var(?:iable)?s?|variables?\s+d['’]environnement)\s*:?\s*[\x60"'«]?\s*(${NAME})`, 'i'),
  new RegExp(String.raw`\b(${NAME})\s+(?:is\s+not\s+set|is\s+not\s+defined|must\s+be\s+set|is\s+required\s+in\s+the\s+environment)\b`),
];
/** A service or a test stack that does not answer: refused connection, stopped container, Docker unreachable. */
const UNREACHABLE_PATTERNS: readonly RegExp[] = [
  /\bECONNREFUSED\b[^\n]*/,
  /\bconnection refused\b[^\n]*/i,
  /\bconnexion refusée\b[^\n]*/i,
  /\bcould not connect to (?:server|database)\b[^\n]*/i,
  /\bCannot connect to the Docker daemon\b[^\n]*/,
  /\bfailed to set up container networking\b[^\n]*/i,
  /\bsupabase start is not running\b[^\n]*/i,
  /\bcontainer [^\n]{0,120}\bis not running\b[^\n]*/i,
  /\bNo such container\b[^\n]*/,
  /\bgetaddrinfo (?:EAI_AGAIN|ENOTFOUND) (?:localhost|127\.0\.0\.1|host\.docker\.internal)\b[^\n]*/,
];

const clip = (text: string): string => text.trim().replace(/\s+/g, ' ').slice(0, 200);

/**
 * Why a failed check failed for its infrastructure, or null (a test that fails, or nothing recognised).
 * `missing`: the variables the check receives (its `passEnv`) that were absent from its environment; one of them
 * named by the output is the strongest sign. Only failed, timed out or unstarted checks are read.
 */
export function infrastructureCause(receipt: Pick<GateReceipt, 'gateId' | 'status' | 'diagnostic'>, missing: readonly string[] = []): InfrastructureCause | null {
  if (!['failed', 'timed_out', 'spawn_error'].includes(receipt.status)) return null;
  const text = receipt.diagnostic ?? '';
  const of = (kind: InfrastructureKind, detail: string): InfrastructureCause => ({ gateId: receipt.gateId, kind, detail: clip(detail) });
  if (receipt.status === 'spawn_error') {
    if (/^Copie de la pile /.test(text)) return of('setup', text.split('\n')[0]!);
    if (/^Executable unavailable: /.test(text)) return of('setup', `exécutable introuvable : ${text.slice('Executable unavailable: '.length).split('\n')[0]}`);
  }
  const named = missing.find(name => new RegExp(String.raw`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text));
  if (named) return of('environment', `variable ${named} absente de l'environnement du contrôle`);
  for (const pattern of ENV_PATTERNS) {
    const m = pattern.exec(text);
    if (m) return of('environment', `variable ${m[1]} absente : ${m[0]}`);
  }
  for (const pattern of UNREACHABLE_PATTERNS) {
    const m = pattern.exec(text);
    if (m) return of('unreachable', m[0]);
  }
  return null;
}

/** Words of a cause, for a report line. */
export function infrastructureText(cause: InfrastructureCause): string {
  const kind = cause.kind === 'environment' ? 'variable d\'environnement absente' : cause.kind === 'unreachable' ? 'pile de test ou service injoignable' : 'préparation impossible';
  return `${cause.gateId} : ${kind} (${cause.detail})`;
}

/** What to do about failures of the infrastructure, generic to every project. */
export function infrastructureAdvice(causes: readonly InfrastructureCause[], stacksDeclared: readonly string[]): string {
  const steps: string[] = [];
  if (causes.some(c => c.kind === 'environment')) {
    steps.push(stacksDeclared.length
      ? `donner l'environnement des piles de test : --stacks <pile> (déclarées : ${stacksDeclared.join(', ')}), ou exporter les variables nommées avant la commande`
      : 'exporter les variables nommées avant la commande (passEnv du contrôle)');
  }
  if (causes.some(c => c.kind === 'unreachable')) {
    steps.push(stacksDeclared.length ? 'vérifier que la pile répond (apv stacks status, apv stacks start <pile> sous son verrou)' : 'vérifier que le service de test répond (conteneurs, ports)');
  }
  if (causes.some(c => c.kind === 'setup')) steps.push('réparer la préparation (copie, exécutable)');
  return `panne d'infrastructure, pas un test en échec : ${steps.join(' ; ')} ; puis relancer`;
}

/**
 * The failures of a run that are infrastructure: one cause per failed check recognised, and whether every failure
 * is one (`all`; cancelled checks stopped by the first failure, and checks blocked by a failed dependency, are not failures of their own).
 */
export function classifyFailures(receipts: readonly Pick<GateReceipt, 'gateId' | 'status' | 'diagnostic'>[], missing: ReadonlyMap<string, readonly string[]>): { causes: InfrastructureCause[]; all: boolean } {
  const failed = receipts.filter(r => ['failed', 'timed_out', 'spawn_error'].includes(r.status));
  const causes = failed.map(r => infrastructureCause(r, missing.get(r.gateId) ?? [])).filter((c): c is InfrastructureCause => c !== null);
  return { causes, all: failed.length > 0 && causes.length === failed.length };
}
