import { globToRegExp } from '../db/glob.js';
import { errorMessage } from '../domain/errors.js';
import { Git } from '../execution/git.js';
import { planRepeat } from '../gates/repeat.js';
import { gitRead } from '../run/git-probe.js';
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
/**
 * Events whose run tests the commit of the run. `workflow_dispatch` only for a workflow without any input: an input
 * (`inputs.pr`) can check out another commit, and the API of the runs does not return the inputs.
 */
const EVENTS = new Set(['pull_request', 'push']);
const DISPATCH = 'workflow_dispatch';
/** Check runs compared at most (the latest first): beyond, the proof is not read. */
const MAX_CHECK_RUNS = 100;
const short = (sha) => sha.slice(0, 12);
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
const str = (v) => typeof v === 'string' ? v : null;
const int = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
/** The files the change adds, modifies, deletes or renames (both sides) since the merge base, or null when unreadable. */
function touched(repo, base, head) {
    const raw = gitRead(repo, ['diff', '--name-only', '--no-renames', '-z', base, head, '--']);
    return raw === null ? null : raw.split('\0').filter(Boolean);
}
/** The scripts of a package.json (null when absent; `invalid` when the file is not a JSON object). */
function scriptsAt(repo, sha) {
    const text = gitRead(repo, ['show', `${sha}:package.json`]);
    if (text === null)
        return null;
    try {
        const value = record(JSON.parse(text));
        if (!value)
            return 'invalid';
        const scripts = value['scripts'];
        return scripts === undefined ? {} : record(scripts) ?? 'invalid';
    }
    catch {
        return 'invalid';
    }
}
/** Names of the scripts of the root package.json added, removed or changed between the base and the head. */
function changedScripts(repo, base, head) {
    const before = scriptsAt(repo, base);
    const after = scriptsAt(repo, head);
    if (before === 'invalid' || after === 'invalid')
        return 'invalid';
    const a = before ?? {};
    const b = after ?? {};
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !Object.hasOwn(a, k) || !Object.hasOwn(b, k) || JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
}
/** Whether the workflow text declares the job `job` (a key of its own line, quoted or not). */
function declaresJob(text, job) {
    return new RegExp(`^[ \\t]+(["']?)${job.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\1[ \\t]*:`, 'm').test(text);
}
/**
 * What keeps the change out of the CI lane, from Git alone (no network): the declaration that does not match the workflow
 * of the base, a protected file changed since the base, a script of package.json changed.
 */
function laneProblems(repo, mergeBase, head, settings) {
    const problems = [];
    const workflow = gitRead(repo, ['show', `${mergeBase}:${settings.workflow}`]);
    if (workflow === null)
        problems.push(`workflow déclaré absent de la base commune ${short(mergeBase)} : ${settings.workflow} (rules.ciProof.workflow)`);
    else if (!declaresJob(workflow, settings.job))
        problems.push(`job ${settings.job} absent de ${settings.workflow} à la base commune (rules.ciProof.job)`);
    const files = touched(repo, mergeBase, head);
    if (files === null)
        return [...problems, `diff illisible entre ${short(mergeBase)} et ${short(head)}`];
    // Compared without case: a file renamed by its case alone stays protected.
    const protectedMatch = settings.protectedPaths.map(g => globToRegExp(g.toLowerCase()));
    const hits = files.filter(f => protectedMatch.some(re => re.test(f.toLowerCase())));
    for (const f of hits.slice(0, 10))
        problems.push(`fichier protégé modifié depuis la base : ${f}`);
    if (hits.length > 10)
        problems.push(`et ${hits.length - 10} autre(s) fichier(s) protégé(s)`);
    if (files.includes('package.json')) {
        const scripts = changedScripts(repo, mergeBase, head);
        if (scripts === 'invalid')
            problems.push('package.json illisible (JSON) à la base ou au commit : ses scripts ne se comparent pas');
        else if (scripts.length)
            problems.push(`package.json : script(s) modifié(s) : ${scripts.slice(0, 10).join(', ')}${scripts.length > 10 ? ', ...' : ''}`);
    }
    // Same blob at the base and at the commit: the workflow that ran is the one of the base (also covered by the diff).
    if (workflow !== null && gitRead(repo, ['rev-parse', `${mergeBase}:${settings.workflow}`]) !== gitRead(repo, ['rev-parse', `${head}:${settings.workflow}`])
        && !hits.includes(settings.workflow))
        problems.push(`workflow ${settings.workflow} différent à ${short(head)} de celui de la base`);
    return problems;
}
/** One call to the API, its JSON object, or the reason it is unusable. */
async function api(gh, path) {
    let call;
    try {
        call = await gh(['api', '-H', 'Accept: application/vnd.github+json', path]);
    }
    catch (error) {
        return { ok: false, why: errorMessage(error) };
    }
    if (call.status !== 0 || call.error)
        return { ok: false, why: (call.error ?? call.stderr ?? '').trim().split('\n')[0].slice(0, 160) || `code ${call.status}` };
    try {
        const value = record(JSON.parse(call.stdout));
        return value ? { ok: true, value } : { ok: false, why: `réponse inattendue de ${path.split('?')[0]}` };
    }
    catch {
        return { ok: false, why: `réponse illisible de ${path.split('?')[0]} (pas du JSON)` };
    }
}
class Unavailable extends Error {
}
/**
 * Whether the CI proves, at `head`, the checks of `pending` that `rules.ciProof` covers. Never throws: an error of the API
 * is `unavailable`, and nothing is accepted then.
 */
export async function verifyCiProof(input) {
    const { settings, head } = input;
    const result = (state, reasons, extra = {}) => ({ state, gates: [], excluded: [], reasons, checkRun: null, workflow: settings.workflow, name: settings.name, artifact: settings.artifact, ...extra });
    const covered = settings.gates.filter(g => input.pending.includes(g));
    if (!covered.length)
        return result('refused', [`aucun contrôle non prouvé n'est couvert par rules.ciProof.gates (${settings.gates.join(', ')})`]);
    const lane = laneProblems(input.repo, input.mergeBase, head, settings);
    if (lane.length)
        return result('out_of_lane', lane);
    // A check that repeats the test files a change adds or modifies (repeatChanged): the CI does not repeat them.
    const excluded = [];
    for (const id of covered) {
        const repeat = input.config.gates.find(g => g.id === id)?.repeatChanged;
        if (!repeat)
            continue;
        try {
            const plan = await planRepeat(new Git(), input.repo, { base: input.mergeBase }, repeat, head);
            if (plan.files.length)
                excluded.push({ gate: id, reason: `${plan.files.length} fichier(s) de test à répéter (repeatChanged), que la CI ne répète pas : ${plan.files.slice(0, 5).join(', ')}${plan.files.length > 5 ? ', ...' : ''}` });
        }
        catch (error) {
            excluded.push({ gate: id, reason: `fichiers de test à répéter non calculés (${errorMessage(error).slice(0, 120)})` });
        }
    }
    const gates = covered.filter(g => !excluded.some(e => e.gate === g));
    if (!gates.length)
        return result('out_of_lane', excluded.map(e => `${e.gate} : ${e.reason}`), { excluded });
    if (!input.gh)
        return result('unavailable', ['hors réseau (--offline) : l\'API GitHub n\'est pas lue'], { gates, excluded });
    if (!input.repository)
        return result('unavailable', ['dépôt distant origin hors de github.com : l\'API GitHub n\'est pas lue'], { gates, excluded });
    try {
        return await readCheckRuns({ ...input, gh: input.gh, repository: input.repository }, gates, excluded, result);
    }
    catch (error) {
        if (error instanceof Unavailable)
            return result('unavailable', [`API GitHub indisponible (${error.message})`], { gates, excluded });
        return result('unavailable', [`API GitHub illisible (${errorMessage(error).slice(0, 160)})`], { gates, excluded });
    }
}
async function readCheckRuns(input, gates, excluded, result) {
    const { settings, head, gh, repository } = input;
    const get = async (path) => {
        const r = await api(gh, `repos/${repository}/${path}`);
        if (!r.ok)
            throw new Unavailable(r.why);
        return r.value;
    };
    const list = await get(`commits/${head}/check-runs?check_name=${encodeURIComponent(settings.name)}&filter=all&per_page=${MAX_CHECK_RUNS}`);
    const runs = list['check_runs'];
    const total = int(list['total_count']);
    if (!Array.isArray(runs) || total === null)
        throw new Unavailable('liste des check runs inattendue');
    if (total > runs.length)
        throw new Unavailable(`plus de ${MAX_CHECK_RUNS} check runs « ${settings.name} » au commit : non comparés`);
    const ignored = [];
    // The check runs of this name, the latest first (start, then id): the latest of the declared workflow decides.
    const named = runs.map(record).filter((c) => c !== null && str(c['name']) === settings.name)
        .sort((a, b) => (str(b['started_at']) ?? '').localeCompare(str(a['started_at']) ?? '') || (int(b['id']) ?? 0) - (int(a['id']) ?? 0));
    const workflowPaths = new Map();
    const workflowPath = async (id) => {
        if (!workflowPaths.has(id))
            workflowPaths.set(id, str((await get(`actions/workflows/${id}`))['path']));
        return workflowPaths.get(id);
    };
    for (const c of named) {
        const id = int(c['id']);
        if (id === null) {
            ignored.push('check run sans identifiant ignoré');
            continue;
        }
        const slug = str(record(c['app'])?.['slug']);
        if (slug !== GITHUB_ACTIONS_APP) {
            ignored.push(`check run ${id} ignoré : application ${slug ?? 'inconnue'}, pas ${GITHUB_ACTIONS_APP}`);
            continue;
        }
        const sha = str(c['head_sha']);
        if (sha !== head) {
            ignored.push(`check run ${id} ignoré : commit ${sha ? short(sha) : 'inconnu'}, pas ${short(head)}`);
            continue;
        }
        const suite = int(record(c['check_suite'])?.['id']);
        if (suite === null) {
            ignored.push(`check run ${id} ignoré : sans suite de checks`);
            continue;
        }
        const found = (await get(`actions/runs?check_suite_id=${suite}`))['workflow_runs'];
        const run = Array.isArray(found) && found.length === 1 ? record(found[0]) : null;
        if (!run) {
            ignored.push(`check run ${id} ignoré : aucune exécution de workflow unique pour sa suite ${suite}`);
            continue;
        }
        const workflowId = int(run['workflow_id']);
        const path = workflowId === null ? null : await workflowPath(workflowId);
        if (path !== settings.workflow) {
            ignored.push(`check run ${id} ignoré : workflow ${path ?? 'inconnu'}, pas ${settings.workflow}`);
            continue;
        }
        // The latest check run of the declared workflow decides: a later failure is never hidden by an earlier success.
        return judge(input, c, id, run, gates, excluded, ignored, result, get);
    }
    return result('refused', [...ignored, `aucun check run « ${settings.name} » de GitHub Actions au commit ${short(head)} du workflow ${settings.workflow}`], { gates, excluded });
}
async function judge(input, c, id, run, gates, excluded, ignored, result, get) {
    const { settings, head } = input;
    const runId = int(run['id']);
    const event = str(run['event']) ?? 'inconnu';
    const checkRun = { id, url: str(c['html_url']), runId: runId ?? 0, runAttempt: int(run['run_attempt']) ?? 0, event, workflow: settings.workflow };
    const refuse = (why) => result('refused', [...ignored, `check run ${id} (exécution ${runId ?? '?'}) : ${why}`], { gates, excluded, checkRun });
    const status = str(c['status']);
    if (status !== 'completed')
        return refuse(`en cours (${status ?? 'statut inconnu'}) : attendre sa conclusion`);
    const conclusion = str(c['conclusion']);
    if (conclusion !== 'success')
        return refuse(`conclusion ${conclusion ?? 'inconnue'}, pas success`);
    if (runId === null)
        return refuse('exécution sans identifiant');
    const runSha = str(run['head_sha']);
    if (runSha !== head)
        return result('refused', [...ignored, `exécution ${runId} d'un autre commit (${runSha ? short(runSha) : 'inconnu'}) que ${short(head)}`], { gates, excluded, checkRun });
    if (event === DISPATCH) {
        const text = gitRead(input.repo, ['show', `${input.mergeBase}:${settings.workflow}`]) ?? '';
        if (/^[ \t]*inputs[ \t]*:/m.test(text))
            return refuse(`évènement ${DISPATCH} : le workflow déclare des entrées (inputs), qui peuvent tester un autre commit que celui de l'exécution et que l'API ne rend pas`);
    }
    else if (!EVENTS.has(event))
        return refuse(`évènement ${event} refusé (acceptés : ${[...EVENTS].join(', ')}, ${DISPATCH} sans entrée)`);
    if (checkRun.runAttempt < 1)
        return refuse('tentative de l\'exécution inconnue');
    // The check run is a job of that run: a check run created through the API with the token of a job is not.
    const jobs = (await get(`actions/runs/${runId}/jobs?filter=all&per_page=100`))['jobs'];
    if (!Array.isArray(jobs))
        throw new Unavailable('liste des jobs inattendue');
    const job = jobs.map(record).find(j => j !== null && int(j['id']) === id);
    if (!job)
        return refuse(`check run ${id} absent des jobs de l'exécution ${runId}`);
    if (str(job['name']) !== settings.name || str(job['head_sha']) !== head || str(job['conclusion']) !== 'success') {
        return refuse(`job ${id} différent du check run (nom, commit ou conclusion)`);
    }
    return result('accepted', [], { gates, excluded, checkRun });
}
/** Lines that say why the CI does not prove the checks, for the refusal of the rule preuve. */
export function ciProofLines(ci) {
    const label = {
        accepted: 'preuve CI acceptée',
        refused: 'preuve CI refusée',
        out_of_lane: 'hors de la voie CI (preuve locale exigée)',
        unavailable: 'preuve CI non vérifiable',
    };
    if (ci.state === 'accepted')
        return [`prouvé(s) par la CI : ${ci.gates.join(', ')}`, ...ci.excluded.map(e => `${e.gate} : ${e.reason}`)];
    const tail = ci.state === 'unavailable' ? ' ; preuve locale exigée' : '';
    return [...ci.reasons.map(r => `${label[ci.state]} : ${r}${tail}`), ...(ci.state === 'out_of_lane' ? [] : ci.excluded.map(e => `${e.gate} : ${e.reason}`))];
}
//# sourceMappingURL=ci-proof.js.map