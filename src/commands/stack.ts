import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { APV_DIR, ensureApvGitignore } from '../config/apv-files.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { gitRead } from '../run/git-probe.js';
import { MAX_OVERRIDE_REASON } from '../run/state.js';
import { cleanLine } from '../run/summary.js';
import { MERGE_REFUSED, mergeStack, planStack, processGh, type Derogation, type Freshness, type GhCall, type StackOptions, type StackPlan } from '../stack/github.js';
import { batchMerge, processGit, type BatchReport, type Proof } from '../stack/batch.js';
import { loadConfigAtCommit, type ApvConfig } from '../config/load.js';
import { hash } from '../domain/hash.js';
import { runGates } from '../gates/run.js';
import { verifyGates } from '../gates/verify.js';
import { success } from '../engine/scheduler.js';
import { environment, runProcess } from '../execution/process.js';
import { commonDir } from '../stacks/idle.js';
import { signalExitCode } from '../lock/run.js';
import { resolve } from 'node:path';
import { EXIT, UsageError, guard, json, parse } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv stack plan <pr...> [--target <branche>] [--ready] [--allow-behind --reason <texte>] [--json]
  APV_ALLOW_MERGE=1 apv stack merge <pr...> [--method merge|squash|rebase] [--target <branche>] [--ready]
                                   [--allow-behind --reason <texte>] [--json]
  apv stack batch <pr...> [--target <branche>] [--dir <dossier>] [--bisect] [--keep] [--json]
  APV_ALLOW_MERGE=1 apv stack batch <pr...> --merge [--ready] [--target <branche>] [--dir <dossier>] [--bisect]

Pile de PR, de la base vers le sommet (numéros de PR dans l'ordre de fusion).
plan   lit chaque PR (gh pr view) et vérifie la pile : chaque PR ouverte, la base de la PR n+1 est la
       tête de la PR n (la branche cible pour la première), fusionnable, contrôles au vert ou absents,
       et la tête de chaque PR contient la tête actuelle de sa base (gh api .../compare/<tête>...<base>).
       Toutes les anomalies sont listées. Ne modifie rien.
merge  uniquement sur ordre explicite de l'opérateur, avec APV_ALLOW_MERGE=1 devant la commande.
       Refait la vérification juste avant chaque fusion ; une fois la PR précédente fusionnée, re-cible
       la suivante sur la branche cible par l'API REST (gh api -X PATCH repos/<propriétaire>/<dépôt>/pulls/<n>)
       et vérifie la nouvelle base par une relecture, quel que soit le code de sortie ; vérifie que la tête
       contient la cible telle qu'elle est à cet instant ; fusionne avec --match-head-commit ; constate la
       fusion par une relecture ; s'arrête à la première anomalie.
       La sortie complète de chaque appel gh est affichée (sur la sortie d'erreur avec --json).
Base à jour : une PR dont la tête ne contient pas la tête actuelle de sa base est refusée (ses contrôles
       n'ont pas porté sur le résultat de la fusion), avec la marche à suivre : fusionner la base dans la
       branche (jamais de rebase ni de force-push), repasser au moins les contrôles de tâche sur la nouvelle
       tête, pousser, relancer. Seule tolérance : des commits de fusion de la base qui ne changent aucun
       fichier (la fusion de la PR précédente d'une pile, par --method merge).
--target  branche d'arrivée de la pile (par défaut la base de la première PR).
--ready   retire le statut brouillon (gh pr ready) avant la fusion ; sans lui, un brouillon est une anomalie.
--allow-behind --reason <texte>  dérogation exceptionnelle : laisse passer une PR en retard sur sa base
       (1 à ${MAX_OVERRIDE_REASON} caractères de raison) ; merge la journalise avant la fusion, dans
       .apv/state/stack.log (une ligne JSON par PR) et dans le rapport. Jamais pour gagner du temps.
batch  fusion par lot de PR indépendantes, chacune vers la cible : lit chaque PR (ouverte, fusionnable,
       contrôles au vert ; brouillon admis), crée la branche apv/lot-<date> depuis origin/<cible> dans un
       worktree (--dir, défaut <répertoire git commun>/apv/lots/), y fusionne la tête de chaque PR dans
       l'ordre (git merge --no-ff, jamais de rebase ; une PR en conflit reste hors du lot), lance batch.setup
       de .apv/config.json (facultatif), UNE suite complète (apv gates run --stage full) puis apv gates verify
       à la tête du lot. --bisect : suite en échec, le lot est coupé en deux, chaque moitié prouvée, jusqu'à
       isoler la ou les PR fautives, qui sortent du lot ; le reste est prouvé une dernière fois.
       --merge (avec APV_ALLOW_MERGE=1, sur ordre de l'opérateur) : lot prouvé, fusionne ses PR dans l'ordre
       (gh pr merge --merge --match-head-commit), chacune après avoir vérifié sa tête (celle du lot) et que
       l'arbre de la cible est celui du lot avant elle, puis que l'arbre de la cible après elle est celui du
       lot : l'écart dû aux fusions précédentes du lot est toléré, le contenu fusionné est celui prouvé. À la
       fin, arbre de la cible identique à la tête prouvée du lot ; toute différence arrête tout. Journal :
       .apv/state/stack.log. --keep garde les worktrees des lots.
La variable APV_GH remplace l'exécutable gh (tests). Sortie : 0 pile cohérente ou fusionnée (lot prouvé,
et fusionné avec --merge), 1 anomalie (rien d'autre n'est fusionné), 2 appel incorrect ou APV_ALLOW_MERGE absent.`;

const METHODS = ['merge', 'squash', 'rebase'] as const;

const quote = (arg: string): string => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;

/** A `gh` call as printed: the command line, its whole output and its exit status. */
export function transcript(bin: string, call: GhCall): string {
  const lines = [`$ ${[bin, ...call.args].map(quote).join(' ')}`];
  if (call.stdout) lines.push(call.stdout.replace(/\n$/, ''));
  if (call.stderr) lines.push(call.stderr.replace(/\n$/, ''));
  lines.push(call.error ? `(gh : ${call.error}${call.status !== null ? `, code ${call.status}` : ''})` : `(code de sortie ${call.status})`);
  return `${lines.join('\n')}\n`;
}

/** How the head of a pull request stands against its base, in a few words. */
export function freshnessText(f: Freshness | null): string {
  if (!f) return 'base non comparée';
  switch (f.state) {
    case 'up_to_date': return `à jour de ${f.base}`;
    case 'same_content': return `à jour de ${f.base} en contenu (${f.missing} commit(s) de fusion sans changement)`;
    case 'behind': return `EN RETARD sur ${f.base} (${f.missing} commit(s) absent(s) de la tête)`;
    default: return `base ${f.base} non vérifiée`;
  }
}

function planLines(plan: StackPlan): string[] {
  return [`Cible : ${plan.target ?? 'inconnue'}`, ...plan.prs.map((p, i) => {
    const head = p.pr ? `${p.pr.headRefName} -> ${p.pr.baseRefName}${p.pr.isDraft ? ' (brouillon)' : ''}, ${p.pr.mergeable || '?'}/${p.pr.mergeStateStatus || '?'}, contrôles ${p.pr.checks.length ? `${p.pr.checks.filter(c => c.state === 'success').length}/${p.pr.checks.length} au vert` : 'absents'}, ${freshnessText(p.freshness)}` : 'illisible';
    return `${i + 1}. PR #${p.number} : ${head}${p.anomalies.length ? `\n${p.anomalies.map(a => `   ANOMALIE : ${a}`).join('\n')}` : ' : ok'}`;
  })];
}

function numbers(values: string[]): number[] {
  if (!values.length) throw new UsageError('numéros de PR manquants (dans l\'ordre de fusion, de la base vers le sommet)');
  const out = values.map(v => {
    const m = /^#?(\d{1,9})$/.exec(v);
    if (!m || Number(m[1]) === 0) throw new UsageError(`numéro de PR invalide : ${v}`);
    return Number(m[1]);
  });
  if (new Set(out).size !== out.length) throw new UsageError('une PR figure deux fois dans la pile');
  return out;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = value === undefined || value === '' ? NaN : Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Journal of the waivers of `apv stack merge`, relative to the root of the repository (never versioned). */
export const STACK_LOG = `${APV_DIR}/state/stack.log`;

/**
 * Appends one waiver to `.apv/state/stack.log` of the repository the command runs in (its working directory
 * when it is not in one), before the merge it allows. Returns the error when it could not write.
 */
function journal(io: CommandIO, stack: number[], method: string, derogation: Derogation): string | null {
  return journalEntry(io, { event: 'allow-behind', stack, method, ...derogation });
}

/** Appends one JSON line to `.apv/state/stack.log`; returns the error when it could not write. */
function journalEntry(io: CommandIO, entry: Record<string, unknown>): string | null {
  try {
    const root = gitRead(io.cwd, ['rev-parse', '--show-toplevel']) || io.cwd;
    ensureApvGitignore(root);
    mkdirSync(join(root, APV_DIR, 'state'), { recursive: true });
    appendFileSync(join(root, STACK_LOG), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    return null;
  } catch (error) { return errorMessage(error); }
}

/** Lines of the report of `apv stack batch`. */
function batchLines(report: BatchReport): string[] {
  const lines = [`Cible : ${report.target ?? 'inconnue'}${report.base ? ` à ${report.base.slice(0, 12)}` : ''}`];
  for (const p of report.prs) if (p.anomalies.length) lines.push(...p.anomalies.map(a => `ANOMALIE : ${a}`));
  for (const lot of report.lots) {
    lines.push(`Lot ${lot.name} : ${lot.members.map(m => `#${m.number}`).join(', ') || 'vide'}${lot.head ? `, tête ${lot.head.slice(0, 12)}` : ''} : ` +
      `${lot.proof ? `${lot.proof.ok ? 'PROUVÉ' : 'NON PROUVÉ'} (${lot.proof.summary})` : 'non éprouvé'}`);
    for (const x of lot.excluded) lines.push(`  PR #${x.pr} hors du lot : ${x.reason}`);
  }
  if (report.culprits.length) lines.push(`PR fautive(s) isolée(s) par bissection, hors du lot : ${report.culprits.map(n => `#${n}`).join(', ')}`);
  if (report.proven) lines.push(`Lot prouvé : ${report.proven.name} (${report.proven.members.map(m => `#${m.number}`).join(', ')}), tête ${report.proven.head?.slice(0, 12)}.`);
  if (report.merged.length) lines.push(`Fusionnées dans l'ordre du lot : ${report.merged.map(n => `#${n}`).join(', ')}.`);
  if (report.finalTree) lines.push(`Arbre final de ${report.target} ${report.finalTree.identical ? 'identique à' : 'DIFFÉRENT de'} la tête prouvée du lot (${report.finalTree.target.slice(0, 12)} / ${report.finalTree.lot.slice(0, 12)}).`);
  if (report.stopped) lines.push(`ARRÊT${report.stopped.pr ? ` à la PR #${report.stopped.pr}` : ''} :`, ...report.stopped.reasons.map(r => `- ${r}`));
  return lines;
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, {
      method: { type: 'string' }, target: { type: 'string' }, ready: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      'allow-behind': { type: 'boolean' }, reason: { type: 'string' },
      dir: { type: 'string' }, bisect: { type: 'boolean' }, merge: { type: 'boolean' }, keep: { type: 'boolean' },
    });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    const [action, ...rest] = positionals;
    if (action !== 'plan' && action !== 'merge' && action !== 'batch') throw new UsageError(action ? `sous-commande inconnue : stack ${action}` : 'sous-commande manquante (plan, merge ou batch)');
    const prs = numbers(rest);
    const batchOnly = (['dir', 'bisect', 'merge', 'keep'] as const).filter(k => values[k] !== undefined);
    if (action !== 'batch' && batchOnly.length) throw new UsageError(`--${batchOnly.join(', --')} : réservé(s) à stack batch`);
    if (action === 'batch') return batch(prs, values, io);
    if (action === 'plan' && values.method !== undefined) throw new UsageError('--method : réservé à stack merge');
    const method = (values.method ?? 'merge') as typeof METHODS[number];
    if (!(METHODS as readonly string[]).includes(method)) throw new UsageError(`--method invalide : ${values.method} (merge, squash ou rebase)`);
    if (values.target !== undefined && !values.target.trim()) throw new UsageError('--target vide');
    if (values.reason !== undefined && !values['allow-behind']) throw new UsageError('--reason va avec --allow-behind (dérogation à la règle de la base à jour)');
    const reason = values.reason === undefined ? '' : cleanLine(values.reason, MAX_OVERRIDE_REASON + 1);
    if (values['allow-behind'] && (!reason || Array.from(reason).length > MAX_OVERRIDE_REASON)) {
      throw new UsageError(`--allow-behind exige --reason "<raison>" (1 à ${MAX_OVERRIDE_REASON} caractères), journalisée`);
    }
    if (action === 'merge' && io.env['APV_ALLOW_MERGE'] !== '1') { io.stderr(`${MERGE_REFUSED}\n`); return EXIT.usage; }
    const bin = io.env['APV_GH'] || 'gh';
    const calls: GhCall[] = [];
    const options: StackOptions = {
      gh: processGh(bin, io.env, io.cwd), ready: Boolean(values.ready),
      pollMs: positiveInt(io.env['APV_STACK_POLL_MS'], 3000), pollAttempts: positiveInt(io.env['APV_STACK_POLL_ATTEMPTS'], 20),
      onCall: call => {
        calls.push(call);
        // merge: every call in full, as it happens (stderr in JSON mode). plan writes nothing: failed calls only.
        if (action === 'merge' || call.status !== 0 || call.error) (values.json ? io.stderr : io.stdout)(transcript(bin, call));
      },
      ...(values.target !== undefined ? { target: values.target } : {}),
      ...(values['allow-behind'] ? { allowBehind: { reason } } : {}),
      onDerogation: derogation => journal(io, prs, method, derogation),
    };
    if (action === 'plan') {
      const plan = await planStack(prs, options);
      if (values.json) json(io, { ...plan, calls });
      else io.stdout(`${[...planLines(plan), plan.ok ? 'Pile cohérente.' : 'Pile incohérente : corriger avant toute fusion.'].join('\n')}\n`);
      return plan.ok ? EXIT.ok : EXIT.failed;
    }
    const report = await mergeStack(prs, method, options);
    if (values.json) { json(io, { ...report, calls }); return report.stopped ? EXIT.failed : EXIT.ok; }
    const lines = ['', 'Rapport de fusion :', ...planLines(report.plan).map(l => `  ${l}`),
      ...report.freshness.map(f => `Base juste avant la fusion de la PR #${f.pr} : ${freshnessText(f)}`),
      ...report.derogations.map(d => `DÉROGATION (--allow-behind) : PR #${d.pr} admise en retard de ${d.missing ?? '?'} commit(s) sur ${d.base}, ` +
        `journalisée dans ${STACK_LOG} ; raison : ${d.reason}`),
      `Méthode : ${method} ; fusionnées : ${report.merged.length ? report.merged.map(n => `#${n}`).join(', ') : 'aucune'}`];
    if (report.stopped) {
      const left = prs.filter(n => !report.merged.includes(n));
      lines.push(`ARRÊT à la PR #${report.stopped.pr} :`, ...report.stopped.reasons.map(r => `- ${r}`),
        `Non fusionnées : ${left.map(n => `#${n}`).join(', ')}. Rien d'autre n'a été fusionné ; vérifier l'état exact (gh pr view) avant de reprendre.`);
    } else lines.push(`Pile fusionnée dans ${report.target}.`);
    io.stdout(`${lines.join('\n')}\n`);
    return report.stopped ? EXIT.failed : EXIT.ok;
  });
}

type BatchValues = { target?: string | undefined; ready?: boolean | undefined; json?: boolean | undefined; dir?: string | undefined; bisect?: boolean | undefined;
  merge?: boolean | undefined; keep?: boolean | undefined; method?: string | undefined; 'allow-behind'?: boolean | undefined; reason?: string | undefined };

/** `apv stack batch`: one full suite for several independent pull requests, then their merge by content. */
async function batch(prs: number[], values: BatchValues, io: CommandIO): Promise<number> {
  const foreign = (['method', 'allow-behind', 'reason'] as const).filter(k => values[k] !== undefined);
  if (foreign.length) throw new UsageError(`--${foreign.join(', --')} : sans effet pour stack batch (fusion --merge de GitHub seulement, contenu vérifié)`);
  if (values.target !== undefined && !values.target.trim()) throw new UsageError('--target vide');
  if (values.ready && !values.merge) throw new UsageError('--ready va avec --merge');
  if (values.merge && io.env['APV_ALLOW_MERGE'] !== '1') { io.stderr(`${MERGE_REFUSED}\n`); return EXIT.usage; }
  const repo = gitRead(io.cwd, ['rev-parse', '--show-toplevel']);
  if (!repo) throw new PipelineError('NOT_A_REPOSITORY', `Pas un dépôt Git : ${io.cwd}`);
  const bin = io.env['APV_GH'] || 'gh';
  const calls: GhCall[] = [];
  const log = (line: string): void => io.stderr(`${line}\n`);
  const abort = new AbortController();
  let received: NodeJS.Signals | null = null;
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => {
    const handler = (): void => { received ??= signal; abort.abort(); };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  /** The sections of the configuration that decide what proves a batch: the checks, their variables, the stacks, the setup. */
  const checksOf = (config: ApvConfig): string => hash({ gates: config.gates, passEnv: config.environment.passEnv, batch: config.batch ?? null, stacks: config.stacks ?? null, suite: config.suite ?? null });
  const atCommit = (sha: string): { config: ApvConfig } => loadConfigAtCommit(repo, sha);
  // What the pull request changes: its head against its merge base with the target (a target that moved since is not its change).
  const configDrift = (base: string, head: string): string | null => {
    const fork = gitRead(repo, ['merge-base', base, head]);
    if (!fork) return `aucune base commune avec la cible`;
    let before: string;
    try { before = checksOf(atCommit(fork).config); } catch (error) { return `configuration illisible à la base de la PR : ${errorMessage(error)}`; }
    try { return checksOf(atCommit(head).config) === before ? null : 'elle change gates, environment.passEnv, batch, stacks ou suite de .apv/config.json'; }
    catch (error) { return `configuration de la PR illisible : ${errorMessage(error)}`; }
  };
  const prove = async (worktree: string, head: string, base: string): Promise<Proof> => {
    // The checks, the setup and the verification come from the target, never from the batch they prove.
    const loaded = atCommit(base);
    const settings = loaded.config.batch;
    if (settings?.setup) {
      log(`Lot : préparation de la copie (${settings.setup.join(' ')}).`);
      const env = environment([...loaded.config.environment.passEnv, 'HOME', ...settings.passEnv], io.env);
      const r = await runProcess({ command: settings.setup, cwd: worktree, env, timeoutMs: settings.setupTimeoutMs, signal: abort.signal, maxOutputBytes: 256 * 1024 });
      if (r.status !== 'passed') return { ok: false, runId: null, summary: `préparation batch.setup en échec (${r.status}, code ${r.exitCode ?? '-'}) : ${`${r.stdout}\n${r.stderr}`.trim().slice(-800)}` };
    }
    // The target as base: the checks that repeat their changed test files (repeatChanged) repeat those the batch brings.
    const result = await runGates({ repo: worktree, config: loaded.config, stage: 'full', base, env: io.env, log, signal: abort.signal,
      ...(io.env['APV_LOCK_POLL_MS'] ? { hooks: { lockPollMs: Number(io.env['APV_LOCK_POLL_MS']) } } : {}) });
    const verified = await verifyGates({ repo: worktree, config: loaded.config, commit: head, stage: 'full' });
    const passed = result.receipts.filter(success).length;
    const failed = result.receipts.filter(r => !success(r)).map(r => `${r.gateId} (${r.status})`);
    return { ok: result.ok && verified.ok, runId: result.runId,
      summary: `${passed}/${result.receipts.length} contrôle(s) réussi(s)${failed.length ? `, en échec : ${failed.join(', ')}` : ''} ; apv gates verify ${verified.ok ? 'à 0' : 'en échec'} ; exécution ${result.runId}` };
  };
  let report: BatchReport;
  try {
    report = await batchMerge({
      repo, common: commonDir(repo), prs, bisect: values.bisect === true, merge: values.merge === true, ready: values.ready === true, keep: values.keep === true,
      remote: 'origin', gh: processGh(bin, io.env, io.cwd), git: processGit(io.env), log,
      onCall: call => { calls.push(call); if (values.merge || call.status !== 0 || call.error) (values.json ? io.stderr : io.stdout)(transcript(bin, call)); },
      pollMs: positiveInt(io.env['APV_STACK_POLL_MS'], 3000), pollAttempts: positiveInt(io.env['APV_STACK_POLL_ATTEMPTS'], 20),
      prove, configDrift, journal: entry => journalEntry(io, entry), signal: abort.signal,
      ...(values.target !== undefined ? { target: values.target } : {}), ...(values.dir !== undefined ? { dir: resolve(io.cwd, values.dir) } : {}),
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  const partial = !report.stopped && report.left.length > 0;
  const status = report.interrupted ? 'interrompu' : report.stopped ? 'arrêté' : partial ? 'partiel' : values.merge ? 'fusionné' : 'prouvé';
  if (values.json) json(io, { ...report, status, calls });
  else {
    const verdict = report.interrupted ? `Lot interrompu (${received ?? 'signal'}) : rien d'autre ne sera fusionné.\n`
      : report.stopped ? ''
      : partial ? `Lot PARTIEL : ${report.left.map(l => `#${l.pr} (${l.reason})`).join(', ')} hors du lot${values.merge ? ' ; les autres sont fusionnées' : ''}. Les PR laissées se traitent à part.\n`
      : values.merge ? 'Lot fusionné.\n' : 'Lot prouvé : APV_ALLOW_MERGE=1 apv stack batch <mêmes PR> --merge le fusionne, sur ordre de l\'opérateur (une nouvelle suite tourne sur un nouveau lot).\n';
    io.stdout(`${batchLines(report).join('\n')}\n${verdict}`);
  }
  if (received) return signalExitCode(received);
  return report.stopped || partial ? EXIT.failed : EXIT.ok;
}
