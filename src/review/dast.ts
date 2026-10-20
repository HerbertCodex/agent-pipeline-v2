import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
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
  mkdirSync(reportDir, { recursive: true });
  const command = expandCommand(settings.command, { reportDir, commit: options.commit, repo: options.repo });
  const env = {
    ...environment([...DEFAULT_PASS_ENV, ...settings.passEnv], options.env),
    APV_DAST_REPORT_DIR: reportDir, APV_DAST_COMMIT: options.commit, APV_DAST_REPO: options.repo,
    ...(options.env['APV_LOCK_HELD'] ? { APV_LOCK_HELD: options.env['APV_LOCK_HELD'] } : {}),
  };
  const started = now();
  let acquired = false;
  const log = openSync(join(reportDir, DAST_LOG), 'w', 0o644);
  let code: number;
  try {
    code = await runLocked(options.store, settings.resource, {
      owner: options.owner, ttlSeconds: 300, waitSeconds: options.waitSeconds, purpose: `apv dast run (${options.commit.slice(0, 12)})`,
      command, cwd: options.repo, env, stderr: options.stderr, stdio: ['ignore', log, log], timeoutMs: settings.timeoutMs,
      onAcquired: () => { acquired = true; },
    });
  } finally { closeSync(log); }
  const finished = now();
  const durationMs = finished.getTime() - started.getTime();
  const status: DastStatus = !acquired && code === LOCK_WAIT_TIMEOUT_EXIT ? 'lock_timeout'
    : code === 0 ? 'passed' : code === TIMEOUT_EXIT && durationMs >= settings.timeoutMs ? 'timed_out' : 'failed';
  const summary: DastSummary = {
    tool: 'apv dast run', version: VERSION, commit: options.commit, repo: options.repo, clean: options.clean,
    resource: settings.resource, command, description: settings.description ?? null,
    startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs, status, exitCode: code,
    timeoutMs: settings.timeoutMs, log: DAST_LOG, files: listFiles(reportDir),
  };
  writeSummary(reportDir, summary);
  return summary;
}
