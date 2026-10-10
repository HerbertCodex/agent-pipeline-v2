import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { loadConfigAtCommit, type ApvConfig } from '../config/load.js';
import { errorMessage } from '../domain/errors.js';
import type { LotGit } from '../stack/batch.js';
import { VIEW_FIELDS, hostname, parsePullRequest, pullRequestPath, type GhCall, type GhRunner, type PullRequest } from '../stack/github.js';
import { requestAttestation, type Fetcher } from './attestation.js';
import type { OperatorOrdersSettings } from './config.js';
import { publicKeys } from './envelope.js';
import { UUID, mergeMessage, orderTrailers, verifyOrder, type OrderRefusal, type OrderStep, type VerifiedOrder } from './order.js';
import { runVerifyCommand, type VerifyInput, type VerifyResult } from './verify-command.js';

/**
 * `apv stack merge <publication> <article> --order <nonce>` (docs/REGLES.md, « Fusion sur ordre signé »): the merge of
 * the two pull requests of an operator order, with no session of the operator, each step once.
 *
 * For each step (publication, then article), in this order, `M` being the head of the target read at that moment:
 * 1. the order `nonce`, signed on the article pull request, verified offline with the keys of `M` (signature, repository,
 *    pull request, expiry, last signed decision by sequence number, head of the article pull request);
 * 2. not consumed: no commit of the first-parent history of `M` carries its trailer for this step (`nonce_used`;
 *    both steps there: `already_done`, nothing to do);
 * 3. the publication head `H` (read once, at the start) descends from `M` (`base`); the verification command of the
 *    project, from a clean copy of `M`, finds the content of the step to be the one the order signed (`verify`);
 * 4. the rules checked before any merge (`apv rules check`) at the merged head (`rules`);
 * 5. a fresh attestation of the production bound to a challenge drawn here (`attestation`);
 * 6. the merge commit of parents (`M`, head), with the trailer `Apv-Order`, pushed on the target without force within
 *    `maxAgeSeconds` of the attestation (a new attestation otherwise). A push refused because the target moved starts the
 *    step again on the new `M` (twice at most, then `main_moved`). Never the merge API of GitHub, never a forced push.
 */

export type OrderMergeCode = OrderRefusal | 'config' | 'github' | 'git' | 'nonce_used' | 'base' | 'verify' | 'rules' | 'attestation' | 'merge_conflict' | 'main_moved';

export interface OrderMergeStep { step: OrderStep; pr: number; head: string; base: string; mergeCommit: string }
export interface OrderMergeReport {
  status: 'merged' | 'already_done' | 'refused';
  code: OrderMergeCode | null;
  /** Why, in French; for `verify`, the code of the command of the project in `projectCode`. */
  reason: string | null;
  projectCode: string | null;
  target: string | null;
  /** Steps merged by this run, in order; the steps found already consumed are in `consumed`. */
  merged: OrderMergeStep[];
  consumed: OrderStep[];
  attestations: number;
  traceErrors: string[];
}

export interface OrderMergeOptions {
  repo: string;
  remote: string;
  publicationPr: number;
  articlePr: number;
  nonce: string;
  gh: GhRunner;
  git: LotGit;
  env: NodeJS.ProcessEnv;
  /** The rules checked before a merge at `head` against `<remote>/<target>`: the problems, empty when respected. */
  rules: (head: string, target: string) => Promise<string[]>;
  log?: (line: string) => void;
  onCall?: (call: GhCall) => void;
  /** The signed trace of a merge (`apv audit merges`); returns the error when it could not be written. */
  onMerged?: (merge: { pr: number; head: string; target: string; method: string; mergeCommit: string }) => string | null;
  fetch?: Fetcher;
  verify?: (input: VerifyInput) => Promise<VerifyResult>;
  now?: () => number;
  monotonic?: () => number;
  challenge?: () => string;
  /** Called just before each push (tests: another run, or someone else, moves the target there). */
  beforePush?: (step: OrderStep, commit: string) => Promise<void>;
}

/** Pushes refused because the target moved, after which the run stops (`main_moved`). */
export const MAX_PUSH_RETRIES = 2;
/** New attestations asked when the push comes later than `maxAgeSeconds` after one. */
const MAX_STALE_ATTESTATIONS = 2;
const COMMENTS_MAX_BYTES = 8 * 1024 * 1024;
const BRANCH = /^(?!-)[A-Za-z0-9._/-]{1,250}$/;

class Refusal extends Error {
  constructor(readonly code: OrderMergeCode, readonly reason: string, readonly projectCode: string | null = null) { super(reason); }
}

const short = (sha: string): string => sha.slice(0, 12);

export async function mergeOnOrder(options: OrderMergeOptions): Promise<OrderMergeReport> {
  const report: OrderMergeReport = { status: 'refused', code: null, reason: null, projectCode: null, target: null, merged: [], consumed: [], attestations: 0, traceErrors: [] };
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const challenge = options.challenge ?? randomUUID;
  const verify = options.verify ?? runVerifyCommand;
  const { repo, remote, git } = options;

  const gh = async (args: string[]): Promise<GhCall> => { const call = await options.gh(args); options.onCall?.(call); return call; };
  const mustGit = async (args: string[], what: string): Promise<string> => {
    const r = await git.run(repo, args);
    if (!r.ok) throw new Refusal('git', `${what} : ${r.stderr.trim().slice(-400) || 'git en échec'}`);
    return r.stdout.trim();
  };
  const readPr = async (n: number): Promise<PullRequest> => {
    const call = await gh(['pr', 'view', String(n), '--json', VIEW_FIELDS]);
    if (call.status !== 0 || call.error) throw new Refusal('github', `PR #${n} illisible (gh pr view)`);
    try { return parsePullRequest(call.stdout); } catch (error) { throw new Refusal('github', `PR #${n} illisible : ${errorMessage(error)}`); }
  };
  const fetchBranch = async (branch: string): Promise<string> => {
    if (!BRANCH.test(branch)) throw new Refusal('github', `nom de branche refusé : ${branch.slice(0, 80)}`);
    await mustGit(['fetch', '--no-tags', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], `récupération de ${branch}`);
    return mustGit(['rev-parse', '--verify', `refs/remotes/${remote}/${branch}^{commit}`], `tête de ${remote}/${branch}`);
  };
  const hasCommit = async (sha: string): Promise<boolean> => (await git.run(repo, ['cat-file', '-e', `${sha}^{commit}`])).ok;

  try {
    if (!UUID.test(options.nonce)) throw new Refusal('malformed', 'référence d\'ordre : UUID attendu');
    const publication = await readPr(options.publicationPr);
    let article = await readPr(options.articlePr);
    const where = pullRequestPath(article);
    if (!where || pullRequestPath(publication)?.repo !== where.repo) throw new Refusal('pr', 'les deux PR doivent venir du même dépôt GitHub, lu dans leur adresse');
    for (const pr of [publication, article]) {
      if (pr.crossRepository !== false) throw new Refusal('pr', `PR #${pr.number} : venue d'un fork, ou origine non dite par GitHub`);
      if (pr.state === 'CLOSED') throw new Refusal('pr', `PR #${pr.number} fermée sans fusion`);
    }
    const target = article.baseRefName;
    report.target = target;
    if (!BRANCH.test(target) || publication.baseRefName !== target) throw new Refusal('pr', `les deux PR doivent viser la même branche (${publication.baseRefName} et ${target})`);
    if (publication.headRefName === target || article.headRefName === target) throw new Refusal('pr', `une PR part de la branche cible ${target}`);
    const repoName = where.repo.slice('repos/'.length);
    const commentsArgs = ['api', ...hostname(where), '--paginate', `${where.repo}/issues/${options.articlePr}/comments`, '--jq', '.[] | .body | @json'];
    // H: the head of the publication pull request read once, at the start; a commit pushed later is never merged.
    const publicationHead = publication.headRefOid;

    let retries = 0;
    for (;;) {
      const base = await fetchBranch(target);
      // The configuration of the base, never the one of a pull request: keys, attestation, verification, setup, variables.
      let config: ApvConfig;
      try { config = loadConfigAtCommit(repo, base).config; }
      catch (error) { throw new Refusal('config', `configuration illisible à la base ${short(base)} : ${errorMessage(error).split('\n')[0]}`); }
      const settings = config.rules?.operatorOrders;
      if (!settings) throw new Refusal('config', `rules.operatorOrders non déclaré à la base ${short(base)} : aucune fusion sur ordre`);

      // 1. The order, read again at each step: a decision taken in between supersedes it.
      const comments = await gh(commentsArgs);
      if (comments.status !== 0 || comments.error) throw new Refusal('github', `commentaires de la PR #${options.articlePr} illisibles`);
      const bodies = readBodies(comments.stdout);
      if (!bodies) throw new Refusal('github', `commentaires de la PR #${options.articlePr} illisibles (format, ou plus de ${COMMENTS_MAX_BYTES} octets)`);
      article = await readPr(options.articlePr);
      const keys = publicKeys(settings.publicKeys);
      const verdict = verifyOrder({ domain: settings.domain, keys, bodies, repo: repoName, pr: options.articlePr, head: article.headRefOid, nonce: options.nonce, now: now() });
      if (!verdict.ok) throw new Refusal(verdict.code, ORDER_TEXT[verdict.code]);

      // 2. Consumption: the trailers of the first-parent history of the base.
      const history = await mustGit(['log', '--first-parent', '--format=%B%x1e', base], 'histoire de la base');
      const done = new Set(orderTrailers(history.split('\x1e')).filter(t => t.nonce === options.nonce).map(t => t.step));
      report.consumed = (['publication', 'article'] as const).filter(s => done.has(s) && !report.merged.some(m => m.step === s));
      if (done.has('publication') && done.has('article')) { report.status = 'already_done'; return report; }
      if (done.has('article')) throw new Refusal('nonce_used', 'étape article déjà consommée sans l\'étape publication : ordre inutilisable');
      const step: OrderStep = done.has('publication') ? 'article' : 'publication';
      const pr = step === 'publication' ? options.publicationPr : options.articlePr;
      const head = step === 'publication' ? publicationHead : verdict.order.articleSha;

      // 3. The content: the head descends from the base (publication), the command of the project from a clean copy.
      await fetchBranch(step === 'publication' ? publication.headRefName : article.headRefName);
      if (!(await hasCommit(head))) throw new Refusal('git', `commit ${short(head)} introuvable après récupération`);
      if (step === 'publication' && !(await git.run(repo, ['merge-base', '--is-ancestor', base, head])).ok) {
        throw new Refusal('base', `la tête ${short(head)} de la PR #${pr} ne descend pas de ${target} (${short(base)}) : fusionner ${target} dans la branche, nouvelle preuve`);
      }
      log(`Ordre ${options.nonce} : étape ${step}, PR #${pr} à ${short(head)} sur ${target} à ${short(base)} ; vérification du projet depuis une copie propre de la base.`);
      const checked = await verify({ repo, git, base, head, step, order: verdict, env: options.env,
        settings: { command: settings.verify.publication, timeoutMs: settings.verify.timeoutMs, passEnv: config.environment.passEnv,
          ...(config.batch?.setup ? { setup: { command: config.batch.setup, timeoutMs: config.batch.setupTimeoutMs } } : {}) } });
      if (!checked.ok) throw new Refusal('verify', `vérification du projet refusée : ${checked.detail}`, checked.projectCode);

      // 4. The rules checked before any merge, at the merged head.
      const problems = await options.rules(head, target);
      if (problems.length) throw new Refusal('rules', `règles avant fusion refusées à ${short(head)} :\n${problems.join('\n')}`);

      // 5. and 6. The attestation, then the merge commit pushed within its window.
      const tree = await git.run(repo, ['merge-tree', '--write-tree', base, head]);
      if (!tree.ok) throw new Refusal('merge_conflict', `fusion de ${short(head)} sur ${short(base)} en conflit`);
      const message = mergeMessage({ pr, step, nonce: options.nonce, digest: verdict.digest, head });
      const commit = await mustGit(['commit-tree', tree.stdout.trim().split('\n')[0]!, '-p', base, '-p', head, '-m', message], 'commit de fusion');
      await attest(settings, verdict, report, challenge, options.fetch);
      let attestedAt = monotonic();
      await options.beforePush?.(step, commit);
      for (let stale = 0; monotonic() - attestedAt > settings.attestation.maxAgeSeconds * 1000; stale += 1) {
        if (stale >= MAX_STALE_ATTESTATIONS) throw new Refusal('attestation', 'attestation trop ancienne au moment de la poussée, plusieurs fois : rien n\'est poussé');
        log(`Attestation de plus de ${settings.attestation.maxAgeSeconds} s : nouvelle demande, nouveau défi.`);
        await attest(settings, verdict, report, challenge, options.fetch);
        attestedAt = monotonic();
      }
      const pushed = await git.run(repo, ['push', '--porcelain', remote, `${commit}:refs/heads/${target}`]);
      if (!pushed.ok) {
        retries += 1;
        log(`Poussée sans force refusée (${target} a bougé ?) : ${pushed.stderr.trim().split('\n').pop()?.slice(0, 200) ?? ''} ; nouvelle vérification.`);
        if (retries > MAX_PUSH_RETRIES) throw new Refusal('main_moved', `${target} a bougé à chaque poussée (${retries} fois) : rien n'est fusionné de plus`);
        continue;
      }
      report.merged.push({ step, pr, head, base, mergeCommit: commit });
      log(`Étape ${step} fusionnée : ${short(commit)} (parents ${short(base)}, ${short(head)}), poussée sans force sur ${target}.`);
      const traced = options.onMerged?.({ pr, head, target, method: 'merge', mergeCommit: commit });
      if (traced) report.traceErrors.push(`trace de fusion de la PR #${pr} non écrite : ${traced}`);
      if (step === 'article') { report.status = 'merged'; return report; }
      retries = 0;
    }
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    Object.assign(report, { status: 'refused', code: error.code, reason: error.reason, projectCode: error.projectCode });
    return report;
  }
}

async function attest(settings: OperatorOrdersSettings, verdict: VerifiedOrder, report: OrderMergeReport, challenge: () => string, fetcher?: Fetcher): Promise<void> {
  report.attestations += 1;
  const result = await requestAttestation({ template: settings.attestation.url, timeoutMs: settings.attestation.timeoutMs, domain: settings.domain,
    keys: publicKeys(settings.publicKeys), order: verdict.order, challenge: challenge(), ...(fetcher ? { fetch: fetcher } : {}) });
  if (!result.ok) throw new Refusal('attestation', `attestation de la production refusée : ${result.reason}`);
}

/** The bodies of `gh api --paginate .../comments --jq '.[] | .body | @json'`: one JSON string per line; null when unreadable. */
export function readBodies(stdout: string): string[] | null {
  if (Buffer.byteLength(stdout, 'utf8') > COMMENTS_MAX_BYTES) return null;
  const bodies: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { return null; }
    if (typeof value === 'string') bodies.push(value);
    else if (value !== null) return null;
  }
  return bodies;
}

const ORDER_TEXT: Record<OrderRefusal, string> = {
  malformed: 'aucun ordre lisible de cette référence sur la PR d\'article (ligne signée absente ou malformée)',
  kind: 'la ligne signée n\'est pas un ordre de publication',
  key: 'ordre signé par une clé que la base ne déclare pas (rules.operatorOrders.publicKeys)',
  signature: 'signature de l\'ordre fausse (charge modifiée, ou autre domaine)',
  repo: 'ordre d\'un autre dépôt',
  pr: 'ordre d\'une autre PR d\'article',
  expired: 'ordre échu : une nouvelle décision de l\'opérateur est nécessaire',
  nonce_conflict: 'deux ordres signés différents sous la même référence',
  decision_conflict: 'deux décisions signées différentes sous le même numéro de séquence',
  decision_missing: 'la décision que l\'ordre exécute n\'est pas sur la PR',
  superseded: 'une décision signée plus récente (numéro de séquence plus grand) remplace celle de l\'ordre',
  head_moved: 'la PR d\'article n\'est plus au commit relu par l\'opérateur',
};
