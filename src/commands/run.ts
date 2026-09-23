import { readFileSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { sha256 } from '../domain/hash.js';
import { specSchema } from '../lifecycle/contracts.js';
import { checkSpec, readSpecDocument } from '../spec/check.js';
import { gitProbe, gitRead, gitRoot, resolveCommit } from '../run/git-probe.js';
import {
  REVIEWS, RUN_ID, STATUSES, STATUS_LABEL, STEPS, STEP_LABEL, applySet, computeNext, createRunState, parseTarget,
  readRunState, runStateFile, splitWave, summarize, summaryLine, withRunLock, writeRunState, type RunState, type RunStatus, type SetOptions, type Wave,
} from '../run/state.js';
import { readRunSummaries, runSummaryLine, unreadRunsLine } from '../run/summary.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv run start <spec> [--base <branche>] [--repo <chemin>] [--json]
  apv run set <spec-id> <cible> <statut> [--branch b] [--worktree w] [--agent id] [--commit sha]
              [--base sha] [--findings n] [--note texte] [--repo <chemin>] [--json]
  apv run next <spec-id> [--repo <chemin>] [--json]
  apv run status [<spec-id>] [--repo <chemin>] [--json]

État de reprise d'une exécution de spec : .apv/state/run-<spec-id>.json, écrit de façon atomique sous
le verrou run:<spec-id> (apv lock).
start   valide la spec (comme apv spec validate, prête à lancer), calcule les vagues (couches des
        dépendances) et les fondations (tâches dont au moins deux autres dépendent directement,
        écrites par un seul agent) et crée l'état. <spec> : un identifiant (.apv/specs/<id>.json) ou un chemin. Refuse si l'état
        existe (apv run next). --base : branche de départ (par défaut la branche courante).
set     <cible> : ${STEPS.join(', ')},
        task:<id> ou review:<${REVIEWS.join('|')}>.
        <statut> : ${STATUSES.join(', ')}. Une tâche ne passe « running »
        que si ses dépendances sont « done » ; « done » exige --commit pour une tâche (facultatif
        pour une étape ou une revue : commit qui la porte, ou commit revu). --base : commit de départ
        de la tâche (reprise). --findings : nombre de constats d'une revue. Rouvrir un travail fait,
        ou remplacer son commit, exige --note.
next    ce qu'il faut faire maintenant : étape courante, tâches prêtes, tâches à reprendre ou à
        relancer (worktree absent, aucun commit après la base), revues à lancer.
status  résumé de toutes les exécutions, ou détail d'une seule.
Sortie : 0 succès, 1 refus (spec invalide, état existant ou absent, transition refusée), 2 appel incorrect.`;

const options = {
  repo: { type: 'string' }, base: { type: 'string' }, branch: { type: 'string' }, worktree: { type: 'string' }, agent: { type: 'string' },
  commit: { type: 'string' }, note: { type: 'string' }, findings: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} as const;

const posix = (path: string): string => path.split(sep).join('/');

function specIdArg(value: string | undefined): string {
  if (!value) throw new UsageError('identifiant de spec manquant');
  if (!RUN_ID.test(value) || value.length > 80) throw new UsageError(`identifiant de spec invalide : ${value}`);
  return value;
}

/** `<spec>` of `start`: an id of `.apv/specs/`, or a path to a spec file (its id is the file name). */
function locateSpec(repo: string, cwd: string, value: string): { specId: string; path: string } {
  const isPath = value.includes('/') || value.includes(sep) || value.endsWith('.json');
  const path = isPath ? resolve(cwd, value) : resolve(repo, '.apv', 'specs', `${value}.json`);
  const specId = basename(path).replace(/\.json$/, '');
  if (!RUN_ID.test(specId) || specId.length > 80) throw new UsageError(`nom de spec invalide pour une exécution : ${specId}`);
  return { specId, path };
}

async function start(repo: string, cwd: string, positionals: string[], values: { base?: string | undefined; json?: boolean | undefined }, io: CommandIO): Promise<number> {
  const [value, ...rest] = positionals;
  if (!value) throw new UsageError('spec manquante');
  if (rest.length) throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
  const { specId, path } = locateSpec(repo, cwd, value);
  const file = runStateFile(repo, specId);
  const base = values.base ?? gitRead(repo, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (!base) throw new PipelineError('RUN_BASE', 'HEAD détachée : préciser la branche de départ avec --base');
  const baseSha = resolveCommit(repo, base);
  if (!baseSha) throw new PipelineError('RUN_BASE', `Base introuvable : ${base}`);
  const refuse = (issues: { code: string; message: string }[]): number => {
    if (values.json) json(io, { started: false, specId, file: path, issues });
    else io.stdout(`Spec invalide, exécution non créée : ${path}\n${issues.map(i => `- [${i.code}] ${i.message}`).join('\n')}\n(apv spec validate ${relative(cwd, path) || path})\n`);
    return EXIT.failed;
  };
  let bytes: string;
  let document: ReturnType<typeof readSpecDocument>;
  try { document = readSpecDocument(path); bytes = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error instanceof PipelineError) return refuse([{ code: error.code, message: error.message }]);
    return refuse([{ code: 'SPEC_FILE', message: `Spec illisible ${path} : ${errorMessage(error)}` }]);
  }
  const check = await checkSpec({ repo, document, ready: true });
  if (!check.valid) return refuse(check.issues);
  const spec = specSchema.parse(document.spec);
  const state = await withRunLock(specId, io.env, () => {
    try { readRunState(file, { shown: posix(relative(repo, file)), specId }); throw new PipelineError('RUN_EXISTS', `L'exécution ${specId} existe déjà (${relative(repo, file)}) : apv run next ${specId} pour la reprendre`); }
    catch (error) { if (!(error instanceof PipelineError) || error.code !== 'RUN_MISSING') throw error; }
    const created = createRunState({ specId, specFile: posix(relative(repo, path)), specSha256: sha256(bytes), base, baseSha,
      tasks: spec.tasks.map(t => ({ id: t.id, title: t.title, dependsOn: t.dependsOn })) });
    writeRunState(file, created);
    return created;
  });
  if (values.json) { json(io, { started: true, file: posix(relative(repo, file)), state }); return EXIT.ok; }
  io.stdout([
    `Exécution créée : ${posix(relative(repo, file))}`,
    `Spec : ${state.specFile} (${check.title ?? specId}), sha256 ${state.specSha256.slice(0, 12)}`,
    `Base : ${state.base} à ${state.baseSha.slice(0, 12)} ; branche de la spec : ${state.branch}`,
    'Vagues :',
    ...state.waves.map(w => `- vague ${w.index} : ${waveParts(state, w, id => id)}`),
    `Suite : apv run next ${specId}`,
  ].join('\n') + '\n');
  return EXIT.ok;
}

/**
 * The tasks of a wave as shown by `start` and `status`: « fondations (un seul agent) : … ; en parallèle : … »
 * when the wave has foundations, the plain list otherwise.
 */
function waveParts(state: RunState, wave: Wave, show: (id: string) => string): string {
  const { foundations, parallel } = splitWave(state, wave);
  if (!foundations.length) return wave.tasks.map(show).join(', ');
  return [`fondations (un seul agent) : ${foundations.map(show).join(', ')}`, ...(parallel.length ? [`en parallèle : ${parallel.map(show).join(', ')}`] : [])].join(' ; ');
}

function parseStatus(value: string | undefined): RunStatus {
  if (!value) throw new UsageError('statut manquant');
  if (!(STATUSES as readonly string[]).includes(value)) throw new UsageError(`statut inconnu : ${value} (${STATUSES.join(', ')})`);
  return value as RunStatus;
}

async function set(repo: string, positionals: string[], values: Record<string, string | boolean | undefined>, io: CommandIO): Promise<number> {
  const [id, targetText, statusText, ...rest] = positionals;
  const specId = specIdArg(id);
  if (!targetText) throw new UsageError('cible manquante');
  if (rest.length) throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
  const target = parseTarget(targetText);
  if (!target) throw new UsageError(`cible inconnue : ${targetText} (${STEPS.join(', ')}, task:<id>, review:<${REVIEWS.join('|')}>)`);
  const status = parseStatus(statusText);
  const str = (name: string): string | undefined => typeof values[name] === 'string' ? values[name] as string : undefined;
  const taskOnly = ['branch', 'worktree', 'agent', 'base'].filter(o => str(o) !== undefined);
  if (target.kind !== 'task' && taskOnly.length) throw new UsageError(`--${taskOnly.join(', --')} : réservé(s) aux tâches (task:<id>)`);
  if (target.kind !== 'review' && str('findings') !== undefined) throw new UsageError('--findings : réservé aux revues (review:<domaine>)');
  const opts: SetOptions = { status };
  const findings = str('findings');
  if (findings !== undefined) {
    if (!/^\d+$/.test(findings)) throw new UsageError(`--findings invalide : ${findings}`);
    opts.findings = Number(findings);
  }
  for (const [option, field] of [['branch', 'branch'], ['agent', 'agentId'], ['note', 'note']] as const) {
    const v = str(option);
    if (v !== undefined) opts[field] = v;
  }
  const worktree = str('worktree');
  if (worktree !== undefined) opts.worktree = resolve(io.cwd, worktree);
  for (const option of ['commit', 'base'] as const) {
    const v = str(option);
    if (v === undefined) continue;
    const sha = resolveCommit(repo, v);
    if (!sha) throw new PipelineError('RUN_COMMIT', `--${option} : commit introuvable dans ${repo} : ${v}`);
    opts[option] = sha;
  }
  const file = runStateFile(repo, specId);
  const result = await withRunLock(specId, io.env, () => {
    const current = readRunState(file, { shown: posix(relative(repo, file)), specId });
    const applied = applySet(current, target, opts);
    writeRunState(file, applied.state);
    return applied;
  });
  const name = targetText;
  if (values['json']) { json(io, { specId, target: name, from: result.from, to: status, event: result.event }); return EXIT.ok; }
  io.stdout(`${specId} ${name} : ${STATUS_LABEL[result.from]} -> ${STATUS_LABEL[status]}${opts.commit ? ` (commit ${opts.commit.slice(0, 12)})` : ''}\n`);
  return EXIT.ok;
}

function next(repo: string, positionals: string[], asJson: boolean, io: CommandIO): number {
  const [id, ...rest] = positionals;
  const specId = specIdArg(id);
  if (rest.length) throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
  const file = runStateFile(repo, specId);
  const state = readRunState(file, { shown: posix(relative(repo, file)), specId });
  const next = computeNext(state, gitProbe(repo));
  // The spec may have been edited since the start: the plan (waves, tasks) no longer matches it.
  const specPath = resolve(repo, state.specFile);
  let specChanged: boolean | null = null;
  try { specChanged = sha256(readFileSync(specPath, 'utf8')) !== state.specSha256; } catch { /* missing: null */ }
  if (specChanged !== false) next.actions.unshift(specChanged ? `la spec ${state.specFile} a changé depuis le lancement : vérifier que les tâches restantes lui correspondent (l'état garde le plan du lancement)` : `la spec ${state.specFile} est introuvable`);
  const plan = { ...next, specChanged };
  if (asJson) { json(io, plan); return EXIT.ok; }
  const short = (sha: string | null): string => sha ? sha.slice(0, 12) : '?';
  const where = plan.finished ? 'terminée' : plan.step === 'waves' ? `vagues (vague ${plan.wave})` : `${STEP_LABEL[plan.step!]} (${STATUS_LABEL[plan.stepStatus!]})`;
  const lines = [
    `Exécution ${state.specId} : branche ${state.branch}, base ${state.base} à ${short(state.baseSha)}`,
    `Étape courante : ${where}`,
  ];
  if (plan.relaunch.length) lines.push('À relancer (si leur agent ne tourne plus) :', ...plan.relaunch.map(r =>
    `- ${r.id} : ${r.reason} ; branche ${r.branch ?? '?'} ; worktree ${r.worktree ?? '?'} ; agent ${r.agentId ?? '?'} ; dernier commit ${short(r.commit)}`));
  if (plan.resume.length) lines.push('À reprendre :', ...plan.resume.map(r =>
    `- ${r.id} : branche ${r.branch ?? '?'} ; worktree ${r.worktree ?? '?'} ; agent ${r.agentId ?? '?'} ; tête ${short(r.head)} ; ${r.commitsAfterBase} commit(s) après la base ; dernier commit enregistré ${short(r.commit)}`));
  if (plan.failed.length) lines.push(`En échec : ${plan.failed.map(f => f.id).join(', ')}`);
  lines.push(`Prêtes : ${plan.ready.length ? plan.ready.map(r => `${r.id} (vague ${r.wave})`).join(', ') : 'aucune'}`);
  if (plan.blocked.length) lines.push(`Bloquées : ${plan.blocked.map(b => `${b.id} (attend ${b.waitingOn.join(', ')})`).join(' ; ')}`);
  if (plan.reviewsToLaunch.length) lines.push(`Revues à lancer : ${plan.reviewsToLaunch.join(', ')}`);
  if (plan.reviewsRunning.length) lines.push(`Revues en cours : ${plan.reviewsRunning.join(', ')}`);
  lines.push('Actions :', ...plan.actions.map(a => `- ${a}`));
  io.stdout(`${lines.join('\n')}\n`);
  return EXIT.ok;
}

function detail(state: RunState): string[] {
  const step = (name: typeof STEPS[number]): string => `${name} ${STATUS_LABEL[state.steps[name].status]}`;
  return [
    `Exécution ${state.specId} (${state.specFile}) : branche ${state.branch}, base ${state.base} à ${state.baseSha.slice(0, 12)}`,
    `Créée ${state.createdAt} ; mise à jour ${state.updatedAt}`,
    `Étapes : ${STEPS.map(step).join(' ; ')}`,
    ...state.waves.map(w => `Vague ${w.index} : ${waveParts(state, w, id => {
      const t = state.tasks[id]!;
      return `${id} ${STATUS_LABEL[t.status]}${t.commit ? ` @${t.commit.slice(0, 7)}` : ''}`;
    })}`),
    `Revues : ${REVIEWS.map(r => `${r} ${STATUS_LABEL[state.reviews[r].status]}${state.reviews[r].findings !== null ? ` (${state.reviews[r].findings} constat(s))` : ''}`).join(' ; ')}`,
    `Événements : ${state.events.length} ; dernier : ${(() => { const e = state.events.at(-1)!; return `${e.at} ${e.target} ${e.from ?? '-'} -> ${e.to}`; })()}`,
  ];
}

function status(repo: string, positionals: string[], asJson: boolean, io: CommandIO): number {
  const [id, ...rest] = positionals;
  if (rest.length) throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
  if (id !== undefined) {
    const specId = specIdArg(id);
    const file = runStateFile(repo, specId);
    const state = readRunState(file, { shown: posix(relative(repo, file)), specId });
    if (asJson) { json(io, { summary: summarize(state, posix(relative(repo, file))), state }); return EXIT.ok; }
    io.stdout(`${[...detail(state), `Résumé : ${summaryLine(summarize(state, file))}`].join('\n')}\n`);
    return EXIT.ok;
  }
  // The shared summary: bounded reads (no FIFO, no huge file, a file and byte budget) and cleaned lines.
  const { entries, unread } = readRunSummaries(repo);
  if (asJson) { json(io, { runs: entries, unread }); return EXIT.ok; }
  const lines = [...entries.map(r => `- ${runSummaryLine(r)}`), ...(unread ? [`- ${unreadRunsLine(unread)}`] : [])];
  io.stdout(lines.length ? `${lines.join('\n')}\n` : 'Aucune exécution (.apv/state/run-*.json).\n');
  return EXIT.ok;
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, options);
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    const [action, ...rest] = positionals;
    if (!action) throw new UsageError('sous-commande manquante (start, set, next, status)');
    if (!['start', 'set', 'next', 'status'].includes(action)) throw new UsageError(`sous-commande inconnue : run ${action}`);
    const setOnly = ['branch', 'worktree', 'agent', 'commit', 'note', 'findings'];
    const forbidden = action === 'set' ? [] : action === 'start' ? setOnly : ['base', ...setOnly];
    const extra = forbidden.filter(n => values[n as keyof typeof values] !== undefined);
    if (extra.length) throw new UsageError(`option(s) sans effet pour run ${action} : --${extra.join(', --')}`);
    const repo = gitRoot(repoPath(io, values.repo));
    if (action === 'start') return start(repo, io.cwd, rest, values, io);
    if (action === 'set') return set(repo, rest, values, io);
    if (action === 'next') return next(repo, rest, Boolean(values.json), io);
    return status(repo, rest, Boolean(values.json), io);
  });
}
