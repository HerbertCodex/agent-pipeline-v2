import type { FindingCode, Severity, StructureSettings } from './config.js';
/** A proposed move, `from` and `to` relative to the repository root. Never applied by the tool. */
export interface Move {
    from: string;
    to: string;
}
export interface Finding {
    code: FindingCode;
    severity: Severity;
    folder: string;
    /** Main files concerned (their tests and companion files follow them in the moves). */
    files: string[];
    proposal: string;
    moves: Move[];
}
export interface FolderSummary {
    folder: string;
    /** Code files directly in the folder, tests and companion files apart. */
    code: number;
    tests: number;
    companions: number;
    /** Main files of a folder with a finding that no move places: left to the operator. */
    unplaced: string[];
}
export interface StructureReport {
    ok: boolean;
    analyzedFiles: number;
    maxFlatFiles: number;
    folders: FolderSummary[];
    findings: Finding[];
    /** Every proposed move (companions and tests included), sorted and without duplicates. */
    plan: Move[];
}
export interface AnalyzeOptions {
    /** Restricts the findings to these folders and their subfolders (repository-relative). */
    paths?: readonly string[];
}
/**
 * Deterministic analysis of a list of tracked paths: findings per folder and a move plan. Pure: reads no
 * file, runs nothing, applies nothing.
 */
export declare function analyzeStructure(paths: readonly string[], settings: StructureSettings, options?: AnalyzeOptions): StructureReport;
