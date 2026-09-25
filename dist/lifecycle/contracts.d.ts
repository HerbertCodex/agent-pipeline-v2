import { type Infer } from '../domain/schema.js';
import { type Config, type Lane } from '../domain/contracts.js';
import { type DecisionLedger } from './decisions.js';
import { type Issue } from '../domain/issues.js';
import { type SecurityContext } from '../security/owasp.js';
import { type QualityContext } from '../quality/review.js';
export declare const threatModelSchema: import("../domain/schema.js").Schema<{
    readonly required: boolean;
    readonly summary: string;
    readonly assets: string[];
    readonly trustBoundaries: string[];
    readonly threats: {
        readonly id: string;
        readonly category: "spoofing" | "tampering" | "repudiation" | "information-disclosure" | "denial-of-service" | "elevation-of-privilege" | "abuse-case" | "supply-chain" | "prompt-injection";
        readonly description: string;
        readonly mitigations: string[];
        readonly acceptanceIds: string[];
    }[];
    readonly assumptions: string[];
}>;
export declare const securityPlanSchema: import("../domain/schema.js").Schema<{
    readonly profile: {
        readonly exposure: "unknown" | "local" | "internal" | "internet";
        readonly authentication: boolean;
        readonly authorization: boolean;
        readonly sensitiveData: boolean;
        readonly sessionState: boolean;
        readonly fileUploads: boolean;
        readonly externalRequests: boolean;
        readonly database: boolean;
        readonly multiTenant: boolean;
        readonly secrets: boolean;
        readonly api: boolean;
        readonly webUi: boolean;
        readonly ciCd: boolean;
        readonly dependencyChange: boolean;
        readonly aiAgent: boolean;
        readonly mcp: boolean;
    };
    readonly owaspTopics: ("csrf" | "threat-modeling" | "authentication" | "password-storage" | "session-management" | "authorization" | "input-validation" | "injection-prevention" | "xss" | "content-security-policy" | "file-upload" | "ssrf" | "rest-security" | "data-protection" | "secrets-management" | "logging-monitoring" | "software-supply-chain" | "github-actions" | "ai-agent-security" | "llm-prompt-injection" | "secure-coding-with-ai" | "mcp-security")[];
    readonly threatModel: {
        readonly required: boolean;
        readonly summary: string;
        readonly assets: string[];
        readonly trustBoundaries: string[];
        readonly threats: {
            readonly id: string;
            readonly category: "spoofing" | "tampering" | "repudiation" | "information-disclosure" | "denial-of-service" | "elevation-of-privilege" | "abuse-case" | "supply-chain" | "prompt-injection";
            readonly description: string;
            readonly mitigations: string[];
            readonly acceptanceIds: string[];
        }[];
        readonly assumptions: string[];
    };
    readonly requirements: {
        readonly id: string;
        readonly title: string;
        readonly owaspTopics: ("csrf" | "threat-modeling" | "authentication" | "password-storage" | "session-management" | "authorization" | "input-validation" | "injection-prevention" | "xss" | "content-security-policy" | "file-upload" | "ssrf" | "rest-security" | "data-protection" | "secrets-management" | "logging-monitoring" | "software-supply-chain" | "github-actions" | "ai-agent-security" | "llm-prompt-injection" | "secure-coding-with-ai" | "mcp-security")[];
        readonly acceptanceIds: string[];
        readonly verification: string;
        readonly negativeTests: string[];
    }[];
    readonly assumptions: string[];
    readonly deferred: string[];
}>;
export declare const specTaskSchema: import("../domain/schema.js").Schema<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly acceptanceIds: string[];
    readonly allowedPaths: string[];
    readonly dependsOn: string[];
    readonly minimumLane: "fast" | "standard" | "high";
}>;
export declare const replanSchema: import("../domain/schema.js").Schema<{
    readonly reason: string;
    readonly tasks: {
        readonly id: string;
        readonly title: string;
        readonly description: string;
        readonly acceptanceIds: string[];
        readonly allowedPaths: string[];
        readonly dependsOn: string[];
        readonly minimumLane: "fast" | "standard" | "high";
    }[];
}>;
export declare const specSchema: import("../domain/schema.js").Schema<{
    readonly title: string;
    readonly problem: string;
    readonly scope: string[];
    readonly outOfScope: string[];
    readonly acceptance: {
        readonly id: string;
        readonly description: string;
        readonly verification: string;
    }[];
    readonly decisions: {
        readonly question: string;
        readonly answer: string;
    }[];
    readonly decisionCoverage: {
        readonly decisionId: string;
        readonly acceptanceIds: string[];
        readonly rationale: string;
    }[];
    readonly decisionResolutions: {
        readonly decisionId: string;
        readonly value: string;
        readonly sourceQuote: string;
        readonly rationale: string;
    }[];
    readonly questions: {
        readonly id: string;
        readonly question: string;
    }[];
    readonly tasks: {
        readonly id: string;
        readonly title: string;
        readonly description: string;
        readonly acceptanceIds: string[];
        readonly allowedPaths: string[];
        readonly dependsOn: string[];
        readonly minimumLane: "fast" | "standard" | "high";
    }[];
    readonly minimumLane: "fast" | "standard" | "high";
    readonly experience: {
        readonly uiImpact: "none" | "minor" | "major";
        readonly surfaces: string[];
        readonly rationale: string;
    };
    readonly security: {
        readonly profile: {
            readonly exposure: "unknown" | "local" | "internal" | "internet";
            readonly authentication: boolean;
            readonly authorization: boolean;
            readonly sensitiveData: boolean;
            readonly sessionState: boolean;
            readonly fileUploads: boolean;
            readonly externalRequests: boolean;
            readonly database: boolean;
            readonly multiTenant: boolean;
            readonly secrets: boolean;
            readonly api: boolean;
            readonly webUi: boolean;
            readonly ciCd: boolean;
            readonly dependencyChange: boolean;
            readonly aiAgent: boolean;
            readonly mcp: boolean;
        };
        readonly owaspTopics: ("csrf" | "threat-modeling" | "authentication" | "password-storage" | "session-management" | "authorization" | "input-validation" | "injection-prevention" | "xss" | "content-security-policy" | "file-upload" | "ssrf" | "rest-security" | "data-protection" | "secrets-management" | "logging-monitoring" | "software-supply-chain" | "github-actions" | "ai-agent-security" | "llm-prompt-injection" | "secure-coding-with-ai" | "mcp-security")[];
        readonly threatModel: {
            readonly required: boolean;
            readonly summary: string;
            readonly assets: string[];
            readonly trustBoundaries: string[];
            readonly threats: {
                readonly id: string;
                readonly category: "spoofing" | "tampering" | "repudiation" | "information-disclosure" | "denial-of-service" | "elevation-of-privilege" | "abuse-case" | "supply-chain" | "prompt-injection";
                readonly description: string;
                readonly mitigations: string[];
                readonly acceptanceIds: string[];
            }[];
            readonly assumptions: string[];
        };
        readonly requirements: {
            readonly id: string;
            readonly title: string;
            readonly owaspTopics: ("csrf" | "threat-modeling" | "authentication" | "password-storage" | "session-management" | "authorization" | "input-validation" | "injection-prevention" | "xss" | "content-security-policy" | "file-upload" | "ssrf" | "rest-security" | "data-protection" | "secrets-management" | "logging-monitoring" | "software-supply-chain" | "github-actions" | "ai-agent-security" | "llm-prompt-injection" | "secure-coding-with-ai" | "mcp-security")[];
            readonly acceptanceIds: string[];
            readonly verification: string;
            readonly negativeTests: string[];
        }[];
        readonly assumptions: string[];
        readonly deferred: string[];
    };
}>;
export type Spec = Infer<typeof specSchema>;
export declare const qaSchema: import("../domain/schema.js").Schema<{
    readonly candidateSha: string;
    readonly verdict: "pass" | "changes_requested";
    readonly summary: string;
    readonly criteria: {
        readonly id: string;
        readonly status: "unknown" | "pass" | "fail";
        readonly evidence: string;
    }[];
    readonly findings: {
        readonly id: string;
        readonly severity: "blocker" | "minor" | "major";
        readonly resolution: "required" | "advisory";
        readonly path: string;
        readonly description: string;
    }[];
    readonly observations: string[];
    readonly decisionChecks: {
        readonly decisionId: string;
        readonly status: "unknown" | "pass" | "fail";
        readonly evidence: string;
    }[];
    readonly securityChecks: {
        readonly requirementId: string;
        readonly status: "unknown" | "pass" | "fail";
        readonly evidence: string;
    }[];
    readonly qualityChecks: {
        readonly axis: "architecture" | "simplicity" | "reuse" | "tests" | "operations" | "ui";
        readonly status: "unknown" | "pass" | "fail" | "not_applicable";
        readonly evidence: string;
        readonly paths: string[];
        readonly receiptIds: string[];
        readonly findingIds: string[];
    }[];
    readonly negativeTestChecks: {
        readonly requirementId: string;
        readonly testIndex: number;
        readonly status: "unknown" | "review" | "pass" | "fail";
        readonly evidence: string;
        readonly paths: string[];
        readonly receiptIds: string[];
        readonly inspectedPaths: string[];
    }[];
}>;
export type QaReport = Infer<typeof qaSchema>;
export declare const designProposalSchema: import("../domain/schema.js").Schema<{
    readonly summary: string;
    readonly rationale: string;
    readonly visualDirection: string;
    readonly implementationBrief: string;
    readonly css: string;
    readonly screens: {
        readonly id: string;
        readonly title: string;
        readonly purpose: string;
        readonly bodyHtml: string;
        readonly states: string[];
        readonly responsive: string;
    }[];
    readonly decisions: {
        readonly decision: string;
        readonly rationale: string;
        readonly alternatives: string[];
        readonly tradeoffs: string[];
    }[];
    readonly avoid: string[];
    readonly references: {
        readonly path: string;
        readonly reason: string;
    }[];
    readonly assets: {
        readonly id: string;
        readonly path: string;
        readonly reason: string;
    }[];
    readonly stylesheets: {
        readonly path: string;
        readonly reason: string;
    }[];
    readonly questions: {
        readonly id: string;
        readonly question: string;
    }[];
    readonly taskScopes: {
        readonly taskId: string;
        readonly screenIds: string[];
    }[];
}>;
export type DesignProposal = Infer<typeof designProposalSchema>;
export interface DesignRecord {
    proposal: DesignProposal;
    hash: string;
    directory: string;
    indexPath: string;
    screenPaths: string[];
    generatedAt: number;
    /** Spec whose approved visual direction this design continues, when one existed. */
    reusedFrom?: string | null;
    /** Repository files inlined into the previews as data: URIs. */
    inlinedAssets?: {
        id: string;
        path: string;
        bytes: number;
    }[];
    /** Repository stylesheets loaded by the previews before the proposal's own css. */
    loadedStylesheets?: {
        path: string;
        bytes: number;
    }[];
}
export interface SpecCheckOptions {
    /** Approval-time rules: no open question, no unresolved ambiguity, every criterion implemented. */
    ready?: boolean;
    ledger?: DecisionLedger;
    /** Accumulated operator request; decision resolutions must quote it. */
    operatorText?: string;
    /** Security minimum the spec must preserve, recomputed from the request and the repository. */
    securityContext?: SecurityContext;
}
/** Every semantic problem of a parsed spec, in the order V2 checked them (V2 stopped at the first). */
export declare function specRuleIssues(spec: Spec, options?: SpecCheckOptions): Issue[];
/** Every problem of an unparsed spec document: schema first (all of it), then the spec rules. */
export declare function specIssues(value: unknown, options?: SpecCheckOptions): Issue[];
export declare function validateSpec(value: unknown, ready?: boolean, ledger?: DecisionLedger, operatorText?: string, securityContext?: SecurityContext): Spec;
/**
 * Structural rules an executable spec must satisfy. Applied at approval, and to freshly produced Product
 * output that asks no question: a spec that asks nothing claims to be complete. It is deliberately not
 * applied when reading a stored document: an old document must stay loadable, whatever rule came later.
 */
export declare function assertSpecReadiness(spec: Spec): Spec;
export declare function taskOrder(spec: Spec): Spec['tasks'];
export declare function validateQa(value: unknown, spec: Spec, candidateSha: string, ledger?: DecisionLedger, quality?: {
    context: QualityContext;
    paths: ReadonlySet<string>;
    candidatePaths?: ReadonlySet<string>;
}): QaReport;
export declare function stricter(...values: Lane[]): Lane;
export interface SpecApproval {
    hash: string;
    reviewer: string;
    note: string;
    at: number;
}
export interface QaRecord {
    report: QaReport;
    evidenceHash: string;
    specHash: string;
    at: number;
    source: 'agent' | 'operator-import';
}
export interface TaskAttempt {
    taskId: string;
    runId: string;
    kind: 'task' | 'qa-repair';
}
export interface PlanRevision {
    id: string;
    reason: string;
    tasks: Spec['tasks'];
    contextHash: string;
    hash: string;
    previousContent: Spec;
    previousApproval: SpecApproval;
    status: 'pending' | 'approved' | 'superseded';
    at: number;
    approval: SpecApproval | null;
}
export interface ScopeAmendment {
    id: string;
    taskId: string;
    sourceRunId: string;
    paths: string[];
    reason: string;
    candidateSha: string;
    status: 'pending' | 'approved' | 'rejected';
    requestedAt: number;
    approvedAt: number | null;
    reviewer: string | null;
    note: string | null;
}
/**
 * Correction of one acceptance criterion of a spec whose execution has started. A spec is immutable once
 * running, but a criterion can turn out to be unsatisfiable (it forbids what the approved change requires).
 * Without this, the only exit was to throw away a finished, passing candidate. It corrects exactly one
 * criterion's text, never its id, and never scope, tasks, paths or decisions.
 */
export interface CriterionAmendment {
    id: string;
    criterionId: string;
    previous: {
        description: string;
        verification: string;
    };
    description: string;
    verification: string;
    /** Security requirements linked to this criterion that carried the same unsatisfiable constraint. */
    requirements?: {
        id: string;
        previous: string;
        verification: string;
        reviewTests?: {
            index: number;
            previous: string;
        }[];
        previousNegativeTests?: string[];
        negativeTests?: string[];
    }[];
    reason: string;
    hash: string;
    status: 'pending' | 'approved';
    at: number;
    approvedAt: number | null;
    reviewer: string | null;
    note: string | null;
}
export declare function criterionAmendmentHash(a: Pick<CriterionAmendment, 'criterionId' | 'previous' | 'description' | 'verification' | 'reason' | 'requirements'>): string;
export interface ReviewWorkspace {
    directory: string;
    candidateDirectory: string;
    patchPath: string;
    qaPath: string;
    reviewPath: string;
    candidateSha: string;
    /** Identity of everything the review documents describe: candidate, spec, design, QA and gate results. */
    bundleHash?: string;
}
export interface Publication {
    remote: string;
    repository: string;
    branch: string;
    base: string;
    candidateSha: string;
    url: string | null;
    state: 'intent' | 'pushed' | 'pr_open' | 'merged';
    mergedAt: string | null;
    mergeSha: string | null;
    /** `review`: a draft PR opened so the operator can read the candidate before approving it. */
    purpose?: 'review' | 'delivery';
}
export interface SpecRecord {
    executionPath?: import('./pathways.js').ExecutionPath;
    architecture?: import('./pathways.js').Architecture | null;
    repo: string;
    baseSha: string;
    config: Config;
    configHash: string;
    revision: number;
    request: string;
    decisionLedger: DecisionLedger;
    decisionLedgerHash: string;
    securityContext: SecurityContext;
    securityContextHash: string;
    content: Spec | null;
    contentHash: string | null;
    approval: SpecApproval | null;
    status: 'draft' | 'approved' | 'running' | 'awaiting_review' | 'ready' | 'delivered' | 'closed' | 'blocked' | 'rejected';
    attempts: TaskAttempt[];
    completedTaskIds: string[];
    currentSha: string;
    activeRunId: string | null;
    finalRunId: string | null;
    validationRunIds: string[];
    qa: QaRecord | null;
    qaRepairs: number;
    /**
     * One quality repair the operator authorized after inspecting evidence the review could not
     * conclude on. Consumed by the repair it authorizes; the controller never grants it by itself.
     */
    qaRepairAuthorization?: {
        at: number;
        reviewer: string;
        note: string;
    } | null;
    design: DesignRecord | null;
    scopeAmendments: ScopeAmendment[];
    criterionAmendments?: CriterionAmendment[];
    planRevisions?: PlanRevision[];
    /**
     * Advisory computed after Product: existing tests that reference a task's files but are assigned to a
     * later task (Product declared them as changing; only the order is wrong), or to none when the test
     * imports the file through a resolved relative path. Gates run the whole suite after every task, so such a test usually breaks the
     * earlier task and forces a scope amendment. Lexical, never blocking.
     */
    impactAdvice?: {
        test: string;
        changedBy: string;
        assignedTo: string | null;
        tokens: string[];
        evidence: 'declared-later' | 'resolved-import';
    }[];
    /** Tasks whose declared file surface is larger than one agent session usually completes. Advisory only. */
    sizeAdvice?: {
        taskId: string;
        title: string;
        paths: number;
    }[];
    review: ReviewWorkspace | null;
    sessionStartedAt: number | null;
    activeMs: number;
    planningMs?: number;
    planningStartedAt?: number | null;
    operational?: {
        maxSpecCostUsd: number | null;
        maxActiveMs: number;
        /** Retries allowed when a role returns a malformed output; execution-only, proves nothing less. */
        maxOutputRepairs?: number;
        /** Execution-only gate changes: strictly more proof, never less. See amendBudget. */
        gates?: {
            add: import('../domain/contracts.js').Config['gates'];
            resources: Record<string, string[]>;
            timeoutMs: Record<string, number>;
        };
        agent: Partial<Pick<import('../domain/contracts.js').AgentConfig, 'model' | 'effort' | 'timeoutMs' | 'maxTurns' | 'maxBudgetUsd' | 'usageMode'>> | null;
        roles?: Partial<Record<'product' | 'design' | 'implementer' | 'qa', Partial<Pick<import('../domain/contracts.js').AgentConfig, 'model' | 'effort' | 'timeoutMs' | 'maxTurns' | 'maxBudgetUsd' | 'usageMode'>>>>;
        at: number;
        reviewer: string;
        note: string;
    };
    delivery: {
        directory: string;
        candidateSha: string;
        manifestHash: string;
    } | null;
    publication: Publication | null;
    error: {
        code: string;
        message: string;
    } | null;
}
export declare function specHash(record: Pick<SpecRecord, 'repo' | 'baseSha' | 'configHash' | 'revision' | 'decisionLedgerHash' | 'securityContextHash' | 'content' | 'executionPath' | 'architecture'>): string;
export declare function approvalHash(record: Pick<SpecRecord, 'contentHash' | 'design'>): string | null;
export declare function reviewer(name: string, note: string): void;
export declare function specMarkdown(record: SpecRecord, id: string): string;
