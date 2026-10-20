import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { loadConfig, loadConfigAtCommit, suiteSettings, type ApvConfig } from '../config/load.js';
import { enforceBaseGates } from '../gates/base-gates.js';
import { runGates, type ReusedCheck } from '../gates/run.js';
import { pickStacks as pickFresh, withFreshCopy } from '../gates/fresh-copy.js';
import { prepareMainCopy } from '../gates/spread.js';
import { classifyUnstable, writeFindings, type UnstableTest, type UnstableVerdict } from '../release/unstable.js';
import { verifyGates, type VerifyResult } from '../gates/verify.js';
import { LockStore } from '../lock/store.js';
import type { ReleaseSettings } from '../release/config.js';
import { migrationLines, pendingReason, refusedReason, releaseMigrations, type Migrations } from '../release/migrations.js';
import { gitRoot, resolveCommit } from '../run/git-probe.js';
import { infrastructureAdvice, infrastructureText, type InfrastructureCause } from '../gates/infrastructure.js';
import { commonDir } from '../stacks/idle.js';
import { journalEntry } from './stack.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv release [<sha>] [--dry-run] [--json] [--repo <chemin>]
  apv release auto [--stacks <pile>[,<pile>]] [--force-retry] [--dry-run] [--json] [--repo <chemin>]

Mise en ligne découplée de la fusion (section release de .apv/config.json, lue sur la branche from distante) :
la branche de production (release.branch) n'avance qu'en avance rapide vers un commit de release.from dont la
suite complète est prouvée au commit exact (apv gates verify --commit <sha>, instable refusé).
<sha> (défaut : tête distante de from) doit être un ancêtre de cette tête, et la production distante un ancêtre
de <sha> (jamais de retour en arrière, jamais de force). Puis git push origin <sha>:refs/heads/<branch>, sortie
affichée, branche distante relue. --dry-run vérifie tout et ne pousse rien.
release.migrations (motifs) : chaque migration ajoutée depuis la production attend « migration <version> appliquée » tapé
par l'opérateur dans une session Claude Code (journal de l'opérateur) ; une migration publiée modifiée est refusée.
Motifs : ceux de la production, de <sha> et de from réunis (un commit qui les vide ou les change n'en retire aucun).
auto : pour un lancement périodique (cron) ; rien à publier : 0 ; reçus rouges à ce commit : 1 sans relancer ; migration
en attente : 0, rien lancé ; sinon suite complète dans la copie neuve de l'arbre (<répertoire git commun>/apv/fresh/<arbre>,
préparée par batch.setup, la même que apv gates run --fresh-copy), sans attendre la file des suites (occupée : 0, plus tard) :
un contrôle dont un reçu vert d'un arbre identique se vérifie (même configuration, même environnement normalisé, moins de
20 h : la suite de la branche) est repris sans relancer, le journal dit lequel ; les tests modifiés déjà répétés au même
contenu sur leur branche ne sont pas répétés de nouveau (crédit de répétition). Puis publie si elle est verte.
Test instable (réussi seulement après relance) : bloquant s'il est ajouté ou modifié depuis la production, ou concerné par
le changement (affectedList du contrôle, lu à la production) ; sinon publié quand même, et écrit comme constat (journal,
.apv/state/suivi-constats.md) avec son nom et son taux d'échec.
Section stacks déclarée : la suite reçoit une pile comme apv gates run --stacks (la première dont le verrou est libre, ou --stacks pour
forcer) ; aucune libre : 0, piles occupées, plus tard. Panne d'infrastructure (variable absente, pile injoignable) : dite comme telle, 1.
Même commit déjà tenté, lu dans ses reçus seuls (magasin vérifié comme apv gates verify) : échec de code : 1, jamais relancé,
--force-retry compris (seul un nouveau commit débloque) ; instable : jugé comme ci-dessus, jamais relancé ; échecs tous en panne d'infrastructure : nouvel essai
30 min après leurs reçus au plus tôt, --force-retry relance tout de suite.
Hors --dry-run : APV_ALLOW_MERGE=1 devant la commande (ordre de l'opérateur, ou son cron).
Les contrôles de la branche de production sont toujours gardés (comme les contrôles de la base à la fusion).
Historique : .apv/state/stack.log (event release). Sortie : 0 publié ou rien à faire, 1 refus, 2 appel incorrect.`;

const REMOTE = 'origin';
export const RELEASE_REFUSED = "APV : mise en ligne refusée sans APV_ALLOW_MERGE=1 devant la commande. Elle se fait seulement sur ordre " +
  "de l'opérateur ou délégation écrite (APV_ALLOW_MERGE=1 apv release <sha>), ou par son cron (APV_ALLOW_MERGE=1 apv release auto) ; --dry-run reste libre.";
const short = (sha: string | null): string => sha ? sha.slice(0, 12) : 'absente';

interface Git { status: number; stdout: string; stderr: string }
function git(repo: string, args: string[]): Git {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 300_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? errorMessage(r.error) : '') };
}
const isAncestor = (repo: string, a: string, b: string): boolean => git(repo, ['merge-base', '--is-ancestor', a, b]).status === 0;

/** The remote heads of `from` and `branch` (ls-remote), `from` fetched; the settings must be those committed on `from`. */
function remoteState(repo: string): { settings: ReleaseSettings; fromHead: string; production: string | null } {
  const local = loadConfig(repo).config.release;
  if (!local) throw new PipelineError('RELEASE', 'section release absente de .apv/config.json : la mise en ligne découplée n\'est pas déclarée');
  const listed = git(repo, ['ls-remote', REMOTE, `refs/heads/${local.from}`, `refs/heads/${local.branch}`]);
  if (listed.status !== 0) throw new PipelineError('RELEASE', `git ls-remote ${REMOTE} en échec : ${listed.stderr.trim()}`);
  const heads = new Map(listed.stdout.split('\n').filter(Boolean).map(l => { const [sha, ref] = l.split('\t'); return [ref!, sha!] as const; }));
  const fromHead = heads.get(`refs/heads/${local.from}`);
  if (!fromHead) throw new PipelineError('RELEASE', `branche distante ${REMOTE}/${local.from} absente`);
  const fetched = git(repo, ['fetch', '--no-tags', REMOTE, `+refs/heads/${local.from}:refs/remotes/${REMOTE}/${local.from}`]);
  if (fetched.status !== 0) throw new PipelineError('RELEASE', `git fetch ${REMOTE} ${local.from} en échec : ${fetched.stderr.trim()}`);
  const published = loadConfigAtCommit(repo, fromHead).config.release;
  if (!published || published.branch !== local.branch || published.from !== local.from) {
    throw new PipelineError('RELEASE', `section release de ${REMOTE}/${local.from} (${short(fromHead)}) ${published ? `différente (${published.from} vers ${published.branch})` : 'absente'} : seule la configuration de ${local.from} fait foi`);
  }
  return { settings: published, fromHead, production: heads.get(`refs/heads/${local.branch}`) ?? null };
}

/** The checks of `sha` with those of the production kept (a change never weakens what production was proven with). */
const proofConfig = (repo: string, sha: string, production: string): ApvConfig =>
  enforceBaseGates(loadConfigAtCommit(repo, sha).config, loadConfigAtCommit(repo, production).config).config;

async function fullProof(repo: string, sha: string, from: string, production: string): Promise<VerifyResult> {
  return verifyGates({ repo, config: proofConfig(repo, sha, production), commit: sha, stage: 'full', configFile: null, reuseReference: `refs/remotes/${REMOTE}/${from}`, repeatCredits: true });
}
const proofLines = (proof: VerifyResult): string[] => proof.gates.filter(g => g.state !== 'passed').map(g => `${g.gateId} (${g.state})`);

/** A check the release took from a green receipt of an identical tree (the suite of the branch), without running it. */
interface Reused { gateId: string; fromRun: string; fromCommit: string; origin: string }
interface Outcome { ok: boolean; published: boolean; sha: string | null; branch: string; from: string; previous: string | null; migrations: Migrations | null; lines: string[]; push?: Git;
  reused?: Reused[]; unstable?: UnstableTest[] }
/** What a release of `sha` brings with it: the copy where its suite ran (for affectedList), the checks it reused, the output. */
interface ReleaseContext { io: CommandIO; copy?: string; reused?: readonly ReusedCheck[] }

/**
 * The verdict on the unstable checks of a proof (src/release/unstable.ts): in the copy of the suite when there is one, else in a
 * fresh copy of the commit prepared by batch.setup (the affectedList commands run the tools of the project); busy: blocking.
 */
async function judgeUnstable(ctx: ReleaseContext, repo: string, sha: string, production: string, proof: VerifyResult): Promise<UnstableVerdict> {
  const config = proofConfig(repo, sha, production);
  const log = (line: string): void => ctx.io.stderr(`${line}\n`);
  const judge = (copy: string): Promise<UnstableVerdict> => classifyUnstable({ repo, copy, commit: sha, production, config, proof, env: ctx.io.env, log });
  if (ctx.copy) return judge(ctx.copy);
  const done = await withFreshCopy(repo, commonDir(repo), sha, async dir => {
    await prepareMainCopy({ repo: dir, config, env: ctx.io.env, log, always: 'copie neuve de la mise en ligne' });
    return judge(dir);
  }, log);
  return 'busy' in done ? { tests: [], blocking: [`${done.busy} : les tests instables se jugent plus tard`] } : done;
}

/**
 * The migrations between production and `sha` (null when no `release.migrations` declares any). The patterns of production,
 * of `sha` and of `from` together, as the checks of production are kept: a commit that empties or changes them removes none.
 */
function migrationsOf(repo: string, settings: ReleaseSettings, production: string, sha: string): Migrations | null {
  const patterns = [...new Set([settings, loadConfigAtCommit(repo, production).config.release, loadConfigAtCommit(repo, sha).config.release].flatMap(r => r?.migrations ?? []))];
  return patterns.length ? releaseMigrations(repo, commonDir(repo), patterns, production, sha) : null;
}
/** Why the migrations stop a release: refused (`refusal`) or waiting for the operator (`wait`); null when they do not. */
function migrationStop(m: Migrations | null): { refusal: string } | { wait: string } | null {
  const refused = m ? refusedReason(m) : null;
  if (refused) return { refusal: refused };
  return m?.pending.length ? { wait: pendingReason(m) } : null;
}

/** Checks a release of `sha` and, unless `dryRun`, pushes it fast-forward. */
async function release(repo: string, state: ReturnType<typeof remoteState>, sha: string, dryRun: boolean, ctx: ReleaseContext): Promise<Outcome> {
  const { settings, settings: { branch, from }, fromHead, production } = state;
  const migrations = production ? migrationsOf(repo, settings, production, sha) : null;
  const base: Outcome = { ok: false, published: false, sha, branch, from, previous: production, migrations, lines: [] };
  const refuse = (line: string): Outcome => ({ ...base, lines: [`Mise en ligne refusée : ${line}`] });
  if (!production) return refuse(`branche distante ${REMOTE}/${branch} absente : l'opérateur la crée une première fois`);
  if (!isAncestor(repo, sha, fromHead)) return refuse(`${short(sha)} n'est pas dans ${REMOTE}/${from} (${short(fromHead)})`);
  if (!isAncestor(repo, production, sha)) return refuse(`${REMOTE}/${branch} (${short(production)}) n'est pas un ancêtre de ${short(sha)} : avance rapide seulement, jamais de retour en arrière`);
  if (production === sha) return { ...base, ok: true, lines: [`${REMOTE}/${branch} est déjà à ${short(sha)} : rien à publier.`] };
  // Before the suite: a migration not applied in production would put online code that calls what the base lacks.
  const stop = migrationStop(migrations);
  if (stop) return refuse('refusal' in stop ? stop.refusal : stop.wait);
  const applied = migrations ? migrationLines(migrations) : [];
  const proof = await fullProof(repo, sha, from, production);
  if (!proof.ok) return refuse(`suite complète non prouvée à ${short(sha)}, contrôles de ${REMOTE}/${branch} compris : ${proofLines(proof).join(', ')} (apv gates run --stage full --base ${REMOTE}/${branch} dans une copie à ce commit)`);
  // An unstable test blocks unless it is unrelated to the change since production (docs/UNE-SUITE-PAR-PR.md, 3).
  let unstable: UnstableTest[] = [];
  if (proof.flaky.length) {
    const verdict = await judgeUnstable(ctx, repo, sha, production, proof);
    unstable = verdict.tests;
    if (verdict.blocking.length) {
      return { ...refuse(`réussi(s) seulement après relance à ${short(sha)} : ${proof.flaky.join(', ')} (règle instable) : ${verdict.blocking.join(' ; ')}`), unstable };
    }
  }
  const reused: Reused[] = (ctx.reused ?? []).map(r => ({ gateId: r.gateId, fromRun: r.fromRun, fromCommit: r.fromCommit, origin: r.origin }));
  const notes = [
    ...(reused.length ? [`Repris sans relancer (arbre identique, même environnement) : ${reused.map(r => `${r.gateId} de ${short(r.fromCommit)} (exécution ${r.fromRun}, reçu ${r.origin})`).join(' ; ')}.`] : []),
    ...unstable.map(t => `Constat : test instable sans rapport avec le changement depuis ${short(production)} : ${t.test} (${t.gateId}) échoue ${t.failed} fois sur ${t.passes} passages (exécution ${t.runId}) ; publié quand même, à corriger à part.`)];
  const said = `suite complète prouvée à ${short(sha)} (${proof.required.length} contrôle(s), ${proof.flaky.length ? `${proof.flaky.length} instable(s) sans rapport avec le changement` : 'aucun instable'}) ; ${REMOTE}/${branch} ${short(production)} vers ${short(sha)} en avance rapide`;
  if (dryRun) return { ...base, ok: true, reused, unstable, lines: [`Mise en ligne possible : ${said}. --dry-run : rien n'est poussé.`, ...notes, ...applied] };
  const push = git(repo, ['push', REMOTE, `${sha}:refs/heads/${branch}`]);
  const after = git(repo, ['ls-remote', REMOTE, `refs/heads/${branch}`]).stdout.split('\t')[0]?.trim() ?? '';
  git(repo, ['fetch', '--no-tags', REMOTE, `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`]);
  const done = push.status === 0 && after === sha;
  const findings = done ? writeFindings(repo, sha, unstable) : null;
  return { ...base, ok: done, published: done, push, reused, unstable,
    lines: [done ? `Mis en ligne : ${said}. ${REMOTE}/${branch} relue à ${short(after)}.` : `Mise en ligne en échec : git push sorti en ${push.status}, ${REMOTE}/${branch} relue à ${short(after || null)}.`, ...notes, ...applied,
      ...(findings ? [`Constat non écrit dans .apv/state/suivi-constats.md : ${findings}`] : [])] };
}

function report(io: CommandIO, asJson: boolean, outcome: Outcome, history: boolean, mode: string): number {
  if (history) {
    const failed = journalEntry(io, { event: 'release', mode, commit: outcome.sha, branch: outcome.branch, from: outcome.from, previous: outcome.previous, ok: outcome.ok, published: outcome.published,
      ...(outcome.reused?.length ? { reused: outcome.reused } : {}),
      ...(outcome.unstable?.length ? { unstable: outcome.unstable.map(t => ({ gate: t.gateId, test: t.test, files: t.files, failed: t.failed, passes: t.passes, run: t.runId, blocking: t.blocking })) } : {}),
      detail: outcome.lines.join(' ') });
    if (failed) outcome.lines.push(`Historique non écrit (.apv/state/stack.log) : ${failed}`);
  }
  if (asJson) json(io, { ...outcome, push: outcome.push ? { status: outcome.push.status, stdout: outcome.push.stdout, stderr: outcome.push.stderr } : null });
  else {
    if (outcome.push) io.stdout(`$ git push ${REMOTE} ${outcome.sha}:refs/heads/${outcome.branch}\n${outcome.push.stdout}${outcome.push.stderr}`);
    io.stdout(`${outcome.lines.join('\n')}\n`);
  }
  return outcome.ok ? EXIT.ok : EXIT.failed;
}

const RETRY_INFRA_MS = 30 * 60_000;
/**
 * Whether `release auto` may run the full suite again at a commit, from its receipts alone (review of 1786b40, M1 and M3):
 * no failed check (`run`); a failure of the code (`code`: never again at this commit, --force-retry included), which is any
 * failure without an infrastructure finding the tool recorded itself (the output of a test never counts); every failure such
 * a finding, its receipts younger than 30 minutes (`wait`, unless --force-retry), else `run`.
 */
export function retryDecision(proof: Pick<VerifyResult, 'gates'>, now: number, forceRetry: boolean):
  { kind: 'run' } | { kind: 'code'; endedAt: number; runs: string; probable: InfrastructureCause[] } | { kind: 'wait'; endedAt: number; runs: string; ageMs: number; causes: InfrastructureCause[] } {
  const failed = proof.gates.filter(g => g.state === 'failed');
  if (!failed.length) return { kind: 'run' };
  const own = failed.filter(g => g.status !== null && ['failed', 'timed_out', 'spawn_error'].includes(g.status));
  const causes = own.map(g => g.failure?.infrastructure ?? null);
  const endedAt = Math.max(...failed.map(g => g.failure?.endedAt ?? 0));
  const runs = [...new Set(failed.map(g => g.runId ?? '?'))].join(', ');
  // Only what the tool itself observed (`finding` of the receipt) counts; a failure its output merely suggests is a failure of the code.
  if (!own.length || causes.some(c => c === null)) return { kind: 'code', endedAt, runs, probable: failed.flatMap(g => g.failure?.probable && !g.failure.infrastructure ? [g.failure.probable] : []) };
  const ageMs = now - endedAt;
  return !forceRetry && ageMs < RETRY_INFRA_MS ? { kind: 'wait', endedAt, runs, ageMs, causes: causes as InfrastructureCause[] } : { kind: 'run' };
}
const when = (at: number): string => new Date(at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** `apv release auto`: one pass, never waiting; a lock of the repository keeps two passes apart. */
async function auto(io: CommandIO, repo: string, dryRun: boolean, asJson: boolean, forced: string[] | undefined, forceRetry: boolean): Promise<number> {
  const common = commonDir(repo);
  const store = new LockStore(join(common, 'apv', 'locks'));
  const lock = await store.tryAcquire('release-auto', { pid: process.pid, host: store.host, label: `apv release auto (${repo})` }, 6 * 3600, 'apv release auto');
  if (!lock.ok) { io.stdout(`apv release auto déjà en cours (verrou release-auto) : plus tard.\n`); return EXIT.ok; }
  try {
    const state = remoteState(repo);
    const { settings, settings: { branch, from }, fromHead, production } = state;
    const base: Outcome = { ok: true, published: false, sha: fromHead, branch, from, previous: production, migrations: null, lines: [] };
    if (production === fromHead) return report(io, asJson, { ...base, lines: [`Rien à publier : ${REMOTE}/${branch} est à la tête de ${from} (${short(fromHead)}).`] }, false, 'auto');
    if (!production || !isAncestor(repo, production, fromHead)) return report(io, asJson, await release(repo, state, fromHead, true, { io }), !dryRun, 'auto');
    // Migrations first: one waiting for the operator never costs a full suite.
    const migrations = migrationsOf(repo, settings, production, fromHead);
    const stop = migrationStop(migrations);
    if (stop && 'refusal' in stop) return report(io, asJson, { ...base, ok: false, migrations, lines: [`Mise en ligne refusée : ${stop.refusal}.`] }, !dryRun, 'auto');
    if (stop) return report(io, asJson, { ...base, migrations, lines: [`En attente : ${stop.wait} ; rien n'est publié ni lancé.`, ...migrationLines({ ...migrations!, pending: [] })] }, false, 'auto');
    // Whether to run the suite again is read from the receipts at this commit only, as `verify` reads them (integrity of the
    // shared store included), never from a file an agent can write (review of 1786b40, M1). An unstable check is never run
    // again: a complete proof with unstable checks is judged (unrelated to the change: published, a finding), else refused.
    // A failure of the code is never run again at the same commit, --force-retry included: only a new commit unblocks it.
    // Only a run whose every failure is an infrastructure failure (src/gates/infrastructure.ts) is run again, 30 minutes
    // after its receipts at the earliest (--force-retry: at once). A green proof alone never suffices: the suite runs in the
    // fresh copy, which reuses what checks out in its own environment (docs/UNE-SUITE-PAR-PR.md, 2).
    const proof = await fullProof(repo, fromHead, from, production);
    if (proof.flaky.length) {
      if (proof.ok) return report(io, asJson, await release(repo, state, fromHead, dryRun, { io }), !dryRun, 'auto');
      return report(io, asJson, { ...base, ok: false, lines: [`Suite complète déjà passée à ${short(fromHead)}, instable(s) : ${proof.flaky.join(', ')}, et incomplète : ${proofLines(proof).join(', ')} : rien n'est publié ni relancé (corriger sur ${from}).`] }, !dryRun, 'auto');
    }
    const decision = retryDecision(proof, Date.now(), forceRetry);
    if (decision.kind === 'code') {
      return report(io, asJson, { ...base, ok: false, lines: [`Suite rouge à ${short(fromHead)} le ${when(decision.endedAt)} (exécution ${decision.runs}), en échec : ${proofLines(proof).join(', ')}${decision.probable.length ? ` (panne probable lue dans la sortie, non constatée par apv : ${decision.probable.map(infrastructureText).join(' ; ')})` : ''} : jamais relancée au même commit (--force-retry compris) ; en attente d'un nouveau commit sur ${from} ; rien n'est publié ni lancé.`] }, !dryRun, 'auto');
    }
    if (decision.kind === 'wait') {
      return report(io, asJson, { ...base, lines: [`Panne d'infrastructure à ${short(fromHead)} le ${when(decision.endedAt)}, il y a ${Math.round(decision.ageMs / 60000)} min (exécution ${decision.runs}) : ${decision.causes.map(infrastructureText).join(' ; ')} ; nouvel essai après ${RETRY_INFRA_MS / 60000} min ; rien n'est lancé (--force-retry pour relancer).`] }, false, 'auto');
    }
    if (dryRun) return report(io, asJson, { ...base, migrations, lines: [`Suite complète à lancer à ${short(fromHead)} dans la copie neuve de son arbre (reçus verts d'un arbre identique repris), puis mise en ligne. --dry-run : rien n'est lancé.`, ...(migrations ? migrationLines(migrations) : [])] }, false, 'auto');
    const piles = pickStacks(proofConfig(repo, fromHead, production), common, forced);
    if ('busy' in piles) return report(io, asJson, { ...base, lines: [`Piles occupées (${piles.busy}) : plus tard ; rien n'est lancé.`] }, false, 'auto');
    const outcome = await withFreshCopy(repo, common, fromHead, async (dir): Promise<Outcome> => {
      const suite = await runSuite(io, dir, fromHead, proofConfig(repo, fromHead, production), production, piles.ids);
      if (suite.busy) return { ...base, lines: [`Machine occupée (${suite.busy}) : plus tard.`] };
      if (suite.infrastructure) return { ...base, ok: false, lines: [`Suite complète à ${short(fromHead)} : panne d'infrastructure : ${suite.infrastructure} ; rien n'est publié.`] };
      if (!suite.ok) return { ...base, ok: false, lines: [`Suite complète rouge à ${short(fromHead)} : ${suite.summary} ; rien n'est publié.`] };
      // Green, unstable checks included: the release judges them in this very copy.
      return release(repo, state, fromHead, false, { io, copy: dir, reused: suite.reused });
    }, line => io.stderr(`${line}\n`));
    if ('busy' in outcome) return report(io, asJson, { ...base, lines: [`Copie neuve occupée (${outcome.busy}) : plus tard ; rien n'est lancé.`] }, false, 'auto');
    // A machine busy is a pass that did nothing: not journaled, as before.
    return report(io, asJson, outcome, !outcome.lines[0]?.startsWith('Machine occupée'), 'auto');
  } finally {
    await store.release('release-auto', { token: lock.record.token }).catch(() => undefined);
  }
}

/** The stacks of the suite (src/gates/fresh-copy.ts): an unknown stack forced is an incorrect call. */
function pickStacks(config: ApvConfig, common: string, forced: string[] | undefined): { ids: string[] | undefined } | { busy: string } {
  try { return pickFresh(config, common, forced); }
  catch (error) { if (error instanceof PipelineError && error.code === 'STACK_UNKNOWN') throw new UsageError(error.message); throw error; }
}

/**
 * The full suite of `sha` in its fresh copy `dir`, without waiting for the queue. A check whose green receipt of an identical
 * tree checks out in this environment is reused (the suite of the branch, docs/UNE-SUITE-PAR-PR.md, 2.1); the changed test
 * files already repeated at the same content are credited (2.2). `ok`: every check passed, some perhaps only after a relaunch
 * (judged by the release).
 */
async function runSuite(io: CommandIO, dir: string, sha: string, config: ApvConfig, production: string, stacks?: string[]):
  Promise<{ ok: boolean; busy?: string; infrastructure?: string; runId?: string; summary: string; reused: ReusedCheck[] }> {
  try {
    const suite = suiteSettings(config);
    const noWait: ApvConfig = { ...config, suite: { ports: suite.ports, queue: { ...suite.queue, waitMs: 0 } } };
    const result = await runGates({ repo: dir, config: noWait, stage: 'full', base: production, repeatReference: production, reference: production, repeatCeiling: false,
      batchSetup: true, repeatCredits: true, ...(stacks ? { stacks } : {}), env: io.env, log: line => io.stderr(`${line}\n`) });
    if (result.candidateSha !== sha) throw new PipelineError('RELEASE', `copie à ${short(result.candidateSha)}, attendu ${short(sha)}`);
    const failed = result.receipts.filter(r => !['passed', 'passed_after_retry', 'cached', 'not_required'].includes(r.status)).map(r => `${r.gateId} (${r.status})`);
    const infra = result.infrastructure;
    // Said as observed only when the tool recorded the finding itself; read from the output only, it stays probable (M3).
    const observed = result.receipts.filter(r => ['failed', 'timed_out', 'spawn_error'].includes(r.status)).every(r => r.finding);
    if (!result.ok && infra.all) return { ok: false, infrastructure: `${observed ? '' : 'probable, lue dans la sortie, non constatée par apv : '}${infra.causes.map(infrastructureText).join(' ; ')} ; ${infrastructureAdvice(infra.causes, stacks ? [] : (config.stacks ?? []).map(x => x.id))} (exécution ${result.runId})`, runId: result.runId, summary: '', reused: result.reused };
    return { ok: result.ok, runId: result.runId, reused: result.reused,
      summary: `${failed.length ? `en échec : ${failed.join(', ')}` : ''}${result.reuseStale.length ? ` reprise devenue invérifiable : ${result.reuseStale.map(x => x.gateId).join(', ')}` : ''} ; exécution ${result.runId}` };
  } catch (error) {
    if (error instanceof PipelineError && ['SUITE_QUEUE', 'GATE_BUSY'].includes(error.code)) return { ok: false, busy: error.message.slice(0, 300), summary: '', reused: [] };
    throw error;
  }
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, {
      'dry-run': { type: 'boolean' }, stacks: { type: 'string' }, 'force-retry': { type: 'boolean' }, json: { type: 'boolean' }, repo: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    if (positionals.length > 1) throw new UsageError(`argument inattendu : ${positionals.slice(1).join(' ')}`);
    const repo = gitRoot(repoPath(io, values.repo));
    const dryRun = values['dry-run'] === true;
    if (!dryRun && io.env['APV_ALLOW_MERGE'] !== '1') { io.stderr(`${RELEASE_REFUSED}\n`); return EXIT.usage; }
    const forced = values.stacks === undefined ? undefined : values.stacks.split(',').map(x => x.trim()).filter(Boolean);
    if (forced && (!forced.length || new Set(forced).size !== forced.length)) throw new UsageError('--stacks attend une ou plusieurs piles différentes, par exemple --stacks 2 ou --stacks 1,2');
    if (forced && positionals[0] !== 'auto') throw new UsageError('--stacks ne vaut que pour apv release auto');
    if (positionals[0] === 'auto') return auto(io, repo, dryRun, values.json === true, forced, values['force-retry'] === true);
    const state = remoteState(repo);
    const sha = positionals[0] === undefined ? state.fromHead : resolveCommit(repo, positionals[0]);
    if (!sha) throw new UsageError(`commit inconnu : ${positionals[0]}`);
    return report(io, values.json === true, await release(repo, state, sha, dryRun, { io }), !dryRun, 'manuel');
  });
}
