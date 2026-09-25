import { type Gate, type GateReceipt, type GateStage } from '../domain/contracts.js';
import type { ApvConfig } from '../config/load.js';
/** Receipts of `apv gates run`, one directory per execution. Machine evidence, not versioned. */
export declare const RECEIPTS_DIR = ".apv/receipts";
/** Environment identity of a V3 local run; V2 read it from `environment.id`, a field V3 no longer reads. */
export declare const ENVIRONMENT_ID = "apv3-local";
export interface GateRunOptions {
    repo: string;
    config: ApvConfig;
    /** Selected gate ids; their dependencies are added. Empty or absent: every configured gate. */
    only?: readonly string[];
    /**
     * `task`: the checks of stage task run, a full check with an `affected` command runs that targeted command instead,
     * the other full checks are reported as reserved. `full` (default): every check, never targeted.
     */
    stage?: GateStage;
    /** Commit the `{{baseSha}}` placeholder stands for. */
    base?: string;
    concurrency?: number;
    failFast?: boolean;
    signal?: AbortSignal;
    /** Source of passed variables (tests inject it); defaults to the process environment. */
    env?: NodeJS.ProcessEnv;
    /** A full suite run out of the rhythm of an execution (`--reason`): written in every receipt and in the summary. */
    override?: {
        run: string;
        reason: string;
    };
}
export interface GateRunResult {
    runId: string;
    repo: string;
    candidateSha: string;
    baseSha: string | null;
    /** True when the working tree had uncommitted changes: receipts then describe more than the commit. */
    dirty: boolean;
    stage: GateStage;
    selected: string[];
    added: string[];
    /** Selected checks of stage full left out of a task run: never executed, never counted as passed. */
    reserved: string[];
    /** Full checks a task run executed through their `affected` command (receipts marked `targeted`). */
    targeted: string[];
    receipts: GateReceipt[];
    directory: string;
    ok: boolean;
}
/** Selected gates in configuration order, with their transitive dependencies. */
export declare function selectGates(gates: readonly Gate[], only?: readonly string[]): {
    gates: Gate[];
    added: string[];
};
/**
 * Checks a stage requires (`run`), the full checks a task stage runs through their targeted `affected` command
 * (`targeted`, never proof of the full check) and the selected checks it leaves to the full suite (`reserved`).
 */
export declare function stageGates(gates: readonly Gate[], stage: GateStage): {
    run: Gate[];
    targeted: Gate[];
    reserved: Gate[];
};
/** Identity of the declared checks and passed variables, recorded in every receipt and compared by `apv gates verify`. */
export declare function gatesConfigHash(config: ApvConfig): string;
/**
 * Runs configured checks in the project working tree: dependency graph, named resources and read/write
 * exclusion through the V2 scheduler, only the declared variables passed, each command bounded by its
 * timeout, secrets redacted from diagnostics. Each receipt is validated and written as JSON.
 * Extracted from the V2 controller validation step, without its disposable worktree, its receipt cache
 * or its approval state: an implementer runs this in the worktree it owns.
 */
export declare function runGates(options: GateRunOptions): Promise<GateRunResult>;
