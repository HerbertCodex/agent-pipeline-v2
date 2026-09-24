import type { Issue } from '../domain/issues.js';
import { type DecisionLedger } from '../lifecycle/decisions.js';
import { type SecurityContext } from '../security/owasp.js';
/**
 * A spec file is either the spec itself, or `{ "request": "...", "spec": { ... } }` when the author keeps the
 * operator request next to it. The request drives the security minimum and must contain resolution quotes.
 */
export interface SpecDocument {
    spec: unknown;
    request: string | null;
}
export declare function parseSpecDocument(raw: unknown): SpecDocument;
export declare function readSpecDocument(file: string): SpecDocument;
/** The ledger of the working tree (a spec is validated while it is written, before any commit). */
export declare function workingLedger(repo: string): {
    file: string | null;
    ledger: DecisionLedger | null;
    issues: Issue[];
};
/** Text a spec stands for when no request was provided: what it claims to change, not what it excludes. */
export declare function specText(spec: unknown): string;
export interface SpecCheckOptions {
    repo: string;
    document: SpecDocument;
    /** Operator request given on the command line; it wins over the one stored in the document. */
    request?: string;
    /** Spec file: its stored request `.apv/state/demande-<id>.md`, written by /apv:spec, is read when no request is given. */
    specFile?: string;
    /** Launch-time rules (default): no open question, every criterion implemented by a task. */
    ready?: boolean;
    configFile?: string;
    signal?: AbortSignal;
}
export interface SpecCheckResult {
    valid: boolean;
    issues: Issue[];
    title: string | null;
    sha: string;
    requestSource: 'option' | 'document' | 'stored' | 'spec';
    /** Path of the stored request, relative to the repository, when it was used. */
    requestFile: string | null;
    ledgerFile: string | null;
    configFile: string | null;
    security: SecurityContext;
}
/**
 * Validates a spec against the same security minimum V2 computed when it launched a spec (journal incident
 * 14: a spec declared valid against a draft context was refused at launch). The minimum comes from the
 * request, the project type and the paths the request names or the tasks declare, recognised on the
 * repository at HEAD.
 */
export declare function checkSpec(options: SpecCheckOptions): Promise<SpecCheckResult>;
