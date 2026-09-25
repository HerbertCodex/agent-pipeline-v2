/**
 * Journal of readings, one JSON object per line, read back by `apv status` and the SessionStart hook.
 * It lives with the other machine journals in `.apv/state/`, ignored by Git (`.apv/.gitignore`).
 */
export declare const QUOTA_LOG = ".apv/state/quota.log";
/** `claude -p "/usage"` starts a whole session: it can take more than a minute on a busy machine. */
export declare const QUOTA_TIMEOUT_MS = 150000;
export declare const QUOTA_COMMAND: readonly ["-p", "/usage", "--setting-sources", ""];
/** Spec section 9: 70 % slow down, 85 % finish running work only, 95 % save and warn the operator. */
export declare const QUOTA_THRESHOLDS: {
    readonly slow_down: 70;
    readonly finish_only: 85;
    readonly save_now: 95;
};
export declare const quotaLevels: readonly ["ok", "slow_down", "finish_only", "save_now", "unknown"];
export type QuotaLevel = typeof quotaLevels[number];
export interface UsageWindow {
    percent: number;
    resets: string | null;
}
export interface QuotaReading {
    at: string;
    /** Five-hour window. */
    session: UsageWindow | null;
    /** Weekly window, all models. */
    week: UsageWindow | null;
    /** Highest of the two percentages; the level is classified on it. */
    percent: number | null;
    level: QuotaLevel;
    /** The window that sets `percent` (the week on a tie: it resets later); null when none was read. Absent from older journal lines. */
    binding?: 'session' | 'week' | null;
}
/** Reads the session and weekly lines of `/usage`; other lines (per-model weeks, headers) are ignored. */
export declare function parseUsage(output: string): {
    session: UsageWindow | null;
    week: UsageWindow | null;
};
export declare function classifyQuota(percent: number | null): QuotaLevel;
export declare function reading(output: string, at?: Date): QuotaReading;
export interface CommandOutcome {
    status: string;
    stdout: string;
    stderr: string;
}
/** How `/usage` is obtained; tests inject a fake instead of calling `claude`. */
export type UsageRunner = (argv: readonly string[], timeoutMs: number) => Promise<CommandOutcome>;
/** Runs the real CLI with the caller's environment: `claude` needs HOME and its own credentials. */
export declare function processRunner(env: NodeJS.ProcessEnv, cwd: string): UsageRunner;
export interface QuotaOutcome {
    reading: QuotaReading;
    command: CommandOutcome;
}
export declare function readQuota(runner: UsageRunner, executable?: string, at?: () => Date): Promise<QuotaOutcome>;
export declare function appendQuotaLog(file: string, value: QuotaReading): void;
/** Last well-formed reading of the journal, or null. */
export declare function lastQuotaReading(file: string): QuotaReading | null;
