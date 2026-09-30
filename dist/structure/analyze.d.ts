import { type FindingCode, type Severity, type StructureSettings } from './config.js';
import { type SplitGroup, type UsageGraph } from './split.js';
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
    /** flat-folder with a usage graph: the proposed subfolders, with their reasons and conventions. */
    groups?: SplitGroup[];
    /** flat-folder with a usage graph: files used together that no name of the project describes, to be named by the operator. */
    unnamed?: {
        members: string[];
        reasons: string[];
    }[];
    /** flat-folder: a folder of primitives (`components/ui`), never split by use (a flat list or one folder per component). */
    primitives?: boolean;
    /** flat-folder with a usage graph: files most of the folder imports, which stay at its root. */
    core?: {
        path: string;
        reason: string;
    }[];
    /** `apv structure check`: the finding concerns a file the change creates or moves (always true without base). */
    isNew?: boolean;
    /** `apv structure check`: severity `error` and new. */
    blocking?: boolean;
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
    /**
     * Who imports whom (src/structure/split.ts): a flat folder is then split by proximity of use, even without a common
     * prefix. Without it, only the names are read.
     */
    usage?: UsageGraph;
    /** Files always analysed, default exclusions or not (what the change creates). */
    always?: ReadonlySet<string>;
    /** Groups proposed by a first pass (folder -> groups), for the folders of the same domain: set by analyzeStructure itself. */
    proposed?: ReadonlyMap<string, readonly {
        dir: string;
        members: readonly string[];
    }[]>;
}
export declare function isPrimitivesFolder(dir: string): boolean;
/**
 * Deterministic analysis of a list of tracked paths: findings per folder and a move plan. Pure: reads no
 * file, runs nothing, applies nothing.
 */
export declare function analyzeStructure(paths: readonly string[], settings: StructureSettings, options?: AnalyzeOptions): StructureReport;
