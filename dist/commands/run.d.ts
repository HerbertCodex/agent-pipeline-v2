import { summarize } from '../run/state.js';
import type { CommandIO } from './io.js';
export declare const usage: string;
export type RunListing = ReturnType<typeof summarize> | {
    specId: string;
    file: string;
    error: string;
};
/** Summaries of every execution of the project; an unreadable state is listed with its error. */
export declare function listRuns(repo: string): RunListing[];
export declare function run(args: string[], io: CommandIO): Promise<number>;
