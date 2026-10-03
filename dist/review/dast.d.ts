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
    /** The preparation of the copy: its dependencies installed (`npm ci`) before the command, or why not. */
    install: DastInstall;
    /** The environment file of `review.dast.envFile`: its path, whether it was loaded, how many variables; never the values. */
    envFile: {
        file: string;
        loaded: boolean;
        variables: number;
    } | null;
}
/**
 * - `done`: `npm ci` ran in the copy and passed;
 * - `skipped`: nothing to install (no `package-lock.json`, or `node_modules` already there), with the reason;
 * - `failed`: `npm ci` failed or passed its delay: the scan command never ran.
 */
export interface DastInstall {
    status: 'done' | 'skipped' | 'failed';
    reason: string;
    command: string[] | null;
    exitCode: number | null;
    durationMs: number;
}
/** The installation of the dependencies of a copy that has a lockfile and no `node_modules`. */
export declare const DAST_INSTALL: readonly ["npm", "ci", "--no-audit", "--no-fund"];
/** `~` and `~/…` as the home folder of the account; a relative path from the copy. */
export declare function envFilePath(value: string, repo: string, home?: string): string;
/** `KEY=value` lines (`export KEY=value`, quotes removed, `#` comments and blank lines skipped). */
export declare function parseEnvFile(text: string): Map<string, string>;
/**
 * The addresses of a value that leave the machine: the host of each URL (`scheme://[user[:pass]@]host[:port]`), and a
 * value that is itself a host name or an IPv4 address (`db.example.com`, `10.0.0.5:5432`). Only loopback hosts pass.
 */
export declare function remoteHosts(value: string): string[];
/**
 * Loads `review.dast.envFile`: refused (`DAST_ENV`) when it is absent, unreadable, or when a value names an address
 * outside the loopback (the scan must never target production). The refusal names the keys, never their values.
 */
export declare function loadDastEnvFile(value: string, repo: string, home?: string): {
    file: string;
    variables: Map<string, string>;
};
/**
 * Prepares the copy: with a `package-lock.json` and no `node_modules`, `npm ci` in the copy, output appended to the log,
 * bounded by `timeoutMs`. Receives the variables of the scan plus `HOME` and `USERPROFILE` (the cache of npm).
 */
export declare function prepareCopy(repo: string, env: NodeJS.ProcessEnv, logFd: number, timeoutMs: number, command?: readonly string[]): DastInstall;
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
    /** The installation of the dependencies of the copy (tests inject it); default `npm ci --no-audit --no-fund`. */
    installCommand?: readonly string[];
}
/**
 * Runs the scan command in the copy, under the lease `settings.resource`, output to `dast.log` of the report
 * folder, bounded by `settings.timeoutMs`; then writes `summary.json` there. The command receives the variables
 * of `DEFAULT_PASS_ENV` and `settings.passEnv` only, plus `APV_DAST_REPORT_DIR`, `APV_DAST_COMMIT` and
 * `APV_DAST_REPO`.
 */
export declare function runDast(options: DastRunOptions): Promise<DastSummary>;
