import { type Token } from './tokenizer.js';
import { type SchemaModel } from './model.js';
export interface MigrationFile {
    path: string;
    sql: string;
}
export interface ParseOptions {
    /**
     * Supabase grants EXECUTE on new functions of schema `public` to anon, authenticated and
     * service_role through default privileges. Postgres itself grants EXECUTE to PUBLIC.
     */
    supabaseDefaults?: boolean;
}
export declare const tokensText: (tokens: Token[]) => string;
/** Splits a token list on top-level separators (commas by default). */
export declare function splitTopLevel(tokens: Token[], separator?: string): Token[][];
export declare class MigrationParser {
    private readonly options;
    readonly model: SchemaModel;
    private file;
    constructor(options?: ParseOptions);
    parse(files: MigrationFile[]): SchemaModel;
    parseFile(migration: MigrationFile): void;
    private loc;
    private resolveTable;
    private statement;
    private createTable;
    private columnDefinition;
    private tableConstraint;
    private addIndex;
    private renameTable;
    private dropColumn;
    private dropConstraint;
    private alterTable;
    private createIndex;
    private alterIndex;
    private dropIndex;
    private dropTable;
    private policyClauses;
    private createPolicy;
    private alterPolicy;
    private dropPolicy;
    /** Identity argument count and types: OUT arguments are not part of the signature. */
    private signature;
    private findFunctions;
    private readSearchPath;
    private functionAttributes;
    private defaultGrants;
    private createFunction;
    private alterFunction;
    private dropFunction;
    private grantOrRevoke;
    private createType;
    private alterType;
    private dropType;
}
export declare function parseMigrations(files: MigrationFile[], options?: ParseOptions): SchemaModel;
