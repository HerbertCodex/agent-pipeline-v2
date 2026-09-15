import { type AgentConfig } from '../domain/contracts.js';
import { type Infer, type Schema } from '../domain/schema.js';
import type { Document, Store } from '../persistence/store.js';
import { type InstallPlan } from './onboarding.js';
import { type SemanticReview } from './decisions.js';
declare const architectureSchema: Schema<{
    readonly summary: string;
    readonly decisions: {
        readonly decision: string;
        readonly rationale: string;
        readonly evidence: string[];
        readonly alternatives: {
            readonly option: string;
            readonly reasonNotChosen: string;
        }[];
        readonly tradeoffs: string[];
        readonly reconsiderWhen: string[];
    }[];
}>;
export declare const bootstrapProposalSchema: Schema<{
    readonly projectType: "unknown" | "backend" | "frontend" | "mobile" | "fullstack" | "library";
    readonly summary: string;
    readonly architecture: {
        readonly summary: string;
        readonly decisions: {
            readonly decision: string;
            readonly rationale: string;
            readonly evidence: string[];
            readonly alternatives: {
                readonly option: string;
                readonly reasonNotChosen: string;
            }[];
            readonly tradeoffs: string[];
            readonly reconsiderWhen: string[];
        }[];
    };
    readonly decisions: {
        readonly id: string;
        readonly subject: string;
        readonly value: string;
        readonly enforcement: "product" | "bootstrap" | "deferred";
        readonly status: "deferred" | "confirmed" | "proposed" | "ambiguous";
        readonly source: "operator" | "derived";
        readonly sourceQuote: string;
        readonly rationale: string;
        readonly supersedes: string[];
        readonly clarificationQuestion: string;
        readonly interpretations: string[];
    }[];
    readonly decisionCoverage: {
        readonly decisionId: string;
        readonly status: "unknown" | "deferred" | "satisfied" | "conflict";
        readonly evidence: {
            readonly kind: "acceptance" | "file" | "architecture" | "constraint";
            readonly reference: string;
            readonly detail: string;
        }[];
    }[];
    readonly files: {
        readonly path: string;
        readonly content: string;
    }[];
    readonly questions: string[];
    readonly productQuestions: string[];
    readonly deferredQuestions: string[];
    readonly notes: string[];
}>;
export type BootstrapProposal = Infer<typeof bootstrapProposalSchema>;
export type ArchitectureProposal = Infer<typeof architectureSchema>;
export interface BootstrapPlan {
    directory: string;
    request: string;
    revision: number;
    provider: AgentConfig;
    proposal: BootstrapProposal;
    semanticReview: SemanticReview;
    hash: string;
    applied: boolean;
    commitSha: string | null;
    approval: {
        reviewer: string;
        note: string;
        at: number;
    } | null;
    onboarding: {
        id: string;
        hash: string;
    } | null;
    reviewMode: 'solo' | 'team' | 'regulated';
}
/** Bootstrap has no project configuration yet: one bounded repair of an output-contract violation. */
export declare const BOOTSTRAP_OUTPUT_REPAIRS = 1;
export declare function bootstrapHash(plan: Pick<BootstrapPlan, 'directory' | 'request' | 'revision' | 'provider' | 'reviewMode' | 'proposal' | 'semanticReview'>): string;
export declare function planBootstrap(store: Store, path: string, request: string, provider: string | unknown, signal?: AbortSignal, reviewMode?: 'solo' | 'team' | 'regulated'): Promise<Document<BootstrapPlan>>;
export declare function refineBootstrap(store: Store, id: string, request: string, signal?: AbortSignal): Promise<Document<BootstrapPlan>>;
export declare function applyBootstrap(store: Store, id: string, expectedHash: string, actor: string, note: string, commit: boolean): Promise<{
    bootstrap: Document<BootstrapPlan>;
    onboarding: Document<InstallPlan>;
}>;
export {};
