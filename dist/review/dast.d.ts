import type { LockOwner, LockStore } from '../lock/store.js';
import type { DastSettings } from '../config/load.js';
/**
 * `apv dast run`: the dynamic security scan (ZAP or another) that the project declares in `review.dast`, run by
 * the project lead before the reviews. The review agents may not start Docker: on the pilot project the planned
 * ZAP scan never ran (four deliveries in a row, September 2026). The lead runs it once, under its lease, and hands the
 * report to the security review, which reads it.
 */
export declare const DAST_SUMMARY = "summary.json";
export declare const DAST_LOG = "dast.log";
export type DastStatus = 'passed' | 'failed' | 'timed_out' | 'lock_timeout';
export interface DastSummary {
    tool: 'apv dast run';
    version: string;
    commit: string;
    repo: string;
    clean: boolean;
    resource: string;
    command: string[];
    description: string | null;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    status: DastStatus;
    exitCode: number;
    timeoutMs: number;
    log: string;
    files: string[];
}
/**
 * Default folder of the reports: under the temporary directory of the machine, named after the copy and the
 * commit, never beside the repository nor inside the copy (removed after the reviews).
 */
export declare function defaultReportDir(repo: string, commit: string, now: Date): string;
/** Refuses a report folder inside the scanned copy (it would go with the copy) or already used by a scan. */
export declare function checkReportDir(repo: string, reportDir: string): void;
export interface DastRunOptions {
    repo: string;
    commit: string;
    clean: boolean;
    reportDir: string;
    settings: DastSettings;
    env: NodeJS.ProcessEnv;
    stderr: (s: string) => void;
    store: LockStore;
    owner: LockOwner;
    waitSeconds: number;
    now?: () => Date;
}
/**
 * Runs the scan command in the copy, under the lease `settings.resource`, output to `dast.log` of the report
 * folder, bounded by `settings.timeoutMs`; then writes `summary.json` there. The command receives the variables
 * of `DEFAULT_PASS_ENV` and `settings.passEnv` only, plus `APV_DAST_REPORT_DIR`, `APV_DAST_COMMIT` and
 * `APV_DAST_REPO`.
 */
export declare function runDast(options: DastRunOptions): Promise<DastSummary>;
