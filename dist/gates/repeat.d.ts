import type { Gate } from '../domain/contracts.js';
import { PipelineError } from '../domain/errors.js';
import type { Git } from '../execution/git.js';
/**
 * Repetition of the changed test files (`repeatChanged` of a check, docs/APV3-SPEC.md, section 19): a test written
 * with a fixed wait, the real clock or shared data passes alone and fails at random under load, days later, in
 * someone else's full suite. The files the change adds or modifies are run again, several times, right after the
 * check passed, so that such a test is caught on the branch that brings it.
 */
export type RepeatSettings = NonNullable<Gate['repeatChanged']>;
/** A fixed wait found in a line the change adds to a repeated test file. */
export interface FixedWait {
    file: string;
    line: number;
    text: string;
}
/** What a check repeats in this run: computed once, before any wait. */
export interface RepeatPlan {
    /** The merge base of `--base` and HEAD the files are compared to; null without `--base`. */
    base: string | null;
    files: string[];
    fixedWaits: FixedWait[];
}
/** Placeholder of the number of repetitions, replaced anywhere in an argument (`--repeat-each={{repeat}}`). */
export declare const REPEAT_PLACEHOLDER = "{{repeat}}";
export declare function fixedWaitIn(line: string): boolean;
/** Lines added by a unified diff with no context (`-U0`), with their number in the new file. */
export declare function addedLines(diff: string): {
    line: number;
    text: string;
}[];
/**
 * The test files to repeat: added or modified since the merge base of `base` and HEAD, working tree included (a task
 * run may have uncommitted tests), untracked files not ignored included, deleted files never; those matching one of
 * the globs `paths`, sorted. Also the fixed waits in the lines they add (a new file: every line).
 */
export declare function planRepeat(git: Git, repo: string, baseSha: string, settings: RepeatSettings): Promise<RepeatPlan>;
/** The refusal of a run whose changed test files exceed `maxFiles`: never a silent skip. */
export declare function tooManyFiles(gateId: string, plan: RepeatPlan, settings: RepeatSettings): PipelineError;
/** The refusal of a run whose changed test files wait on durations (`fixedWaits: "refuse"`). */
export declare function fixedWaitRefusal(gateId: string, waits: readonly FixedWait[]): PipelineError;
/** The repetition command: `{{repeat}}` replaced anywhere, then `stressArgs`; the files are appended by the caller. */
export declare function repeatArgv(settings: RepeatSettings): string[];
/**
 * How many times each test failed in the output of the repetition: the lines matching `pattern` (capture group 1 when
 * present; ANSI codes removed), counted by name. A runner that reports each failed repetition on its own line (Playwright
 * `--repeat-each` with `--retries=0`, reporter `list` or `line`) gives « fails X times out of N ». 100 tests at most.
 */
export declare function repeatFailures(pattern: string | undefined, output: string): {
    test: string;
    count: number;
}[];
/** The diagnostic of a failed repetition: « test instable : échoue X fois sur N » for each test the pattern names. */
export declare function repeatDiagnostic(input: {
    files: readonly string[];
    times: number;
    failures: readonly {
        test: string;
        count: number;
    }[];
    afterRetry: boolean;
    status: string;
    timeoutMs: number;
    excerpt: string;
    hasPattern: boolean;
}): string;
