import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { errorMessage } from '../domain/errors.js';

/**
 * Message of a merge refused for lack of authorisation. Same text as `REASONS.merge` of the Bash hook
 * (hooks/scripts/bash-guard.mjs); a test keeps both equal.
 */
export const MERGE_REFUSED = "APV : fusion de PR bloquée hors de la commande dédiée. Une fusion se fait seulement sur ordre explicite " +
  "de l'opérateur, par /apv:stack (outil : APV_ALLOW_MERGE=1 apv stack merge <pr...>), qui re-cible, vérifie la base de chaque PR " +
  "juste avant de fusionner et s'arrête à la première anomalie. APV_ALLOW_MERGE=1 se pose devant cette seule commande.";

/** One `gh` call, kept whole: the command never hides the output of a call (incident 30). */
export interface GhCall { args: string[]; status: number | null; stdout: string; stderr: string; error: string | null }
export type GhRunner = (args: string[]) => Promise<GhCall>;

const GH_TIMEOUT_MS = 120_000;

/** Runs `gh` (or `APV_GH`) without a shell, with the caller's environment; stopped after `timeoutMs`. */
export function processGh(bin: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs = GH_TIMEOUT_MS): GhRunner {
  return args => new Promise(done => {
    const out: Buffer[] = []; const err: Buffer[] = [];
    let child: ReturnType<typeof spawn>;
    try { child = spawn(bin, args, { cwd, env: { ...env, GH_PROMPT_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { done({ args, status: null, stdout: '', stderr: '', error: errorMessage(error) }); return; }
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.once('error', error => { clearTimeout(timer); done({ args, status: null, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), error: error.message }); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      done({ args, status: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), error: signal ? `arrêté par ${signal}` : null });
    });
  });
}

export const VIEW_FIELDS = 'number,state,isDraft,baseRefName,headRefName,headRefOid,isCrossRepository,mergeable,mergeStateStatus,statusCheckRollup,url';

export interface CheckItem { name: string; state: 'success' | 'pending' | 'failure' }
export interface PullRequest {
  number: number; state: string; isDraft: boolean; baseRefName: string; headRefName: string; headRefOid: string;
  mergeable: string; mergeStateStatus: string; checks: CheckItem[];
  /** Whether the head branch lives in another repository (a fork); null when GitHub did not say. */
  crossRepository: boolean | null;
  /** Web address of the pull request: its host, owner and repository name the REST calls. */
  url: string;
}

const str = (v: unknown): string => typeof v === 'string' ? v : '';

/** Check runs and commit statuses of `statusCheckRollup`, reduced to success, pending or failure. */
export function readChecks(rollup: unknown): CheckItem[] {
  if (!Array.isArray(rollup)) return [];
  return rollup.map((raw): CheckItem => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const name = str(item['name']) || str(item['context']) || str(item['workflowName']) || 'contrôle sans nom';
    if (item['__typename'] === 'StatusContext' || (item['state'] !== undefined && item['conclusion'] === undefined)) {
      const state = str(item['state']).toUpperCase();
      return { name, state: state === 'SUCCESS' ? 'success' : state === 'PENDING' || state === 'EXPECTED' ? 'pending' : 'failure' };
    }
    const status = str(item['status']).toUpperCase();
    if (status && status !== 'COMPLETED') return { name, state: 'pending' };
    const conclusion = str(item['conclusion']).toUpperCase();
    return { name, state: ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion) ? 'success' : 'failure' };
  });
}

export function parsePullRequest(text: string): PullRequest {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || typeof raw['number'] !== 'number') throw new Error('réponse sans numéro de PR');
  return {
    number: raw['number'], state: str(raw['state']), isDraft: raw['isDraft'] === true, baseRefName: str(raw['baseRefName']),
    headRefName: str(raw['headRefName']), headRefOid: str(raw['headRefOid']), mergeable: str(raw['mergeable']),
    mergeStateStatus: str(raw['mergeStateStatus']), checks: readChecks(raw['statusCheckRollup']), url: str(raw['url']),
    crossRepository: typeof raw['isCrossRepository'] === 'boolean' ? raw['isCrossRepository'] : null,
  };
}

/** Where the REST API reaches a pull request: `repos/<owner>/<repo>/pulls/<n>` on its host, and its repository `repos/<owner>/<repo>`. */
export interface PullRequestPath { host: string; path: string; repo: string }

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The REST path of a pull request, read from the web address `gh pr view` gives for it: the same repository
 * that answered the read, host included (GitHub Enterprise). Null when the address is not the one of pull
 * request `n` (another number, unexpected form, owner or name with other characters than GitHub allows).
 */
export function pullRequestPath(pr: Pick<PullRequest, 'number' | 'url'>): PullRequestPath | null {
  const m = /^https:\/\/([A-Za-z0-9.-]{1,253}(?::\d{1,5})?)\/([^/]+)\/([^/]+)\/pull\/(\d{1,9})$/.exec(pr.url);
  if (!m || Number(m[4]) !== pr.number || [m[2]!, m[3]!].some(name => !NAME.test(name) || name === '.' || name === '..')) return null;
  const repo = `repos/${m[2]}/${m[3]}`;
  return { host: m[1]!.toLowerCase(), path: `${repo}/pulls/${pr.number}`, repo };
}

/** `--hostname <host>` for a repository outside github.com. */
export const hostname = (where: Pick<PullRequestPath, 'host'>): string[] => where.host === 'github.com' ? [] : ['--hostname', where.host];

/**
 * Arguments of the retarget: `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -f base=<target>`. The REST API
 * and not `gh pr edit --base`, whose GraphQL query also reads the classic projects of the pull request and
 * fails since their deprecation (seen on the real merge of PR #70 and #71).
 */
export function retargetArgs(where: PullRequestPath, target: string): string[] {
  return ['api', ...hostname(where), '-X', 'PATCH', where.path, '-f', `base=${target}`];
}

/**
 * What the compare call keeps of the answer: the number of commits of the base the head lacks, how many of them
 * GitHub listed and how many are merge commits, the files they change since the merge base (null when GitHub did
 * not list them) and the merge base itself.
 */
export const FRESHNESS_JQ = '{ahead_by, merge_base: .merge_base_commit.sha, listed: ((.commits // []) | length), ' +
  'merges: ([(.commits // [])[] | select((.parents // []) | length > 1)] | length), files: (if .files == null then null else [.files[].filename] end)}';

/** A ref in a REST path: every character escaped but the slashes of a branch name. */
export const refSegment = (ref: string): string => encodeURIComponent(ref).replaceAll('%2F', '/');

/**
 * Arguments of the freshness read: `gh api repos/<owner>/<repo>/compare/<head sha>...<base>`. In this order,
 * GitHub's `ahead_by` counts the commits of the base the head of the pull request does not contain, and `files`
 * lists what these commits change since the merge base: exactly what merging the base into the head would bring.
 */
export function compareArgs(where: PullRequestPath, head: string, base: string): string[] {
  return ['api', ...hostname(where), `${where.repo}/compare/${refSegment(head)}...${refSegment(base)}`, '--jq', FRESHNESS_JQ];
}

/**
 * Whether the head of a pull request contains the current head of its base, read from GitHub:
 * - `up_to_date`: every commit of the base is in the head (`ahead_by` 0);
 * - `same_content`: the base has commits the head lacks, but they are all merge commits, all listed, and change no
 *   file since the merge base (the merge commit of the previous pull request of the stack, merged with
 *   `--merge`): merging the base into the head changes nothing, so the checks of the head bear on the result;
 * - `behind`: the base brings changes the head never saw (or GitHub did not list them): refused;
 * - `unknown`: the compare call failed or its answer is unreadable: refused, never taken as up to date.
 */
export type FreshnessState = 'up_to_date' | 'same_content' | 'behind' | 'unknown';
export interface Freshness {
  base: string; head: string; state: FreshnessState;
  /** Commits of the base the head does not contain; null when unknown. */
  missing: number | null;
  /** Files these commits change since the merge base (at most the first page GitHub lists); null when unknown. */
  files: string[] | null;
  mergeBase: string | null;
  error: string | null;
}

/** Reads the answer of the compare call (the object `FRESHNESS_JQ` builds). */
export function parseFreshness(text: string, base: string, head: string): Freshness {
  const unknown = (error: string): Freshness => ({ base, head, state: 'unknown', missing: null, files: null, mergeBase: null, error });
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text) as Record<string, unknown>; }
  catch (error) { return unknown(`réponse illisible : ${errorMessage(error)}`); }
  if (!raw || typeof raw !== 'object') return unknown('réponse illisible');
  const missing = raw['ahead_by'];
  if (typeof missing !== 'number' || !Number.isInteger(missing) || missing < 0) return unknown('réponse sans ahead_by');
  const list = raw['files'];
  const files = Array.isArray(list) && list.every(f => typeof f === 'string') ? list as string[] : null;
  const mergeBase = typeof raw['merge_base'] === 'string' ? raw['merge_base'] : null;
  // Same content only on the full evidence: every missing commit listed, each one a merge, and no file changed.
  const onlyMerges = raw['listed'] === missing && raw['merges'] === missing;
  const state: FreshnessState = missing === 0 ? 'up_to_date' : files && files.length === 0 && onlyMerges ? 'same_content' : 'behind';
  return { base, head, state, missing, files, mergeBase, error: null };
}

const short = (sha: string): string => sha.slice(0, 12);

/** Refusal of a pull request whose head lacks changes of its base, with the way to update it. */
export function behindReason(n: number, pr: PullRequest, f: Freshness): string {
  const files = f.files === null ? 'fichiers non listés par GitHub'
    : `${f.files.length} fichier(s) changé(s) : ${f.files.slice(0, 5).join(', ')}${f.files.length > 5 ? `, et ${f.files.length - 5} autre(s)` : ''}`;
  return `PR #${n} n'est pas à jour de sa base ${f.base} : ${f.missing} commit(s) de ${f.base} absent(s) de la tête ${short(f.head)} (${files}) ; ` +
    'ses contrôles n\'ont donc pas porté sur le résultat de la fusion. Marche à suivre : dans la branche ' +
    `${pr.headRefName || '?'}, git fetch origin puis git merge origin/${f.base} (une fusion, jamais de rebase ni de force-push) ; ` +
    `repasser au moins les contrôles de tâche sur la nouvelle tête (apv gates run --stage task --base origin/${f.base}, puis ` +
    `apv gates verify --commit <nouvelle tête> --stage task --base origin/${f.base} à 0) ; git push (sans force) ; attendre les ` +
    'contrôles GitHub au vert ; relancer apv stack plan puis apv stack merge. Dérogation exceptionnelle et journalisée : ' +
    '--allow-behind --reason "<raison>".';
}

/** Refusal of a pull request whose base could not be compared with its head. */
export function unknownReason(n: number, f: Freshness): string {
  return `PR #${n} : impossible de vérifier que la tête ${short(f.head)} contient sa base ${f.base} (${f.error ?? 'raison inconnue'}) ; ` +
    'la fusion attend cette preuve (compare de l\'API GitHub).';
}

/** A pull request merged although its head lacks changes of its base (`--allow-behind`), journaled. */
export interface Derogation {
  pr: number; head: string; base: string; missing: number | null; files: string[] | null; reason: string;
}

/** Merge states that allow a merge now; `DRAFT` is handled apart (`--ready`). */
const MERGE_READY = new Set(['CLEAN', 'HAS_HOOKS']);

/**
 * Every reason not to merge this pull request onto `expectedBase` now. Waiting states (`UNKNOWN`) count as
 * anomalies here: the caller polls them first.
 */
export function anomalies(pr: PullRequest, expectedBase: string, allowDraft: boolean): string[] {
  const out: string[] = [];
  if (pr.state !== 'OPEN') out.push(`PR #${pr.number} n'est pas ouverte (état ${pr.state || 'inconnu'})`);
  if (pr.baseRefName !== expectedBase) out.push(`PR #${pr.number} vise ${pr.baseRefName || '?'} au lieu de ${expectedBase}`);
  if (pr.isDraft && !allowDraft) out.push(`PR #${pr.number} est un brouillon (--ready retire ce statut avant la fusion, sur ordre de l'opérateur)`);
  if (pr.mergeable !== 'MERGEABLE') out.push(`PR #${pr.number} n'est pas fusionnable (mergeable ${pr.mergeable || 'inconnu'})`);
  const draftState = pr.isDraft && pr.mergeStateStatus === 'DRAFT';
  if (!draftState && !MERGE_READY.has(pr.mergeStateStatus)) out.push(`PR #${pr.number} : état de fusion ${pr.mergeStateStatus || 'inconnu'} (attendu CLEAN)`);
  const failing = pr.checks.filter(c => c.state === 'failure').map(c => c.name);
  const pending = pr.checks.filter(c => c.state === 'pending').map(c => c.name);
  if (failing.length) out.push(`PR #${pr.number} : contrôle(s) en échec : ${failing.join(', ')}`);
  if (pending.length) out.push(`PR #${pr.number} : contrôle(s) en cours : ${pending.join(', ')}`);
  return out;
}

export interface StackOptions {
  gh: GhRunner;
  /** Called after each `gh` call with the whole call. */
  onCall: (call: GhCall) => void;
  /** Branch the whole stack lands on; the base of the first pull request when absent. */
  target?: string;
  /** Removes the draft status (`gh pr ready`) before merging. */
  ready: boolean;
  pollMs: number;
  pollAttempts: number;
  /**
   * `--allow-behind --reason`: exceptional waiver of the freshness rule. A pull request whose head lacks changes of
   * its base is then merged, never silently: `onDerogation` journals it first, and a failure to journal stops the stack.
   */
  allowBehind?: { reason: string };
  /** Journals a waiver before the merge it allows; returns an error message when it could not. */
  onDerogation?: (derogation: Derogation) => string | null;
  /** `--wait-ci <minutes>`: how long a read waits for the pending checks of a pull request to end (0 or absent: no wait). */
  ciWaitMs?: number;
  /** Interval between two reads while waiting for the checks (default 30 s). */
  ciPollMs?: number;
  /** Progress lines (the wait for the checks). */
  log?: (line: string) => void;
  /**
   * The rules checked before any merge (`apv rules check`, docs/REGLES.md) for the head of a pull request going to
   * `target`: what refuses it (empty when nothing does) and what to note (waivers of the operator). `apv stack plan`
   * lists them, `apv stack merge` stops on them right before each merge. The command always passes them.
   */
  rules?: (pr: PullRequest, target: string) => Promise<RulesVerdict>;
  /** After each merge seen by a read: writes its signed trace (`apv audit merges`); returns an error message when it could not. */
  onMerged?: (merge: { pr: number; head: string; target: string; method: string; mergeCommit: string | null; commits?: number }) => string | null;
}

/** The interval between two reads of the checks while `--wait-ci` waits: 30 seconds. */
export const CI_POLL_MS = 30_000;

/** What `--wait-ci` needs: the budget, the interval and where to say it waits. */
export interface CiWait { ciWaitMs?: number | undefined; ciPollMs?: number | undefined; log?: ((line: string) => void) | undefined }

const pendingNames = (pr: PullRequest): string[] => pr.checks.filter(c => c.state === 'pending').map(c => c.name);

/**
 * `--wait-ci`: reads the pull request again while some of its checks are pending, at most `ciWaitMs` from now; returns
 * the last read (its checks finished, failed, or still pending when the time is up: the caller judges, never this wait).
 */
export async function waitForChecks(n: number, first: { pr: PullRequest | null; error: string | null }, read: () => Promise<{ pr: PullRequest | null; error: string | null }>,
  wait: CiWait): Promise<{ pr: PullRequest | null; error: string | null }> {
  let result = first;
  const budget = wait.ciWaitMs ?? 0;
  if (budget <= 0 || !result.pr || !pendingNames(result.pr).length) return result;
  const deadline = Date.now() + budget;
  const every = Math.max(1, wait.ciPollMs ?? CI_POLL_MS);
  wait.log?.(`PR #${n} : contrôle(s) en cours (${pendingNames(result.pr).join(', ')}), attente de la CI (--wait-ci, au plus ${Math.ceil(budget / 60_000)} min).`);
  while (result.pr && pendingNames(result.pr).length && Date.now() < deadline) {
    await sleep(Math.min(every, Math.max(1, deadline - Date.now())));
    result = await read();
  }
  if (result.pr) {
    const left = pendingNames(result.pr);
    wait.log?.(left.length ? `PR #${n} : délai de --wait-ci écoulé, contrôle(s) encore en cours : ${left.join(', ')}.`
      : `PR #${n} : CI terminée (${result.pr.checks.filter(c => c.state === 'success').length}/${result.pr.checks.length} au vert).`);
  }
  return result;
}

/**
 * Refusal of a pull request that has no check once retargeted onto the target, while the first pull request of the
 * stack, which aimed at the target, had some: the CI of the target runs only for pull requests opened towards it
 * (event `pull_request` with `branches`), and a retarget does not start it. Absent checks are not green.
 */
export function noChecksAfterRetargetReason(n: number, pr: PullRequest, target: string, firstPr: number, firstChecks: number): string {
  return `PR #${n} : aucun contrôle après son re-ciblage sur ${target}, alors que la PR #${firstPr}, qui visait ${target}, en avait ${firstChecks} : ` +
    `la CI de ${target} ne se déclenche que sur les PR ouvertes vers elle et un re-ciblage ne la relance pas ; des contrôles absents ne valent pas le vert. ` +
    `Marche à suivre : dans la branche ${pr.headRefName || '?'}, git fetch origin puis git merge origin/${target} (fusion de la base, aucun fichier changé ` +
    `attendu ; jamais de rebase ni de force-push ; si Git répond « Already up to date », git commit --allow-empty -m "ci : relance sur ${target}") ; ` +
    `git push (sans force) ; puis relancer APV_ALLOW_MERGE=1 apv stack merge sur les PR restantes avec --wait-ci <minutes>, qui attend la fin de la CI.`;
}

/** What the rules say about the head of one pull request. */
export interface RulesVerdict { problems: string[]; notes: string[] }

export interface PlannedPr {
  number: number; pr: PullRequest | null; expectedBase: string | null; anomalies: string[];
  /** What does not stop the stack but will matter at the merge (a pull request without checks above the first one). */
  notes: string[];
  /** The rules before a merge at its head, against the target (null when not checked: PR unread, no target). */
  rules: RulesVerdict | null;
  /** Whether the head contains its expected base (null when not compared: PR unread, base unknown, address unreadable). */
  freshness: Freshness | null;
}
export interface StackPlan { target: string | null; prs: PlannedPr[]; ok: boolean }

async function call(options: StackOptions, args: string[]): Promise<GhCall> {
  const result = await options.gh(args);
  options.onCall(result);
  return result;
}

async function view(options: StackOptions, n: number): Promise<{ pr: PullRequest | null; error: string | null }> {
  const result = await call(options, ['pr', 'view', String(n), '--json', VIEW_FIELDS]);
  if (result.status !== 0 || result.error) return { pr: null, error: `gh pr view ${n} a échoué (${result.error ?? `code ${result.status}`})` };
  try { return { pr: parsePullRequest(result.stdout), error: null }; }
  catch (error) { return { pr: null, error: `réponse illisible de gh pr view ${n} : ${errorMessage(error)}` }; }
}

/** Compares the head of a pull request with the current head of `base` (`compareArgs`). */
async function freshness(options: StackOptions, pr: PullRequest, base: string, where: PullRequestPath): Promise<Freshness> {
  const result = await call(options, compareArgs(where, pr.headRefOid, base));
  if (result.status !== 0 || result.error) {
    return { base, head: pr.headRefOid, state: 'unknown', missing: null, files: null, mergeBase: null, error: `gh api compare a échoué (${result.error ?? `code ${result.status}`})` };
  }
  return parseFreshness(result.stdout, base, pr.headRefOid);
}

/** Re-reads a pull request while GitHub still computes its mergeability. */
async function settled(options: StackOptions, n: number): Promise<{ pr: PullRequest | null; error: string | null }> {
  const mergeability = async (): Promise<{ pr: PullRequest | null; error: string | null }> => {
    let result = await view(options, n);
    for (let i = 0; i < options.pollAttempts && result.pr && (result.pr.mergeable === 'UNKNOWN' || result.pr.mergeStateStatus === 'UNKNOWN'); i += 1) {
      await sleep(options.pollMs);
      result = await view(options, n);
    }
    return result;
  };
  // --wait-ci: the pending checks may end; their end changes the merge state, read again with its own wait.
  return waitForChecks(n, await mergeability(), mergeability, options);
}

/**
 * Whether a pull request may be merged onto `base` as far as freshness goes: null when its head contains the base
 * (or the base brings no change), the reason to stop otherwise. A behind head passes only with `allowBehind`.
 */
function freshnessProblem(n: number, pr: PullRequest, f: Freshness, options: StackOptions): string | null {
  if (f.state === 'unknown') return unknownReason(n, f);
  if (f.state === 'behind' && !options.allowBehind) return behindReason(n, pr, f);
  return null;
}

/**
 * `apv stack plan`: reads every pull request and checks the stack. Each one open, the base of PR n+1 is the
 * head of PR n (the target for the first), mergeable, checks green or absent, and its head contains the current
 * head of that base (compare of the REST API; see `Freshness`). All anomalies are listed.
 */
export async function planStack(numbers: number[], options: StackOptions): Promise<StackPlan> {
  const prs: PlannedPr[] = [];
  for (const n of numbers) {
    const { pr, error } = await settled(options, n);
    prs.push({ number: n, pr, expectedBase: null, anomalies: error ? [error] : [], notes: [], freshness: null, rules: null });
  }
  const first = prs[0]?.pr;
  const target = options.target ?? first?.baseRefName ?? null;
  for (const [i, item] of prs.entries()) {
    if (!item.pr) continue;
    const previous = i === 0 ? null : prs[i - 1]!;
    item.expectedBase = i === 0 ? target : previous?.pr?.headRefName ?? null;
    if (item.expectedBase === null) item.anomalies.push(`PR #${item.number} : base attendue inconnue (la PR précédente n'a pas été lue)`);
    else item.anomalies.push(...anomalies(item.pr, item.expectedBase, options.ready));
    if (target && item.pr.headRefName === target) item.anomalies.push(`PR #${item.number} part de la branche cible ${target}`);
    // Above the first pull request: no check while the first one, aimed at the target, has some. The CI of the target may
    // run only for pull requests towards it: the merge will stop after the retarget and give the way (a merge of the base).
    const firstChecks = first?.checks.length ?? 0;
    if (i > 0 && target && item.pr.baseRefName !== target && item.pr.checks.length === 0 && firstChecks > 0) {
      item.notes.push(`PR #${item.number} : aucun contrôle (sa base ${item.pr.baseRefName || '?'} n'est pas ${target}) ; si la CI de ${target} ne tourne que sur les PR vers elle, ` +
        'elle ne tournera pas au re-ciblage : apv stack merge s\'arrêtera alors avant de la fusionner, avec la marche (une fusion de la base poussée, puis --wait-ci)');
    }
    // The address gives the path of the compare call, and of the retarget for every PR after the first: an address
    // the tool cannot use stops the stack before any merge.
    const where = pullRequestPath(item.pr);
    if (!where) {
      item.anomalies.push(`PR #${item.number} : adresse illisible (${item.pr.url || 'absente'}), base non vérifiable${i > 0 ? ', re-ciblage impossible' : ''}`);
      continue;
    }
    // Each PR against its own base: the previous PR of the stack, or the target for the first one.
    if (item.expectedBase === null || item.pr.state !== 'OPEN' || !item.pr.headRefOid) continue;
    item.freshness = await freshness(options, item.pr, item.expectedBase, where);
    const problem = freshnessProblem(item.number, item.pr, item.freshness, options);
    if (problem) item.anomalies.push(problem);
    // Each pull request is judged on its own change: the first against the target, the next ones against the head of the
    // previous one, their base now (against the target, the diff would hold the changes of the PR below, and ask this one
    // for their reviews and captures). Right before its merge, `mergeStack` reads them again against the target, which then
    // holds the PR below: the same own change. A pull request already refused for another anomaly is not checked further.
    if (options.rules && target && !item.anomalies.length) {
      item.rules = await options.rules(item.pr, i === 0 ? target : item.expectedBase);
      item.anomalies.push(...item.rules.problems);
    }
  }
  return { target, prs, ok: prs.every(p => p.anomalies.length === 0) };
}

export interface MergeReport {
  target: string | null; method: string; merged: number[];
  stopped: { pr: number; reasons: string[] } | null;
  plan: StackPlan;
  /** Freshness of each pull request against the target, read just before its merge. */
  freshness: Array<{ pr: number } & Freshness>;
  /** Pull requests merged behind their base by waiver (`--allow-behind`), each journaled before its merge. */
  derogations: Derogation[];
  /** The rules read right before each merge. */
  rules: Array<{ pr: number } & RulesVerdict>;
  /** Merges whose signed trace could not be written. */
  traceErrors: string[];
  /** Each pull request whose merge was seen, with the head it was merged at: what the branch cleanup works from. */
  mergedHeads: MergedHead[];
}

/**
 * A pull request whose merge was seen (state `MERGED` read again), with its head branch and the head the merge carried
 * (`--match-head-commit`): its branch is deleted only while it still points there.
 */
export interface MergedHead {
  pr: number; branch: string; head: string;
  /** From a fork (`isCrossRepository`); null when GitHub did not say. */
  crossRepository: boolean | null;
  /** Web address of the pull request: host, owner and repository of the branch. */
  url: string;
}

/**
 * `apv stack merge`: merges the stack in order and stops at the first anomaly. Before each merge the pull
 * request is read again and checked; once the previous one is merged, the next one is retargeted onto the
 * target by the REST API and the new base is verified by a new read, never trusted from an exit code (incident 30). The
 * merge passes `--match-head-commit`, so a head that moved since the check is refused by GitHub itself.
 */
export async function mergeStack(numbers: number[], method: 'merge' | 'squash' | 'rebase', options: StackOptions): Promise<MergeReport> {
  const plan = await planStack(numbers, options);
  const report: MergeReport = { target: plan.target, method, merged: [], stopped: null, plan, freshness: [], derogations: [], rules: [], traceErrors: [], mergedHeads: [] };
  const stop = (pr: number, reasons: string[]): MergeReport => { report.stopped = { pr, reasons }; return report; };
  if (!plan.ok) {
    const bad = plan.prs.find(p => p.anomalies.length)!;
    return stop(bad.number, ['pile incohérente avant toute fusion (apv stack plan)', ...plan.prs.flatMap(p => p.anomalies)]);
  }
  const target = plan.target!;
  const firstPr = plan.prs[0]!;
  const firstChecks = firstPr.pr?.checks.length ?? 0;
  for (const [i, n] of numbers.entries()) {
    let { pr, error } = await view(options, n);
    if (!pr) return stop(n, [error!]);
    const retargeted = i > 0 && pr.baseRefName !== target;
    if (retargeted) {
      const previousHead = plan.prs[i - 1]!.pr!.headRefName;
      if (pr.baseRefName !== previousHead) return stop(n, [`PR #${n} vise ${pr.baseRefName}, ni la cible ${target} ni la tête de la PR précédente ${previousHead}`]);
      const where = pullRequestPath(pr);
      if (!where) return stop(n, [`PR #${n} : adresse illisible (${pr.url || 'absente'}), re-ciblage impossible`]);
      const retarget = await call(options, retargetArgs(where, target));
      const outcome = retarget.error ?? `code ${retarget.status}`;
      // The result is read again whatever the exit code: the base read is the only proof (incident 30).
      ({ pr, error } = await view(options, n));
      if (!pr) return stop(n, [`re-ciblage de la PR #${n} (gh api : ${outcome}) non vérifié : ${error!}`]);
      if (retarget.status !== 0 || retarget.error) {
        return stop(n, [`re-ciblage de la PR #${n} en échec (gh api : ${outcome}) ; relue, elle vise ${pr.baseRefName || '?'}`]);
      }
      if (pr.baseRefName !== target) {
        return stop(n, [`re-ciblage de la PR #${n} non effectif : elle vise ${pr.baseRefName || '?'} au lieu de ${target} (gh api : ${outcome})`]);
      }
    }
    ({ pr, error } = await settled(options, n));
    if (!pr) return stop(n, [error!]);
    if (retargeted && pr.checks.length === 0 && firstChecks > 0) {
      // A workflow that also listens to the edit of a pull request may start: a few reads (and --wait-ci) let it show.
      for (let k = 0; k < options.pollAttempts && pr && pr.checks.length === 0; k += 1) {
        await sleep(options.pollMs);
        ({ pr, error } = await settled(options, n));
      }
      if (!pr) return stop(n, [error!]);
      if (pr.checks.length === 0) return stop(n, [noChecksAfterRetargetReason(n, pr, target, firstPr.number, firstChecks)]);
    }
    let problems = anomalies(pr, target, options.ready);
    if (problems.length) return stop(n, problems);
    if (pr.isDraft) {
      const ready = await call(options, ['pr', 'ready', String(n)]);
      ({ pr, error } = await settled(options, n));
      if (!pr) return stop(n, [error!]);
      if (pr.isDraft) return stop(n, [`la PR #${n} est encore un brouillon après gh pr ready (${ready.error ?? `code ${ready.status}`})`]);
      problems = anomalies(pr, target, false);
      if (problems.length) return stop(n, problems);
    }
    // Freshness last, right before the merge: the head must contain the target as it is now, after the merge of the
    // previous PR of the stack (incident of 25 September 2026: two PR green alone, main red once both were merged).
    const where = pullRequestPath(pr);
    if (!where) return stop(n, [`PR #${n} : adresse illisible (${pr.url || 'absente'}), base non vérifiable`]);
    const fresh = await freshness(options, pr, target, where);
    report.freshness.push({ pr: n, ...fresh });
    const problem = freshnessProblem(n, pr, fresh, options);
    if (problem) return stop(n, [problem]);
    if (fresh.state === 'behind' && options.allowBehind) {
      const derogation: Derogation = { pr: n, head: pr.headRefOid, base: target, missing: fresh.missing, files: fresh.files, reason: options.allowBehind.reason };
      const failed = options.onDerogation ? options.onDerogation(derogation) : 'aucun journal';
      if (failed) return stop(n, [`dérogation --allow-behind non journalisée (${failed}) : fusion de la PR #${n} refusée`, behindReason(n, pr, fresh)]);
      report.derogations.push(derogation);
    }
    // The rules last, at the head GitHub will merge (--match-head-commit), against the target as it is now.
    if (options.rules) {
      const verdict = await options.rules(pr, target);
      report.rules.push({ pr: n, ...verdict });
      if (verdict.problems.length) return stop(n, verdict.problems);
    }
    const merge = await call(options, ['pr', 'merge', String(n), `--${method}`, '--match-head-commit', pr.headRefOid]);
    let after = await view(options, n);
    for (let k = 0; k < options.pollAttempts && after.pr && after.pr.state === 'OPEN' && merge.status === 0; k += 1) {
      await sleep(options.pollMs);
      after = await view(options, n);
    }
    if (!after.pr) return stop(n, [after.error!]);
    if (after.pr.state !== 'MERGED' || after.pr.baseRefName !== target) {
      return stop(n, [`fusion de la PR #${n} non constatée : état ${after.pr.state || 'inconnu'}, base ${after.pr.baseRefName || '?'} (gh pr merge : ${merge.error ?? `code ${merge.status}`})`]);
    }
    report.merged.push(n);
    report.mergedHeads.push({ pr: n, branch: pr.headRefName, head: pr.headRefOid, crossRepository: pr.crossRepository, url: pr.url });
    if (options.onMerged) {
      // A rebase lands one new commit per commit of the pull request, the last one being `mergeCommit`: their number is
      // kept in the trace, so that the audit accounts for all of them, not only the last one.
      const read = await call(options, ['pr', 'view', String(n), '--json', method === 'rebase' ? 'mergeCommit,commits' : 'mergeCommit']);
      let mergeCommit: string | null = null;
      let commits: number | undefined;
      try {
        const answer = JSON.parse(read.stdout) as { mergeCommit?: { oid?: unknown }; commits?: unknown };
        const oid = answer.mergeCommit?.oid;
        mergeCommit = typeof oid === 'string' && /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
        if (method === 'rebase' && Array.isArray(answer.commits) && answer.commits.length > 0) commits = answer.commits.length;
      } catch { mergeCommit = null; }
      const failed = options.onMerged({ pr: n, head: pr.headRefOid, target, method, mergeCommit, ...(commits ? { commits } : {}) });
      if (failed) report.traceErrors.push(`PR #${n} : trace de fusion non écrite (${failed}) : apv audit merges la signalera`);
    }
  }
  return report;
}
