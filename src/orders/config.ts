import { hash } from '../domain/hash.js';
import { s, type Infer } from '../domain/schema.js';
import { matches } from '../policy/policy.js';
import { REQUIRED_WEB_GATES, runsCommand } from '../rules/required.js';
import { DOMAIN_PATTERN, readPublicKey } from './envelope.js';
import { PROBE_SLUG, REFUSED_PROBES } from './paths.js';

/**
 * `rules.operatorOrders` of `.apv/config.json` (docs/REGLES.md, « Fusion sur ordre signé »), always read at the base of
 * the merge (a pull request never changes the rules it is checked against):
 * - `domain`: the domain of the signed messages of the project (`<domain>:signed:1:<kind>`, comment `<domain>-signed:1`);
 * - `publicKeys`: the Ed25519 public keys of the signer (PEM SPKI or its base64 line), two during a rotation; never a
 *   private key (refused by the loader, never echoed);
 * - `attestation`: the address of the production that attests an order is open, with `{nonce}` and `{challenge}`
 *   replaced by APV (HTTPS only, no exception: the tests of the tool replace the network, never the address), and
 *   `maxAgeSeconds`, the longest time between the attestation and the push of the merge (120 by default);
 * - `publicationBranch` (optional): the branch the publication pull request must come from, `{slug}` replaced by the
 *   `slug` the order signed (`publication/{slug}`); absent, only the command of the project binds that pull request to
 *   the order (closed list of files, content regenerated from the signed proposal);
 * - `paths.publication` and `paths.article`: the globs each pull request of an order may change (`{slug}` replaced by
 *   the slug the order signed); required for a merge on order, never covering a path of the refusal list of APV;
 * - `verify.publication`: the command of the project that checks the content of a step, run by APV from a clean copy
 *   of the trusted base, the verified order on its input, with whole arguments replaced: `{{trusted}}` the trusted base
 *   (where the keys and the configuration are read: the project reads its keys there too), `{{base}}` the commit the
 *   step merges on (the target at that moment, which may already contain the publication head), `{{head}}`, `{{step}}`;
 * - `reducedProof` (optional, docs/PREUVE-REDUITE.md): the check run of a job that stands in for the full suite in a
 *   merge on order only, when the diff of the step holds in a closed list of regenerated content; `gates` it runs whole,
 *   `waives` it does not run (the only declaration of `rules` that lifts checks: its addition or widening needs an
 *   anchored decision of the operator, checked by `apv rules check`).
 */
export const DEFAULT_ATTESTATION_MAX_AGE_SECONDS = 120;
export const DEFAULT_ATTESTATION_TIMEOUT_MS = 15_000;
export const DEFAULT_VERIFY_TIMEOUT_MS = 900_000;
/** Placeholders of `verify.publication`, replaced as whole arguments. */
export const VERIFY_PLACEHOLDERS = ['trusted', 'base', 'head', 'step'] as const;

const gateId = s.string(1, 80, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const stepPaths = s.optional(s.array(s.string(1, 500), 1, 100));

/** `rules.operatorOrders.reducedProof` (docs/PREUVE-REDUITE.md, section 4). */
export const reducedProofSchema = s.object({
  /** The workflow file, under `.github/workflows/`; never the one of rules.ciProof. */
  workflow: s.string(1, 200, /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/),
  /** The key of the job in the workflow (`jobs.<job>`). */
  job: s.string(1, 100, /^[A-Za-z_][A-Za-z0-9_-]*$/),
  /** The name of its check run (`name:` of the job); never the one of rules.ciProof. */
  name: s.string(1, 200, /^[^\u0000-\u001f\u007f]+$/),
  /** The checks of the configuration the job runs whole: the check run stands in for their receipts. */
  gates: s.array(gateId, 1, 50),
  /** The checks of the full suite the reduced lane does not run: not required in the lane, and there only. */
  waives: s.array(gateId, 1, 50),
  /** What the job proves besides `gates`, in one readable sentence: copied in the output, never interpreted. */
  covers: s.string(1, 1000),
  /** The closed list of paths, per step, a copy of motifs of rules.operatorOrders.paths, literal (`{slug}` only). */
  paths: s.object({ publication: stepPaths, article: stepPaths }),
  /** Files that produce the reduced proof, added to the defaults (CI_PROTECTED_DEFAULTS); never fewer. */
  protectedPaths: s.optional(s.array(s.string(1, 500), 0, 100)),
  /** The artifact of the receipts of the job: for the measure only, never read by the rule. */
  artifact: s.optional(s.string(1, 100, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
});
export type ReducedProofDeclaration = Infer<typeof reducedProofSchema>;

export const operatorOrdersSchema = s.object({
  domain: s.string(1, 63, DOMAIN_PATTERN),
  publicKeys: s.array(s.string(1, 4096), 1, 4),
  attestation: s.object({
    url: s.string(1, 2000),
    maxAgeSeconds: s.default(s.number(10, 600), DEFAULT_ATTESTATION_MAX_AGE_SECONDS),
    timeoutMs: s.default(s.number(1000, 120_000), DEFAULT_ATTESTATION_TIMEOUT_MS),
  }),
  publicationBranch: s.optional(s.string(1, 200, /^[A-Za-z0-9._/{}-]+$/)),
  paths: s.optional(s.object({
    publication: s.array(s.string(1, 500), 1, 100),
    article: s.array(s.string(1, 500), 1, 100),
  })),
  verify: s.object({
    publication: s.array(s.string(1, 4000), 1, 100),
    timeoutMs: s.default(s.number(1000, 3_600_000), DEFAULT_VERIFY_TIMEOUT_MS),
  }),
  reducedProof: s.optional(reducedProofSchema),
});
export type OperatorOrdersSettings = Infer<typeof operatorOrdersSchema>;

const PROBLEMS = {
  private: 'clé privée refusée (seule la clé publique se déclare ; la clé privée reste en production)',
  unreadable: 'clé publique illisible (PEM SPKI ou sa ligne base64 attendus)',
  not_ed25519: 'clé publique d\'un autre algorithme que Ed25519',
} as const;

/** The attestation address with its placeholders replaced (values already checked as UUID). */
export function attestationUrl(template: string, nonce: string, challenge: string): string {
  return template.replace('{nonce}', encodeURIComponent(nonce)).replace('{challenge}', encodeURIComponent(challenge));
}

/** The branch of the publication pull request an order names (`publicationBranch` with its slug), or null when undeclared or unreadable. */
export function publicationBranchOf(template: string | undefined, slug: unknown): string | null {
  if (template === undefined || typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) return null;
  return template.replace('{slug}', slug);
}

/** What the loader reads besides `rules.operatorOrders` to check `reducedProof`: the checks and the other rules. */
export interface OrdersContext {
  gates: readonly { id: string; command: readonly string[] }[];
  ciProof?: { workflow: string; name: string } | undefined;
  requiredGates?: readonly { id: string; command: readonly string[] }[] | undefined;
}

/** Every problem of a declaration that the schema cannot see: keys, address, placeholders. Never echoes a key. */
export function operatorOrdersIssues(settings: OperatorOrdersSettings, context: OrdersContext = { gates: [] }): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  settings.publicKeys.forEach((text, index) => {
    const read = readPublicKey(text);
    if ('problem' in read) issues.push(`rules.operatorOrders.publicKeys[${index}] : ${PROBLEMS[read.problem]}`);
    else if (ids.has(read.id)) issues.push(`rules.operatorOrders.publicKeys[${index}] : clé déclarée deux fois (${read.id})`);
    else ids.add(read.id);
  });
  const template = settings.attestation.url;
  const count = (mark: string): number => template.split(mark).length - 1;
  if (count('{nonce}') !== 1 || count('{challenge}') !== 1 || template.replace('{nonce}', '').replace('{challenge}', '').match(/[{}]/)) {
    issues.push('rules.operatorOrders.attestation.url : {nonce} et {challenge} attendus une fois chacun, aucune autre accolade');
  } else {
    let url: URL | null = null;
    try { url = new URL(attestationUrl(template, '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000')); } catch { url = null; }
    if (!url) issues.push('rules.operatorOrders.attestation.url : adresse illisible');
    else if (url.username || url.password) issues.push('rules.operatorOrders.attestation.url : aucun identifiant dans l\'adresse');
    else if (url.protocol !== 'https:') {
      issues.push('rules.operatorOrders.attestation.url : HTTPS attendu');
    }
  }
  const branch = settings.publicationBranch;
  if (branch !== undefined && (branch.split('{slug}').length !== 2 || /[{}]/.test(branch.replace('{slug}', '')) || branch.includes('..')
    || /^[/-]/.test(branch) || branch.endsWith('/') || branch.endsWith('.lock'))) {
    issues.push('rules.operatorOrders.publicationBranch : {slug} attendu une fois, aucune autre accolade, ni « .. », ni « / » ou « - » en tête');
  }
  for (const [step, globs] of Object.entries(settings.paths ?? {})) {
    for (const glob of globs) {
      if (glob.includes('**')) { issues.push(`rules.operatorOrders.paths.${step} : ** refusé dans ${glob} (chemins littéraux, * dans un seul segment, {slug} pour le slug signé)`); continue; }
      const probe = glob.replaceAll('{slug}', PROBE_SLUG);
      let covered: string | undefined;
      try { covered = REFUSED_PROBES.find(path => matches(path, probe)); }
      catch { issues.push(`rules.operatorOrders.paths.${step} : motif ${glob} illisible (*, ** et ? seulement, {slug} pour le slug signé)`); continue; }
      if (covered) issues.push(`rules.operatorOrders.paths.${step} : le motif ${glob} couvre un chemin que la fusion sur ordre refuse toujours (${covered})`);
    }
  }
  const uses = (key: string): boolean => settings.verify.publication.includes(`{{${key}}}`);
  if (uses('base') && !uses('trusted')) {
    issues.push('rules.operatorOrders.verify.publication : {{base}} sans {{trusted}} ; les clés et la configuration se lisent à {{trusted}}, la base de confiance ({{base}} peut contenir la tête de publication)');
  }
  for (const arg of settings.verify.publication) {
    if (!arg.includes('{{')) continue;
    const key = /^\{\{([A-Za-z]+)\}\}$/.exec(arg)?.[1];
    if (!key || !(VERIFY_PLACEHOLDERS as readonly string[]).includes(key)) {
      issues.push(`rules.operatorOrders.verify.publication : marque inconnue ou partielle ${arg} (arguments entiers seulement : ${VERIFY_PLACEHOLDERS.map(k => `{{${k}}}`).join(', ')})`);
    }
  }
  if (settings.reducedProof) issues.push(...reducedProofIssues(settings, settings.reducedProof, context));
  return issues;
}

const STEPS = ['publication', 'article'] as const;

/**
 * The problems of `reducedProof` (docs/PREUVE-REDUITE.md, section 4.1): checks shared or unknown, a check APV requires
 * lifted (by its id or by its command, F1), the workflow or the name of rules.ciProof, paths that are not literal
 * copies of rules.operatorOrders.paths (F3), protected paths that cover a content path.
 */
function reducedProofIssues(settings: OperatorOrdersSettings, rp: ReducedProofDeclaration, context: OrdersContext): string[] {
  const issues: string[] = [];
  const at = 'rules.operatorOrders.reducedProof';
  const declared = new Set(context.gates.map(g => g.id));
  for (const id of rp.gates.filter(g => rp.waives.includes(g))) issues.push(`${at} : ${id} à la fois dans gates et dans waives`);
  for (const field of ['gates', 'waives'] as const) {
    for (const id of rp[field].filter(g => !declared.has(g))) issues.push(`${at}.${field} : ${id} n'est pas un contrôle déclaré (gates de la configuration)`);
  }
  const required = [...REQUIRED_WEB_GATES, ...(context.requiredGates ?? [])];
  for (const id of rp.waives) {
    if (required.some(r => r.id === id)) { issues.push(`${at}.waives : ${id} est un contrôle exigé par APV, jamais levé (rapide et sans pile)`); continue; }
    const command = context.gates.find(g => g.id === id)?.command;
    const runs = command ? required.find(r => runsCommand(command, r.command)) : undefined;
    if (runs) issues.push(`${at}.waives : ${id} lance un contrôle exigé (${runs.id} : ${runs.command.join(' ')}), jamais levé`);
  }
  if (context.ciProof?.workflow === rp.workflow) issues.push(`${at}.workflow : celui de rules.ciProof (${rp.workflow}) ; une preuve ne se lit jamais pour l'autre`);
  if (context.ciProof?.name === rp.name) issues.push(`${at}.name : celui de rules.ciProof (« ${rp.name} ») ; une preuve ne se lit jamais pour l'autre`);
  const steps = STEPS.filter(step => rp.paths[step] !== undefined);
  if (!steps.length) issues.push(`${at}.paths : au moins une étape (publication, article)`);
  if (!settings.paths) issues.push(`${at} : rules.operatorOrders.paths absent, rien à quoi comparer reducedProof.paths`);
  for (const step of steps) {
    for (const glob of rp.paths[step]!) {
      if (/[*?]/.test(glob)) { issues.push(`${at}.paths.${step} : *, ? et ** refusés dans ${glob} (chemins littéraux, {slug} seul remplacé)`); continue; }
      if (settings.paths && !settings.paths[step].includes(glob)) issues.push(`${at}.paths.${step} : ${glob} n'est pas un motif de rules.operatorOrders.paths.${step} (recopié caractère pour caractère)`);
    }
  }
  for (const guard of rp.protectedPaths ?? []) {
    let covered: string | undefined;
    try { covered = steps.flatMap(step => rp.paths[step]!).find(glob => matches(glob.replaceAll('{slug}', PROBE_SLUG), guard)); }
    catch { issues.push(`${at}.protectedPaths : motif ${guard} illisible`); continue; }
    if (covered) issues.push(`${at}.protectedPaths : ${guard} couvre le chemin de contenu ${covered} (un fichier ne peut pas être à la fois testé et ce qui produit la preuve)`);
  }
  return issues;
}

/**
 * The fingerprint of a declaration (docs/PREUVE-REDUITE.md, 4.3): the first 12 characters of the SHA-256 of its canonical
 * form and of the blob of its workflow at the head (F-A2 of the review of the code: the text of the job is what stands in
 * for the lifted checks), null when the workflow is absent.
 */
export function reducedProofPrint(rp: ReducedProofDeclaration, workflowBlob: string | null): string {
  return hash({ declaration: rp, workflow: workflowBlob }).slice(0, 12);
}

/**
 * Why the declaration of the head widens the one of the base (docs/PREUVE-REDUITE.md, 4.3), empty when it does not:
 * added; workflow, job or name changed; the workflow file itself changed (its blob, F-A2); a check of `gates` or
 * `waives`, a motif of `paths` added; a protected path removed. Removing the declaration, a check, a motif, or adding a protected path never widens it.
 */
export function reducedProofWidening(base: ReducedProofDeclaration | undefined, head: ReducedProofDeclaration | undefined,
  workflow: { base: string | null; head: string | null } = { base: null, head: null }): string[] {
  if (!head) return [];
  if (!base) return ['déclaration ajoutée'];
  const added = (before: readonly string[], after: readonly string[]): string[] => after.filter(x => !before.includes(x));
  const out: string[] = [];
  if (base.workflow !== head.workflow || base.job !== head.job || base.name !== head.name) out.push(`workflow, job ou nom changé (${head.workflow}, ${head.job}, « ${head.name} »)`);
  else if (workflow.base !== workflow.head) out.push(`workflow réduit ${head.workflow} modifié`);
  for (const field of ['gates', 'waives'] as const) {
    const plus = added(base[field], head[field]);
    if (plus.length) out.push(`${field} : + ${plus.join(', ')}`);
  }
  for (const step of STEPS) {
    const plus = added(base.paths[step] ?? [], head.paths[step] ?? []);
    if (plus.length) out.push(`paths.${step} : + ${plus.join(', ')}`);
  }
  const minus = added(head.protectedPaths ?? [], base.protectedPaths ?? []);
  if (minus.length) out.push(`protectedPaths : - ${minus.join(', ')}`);
  return out;
}

/** One line of `apv status`: the declaration of the working tree, as the merge on order reads it at the base. */
export function operatorOrdersLine(settings: OperatorOrdersSettings | null, error: string | null = null): string {
  if (error) return `Ordres signés (rules.operatorOrders) : configuration illisible, aucune fusion sur ordre possible`;
  if (!settings) return 'Ordres signés (rules.operatorOrders) : non déclarés (aucune fusion sur ordre signé)';
  const keys = settings.publicKeys.map(readPublicKey).map(k => ('id' in k ? k.id : 'illisible')).join(', ');
  let host = 'adresse illisible';
  try { host = new URL(attestationUrl(settings.attestation.url, 'n', 'c')).host; } catch { /* said as unreadable */ }
  return `Ordres signés (rules.operatorOrders) : domaine ${settings.domain}, clé(s) ${keys} ; attestation par ${host}, `
    + `${settings.attestation.maxAgeSeconds} s au plus avant la poussée ; chemins permis : ${settings.paths ? `publication ${settings.paths.publication.join(', ')} ; article ${settings.paths.article.join(', ')}` : 'non déclarés (aucune fusion sur ordre)'} ; `
    + `vérification du projet : ${settings.verify.publication.join(' ')} `
    + `${settings.reducedProof ? `; ${reducedProofLine(settings.reducedProof)} ` : ''}`
    + '(lue à la base par apv stack merge --order)';
}

/** The reduced proof on the line of `apv status`: workflow, job and name, checks proven and lifted, paths per step. */
function reducedProofLine(rp: ReducedProofDeclaration): string {
  const paths = STEPS.filter(step => rp.paths[step]).map(step => `${step} ${rp.paths[step]!.join(', ')}`).join(' ; ');
  return `preuve réduite : ${rp.workflow}, job ${rp.job} « ${rp.name} » ; prouvés : ${rp.gates.join(', ')} ; levés : ${rp.waives.join(', ')} ; chemins : ${paths}`;
}
