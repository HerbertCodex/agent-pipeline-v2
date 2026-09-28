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
    /** The merge base of `--base` and HEAD the files are compared to. */
    base: string;
    /** The merge base of the reference (the branch the change goes to, `repeatChanged.reference`) and HEAD, when used. */
    reference: string | null;
    files: string[];
    fixedWaits: FixedWait[];
}
/** Placeholder of the number of repetitions, replaced anywhere in an argument (`--repeat-each={{repeat}}`). */
export declare const REPEAT_PLACEHOLDER = "{{repeat}}";
/** The refusal of a full run whose reference does not resolve: the changes would be counted from `--base` alone. */
export declare function referenceMissing(gateId: string, name: string, detail?: string): string;
export declare function fixedWaitIn(line: string): boolean;
/**
 * The fixed waits of consecutive lines: each line alone, and a `new Promise(` joined with the (at most three)
 * following consecutive lines, so that `new Promise(resolve =>` / `setTimeout(resolve, 100))` is found on its first line.
 */
export declare function fixedWaitLines(lines: readonly {
    line: number;
    text: string;
}[]): {
    line: number;
    text: string;
}[];
/**
 * Lines added by a unified diff with no context (`-U0`), with their number in the new file. Only the lines inside
 * a hunk count, so an added line `++i;` (`+++i;` in the diff) is a line, never the `+++ b/<file>` header.
 */
export declare function addedLines(diff: string): {
    line: number;
    text: string;
}[];
/** The commit `ref` names, or null when it does not resolve (no remote, reference absent). */
export declare function resolveRef(git: Git, repo: string, ref: string): Promise<string | null>;
/**
 * The commit a configured reference names (`repeatChanged.reference`, `skipWhenOnly.reference`), by its full ref only:
 * `refs/remotes/<name>`, `refs/heads/<name>`, `refs/tags/<name>` and `refs/<name>` are listed (`git for-each-ref`), and
 * the name is refused when none or more than one exist (a local branch or a tag `origin/main` never hides the
 * remote-tracking one: both exist, the name is ambiguous). A full ref (`refs/...`) or a full commit id is taken as is.
 */
export declare function resolveReference(git: Git, repo: string, name: string): Promise<{
    sha: string | null;
    ref: string | null;
    reason: string;
}>;
/** The merge base of `a` and `b`; `a` itself without a common ancestor (unrelated histories: everything counts). */
export declare function mergeBase(git: Git, repo: string, a: string, b: string): Promise<string>;
/**
 * The test files to repeat: added or modified since the merge base of `base` (and of `reference`, when given) with
 * `head`, those matching one of the globs `paths`, sorted; deleted files never. Without `head`, against the working
 * tree (a task run may have uncommitted tests), untracked files not ignored included; with `head` (a commit), its
 * committed content only (`apv gates verify`, `apv stack batch`). Also the fixed waits in the lines they add (a new
 * file: every line), unless `fixedWaits` is off.
 */
export declare function planRepeat(git: Git, repo: string, bases: {
    base: string;
    reference?: string | null;
}, settings: RepeatSettings, head?: string): Promise<RepeatPlan>;
/** The refusal of a repeated file whose path starts with `-`: appended to the command, it would read as an option. */
export declare function optionLikeFile(gateId: string, file: string): PipelineError;
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
