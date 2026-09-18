import { Pipeline } from '../engine/pipeline.js';
import { type Run } from '../domain/contracts.js';
import type { Document } from '../persistence/store.js';
import { type SpecRecord } from './contracts.js';
/**
 * Elements and their attributes, quote-aware so a `>` inside an attribute value cannot end a tag early.
 * Text between tags is displayed content: a mockup may legitimately show `src=`, a URL or escaped markup
 * as text, and the validator must not confuse that with an element that loads something.
 */
export declare function scanTags(html: string): {
    name: string;
    attributes: {
        name: string;
        value: string;
    }[];
}[];
export interface WorkflowOptions {
    signal?: AbortSignal;
    acceptCurrent?: boolean;
    acceptCost?: boolean;
    manualQa?: boolean;
}
export declare class Lifecycle {
    readonly pipeline: Pipeline;
    /** Inventories keyed by immutable commit SHA and language profiles; bounded, never invalidated. */
    private readonly inventories;
    constructor(stateDir: string);
    private inventoryAt;
    get store(): import("../persistence/store.js").Store;
    close(): void;
    get(id: string): Document<SpecRecord>;
    private save;
    private approved;
    /** See SpecRecord.impactAdvice. Tasks are walked in dependency order, like execution. */
    private impactAdvice;
    /**
     * What each completed attempt reported. A criterion may require the Implementer to report something
     * (an observation outside scope, a limitation); without these summaries QA can only answer "unknown".
     */
    private taskSummaries;
    /** Operator decisions made after approval, shown to QA with their reasons: they postdate the spec text. */
    private approvedAmendments;
    draft(options: {
        repo: string;
        config: unknown;
        request: string;
        proposal?: unknown;
        compactTask?: unknown;
        pathway?: 'auto' | 'standard' | 'structural';
        signal?: AbortSignal;
    }): Promise<Document<SpecRecord>>;
    private requiresDesign;
    private companionPaths;
    private validateDesignMarkup;
    /** url() is allowed only as url(asset:ID) for a repository file the proposal declares; the controller inlines it. */
    private validateDesignUrls;
    /**
     * Preview copy of the proposal with every url(asset:ID) replaced by an inline data: URI read from the
     * repository. Previews stay a single self-contained file with no network access, so the mockup can show
     * the project's real typography instead of a substitute.
     */
    private inlineDesignAssets;
    /**
     * The spec whose approved visual direction a new design for `repo` continues: the most recently approved,
     * non-rejected spec with a design. Maintenance uses the same rule to keep that document.
     */
    designReference(repo: string, excludeId?: string): Document<SpecRecord> | undefined;
    /** Files tracked at one commit: a design asset must be repository content at the reviewed commit, not whatever the working tree happens to hold. */
    private trackedPaths;
    /**
     * Project stylesheets the preview loads before the proposal's css. Same containment as assets (tracked at
     * the reviewed commit, physically inside the repository), plain CSS only, and never text that could close
     * the style element and inject markup into the preview.
     */
    private loadDesignStylesheets;
    /**
     * Visual direction already approved for this repository, if any. Passing it to the design role turns a
     * full re-derivation into an extension: the mockup keeps one direction across increments and only covers
     * screens the new spec creates or changes.
     */
    private establishedDesign;
    private validateDesignScopes;
    private htmlEscape;
    private prepareDesignProposal;
    private product;
    private buildProduct;
    /** Resume the exact request; an accepted Product checkpoint survives a failed Design round. */
    resumePlanning(id: string, signal?: AbortSignal): Promise<Document<SpecRecord>>;
    /** Operational limits do not rewrite the approved scope, gates or functional hash. */
    amendBudget(id: string, input: unknown, actor: string, note: string): Document<SpecRecord>;
    refine(id: string, request: string, proposal?: unknown, signal?: AbortSignal): Promise<Document<SpecRecord>>;
    approveSpec(id: string, expectedHash: string, actor: string, note: string): Promise<Document<SpecRecord>>;
    /** Design context scoped to one task: legacy proposals without taskScopes keep the whole design. */
    private designContextFor;
    private makeTask;
    /**
     * The retried task, told why the previous attempt stopped: its error, the diagnostics of the checks it
     * failed and its own summary. The new attempt starts from the approved base, so without this it would
     * repeat a failure it cannot see. The context is trimmed to fit `limits.maxTaskContextChars`.
     */
    private withPreviousAttempt;
    /** The repair task for the current QA report, built from the current effective spec and amendments. */
    private qaRepairTask;
    private aggregateTask;
    /** What the providers declared for this spec so far. Declared values, never an invoice. */
    declaredCostUsd(r: SpecRecord, documentId: string): number;
    costSummary(id: string): {
        ceilingUsd: number | null;
        knownUsd: number;
        unknownInvocations: number;
        pendingInvocations: number;
    };
    /**
     * The reviewed configuration may cap what a spec is allowed to spend. Reaching it stops the workflow with
     * what was spent; continuing is an explicit operator decision (`spec run --accept-cost`), like every other
     * boundary of this controller.
     */
    private costExceeded;
    private executeActive;
    private requestScopeAmendment;
    private block;
    /** Records a proposed correction of one acceptance criterion and returns its hash for explicit approval. */
    planCriterionAmendment(id: string, criterionId: string, correction: {
        description: string;
        verification: string;
        reason: string;
        requirements?: {
            id: string;
            verification: string;
        }[];
    }): Document<SpecRecord>;
    /** Applies a criterion correction the operator approved by its exact hash, and reopens assessment. */
    approveCriterionAmendment(id: string, amendmentId: string, expectedHash: string, actor: string, note: string): Document<SpecRecord>;
    approveScopeAmendment(id: string, amendmentId: string, actor: string, note: string): Promise<Document<SpecRecord>>;
    run(id: string, options?: WorkflowOptions): Promise<Document<SpecRecord>>;
    private qaMarkdown;
    /** The approved mockup QA compares the candidate against; bounded like the Implementer's copy. */
    private qaDesignContext;
    private prepareReviewWorkspace;
    private reviewable;
    /** Publication adapters still acquire the lifecycle lease and require explicit consent. */
    publicationCandidate(id: string, purpose?: 'review' | 'delivery'): Promise<Run>;
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
