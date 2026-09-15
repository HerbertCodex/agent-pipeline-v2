import { type LanguageProfile } from './languages.js';
export interface InventorySymbol {
    name: string;
    kind: string;
    path: string;
    line: number;
    exported: boolean;
    language: string;
    test: boolean;
}
/** A text source file whose technology has no declaration grammar: indexed as a whole, by name. */
export interface InventoryUnit {
    name: string;
    path: string;
    extension: string;
    test: boolean;
}
export interface Inventory {
    sha: string;
    fileCount: number;
    /** Every tracked path at sha; kept for path-based classification, never sent to agents in full. */
    files: string[];
    languages: {
        id: string;
        files: number;
    }[];
    unitExtensions: string[];
    symbols: InventorySymbol[];
    units: InventoryUnit[];
    truncated: boolean;
}
export interface InventoryOptions {
    languages?: readonly LanguageProfile[];
    signal?: AbortSignal;
}
/**
 * Deterministic, model-free inventory of an immutable Git tree. Languages are recognised by
 * declarative profiles (extension + declaration grammar); every other text source file becomes
 * a file-level unit so that no technology is invisible and none needs a controller special case.
 */
export declare function buildInventory(repo: string, ref: string, options?: InventoryOptions): Promise<Inventory>;
/** Compact, bounded view handed to agents: the full public surface, not a lexical sample. */
export declare function inventoryForAgents(inventory: Inventory, maxSymbols?: number, maxUnits?: number): {
    sha: string;
    languages: {
        id: string;
        files: number;
    }[];
    unitExtensions: string[];
    exported: {
        name: string;
        kind: string;
        path: string;
        line: number;
    }[];
    units: string[];
    omitted: {
        exported: number;
        units: number;
        internalSymbols: number;
        testFiles: number;
    };
    truncated: boolean;
    note: string;
};
export interface InventoryDelta {
    added: {
        name: string;
        kind: string;
        path: string;
        line: number;
    }[];
    removed: {
        name: string;
        kind: string;
        path: string;
    }[];
    possibleDuplicates: {
        added: {
            name: string;
            kind: string;
            path: string;
        };
        existing: {
            name: string;
            kind: string;
            path: string;
        };
    }[];
}
/**
 * Public surface introduced by a candidate, and new names that collide (case/punctuation-insensitive)
 * with something that already existed elsewhere. A collision is a review prompt, not a verdict.
 */
export declare function diffInventory(base: Inventory, candidate: Inventory): InventoryDelta;
/** Human-readable, deterministic inventory document. */
export declare function inventoryMarkdown(inventory: Inventory): string;
