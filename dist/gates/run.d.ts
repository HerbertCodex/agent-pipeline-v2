import { type Gate, type GateReceipt } from '../domain/contracts.js';
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
    /** Commit the `{{baseSha}}` placeholder stands for. */
    base?: string;
    concurrency?: number;
    failFast?: boolean;
    signal?: AbortSignal;
    /** Source of passed variables (tests inject it); defaults to the process environment. */
    env?: NodeJS.ProcessEnv;
}
export interface GateRunResult {
    runId: string;
    repo: string;
    candidateSha: string;
    baseSha: string | null;
    /** True when the working tree had uncommitted changes: receipts then describe more than the commit. */
    dirty: boolean;
    selected: string[];
    added: string[];
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
 * Runs configured checks in the project working tree: dependency graph, named resources and read/write
 * exclusion through the V2 scheduler, only the declared variables passed, each command bounded by its
 * timeout, secrets redacted from diagnostics. Each receipt is validated and written as JSON.
 * Extracted from the V2 controller validation step, without its disposable worktree, its receipt cache
 * or its approval state: an implementer runs this in the worktree it owns.
 */
export declare function runGates(options: GateRunOptions): Promise<GateRunResult>;
