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
/**
 * The main checkout of the repository that contains `path`: the first entry of `git worktree list`, where the
 * `apv run` commands write the execution states (an implementer or integrator worktree holds at best a stale
 * copy). The root of `path` itself when Git names no main checkout (bare repository).
 */
export declare function mainCheckout(path: string): string;
/**
 * Spec ids a branch may belong to under `/apv:run`: `apv/<id>` or `apv/<id>-<suffixe>` (task, integration, fix
 * branches). Every prefix of what follows `apv/` cut at a hyphen, the longest first, when it is a valid id.
 */
export declare function branchSpecIds(branch: string): string[];
export interface RunContext {
    specId: string;
    /** Main checkout, where the state lives. */
    main: string;
    file: string;
    /** How the execution was found: `--run`, or the current branch. */
    source: 'option' | 'branch';
    branch: string | null;
}
/**
 * The execution `apv gates run` works for: `explicit` (`--run <id>`), whose state must exist; otherwise the
 * current branch of `repo` (`apv/<id>` or `apv/<id>-<suffixe>`) when the main checkout has the state
 * `.apv/state/run-<id>.json` (the longest id wins). Null outside any execution: detached head, another
 * branch, no state.
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
