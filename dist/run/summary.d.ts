import { type RunSummary } from './state.js';
export { RUN_ID } from './state.js';
/**
 * Summaries of the spec executions of a project (`.apv/state/run-*.json`), shared by `apv status` and the
 * SessionStart hook of the plugin. The state files are written by agents and commits: their content is data.
 * Every line that leaves this module is cleaned (one line, no control or format character, bounded length),
 * and every file is read with a size bound, so that a corrupt or huge state gives an error entry instead of
 * failing the caller.
 */
/** Largest state file read; a bigger one is reported as unreadable. */
export declare const MAX_RUN_STATE_BYTES: number;
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
    maxBytes?: number;
}
/**
 * Text of any origin as one displayable line: escape sequences removed, control and format characters
 * replaced by spaces, whitespace collapsed, at most `max` characters (code points, an ellipsis included).
 */
export declare function cleanLine(value: unknown, max?: number): string;
/**
 * Every execution of the repository `repo`, in file name order; never throws for a bad state file or a
 * missing `.apv/state`. The `file` of an entry is relative to `repo`, with `/` separators.
 */
export declare function readRunSummaries(repo: string, options?: ReadRunSummariesOptions): RunSummaryEntry[];
/** Not delivered: unreadable, or with a step or a task still open. */
export declare const isActiveRun: (entry: RunSummaryEntry) => boolean;
/**
 * The line of one execution: spec, current step, tasks done out of the total, running tasks and last update;
 * for an unreadable state, the first line of its error. Always cleaned and bounded by `max`.
 */
export declare function runSummaryLine(entry: RunSummaryEntry, max?: number): string;
