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
 * - `done`: `npm ci` ran in the copy and passed (its marker written);
 * - `skipped`: nothing to install (no `package-lock.json`, or the marker of a successful installation of this very
 *   lockfile), with the reason;
 * - `failed`: `npm ci` failed; `timed_out`: it passed its delay. In both cases the scan command never ran.
 */
export interface DastInstall {
    status: 'done' | 'skipped' | 'failed' | 'timed_out';
    reason: string;
    command: string[] | null;
    exitCode: number | null;
    durationMs: number;
}
/**
 * The installation of the dependencies of the copy, without the scripts of the packages (`preinstall`, `postinstall`):
 * they would run outside the lease of the scan.
 */
export declare const DAST_INSTALL: readonly ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"];
/** Written in `node_modules` after a successful installation: the sha256 of the lockfile it installed. */
export declare const DAST_INSTALL_MARKER = ".apv-dast-install";
export declare const LOOPBACK_TEXT = "seuls localhost, *.localhost, 127.0.0.0/8 et ::1 sont admis";
/**
 * Why a value of an environment file names an address outside the loopback, or null. Each word of the value is read
 * (a list, a JSON object, a libpq string `host=… port=…`): a URL (`scheme://`, `//`), `user@host`, `host=`, an IPv4 or
 * IPv6 address, a host name with a dot (`db.prod.example.com`, `bdd.exämple.fr`, with a trailing dot) must be loopback;
 * in a variable that names an address (`*_HOST`, `*_URL`...) or after `host`, a bare name (`prodserver`) or a number
 * beyond a port too. An e-mail address on a domain reserved for examples (`demo@example.org`) is a test account, not a
 * host. Never returns the value.
 */
export declare function addressRefusal(key: string, value: string): string | null;
/** `~` and `~/…` as the home folder of the account; a relative path from the copy. */
export declare function envFilePath(value: string, repo: string, home?: string): string;
/** `KEY=value` lines (`export KEY=value`, quotes removed, `#` comments and blank lines skipped). */
export declare function parseEnvFile(text: string): Map<string, string>;
/**
 * Loads `review.dast.envFile`: refused (`DAST_ENV`) when it is absent, unreadable, sets a reserved variable (`APV_*`,
 * `PATH`, `NODE_OPTIONS`, `HOME`...), or when a value names an address outside the loopback (the scan never targets
 * production). The refusal names the keys, never their values.
 */
export declare function loadDastEnvFile(value: string, repo: string, home?: string): {
    file: string;
    variables: Map<string, string>;
};
/**
 * Prepares the copy: with a `package-lock.json`, `npm ci --ignore-scripts` in the copy unless the marker of a successful
 * installation of this very lockfile is there (an interrupted installation leaves a partial `node_modules`, never the
 * marker), output appended to the log, bounded by `timeoutMs`. Receives the variables of the scan (never those of the
 * environment file) plus `HOME` and `USERPROFILE` (the cache of npm).
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
