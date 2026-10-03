import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_PASS_ENV, VERSION } from '../domain/contracts.js';
import { PipelineError } from '../domain/errors.js';
import { environment, expandCommand } from '../execution/process.js';
import { isInside } from '../execution/git.js';
import { canonicalPath } from '../domain/paths.js';
import { LOCK_WAIT_TIMEOUT_EXIT, TIMEOUT_EXIT, runLocked } from '../lock/run.js';
import type { LockOwner, LockStore } from '../lock/store.js';
import type { DastSettings } from '../config/load.js';

/**
 * `apv dast run`: the dynamic security scan (ZAP or another) that the project declares in `review.dast`, run by
 * the project lead before the reviews. The review agents may not start Docker: on the pilot project the planned
 * ZAP scan never ran (four deliveries in a row, September 2026). The lead runs it once, under its lease, and hands the
 * report to the security review, which reads it.
 */

export const DAST_SUMMARY = 'summary.json';
export const DAST_LOG = 'dast.log';
/** Files listed in the summary, at most. */
const MAX_LISTED = 200;

export type DastStatus = 'passed' | 'failed' | 'timed_out' | 'lock_timeout';
export interface DastSummary {
  tool: 'apv dast run'; version: string;
  commit: string; repo: string; clean: boolean;
  resource: string; command: string[]; description: string | null;
  startedAt: string; finishedAt: string; durationMs: number;
  status: DastStatus; exitCode: number;
  timeoutMs: number; log: string; files: string[];
  /** The preparation of the copy: its dependencies installed (`npm ci`) before the command, or why not. */
  install: DastInstall;
  /** The environment file of `review.dast.envFile`: its path, whether it was loaded, how many variables; never the values. */
  envFile: { file: string; loaded: boolean; variables: number } | null;
}

/**
 * - `done`: `npm ci` ran in the copy and passed;
 * - `skipped`: nothing to install (no `package-lock.json`, or `node_modules` already there), with the reason;
 * - `failed`: `npm ci` failed or passed its delay: the scan command never ran.
 */
export interface DastInstall { status: 'done' | 'skipped' | 'failed'; reason: string; command: string[] | null; exitCode: number | null; durationMs: number }

/** The installation of the dependencies of a copy that has a lockfile and no `node_modules`. */
export const DAST_INSTALL = ['npm', 'ci', '--no-audit', '--no-fund'] as const;

/** Hosts that never leave the machine: the scan may only target these through the environment file. */
const LOOPBACK = /^(?:localhost|[\w-]+\.localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0:0:0:0:0:0:0:1)$/i;

/** `~` and `~/…` as the home folder of the account; a relative path from the copy. */
export function envFilePath(value: string, repo: string, home: string = homedir()): string {
  const expanded = value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value;
  return isAbsolute(expanded) ? expanded : resolve(repo, expanded);
}

/** `KEY=value` lines (`export KEY=value`, quotes removed, `#` comments and blank lines skipped). */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) throw new PipelineError('DAST_ENV', `review.dast.envFile : ligne ${i + 1} illisible (KEY=valeur attendu)`);
    let value = m[2]!;
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out.set(m[1]!, value);
  }
  return out;
}

/**
 * The addresses of a value that leave the machine: the host of each URL (`scheme://[user[:pass]@]host[:port]`), and a
 * value that is itself a host name or an IPv4 address (`db.example.com`, `10.0.0.5:5432`). Only loopback hosts pass.
 */
export function remoteHosts(value: string): string[] {
  const hosts: string[] = [];
  for (const m of value.matchAll(/[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/?#\s,;]+)/gi)) hosts.push(m[1]!);
  const bare = /^((?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:\/.*)?$/i.exec(value.trim());
  if (bare && !/:\/\//.test(value)) hosts.push(bare[1]!);
  for (const m of value.matchAll(/(?<![\w.])((?:\d{1,3}\.){3}\d{1,3})(?![\w.])/g)) hosts.push(m[1]!);
  return [...new Set(hosts)].filter(h => !LOOPBACK.test(h));
}

/**
 * Loads `review.dast.envFile`: refused (`DAST_ENV`) when it is absent, unreadable, or when a value names an address
 * outside the loopback (the scan must never target production). The refusal names the keys, never their values.
 */
export function loadDastEnvFile(value: string, repo: string, home?: string): { file: string; variables: Map<string, string> } {
  const file = envFilePath(value, repo, home || homedir());
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { throw new PipelineError('DAST_ENV', `review.dast.envFile introuvable ou illisible : ${file}`); }
  const variables = parseEnvFile(text);
  const remote = [...variables].filter(([, v]) => remoteHosts(v).length).map(([k]) => k);
  if (remote.length) {
    throw new PipelineError('DAST_ENV', `review.dast.envFile (${file}) refusé : ${remote.join(', ')} désigne(nt) une adresse hors bouclage (seuls localhost et 127.0.0.1 sont admis) ; le scan ne vise jamais la production. Rien n'est lancé.`);
  }
  return { file, variables };
}

/**
 * Prepares the copy: with a `package-lock.json` and no `node_modules`, `npm ci` in the copy, output appended to the log,
 * bounded by `timeoutMs`. Receives the variables of the scan plus `HOME` and `USERPROFILE` (the cache of npm).
 */
export function prepareCopy(repo: string, env: NodeJS.ProcessEnv, logFd: number, timeoutMs: number, command: readonly string[] = DAST_INSTALL): DastInstall {
  if (!existsSync(join(repo, 'package-lock.json'))) return { status: 'skipped', reason: 'pas de package-lock.json dans la copie', command: null, exitCode: null, durationMs: 0 };
  if (existsSync(join(repo, 'node_modules'))) return { status: 'skipped', reason: 'node_modules déjà présent dans la copie', command: null, exitCode: null, durationMs: 0 };
  const started = Date.now();
  writeSync(logFd, `[apv dast] installation des dépendances de la copie : ${command.join(' ')}\n`);
  const r = spawnSync(command[0]!, command.slice(1), { cwd: repo, env, stdio: ['ignore', logFd, logFd], timeout: timeoutMs, killSignal: 'SIGTERM' });
  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.error ? 127 : 1);
  if (r.error || r.status !== 0) {
    const why = r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? `délai dépassé (${Math.round(timeoutMs / 1000)} s)` : r.error ? r.error.message : `code ${exitCode}`;
    return { status: 'failed', reason: `${command.join(' ')} en échec : ${why}`, command: [...command], exitCode, durationMs };
  }
  return { status: 'done', reason: 'node_modules absent, package-lock.json présent', command: [...command], exitCode: 0, durationMs };
}

/**
 * Default folder of the reports: under the temporary directory of the machine, named after the copy and the
 * commit, never beside the repository nor inside the copy (removed after the reviews).
 */
export function defaultReportDir(repo: string, commit: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return join(canonicalPath(tmpdir()), 'apv-dast', `${basename(repo)}-${commit.slice(0, 12)}-${stamp}`);
}

/** Refuses a report folder inside the scanned copy (it would go with the copy) or already used by a scan. */
export function checkReportDir(repo: string, reportDir: string): void {
  // Canonical paths on both sides: Git gives the resolved root (macOS: /var is /private/var), a symbolic link
  // may lead into the copy; comparing the written paths let a folder inside the copy through.
  if (isInside(canonicalPath(repo), canonicalPath(reportDir))) {
    throw new PipelineError('DAST_OUT', `Dossier des rapports dans la copie scannée (${reportDir}) : la copie est retirée après les revues ; choisir un dossier hors du dépôt (le dossier de session, par exemple)`);
  }
  if (existsSync(join(reportDir, DAST_SUMMARY))) {
    throw new PipelineError('DAST_OUT', `${join(reportDir, DAST_SUMMARY)} existe déjà : un dossier par scan (apv wait --file sur ce résumé rendrait la main tout de suite)`);
  }
}

/** Files of the report folder (relative, sorted), summary excluded, at most MAX_LISTED. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number): void => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_LISTED) return;
      const path = join(current, entry.name);
      if (entry.isDirectory()) { if (depth < 3) walk(path, depth + 1); continue; }
      const rel = relative(dir, path).split(sep).join('/');
      if (rel !== DAST_SUMMARY) out.push(rel);
    }
  };
  walk(dir, 0);
  return out;
}

/** Atomic write: `apv wait --file <dossier>/summary.json` never sees half a summary. */
function writeSummary(dir: string, summary: DastSummary): void {
  const file = join(dir, DAST_SUMMARY);
  const tmp = join(dir, `.${DAST_SUMMARY}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o644);
  try { writeSync(fd, `${JSON.stringify(summary, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, file); } catch (error) { rmSync(tmp, { force: true }); throw error; }
}

export interface DastRunOptions {
  repo: string; commit: string; clean: boolean; reportDir: string; settings: DastSettings;
  env: NodeJS.ProcessEnv; stderr: (s: string) => void; store: LockStore; owner: LockOwner; waitSeconds: number;
  now?: () => Date;
  /** The installation of the dependencies of the copy (tests inject it); default `npm ci --no-audit --no-fund`. */
  installCommand?: readonly string[];
}

/**
 * Runs the scan command in the copy, under the lease `settings.resource`, output to `dast.log` of the report
 * folder, bounded by `settings.timeoutMs`; then writes `summary.json` there. The command receives the variables
 * of `DEFAULT_PASS_ENV` and `settings.passEnv` only, plus `APV_DAST_REPORT_DIR`, `APV_DAST_COMMIT` and
 * `APV_DAST_REPO`.
 */
export async function runDast(options: DastRunOptions): Promise<DastSummary> {
  const now = options.now ?? (() => new Date());
  const { settings } = options;
  const reportDir = canonicalPath(options.reportDir);
  checkReportDir(options.repo, reportDir);
  // The environment file first: an address outside the loopback refuses the scan before anything runs or is written.
  const loaded = settings.envFile !== undefined ? loadDastEnvFile(settings.envFile, options.repo, options.env['HOME']) : null;
  mkdirSync(reportDir, { recursive: true });
  const command = expandCommand(settings.command, { reportDir, commit: options.commit, repo: options.repo });
  const base = environment([...DEFAULT_PASS_ENV, ...settings.passEnv], options.env);
  const env = {
    ...base, ...(loaded ? Object.fromEntries(loaded.variables) : {}),
    APV_DAST_REPORT_DIR: reportDir, APV_DAST_COMMIT: options.commit, APV_DAST_REPO: options.repo,
    ...(options.env['APV_LOCK_HELD'] ? { APV_LOCK_HELD: options.env['APV_LOCK_HELD'] } : {}),
  };
  const started = now();
  let acquired = false;
  const log = openSync(join(reportDir, DAST_LOG), 'w', 0o644);
  let code: number;
  let install: DastInstall;
  let commandMs = 0;
  try {
    // The copy prepared before the lease: an installation takes no shared resource.
    install = prepareCopy(options.repo, { ...base, ...environment(['HOME', 'USERPROFILE'], options.env) }, log, settings.timeoutMs, options.installCommand);
    if (install.status === 'failed') code = install.exitCode ?? 1;
    else {
      const commandStarted = now().getTime();
      code = await runLocked(options.store, settings.resource, {
        owner: options.owner, ttlSeconds: 300, waitSeconds: options.waitSeconds, purpose: `apv dast run (${options.commit.slice(0, 12)})`,
        command, cwd: options.repo, env, stderr: options.stderr, stdio: ['ignore', log, log], timeoutMs: settings.timeoutMs,
        onAcquired: () => { acquired = true; },
      });
      commandMs = now().getTime() - commandStarted;
    }
  } finally { closeSync(log); }
  const finished = now();
  const durationMs = finished.getTime() - started.getTime();
  const status: DastStatus = install.status === 'failed' ? 'failed' : !acquired && code === LOCK_WAIT_TIMEOUT_EXIT ? 'lock_timeout'
    : code === 0 ? 'passed' : code === TIMEOUT_EXIT && commandMs >= settings.timeoutMs ? 'timed_out' : 'failed';
  const summary: DastSummary = {
    tool: 'apv dast run', version: VERSION, commit: options.commit, repo: options.repo, clean: options.clean,
    resource: settings.resource, command, description: settings.description ?? null,
    startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs, status, exitCode: code,
    timeoutMs: settings.timeoutMs, log: DAST_LOG, files: listFiles(reportDir), install,
    envFile: settings.envFile !== undefined ? { file: loaded!.file, loaded: true, variables: loaded!.variables.size } : null,
  };
  writeSummary(reportDir, summary);
  return summary;
}
