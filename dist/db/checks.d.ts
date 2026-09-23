import type { DbConfig, DbException } from './config.js';
import type { SchemaModel } from './model.js';
export type Severity = 'error' | 'warning';
export interface Finding {
    rule: string;
    severity: Severity;
    file: string;
    line: number;
    /** Object the finding is about, as used by `exceptions[].target`. */
    target: string;
    message: string;
}
export interface SuppressedFinding extends Finding {
    reason: string;
}
export declare const RULES: {
    readonly naming: "naming.english_snake_case";
    readonly fkIndex: "fk.index";
    readonly rls: "rls.enabled_forced";
    readonly policyBroad: "policy.too_broad";
    readonly definerPath: "definer.search_path";
    readonly definerGrant: "definer.execute_grant";
    readonly selectStar: "code.select_star";
    readonly userIdGuard: "redundancy.user_id_guard";
    readonly idempotency: "idempotency.create_tables";
};
/**
 * Columns a partial index predicate requires to be non-null, when it says nothing else
 * (`col is not null [and col2 is not null]`); null for any other predicate.
 */
export declare function notNullGuard(predicate: string): string[] | null;
export declare function checkModel(model: SchemaModel, config: DbConfig): Finding[];
/** Splits findings into kept and suppressed by declared exceptions (rule and target accept globs). */
export declare function applyExceptions(findings: Finding[], exceptions: DbException[]): {
    kept: Finding[];
    suppressed: SuppressedFinding[];
};
