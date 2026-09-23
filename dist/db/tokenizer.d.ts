/**
 * Light SQL tokenizer for Postgres migrations: enough to follow DDL, not a full grammar.
 * Comments are dropped; strings, dollar-quoted bodies and quoted identifiers are single tokens.
 */
export type TokenKind = 'word' | 'qident' | 'string' | 'number' | 'punct' | 'op';
export interface Token {
    kind: TokenKind;
    /** Lowercased for words (unquoted identifiers fold to lowercase), unescaped content otherwise. */
    value: string;
    /** Source text as written. */
    text: string;
    line: number;
}
export interface Statement {
    tokens: Token[];
    line: number;
}
export declare class SqlSyntaxError extends Error {
    readonly line: number;
    constructor(message: string, line: number);
}
export declare function tokenize(sql: string): Token[];
/** Splits on top-level semicolons. `begin atomic ... end` bodies (SQL-standard functions) stay whole. */
export declare function splitStatements(tokens: Token[]): Statement[];
