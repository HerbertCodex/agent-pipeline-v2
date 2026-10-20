import { PipelineError } from '../domain/errors.js';
import { localTime } from '../domain/time.js';
import { lotCommits, measurePr, prBaseline, type PrMetrics } from '../metrics/pr.js';
import {
  BASELINE_RUNS, PHASE_LABEL, deliveredPullRequest, duration, gapPercent, measureRun, runBaseline, signedPercent, type RunBaseline, type RunMetrics,
} from '../metrics/run.js';
import {
  commonDirOf, findRunStates, mergedPrs, pullRequestEnd, reviewsOn, runCommits, stackEvents, storedRuns, suiteCount, suitesOn, viewPr,
  type FoundState, type StoredRun,
} from '../metrics/sources.js';
import { gitRoot } from '../run/git-probe.js';
import { RUN_ID, STATUS_LABEL } from '../run/state.js';
import { cleanLine } from '../run/summary.js';
import { processGh, type GhRunner } from '../stack/github.js';
import type { StackEvent } from '../metrics/pr.js';
import { EXIT, UsageError, guard, json, parse, repoPath, table } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv metrics run [<id>] [--offline] [--repo <chemin>] [--json]
  apv metrics prs [<n>...] [--since <date>] [--repo <chemin>] [--json]

Mesure du temps de bout en bout (docs/SHIFT-LEFT.md, section 11), en lecture seule, sans aucune saisie.

run <id> : une exécution de spec, depuis son état .apv/state/run-<id>.json (la copie la plus récente parmi les
worktrees du dépôt, dont celui du chef de projet, puis l'historique de toutes les branches) : temps de la création de
l'exécution (spec validée) jusqu'à la fusion de sa PR ; durée de chaque phase, chaque phase allant du jalon de la
précédente au sien (modèle de données, plan, code, intégration, relectures, corrections, livraison, attente de
fusion) ; chemin critique de la phase de code (chaîne de dépendances la plus longue, pondérée par la durée mesurée
de chaque tâche) ; suites complètes et contrôles de tâche lancés sur ses commits (magasin partagé des reçus) ; passes
de corrections ; relectures ; pauses de quota. Puis l'écart à la base de comparaison : médiane des ${BASELINE_RUNS} dernières
exécutions fusionnées avant celle-ci. Sans <id> : toutes les exécutions trouvées, et la base.
La PR vient de la note de livraison (adresse .../pull/<n> ou « PR #<n> »), sinon de la branche de la spec (gh pr list) ;
sa fusion de gh pr view, sinon de la trace signée de apv stack merge, sinon de .apv/state/stack.log.
--offline : aucun appel gh (traces de fusion et stack.log seulement).
Bornes : 50 états au plus (les plus récents, plafond signalé), 4 appels gh à la fois ; un état daté du futur est ignoré.

prs [<n>...] : chaque PR (défaut : celles fusionnées depuis --since, 30 jours par défaut) : ouverte, prête (la plus
tardive de son ouverture et de son dernier commit), première tentative de fusion (stack.log), fusionnée ; prête à
fusionnée, attente de l'ordre, fusion ; relectures enregistrées et suites complètes sur ses commits ; type « spec »
(sa branche est celle d'une exécution) ou « minime ». Base : médiane des 5 dernières PR minimes fusionnées.
Les objectifs de la section 11 (30 min, 40 min) sont à vérifier sur ces chiffres, pas promis.
Sortie : 0 mesuré, 1 exécution ou PR introuvable ou illisible, 2 appel incorrect.`;

const when = (iso: string | null): string => iso ? localTime(iso) : '?';
const END_LABEL: Record<RunMetrics['end']['kind'], string> = { merge: "jusqu'à la fusion", delivery: "jusqu'à la livraison (fusion inconnue)", 'last-event': "jusqu'au dernier événement (pas encore livrée)" };

/** Executions measured at once, hence `gh` calls at once (each measure makes its calls one after the other). */
const MEASURE_CONCURRENCY = 4;

/** `fn` over `items`, at most `limit` at a time, results in the order of `items`. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const slot = async (): Promise<void> => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, slot));
  return out;
}

interface Context { repo: string; common: string | null; gh: GhRunner | null; stack: StackEvent[]; runs: StoredRun[] }

async function measure(ctx: Context, found: FoundState): Promise<RunMetrics> {
  const commits = runCommits(ctx.repo, found.state);
  const pr = await pullRequestEnd({ gh: ctx.gh, common: ctx.common, state: found.state, named: deliveredPullRequest(found.state), stack: ctx.stack });
  // The suite of the lot that merged its pull request is one of its suites.
  if (pr) for (const sha of lotCommits(ctx.stack, pr.number)) commits.add(sha);
  const suites = ctx.common ? suiteCount(suitesOn(ctx.runs, commits)) : null;
  return measureRun({ state: found.state, source: found.source, suites, pr });
}

function runLines(m: RunMetrics, base: RunBaseline): string[] {
  const cp = m.criticalPath;
  const prText = m.pr ? `PR #${m.pr.number}${m.pr.mergedAt ? ` fusionnée ${when(m.pr.mergedAt)}` : ' pas encore fusionnée'}` : 'aucune PR trouvée';
  const lines = [
    cleanLine(`Exécution ${m.specId} (état : ${m.source}, mis à jour ${when(m.updatedAt)})`, 400),
    `De bout en bout : ${duration(m.totalMs)}, de la création de l'exécution (${when(m.createdAt)}) ${END_LABEL[m.end.kind]} (${when(m.end.at)}) ; ${prText}`,
    'Phases (chacune du jalon de la précédente au sien) :',
    table(['Phase', 'Durée', 'État', 'Fin'], m.phases.map(p => [PHASE_LABEL[p.phase], p.ms === null ? '-' : duration(p.ms),
      p.status === 'running' ? 'en cours' : p.status === 'pending' ? 'à venir' : STATUS_LABEL[p.status], p.endedAt ? when(p.endedAt) : '-'])).split('\n').map(l => `  ${l}`).join('\n'),
    `Chemin critique de la phase de code : ${cp.chain.length ? cp.chain.join(' -> ') : 'aucune tâche terminée'}, ${duration(cp.workMs)} de travail ; phase de code ${duration(cp.spanMs)}, dont ${duration(cp.waitMs)} hors du travail du chemin critique${cp.complete ? '' : ' (tâches pas toutes terminées)'}`,
    `Tâches : ${m.tasks.length} en ${m.waves} vague(s) ; relancées : ${m.tasks.filter(t => t.starts > 1).map(t => `${t.id} (${t.starts} départs)`).join(', ') || 'aucune'}`,
    m.suites ? `Suites complètes : ${m.suites.full} (${duration(m.suites.fullMs)} en tout), dont ${m.suites.fullFailed} en échec ; contrôles de tâche : ${m.suites.task} ; suites d'impact : pas encore livrées`
      : 'Suites : magasin des reçus illisible',
    `Relectures : ${m.reviews.map(r => `${r.domain} ${STATUS_LABEL[r.status]}${r.findings !== null ? ` (${r.findings} constat(s))` : ''}${r.launches > 1 ? `, ${r.launches} lancements` : ''}`).join(' ; ')}`,
    `Passes de corrections : ${m.fixPasses} ; suites complètes hors rythme : ${m.fullSuiteOverrides} ; pauses de quota : ${duration(m.pausedMs)}`,
    'Contestations et mutations survivantes : non mesurées (testeur et mutation pas encore livrés)',
  ];
  lines.push(base.specs.length
    ? `Base de comparaison (médiane de ${base.specs.join(', ')}) : bout en bout ${duration(base.totalMs)} (écart ${signedPercent(gapPercent(m.finished ? m.totalMs : null, base.totalMs))}${m.finished ? '' : ', pas encore fusionnée'}) ; chemin critique ${duration(base.criticalWorkMs)} (écart ${signedPercent(gapPercent(cp.complete ? cp.workMs : null, base.criticalWorkMs))}) ; phase de code ${duration(base.codeSpanMs)}`
    : 'Base de comparaison : aucune autre exécution fusionnée');
  return lines;
}

function listLines(all: RunMetrics[], base: RunBaseline): string[] {
  const rows = all.map(m => [m.specId, when(m.createdAt), duration(m.totalMs), m.end.kind === 'merge' ? `fusion #${m.pr?.number}` : m.end.kind === 'delivery' ? 'livraison' : 'en cours',
    duration(m.criticalPath.workMs), duration(m.criticalPath.spanMs), String(m.tasks.length), String(m.waves)]);
  return [
    table(['Exécution', 'Créée', 'Bout en bout', "Jusqu'à", 'Chemin critique', 'Phase de code', 'Tâches', 'Vagues'], rows.map(r => r.map(c => cleanLine(c, 120)))),
    base.specs.length ? `Base de comparaison (médiane de ${base.specs.join(', ')}) : bout en bout ${duration(base.totalMs)} ; chemin critique ${duration(base.criticalWorkMs)} ; phase de code ${duration(base.codeSpanMs)}`
      : 'Base de comparaison : aucune exécution fusionnée',
  ];
}

async function runCommand(io: CommandIO, repo: string, id: string | undefined, offline: boolean, asJson: boolean): Promise<number> {
  if (id !== undefined && !RUN_ID.test(id)) throw new UsageError(`identifiant d'exécution invalide : ${id}`);
  const common = commonDirOf(repo);
  const { states, skipped, warnings } = findRunStates(repo);
  if (id !== undefined && !states.has(id)) {
    const details = [...(skipped.length ? [`illisibles : ${skipped.join(' ; ')}`] : []), ...warnings];
    // Names of files and branches come from the repository: no control character reaches the terminal.
    throw new PipelineError('METRICS_RUN_MISSING', cleanLine(`Aucun état d'exécution ${id} dans les worktrees ni dans l'historique du dépôt${details.length ? ` (${details.join(' ; ')})` : ''}`, 1000));
  }
  const ctx: Context = { repo, common, gh: offline ? null : processGh(io.env['APV_GH'] || 'gh', io.env, repo), stack: stackEvents(repo), runs: storedRuns(common) };
  const all = (await mapLimit([...states.values()], MEASURE_CONCURRENCY, f => measure(ctx, f))).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const target = id !== undefined ? all.find(m => m.specId === id)! : undefined;
  const base = runBaseline(all, target);
  if (asJson) { json(io, target ? { run: target, baseline: base, skipped, warnings } : { runs: all, baseline: base, skipped, warnings }); return EXIT.ok; }
  const lines = target ? runLines(target, base) : listLines(all, base);
  lines.push(...warnings.map(w => cleanLine(`Attention : ${w}`, 400)));
  if (skipped.length) lines.push(...skipped.map(s => cleanLine(`Copie illisible ignorée : ${s}`, 400)));
  io.stdout(`${lines.join('\n')}\n`);
  return EXIT.ok;
}

function prLines(list: PrMetrics[], base: ReturnType<typeof prBaseline>): string[] {
  const rows = list.map(p => [`#${p.number}`, p.kind === 'spec' ? `spec ${p.spec}` : 'minime', when(p.createdAt), when(p.readyAt), p.mergedAt ? when(p.mergedAt) : 'non fusionnée',
    duration(p.readyToMergeMs), duration(p.orderWaitMs), duration(p.mergeMs),
    `${p.reviews.count}${p.reviews.domains.length ? ` (${p.reviews.domains.join(', ')})` : ''}`,
    p.suites ? `${p.suites.full} (${duration(p.suites.fullMs)})` : '?', `${p.size.files} fichier(s), +${p.size.additions} -${p.size.deletions}`]);
  return [
    table(['PR', 'Type', 'Ouverte', 'Prête', 'Fusionnée', 'Prête à fusionnée', "Attente de l'ordre", 'Fusion', 'Relectures', 'Suites complètes', 'Taille'], rows.map(r => r.map(c => cleanLine(c, 120)))),
    ...list.filter(p => p.batchStops).map(p => `#${p.number} : ${p.batchStops} arrêt(s) du lot avant sa fusion (stack.log)`),
    base.prs.length
      ? `Base (médiane des ${base.prs.length} dernières PR minimes fusionnées : ${base.prs.map(n => `#${n}`).join(', ')}) : prête à fusionnée ${duration(base.readyToMergeMs)} ; ouverte à fusionnée ${duration(base.openToMergeMs)} ; attente de l'ordre ${duration(base.orderWaitMs)} ; fusion ${duration(base.mergeMs)}`
      : 'Base : aucune PR minime fusionnée parmi celles-ci',
    'Objectifs de la section 11, à vérifier sur ces chiffres : voie sans code 30 min au plus de prête à fusionnée, voie des réglages 40 min au plus.',
  ];
}

async function prsCommand(io: CommandIO, repo: string, numbers: number[], since: string | undefined, asJson: boolean): Promise<number> {
  const gh = processGh(io.env['APV_GH'] || 'gh', io.env, repo);
  const errors: string[] = [];
  let list = numbers;
  const from = since ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  if (!list.length) {
    const found = await mergedPrs(gh, from, 100);
    if (found.error) throw new PipelineError('METRICS_GH', found.error);
    list = found.numbers;
  }
  const common = commonDirOf(repo);
  const stack = stackEvents(repo);
  const runs = storedRuns(common);
  const specByBranch = new Map([...findRunStates(repo).states.values()].map(f => [f.state.branch, f.state.specId]));
  const measured: PrMetrics[] = [];
  for (const n of list) {
    const { pr, error } = await viewPr(gh, n);
    if (!pr) { errors.push(error ?? `PR #${n} illisible`); continue; }
    const oids = pr.commits.map(c => c.oid);
    measured.push(measurePr({ pr, spec: specByBranch.get(pr.headRefName) ?? null, stack,
      reviews: common ? reviewsOn(common, oids) : null, suites: common ? suitesOn(runs, new Set([...oids, ...lotCommits(stack, n)])) : null }));
  }
  const base = prBaseline(measured);
  if (asJson) json(io, { since: numbers.length ? null : from, prs: measured, baseline: base, errors });
  else {
    io.stdout(`${measured.length ? prLines(measured, base).join('\n') : 'Aucune PR mesurée'}\n`);
    if (errors.length) io.stderr(`${errors.map(e => cleanLine(e, 400)).join('\n')}\n`);
  }
  return errors.length ? EXIT.failed : EXIT.ok;
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, { since: { type: 'string' }, offline: { type: 'boolean' }, repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    const [action, ...rest] = positionals;
    const repo = (): string => gitRoot(repoPath(io, values.repo));
    if (action === 'run') {
      if (values.since !== undefined) throw new UsageError('--since ne vaut que pour apv metrics prs');
      if (rest.length > 1) throw new UsageError(`argument inattendu : ${rest.slice(1).join(' ')}`);
      return runCommand(io, repo(), rest[0], values.offline === true, values.json === true);
    }
    if (action === 'prs') {
      if (values.offline) throw new UsageError('--offline ne vaut que pour apv metrics run (les PR se lisent par gh)');
      if (values.since !== undefined && Number.isNaN(Date.parse(values.since))) throw new UsageError(`--since : date invalide (${values.since})`);
      const numbers = rest.map(r => {
        const n = /^#?(\d{1,7})$/.exec(r)?.[1];
        if (!n) throw new UsageError(`numéro de PR invalide : ${r}`);
        return Number(n);
      });
      if (numbers.length && values.since !== undefined) throw new UsageError('--since ou des numéros de PR, pas les deux');
      return prsCommand(io, repo(), numbers, values.since !== undefined ? new Date(values.since).toISOString() : undefined, values.json === true);
    }
    throw new UsageError(action ? `sous-commande inconnue : metrics ${action}` : 'sous-commande manquante (run ou prs)');
  });
}
