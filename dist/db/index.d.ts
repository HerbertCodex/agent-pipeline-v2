import { type Finding, type SuppressedFinding } from './checks.js';
import { type DbConfig } from './config.js';
import { type LiveReport, type PsqlRunner } from './live.js';
import type { SchemaModel } from './model.js';
export interface DbCheckOptions {
    root: string;
    configPath?: string;
    live?: boolean;
    env?: NodeJS.ProcessEnv;
    /** Test seam for `--live`. */
    psql?: PsqlRunner;
}
export interface DbCheckReport {
    root: string;
    configPath: string | null;
    config: DbConfig;
    migrations: string[];
    codeFiles: string[];
    model: SchemaModel;
    findings: Finding[];
    suppressed: SuppressedFinding[];
    live: LiveReport | null;
    errors: number;
    warnings: number;
}
export declare function runDbCheck(options: DbCheckOptions): DbCheckReport;
export declare function formatHuman(report: DbCheckReport): string;
export declare function formatJson(report: DbCheckReport): string;
export { parseMigrations } from './parser.js';
export { checkModel, applyExceptions, RULES } from './checks.js';
export type { Finding, SuppressedFinding } from './checks.js';
