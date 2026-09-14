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
