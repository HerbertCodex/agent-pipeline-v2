import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { PipelineError, invariant } from '../domain/errors.js';
import { sha256 } from '../domain/hash.js';
import type { Git } from '../execution/git.js';

/**
 * Shared receipt store of a repository: `<git common dir>/apv/receipts/<run>/`, common to every worktree of the
 * repository and never versioned (it lives inside the Git directory). `apv gates run` copies each run there, so
 * that its receipts survive the removal of the worktree (a detached delivery copy, for instance) and
 * `apv gates verify --commit <sha>` proves the commit from any checkout of the repository.
 */
export const SHARED_RECEIPTS_DIR = join('apv', 'receipts');
/** Digests of the files of a run in the shared store (or an export), written last. */
export const MANIFEST = 'manifest.json';
/** Retention of the shared store (`receipts` of `.apv/config.json`): runs younger than `keepDays`, `keepRuns` at most. */
export const DEFAULT_RECEIPT_RETENTION = { keepDays: 30, keepRuns: 1000 } as const;
export interface ReceiptRetention { keepDays: number; keepRuns: number }
/** Identifier of a run of `apv gates run`: its UTC start (to the second) and 8 random hexadecimal digits. */
export const RUN_DIR = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{8}$/;
/** A file of a run: a receipt (`<gate>.json`) or `summary.json`. */
const RUN_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/;
/** A copy interrupted before its rename is removed after this delay. */
const STALE_TEMP_MS = 3_600_000;

export interface Manifest {
  version: 1;
  runId: string;
  /** Commit of the run (from its summary), checked against each receipt. */
  candidateSha: string;
  /** Worktree the run happened in (may no longer exist). */
  worktree: string;
  copiedAt: string;
  /** sha256 of each file of the run, manifest excluded. */
  files: Record<string, string>;
}

/** The retention a configuration asks for: `receipts`, defaults for what is absent. */
export const receiptRetention = (config: { receipts?: Partial<ReceiptRetention> | undefined }): ReceiptRetention =>
  ({ ...DEFAULT_RECEIPT_RETENTION, ...config.receipts });

/** Absolute path of the shared store of the repository `repo` belongs to (not created). */
export async function sharedStore(git: Git, repo: string): Promise<string> {
  const out = (await git.exec(repo, ['rev-parse', '--git-common-dir'])).trim();
  invariant(out.length > 0, 'GIT', 'git rev-parse --git-common-dir returned nothing');
  const common = isAbsolute(out) ? out : resolve(repo, out);
  return join(existsSync(common) ? realpathSync(common) : common, SHARED_RECEIPTS_DIR);
}

/** Start of a run from its identifier, in milliseconds; null when the name is not a run identifier. */
export function runTime(runId: string): number | null {
  const m = RUN_DIR.exec(runId);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(t) ? t : null;
}

/** Regular files of a run directory, by name (symbolic links and subdirectories are not part of a run). */
function runFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name).sort();
}

/** The manifest of a run directory, computed from its files (the manifest itself excluded). */
export function manifestOf(dir: string, runId: string, candidateSha: string, worktree: string, now = new Date()): Manifest {
  const files: Record<string, string> = {};
  for (const name of runFiles(dir)) {
    if (name === MANIFEST || !RUN_FILE.test(name)) continue;
    files[name] = sha256(readFileSync(join(dir, name)));
  }
  return { version: 1, runId, candidateSha, worktree, copiedAt: now.toISOString(), files };
}

/**
 * Copies the run directory `local` into the shared store `store`, with its manifest, through a temporary
 * directory renamed at the end: a reader never sees a partial copy. A run already there is left as is.
 * Returns the directory of the copy.
 */
export function publishRun(store: string, local: string, runId: string, candidateSha: string, worktree: string): string {
  invariant(RUN_DIR.test(runId), 'RECEIPT_STORE', `Invalid run identifier: ${runId}`);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const target = join(store, runId);
  if (existsSync(target)) return target;
  const temp = join(store, `.tmp-${runId}-${randomUUID().slice(0, 8)}`);
  mkdirSync(temp, { mode: 0o700 });
  try {
    const manifest = manifestOf(local, runId, candidateSha, worktree);
    for (const name of Object.keys(manifest.files)) writeFileSync(join(temp, name), readFileSync(join(local, name)));
    // The digests are those of the bytes read for the copy: checked again on the copy before the rename.
    const copied = manifestOf(temp, runId, candidateSha, worktree);
    invariant(JSON.stringify(copied.files) === JSON.stringify(manifest.files), 'RECEIPT_STORE', `Receipts of ${runId} changed during their copy`);
    writeFileSync(join(temp, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  return target;
}

export type SharedRun =
  | { runId: string; dir: string; intact: true; manifest: Manifest; files: Map<string, Buffer> }
  | { runId: string; dir: string; intact: false; reason: string };

/**
 * Reads a run of the shared store and checks it against its manifest: the manifest names this run, lists
 * exactly the files present, and each file has the digest the manifest gives. Anything else: not intact,
 * with the reason; none of its receipts may count.
 */
export function readSharedRun(dir: string): SharedRun {
  const runId = basename(dir);
  const fail = (reason: string): SharedRun => ({ runId, dir, intact: false, reason });
  let manifest: Manifest;
  try { manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as Manifest; }
  catch { return fail('manifeste absent ou illisible'); }
  if (manifest === null || typeof manifest !== 'object' || manifest.version !== 1 || manifest.runId !== runId
    || typeof manifest.candidateSha !== 'string' || !/^[a-f0-9]{40,64}$/.test(manifest.candidateSha)
    || manifest.files === null || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) return fail('manifeste invalide');
  const listed = Object.keys(manifest.files).sort();
  let present: string[];
  try { present = readdirSync(dir).filter(n => n !== MANIFEST).sort(); } catch { return fail('dossier illisible'); }
  if (JSON.stringify(listed) !== JSON.stringify(present)) return fail('fichiers différents de ceux du manifeste');
  const files = new Map<string, Buffer>();
  for (const name of listed) {
    if (!RUN_FILE.test(name)) return fail(`nom de fichier inattendu : ${name}`);
    const path = join(dir, name);
    let bytes: Buffer;
    try {
      if (!lstatSync(path).isFile()) return fail(`${name} n'est pas un fichier`);
      bytes = readFileSync(path);
    } catch { return fail(`${name} illisible`); }
    if (sha256(bytes) !== manifest.files[name]) return fail(`empreinte de ${name} différente de celle du manifeste`);
    files.set(name, bytes);
  }
  return { runId, dir, intact: true, manifest, files };
}

/** The commit a run of the shared store names in its manifest, or null when the manifest is absent or invalid. */
export function manifestCommit(dir: string): string | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as { candidateSha?: unknown };
    return typeof value.candidateSha === 'string' && /^[a-f0-9]{40,64}$/.test(value.candidateSha) ? value.candidateSha : null;
  } catch { return null; }
}

/** Run directories of the shared store, by identifier (temporary copies and foreign entries left out). */
export function sharedRunIds(store: string): string[] {
  if (!existsSync(store)) return [];
  return readdirSync(store, { withFileTypes: true }).filter(e => e.isDirectory() && RUN_DIR.test(e.name)).map(e => e.name).sort();
}

export interface PruneResult { removed: string[]; kept: number; temporary: number }

/**
 * Bounded retention of the shared store: keeps the `keepRuns` most recent runs younger than `keepDays` (by the
 * start written in their identifier), removes the others, and the temporary copies older than an hour. Entries
 * that are not runs are never touched.
 */
export function pruneStore(store: string, retention: ReceiptRetention, now = Date.now()): PruneResult {
  invariant(Number.isSafeInteger(retention.keepDays) && retention.keepDays >= 1, 'RECEIPT_STORE', 'keepDays must be an integer >= 1');
  invariant(Number.isSafeInteger(retention.keepRuns) && retention.keepRuns >= 1, 'RECEIPT_STORE', 'keepRuns must be an integer >= 1');
  if (!existsSync(store)) return { removed: [], kept: 0, temporary: 0 };
  const limit = now - retention.keepDays * 86_400_000;
  const runs = sharedRunIds(store).map(id => ({ id, time: runTime(id)! })).sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : -1));
  const removed: string[] = [];
  let kept = 0;
  for (const run of runs) {
    if (kept < retention.keepRuns && run.time >= limit) { kept += 1; continue; }
    rmSync(join(store, run.id), { recursive: true, force: true });
    removed.push(run.id);
  }
  let temporary = 0;
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.tmp-')) continue;
    try {
      if (now - statSync(join(store, entry.name)).mtimeMs < STALE_TEMP_MS) continue;
      rmSync(join(store, entry.name), { recursive: true, force: true });
      temporary += 1;
    } catch { /* Removed by a concurrent prune. */ }
  }
  return { removed: removed.sort(), kept, temporary };
}

/** A run known to the worktree, the shared store, or both. */
export interface RunEntry {
  runId: string;
  candidateSha: string | null;
  stage: string | null;
  ok: boolean | null;
  dirty: boolean | null;
  /** Directory in the worktree (`.apv/receipts/<run>`), or null. */
  local: string | null;
  /** Directory in the shared store, or null. */
  shared: string | null;
  /** Shared copy intact (digests of its manifest), null without a shared copy; `reason` when not intact. */
  intact: boolean | null;
  reason: string | null;
}

interface SummaryFields { candidateSha: string | null; stage: string | null; ok: boolean | null; dirty: boolean | null }
function summaryFields(text: string | null): SummaryFields {
  const none = { candidateSha: null, stage: null, ok: null, dirty: null };
  if (text === null) return none;
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    return {
      candidateSha: typeof v['candidateSha'] === 'string' && /^[a-f0-9]{40,64}$/.test(v['candidateSha']) ? v['candidateSha'] : null,
      stage: typeof v['stage'] === 'string' ? v['stage'] : null,
      ok: typeof v['ok'] === 'boolean' ? v['ok'] : null,
      dirty: typeof v['dirty'] === 'boolean' ? v['dirty'] : null,
    };
  } catch { return none; }
}
const readText = (path: string): string | null => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

/** Runs of the worktree (`localRoot`, its `.apv/receipts`) and of the shared store, most recent first. */
export function listRuns(localRoot: string, store: string): RunEntry[] {
  const runs = new Map<string, RunEntry>();
  if (existsSync(localRoot)) {
    for (const entry of readdirSync(localRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(localRoot, entry.name);
      runs.set(entry.name, { runId: entry.name, ...summaryFields(readText(join(dir, 'summary.json'))), local: dir, shared: null, intact: null, reason: null });
    }
  }
  for (const runId of sharedRunIds(store)) {
    const run = readSharedRun(join(store, runId));
    const current = runs.get(runId);
    const fields = run.intact ? summaryFields(run.files.get('summary.json')?.toString('utf8') ?? null) : null;
    runs.set(runId, { ...(current ?? { runId, candidateSha: null, stage: null, ok: null, dirty: null, local: null }),
      ...(!current && fields ? fields : {}),
      shared: run.dir, intact: run.intact, reason: run.intact ? null : run.reason });
  }
  return [...runs.values()].sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
}

export interface ExportResult { runId: string; directory: string; source: 'local' | 'shared'; files: string[] }

/**
 * Copies a run into `<out>/<run>/` with its manifest (digests of each file): from the worktree when it has the
 * run, else from the shared store, whose copy must be intact. The destination must not exist yet.
 */
export function exportRun(worktree: string, localRoot: string, store: string, runId: string, out: string): ExportResult {
  invariant(RUN_DIR.test(runId), 'RECEIPT_EXPORT', `Identifiant d'exécution invalide : ${runId} (forme <AAAAMMJJ>T<HHMMSS>Z-<8 chiffres hexadécimaux>)`);
  const target = join(out, runId);
  invariant(!existsSync(target), 'RECEIPT_EXPORT', `La destination existe déjà : ${target}`);
  const local = join(localRoot, runId);
  let source: 'local' | 'shared';
  let files: Map<string, Buffer>;
  let manifest: Manifest;
  if (existsSync(local) && statSync(local).isDirectory()) {
    const summary = summaryFields(readText(join(local, 'summary.json')));
    invariant(summary.candidateSha !== null, 'RECEIPT_EXPORT', `summary.json absent ou illisible dans ${local}`);
    manifest = manifestOf(local, runId, summary.candidateSha, worktree);
    files = new Map(Object.keys(manifest.files).map(name => [name, readFileSync(join(local, name))]));
    invariant(Object.entries(manifest.files).every(([name, digest]) => sha256(files.get(name)!) === digest), 'RECEIPT_EXPORT', `Reçus de ${runId} modifiés pendant la copie`);
    source = 'local';
  } else {
    invariant(existsSync(join(store, runId)), 'RECEIPT_EXPORT', `Exécution introuvable dans ce worktree et dans le magasin partagé : ${runId}`);
    const run = readSharedRun(join(store, runId));
    if (!run.intact) throw new PipelineError('RECEIPT_EXPORT', `Copie partagée de ${runId} refusée : ${run.reason}`);
    manifest = run.manifest;
    files = run.files;
    source = 'shared';
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of files) writeFileSync(join(target, name), bytes);
  writeFileSync(join(target, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  return { runId, directory: target, source, files: [...files.keys()].sort() };
}
