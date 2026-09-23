import type { JsonSchema, Schema } from './schema.js';
/** One validation problem. Validators that report issues list them all instead of stopping at the first. */
export interface Issue {
    code: string;
    message: string;
}
/** Collects issues where a V2 validator used `invariant`; `ok` keeps the checked condition usable as a guard. */
export declare class IssueList {
    readonly items: Issue[];
    check(condition: unknown, code: string, message: string): boolean;
    /** Runs a V2 check that throws, recording its error instead of propagating it. */
    attempt<T>(code: string, action: () => T): T | undefined;
    get empty(): boolean;
    /** V2 contract: throw the first issue, exactly as the former `invariant` sequence did. */
    throwFirst(): void;
}
/**
 * Every schema violation of `value`, walking the JSON Schema that `s.*` builders publish (the same
 * definitions the runtime parser uses). The parser stops at the first problem; this lists them all so an
 * author fixes a document in one pass. It understands exactly the vocabulary `schema.ts` emits.
 */
export declare function jsonSchemaIssues(json: JsonSchema, value: unknown, path?: string): Issue[];
/** All schema issues, then the parser as a safety net: a value the walker accepts must also parse. */
export declare function schemaIssues<T>(schema: Schema<T>, value: unknown): {
    value: T | undefined;
    issues: Issue[];
};
