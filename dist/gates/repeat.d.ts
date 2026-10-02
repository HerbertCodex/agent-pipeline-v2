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
    /**
     * Changed test files whose only differences with the base are the paths of their imports (a move or a rename of
     * modules rewrites them): listed, never repeated (the check itself still runs them), never skipped silently.
     */
    importsOnly: string[];
    /**
     * Changed test files whose only differing lines cite a file the same diff renamed without changing it (same blob, same mode): the
     * old path replaced by the new one, nothing else (their imports may also have moved). Listed, never repeated (the
     * check itself still runs them), never skipped silently.
     */
    movedPathsOnly: string[];
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
/**
 * A test file with every module path of its imports replaced by the same placeholder, and each import statement put
 * on one line: static `import` (and `import type`), `export ... from`, side-effect `import '...'`, `vi.mock('...')`
 * (`jest.mock`, `importActual`...), `import('...')` with a literal. The names imported, the order of the statements and
 * every other line stay as they are.
 */
export declare function withoutImportPaths(text: string): string;
/** Only the paths of the imports differ (a module moved or renamed): the names imported and every other line are the same. */
export declare function onlyImportPathsChanged(before: string, after: string): boolean;
/**
 * A file the diff renamed without any change: same blob and same mode at both paths (`git diff -M --raw`; in the
 * working tree, the blob of the new path hashed), never a symbolic link (mode 120000). A similarity of 100 % is not
 * enough (permuted lines, a changed mode).
 */
export interface Rename {
    from: string;
    to: string;
}
/**
 * The forms under which a test cites a renamed file, old -> new: the full path, and each shorter suffix (cut on a `/`)
 * that still begins inside the folder both paths share (`docs/design/x.html` -> `docs/design/produit/x.html`: also
 * `design/x.html` -> `design/produit/x.html`, never `x.html` -> `produit/x.html`, which names no folder). A form
 * without any `/` (a file at the root: a bare name could be an identifier or a word) is never one; a form two renames
 * would replace differently is dropped.
 */
export declare function renamedPathForms(renames: readonly Rename[]): Map<string, string>;
/**
 * Where a text is prose rather than code, character by character: inside a string literal (`'…'`, `"…"`, a template
 * `` `…` `` outside its `${…}`) or a comment (`//`, `/* … *\/`, `<!-- … -->`, `#` at the start of a line or after a
 * space). A lexical reading, not a parser: regular expression literals are skipped after an operator or a bracket; a
 * quote left open ends with its line. Only there may a cited path be replaced: never an identifier, never `a/b` in code.
 */
export declare function textRegions(text: string): Uint8Array;
/** The replacement of the cited forms of renamed files, prepared once for a base. */
export interface RenamedPaths {
    forms: Map<string, string>;
    pattern: RegExp | null;
}
export declare function renamedPaths(renames: readonly Rename[]): RenamedPaths;
/**
 * A line with each cited form of a renamed file replaced by its new form, in one pass (a chain of renames is never
 * applied twice): a whole path only, optionally after `./` or `../`, never inside a longer path or name, and only where
 * `region` marks the characters as text (a string or a comment; every character when absent).
 */
export declare function withRenamedPaths(line: string, paths: RenamedPaths, region?: Uint8Array): string;
/**
 * Only cited paths of renamed files (and the paths of imports) differ: the two texts, imports put in their canonical
 * form, have the same number of lines, and each line that differs becomes the new one once the old paths of the
 * renamed files are replaced by the new ones inside its strings and comments (`withRenamedPaths`). Lines are paired
 * in order: a line added, removed or changed in any other way is a change. The content of each renamed file is the
 * same at both paths; which file a cited path resolves to at run time (the folder it is read from) is not known.
 */
export declare function onlyRenamedPathsChanged(before: string, after: string, renames: readonly Rename[] | RenamedPaths): boolean;
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
