import type { ApvConfig } from '../config/load.js';
import { globToRegExp } from '../db/glob.js';
import { errorMessage } from '../domain/errors.js';
import { Git } from '../execution/git.js';
import { planRepeat } from '../gates/repeat.js';
import { gitRead } from '../run/git-probe.js';
import type { GhRunner } from '../stack/github.js';
import { readAliases } from './ci-aliases.js';
import { extendedConfigs, importClosure, namedFiles, treeFiles } from './ci-closure.js';
import type { CiProofSettings } from './config.js';

/**
 * The proof by the CI (docs/REGLES.md, « Preuve par la CI », issue #130). The check run of the job the base declares
 * (`rules.ciProof`) stands in for the local receipts of the checks it covers, only when:
 * - the change leaves unchanged, since the merge base, the workflow and every file that produces the proof (paths
 *   compared by Git, the scripts of package.json one by one); otherwise it leaves the CI lane: local proof required;
 * - the check run comes from the GitHub Actions application, at the exact commit, concluded in success, read through the
 *   API of the check runs; its run is one of the declared workflow (its id resolved to the path), at the same commit,
 *   for an event whose tested commit is the one of the run, and the check run is a job of that run.
 * The receipts the job leaves in its artifact are never read here: the measure only. Without the network or the API,
 * nothing is accepted: the rule falls back on the local proof.
 */

/** The only application whose check runs count: GitHub Actions. */
export const GITHUB_ACTIONS_APP = 'github-actions';
/** Its identifier (the slug alone could be taken by another application of that name). */
export const GITHUB_ACTIONS_APP_ID = 15368;
/**
 * Events whose run tests the commit of the run. `workflow_dispatch` only for a workflow without any input: an input
 * (`inputs.pr`) can check out another commit, and the API of the runs does not return the inputs.
 */
const EVENTS = new Set(['push']);
const DISPATCH = 'workflow_dispatch';
/** Conclusions of a check run that say the commit is not proven (a red one is never hidden, docs/PREUVE-REDUITE.md 5.4). */
const RED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
/** Check runs compared at most (the latest first): beyond, the proof is not read. */
const MAX_CHECK_RUNS = 100;

export type CiProofState = 'accepted' | 'refused' | 'out_of_lane' | 'unavailable';
export interface CiCheckRun { id: number; url: string | null; runId: number; runAttempt: number; event: string; workflow: string }
export interface CiProofOutcome {
  /**
   * `accepted`: the check run proves `gates`; `refused`: no check run proves them (reasons); `out_of_lane`: the change
   * modifies what produces the proof, or the declaration does not match the workflow of the base; `unavailable`: the
   * API could not be read (offline, origin outside github.com, error, unexpected answer).
   */
  state: CiProofState;
  /** Checks the CI proves (accepted) or would prove: declared, without a clean local receipt, not excluded. */
  gates: string[];
  /** Checks declared that the CI cannot prove for this change, each with its reason. */
  excluded: { gate: string; reason: string }[];
  /** Why the CI does not prove them (empty when accepted); the check runs ignored come first. */
  reasons: string[];
  /** The check run accepted, or the latest one examined. */
  checkRun: CiCheckRun | null;
  workflow: string;
  name: string;
  artifact: string | null;
  /**
   * The reduced proof only (`exempt` given): the changed files of regenerated content the job executes (named by the
   * output), exempted from the closure (docs/PREUVE-REDUITE.md, 5.6).
   */
  content?: string[];
}

/**
 * How a declaration other than rules.ciProof reads its check run (the reduced proof, docs/PREUVE-REDUITE.md); absent,
 * rules.ciProof as before.
 */
export interface CiProofOptions {
  /** The field the declaration comes from, said in the messages (default rules.ciProof). */
  field?: string;
  /** Events besides workflow_dispatch without input whose run tests the commit of the run (default: push). */
  events?: ReadonlySet<string>;
  /** The check run is read and required even when no pending check is covered (it proves `covers` too). */
  requireRun?: boolean;
  /**
   * Changed files of regenerated content, checked by the tool, that a file of the job may import: exempted from the
   * closure when they exist at the base and are reached; an added one that shadows a resolution never is; their own
   * imports are followed again at the head.
   */
  exempt?: ReadonlySet<string>;
}

export interface CiProofInput {
  repo: string;
  mergeBase: string;
  head: string;
  settings: CiProofSettings;
  /** Checks of the full suite without a clean local receipt at the commit (state missing or dirty). */
  pending: readonly string[];
  /** The configuration of the checks the proof uses (repeatChanged of each). */
  config: ApvConfig;
  /** `gh` (never APV_GH), or null offline. */
  gh: GhRunner | null;
  /** `owner/name` of the repository on github.com, or null. */
  repository: string | null;
  options?: CiProofOptions;
}

const short = (sha: string): string => sha.slice(0, 12);
const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const str = (v: unknown): string | null => typeof v === 'string' ? v : null;
const int = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** The files the change adds, modifies, deletes or renames (both sides) since the merge base, or null when unreadable. */
function touched(repo: string, base: string, head: string): string[] | null {
  const raw = gitRead(repo, ['diff', '--name-only', '--no-renames', '-z', base, head, '--']);
  return raw === null ? null : raw.split('\0').filter(Boolean);
}

/**
 * Whether the workflow text declares, under `jobs:`, the job `job` whose name (`name:`, else its key) is `name`: the check run
 * of the API names a job, and the declared key must be the one that produces it.
 */
export function declaresJob(text: string, job: string, name: string): boolean {
  const lines = text.split('\n');
  const indentOf = (l: string): number => l.length - l.trimStart().length;
  const unquote = (v: string): string => v.trim().replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2');
  const jobsAt = lines.findIndex(l => /^jobs[ \t]*:[ \t]*(?:#.*)?$/.test(l));
  if (jobsAt < 0) return false;
  let keyIndent = -1; let block: string[] | null = null;
  for (const line of lines.slice(jobsAt + 1)) {
    if (!line.trim() || line.trimStart().startsWith('#')) { block?.push(line); continue; }
    const indent = indentOf(line);
    if (indent === 0) break;
    if (keyIndent < 0) keyIndent = indent;
    if (indent === keyIndent) {
      if (block) break;
      const key = /^\s*(?:"([^"]+)"|'([^']+)'|([^\s:#]+))\s*:/.exec(line);
      if ((key?.[1] ?? key?.[2] ?? key?.[3]) === job) block = [];
    } else block?.push(line);
  }
  if (!block) return false;
  const direct = block.filter(l => l.trim() && indentOf(l) === Math.min(...block.filter(x => x.trim()).map(indentOf)));
  const named = direct.map(l => /^\s*name\s*:(.*)$/.exec(l)).find(m => m);
  return (named ? unquote(named[1]!) : job) === name;
}

/**
 * What keeps the change out of the CI lane, from Git alone (no network): the declaration that does not match the workflow
 * of the base, a protected file changed since the base, a file the proof executes changed (named by the workflow or the
 * scripts of the base, or imported by a relative path from those and from the protected files, read at the base).
 */
function laneProblems(repo: string, mergeBase: string, head: string, settings: CiProofSettings, options: CiProofOptions = {}): { problems: string[]; content: string[] } {
  const problems: string[] = [];
  const content: string[] = [];
  const field = options.field ?? 'rules.ciProof';
  const workflow = gitRead(repo, ['show', `${mergeBase}:${settings.workflow}`]);
  if (workflow === null) problems.push(`workflow déclaré absent de la base commune ${short(mergeBase)} : ${settings.workflow} (${field}.workflow)`);
  else if (!declaresJob(workflow, settings.job, settings.name)) problems.push(`job ${settings.job} de nom « ${settings.name} » absent de ${settings.workflow} à la base commune (${field}.job, ${field}.name)`);
  const files = touched(repo, mergeBase, head);
  if (files === null) return { problems: [...problems, `diff illisible entre ${short(mergeBase)} et ${short(head)}`], content };
  const tree = treeFiles(repo, mergeBase);
  if (tree === null) return { problems: [...problems, `arbre illisible à la base commune ${short(mergeBase)}`], content };
  const treeSet = new Set(tree);
  // Compared without case: a file renamed by its case alone stays protected.
  const protectedMatch = settings.protectedPaths.map(g => globToRegExp(g.toLowerCase()));
  const isProtected = (f: string): boolean => protectedMatch.some(re => re.test(f.toLowerCase()));
  const hits = files.filter(isProtected);
  for (const f of hits.slice(0, 10)) problems.push(`fichier protégé modifié depuis la base : ${f}`);
  if (hits.length > 10) problems.push(`et ${hits.length - 10} autre(s) fichier(s) protégé(s)`);
  // What the workflow and the scripts of the base name, and what all of it imports: executed by the proof, so protected.
  const named = namedFiles([workflow ?? '', gitRead(repo, ['show', `${mergeBase}:package.json`]) ?? ''].join('\n'), treeSet);
  const configs = extendedConfigs(repo, mergeBase, tree.filter(f => /(?:^|\/)[tj]sconfig[^/]*\.json$/.test(f)), treeSet);
  const roots = [...new Set([...named, ...tree.filter(isProtected)])];
  const aliases = readAliases(repo, mergeBase, tree);
  const { reached, shadows, unresolved, complete } = importClosure(repo, mergeBase, roots, treeSet, aliases);
  const exempt = options.exempt ?? new Set<string>();
  const shadowing: string[] = [];
  const executed = files.filter(f => (reached.has(f) || shadows.has(f) || configs.includes(f)) && !hits.includes(f)).filter(f => {
    // Regenerated content (reduced proof only): a modified file reached by an import, never a configuration nor a file
    // the workflow, the scripts or the protected paths name (what the job runs itself); an added file that a specifier
    // of the closure may designate shadows a resolution and is never exempted.
    if (!exempt.has(f) || configs.includes(f) || roots.includes(f)) return true;
    if (!treeSet.has(f)) { shadowing.push(f); return false; }
    if (reached.has(f)) { content.push(f); return false; }
    return true;
  });
  for (const f of shadowing.slice(0, 10)) problems.push(`fichier ajouté qui masque une résolution d'un import de la preuve : ${f}`);
  for (const f of executed.slice(0, 10)) problems.push(`fichier exécuté ou pouvant remplacer un fichier exécuté par la preuve, modifié depuis la base (nommé, importé ou hérité par le workflow, les scripts, la configuration ou un fichier protégé) : ${f}`);
  if (executed.length > 10) problems.push(`et ${executed.length - 10} autre(s) fichier(s) exécuté(s) par la preuve`);
  for (const u of unresolved.slice(0, 5)) problems.push(`import non suivi (ni relatif, ni alias connu, ni module Node, ni paquet déclaré par package.json) : ${u}`);
  if (unresolved.length > 5) problems.push(`et ${unresolved.length - 5} autre(s) import(s) non suivi(s)`);
  if (aliases.unreadable.length) problems.push(`configuration d'alias illisible (JSON) : ${aliases.unreadable.slice(0, 5).join(', ')}`);
  if (!complete) problems.push('fichiers importés par la preuve non tous lisibles ou trop nombreux : leur liste n\'est pas fiable');
  if (content.length) problems.push(...headImports(repo, head, content, files, exempt, aliases, content));
  // Same blob at the base and at the commit: the workflow that ran is the one of the base (also covered by the diff).
  if (workflow !== null && gitRead(repo, ['rev-parse', `${mergeBase}:${settings.workflow}`]) !== gitRead(repo, ['rev-parse', `${head}:${settings.workflow}`])
    && !hits.includes(settings.workflow)) problems.push(`workflow ${settings.workflow} différent à ${short(head)} de celui de la base`);
  return { problems, content };
}

/**
 * The imports of the exempted content followed again at the head (docs/PREUVE-REDUITE.md, 5.6, F3): their text of the
 * head, the aliases of the base. A specifier that cannot be followed, a closure not complete, a file reached that the
 * change modifies without being regenerated content: problems. Regenerated content the head adds and reaches is named
 * with the content (`named`).
 */
function headImports(repo: string, head: string, roots: readonly string[], changed: readonly string[], exempt: ReadonlySet<string>, aliases: ReturnType<typeof readAliases>, named: string[]): string[] {
  const problems: string[] = [];
  const tree = treeFiles(repo, head);
  if (tree === null) return [`arbre illisible à la tête ${short(head)}`];
  const { reached, unresolved, complete } = importClosure(repo, head, roots, new Set(tree), aliases);
  for (const f of reached) {
    if (!changed.includes(f)) continue;
    if (!exempt.has(f)) problems.push(`fichier atteint à la tête par le contenu régénéré, changé sans être régénéré : ${f}`);
    else if (!named.includes(f)) named.push(f);
  }
  for (const u of unresolved.slice(0, 5)) problems.push(`import non suivi (ni relatif, ni alias connu, ni module Node, ni paquet déclaré par package.json) à la tête : ${u}`);
  if (unresolved.length > 5) problems.push(`et ${unresolved.length - 5} autre(s) import(s) non suivi(s) à la tête`);
  if (!complete) problems.push('fichiers importés à la tête par le contenu régénéré non tous lisibles ou trop nombreux');
  return problems;
}

/** One call to the API, its JSON object, or the reason it is unusable. */
async function api(gh: GhRunner, path: string): Promise<{ ok: true; value: unknown } | { ok: false; why: string }> {
  let call;
  try { call = await gh(['api', '-H', 'Accept: application/vnd.github+json', path]); }
  catch (error) { return { ok: false, why: errorMessage(error) }; }
  if (call.status !== 0 || call.error) return { ok: false, why: (call.error ?? call.stderr ?? '').trim().split('\n')[0]!.slice(0, 160) || `code ${call.status}` };
  try {
    return { ok: true, value: JSON.parse(call.stdout) };
  } catch { return { ok: false, why: `réponse illisible de ${path.split('?')[0]} (pas du JSON)` }; }
}

class Unavailable extends Error {}

/**
 * Whether the CI proves, at `head`, the checks of `pending` that `rules.ciProof` covers. Never throws: an error of the API
 * is `unavailable`, and nothing is accepted then.
 */
export async function verifyCiProof(input: CiProofInput): Promise<CiProofOutcome> {
  const { settings, head } = input;
  const options = input.options ?? {};
  let content: string[] | undefined;
  const result = (state: CiProofState, reasons: string[], extra: Partial<CiProofOutcome> = {}): CiProofOutcome =>
    ({ state, gates: [], excluded: [], reasons, checkRun: null, workflow: settings.workflow, name: settings.name, artifact: settings.artifact, ...(content ? { content } : {}), ...extra });
  const covered = settings.gates.filter(g => input.pending.includes(g));
  if (!covered.length && !options.requireRun) return result('refused', [`aucun contrôle non prouvé n'est couvert par ${options.field ?? 'rules.ciProof'}.gates (${settings.gates.join(', ')})`]);

  const lane = laneProblems(input.repo, input.mergeBase, head, settings, options);
  if (options.exempt) content = lane.content;
  if (lane.problems.length) return result('out_of_lane', lane.problems);

  // A check that repeats the test files a change adds or modifies (repeatChanged): the CI does not repeat them.
  const excluded: { gate: string; reason: string }[] = [];
  for (const id of covered) {
    const repeat = input.config.gates.find(g => g.id === id)?.repeatChanged;
    if (!repeat) continue;
    try {
      const plan = await planRepeat(new Git(), input.repo, { base: input.mergeBase }, repeat, head);
      if (plan.files.length) excluded.push({ gate: id, reason: `${plan.files.length} fichier(s) de test à répéter (repeatChanged), que la CI ne répète pas : ${plan.files.slice(0, 5).join(', ')}${plan.files.length > 5 ? ', ...' : ''}` });
    } catch (error) { excluded.push({ gate: id, reason: `fichiers de test à répéter non calculés (${errorMessage(error).slice(0, 120)})` }); }
  }
  const gates = covered.filter(g => !excluded.some(e => e.gate === g));
  if (!gates.length && !options.requireRun) return result('out_of_lane', excluded.map(e => `${e.gate} : ${e.reason}`), { excluded });

  if (!input.gh) return result('unavailable', ['hors réseau (--offline) : l\'API GitHub n\'est pas lue'], { gates, excluded });
  if (!input.repository) return result('unavailable', ['dépôt distant origin hors de github.com : l\'API GitHub n\'est pas lue'], { gates, excluded });
  try {
    return await readCheckRuns({ ...input, gh: input.gh, repository: input.repository }, gates, excluded, result);
  } catch (error) {
    if (error instanceof Unavailable) return result('unavailable', [`API GitHub indisponible (${error.message})`], { gates, excluded });
    return result('unavailable', [`API GitHub illisible (${errorMessage(error).slice(0, 160)})`], { gates, excluded });
  }
}

type Result = (state: CiProofState, reasons: string[], extra?: Partial<CiProofOutcome>) => CiProofOutcome;

async function readCheckRuns(input: CiProofInput & { gh: GhRunner; repository: string }, gates: string[], excluded: CiProofOutcome['excluded'], result: Result): Promise<CiProofOutcome> {
  const { settings, head, gh, repository } = input;
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const r = await api(gh, `repos/${repository}/${path}`);
    if (!r.ok) throw new Unavailable(r.why);
    const value = record(r.value);
    if (!value) throw new Unavailable(`réponse inattendue de ${path.split('?')[0]}`);
    return value;
  };
  const list = await get(`commits/${head}/check-runs?check_name=${encodeURIComponent(settings.name)}&filter=all&per_page=${MAX_CHECK_RUNS}`);
  const runs = list['check_runs'];
  const total = int(list['total_count']);
  if (!Array.isArray(runs) || total === null) throw new Unavailable('liste des check runs inattendue');
  if (total > runs.length) throw new Unavailable(`plus de ${MAX_CHECK_RUNS} check runs « ${settings.name} » au commit : non comparés`);
  const ignored: string[] = [];
  // The check runs of this name, the latest first (identifier): the latest of the declared workflow decides, and none may have failed.
  const named = runs.map(record).filter((c): c is Record<string, unknown> => c !== null && str(c['name']) === settings.name)
    .sort((a, b) => (int(b['id']) ?? 0) - (int(a['id']) ?? 0));
  const workflowPaths = new Map<number, string | null>();
  const workflowPath = async (id: number): Promise<string | null> => {
    if (!workflowPaths.has(id)) workflowPaths.set(id, str((await get(`actions/workflows/${id}`))['path']));
    return workflowPaths.get(id)!;
  };
  const eligible: { c: Record<string, unknown>; id: number; run: Record<string, unknown> }[] = [];
  for (const c of named) {
    const id = int(c['id']);
    if (id === null) { ignored.push('check run sans identifiant ignoré'); continue; }
    const app = record(c['app']);
    const slug = str(app?.['slug']);
    if (slug !== GITHUB_ACTIONS_APP || int(app?.['id']) !== GITHUB_ACTIONS_APP_ID) { ignored.push(`check run ${id} ignoré : application ${slug ?? 'inconnue'} (${int(app?.['id']) ?? '?'}), pas ${GITHUB_ACTIONS_APP} (${GITHUB_ACTIONS_APP_ID})`); continue; }
    const sha = str(c['head_sha']);
    if (sha !== head) { ignored.push(`check run ${id} ignoré : commit ${sha ? short(sha) : 'inconnu'}, pas ${short(head)}`); continue; }
    // A job skipped (draft pull request, condition) proves nothing and says nothing against: it never hides a real run.
    const conclusion = str(c['conclusion']);
    if (conclusion === 'skipped' || conclusion === 'neutral') { ignored.push(`check run ${id} ignoré : conclusion ${conclusion}`); continue; }
    const suite = int(record(c['check_suite'])?.['id']);
    if (suite === null) { ignored.push(`check run ${id} ignoré : sans suite de checks`); continue; }
    const found = (await get(`actions/runs?check_suite_id=${suite}`))['workflow_runs'];
    const run = Array.isArray(found) && found.length === 1 ? record(found[0]) : null;
    if (!run) { ignored.push(`check run ${id} ignoré : aucune exécution de workflow unique pour sa suite ${suite}`); continue; }
    const workflowId = int(run['workflow_id']);
    const path = workflowId === null ? null : await workflowPath(workflowId);
    if (path !== settings.workflow) { ignored.push(`check run ${id} ignoré : workflow ${path ?? 'inconnu'}, pas ${settings.workflow}`); continue; }
    eligible.push({ c, id, run });
  }
  // A failure, cancellation (a cancellation by a concurrency group is not told apart by the API) or unfinished run of the declared
  // job at this commit is never hidden by a later green run: the commit is not proven (rule instable).
  const failed = eligible.find(e => RED.has(str(e.c['conclusion']) ?? '') || str(e.c['status']) !== 'completed');
  const decisive = failed ?? eligible[0];
  if (!decisive) return result('refused', [...ignored, `aucun check run « ${settings.name} » de GitHub Actions au commit ${short(head)} du workflow ${settings.workflow}`], { gates, excluded });
  return judge(input, decisive.c, decisive.id, decisive.run, gates, excluded, ignored, result, get);
}

async function judge(input: CiProofInput, c: Record<string, unknown>, id: number, run: Record<string, unknown>, gates: string[], excluded: CiProofOutcome['excluded'],
  ignored: string[], result: Result, get: (path: string) => Promise<Record<string, unknown>>): Promise<CiProofOutcome> {
  const { settings, head } = input;
  const runId = int(run['id']);
  const event = str(run['event']) ?? 'inconnu';
  const checkRun: CiCheckRun = { id, url: str(c['html_url']), runId: runId ?? 0, runAttempt: int(run['run_attempt']) ?? 0, event, workflow: settings.workflow };
  const refuse = (why: string): CiProofOutcome => result('refused', [...ignored, `check run ${id} (exécution ${runId ?? '?'}) : ${why}`], { gates, excluded, checkRun });
  const status = str(c['status']);
  if (status !== 'completed') return refuse(`en cours (${status ?? 'statut inconnu'}) : attendre sa conclusion`);
  const conclusion = str(c['conclusion']);
  if (conclusion !== 'success') return refuse(`conclusion ${conclusion ?? 'inconnue'}, pas success`);
  if (runId === null) return refuse('exécution sans identifiant');
  if (str(run['status']) !== 'completed' || str(run['conclusion']) !== 'success') return refuse(`exécution du workflow ${runId} : statut ${str(run['status']) ?? 'inconnu'}, conclusion ${str(run['conclusion']) ?? 'inconnue'}, pas completed et success`);
  const runSha = str(run['head_sha']);
  if (runSha !== head) return result('refused', [...ignored, `exécution ${runId} d'un autre commit (${runSha ? short(runSha) : 'inconnu'}) que ${short(head)}`], { gates, excluded, checkRun });
  const events = input.options?.events ?? EVENTS;
  if (event === DISPATCH) {
    const text = gitRead(input.repo, ['show', `${input.mergeBase}:${settings.workflow}`]) ?? '';
    if (/^[ \t]*inputs[ \t]*:/m.test(text) || /workflow_dispatch[ \t]*:[ \t]*\{[^}]*\binputs\b/.test(text)) return refuse(`évènement ${DISPATCH} : le workflow déclare des entrées (inputs), qui peuvent tester un autre commit que celui de l'exécution et que l'API ne rend pas`);
  } else if (!events.has(event)) return refuse(`évènement ${event} non admis (admis : ${[...events, `${DISPATCH} sans entrée`].join(', ')}) : l'API ne permet pas d'identifier sûrement la pull request qui a déclenché une exécution, et sa base peut changer après coup ; lancer la preuve par workflow_dispatch (gh workflow run ${settings.workflow.split('/').pop()} --ref <branche>) sur le commit exact`);
  if (checkRun.runAttempt < 1) return refuse('tentative de l\'exécution inconnue');
  // The check run is a job of that run: a check run created through the API with the token of a job is not.
  const jobs = (await get(`actions/runs/${runId}/jobs?filter=all&per_page=100`))['jobs'];
  if (!Array.isArray(jobs)) throw new Unavailable('liste des jobs inattendue');
  const job = jobs.map(record).find(j => j !== null && int(j['id']) === id);
  if (!job) return refuse(`check run ${id} absent des jobs de l'exécution ${runId}`);
  if (str(job['name']) !== settings.name || str(job['head_sha']) !== head || str(job['conclusion']) !== 'success') {
    return refuse(`job ${id} différent du check run (nom, commit ou conclusion)`);
  }
  return result('accepted', [], { gates, excluded, checkRun });
}

/** Lines that say why the CI does not prove the checks, for the refusal of the rule preuve. */
export function ciProofLines(ci: CiProofOutcome): string[] {
  const label: Record<CiProofState, string> = {
    accepted: 'preuve CI acceptée',
    refused: 'preuve CI refusée',
    out_of_lane: 'hors de la voie CI (preuve locale exigée)',
    unavailable: 'preuve CI non vérifiable',
  };
  if (ci.state === 'accepted') return [`prouvé(s) par la CI : ${ci.gates.join(', ')}`, ...ci.excluded.map(e => `${e.gate} : ${e.reason}`)];
  const tail = ci.state === 'unavailable' ? ' ; preuve locale exigée' : '';
  return [...ci.reasons.map(r => `${label[ci.state]} : ${r}${tail}`), ...(ci.state === 'out_of_lane' ? [] : ci.excluded.map(e => `${e.gate} : ${e.reason}`))];
}



/** One check run of a name at a commit, as the API gives it (any application). */
export interface NamedCheckRun { id: number; status: string; conclusion: string | null; app: string | null; url: string | null }

/**
 * The check runs named `name` at `head` (any application, the latest first), or why the API could not be read: what
 * the reduced lane reads to never hide a red full proof (M2), and the audit of a merge without a local trace (F6).
 */
export async function checkRunsNamed(gh: GhRunner, repository: string, head: string, name: string): Promise<{ ok: true; runs: NamedCheckRun[] } | { ok: false; why: string }> {
  const r = await api(gh, `repos/${repository}/commits/${head}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=${MAX_CHECK_RUNS}`);
  if (!r.ok) return { ok: false, why: r.why };
  const list = record(r.value);
  const runs = list?.['check_runs'];
  const total = int(list?.['total_count']);
  if (!Array.isArray(runs) || total === null) return { ok: false, why: 'liste des check runs inattendue' };
  if (total > runs.length) return { ok: false, why: `plus de ${MAX_CHECK_RUNS} check runs « ${name} » au commit` };
  const out: NamedCheckRun[] = [];
  for (const c of runs.map(record)) {
    if (!c || str(c['name']) !== name || int(c['id']) === null) continue;
    out.push({ id: int(c['id'])!, status: str(c['status']) ?? 'inconnu', conclusion: str(c['conclusion']), app: str(record(c['app'])?.['slug']), url: str(c['html_url']) });
  }
  return { ok: true, runs: out.sort((a, b) => b.id - a.id) };
}

/** Whether a check run is red: failed, cancelled, waiting for an action, or not finished. Skipped and neutral are not. */
export function redCheckRun(run: NamedCheckRun): boolean {
  return run.status !== 'completed' || RED.has(run.conclusion ?? '');
}
