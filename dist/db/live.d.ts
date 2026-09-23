import type { DbConfig } from './config.js';
import type { Finding } from './checks.js';
export interface LiveReport {
    status: 'skipped' | 'ran' | 'failed';
    reason: string | null;
    findings: Finding[];
    /** One line per executed check, for the human report. */
    details: string[];
}
export type PsqlRunner = (sql: string) => string;
export declare const LIVE_RULES: {
    readonly fkIndex: "live.fk_index";
    readonly rls: "live.rls";
    readonly seqScan: "live.explain_seq_scan";
    readonly error: "live.error";
    readonly skipped: "live.skipped";
};
export declare function findExecutable(name: string, env: NodeJS.ProcessEnv): string | null;
/** Connection settings passed through libpq variables: the password never appears in the process list. */
export declare function connectionEnv(url: string): {
    env: Record<string, string>;
    args: string[];
};
/**
 * Splits a command line written in one variable (APV_PSQL) into argv, without a shell: blanks
 * separate words, single quotes are literal, double quotes and backslashes escape. No expansion.
 */
export declare function splitCommand(text: string): string[];
/**
 * Every script runs in a session whose transactions are read-only: the live checks only read the
 * catalog and EXPLAIN (never ANALYZE), and a configured query can never write, even by mistake.
 */
export declare const READ_ONLY_PREFIX = "set default_transaction_read_only = on;\n";
/**
 * Runs psql with `-f -`. `psql` is an executable path, or a whole command (APV_PSQL, for example
 * `docker exec -i <conteneur> psql -U postgres -d postgres`) to which the psql options are appended.
 * With a URL, the connection goes through libpq variables; without one, the command carries it.
 */
export declare function psqlRunner(psql: string | readonly string[], url: string | undefined, baseEnv: NodeJS.ProcessEnv): PsqlRunner;
/** Parses psql output; tolerates command tags (BEGIN, ROLLBACK) around the JSON value. */
export declare function parseJsonOutput<T>(output: string): T | null;
export declare const FK_INDEX_SQL: (schemas: string[]) => string;
export declare const RLS_SQL: (schemas: string[]) => string;
export declare const EXPLAIN_SQL: (sql: string) => string;
export declare const RELTUPLES_SQL: (relations: string[]) => string;
interface PlanNode {
    'Node Type'?: string;
    'Relation Name'?: string;
    Schema?: string;
    'Plan Rows'?: number;
    Plans?: PlanNode[];
}
export declare function seqScans(plan: PlanNode, found?: {
    relation: string;
    planRows: number;
}[]): {
    relation: string;
    planRows: number;
}[];
/**
 * Live checks, read-only: missing FK indexes, RLS state, EXPLAIN of the configured queries. The
 * database is reached by APV_PSQL (a whole psql command, which carries its own connection, for
 * example through `docker exec`), or by psql from the PATH with APV_DB_URL. Skipped, and said so,
 * when neither is usable.
 */
export declare function runLiveChecks(config: DbConfig, env: NodeJS.ProcessEnv, runner?: PsqlRunner): LiveReport;
export {};
