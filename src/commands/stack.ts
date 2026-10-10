import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { APV_DIR, ensureApvGitignore } from '../config/apv-files.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { gitRead } from '../run/git-probe.js';
import { MAX_OVERRIDE_REASON } from '../run/state.js';
import { cleanLine } from '../run/summary.js';
import { CI_POLL_MS, MERGE_REFUSED, mergeStack, planStack, processGh, type Derogation, type Freshness, type GhCall, type GhRunner, type PullRequest, type RulesVerdict, type StackOptions, type StackPlan } from '../stack/github.js';
import { checkMergeRules, rulesLines } from '../rules/check.js';
import { auditLines, auditMerges, writeMergeTrace } from '../rules/merges.js';
import { anchorKey } from '../rules/operator.js';
import { branchProtection } from '../rules/protection.js';
import { batchMerge, processGit, type BatchReport, type DastOutcome, type Proof } from '../stack/batch.js';
import { LockStore, defaultLockDir, type LockOwner } from '../lock/store.js';
import { canonicalPath } from '../domain/paths.js';
import { DAST_SUMMARY, defaultReportDir, runDast } from '../review/dast.js';
import { stackChecks, stackChecksLines, type StackChecks } from '../stack/plan-checks.js';
import { infrastructureAdvice, infrastructureText } from '../gates/infrastructure.js';
import { cleanMergedBranches, cleanupLines, type BranchCleanup } from '../stack/branches.js';
import { loadConfig, loadConfigAtCommit, type ApvConfig } from '../config/load.js';
import { hash } from '../domain/hash.js';
import { runGates } from '../gates/run.js';
import { verifyGates } from '../gates/verify.js';
import { planRepeat } from '../gates/repeat.js';
import { Git } from '../execution/git.js';
import { success } from '../engine/scheduler.js';
import { environment, runProcess } from '../execution/process.js';
import { commonDir } from '../stacks/idle.js';
import { signalExitCode } from '../lock/run.js';
import { resolve } from 'node:path';
import { EXIT, UsageError, guard, json, list, parse } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv stack plan <pr...> [--target <branche>] [--ready] [--allow-behind --reason <texte>] [--json]
  APV_ALLOW_MERGE=1 apv stack merge <pr...> [--method merge|squash|rebase] [--target <branche>] [--ready]
                                   [--allow-behind --reason <texte>] [--keep-branches] [--wait-ci <minutes>] [--json]
  apv stack batch <pr...> [--target <branche>] [--dir <dossier>] [--bisect] [--dast] [--keep] [--stacks <pile>,<pile>]
                          [--wait-ci <minutes>] [--json]
  APV_ALLOW_MERGE=1 apv stack batch <pr...> --merge [--ready] [--target <branche>] [--dir <dossier>] [--bisect] [--dast]
                                   [--keep-branches] [--stacks <pile>,<pile>] [--wait-ci <minutes>]

Pile de PR, de la base vers le sommet (numéros de PR dans l'ordre de fusion).
plan   lit chaque PR (gh pr view) et vérifie la pile : chaque PR ouverte, la base de la PR n+1 est la
       tête de la PR n (la branche cible pour la première), fusionnable, contrôles au vert ou absents,
       et la tête de chaque PR contient la tête actuelle de sa base (gh api .../compare/<tête>...<base>).
       Toutes les anomalies sont listées. Ne modifie rien (la cible et les têtes sont récupérées par git fetch).
       Code de la pile, depuis la cible (configuration de la cible) : pour chaque contrôle qui répète ses tests
       modifiés (repeatChanged), le nombre de fichiers de test ajoutés ou modifiés à chaque étage ; un étage
       au-delà de repeatChanged.maxFiles est signalé avec la coupe proposée (parties prouvées et fusionnées
       l'une après l'autre), une PR seule au-delà est à découper. Une PR qui change la configuration surveillée
       par reuse (sections reuse, map, design.dir, contrôles qui jugent la réutilisation) dans une pile est
       signalée : à fusionner seule d'abord. Une PR au-dessus de la première, sans contrôle alors que la première
       en a, est notée (la CI de la cible peut ne tourner que sur les PR vers elle). Ces signalements ne
       changent pas le code de sortie.
merge  uniquement sur ordre explicite de l'opérateur, avec APV_ALLOW_MERGE=1 devant la commande.
       Refait la vérification juste avant chaque fusion ; une fois la PR précédente fusionnée, re-cible
       la suivante sur la branche cible par l'API REST (gh api -X PATCH repos/<propriétaire>/<dépôt>/pulls/<n>)
       et vérifie la nouvelle base par une relecture, quel que soit le code de sortie ; vérifie que la tête
       contient la cible telle qu'elle est à cet instant ; fusionne avec --match-head-commit ; constate la
       fusion par une relecture ; s'arrête à la première anomalie. Une PR re-ciblée qui n'a aucun contrôle,
       alors que la première PR de la pile (qui visait la cible) en avait, arrête la pile : la CI de la cible ne
       se déclenche que sur les PR vers elle ; la marche est donnée (fusionner origin/<cible> dans la branche,
       sans changement de fichier, pousser sans force, relancer avec --wait-ci).
       La sortie complète de chaque appel gh est affichée (sur la sortie d'erreur avec --json).
Base à jour : une PR dont la tête ne contient pas la tête actuelle de sa base est refusée (ses contrôles
       n'ont pas porté sur le résultat de la fusion), avec la marche à suivre : fusionner la base dans la
       branche (jamais de rebase ni de force-push), repasser au moins les contrôles de tâche sur la nouvelle
       tête, pousser, relancer. Seule tolérance : des commits de fusion de la base qui ne changent aucun
       fichier (la fusion de la PR précédente d'une pile, par --method merge).
--target  branche d'arrivée de la pile (par défaut la base de la première PR).
--ready   retire le statut brouillon (gh pr ready) avant la fusion ; sans lui, un brouillon est une anomalie.
--wait-ci <minutes>  (merge, batch) une PR dont des contrôles sont en cours est relue jusqu'à leur fin, au
       plus ce délai par lecture (1 à 360 minutes, relecture toutes les 30 s) ; sans lui, des contrôles en cours
       sont une anomalie. Un contrôle encore en cours au bout du délai reste une anomalie ; un contrôle en
       échec aussi, jamais attendu.
--allow-behind --reason <texte>  dérogation exceptionnelle : laisse passer une PR en retard sur sa base
       (1 à ${MAX_OVERRIDE_REASON} caractères de raison) ; merge la journalise avant la fusion, dans
       .apv/state/stack.log (une ligne JSON par PR) et dans le rapport. Jamais pour gagner du temps.
batch  fusion par lot de PR indépendantes, chacune vers la cible : lit chaque PR (ouverte, fusionnable,
       contrôles au vert ; brouillon admis), crée la branche apv/lot-<date> depuis origin/<cible> dans un
       worktree (--dir, défaut <répertoire git commun>/apv/lots/), y fusionne la tête de chaque PR dans
       l'ordre (git merge --no-ff, jamais de rebase ; une PR en conflit reste hors du lot), lance batch.setup
       de .apv/config.json (facultatif), UNE suite complète (apv gates run --stage full) puis apv gates verify
       à la tête du lot. C'est la voie normale de fusion dès que deux PR indépendantes sont prêtes (D5, revue du
       pipeline du 2026-10-03 validée par l'opérateur, projet pilote).
       Fichiers générés : un conflit qui ne touche que la carte du code (map.file), .apv/DECISIONS.json ou
       .apv/DECISIONS.md n'exclut pas la PR : le registre est fusionné par union de ses décisions (une décision
       modifiée des deux côtés reste un conflit), le Markdown rendu depuis le registre, la carte régénérée
       (apv map) sur l'arbre fusionné, dans le commit de fusion du lot ; une carte périmée par une fusion sans
       conflit est régénérée de même. Le contrôle code-map de la suite vérifie la carte régénérée.
       --bisect : suite en échec, le lot est coupé en deux, chaque moitié prouvée, jusqu'à
       isoler la ou les PR fautives, qui sortent du lot ; le reste est prouvé une dernière fois.
       --dast : lot prouvé, le scan dynamique déclaré par review.dast (le même que apv dast run) tourne sur la
       tête du lot, dans son worktree, sous son verrou, avant toute fusion (D3 : un scan par lot sur le contenu
       fusionné, jamais après la fusion) ; scan en échec ou non déclaré à la cible : arrêt, rien n'est fusionné.
       --stacks 2 ou --stacks 1,2 : la suite du lot reçoit les piles de test déclarées (section stacks), comme
       apv gates run --stacks : chaque contrôle de pile tourne sur une pile donnée, avec ses variables (envFile,
       env) et sous son verrou ; une seule pile : tous sur elle. Une suite dont tous les échecs sont une panne
       d'infrastructure (variable d'environnement absente, pile injoignable) n'est pas un échec de code : ni
       bissection ni PR fautive, arrêt avec la marche.
       --merge (avec APV_ALLOW_MERGE=1, sur ordre de l'opérateur) : lot prouvé, fusionne ses PR dans l'ordre
       (gh pr merge --merge --match-head-commit), chacune après avoir vérifié sa tête (celle du lot) et que
       l'arbre de la cible est celui du lot avant elle, puis que l'arbre de la cible après elle est celui du
       lot : l'écart dû aux fusions précédentes du lot est toléré, le contenu fusionné est celui prouvé. Une PR
       dont la fusion dans le lot a régénéré des fichiers générés est d'abord mise à jour : la cible (contenu
       du lot avant elle) est fusionnée dans sa branche avec la même régénération, dans un worktree détaché ;
       le commit obtenu doit avoir exactement l'arbre prouvé dans le lot (sinon arrêt, rien n'est poussé), il
       est poussé sans force sur sa branche (jamais depuis un fork, ni sur la cible, la branche par défaut, une
       branche de longue durée de stack.keepBranches, une branche protégée ou la base d'une PR ouverte : arrêt, rien poussé), journalisé
       (batch-refresh), relu par gh pr view, puis fusionné. Sans --dast alors que la cible déclare review.dast,
       le rapport dit « Scan dynamique non lancé (--dast absent) ». À la fin, arbre de la cible identique à la tête prouvée du lot ; toute
       différence arrête tout. Journal : .apv/state/stack.log. --keep garde les worktrees des lots.
Règles avant fusion (docs/REGLES.md) : merge vérifie, juste avant chaque fusion, les règles de apv rules check à
       la tête de la PR contre origin/<cible> (preuve complète au commit, aucun contrôle réussi après relance,
       relectures enregistrées sans constat critique ni haut, captures de fidélité, contrôles de base d'un projet
       web, maquette validée pour chaque écran) et s'arrête au premier refus ; plan les liste ; batch --merge les
       vérifie pour chaque PR avant de construire le lot (la preuve est celle du lot, sans contrôle instable). Aucune
       option ne les lève : seul l'opérateur, par « dérogation <règle> <commit> : <raison> » tapé dans la session.
Branches fusionnées (merge, batch --merge) : après les fusions, la branche de tête de chaque PR fusionnée
       est supprimée sur GitHub (gh api -X DELETE repos/<propriétaire>/<dépôt>/git/refs/heads/<branche>),
       relue juste avant, puis son absence constatée par une relecture. Elle est gardée, avec la raison :
       --keep-branches ; PR venue d'un fork ; dépôt lui-même fork ; branche cible ou par défaut du dépôt ;
       motif de stack.keepBranches (.apv/config.json ; défaut develop, development, release/*, releases/*,
       staging, hotfix/*) ; base ou tête d'une PR encore ouverte, ou déjà base d'une PR (lu par l'API ;
       dans une pile, la PR suivante est re-ciblée avant) ; branche protégée ; tête qui n'est plus le commit
       fusionné ; lot interrompu ou arrêté sur une anomalie. Absente : « absente (404) », sans erreur.
       Un échec de suppression est un avertissement : la fusion reste acquise, le code de sortie ne change
       pas. Une ligne par branche ; si delete_branch_on_merge est faux, la commande qui l'active est donnée
       (gh api -X PATCH repos/<propriétaire>/<dépôt> -F delete_branch_on_merge=true), jamais lancée.
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
  const rules = plan.prs.filter(p => p.rules).map(p => `Règles avant fusion, PR #${p.number} : ${p.rules!.problems.length ? 'REFUSÉES (détail ci-dessus)' : 'respectées'}${p.rules!.notes.length ? ` ; ${p.rules!.notes.join(' ; ')}` : ''}`);
  return [`Cible : ${plan.target ?? 'inconnue'}`, ...plan.prs.map((p, i) => {
    const head = p.pr ? `${p.pr.headRefName} -> ${p.pr.baseRefName}${p.pr.isDraft ? ' (brouillon)' : ''}, ${p.pr.mergeable || '?'}/${p.pr.mergeStateStatus || '?'}, contrôles ${p.pr.checks.length ? `${p.pr.checks.filter(c => c.state === 'success').length}/${p.pr.checks.length} au vert` : 'absents'}, ${freshnessText(p.freshness)}` : 'illisible';
    return `${i + 1}. PR #${p.number} : ${head}${p.anomalies.length ? `\n${p.anomalies.map(a => `   ANOMALIE : ${a}`).join('\n')}` : ' : ok'}` +
      `${p.notes.length ? `\n${p.notes.map(n => `   NOTE : ${n}`).join('\n')}` : ''}`;
  }), ...rules];
}

/**
 * The rules checked before any merge (src/rules/check.ts) for the head of a pull request, against `origin/<target>`, read
 * in the repository the command runs in: its receipts, its review records, the operator's journal. Outside a repository,
 * nothing can be verified: refused.
 */
export function stackRules(cwd: string, remote = 'origin', ciGh: GhRunner | null = null): (pr: PullRequest, target: string) => Promise<RulesVerdict> {
  return async (pr, target) => {
    const repo = gitRead(cwd, ['rev-parse', '--show-toplevel']);
    const head = pr.headRefOid.slice(0, 12);
    if (!repo) return { problems: [`PR #${pr.number} : règles avant fusion non vérifiables hors d'une copie du dépôt (reçus, relectures, journal de l'opérateur) : lancer apv stack depuis le dépôt`], notes: [] };
    // The base of a stacked pull request (the head branch of the one below) may not be fetched yet: its remote branch only.
    if (gitRead(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${target}`]) === null) {
      gitRead(repo, ['fetch', '--no-tags', remote, `+refs/heads/${target}:refs/remotes/${remote}/${target}`]);
    }
    try {
      const report = await checkMergeRules({ repo, commit: pr.headRefOid, target: `${remote}/${target}`, ci: { gh: ciGh } });
      const notes = report.rules.filter(r => r.status === 'waived').map(r => `dérogation de l'opérateur à la règle ${r.rule} (${r.waiver!.at}) : ${r.waiver!.reason}`);
      return { problems: report.ok ? [] : [`PR #${pr.number} : règles avant fusion refusées à ${head} (apv rules check --commit ${head} --target ${remote}/${target}) :`, ...rulesLines(report, '  ').slice(1, -1)], notes };
    } catch (error) {
      return { problems: [`PR #${pr.number} : règles avant fusion non vérifiables à ${head} : ${errorMessage(error)}`], notes: [] };
    }
  };
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

/** `--wait-ci <minutes>`: 1 to 360 whole minutes, in milliseconds; 0 when absent. */
function waitCi(value: string | undefined): number {
  if (value === undefined) return 0;
  const n = Number(value);
  if (!/^\d{1,3}$/.test(value) || !Number.isInteger(n) || n < 1 || n > 360) throw new UsageError(`--wait-ci attend un nombre entier de minutes, de 1 à 360 : ${value}`);
  return n * 60_000;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = value === undefined || value === '' ? NaN : Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Writes the signed trace of a merge (`apv audit merges`); returns the error when it could not. */
function traceMerge(cwd: string, merge: { pr: number; head: string; target: string; method: string; mergeCommit: string | null; commits?: number }): string | null {
  try {
    const root = gitRead(cwd, ['rev-parse', '--show-toplevel']);
    if (!root) return 'pas un dépôt Git';
    const common = commonDir(root);
    const anchor = anchorKey(common);
    if (!anchor.key) return anchor.problem ?? 'clé d\'ancrage absente';
    writeMergeTrace(common, { ...merge, at: new Date().toISOString() }, anchor.key);
    return null;
  } catch (error) { return errorMessage(error); }
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
    for (const m of lot.members) if (m.regenerated.length) lines.push(`  PR #${m.number} : fichiers générés régénérés dans le lot : ${m.regenerated.join(', ')}`);
    for (const x of lot.excluded) lines.push(`  PR #${x.pr} hors du lot : ${x.reason}`);
    if (lot.dast) lines.push(`  Scan dynamique du lot : ${lot.dast.ok ? 'terminé à 0' : 'NON PASSÉ'} (${lot.dast.summary})${lot.dast.reportDir ? ` ; rapports : ${lot.dast.reportDir}` : ''}`);
  }
  for (const r of report.refreshed) lines.push(`Branche ${r.branch} (PR #${r.pr}) mise à jour avant sa fusion : ${r.from.slice(0, 12)} vers ${r.to.slice(0, 12)} (${r.files.join(', ')}).`);
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
      dir: { type: 'string' }, bisect: { type: 'boolean' }, merge: { type: 'boolean' }, keep: { type: 'boolean' }, 'keep-branches': { type: 'boolean' },
      stacks: { type: 'string' }, 'wait-ci': { type: 'string' }, dast: { type: 'boolean' },
    });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    const [action, ...rest] = positionals;
    if (action !== 'plan' && action !== 'merge' && action !== 'batch') throw new UsageError(action ? `sous-commande inconnue : stack ${action}` : 'sous-commande manquante (plan, merge ou batch)');
    const prs = numbers(rest);
    const batchOnly = (['dir', 'bisect', 'merge', 'keep', 'stacks', 'dast'] as const).filter(k => values[k] !== undefined);
    if (action !== 'batch' && batchOnly.length) throw new UsageError(`--${batchOnly.join(', --')} : réservé(s) à stack batch`);
    if (action === 'plan' && values['keep-branches'] !== undefined) throw new UsageError('--keep-branches : réservé à stack merge et stack batch --merge');
    if (action === 'plan' && values['wait-ci'] !== undefined) throw new UsageError('--wait-ci : réservé à stack merge et stack batch');
    const ciWaitMs = waitCi(values['wait-ci']);
    const ciPollMs = positiveInt(io.env['APV_STACK_CI_POLL_MS'], CI_POLL_MS) || CI_POLL_MS;
    if (action === 'batch') return batch(prs, values, io, { ciWaitMs, ciPollMs });
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
      ciWaitMs, ciPollMs, log: line => io.stderr(`${line}\n`),
      // The proof by the CI is read with `gh` itself, never APV_GH (src/commands/rules.ts).
      rules: stackRules(io.cwd, 'origin', processGh('gh', io.env, io.cwd)),
      onMerged: merge => traceMerge(io.cwd, merge),
    };
    if (action === 'plan') {
      const plan = await planStack(prs, options);
      const checks = await codeOfStack(io, plan);
      if (values.json) json(io, { ...plan, checks, calls });
      else io.stdout(`${[...planLines(plan), ...(checks ? stackChecksLines(checks, prs.length) : []),
        plan.ok ? 'Pile cohérente.' : 'Pile incohérente : corriger avant toute fusion.'].join('\n')}\n`);
      return plan.ok ? EXIT.ok : EXIT.failed;
    }
    const report = await mergeStack(prs, method, options);
    // Said once, at the head of the report: the branch protection on GitHub and the merges made outside the tool.
    const root = gitRead(io.cwd, ['rev-parse', '--show-toplevel']);
    const protection = root ? await branchProtection(root, processGh(bin, io.env, io.cwd)) : null;
    const audit = root && report.target ? auditMerges(root, commonDir(root), `origin/${report.target}`) : null;
    // After the merges (and the retarget of each next PR of the stack), the merged branches; a failure never fails the merge.
    const cleanup = await branchCleanup(io, report.mergedHeads, report.target, values['keep-branches'] ? '--keep-branches' : null,
      async args => { const call = await options.gh(args); options.onCall(call); return call; });
    if (values.json) { json(io, { ...report, protection, audit, cleanup, calls }); return report.stopped ? EXIT.failed : EXIT.ok; }
    const lines = ['', 'Rapport de fusion :', ...(protection ? [`Protection de branche : ${protection.message}.`] : []), ...(audit ? auditLines(audit) : []),
      ...planLines(report.plan).map(l => `  ${l}`), ...report.traceErrors.map(e => `ATTENTION : ${e}`),
      ...report.freshness.map(f => `Base juste avant la fusion de la PR #${f.pr} : ${freshnessText(f)}`),
      ...report.derogations.map(d => `DÉROGATION (--allow-behind) : PR #${d.pr} admise en retard de ${d.missing ?? '?'} commit(s) sur ${d.base}, ` +
        `journalisée dans ${STACK_LOG} ; raison : ${d.reason}`),
      ...report.rules.filter(r => !r.problems.length).map(r => `Règles avant la fusion de la PR #${r.pr} : respectées${r.notes.length ? ` ; ${r.notes.join(' ; ')}` : ''}`),
      `Méthode : ${method} ; fusionnées : ${report.merged.length ? report.merged.map(n => `#${n}`).join(', ') : 'aucune'}`];
    if (report.stopped) {
      const left = prs.filter(n => !report.merged.includes(n));
      lines.push(`ARRÊT à la PR #${report.stopped.pr} :`, ...report.stopped.reasons.map(r => `- ${r}`),
        `Non fusionnées : ${left.map(n => `#${n}`).join(', ')}. Rien d'autre n'a été fusionné ; vérifier l'état exact (gh pr view) avant de reprendre.`);
    } else lines.push(`Pile fusionnée dans ${report.target}.`);
    lines.push(...cleanupLines(cleanup));
    io.stdout(`${lines.join('\n')}\n`);
    return report.stopped ? EXIT.failed : EXIT.ok;
  });
}

/**
 * The code of the stack (src/stack/plan-checks.ts): changed test files per stage and watched configuration, read from
 * the checkout the command runs in; null when every pull request could not be read (the plan already says why).
 */
async function codeOfStack(io: CommandIO, plan: StackPlan): Promise<StackChecks | null> {
  if (!plan.target || plan.prs.some(p => !p.pr?.headRefOid)) return null;
  const repo = gitRead(io.cwd, ['rev-parse', '--show-toplevel']);
  if (!repo) return { read: false, error: `pas un dépôt Git : ${io.cwd}`, gates: [], stages: [], parts: [], alone: [], reuseConfig: [] };
  return stackChecks({ repo, git: processGit(io.env), remote: 'origin', target: plan.target, prs: plan.prs.map(p => ({ number: p.number, head: p.pr!.headRefOid })) });
}

/** The cleanup of the merged branches (src/stack/branches.ts); nothing to do, nothing called, when nothing was merged. */
async function branchCleanup(io: CommandIO, merged: Parameters<typeof cleanMergedBranches>[0], target: string | null, keep: string | null,
  run: (args: string[]) => Promise<GhCall>): Promise<BranchCleanup> {
  if (!merged.length) return { branches: [], repositories: [] };
  // The long-lived branches named by `stack.keepBranches` of the checkout; an unreadable configuration keeps every branch.
  let keepPatterns: string[] | undefined;
  try { keepPatterns = loadConfig(gitRead(io.cwd, ['rev-parse', '--show-toplevel']) || io.cwd).config.stack?.keepBranches; }
  catch (error) { keep ??= `configuration illisible, stack.keepBranches inconnu (${cleanLine(errorMessage(error), 300)})`; }
  try { return await cleanMergedBranches(merged, { run, target, keep, ...(keepPatterns ? { keepPatterns } : {}) }); }
  catch (error) {
    // Never a crash after a merge: every branch left is said, as a warning.
    return { branches: merged.map(m => ({ pr: m.pr, branch: m.branch, head: m.head, status: 'failed' as const, reason: `erreur inattendue : ${errorMessage(error)}` })), repositories: [] };
  }
}

type BatchValues = { target?: string | undefined; ready?: boolean | undefined; json?: boolean | undefined; dir?: string | undefined; bisect?: boolean | undefined;
  merge?: boolean | undefined; keep?: boolean | undefined; 'keep-branches'?: boolean | undefined; method?: string | undefined; 'allow-behind'?: boolean | undefined; reason?: string | undefined;
  stacks?: string | undefined; dast?: boolean | undefined };

const DAST_TEXT: Record<string, string> = { passed: 'terminé à 0', failed: 'en échec', timed_out: 'arrêté au délai (review.dast.timeoutMs)', lock_timeout: 'non lancé : verrou non obtenu' };

/** `apv stack batch`: one full suite for several independent pull requests, then their merge by content. */
async function batch(prs: number[], values: BatchValues, io: CommandIO, ci: { ciWaitMs: number; ciPollMs: number }): Promise<number> {
  const foreign = (['method', 'allow-behind', 'reason'] as const).filter(k => values[k] !== undefined);
  if (foreign.length) throw new UsageError(`--${foreign.join(', --')} : sans effet pour stack batch (fusion --merge de GitHub seulement, contenu vérifié)`);
  if (values.target !== undefined && !values.target.trim()) throw new UsageError('--target vide');
  if (values.ready && !values.merge) throw new UsageError('--ready va avec --merge');
  if (values['keep-branches'] && !values.merge) throw new UsageError('--keep-branches va avec --merge');
  if (values.merge && io.env['APV_ALLOW_MERGE'] !== '1') { io.stderr(`${MERGE_REFUSED}\n`); return EXIT.usage; }
  const repo = gitRead(io.cwd, ['rev-parse', '--show-toplevel']);
  if (!repo) throw new PipelineError('NOT_A_REPOSITORY', `Pas un dépôt Git : ${io.cwd}`);
  // The test stacks of the suite: checked against the stacks the checkout declares before anything is built.
  const stacks = values.stacks === undefined ? undefined : list(values.stacks);
  if (stacks !== undefined) {
    if (!stacks.length || new Set(stacks).size !== stacks.length) throw new UsageError('--stacks attend une ou plusieurs piles différentes, par exemple --stacks 2 ou --stacks 1,2');
    let declared: string[];
    try { declared = (loadConfig(repo).config.stacks ?? []).map(x => x.id); } catch (error) { throw new UsageError(`--stacks : configuration illisible (${cleanLine(errorMessage(error), 300)})`); }
    const unknown = stacks.filter(id => !declared.includes(id));
    if (unknown.length) throw new UsageError(`--stacks : pile inconnue ${unknown.join(', ')} (déclarées : ${declared.join(', ') || 'aucune'}, section stacks de .apv/config.json)`);
  }
  // --dast: the scan the checkout declares; the one of the target decides at the proof (configuration of the target).
  if (values.dast) {
    let declared: boolean;
    try { declared = loadConfig(repo).config.review?.dast !== undefined; } catch (error) { throw new UsageError(`--dast : configuration illisible (${cleanLine(errorMessage(error), 300)})`); }
    if (!declared) throw new UsageError('--dast : aucun scan dynamique déclaré (review.dast de .apv/config.json) ; la revue sécurité note le scan « non vérifié : non déclaré par le projet »');
  }
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
  // The ceilings of repeatChanged in the checks of the target, applied to the test files each pull request changes.
  const repeatRefusal = async (base: string, head: string): Promise<string | null> => {
    let config: ApvConfig;
    try { config = atCommit(base).config; } catch (error) { return `configuration de la cible illisible : ${errorMessage(error)}`; }
    const reasons: string[] = [];
    for (const gate of config.gates) {
      const settings = gate.repeatChanged;
      if (!settings) continue;
      const plan = await planRepeat(new Git(abort.signal), repo, { base }, settings, head);
      if (plan.files.length > settings.maxFiles) reasons.push(`${gate.id} : ${plan.files.length} fichier(s) de test ajouté(s) ou modifié(s), au-delà de repeatChanged.maxFiles (${settings.maxFiles})`);
      const optionLike = plan.files.find(f => f.startsWith('-'));
      if (optionLike) reasons.push(`${gate.id} : fichier ${optionLike} qui commence par « - »`);
      if (settings.fixedWaits === 'refuse' && plan.fixedWaits.length) reasons.push(`${gate.id} : attente(s) à durée fixe refusée(s) (${plan.fixedWaits.slice(0, 5).map(w => `${w.file}:${w.line}`).join(', ')})`);
    }
    return reasons.length ? reasons.join(' ; ') : null;
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
    // The target as base and reference: the checks that repeat their changed test files (repeatChanged) repeat those the
    // batch brings; their ceiling of files was applied pull request by pull request (repeatRefusal), never to the sum.
    let result: Awaited<ReturnType<typeof runGates>>;
    try {
      // The target is also the reference of the scope of the proof (skipWhenOnly): its paths, its merge base with the batch.
      result = await runGates({ repo: worktree, config: loaded.config, stage: 'full', base, repeatReference: base, reference: base, repeatCeiling: false, env: io.env, log, signal: abort.signal,
        ...(stacks ? { stacks } : {}), ...(io.env['APV_LOCK_POLL_MS'] || io.env['APV_PORTS_POLL_MS'] ? { hooks: {
          ...(io.env['APV_LOCK_POLL_MS'] ? { lockPollMs: Number(io.env['APV_LOCK_POLL_MS']) } : {}), ...(io.env['APV_PORTS_POLL_MS'] ? { portsPollMs: Number(io.env['APV_PORTS_POLL_MS']) } : {}) } } : {}) });
    } catch (error) {
      // Refused before it ran (repetition ceiling, stacks the target does not declare or cannot give): nothing about the code.
      if (error instanceof PipelineError && ['GATE_REPEAT', 'GATE_STACKS', 'STACK_UNKNOWN'].includes(error.code)) {
        return { ok: false, runId: null, summary: `suite refusée : ${cleanLine(error.message, 600)}`, refused: cleanLine(error.message, 600) };
      }
      throw error;
    }
    const verified = await verifyGates({ repo: worktree, config: loaded.config, commit: head, stage: 'full', repeatReference: base, reference: base });
    const passed = result.receipts.filter(success).length;
    const notRequired = result.receipts.filter(r => r.status === 'not_required').map(r => r.gateId);
    const failed = result.receipts.filter(r => !success(r) && r.status !== 'not_required').map(r => `${r.gateId} (${r.status})`);
    // A check passed only after the relaunch of its failed tests proves nothing for a merge (rule instable).
    if (verified.flaky.length || result.flaky.length) {
      const flaky = [...new Set([...verified.flaky, ...result.flaky])];
      return { ok: false, runId: result.runId, summary: `réussi(s) seulement après relance : ${flaky.join(', ')} ; règle instable : examiner le test comme un bug possible du produit, corriger, relancer ; exécution ${result.runId}` };
    }
    // Failures of the infrastructure (a variable absent, a stack unreachable) are said apart; all of them: not the code.
    const infra = result.infrastructure;
    const infraText = infra.causes.length ? ` ; panne d'infrastructure probable : ${infra.causes.map(infrastructureText).join(' ; ')}` : '';
    const ok = result.ok && verified.ok;
    return { ok, runId: result.runId,
      summary: `${passed}/${result.receipts.length} contrôle(s) réussi(s)${notRequired.length ? `, non requis par leur portée : ${notRequired.join(', ')}` : ''}${failed.length ? `, en échec : ${failed.join(', ')}` : ''}${infraText} ; apv gates verify ${verified.ok ? 'à 0' : 'en échec'} ; exécution ${result.runId}`,
      ...(!ok && infra.all ? { infrastructure: `${infra.causes.map(infrastructureText).join(' ; ')} ; ${infrastructureAdvice(infra.causes, stacks ? [] : (loaded.config.stacks ?? []).map(x => x.id))}` } : {}) };
  };
  /** `--dast`: `apv dast run` on the worktree of the proven batch, with the scan the target declares, under its lease. */
  const dast = async (worktree: string, head: string, base: string): Promise<DastOutcome> => {
    const settings = atCommit(base).config.review?.dast;
    if (!settings) return { ok: false, status: 'undeclared', reportDir: null, summary: `aucun scan dynamique déclaré à la cible (review.dast de .apv/config.json à ${base.slice(0, 12)})` };
    const reportDir = canonicalPath(defaultReportDir(worktree, head, new Date()));
    const poll = io.env['APV_LOCK_POLL_MS'] ? Number(io.env['APV_LOCK_POLL_MS']) : undefined;
    const store = new LockStore(defaultLockDir(io.env), poll && Number.isFinite(poll) ? { pollMs: poll } : {});
    const owner: LockOwner = { pid: process.pid, host: store.host, label: io.env['APV_LOCK_LABEL'] || io.env['USER'] || 'apv stack batch' };
    const clean = gitRead(worktree, ['status', '--porcelain', '--untracked-files=no']) === '';
    log(`Lot : scan dynamique du commit ${head.slice(0, 12)} dans ${worktree}, sous le verrou « ${settings.resource} » ; rapports : ${reportDir}`);
    const summary = await runDast({ repo: worktree, commit: head, clean, reportDir, settings, env: io.env, stderr: io.stderr, store, owner, waitSeconds: 1800 });
    return { ok: summary.status === 'passed', status: summary.status, reportDir,
      summary: `scan dynamique ${DAST_TEXT[summary.status] ?? summary.status} (code ${summary.exitCode}) en ${Math.round(summary.durationMs / 1000)} s ; résumé : ${reportDir}/${DAST_SUMMARY}` };
  };
  // The long-lived branches of the checkout (`stack.keepBranches`): never updated by the batch; unreadable: the defaults.
  let keepPatterns: string[] | undefined;
  try { keepPatterns = loadConfig(repo).config.stack?.keepBranches; } catch { keepPatterns = undefined; }
  let report: BatchReport;
  const gh = processGh(bin, io.env, io.cwd);
  const onCall = (call: GhCall): void => { calls.push(call); if (values.merge || call.status !== 0 || call.error) (values.json ? io.stderr : io.stdout)(transcript(bin, call)); };
  try {
    report = await batchMerge({
      repo, common: commonDir(repo), prs, bisect: values.bisect === true, merge: values.merge === true, ready: values.ready === true, keep: values.keep === true,
      remote: 'origin', gh, git: processGit(io.env), log, onCall,
      pollMs: positiveInt(io.env['APV_STACK_POLL_MS'], 3000), pollAttempts: positiveInt(io.env['APV_STACK_POLL_ATTEMPTS'], 20), ...ci,
      prove, configDrift, repeatRefusal, signal: abort.signal, ...(values.dast ? { dast } : {}), ...(keepPatterns ? { keepPatterns } : {}),
      journal: entry => {
        // Each merge of a batch leaves its signed trace, its merge commit being the target just after it.
        if (entry['event'] === 'batch-merge' && typeof entry['pr'] === 'number' && typeof entry['head'] === 'string') {
          const failed = traceMerge(io.cwd, { pr: entry['pr'], head: entry['head'], target: String(entry['target'] ?? ''), method: 'merge',
            mergeCommit: typeof entry['targetAfter'] === 'string' ? entry['targetAfter'] : null });
          if (failed) return `trace de fusion non écrite : ${failed}`;
        }
        return journalEntry(io, entry);
      },
      rules: async (head, target) => {
        try {
          const r = await checkMergeRules({ repo, commit: head, target: `origin/${target}`, skip: ['preuve', 'instable'] });
          return r.ok ? [] : rulesLines(r, '  ').slice(1, -1);
        } catch (error) { return [`règles avant fusion non vérifiables à ${head.slice(0, 12)} : ${errorMessage(error)}`]; }
      },
      ...(values.target !== undefined ? { target: values.target } : {}), ...(values.dir !== undefined ? { dir: resolve(io.cwd, values.dir) } : {}),
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  // An interrupted batch does nothing more, and a batch stopped by an anomaly (after a merge: content of the target
  // different from the proven batch, journal not written) is left as it is to be examined: its merged branches stay.
  const keep = report.interrupted || received ? 'lot interrompu (signal) : rien d\'autre n\'est fait'
    : report.stopped ? 'lot arrêté sur une anomalie : branches gardées pour l\'examen' : values['keep-branches'] ? '--keep-branches' : null;
  const cleanup = await branchCleanup(io, report.mergedHeads, report.target, keep, async args => { const call = await gh(args); onCall(call); return call; });
  const partial = !report.stopped && report.left.length > 0;
  const status = report.interrupted ? 'interrompu' : report.stopped ? 'arrêté' : partial ? 'partiel' : values.merge ? 'fusionné' : 'prouvé';
  // The scan the target declares and this batch did not run (`--dast` absent): said, so that a merge without it is a choice.
  let dastSkipped = false;
  if (!values.dast && report.base) { try { dastSkipped = atCommit(report.base).config.review?.dast !== undefined; } catch { dastSkipped = false; } }
  const skippedLine = dastSkipped ? `Scan dynamique non lancé (--dast absent) alors que la cible déclare review.dast${values.merge ? ' : PR fusionnées sans scan du lot ; le scan par PR (apv dast run) reste dû avant la fusion' : ''}.` : null;
  if (values.json) json(io, { ...report, status, dastSkipped, cleanup, calls });
  else {
    const verdict = report.interrupted ? `Lot interrompu (${received ?? 'signal'}) : rien d'autre ne sera fusionné.\n`
      : report.stopped ? ''
      : partial ? `Lot PARTIEL : ${report.left.map(l => `#${l.pr} (${l.reason})`).join(', ')} hors du lot${values.merge ? ' ; les autres sont fusionnées' : ''}. Les PR laissées se traitent à part.\n`
      : values.merge ? 'Lot fusionné.\n' : `Lot prouvé${report.proven?.dast?.ok ? ' et scanné' : ''} : APV_ALLOW_MERGE=1 apv stack batch <mêmes PR> --merge${values.dast ? ' --dast' : ''} le fusionne, sur ordre de l'opérateur (une nouvelle suite tourne sur un nouveau lot).\n`;
    io.stdout(`${[...batchLines(report), ...(skippedLine ? [skippedLine] : []), ...cleanupLines(cleanup)].join('\n')}\n${verdict}`);
  }
  if (received) return signalExitCode(received);
  return report.stopped || partial ? EXIT.failed : EXIT.ok;
}
