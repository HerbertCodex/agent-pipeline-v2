import { relative } from 'node:path';
import { loadConfig } from '../config/load.js';
import { gateStage, gateStages, type GateStage } from '../domain/contracts.js';
import { PipelineError } from '../domain/errors.js';
import { runGates, selectGates } from '../gates/run.js';
import { expectedLevel, findRun, type ExpectedLevel, type RunContext } from '../run/rhythm.js';
import { resolveCommit, gitRoot } from '../run/git-probe.js';
import { MAX_OVERRIDE_REASON, RUN_ID, applyFullSuiteOverride, readRunState, withRunLock, writeRunState } from '../run/state.js';
import { cleanLine } from '../run/summary.js';
import { verifyGates, type EvidenceState, type VerifyResult } from '../gates/verify.js';
import { Git } from '../execution/git.js';
import { EXIT, UsageError, guard, json, list, parse, repoPath, table } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv gates run [--stage task|full] [--only a,b] [--config <fichier>] [--base <ref>]
                [--concurrency N] [--keep-going] [--skip-proven] [--run <spec-id>]
                [--reason <texte>] [--repo <chemin>] [--json]
  apv gates verify --commit <sha> [--stage full|task] [--base <ref>] [--config <fichier>]
                   [--repo <chemin>] [--json]

run : exécute les contrôles déclarés (.apv/config.json, sinon pipeline.v2.json) dans le dépôt :
dépendances, ressources, variables transmises, délais et masquage des secrets respectés.
Écrit un reçu JSON par contrôle dans .apv/receipts/<exécution>/ et affiche un tableau.
--stage task n'exécute que les contrôles de stage task (champ absent : task) ; un contrôle
de stage full qui déclare affected y lance cette commande ciblée à sa place (tests concernés
par les changements, marqués « ciblé », jamais une preuve du contrôle complet) ; les autres
contrôles de stage full sont listés comme réservés à la suite complète, jamais comptés comme
réussis. --stage full (défaut) exécute tout, jamais en ciblé ; si la suite complète est déjà
prouvée sur ce commit exact (apv gates verify à 0, arbre propre), elle le signale avant de la
relancer ; avec --skip-proven, elle ne relance rien dans ce cas et sort en 0 (la preuve reste
celle que vérifie apv gates verify).
Rythme d'une exécution (/apv:run) : dans le cadre d'une exécution, la suite complète (--stage full,
avec au moins un contrôle de stage full) est refusée quand l'étape courante n'attend que les
contrôles de tâche et ciblés (même calcul que apv run next : intégration intermédiaire ou
corrections avec run.fullSuite = final) ; le message donne la commande à lancer à la place.
L'exécution : --run <spec-id>, sinon celle de la branche courante (apv/<id> ou apv/<id>-<suffixe>)
quand le checkout principal a son état .apv/state/run-<id>.json ; aucune : rien ne change.
--reason <texte> (1 à ${MAX_OVERRIDE_REASON} caractères) laisse passer la suite complète : la raison est journalisée
dans l'état de l'exécution et écrite dans les reçus (override).
Sortie : 0 si tous les contrôles exécutés passent, 1 sinon (ou suite complète refusée par le
rythme), 2 appel incorrect.

verify : vérifie dans les reçus que chaque contrôle exigé a réussi sur ce commit exact, arbre
propre, avec la configuration actuelle ; pour chaque contrôle, seul son reçu le plus récent
compte. --stage full (défaut) : tous les contrôles, les reçus ciblés ne comptent jamais.
--stage task : ceux de stage task, plus les contrôles full qui déclarent affected, prouvés par
leur reçu ciblé (ou complet) ; --base <ref> est alors obligatoire (le dernier commit prouvé par
la suite complète) : un reçu ciblé ne compte que si la base de son exécution est ce commit ou
l'un de ses ancêtres.
Sortie : 0 preuve complète, 1 sinon (ce qui manque est listé), 2 appel incorrect.`;

const STATUS: Record<string, string> = { passed: 'réussi', failed: 'échec', timed_out: 'délai dépassé', cancelled: 'annulé',
  spawn_error: 'non lancé', blocked: 'bloqué', cached: 'réutilisé' };
const RESERVED = 'réservé à la suite complète';
const TARGETED = 'ciblé';
const EVIDENCE: Record<EvidenceState, string> = { passed: 'réussi', failed: 'échec', dirty: 'arbre modifié', missing: 'aucun reçu' };

/** Human lines of `apv gates verify`. */
function verifyLines(result: VerifyResult): string[] {
  const what = result.stage === 'full' ? 'suite complète' : result.targeted.length ? 'contrôles de tâche et ciblés' : 'contrôles de tâche';
  const state = (g: VerifyResult['gates'][number]): string => {
    const text = g.state === 'failed' ? `${EVIDENCE.failed} (${STATUS[g.status!] ?? g.status})` : EVIDENCE[g.state];
    return g.proof === 'targeted' ? `${text} (${TARGETED})` : text;
  };
  const lines = [`Vérification (${what}) au commit ${result.commit.slice(0, 12)}${result.base ? ` ; tests ciblés depuis ${result.base.slice(0, 12)}` : ''}`, '',
    table(['contrôle', 'état', 'reçu'], result.gates.map(g => [g.viaTargeted ? `${g.gateId} (${TARGETED})` : g.gateId, state(g),
      g.receipt ? `${g.runId}/${g.gateId}.json` : '-']))];
  const other = result.gates.filter(g => g.otherConfig > 0 && g.state !== 'passed');
  if (other.length) lines.push('', `Reçus ignorés (configuration des contrôles différente) : ${other.map(g => g.gateId).join(', ')}`);
  const targeted = result.gates.filter(g => !g.viaTargeted && g.targeted > 0 && g.state !== 'passed');
  if (targeted.length) lines.push('', `Reçus ciblés ignorés (seule la suite complète prouve ces contrôles) : ${targeted.map(g => g.gateId).join(', ')}`);
  const otherBase = result.gates.filter(g => g.otherBase > 0 && g.state !== 'passed');
  if (otherBase.length) lines.push('', `Reçus ciblés ignorés (leur base ne couvre pas les changements depuis ${result.base?.slice(0, 12)}) : ${otherBase.map(g => g.gateId).join(', ')}`);
  if (result.unreadable.length) lines.push('', `Reçus illisibles ignorés : ${result.unreadable.join(', ')}`);
  const missing = result.gates.filter(g => g.state !== 'passed');
  const rerun = result.stage === 'task' && result.base ? `apv gates run --stage task --base ${result.base.slice(0, 12)}` : `apv gates run --stage ${result.stage}`;
  lines.push('', result.ok
    ? `Preuve complète : ${result.required.length} contrôle(s) réussi(s) sur ce commit, arbre propre${result.stage === 'task' && (result.targeted.length || result.reserved.length) ? ' (niveau tâche : la suite complète reste à passer)' : ''}.`
    : `Preuve incomplète. Manque : ${missing.map(g => `${g.gateId} (${EVIDENCE[g.state]})`).join(', ')}. ` +
      `Relancer : ${rerun} sur ce commit, arbre propre.`);
  return lines;
}

/** The full proof of HEAD when it exists on a clean tree, else null (any refusal of verify counts as « not proven »). */
async function provenFull(repo: string, config: Parameters<typeof verifyGates>[0]['config']): Promise<VerifyResult | null> {
  try {
    const git = new Git();
    const root = await git.root(repo);
    if ((await git.exec(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) !== '') return null;
    const result = await verifyGates({ repo: root, config, commit: 'HEAD', stage: 'full' });
    return result.ok ? result : null;
  } catch { return null; }
}

/** What the rhythm check decided for this run of the gates. */
interface RhythmOutcome {
  context: RunContext | null;
  expected: ExpectedLevel | null;
  /** The reason written in the state and the receipts, when the full suite runs against the expected level. */
  override: { run: string; reason: string } | null;
  notes: string[];
}

/**
 * The rhythm of an execution (/apv:run) applied to a full run: refused when the current step expects the task
 * level only (the level of `apv run next`), unless `reason` is given, journaled in the state of the execution.
 * Outside any execution, or when the level is full or unknown, nothing changes.
 */
async function rhythmCheck(repo: string, explicit: string | undefined, reason: string | undefined, io: CommandIO): Promise<RhythmOutcome> {
  const notes: string[] = [];
  const context = findRun(repo, explicit);
  if (!context) {
    if (reason !== undefined) notes.push('Note : --reason sans effet, aucune exécution trouvée pour cette branche (--run <spec-id> pour en nommer une).');
    return { context, expected: null, override: null, notes };
  }
  let expected: ExpectedLevel;
  try { expected = expectedLevel(context); }
  catch (error) {
    // A state found by the branch but unreadable: said, and the run goes on as outside an execution.
    if (context.source === 'option' || !(error instanceof PipelineError)) throw error;
    notes.push(`Note : rythme de l'exécution ${context.specId} non vérifié, état illisible (${cleanLine(error.message, 300)}).`);
    return { context, expected: null, override: null, notes };
  }
  const { plan, mode, where } = expected;
  if (plan.suite.level !== 'task') {
    if (reason !== undefined) notes.push(`Note : --reason sans effet, l'exécution ${context.specId} (${where}) n'attend pas le seul niveau tâche à cette étape.`);
    return { context, expected, override: null, notes };
  }
  const tb = plan.suite.targetBase.slice(0, 12);
  if (reason === undefined) {
    const found = context.source === 'branch' ? ` (exécution trouvée par la branche ${context.branch} ; --run <spec-id> pour en nommer une autre)` : '';
    throw new PipelineError('GATE_RHYTHM', `Suite complète refusée : l'exécution ${context.specId}${found} en est à l'étape ${where}, run.fullSuite = ${mode}, ` +
      `et le niveau attendu à cette étape est « contrôles de tâche et ciblés » (apv run next ${context.specId}). ` +
      `À lancer à la place : apv gates run --stage task --base ${tb}, puis apv gates verify --commit <tête> --stage task --base ${tb} à 0. ` +
      'La suite complète vient à la dernière intégration et à la livraison. ' +
      'Dérogation motivée seulement : --reason "<raison>" (journalisée dans l\'état de l\'exécution et écrite dans les reçus).');
  }
  const commit = resolveCommit(gitRoot(repo), 'HEAD') ?? undefined;
  await withRunLock(context.specId, io.env, () => {
    const current = readRunState(context.file, { shown: `.apv/state/run-${context.specId}.json`, specId: context.specId });
    writeRunState(context.file, applyFullSuiteOverride(current, { reason, ...(commit ? { commit } : {}) }).state);
  });
  notes.push(cleanLine(`Dérogation au rythme de l'exécution ${context.specId} (${where}, niveau attendu : contrôles de tâche et ciblés), journalisée dans son état : ${reason}`, 700));
  return { context, expected, override: { run: context.specId, reason }, notes };
}

function stageOf(value: string | boolean | undefined): GateStage | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(gateStages as readonly string[]).includes(value)) throw new UsageError(`--stage attend ${gateStages.join(' ou ')}`);
  return value as GateStage;
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, {
      only: { type: 'string' }, config: { type: 'string' }, base: { type: 'string' }, concurrency: { type: 'string' },
      stage: { type: 'string' }, commit: { type: 'string' }, 'skip-proven': { type: 'boolean' }, run: { type: 'string' }, reason: { type: 'string' },
      'keep-going': { type: 'boolean' }, repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    const [action, ...rest] = positionals;
    if (action !== 'run' && action !== 'verify') throw new UsageError(action ? `sous-commande inconnue : gates ${action}` : 'sous-commande manquante');
    if (rest.length) throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
    const stage = stageOf(values.stage);
    if (action === 'verify') {
      const extra = (['only', 'concurrency', 'keep-going', 'skip-proven', 'run', 'reason'] as const).filter(k => values[k] !== undefined);
      if (extra.length) throw new UsageError(`option de gates run seulement : --${extra.join(', --')}`);
      if (!values.commit) throw new UsageError('gates verify attend --commit <sha>');
      if (values.base !== undefined && stage !== 'task') throw new UsageError('gates verify : --base va avec --stage task (base des tests ciblés)');
      const repo = repoPath(io, values.repo);
      const loaded = loadConfig(repo, values.config);
      const result = await verifyGates({ repo, config: loaded.config, commit: values.commit, ...(stage ? { stage } : {}), ...(values.base ? { base: values.base } : {}) });
      if (values.json) {
        json(io, { ok: result.ok, commit: result.commit, stage: result.stage, base: result.base, config: loaded.file, configHash: result.configHash,
          required: result.required, targeted: result.targeted, reserved: result.reserved, gates: result.gates, unreadable: result.unreadable,
          missing: result.gates.filter(g => g.state !== 'passed').map(g => g.gateId) });
      } else {
        io.stdout(`${verifyLines(result).join('\n')}\n`);
      }
      return result.ok ? EXIT.ok : EXIT.failed;
    }
    if (values.commit !== undefined) throw new UsageError('--commit est une option de gates verify');
    const skipProven = values['skip-proven'] === true;
    if (skipProven && (stage === 'task' || values.only !== undefined)) throw new UsageError('--skip-proven va avec la suite complète entière (--stage full, sans --only)');
    if (values.run !== undefined && (!RUN_ID.test(values.run) || values.run.length > 80)) throw new UsageError(`--run : identifiant de spec invalide : ${values.run}`);
    const reason = values.reason?.trim();
    if (values.reason !== undefined && (!reason || reason.length > MAX_OVERRIDE_REASON)) throw new UsageError(`--reason attend un texte de 1 à ${MAX_OVERRIDE_REASON} caractères`);
    if (reason !== undefined && stage === 'task') throw new UsageError('--reason va avec la suite complète (--stage full) : il motive une dérogation au rythme de l\'exécution');
    const concurrency = values.concurrency === undefined ? 3 : Number(values.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new UsageError('--concurrency attend un entier entre 1 et 16');
    const repo = repoPath(io, values.repo);
    const loaded = loadConfig(repo, values.config);
    // The full suite already proven on this exact commit, clean tree: said before a run of several minutes, and
    // with --skip-proven, not run again. The proof is the one `apv gates verify` checks, nothing weaker.
    const proven = stage !== 'task' && values.only === undefined ? await provenFull(repo, loaded.config) : null;
    if (proven && skipProven) {
      if (values.json) json(io, { ok: true, skipped: true, candidateSha: proven.commit, stage: 'full', config: loaded.file, required: proven.required,
        gates: proven.gates.map(g => ({ gate: g.gateId, receipt: `${g.runId}/${g.gateId}.json` })) });
      else io.stdout(`Suite complète déjà prouvée au commit ${proven.commit.slice(0, 12)} (apv gates verify à 0, arbre propre) : ${proven.required.length} contrôle(s), rien n'est relancé (--skip-proven).\n`);
      return EXIT.ok;
    }
    if (proven && !values.json) {
      io.stdout(`Note : la suite complète est déjà prouvée au commit ${proven.commit.slice(0, 12)} (apv gates verify à 0, arbre propre) ; --skip-proven évite de la relancer.\n`);
    }
    // The rhythm of an execution: only a run that executes a check of stage full in full is concerned.
    const full = stage !== 'task' && selectGates(loaded.config.gates, list(values.only)).gates.some(g => gateStage(g) === 'full');
    const rhythm: RhythmOutcome = full ? await rhythmCheck(repo, values.run, reason, io)
      : { context: null, expected: null, override: null, notes: reason !== undefined ? ['Note : --reason sans effet, aucun contrôle de stage full à exécuter.'] : [] };
    if (!values.json && rhythm.notes.length) io.stdout(`${rhythm.notes.join('\n')}\n`);
    const result = await runGates({ repo, config: loaded.config, only: list(values.only), concurrency, failFast: !values['keep-going'], env: io.env,
      ...(values.base ? { base: values.base } : {}), ...(stage ? { stage } : {}), ...(rhythm.override ? { override: rhythm.override } : {}) });
    const rows = result.receipts.map(r => ({ gate: r.gateId, targeted: r.targeted === true, status: r.status, exitCode: r.exitCode,
      durationMs: Math.round(r.durationMs), receipt: r.id, diagnostic: r.diagnostic }));
    const name = (r: { gate: string; targeted: boolean }): string => r.targeted ? `${r.gate} (${TARGETED})` : r.gate;
    if (values.json) {
      json(io, { ok: result.ok, runId: result.runId, candidateSha: result.candidateSha, baseSha: result.baseSha, dirty: result.dirty, alreadyProven: proven !== null,
        stage: result.stage, config: loaded.file, legacyConfig: loaded.legacy, ignoredSections: loaded.ignored, added: result.added,
        reserved: result.reserved, targeted: result.targeted, receiptsDirectory: result.directory, gates: rows,
        rhythm: rhythm.context ? { run: rhythm.context.specId, source: rhythm.context.source, step: rhythm.expected?.plan.step ?? null,
          level: rhythm.expected?.plan.suite.level ?? null, override: rhythm.override } : null, notes: rhythm.notes });
    } else {
      const lines = [`${result.stage === 'task' ? 'Contrôles de tâche (--stage task)' : 'Contrôles'} à ${result.candidateSha.slice(0, 12)} (configuration : ${loaded.file ? relative(result.repo, loaded.file) || loaded.file : 'aucune'}${loaded.legacy ? ', format V2' : ''})`];
      if (result.added.length) lines.push(`Dépendances ajoutées : ${result.added.join(', ')}`);
      if (result.dirty) lines.push('Attention : modifications non commitées présentes ; les reçus décrivent plus que le commit.');
      lines.push('', table(['contrôle', 'statut', 'code', 'durée'], [
        ...rows.map(r => [name(r), STATUS[r.status] ?? r.status, r.exitCode === null ? '-' : String(r.exitCode), `${(r.durationMs / 1000).toFixed(1)} s`]),
        ...result.reserved.map(id => [id, RESERVED, '-', '-'])]));
      for (const r of rows.filter(r => r.diagnostic && r.status !== 'blocked')) lines.push('', `--- ${name(r)} (${STATUS[r.status] ?? r.status}) ---`, r.diagnostic.trimEnd());
      const verdict = !result.ok ? 'Des contrôles échouent.'
        : result.stage === 'task' && !rows.length ? 'Aucun contrôle de tâche à exécuter.'
        : result.stage === 'task' ? 'Tous les contrôles de tâche passent.' : 'Tous les contrôles passent.';
      const reserved = result.reserved.length
        ? ` ${result.reserved.length} contrôle(s) ${RESERVED}, non exécuté(s) : la suite complète (apv gates run --stage full) les vérifie.` : '';
      const targeted = result.targeted.length
        ? ` ${result.targeted.length} contrôle(s) ${TARGETED}(s) (${result.targeted.join(', ')}) : seuls les tests concernés par les changements ont tourné ; la suite complète (apv gates run --stage full) les exécute en entier.` : '';
      lines.push('', `${verdict}${targeted}${reserved} Reçus : ${relative(io.cwd, result.directory) || result.directory}`);
      io.stdout(`${lines.join('\n')}\n`);
    }
    return result.ok ? EXIT.ok : EXIT.failed;
  });
}
