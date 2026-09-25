import { type FullSuiteMode } from '../config/load.js';
import { type NextPlan, type RunState } from './state.js';
/**
 * `run.fullSuite` of the configuration of `repo`; an unreadable configuration falls back on `final`, said in
 * `problem`. Shared by `apv run next` and the rhythm check of `apv gates run`: one computation, one answer.
 */
export declare function suiteMode(repo: string): {
    mode: FullSuiteMode;
    problem: string | null;
};
/** A checkout of the repository, as `git worktree list --porcelain` gives it. */
export interface Worktree {
    path: string;
    /** Short branch name (`apv/x`), null on a detached head. */
    branch: string | null;
    /** The main checkout: the first entry of `git worktree list`. */
    main: boolean;
}
/**
 * The checkouts of the repository that contains `path`, the main one first (bare entries left out). The root of
 * `path` alone when Git lists none.
 */
export declare function listWorktrees(path: string): Worktree[];
/**
 * The main checkout of the repository that contains `path`: the first entry of `git worktree list`. The root of
 * `path` itself when Git names no main checkout (bare repository).
 */
export declare function mainCheckout(path: string): string;
/**
 * The checkout that holds the state `.apv/state/run-<specId>.json` of an execution, looked for in every worktree of
 * the repository that contains `repo`: executions run side by side, each from its own checkout (the one on
 * `apv/<id>` where `apv run start` wrote the state), and a task or integration worktree may hold a stale copy
 * that came with a commit. One copy: its checkout. Several: the checkout on `apv/<specId>`, else the main
 * checkout, else refused (`RUN_AMBIGUOUS`, every location listed). Null when no checkout has it.
 */
export declare function locateRunState(repo: string, specId: string): Worktree | null;
/**
 * Spec ids a branch may belong to under `/apv:run`: `apv/<id>` or `apv/<id>-<suffixe>` (task, integration, fix
 * branches). Every prefix of what follows `apv/` cut at a hyphen, the longest first, when it is a valid id.
 */
export declare function branchSpecIds(branch: string): string[];
export interface RunContext {
    specId: string;
    /** The checkout that holds the state (see `locateRunState`). */
    checkout: string;
    file: string;
    /** How the execution was found: `--run`, or the current branch. */
    source: 'option' | 'branch';
    branch: string | null;
}
/**
 * The execution `apv gates run` works for: `explicit` (`--run <id>`), whose state must exist; otherwise the
 * current branch of `repo` (`apv/<id>` or `apv/<id>-<suffixe>`) when a checkout of the repository has the state
 * `.apv/state/run-<id>.json` (the longest id wins). The state is looked for in every worktree (`locateRunState`).
 * Null outside any execution: detached head, another branch, no state.
 */
export declare function findRun(repo: string, explicit?: string): RunContext | null;
export interface ExpectedLevel {
    state: RunState;
    plan: NextPlan;
    mode: FullSuiteMode;
    /** Where the execution stands, for a human: `vagues (intégration intermédiaire)`, `corrections`… */
    where: string;
}
/** The level `apv run next` expects at the current step of the execution, computed the same way. */
export declare function expectedLevel(context: RunContext): ExpectedLevel;
