import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { loadConfig, loadConfigAtCommit, suiteSettings, type ApvConfig } from '../config/load.js';
import { enforceBaseGates } from '../gates/base-gates.js';
import { runGates } from '../gates/run.js';
import { verifyGates, type VerifyResult } from '../gates/verify.js';
import { LockStore } from '../lock/store.js';
import type { ReleaseSettings } from '../release/config.js';
import { migrationLines, pendingReason, refusedReason, releaseMigrations, type Migrations } from '../release/migrations.js';
import { gitRoot, resolveCommit } from '../run/git-probe.js';
import { infrastructureAdvice, infrastructureText } from '../gates/infrastructure.js';
import { commonDir, flockFree, resolveStacks } from '../stacks/idle.js';
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
auto : pour un lancement périodique (cron) ; rien à publier : 0 ; reçus rouges ou instables à ce commit : 1 sans
relancer ; migration en attente : 0, rien lancé ; sinon suite complète relancée en entier (aucun reçu repris) dans une copie détachée (batch.setup), sans
attendre la file des suites (occupée : 0, plus tard), puis publie si elle est verte au premier passage.
Section stacks déclarée : la suite reçoit une pile comme apv gates run --stacks (la première dont le verrou est libre, ou --stacks pour
forcer) ; aucune libre : 0, piles occupées, plus tard. Panne d'infrastructure (variable absente, pile injoignable) : dite comme telle, 1.
Même commit déjà tenté : suite rouge ou instable (code) : 0, plus de relance jusqu'à un nouveau commit ; panne d'infrastructure : nouvel essai
au plus toutes les 30 min ; --force-retry relance quand même.
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
  return verifyGates({ repo, config: proofConfig(repo, sha, production), commit: sha, stage: 'full', configFile: null, reuseReference: `refs/remotes/${REMOTE}/${from}` });
}
const proofLines = (proof: VerifyResult): string[] => proof.gates.filter(g => g.state !== 'passed').map(g => `${g.gateId} (${g.state})`);

interface Outcome { ok: boolean; published: boolean; sha: string | null; branch: string; from: string; previous: string | null; migrations: Migrations | null; lines: string[]; push?: Git }

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
async function release(repo: string, state: ReturnType<typeof remoteState>, sha: string, dryRun: boolean): Promise<Outcome> {
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
  if (proof.flaky.length) return refuse(`réussi(s) seulement après relance à ${short(sha)} : ${proof.flaky.join(', ')} (règle instable)`);
  const said = `suite complète prouvée à ${short(sha)} (${proof.required.length} contrôle(s), aucun instable) ; ${REMOTE}/${branch} ${short(production)} vers ${short(sha)} en avance rapide`;
  if (dryRun) return { ...base, ok: true, lines: [`Mise en ligne possible : ${said}. --dry-run : rien n'est poussé.`, ...applied] };
  const push = git(repo, ['push', REMOTE, `${sha}:refs/heads/${branch}`]);
  const after = git(repo, ['ls-remote', REMOTE, `refs/heads/${branch}`]).stdout.split('\t')[0]?.trim() ?? '';
  git(repo, ['fetch', '--no-tags', REMOTE, `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`]);
  const done = push.status === 0 && after === sha;
  return { ...base, ok: done, published: done, push,
    lines: [done ? `Mis en ligne : ${said}. ${REMOTE}/${branch} relue à ${short(after)}.` : `Mise en ligne en échec : git push sorti en ${push.status}, ${REMOTE}/${branch} relue à ${short(after || null)}.`, ...applied] };
}

function report(io: CommandIO, asJson: boolean, outcome: Outcome, history: boolean, mode: string): number {
  if (history) {
    const failed = journalEntry(io, { event: 'release', mode, commit: outcome.sha, branch: outcome.branch, from: outcome.from, previous: outcome.previous, ok: outcome.ok, published: outcome.published, detail: outcome.lines.join(' ') });
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
interface Attempt { sha: string; kind: 'red' | 'infrastructure'; at: number; runId: string }
const attemptFile = (common: string): string => join(common, 'apv', 'release', 'last-auto.json');
/** The failed pass of `release auto` at `sha`, if it was the last one; null otherwise (unreadable too). */
function lastAttempt(common: string, sha: string): Attempt | null {
  try {
    const a = JSON.parse(readFileSync(attemptFile(common), 'utf8')) as Attempt;
    return a.sha === sha && (a.kind === 'red' || a.kind === 'infrastructure') && typeof a.at === 'number' ? a : null;
  } catch { return null; }
}
function writeAttempt(common: string, a: Attempt): void {
  try { mkdirSync(join(common, 'apv', 'release'), { recursive: true }); writeFileSync(attemptFile(common), JSON.stringify(a)); } catch { /* the next pass then runs again */ }
}

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
    if (!production || !isAncestor(repo, production, fromHead)) return report(io, asJson, await release(repo, state, fromHead, true), !dryRun, 'auto');
    // Migrations first: one waiting for the operator never costs a full suite.
    const migrations = migrationsOf(repo, settings, production, fromHead);
    const stop = migrationStop(migrations);
    if (stop && 'refusal' in stop) return report(io, asJson, { ...base, ok: false, migrations, lines: [`Mise en ligne refusée : ${stop.refusal}.`] }, !dryRun, 'auto');
    if (stop) return report(io, asJson, { ...base, migrations, lines: [`En attente : ${stop.wait} ; rien n'est publié ni lancé.`, ...migrationLines({ ...migrations!, pending: [] })] }, false, 'auto');
    // The last pass of this cron at this very commit: a red suite waits for a new commit, an infrastructure failure for 30 minutes.
    const last = forceRetry ? null : lastAttempt(common, fromHead);
    if (last?.kind === 'red') return report(io, asJson, { ...base, lines: [`Suite rouge à ${short(fromHead)} (exécution ${last.runId}) : en attente d'un nouveau commit sur ${from} ; rien n'est lancé (--force-retry pour relancer).`] }, false, 'auto');
    if (last?.kind === 'infrastructure' && Date.now() - last.at < RETRY_INFRA_MS) {
      return report(io, asJson, { ...base, lines: [`Panne d'infrastructure à ${short(fromHead)} il y a ${Math.round((Date.now() - last.at) / 60000)} min (exécution ${last.runId}) : nouvel essai après ${RETRY_INFRA_MS / 60000} min ; rien n'est lancé (--force-retry pour relancer).`] }, false, 'auto');
    }
    // A red or unstable suite already recorded at this commit is never run again by the cron; a green one never suffices.
    const proof = (last || forceRetry) ? null : await fullProof(repo, fromHead, from, production);
    if (proof && (proof.gates.some(g => g.state === 'failed') || proof.flaky.length)) {
      const what = proof.flaky.length ? `instable(s) : ${proof.flaky.join(', ')}` : `en échec : ${proofLines(proof).join(', ')}`;
      return report(io, asJson, { ...base, ok: false, lines: [`Suite complète déjà passée à ${short(fromHead)}, ${what} : rien n'est publié ni relancé (corriger sur ${from}).`] }, !dryRun, 'auto');
    }
    if (dryRun) return report(io, asJson, { ...base, migrations, lines: [`Suite complète à relancer à ${short(fromHead)} dans une copie détachée, puis mise en ligne. --dry-run : rien n'est lancé.`, ...(migrations ? migrationLines(migrations) : [])] }, false, 'auto');
    const piles = pickStacks(proofConfig(repo, fromHead, production), common, forced);
    if ('busy' in piles) return report(io, asJson, { ...base, lines: [`Piles occupées (${piles.busy}) : plus tard ; rien n'est lancé.`] }, false, 'auto');
    const suite = await runCopy(io, repo, common, fromHead, production, piles.ids);
    if (suite.busy) return report(io, asJson, { ...base, lines: [`Machine occupée (${suite.busy}) : plus tard.`] }, false, 'auto');
    if (suite.infrastructure || !suite.ok) writeAttempt(common, { sha: fromHead, kind: suite.infrastructure ? 'infrastructure' : 'red', at: Date.now(), runId: suite.runId ?? '?' });
    if (suite.infrastructure) return report(io, asJson, { ...base, ok: false, lines: [`Suite complète à ${short(fromHead)} : panne d'infrastructure : ${suite.infrastructure} ; rien n'est publié.`] }, true, 'auto');
    if (!suite.ok) return report(io, asJson, { ...base, ok: false, lines: [`Suite complète rouge ou instable à ${short(fromHead)} : ${suite.summary} ; rien n'est publié.`] }, true, 'auto');
    return report(io, asJson, await release(repo, state, fromHead, false), true, 'auto');
  } finally {
    await store.release('release-auto', { token: lock.record.token }).catch(() => undefined);
  }
}

/**
 * The stacks the full suite is given, as `apv gates run --stacks`: those forced, else the first declared whose lock is free
 * (a lock file held by someone else is busy); none declared: none given (`ids` undefined); all busy: `busy`.
 */
function pickStacks(config: ApvConfig, common: string, forced: string[] | undefined): { ids: string[] | undefined } | { busy: string } {
  const declared = resolveStacks(config, common);
  if (!declared.length) {
    if (forced) throw new UsageError('--stacks : aucune pile déclarée (section stacks de .apv/config.json)');
    return { ids: undefined };
  }
  if (forced) {
    const unknown = forced.filter(id => !declared.some(s => s.id === id));
    if (unknown.length) throw new UsageError(`--stacks : pile inconnue ${unknown.join(', ')} (déclarées : ${declared.map(s => s.id).join(', ')})`);
    return { ids: forced };
  }
  const free = declared.find(s => !s.lockFile || flockFree(s.lockFile) !== false);
  return free ? { ids: [free.id] } : { busy: declared.map(s => `${s.id} : verrou ${s.lockFile} tenu`).join(' ; ') };
}

/** The full suite of `sha` in a detached copy under the Git common directory, prepared by batch.setup, then removed. */
async function runCopy(io: CommandIO, repo: string, common: string, sha: string, production: string, stacks?: string[]): Promise<{ ok: boolean; busy?: string; infrastructure?: string; runId?: string; summary: string }> {
  const dir = join(common, 'apv', 'release', sha.slice(0, 12));
  mkdirSync(join(common, 'apv', 'release'), { recursive: true });
  if (existsSync(dir)) git(repo, ['worktree', 'remove', '--force', dir]);
  const added = git(repo, ['worktree', 'add', '--detach', dir, sha]);
  if (added.status !== 0) throw new PipelineError('RELEASE', `copie ${dir} non créée : ${added.stderr.trim()}`);
  try {
    const config = proofConfig(repo, sha, production);
    const suite = suiteSettings(config);
    const noWait: ApvConfig = { ...config, suite: { ports: suite.ports, queue: { ...suite.queue, waitMs: 0 } } };
    // Every check run again (no receipt reused): the cron publishes only what it has just seen pass.
    const result = await runGates({ repo: dir, config: noWait, stage: 'full', base: production, repeatReference: production, reference: production, repeatCeiling: false,
      batchSetup: true, replay: 'all', ...(stacks ? { stacks } : {}), env: io.env, log: line => io.stderr(`${line}\n`) });
    const failed = result.receipts.filter(r => !['passed', 'passed_after_retry', 'cached', 'not_required'].includes(r.status)).map(r => `${r.gateId} (${r.status})`);
    const infra = result.infrastructure;
    if (!result.ok && infra.all) return { ok: false, infrastructure: `${infra.causes.map(infrastructureText).join(' ; ')} ; ${infrastructureAdvice(infra.causes, stacks ? [] : (config.stacks ?? []).map(x => x.id))} (exécution ${result.runId})`, runId: result.runId, summary: '' };
    return { ok: result.ok && !result.flaky.length, runId: result.runId, summary: `${failed.length ? `en échec : ${failed.join(', ')}` : ''}${result.flaky.length ? ` instable(s) : ${result.flaky.join(', ')}` : ''} ; exécution ${result.runId}` };
  } catch (error) {
    if (error instanceof PipelineError && ['SUITE_QUEUE', 'GATE_BUSY'].includes(error.code)) return { ok: false, busy: error.message.slice(0, 300), summary: '' };
    throw error;
  } finally {
    const removed = git(repo, ['worktree', 'remove', '--force', dir]);
    if (removed.status !== 0) io.stderr(`Copie ${dir} non retirée : ${removed.stderr.trim()}\n`);
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
    return report(io, values.json === true, await release(repo, state, sha, dryRun), !dryRun, 'manuel');
  });
}
