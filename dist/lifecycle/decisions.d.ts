import { type Infer } from '../domain/schema.js';
export declare const decisionEnforcements: readonly ["bootstrap", "product", "deferred"];
export declare const decisionStatuses: readonly ["confirmed", "proposed", "ambiguous", "deferred"];
export declare const decisionSources: readonly ["operator", "derived"];
export declare const decisionSchema: import("../domain/schema.js").Schema<{
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
}>;
export type Decision = Infer<typeof decisionSchema>;
export declare const decisionLedgerSchema: import("../domain/schema.js").Schema<{
    readonly schemaVersion: 1;
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
}>;
export type DecisionLedger = Infer<typeof decisionLedgerSchema>;
export declare const decisionCoverageSchema: import("../domain/schema.js").Schema<{
    readonly decisionId: string;
    readonly status: "unknown" | "deferred" | "satisfied" | "conflict";
    readonly evidence: {
        readonly kind: "acceptance" | "file" | "architecture" | "constraint";
        readonly reference: string;
        readonly detail: string;
    }[];
}>;
export type DecisionCoverage = Infer<typeof decisionCoverageSchema>;
export declare const semanticReviewSchema: import("../domain/schema.js").Schema<{
    readonly verdict: "pass" | "changes_requested";
    readonly summary: string;
    readonly decisions: {
        readonly decisionId: string;
        readonly status: "unknown" | "ambiguous" | "pass" | "fail";
        readonly evidence: string;
    }[];
    readonly missingOperatorDecisions: {
        readonly sourceQuote: string;
        readonly description: string;
    }[];
    readonly findings: {
        readonly severity: "blocker" | "warning";
        readonly description: string;
    }[];
}>;
export type SemanticReview = Infer<typeof semanticReviewSchema>;
/**
 * Conservative deterministic tripwire for a high-value class of scope ambiguities:
 * an approval/acceptance followed by an exception ("je valide ... sauf ...").
 * It intentionally does not try to understand arbitrary natural language; the
 * independent semantic reviewer remains responsible for broader ambiguity.
 */
export declare function ambiguousApprovalFragments(text: string): string[];
export declare function validateDecisionLedger(ledger: DecisionLedger, operatorText?: string): DecisionLedger;
export declare function ledgerHash(ledger: DecisionLedger): string;
export declare function confirmedDecisions(ledger: DecisionLedger, enforcement?: 'bootstrap' | 'product'): Decision[];
export declare function ambiguousDecisions(ledger: DecisionLedger, enforcement?: 'bootstrap' | 'product'): Decision[];
export declare function validateBootstrapCoverage(ledger: DecisionLedger, coverage: DecisionCoverage[], files: string[]): void;
export declare function validateSemanticReview(ledger: DecisionLedger, review: SemanticReview): SemanticReview;
export declare function decisionLedgerMarkdown(ledger: DecisionLedger): string;
export declare function loadDecisionLedger(repo: string, sha?: string): Promise<DecisionLedger>;
export declare function readWorkingDecisionLedger(repo: string): DecisionLedger;
