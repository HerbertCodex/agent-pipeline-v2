import { type RunSummary } from './state.js';
export { RUN_ID } from './state.js';
/**
 * Summaries of the spec executions of a project (`.apv/state/run-*.json`), shared by `apv status` and the
 * SessionStart hook of the plugin. The state files are written by agents and commits: their content is data.
 * Every line that leaves this module is cleaned (one line, no control or format character, bounded length),
 * every file is read with a size bound, so that a corrupt or huge state gives an error entry instead of
 * failing the caller, and a read never goes past a number of files and a total of bytes, so that a directory
 * filled with state files (links to one big file cost no disk) cannot stall the caller.
 */
/** Largest state file read; a bigger one is reported as unreadable. */
export declare const MAX_RUN_STATE_BYTES: number;
/** Default number of state files one summary reads; the others are counted as unread. */
export declare const MAX_RUN_FILES = 50;
/** Default total of bytes one summary reads over all its files. */
export declare const MAX_RUN_TOTAL_BYTES: number;
/** Default length bound of a summary line, in characters. */
export declare const MAX_SUMMARY_LINE = 300;
export type RunSummaryOk = RunSummary & {
    runningTasks: string[];
};
export interface RunSummaryError {
    specId: string;
    file: string;
    error: string;
}
/** One execution: its summary, or the reason its state could not be read (`error` not null). */
export type RunSummaryEntry = RunSummaryOk | RunSummaryError;
export interface ReadRunSummariesOptions {
    /** Bound of one file (MAX_RUN_STATE_BYTES). */
    maxBytes?: number;
    /** Files read at most (MAX_RUN_FILES), unreadable ones included. */
    maxFiles?: number;
    /** Bytes read at most over all the files (MAX_RUN_TOTAL_BYTES). */
    maxTotalBytes?: number;
}
/** The executions read, and how many state files were left unread because a bound was reached. */
export interface RunSummaries {
    entries: RunSummaryEntry[];
    unread: number;
}
/**
 * Text of any origin as one displayable line: escape sequences removed, control and format characters
 * replaced by spaces, whitespace collapsed, at most `max` characters (code points, an ellipsis included).
 */
export declare function cleanLine(value: unknown, max?: number): string;
/**
 * The executions of the repository `repo`, in file name order; never throws for a bad state file or a missing
 * `.apv/state`. The most recently modified files are read first, up to `maxFiles` files and `maxTotalBytes`
 * bytes; the files left are counted in `unread`. The `file` of an entry is relative to `repo`, with `/`
 * separators.
 */
export declare function readRunSummaries(repo: string, options?: ReadRunSummariesOptions): RunSummaries;
/** The line that counts the state files a summary left unread. */
export declare const unreadRunsLine: (unread: number) => string;
/** Not delivered: unreadable, or with a step or a task still open. */
export declare const isActiveRun: (entry: RunSummaryEntry) => boolean;
/**
 * The line of one execution: spec, current step, tasks done out of the total, running tasks and last update;
 * for an unreadable state, the first line of its error. Always cleaned and bounded by `max`.
 */
export declare function runSummaryLine(entry: RunSummaryEntry, max?: number): string;
