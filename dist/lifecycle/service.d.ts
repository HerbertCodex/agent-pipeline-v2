import { Pipeline } from '../engine/pipeline.js';
import { type Run } from '../domain/contracts.js';
import type { Document } from '../persistence/store.js';
import { type SpecRecord } from './contracts.js';
export interface WorkflowOptions {
    signal?: AbortSignal;
    acceptCurrent?: boolean;
    manualQa?: boolean;
}
export declare class Lifecycle {
    readonly pipeline: Pipeline;
    constructor(stateDir: string);
    get store(): import("../persistence/store.js").Store;
    close(): void;
    get(id: string): Document<SpecRecord>;
    private save;
    private approved;
    draft(options: {
        repo: string;
        config: unknown;
        request: string;
        proposal?: unknown;
        signal?: AbortSignal;
    }): Promise<Document<SpecRecord>>;
    private requiresDesign;
    private companionPaths;
    private validateDesignMarkup;
    private htmlEscape;
    private prepareDesignProposal;
    private product;
    refine(id: string, request: string, proposal?: unknown, signal?: AbortSignal): Promise<Document<SpecRecord>>;
    approveSpec(id: string, expectedHash: string, actor: string, note: string): Promise<Document<SpecRecord>>;
    private makeTask;
    private aggregateTask;
    private executeActive;
    private requestScopeAmendment;
    private block;
    approveScopeAmendment(id: string, amendmentId: string, actor: string, note: string): Promise<Document<SpecRecord>>;
    run(id: string, options?: WorkflowOptions): Promise<Document<SpecRecord>>;
    private qaMarkdown;
    private prepareReviewWorkspace;
    private reviewable;
    /** Publication adapters still acquire the lifecycle lease and require explicit consent. */
    publicationCandidate(id: string): Promise<Run>;
    review(id: string, sha: string, actor: string, note: string): Promise<Document<SpecRecord>>;
    importQa(id: string, value: unknown): Promise<Document<SpecRecord>>;
    reject(id: string, note: string): Document<SpecRecord>;
    verify(id: string, signal?: AbortSignal): Promise<Document<SpecRecord>>;
    retry(id: string, confirmed: boolean): Promise<Document<SpecRecord>>;
    recover(id: string, confirmed: boolean): Document<SpecRecord>;
    deliver(id: string, directory: string): Promise<Document<SpecRecord>>;
    branch(id: string, name: string, confirmed: boolean): Promise<Document<SpecRecord>>;
    closeLocal(id: string, ref: string, mergeSha: string, actor: string, note: string): Promise<Document<SpecRecord>>;
    /** Deterministic public-surface change between the approved base and the integrated candidate. */
    private inventoryDelta;
    summary(doc: Document<SpecRecord>): Record<string, unknown>;
}
