import type { ApvConfig } from '../config/load.js';
import type { Gate } from '../domain/contracts.js';
import type { Git } from '../execution/git.js';
import { type ResolvedStack } from '../stacks/idle.js';
import { type GateLock } from './suite.js';
/**
 * A full suite spread over several declared test stacks (docs/APV3-SPEC.md, section 18.6): the checks of a stack
 * (those whose `lock` is the lock of a declared stack) are dealt to the stacks given, in configuration order, one each
 * in turn. On the first stack, a check runs in the copy of the suite; on another, in a detached copy of the same
 * commit, prepared by `batch.setup`, with the variables of its stack and under its lock. A check with dependencies, or
 * that others depend on, stays in the copy of the suite (on the first stack): its inputs and outputs live there.
 */
export interface SpreadAssignment {
    gateId: string;
    stack: ResolvedStack;
    workspace: string;
    /** Keys of the env file of the stack the check does not receive (not in its passEnv): listed, never passed. */
    notPassed: string[];
}
export interface SpreadCopy {
    stack: ResolvedStack;
    dir: string;
    gates: string[];
    error: string | null;
}
export interface SpreadPlan {
    assignments: Map<string, SpreadAssignment>;
    copies: SpreadCopy[];
}
export declare function planSpread(options: {
    git: Git;
    repo: string;
    common: string;
    config: ApvConfig;
    gates: readonly Gate[];
    ids: readonly string[];
    runId: string;
}): Promise<SpreadPlan>;
/**
 * Makes each copy: a detached worktree of `sha`, `batch.setup` run at its root (HOME passed), then a clean tree
 * required. A copy that cannot be made keeps the reason: its checks are not run and their receipts say why.
 */
export declare function prepareCopies(plan: SpreadPlan, options: {
    git: Git;
    repo: string;
    sha: string;
    config: ApvConfig;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal | undefined;
    log: (line: string) => void;
}): Promise<void>;
export declare function removeCopies(plan: SpreadPlan, git: Git, repo: string, log: (line: string) => void): Promise<void>;
/**
 * The variables of a stack for a check: its env file, then its `env`, then the `fileEnv` variable of the lock of the
 * check pointed at the lock file of the stack; only the names the check receives (`passEnv`), like every variable.
 */
export declare function stackVariables(stack: ResolvedStack, gate: Gate, passEnv: readonly string[]): Record<string, string>;
/** The lock of a check run on `stack`: the lock of the stack, with the wait the check declares. */
export declare function stackLock(stack: ResolvedStack, gate: Gate, leaseDir: string): GateLock;
