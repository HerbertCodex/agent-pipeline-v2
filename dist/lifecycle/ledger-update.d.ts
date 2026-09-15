import { type Infer } from '../domain/schema.js';
import { type DecisionLedger } from './decisions.js';
/**
 * Operator-authored change to the Decision Ledger after bootstrap. New entries are appended; an entry
 * that replaces or resolves an existing decision must name it in `supersedes`, and the superseded entry
 * leaves the active ledger (it stays in Git history). The CLI cannot authenticate who wrote a quote:
 * like reviewer labels, quotes are an audited operator declaration, not a proof.
 */
export declare const ledgerUpdateSchema: import("../domain/schema.js").Schema<{
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
export type LedgerUpdate = Infer<typeof ledgerUpdateSchema>;
export interface LedgerUpdatePlan {
    repo: string;
    baseSha: string;
    currentLedgerHash: string;
    added: string[];
    superseded: string[];
    ledger: DecisionLedger;
    ledgerHash: string;
    hash: string;
}
export declare function planLedgerUpdate(repoPath: string, input: unknown): Promise<LedgerUpdatePlan>;
export declare function applyLedgerUpdate(repoPath: string, input: unknown, expectedHash: string, reviewer: string, note: string, commit: boolean): Promise<LedgerUpdatePlan & {
    commitSha: string | null;
}>;
