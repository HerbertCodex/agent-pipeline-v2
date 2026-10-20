import { type Gate } from '../domain/contracts.js';
import type { Git } from '../execution/git.js';
import { type ApvConfig } from '../config/load.js';
/**
 * Scope of the proof of a check (`skipWhenOnly`, docs/APV3-SPEC.md, section 21): a change that only touches files with
 * no effect on what the check proves (documentation, decisions, specs) does not pay its full run. The check is « not
 * required » only when EVERY file changed since the merge base of `--base` and HEAD, and since the merge base of the
 * reference (the branch the change goes to) and HEAD, matches the paths the reference declares (never those of the
 * change), none of their `except`, none of `ALWAYS_REQUIRED` nor of the inputs of the check, and keeps its mode and type.
 * Anything else, or anything unknown, makes it required: the default is always the full run.
 */
/**
 * Files that always require the checks, whatever the configuration says: the configuration of the checks, the
 * dependencies (manifests and lock files), the CI and repository machinery, the build, test and runtime
 * configuration, the tests and test scripts, the database migrations.
 */
export declare const ALWAYS_REQUIRED: readonly string[];
/** A file of a raw diff: its path, its status (`A`, `M`, `D`, `T`...) and its modes before and after. */
export interface ChangedFile {
    path: string;
    status: string;
    oldMode: string;
    newMode: string;
}
/** The decision for one check that declares `skipWhenOnly`. */
export interface ScopeDecision {
    gateId: string;
    required: boolean;
    reason: string;
    /** Merge base of `--base` and HEAD. */
    base: string | null;
    /** Merge base of the reference and HEAD. */
    reference: string | null;
    referenceName: string;
    /** The commit the reference named: its configuration gives the paths. */
    referenceSha: string | null;
    /** The files changed since the merge bases, sorted (every one when not required, the first `MAX_SCOPE_FILES` otherwise). */
    files: string[];
    /** How many files changed. */
    fileCount: number;
    /** The files that make the check required (50 at most). */
    blocking: string[];
}
/** Parses `git diff --raw -z --no-renames`: `:<old mode> <new mode> <old> <new> <status>\0<path>\0`. */
export declare function parseRawDiff(out: string): ChangedFile[];
/** Why a file changes the kind of thing it is (mode or type), or null: a symbolic link, a submodule, an executable. */
export declare function modeChange(f: ChangedFile): string | null;
/**
 * The paths a check names in its commands, as exact paths and directories (`scripts/e2e.sh`, `--config=e2e/pw.ts`):
 * a change to a script the check runs always requires it. Options, placeholders and paths outside the repository ignored.
 */
export declare function commandPaths(gate: Gate, repo: string): string[];
/**
 * Files never searched for mentions: APV's configuration, decisions, specs, state and code map (never read by the
 * application; the configuration lists the dispensed paths themselves, the map names every file of the project), and the ignore files of tools (`.gitignore`, `.prettierignore`...:
 * they read nothing). Any other file under `.apv/` (a tool script) is searched.
 */
export declare const NOT_SEARCHED: readonly string[];
/** What a file or folder is searched as: its path, its name, and each parent folder as a path segment or a quoted name. */
export declare function mentionNeedles(file: string, folders?: boolean): {
    needle: string;
    folder: string | null;
}[];
/**
 * The files among `candidates` the rest of the tree may read (`git grep -F -i` at `head`, the whole tracked tree except
 * `searchable` = false and `NOT_SEARCHED`): a file whose path or name appears literally, and every file under a parent
 * folder that appears as a path segment (`docs/`, `/docs`) or a quoted name (`'docs'`, `"docs"`, `` `docs` ``: a
 * `readdirSync('docs')`, a `join('docs', name)`, an `import.meta.glob('../docs/*.md')`). False positives are accepted:
 * the default is the full run. Null when the search could not be made (then every candidate is required).
 */
export declare function mentionedFiles(repo: string, head: string, candidates: readonly string[], searchable: (path: string) => boolean, withFolders?: (file: string) => boolean): Promise<Set<string> | null>;
/**
 * The files among `candidates` that a symbolic link of `head` points to, or lies under. A target is resolved to its
 * real path (links of the checkout followed) before it is judged outside the repository; a link to the root of the
 * repository or to one of its ancestors makes every candidate linked. Null beyond `MAX_LINKS` links or when the tree
 * cannot be read.
 */
export declare function linkedFiles(git: Git, repo: string, head: string, candidates: readonly string[]): Promise<Set<string> | null>;
export interface ScopeInput {
    /** `--base` (any revision); its merge base with `head` must not be `head`. */
    base: string;
    /** In place of `skipWhenOnly.reference` (`apv stack batch`: its target). */
    reference?: string;
    /** The commit whose committed content is compared. */
    head: string;
    /** The working tree has uncommitted changes: every check is required. */
    dirty?: boolean;
    /** The configuration file read, when inside the repository: always required too. */
    configFile?: string | null;
}
/**
 * The scope decisions of the checks of `config` that declare `skipWhenOnly` (the others are always required). Pure
 * function of the configuration, the commit, the base and the reference: `apv gates run` decides with it before
 * anything waits, `apv gates verify` recomputes it from the commit, and the two agree. A required check makes its
 * dependencies required (transitively): a check never runs without what it depends on.
 */
export declare function planScope(git: Git, repo: string, config: ApvConfig, input: ScopeInput): Promise<Map<string, ScopeDecision>>;
/** The receipt field `scope` of a decision. */
export declare function scopeRecord(d: ScopeDecision): {
    required: boolean;
    reason: string;
    base: string | null;
    reference: string | null;
    referenceName: string;
    referenceSha: string | null;
    fileCount: number;
    files: string[];
    blocking: string[];
};
/** The refusal of a full run whose `skipWhenOnly.reference` does not resolve. */
export declare function scopeReferenceMissing(gateId: string, name: string, detail?: string): string;
