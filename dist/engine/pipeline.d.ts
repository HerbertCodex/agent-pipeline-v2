import { type Run } from '../domain/contracts.js';
import { Store } from '../persistence/store.js';
export interface StartOptions {
    repo: string;
    task: unknown;
    config: unknown;
    baseRef?: string;
}
export interface ExecuteOptions {
    signal?: AbortSignal;
    acceptCurrentCandidate?: boolean;
}
export declare class Pipeline {
    readonly store: Store;
    constructor(stateDir: string);
    close(): void;
    private hooks;
    create(options: StartOptions): Promise<Run>;
    /** Validate an already materialized commit, without calling the implementation agent.
     * Used for baseline diagnosis and final, aggregate spec validation. It never asserts approval. */
    createValidation(options: StartOptions, candidateRef: string, allowEmpty?: boolean): Promise<Run>;
    /**
     * Why a validation of `options` could not adopt the proof already produced by `sourceId`, or null when it
     * can. Adoption is deliberately narrow: same base, candidate, change set and risk lane; the same gate plan
     * (commands, environment variables, dependencies, setup); the same environment identity measured now; and
     * fresh, verified evidence on the source. Anything else must be validated again.
     */
    adoptionRefusal(options: StartOptions, sourceId: string): Promise<string | null>;
    /**
     * Validation run that adopts the receipts of `sourceId` instead of replaying its gates. Each adopted receipt
     * is `cached` with `reusedFrom`, bound to this run's identity, and keeps the source validation time: adoption
     * never extends freshness. The run keeps its own review requirement.
     */
    adoptValidation(options: StartOptions, sourceId: string): Promise<Run>;
    /** Internal composition boundary: verifies evidence but does NOT approve or export a run. */
    assertValidated(id: string): Promise<string>;
    start(options: StartOptions, execution?: ExecuteOptions): Promise<Run>;
    private session;
    execute(id: string, options?: ExecuteOptions): Promise<Run>;
    revalidate(id: string, options?: ExecuteOptions): Promise<Run>;
    private drive;
    private implement;
    private capture;
    private setup;
    private validate;
    recover(id: string, confirmStopped: boolean): Run;
    private evidenceReady;
    approve(id: string, candidateSha: string, reviewer: string, note: string): Promise<Run>;
    invalidateApprovals(id: string, reason: string): Run;
    reject(id: string, note: string): Run;
    exportPatch(id: string): Promise<string>;
}
export declare function summarize(run: Run): Record<string, unknown>;
