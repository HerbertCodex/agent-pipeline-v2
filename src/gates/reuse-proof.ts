import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { validateReceipt, type GateReceipt } from '../domain/contracts.js';
import type { Git } from '../execution/git.js';
import { runsWebAudit } from '../web/impact.js';
import { MANIFEST, RECEIPTS_DIR, RUN_DIR, manifestCommit, readSharedRun, sharedRunIds } from './store.js';
import { DEFAULT_REUSE_MAX_AGE_MS, REUSE_AGE_MARGIN_MS, ignoreDigest, inputsDigest, treesOf } from './reuse.js';

/**
 * What proves the reuse of a green receipt at another commit (docs/ACCELERATION-LOTS.md, 5.2 and 5.5), in one place for
 * the two sides: `apv gates run`, which writes a receipt `cached` only when this check accepts it, and `apv gates verify`,
 * which runs the very same check on every receipt `cached` it reads. Nothing of a receipt `cached` is trusted: its origin is
 * read again from the worktree or from the shared store (intact), the trees and the digest are recomputed from Git.
 */

/** Where a receipt was read: the `.apv/receipts/` of the worktree, or the shared store of the repository. */
export type ReceiptSource = 'local' | 'shared';
export interface Found { receipt: GateReceipt; dirty: boolean | null; baseSha: string | null; source: ReceiptSource }
/** A run of the shared store refused as a whole: its files no longer match its manifest, or contradict it. */
export interface AlteredRun { runId: string; reason: string }
/** The receipts of the worktree: every readable one, the unreadable files, and the runs it has. */
export interface LocalReceipts { found: Found[]; unreadable: string[]; runs: Set<string> }

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Tree state and base of a run, from its summary (null when unknown). */
function summaryOf(text: string | null): { dirty: boolean | null; baseSha: string | null } {
  let dirty: boolean | null = null;
  let baseSha: string | null = null;
  if (text === null) return { dirty, baseSha };
  try {
    const summary = JSON.parse(text) as { dirty?: unknown; baseSha?: unknown };
    if (typeof summary.dirty === 'boolean') dirty = summary.dirty;
    if (typeof summary.baseSha === 'string' && /^[a-f0-9]{40,64}$/.test(summary.baseSha)) baseSha = summary.baseSha;
  } catch { /* No summary: the tree state comes from the receipts or stays unknown, the base stays unknown. */ }
  return { dirty, baseSha };
}

/** Every readable receipt of `.apv/receipts/`, with the tree state from the receipt or, for older ones, its run summary. */
export function readLocal(repo: string): LocalReceipts {
  const root = join(repo, RECEIPTS_DIR);
  const found: Found[] = [];
  const unreadable: string[] = [];
  const runs = new Set<string>();
  if (!existsSync(root)) return { found, unreadable, runs };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    runs.add(entry.name);
    const dir = join(root, entry.name);
    let text: string | null = null;
    try { text = readFileSync(join(dir, 'summary.json'), 'utf8'); } catch { /* Older run without summary. */ }
    const summary = summaryOf(text);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json') || file === 'summary.json') continue;
      try {
        const receipt = validateReceipt(JSON.parse(readFileSync(join(dir, file), 'utf8')));
        found.push({ receipt, dirty: receipt.dirty ?? summary.dirty, baseSha: summary.baseSha, source: 'local' });
      } catch { unreadable.push(join(RECEIPTS_DIR, entry.name, file)); }
    }
  }
  return { found, unreadable, runs };
}

/**
 * Receipts of the shared store for the runs absent from the worktree (a run present in both is read from the
 * worktree, as before the store existed). A run counts only when intact: its manifest names it and lists exactly
 * its files with their digests, its summary is there, and each receipt belongs to it (same run, same commit as
 * the manifest, file named after its check). Otherwise none of its receipts count, and the run is reported.
 * `keep` says which runs to read from the commit their manifest names (null: no readable manifest, always read).
 */
export function readShared(store: string, local: Set<string>, keep: (named: string | null) => boolean): { found: Found[]; altered: AlteredRun[] } {
  const found: Found[] = [];
  const altered: AlteredRun[] = [];
  for (const runId of sharedRunIds(store)) {
    if (local.has(runId)) continue;
    // Runs of another commit cannot prove this one: their files are not read (a thousand runs stay cheap). A
    // manifest that names another commit while its receipts claim this one would be refused below anyway.
    if (!keep(manifestCommit(join(store, runId)))) continue;
    const run = sharedRunReceipts(store, runId);
    if ('reason' in run) altered.push({ runId, reason: run.reason });
    else found.push(...run.found);
  }
  return { found, altered };
}

/**
 * The receipts of one run of the shared store, when the run is intact: its manifest names it and lists exactly its files
 * with their digests, its summary is there, and each receipt belongs to it (same run, same commit as the manifest, file
 * named after its check). Otherwise the reason, and none of its receipts count.
 */
export function sharedRunReceipts(store: string, runId: string): { found: Found[] } | { reason: string } {
  const run = readSharedRun(join(store, runId));
  if (!run.intact) return { reason: run.reason };
  const summaryBytes = run.files.get('summary.json');
  if (!summaryBytes) return { reason: 'summary.json absent' };
  const summary = summaryOf(summaryBytes.toString('utf8'));
  const found: Found[] = [];
  for (const [name, bytes] of run.files) {
    if (name === 'summary.json') continue;
    let receipt: GateReceipt;
    try { receipt = validateReceipt(JSON.parse(bytes.toString('utf8'))); }
    catch { return { reason: `${name} n'est pas un reçu valide` }; }
    if (receipt.runId !== runId || `${receipt.gateId}.json` !== name || receipt.candidateSha !== run.manifest.candidateSha) {
      return { reason: `${name} contredit son exécution (exécution, contrôle ou commit)` };
    }
    found.push({ receipt, dirty: receipt.dirty ?? summary.dirty, baseSha: summary.baseSha, source: 'shared' });
  }
  return { found };
}

/** The later of two receipts: by start, then by run identifier. */
export const latest = (a: Found, b: Found): Found =>
  b.receipt.startedAt > a.receipt.startedAt || (b.receipt.startedAt === a.receipt.startedAt && b.receipt.runId > a.receipt.runId) ? b : a;

/** Whether an argv runs `apv dast` (`dast run`, or `dast` right after the executable of the tool). */
export function runsDast(argv: readonly string[]): boolean {
  return argv.some((a, i) => a === 'dast' && (argv[i + 1] === 'run' || /(?:^|[\\/])(?:apv|cli\.m?js)$/.test(argv[i - 1] ?? '')));
}

/**
 * Why a check is never reused, whatever its receipts say (docs/ACCELERATION-LOTS.md, 5.2 A3), or null: declared
 * `reuse: false` by the project, or a command that runs `apv web audit` or `apv dast` (they measure a state outside the
 * repository: the preview served, the network, the time), or a command (or its relaunch) that reads the commit itself
 * through `{{candidateSha}}`: two commits of the same tree are still two commits for it.
 */
export function neverReused(gate: ReusableGate): string | null {
  if (gate.reuse === false) return 'reuse: false, le projet le déclare toujours rejoué';
  if (runsWebAudit(gate.command)) return 'il lance apv web audit, qui mesure un état extérieur au dépôt';
  if (runsDast(gate.command)) return 'il lance apv dast, qui scanne un état extérieur au dépôt';
  if (commandsOf(gate).some(a => a.includes('{{candidateSha}}'))) return 'sa commande lit le commit lui-même ({{candidateSha}}), pas seulement son arbre';
  return null;
}

/** What the reuse reads of a declared check: its id, its commands, its `reuse` field. */
export interface ReusableGate { id?: string; command: readonly string[]; reuse?: boolean | undefined; retryFailed?: { command: readonly string[] } | undefined }
const commandsOf = (gate: ReusableGate): readonly string[] => [...gate.command, ...(gate.retryFailed?.command ?? [])];
/** Whether the commands of a check read the base of their run (`{{baseSha}}`): its result then depends on that base too. */
export const readsBase = (gate: ReusableGate): boolean => commandsOf(gate).some(a => a.includes('{{baseSha}}'));

/**
 * Every run of the shared store that can say something about one tree, read once for all the checks of a verification or
 * of a run of the checks. `block`: why a later failure on this tree cannot be excluded (null: it can).
 */
export interface TreeScan {
  tree: string;
  /** Receipts of the worktree (every commit), and of the intact shared runs whose manifest names a commit of this tree. */
  found: Found[];
  /** Tree of each commit those receipts and manifests name (absent: a commit the repository does not have). */
  trees: Map<string, string>;
  block: string | null;
  /** Cost of the scan: runs of the shared store looked at, receipt files read for the commit they claim, milliseconds. */
  runs: number;
  files: number;
  ms: number;
}

/** What a check of reuse reads: the commit judged, the configuration of the checks, the clock, the receipts. */
export interface ReuseContext {
  git: Git;
  repo: string;
  /** Commit the receipt `cached` is (or would be) written at, full SHA. */
  commit: string;
  configHash: string;
  now: number;
  /** Shared store of the repository (`<git common dir>/apv/receipts`). */
  store: string;
  local: LocalReceipts;
  /** Scans of the store by tree, made once per context. */
  scans: Map<string, Promise<TreeScan>>;
}

export function reuseContext(input: Omit<ReuseContext, 'scans'>): ReuseContext {
  return { ...input, scans: new Map() };
}

/** Receipt files of a run directory of the store (summary and manifest left out); none when it cannot be listed. */
function receiptFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.json') && e.name !== 'summary.json' && e.name !== MANIFEST).map(e => e.name);
  } catch { return []; }
}

/** The commit a receipt file claims (`candidateSha`), read whatever its run says; null when it is not readable as such. */
function claimedCommit(path: string): string | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { candidateSha?: unknown };
    return typeof value.candidateSha === 'string' && SHA.test(value.candidateSha) ? value.candidateSha : null;
  } catch { return null; }
}

/**
 * The runs of the shared store that may hold a receipt of `tree`. Every run absent from the worktree is looked at: its
 * manifest names a commit (absent or unreadable: blocked, its commit is unknown), and the receipts it holds are read for
 * the commit each one claims, whatever the manifest says. A run whose manifest names a commit of this tree, or one of whose
 * receipts claims a commit of this tree, while the two disagree, blocks: a failure of this tree could hide there behind a
 * manifest of another commit (decision of the project lead, 18 October: the A0 limit closed). A run of this tree is then
 * read in full and must be intact (digests of its manifest), or it blocks too. A disagreement between two other trees
 * cannot hide a failure of this one: not read further.
 */
async function scanTree(ctx: ReuseContext, tree: string): Promise<TreeScan> {
  const started = performance.now();
  const commits = new Set(ctx.local.found.map(f => f.receipt.candidateSha));
  const runs: { runId: string; named: string; claimed: Set<string> }[] = [];
  let files = 0;
  const result = (block: string | null, found: Found[] = [], trees = new Map<string, string>()): TreeScan =>
    ({ tree, found, trees, block, runs: runs.length, files, ms: Math.round(performance.now() - started) });
  for (const runId of sharedRunIds(ctx.store)) {
    if (ctx.local.runs.has(runId)) continue;
    const dir = join(ctx.store, runId);
    const named = manifestCommit(dir);
    if (!named) return result(`exécution ${runId} du magasin partagé au manifeste absent ou illisible : son commit est inconnu, un échec plus récent sur le même arbre ne peut pas être exclu`);
    commits.add(named);
    const claimed = new Set<string>();
    for (const name of receiptFiles(dir)) {
      files += 1;
      const sha = claimedCommit(join(dir, name));
      if (sha) { claimed.add(sha); commits.add(sha); }
    }
    runs.push({ runId, named, claimed });
  }
  const trees = await treesOf(ctx.git, ctx.repo, commits);
  const found: Found[] = [...ctx.local.found];
  for (const run of runs) {
    const ofTree = trees.get(run.named) === tree;
    const hidden = [...run.claimed].find(c => c !== run.named && (ofTree || trees.get(c) === tree));
    if (hidden) {
      return result(`exécution ${run.runId} du magasin partagé : son manifeste nomme le commit ${run.named.slice(0, 12)}, un de ses reçus le commit ${hidden.slice(0, 12)} ; ` +
        'un reçu de cet arbre peut s\'y cacher, un échec plus récent sur le même arbre ne peut pas être exclu');
    }
    if (!ofTree) continue;
    const read = sharedRunReceipts(ctx.store, run.runId);
    if ('reason' in read) return result(`exécution ${run.runId} du même arbre altérée dans le magasin partagé : un échec plus récent ne peut pas être exclu`);
    found.push(...read.found);
  }
  return result(null, found, trees);
}

/** The scan of the store for `tree`, made once per context. */
export function treeScan(ctx: ReuseContext, tree: string): Promise<TreeScan> {
  if (!ctx.scans.has(tree)) ctx.scans.set(tree, scanTree(ctx, tree));
  return ctx.scans.get(tree)!;
}

const hours = (ms: number): string => String(Math.round(ms / 360_000) / 10);

/**
 * Whether a receipt `cached` proves its check at `ctx.commit` (docs/ACCELERATION-LOTS.md, 5.5). Nothing of it is trusted:
 * the check must not be one that is never reused (`gate`, from the configuration judged); its origin is read again (the
 * worktree when it has the run, else the run of the shared store, intact), must be the same check, `passed` at first pass
 * (never `cached`: no chain), complete, on a clean tree, of the current configuration, of the same environment, younger
 * than the maximum age, with the same output digests, without a record of `apv web audit`; the trees of both commits are
 * recomputed (`basis: tree`) and so is the digest of the inputs; the store is scanned for the tree (TreeScan), and no
 * receipt of the check on the same tree, later than the origin, failed. Returns the origin, or why the receipt proves nothing.
 */
export async function checkReuse(ctx: ReuseContext, gate: ReusableGate | undefined, cached: Found):
  Promise<{ origin: Found; scan: TreeScan } | { reason: string }> {
  const r = cached.receipt;
  const reuse = r.reuse;
  const refuse = (reason: string): { reason: string } => ({ reason });
  if (!reuse) return refuse('reçu sans relevé reuse (exécution, commit et empreintes de l\'origine) : rien à vérifier');
  if (r.targeted === true) return refuse('un reçu réutilisé n\'est jamais ciblé');
  const never = gate ? neverReused(gate) : null;
  if (never) return refuse(`contrôle jamais repris (${never})`);
  let origin: Found | undefined;
  if (ctx.local.runs.has(reuse.fromRun)) {
    origin = ctx.local.found.find(f => f.receipt.runId === reuse.fromRun && f.receipt.id === r.reusedFrom);
    if (!origin) return refuse(`reçu d'origine ${r.reusedFrom} absent de l'exécution ${reuse.fromRun} du worktree`);
  } else {
    if (!RUN_DIR.test(reuse.fromRun) || !existsSync(join(ctx.store, reuse.fromRun))) {
      return refuse(`exécution d'origine ${reuse.fromRun} absente du worktree et du magasin partagé (retirée par la rétention ?)`);
    }
    const run = sharedRunReceipts(ctx.store, reuse.fromRun);
    if ('reason' in run) return refuse(`exécution d'origine ${reuse.fromRun} refusée, altérée dans le magasin partagé : ${run.reason}`);
    origin = run.found.find(f => f.receipt.id === r.reusedFrom);
    if (!origin) return refuse(`reçu d'origine ${r.reusedFrom} absent de l'exécution ${reuse.fromRun} du magasin partagé`);
  }
  const from: Found = origin;
  const o = from.receipt;
  if (o.gateId !== r.gateId) return refuse(`reçu d'origine d'un autre contrôle (${o.gateId})`);
  if (o.candidateSha !== reuse.fromCommit) return refuse(`reçu d'origine au commit ${o.candidateSha.slice(0, 12)}, pas au commit déclaré ${reuse.fromCommit.slice(0, 12)}`);
  if (o.status !== 'passed') return refuse(`origine ${o.status} : seul un reçu exécuté et réussi au premier passage se réutilise`);
  if (o.early || o.targeted === true) return refuse('origine ciblée (affected ou contrôle tôt) : jamais la preuve du contrôle entier');
  if (from.dirty !== false) return refuse(from.dirty ? 'origine écrite sur un arbre modifié' : 'origine d\'état d\'arbre inconnu');
  if (o.configHash !== ctx.configHash) return refuse('origine écrite pour une autre configuration des contrôles');
  if (o.startedAt > r.startedAt || o.startedAt > ctx.now) return refuse('origine datée après sa reprise ou dans le futur');
  if (ctx.now - o.startedAt > DEFAULT_REUSE_MAX_AGE_MS) {
    return refuse(`origine trop vieille (${hours(ctx.now - o.startedAt)} h, au plus ${hours(DEFAULT_REUSE_MAX_AGE_MS)} h) : l'âge ne se renouvelle jamais par une reprise`);
  }
  if (r.stdoutHash !== o.stdoutHash || r.stderrHash !== o.stderrHash) return refuse('empreintes de sortie différentes de celles de l\'origine');
  if (reuse.environment !== o.environmentHash) return refuse('identité d\'environnement différente de celle de l\'origine');
  if (o.web) return refuse('origine qui porte un relevé de apv web audit : jamais reprise, l\'audit mesure un état extérieur au dépôt');
  // A command that reads the base of its run ({{baseSha}}) proves something about that base too: the same base, or nothing.
  if (gate && readsBase(gate) && (from.baseSha === null || cached.baseSha !== from.baseSha)) {
    return refuse(`commande qui lit la base de son exécution ({{baseSha}}) : base ${cached.baseSha?.slice(0, 12) ?? 'inconnue'} à la reprise, ${from.baseSha?.slice(0, 12) ?? 'inconnue'} à l'origine`);
  }
  if (reuse.basis !== 'tree') return refuse('reprise par entrées identiques (basis inputs) : le contrôle ne déclare pas reuse.ignore à la base, seule la reprise à arbre identique se vérifie');
  const known = await treesOf(ctx.git, ctx.repo, [reuse.fromCommit, ctx.commit]);
  const tree = known.get(ctx.commit);
  const fromTree = known.get(reuse.fromCommit);
  if (!fromTree || !tree) return refuse(`commit d'origine ${reuse.fromCommit.slice(0, 12)} introuvable dans le dépôt`);
  if (fromTree !== tree) return refuse(`arbre de ${reuse.fromCommit.slice(0, 12)} différent de celui de ${ctx.commit.slice(0, 12)} (basis tree)`);
  if (reuse.changed !== 0 || reuse.files.length) return refuse('reprise à arbre identique qui déclare des fichiers changés');
  if (reuse.ignoreDigest !== ignoreDigest([])) return refuse('reprise à arbre identique qui déclare des fichiers ignorés');
  if (reuse.inputsDigest !== (await inputsDigest(ctx.git, ctx.repo, ctx.commit)).digest) return refuse('empreinte des entrées différente de celle recalculée au commit');
  // A later failure on the same tree wins, as in `verify`: receipts of the worktree (every commit) and of the runs of the
  // store that may hold one of this tree (TreeScan: a run that cannot be read, or whose manifest contradicts it, blocks).
  const scan = await treeScan(ctx, tree);
  if (scan.block) return refuse(scan.block);
  const later = scan.found.filter(f => f.receipt.gateId === r.gateId && !f.receipt.early && f.receipt.targeted !== true && f.dirty === false
    && f.receipt.configHash === ctx.configHash && scan.trees.get(f.receipt.candidateSha) === tree && f.receipt !== o && latest(from, f) === f
    && !['passed', 'cached', 'not_required'].includes(f.receipt.status));
  if (later.length) {
    const fail = later.reduce(latest).receipt;
    return refuse(`échec plus récent sur le même arbre : ${fail.runId}/${fail.gateId}.json (${fail.status}${fail.status === 'passed_after_retry' ? ', test instable' : ''}) l'emporte`);
  }
  return { origin: from, scan };
}

/** The environment a check would run in now, for one stack (null: none), as its receipt would record it. */
export interface ReuseEnvironment { hash: string; stack: string | null }

/** The receipt `cached` a run may write for a check: its origin, the record of the reuse, the stack of its environment. */
export interface ReuseChoice { origin: Found; reuse: NonNullable<GateReceipt['reuse']>; stack: string | null; scan: TreeScan }

/**
 * The origin `apv gates run` may reuse for `gate` at `ctx.commit` (docs/ACCELERATION-LOTS.md, A1), or why none:
 * the latest receipt of the check on an identical tree (worktree, then shared store, intact), at the same configuration,
 * in one of the environments the check would run in now (`environments`: its variables, executable, stack), `passed` at
 * first pass, clean, complete, younger than the maximum age minus REUSE_AGE_MARGIN_MS, without a record of `apv web audit`.
 * The receipt about to be written is then checked by `checkReuse`, the very check `apv gates verify` runs: a receipt it
 * would refuse is never written. `candidate`: false when no receipt of an identical tree was even considered (nothing to say).
 */
export async function findOrigin(ctx: ReuseContext, gate: ReusableGate & { id: string }, environments: readonly ReuseEnvironment[], base: string | null):
  Promise<ReuseChoice | { reason: string; candidate: boolean }> {
  const never = neverReused(gate);
  if (never) return { reason: `jamais repris : ${never}`, candidate: false };
  const tree = (await treesOf(ctx.git, ctx.repo, [ctx.commit])).get(ctx.commit);
  if (!tree) return { reason: `arbre du commit ${ctx.commit.slice(0, 12)} illisible`, candidate: false };
  const scan = await treeScan(ctx, tree);
  const limit = DEFAULT_REUSE_MAX_AGE_MS - REUSE_AGE_MARGIN_MS;
  const sameTree = scan.found.filter(f => f.receipt.gateId === gate.id && f.receipt.status === 'passed' && !f.receipt.early && f.receipt.targeted !== true
    && f.dirty === false && f.receipt.configHash === ctx.configHash && scan.trees.get(f.receipt.candidateSha) === tree && !f.receipt.web);
  if (scan.block) return { reason: scan.block, candidate: true };
  if (!sameTree.length) return { reason: 'aucun reçu réussi au premier passage sur un arbre identique avec cette configuration', candidate: false };
  const young = sameTree.filter(f => f.receipt.startedAt <= ctx.now && ctx.now - f.receipt.startedAt <= limit);
  if (!young.length) return { reason: `reçu(s) réussi(s) sur un arbre identique, mais de plus de ${hours(limit)} h (la reprise doit rester vérifiable ${hours(REUSE_AGE_MARGIN_MS)} h)`, candidate: true };
  const byHash = new Map(environments.map(e => [e.hash, e]));
  const sameEnv = young.filter(f => byHash.has(f.receipt.environmentHash));
  if (!sameEnv.length) return { reason: 'reçu(s) réussi(s) sur un arbre identique, mais dans un autre environnement (variables transmises, exécutable, pile, Node, système ou version de l\'outil)', candidate: true };
  // A command that reads the base of its run: only an origin run from the same base.
  const sameBase = readsBase(gate) ? sameEnv.filter(f => f.baseSha !== null && f.baseSha === base) : sameEnv;
  if (!sameBase.length) return { reason: `reçu(s) réussi(s) sur un arbre identique, mais depuis une autre base ({{baseSha}} dans la commande : ${base?.slice(0, 12) ?? "aucune"} ici)`, candidate: true };
  const origin = sameBase.reduce(latest);
  const reuse: NonNullable<GateReceipt['reuse']> = { fromRun: origin.receipt.runId, fromCommit: origin.receipt.candidateSha, basis: 'tree',
    inputsDigest: (await inputsDigest(ctx.git, ctx.repo, ctx.commit)).digest, ignoreDigest: ignoreDigest([]), environment: origin.receipt.environmentHash, changed: 0, files: [] };
  const probe: Found = { receipt: { ...origin.receipt, candidateSha: ctx.commit, status: 'cached', reusedFrom: origin.receipt.id, startedAt: ctx.now, durationMs: 0, reuse },
    dirty: false, baseSha: base, source: 'local' };
  const checked = await checkReuse(ctx, gate, probe);
  if ('reason' in checked) return { reason: checked.reason, candidate: true };
  return { origin, reuse, stack: byHash.get(origin.receipt.environmentHash)!.stack, scan: checked.scan };
}
