import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { loadConfigAtCommit, type ApvConfig } from '../config/load.js';
import { hash } from '../domain/hash.js';
import { errorMessage } from '../domain/errors.js';
import { runProcess } from '../execution/process.js';
import type { LotGit } from '../stack/batch.js';
import { VIEW_FIELDS, hostname, parsePullRequest, pullRequestPath, type GhCall, type GhRunner, type PullRequest } from '../stack/github.js';
import { requestAttestation, type Fetcher } from './attestation.js';
import { publicationBranchOf, type OperatorOrdersSettings } from './config.js';
import { publicKeys } from './envelope.js';
import { COMMIT, HISTORY_LOG_FORMAT, UUID, mergeMessage, orderMergeCommits, readHistory, verifyOrder, type HistoryCommit, type OrderMergeCommit, type OrderRefusal, type OrderStep, type VerifiedOrder } from './order.js';
import { forbiddenPaths, stepGlobs } from './paths.js';
import { runVerifyCommand, type VerifyInput, type VerifyResult } from './verify-command.js';

/**
 * `apv stack merge <publication> <article> --order <nonce>` (docs/REGLES.md, section 3 ter): the merge of the two pull
 * requests of an operator order, with no session of the operator, each step once.
 *
 * Trusted base `T`, fixed for the whole run before anything is merged: the target as it was before any merge on this
 * order (its head at the start, or the first parent of the publication merge APV already made for this order). The keys,
 * the domain, the attestation address, the verification command, `batch.setup` and the variables are read at `T` only,
 * and the verification command always runs from a clean copy of `T`: nothing a pull request wrote (the publication head
 * merged at the first step included) is ever read as configuration or executed by the tool.
 *
 * For each step (publication, then article), in this order, `M` being the head of the target read at that moment:
 * 1. the order `nonce`, signed on the article pull request, verified offline with the keys of `T` (signature,
 *    repository, pull request, expiry, last signed decision by sequence number, head of the article pull request);
 * 2. not consumed: only merge commits APV made count (two parents, second parent equal to `Apv-Merged-Head`, trailer
 *    read by Git, `Apv-Order-Sha256` equal to the digest of this order); both steps there: `already_done`;
 * 3. the publication head `H` (read once, at the start) descends from `M` (`base`); the verification command of the
 *    project, from a clean copy of `T`, finds the content of the step to be the one the order signed (`verify`);
 * 4. the rules checked before any merge (`apv rules check`) at the merged head (`rules`);
 * 5. the tree of the merge is the tree verified: the one of `H` (publication), or only the files of the article pull
 *    request with their content at the signed commit (article);
 * 6. a fresh attestation of the production bound to a challenge drawn here (`attestation`);
 * 7. the merge commit of parents (`M`, head), with the trailer `Apv-Order`, pushed on the target without force within
 *    `maxAgeSeconds` of the attestation (a new attestation otherwise), the push bounded in time. A push refused because
 *    the target moved starts the step again on the new `M`, whose declaration must be the one of `T` (twice at most, then
 *    `main_moved`). Never the merge API of GitHub, never a forced push.
 */

export type OrderMergeCode = OrderRefusal | 'config' | 'github' | 'git' | 'nonce_used' | 'base' | 'verify' | 'rules' | 'attestation' | 'merge_conflict' | 'main_moved' | 'push' | 'paths';

export interface OrderMergeStep { step: OrderStep; pr: number; head: string; base: string; mergeCommit: string }
export interface OrderMergeReport {
  status: 'merged' | 'already_done' | 'refused';
  code: OrderMergeCode | null;
  /** Why, in French; for `verify`, the code of the command of the project in `projectCode`. */
  reason: string | null;
  projectCode: string | null;
  target: string | null;
  /** The trusted base of the run: the configuration was read there and the verification command ran from it. */
  trustedBase: string | null;
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
  /**
   * The rules checked before a merge at `head` against `base`, the exact commit of the target APV read and merges on
   * (never a remote-tracking ref that may be stale): the problems, empty when respected.
   */
  rules: (head: string, base: string) => Promise<string[]>;
  log?: (line: string) => void;
  onCall?: (call: GhCall) => void;
  /** The signed trace of a merge (`apv audit merges`); returns the error when it could not be written. */
  onMerged?: (merge: { pr: number; head: string; target: string; method: string; mergeCommit: string }) => string | null;
  fetch?: Fetcher;
  verify?: (input: VerifyInput) => Promise<VerifyResult>;
  now?: () => number;
  monotonic?: () => number;
  challenge?: () => string;
  /** Longest push (the attestation window is checked just before it). */
  pushTimeoutMs?: number;
  /** Called just before each push (tests: another run, or someone else, moves the target there). */
  beforePush?: (step: OrderStep, commit: string) => Promise<void>;
}

/** Pushes refused because the target moved, after which the run stops (`main_moved`). */
export const MAX_PUSH_RETRIES = 2;
export const DEFAULT_PUSH_TIMEOUT_MS = 60_000;
/** New attestations asked when the push comes later than `maxAgeSeconds` after one. */
const MAX_STALE_ATTESTATIONS = 2;
const COMMENTS_MAX_BYTES = 8 * 1024 * 1024;

class Refusal extends Error {
  constructor(readonly code: OrderMergeCode, readonly reason: string, readonly projectCode: string | null = null) { super(reason); }
}

const short = (sha: string): string => sha.slice(0, 12);

/** What the operator does when an order ends in `nonce_used` (docs/REGLES.md, section 3 ter). */
export const NONCE_USED_EXIT = 'Sortie : si l\'étape publication n\'est pas faite, une nouvelle décision de l\'opérateur dans l\'admin, donc un nouvel ordre (nouvelle référence) ; '
  + 'si elle est faite, la fusion de la PR d\'article à la main par le chef de projet, sur ordre tapé de l\'opérateur (cas limite 4 de la conception), que apv audit merges signale.';

/** A branch name read from GitHub that may be fetched: never `HEAD`, an option, a range or a reflog form. */
export function safeBranch(name: string): boolean {
  return /^[A-Za-z0-9._/-]{1,250}$/.test(name) && name !== 'HEAD' && !/^[-/.]/.test(name) && !name.endsWith('/') && !name.endsWith('.lock')
    && !name.includes('..') && !name.includes('//') && !name.split('/').some(part => part.startsWith('.'));
}

/** What a run fixes at its trusted base: the declaration of the orders, the setup of a copy and the variables given. */
function fingerprint(config: ApvConfig): string {
  return hash({ orders: config.rules?.operatorOrders ?? null, setup: config.batch?.setup ?? null, setupTimeoutMs: config.batch?.setupTimeoutMs ?? null,
    batchEnv: config.batch?.passEnv ?? null, passEnv: config.environment.passEnv });
}

export async function mergeOnOrder(options: OrderMergeOptions): Promise<OrderMergeReport> {
  const report: OrderMergeReport = { status: 'refused', code: null, reason: null, projectCode: null, target: null, trustedBase: null, merged: [], consumed: [], attestations: 0, traceErrors: [] };
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const challenge = options.challenge ?? randomUUID;
  const verify = options.verify ?? runVerifyCommand;
  const { repo, remote } = options;
  const run = (args: string[]): ReturnType<LotGit['run']> => options.git.run(repo, ['-c', 'core.fsmonitor=false', ...args]);
  /** Private refs of this run only (another run of the same order has its own), never a branch nor a remote-tracking ref; removed at the end. */
  const runRefs = `refs/apv/orders/${options.nonce}/${randomUUID()}/`;
  const privateRef = (name: string): string => `${runRefs}${name}`;

  const gh = async (args: string[]): Promise<GhCall> => { const call = await options.gh(args); options.onCall?.(call); return call; };
  const mustGit = async (args: string[], what: string): Promise<string> => {
    const r = await run(args);
    if (!r.ok) throw new Refusal('git', `${what} : ${r.stderr.trim().slice(-400) || 'git en échec'}`);
    return r.stdout.trim();
  };
  const readPr = async (n: number): Promise<PullRequest> => {
    const call = await gh(['pr', 'view', String(n), '--json', VIEW_FIELDS]);
    if (call.status !== 0 || call.error) throw new Refusal('github', `PR #${n} illisible (gh pr view)`);
    let pr: PullRequest;
    try { pr = parsePullRequest(call.stdout); } catch (error) { throw new Refusal('github', `PR #${n} illisible : ${errorMessage(error)}`); }
    if (!COMMIT.test(pr.headRefOid)) throw new Refusal('pr', `PR #${n} : tête rendue par GitHub qui n'est pas un commit de 40 caractères hexadécimaux`);
    if (!safeBranch(pr.headRefName) || !safeBranch(pr.baseRefName)) throw new Refusal('pr', `PR #${n} : nom de branche refusé (${pr.headRefName.slice(0, 80)})`);
    return pr;
  };
  const fetchInto = async (branch: string, name: string): Promise<string> => {
    await mustGit(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-auto-gc', '--end-of-options', remote, `+refs/heads/${branch}:${privateRef(name)}`], `récupération de ${branch}`);
    return mustGit(['rev-parse', '--verify', '--end-of-options', `${privateRef(name)}^{commit}`], `tête récupérée de ${branch}`);
  };
  const hasCommit = async (sha: string): Promise<boolean> => (await run(['cat-file', '-e', `${sha}^{commit}`])).ok;
  const configAt = (commit: string): ApvConfig => {
    try { return loadConfigAtCommit(repo, commit).config; }
    catch (error) { throw new Refusal('config', `configuration illisible à ${short(commit)} : ${errorMessage(error).split('\n')[0]}`); }
  };
  const ordersAt = (config: ApvConfig, commit: string): OperatorOrdersSettings => {
    const settings = config.rules?.operatorOrders;
    if (!settings) throw new Refusal('config', `rules.operatorOrders non déclaré à ${short(commit)} : aucune fusion sur ordre`);
    return settings;
  };

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
    if (publication.baseRefName !== target) throw new Refusal('pr', `les deux PR doivent viser la même branche (${publication.baseRefName} et ${target})`);
    if (publication.headRefName === target || article.headRefName === target) throw new Refusal('pr', `une PR part de la branche cible ${target}`);
    const repoName = where.repo.slice('repos/'.length);
    const commentsArgs = ['api', ...hostname(where), '--paginate', `${where.repo}/issues/${options.articlePr}/comments`, '--jq', '.[] | .body | @json'];
    const readOrder = async (settings: OperatorOrdersSettings) => {
      const comments = await gh(commentsArgs);
      if (comments.status !== 0 || comments.error) throw new Refusal('github', `commentaires de la PR #${options.articlePr} illisibles`);
      const bodies = readBodies(comments.stdout);
      if (!bodies) throw new Refusal('github', `commentaires de la PR #${options.articlePr} illisibles (format, ou plus de ${COMMENTS_MAX_BYTES} octets)`);
      article = await readPr(options.articlePr);
      return verifyOrder({ domain: settings.domain, keys: publicKeys(settings.publicKeys), bodies, repo: repoName, pr: options.articlePr,
        head: article.headRefOid, nonce: options.nonce, now: now() });
    };
    // The first-parent history of the target, read with NUL separators only (never a character a message may hold).
    const historyOf = async (base: string): Promise<HistoryCommit[]> => {
      const history = readHistory(await mustGit(['log', '--first-parent', HISTORY_LOG_FORMAT, '--end-of-options', base], 'histoire de la cible'));
      if (!history || history[0]?.sha !== base) throw new Refusal('git', `histoire de la cible illisible à ${short(base)} (chaîne de premiers parents attendue)`);
      return history;
    };
    const mergesOf = async (base: string): Promise<OrderMergeCommit[]> => orderMergeCommits(await historyOf(base)).filter(c => c.nonce === options.nonce);
    // H: the head of the publication pull request read once, at the start; a commit pushed later is never merged.
    const publicationHead = publication.headRefOid;

    // The trusted base: the target before any merge on this order. As soon as a well-formed publication merge of this
    // nonce is on the history (two parents, merged head as second parent), the base is the first parent of the oldest
    // one, whatever happens next: never a fall back on the current target, which may contain the publication head.
    const start = await fetchInto(target, 'cible');
    const startHistory = await historyOf(start);
    const publicationMerges = orderMergeCommits(startHistory).filter(c => c.nonce === options.nonce && c.step === 'publication');
    const trusted = publicationMerges.length ? publicationMerges[publicationMerges.length - 1]!.firstParent : start;
    // The trusted base is a commit of the first-parent chain of the target, never a commit named by a message.
    if (!startHistory.some(c => c.sha === trusted)) throw new Refusal('git', `base de confiance ${short(trusted)} hors de la chaîne de premiers parents de ${target}`);
    report.trustedBase = trusted;
    const trustedConfig = configAt(trusted);
    const settings = ordersAt(trustedConfig, trusted);
    const trustedPrint = fingerprint(trustedConfig);

    let retries = 0;
    let base = start;
    for (;;) {
      // 1. The order, read again at each step with the keys of the trusted base: a decision taken in between supersedes it.
      const verdict = await readOrder(settings);
      if (!verdict.ok) throw new Refusal(verdict.code, ORDER_TEXT[verdict.code]);

      // 2. Consumption: the merge commits APV made for this order, of this digest, on the first-parent history.
      const merges = await mergesOf(base);
      const done = consumedSteps(merges, verdict, { trusted, publicationPr: options.publicationPr, articlePr: options.articlePr, publicationHead,
        mergedHere: new Set(report.merged.map(m => m.mergeCommit)) });
      report.consumed = (['publication', 'article'] as const).filter(s => done.has(s) && !report.merged.some(m => m.step === s));
      if (done.has('publication') && done.has('article')) { report.status = 'already_done'; return report; }
      if (done.has('article')) throw new Refusal('nonce_used', `étape article déjà consommée sans l'étape publication : ordre inutilisable. ${NONCE_USED_EXIT}`);
      const step: OrderStep = done.has('publication') ? 'article' : 'publication';
      const pr = step === 'publication' ? options.publicationPr : options.articlePr;
      const head = step === 'publication' ? publicationHead : verdict.order.articleSha;

      // 3. The pull request of the step, its head, the content checked by the project from the trusted base.
      if (step === 'publication' && settings.publicationBranch !== undefined) {
        const expected = publicationBranchOf(settings.publicationBranch, verdict.order.payload['slug']);
        if (expected === null || publication.headRefName !== expected) {
          throw new Refusal('pr', `PR #${pr} : branche ${publication.headRefName.slice(0, 80)}, l'ordre désigne ${expected ?? 'un slug illisible'} (rules.operatorOrders.publicationBranch)`);
        }
      }
      await fetchInto(step === 'publication' ? publication.headRefName : article.headRefName, step);
      if (!(await hasCommit(head))) throw new Refusal('git', `commit ${short(head)} introuvable après récupération`);
      if (step === 'publication' && !(await run(['merge-base', '--is-ancestor', base, head])).ok) {
        throw new Refusal('base', `la tête ${short(head)} de la PR #${pr} ne descend pas de ${target} (${short(base)}) : fusionner ${target} dans la branche, nouvelle preuve`);
      }
      // The paths of the step, whatever the command of the project says: the allow list of the trusted base, and never
      // the refusal list of APV (configuration of APV, of the agents, of the CI, of Git, packages).
      if (!settings.paths) throw new Refusal('paths', 'rules.operatorOrders.paths non déclaré à la base de confiance : aucune fusion sur ordre sans liste des chemins permis');
      const globs = stepGlobs(settings.paths[step], verdict.order.payload['slug']);
      if (!globs) throw new Refusal('paths', `rules.operatorOrders.paths.${step} nomme {slug} et l'ordre ne signe aucun slug lisible`);
      const from = step === 'publication' ? base : await mustGit(['merge-base', base, head], 'base commune de la PR d\'article');
      const changed = (await mustGit(['diff', '--name-only', '--no-renames', '-z', from, head], 'fichiers changés')).split('\0').filter(Boolean);
      const forbidden = forbiddenPaths(changed, globs);
      if (forbidden.refused.length) throw new Refusal('paths', `la PR #${pr} change des chemins que la fusion sur ordre refuse toujours (${forbidden.refused.slice(0, 5).join(', ')})`);
      if (forbidden.outside.length) throw new Refusal('paths', `la PR #${pr} change des chemins hors de rules.operatorOrders.paths.${step} (${forbidden.outside.slice(0, 5).join(', ')})`);
      log(`Ordre ${options.nonce} : étape ${step}, PR #${pr} à ${short(head)} sur ${target} à ${short(base)} ; vérification du projet depuis une copie propre de la base de confiance ${short(trusted)}.`);
      const checked = await verify({ repo, git: options.git, source: trusted, base, head, step, order: verdict, env: options.env,
        settings: { command: settings.verify.publication, timeoutMs: settings.verify.timeoutMs, passEnv: trustedConfig.environment.passEnv,
          ...(trustedConfig.batch?.setup ? { setup: { command: trustedConfig.batch.setup, timeoutMs: trustedConfig.batch.setupTimeoutMs } } : {}) } });
      if (!checked.ok) throw new Refusal('verify', `vérification du projet refusée : ${checked.detail}`, checked.projectCode);

      // 4. The rules checked before any merge, at the merged head.
      const problems = await options.rules(head, base);
      if (problems.length) throw new Refusal('rules', `règles avant fusion refusées à ${short(head)} :\n${problems.join('\n')}`);

      // 5. The merge, whose tree must be the one verified.
      const merged = await run(['merge-tree', '--write-tree', base, head]);
      if (!merged.ok) throw new Refusal('merge_conflict', `fusion de ${short(head)} sur ${short(base)} en conflit`);
      const tree = merged.stdout.trim().split('\n')[0]!;
      await checkTree(step, tree, base, head);
      const message = mergeMessage({ pr, step, nonce: options.nonce, digest: verdict.digest, head });
      const commit = await mustGit(['commit-tree', tree, '-p', base, '-p', head, '-m', message], 'commit de fusion');

      // 6. and 7. The attestation, then the push within its window, bounded in time.
      await attest(settings, verdict, report, challenge, options.fetch);
      let attestedAt = monotonic();
      await options.beforePush?.(step, commit);
      for (let stale = 0; monotonic() - attestedAt > settings.attestation.maxAgeSeconds * 1000; stale += 1) {
        if (stale >= MAX_STALE_ATTESTATIONS) throw new Refusal('attestation', 'attestation trop ancienne au moment de la poussée, plusieurs fois : rien n\'est poussé');
        log(`Attestation de plus de ${settings.attestation.maxAgeSeconds} s : nouvelle demande, nouveau défi.`);
        await attest(settings, verdict, report, challenge, options.fetch);
        attestedAt = monotonic();
      }
      const pushed = await runProcess({
        command: ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'push', '--porcelain', '--no-verify', '--end-of-options', remote, `${commit}:refs/heads/${target}`],
        cwd: repo, env: { ...options.env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: options.pushTimeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS, maxOutputBytes: 64 * 1024,
      });
      if (pushed.status === 'timed_out') throw new Refusal('push', `poussée arrêtée au délai : issue inconnue ; relancer la même commande, le pied dira si l'étape ${step} est faite`);
      if (pushed.status !== 'passed') {
        retries += 1;
        log(`Poussée sans force refusée (${target} a bougé ?) : ${pushed.stderr.trim().split('\n').pop()?.slice(0, 200) ?? ''} ; nouvelle vérification.`);
        if (retries > MAX_PUSH_RETRIES) throw new Refusal('main_moved', `${target} a bougé à chaque poussée (${retries} fois) : rien n'est fusionné de plus`);
        base = await fetchInto(target, 'cible');
        // The target moved: its declaration must still be the one of the trusted base (keys, setup, variables).
        if (fingerprint(configAt(base)) !== trustedPrint) throw new Refusal('config', `${target} a bougé et sa configuration (rules.operatorOrders, batch.setup ou variables) diffère de la base de confiance ${short(trusted)} : relancer`);
        continue;
      }
      report.merged.push({ step, pr, head, base, mergeCommit: commit });
      log(`Étape ${step} fusionnée : ${short(commit)} (parents ${short(base)}, ${short(head)}), poussée sans force sur ${target}.`);
      const traced = options.onMerged?.({ pr, head, target, method: 'merge', mergeCommit: commit });
      if (traced) report.traceErrors.push(`trace de fusion de la PR #${pr} non écrite : ${traced}`);
      if (step === 'article') { report.status = 'merged'; return report; }
      retries = 0;
      base = await fetchInto(target, 'cible');
    }
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    Object.assign(report, { status: 'refused', code: error.code, reason: error.reason, projectCode: error.projectCode });
    return report;
  } finally {
    {
      const refs = await run(['for-each-ref', '--format=%(refname)', runRefs]);
      for (const ref of refs.ok ? refs.stdout.split('\n').filter(Boolean) : []) await run(['update-ref', '-d', ref]);
    }
  }

  /**
   * The tree pushed is the tree verified. Publication: the tree of `H` itself (`H` descends from the target). Article:
   * every path the merge changes on the target is a path the article pull request changes since its fork, with the
   * content it has at the signed commit.
   */
  async function checkTree(step: OrderStep, tree: string, base: string, head: string): Promise<void> {
    if (step === 'publication') {
      if (tree !== await mustGit(['rev-parse', '--verify', '--end-of-options', `${head}^{tree}`], 'arbre de la tête')) {
        throw new Refusal('merge_conflict', `l'arbre de la fusion n'est pas celui de la tête vérifiée ${short(head)}`);
      }
      return;
    }
    const fork = await mustGit(['merge-base', base, head], 'base commune de la PR d\'article');
    const names = async (from: string, to: string): Promise<string[]> => (await mustGit(['diff', '--name-only', '--no-renames', '-z', from, to], 'fichiers changés')).split('\0').filter(Boolean);
    const allowed = new Set(await names(fork, head));
    const blob = async (rev: string, path: string): Promise<string | null> => { const r = await run(['rev-parse', '--verify', '--quiet', `${rev}:${path}`]); return r.ok ? r.stdout.trim() : null; };
    for (const path of await names(base, tree)) {
      if (!allowed.has(path) || (await blob(tree, path)) !== (await blob(head, path))) {
        throw new Refusal('merge_conflict', `la fusion de l'étape article change ${path.slice(0, 200)} autrement que le commit signé ${short(head)}`);
      }
    }
  }
}

/**` (configuration, decisions, specs, brief) and the V2 configuration file.
 */
export function isApvConfigPath(path: string): boolean {
  return path === '.apv' || path.startsWith('.apv/') || path === 'pipeline.v2.json';
}

/**
 * The steps of the order already consumed on the target: only the merges APV made count. Each well-formed merge of this
 * nonce must be exactly one APV writes (message of `mergeMessage`, digest of this order, second parent the head of the
 * pull request given for its step, publication from the trusted base or made by this run); a well-formed one that is not
 * refuses the order.
 */
interface ConsumedContext { trusted: string; publicationPr: number; articlePr: number; publicationHead: string; mergedHere: ReadonlySet<string> }
function consumedSteps(merges: readonly OrderMergeCommit[], verdict: VerifiedOrder, ctx: ConsumedContext): Set<OrderStep> {
  const done = new Set<OrderStep>();
  for (const step of ['publication', 'article'] as const) {
    const all = merges.filter(c => c.step === step);
    if (!all.length) continue;
    const pr = step === 'publication' ? ctx.publicationPr : ctx.articlePr;
    const head = step === 'publication' ? ctx.publicationHead : verdict.order.articleSha;
    const genuine = all.filter(c => c.digest === verdict.digest && c.head === head && (step === 'article' || c.firstParent === ctx.trusted || ctx.mergedHere.has(c.sha))
      && c.message === mergeMessage({ pr, step, nonce: verdict.order.nonce, digest: verdict.digest, head }).trim());
    if (genuine.length !== 1 || all.length !== 1) {
      throw new Refusal('nonce_used', `fusion d'étape ${step} de cet ordre non reconnue sur la cible (${all.map(c => short(c.sha)).join(', ')}) : pied forgé, autre tête ou fusion en double ; à examiner avec l'opérateur. ${NONCE_USED_EXIT}`);
    }
    done.add(step);
  }
  return done;
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
  key: 'ordre signé par une clé que la base de confiance ne déclare pas (rules.operatorOrders.publicKeys)',
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
