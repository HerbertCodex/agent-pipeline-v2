export interface DbExplainQuery {
    name: string;
    sql: string;
}
export interface DbException {
    rule: string;
    target: string;
    reason: string;
}
export interface DbConfig {
    /** Migration glob(s), applied in file name order. */
    migrations: string[];
    /** Application code scanned for `select *` (`db.code` in the configuration file). */
    codeGlobs: string[];
    /** Code excluded from the scan (tests may read whole rows). */
    codeExclude: string[];
    /** French words (or whole identifiers) accepted by the naming rule. */
    allowFrench: string[];
    /** Declared exceptions: rule id (or glob), target (or glob) and a mandatory reason. */
    exceptions: DbException[];
    /** Tables that need RLS enabled, forced and a policy even without a `user_id` column (`schema.table`). */
    rlsTables: string[];
    /** Queries checked by `--live` with EXPLAIN. */
    explain: DbExplainQuery[];
    /** A sequential scan on a table with more estimated rows than this is an error (`--live`). */
    seqScanRows: number;
    /** Model Supabase default privileges (EXECUTE for anon, authenticated, service_role on schema public). */
    supabaseDefaults: boolean;
    /** Schemas read by `--live`. */
    liveSchemas: string[];
}
export declare const DEFAULT_DB_CONFIG: DbConfig;
export interface LoadedConfig {
    config: DbConfig;
    path: string | null;
    problems: string[];
}
/** Reads `db` from `.apv/config.json` (or `configPath`); unknown or invalid fields are reported, never ignored silently. */
export declare function loadDbConfig(root: string, configPath?: string): LoadedConfig;
