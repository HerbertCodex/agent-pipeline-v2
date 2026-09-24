import { type Infer } from '../domain/schema.js';
import type { ChangeSet, Config, GateReceipt, RiskDecision } from '../domain/contracts.js';
import { type Spec, type SpecRecord } from './contracts.js';
import { type SecurityContext } from '../security/owasp.js';
export type ExecutionPath = 'compact' | 'standard' | 'structural';
/** A bounded Product transport. The controller restores lanes and validates the full spec. */
export declare const briefSpecSchema: import("../domain/schema.js").Schema<{
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
    }[];
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
export declare function expandBrief(brief: Infer<typeof briefSpecSchema>): Spec;
export declare const architectureSchema: import("../domain/schema.js").Schema<{
    readonly summary: string;
    readonly decisions: {
        readonly decision: string;
        readonly rationale: string;
        readonly constraint: string;
        readonly simplerAlternative: string;
        readonly risks: string[];
        readonly alternatives: string[];
        readonly tradeoffs: string[];
        readonly reconsiderWhen: string[];
    }[];
    readonly inspection: {
        readonly path: string;
        readonly finding: string;
    }[];
}>;
export type Architecture = Infer<typeof architectureSchema>;
/** Conservative route selection. A more demanding route never falls back during a draft. */
export declare function selectPath(request: string, security: SecurityContext, current?: ExecutionPath): ExecutionPath;
export declare function pathDecision(request: string, security: SecurityContext, current?: ExecutionPath, decisionCount?: number): {
    policyVersion: string;
    kind: string;
    inputs: {
        current: ExecutionPath;
        minimumLane: string;
        requiresThreatModel: boolean;
        decisionCount: number;
        structuralLanguage: boolean;
    };
    inputHash: string;
    result: {
        path: ExecutionPath;
    };
    reasons: string[];
    decisionHash: string;
};
export declare function resolvePathDecision(inputs: {
    current: ExecutionPath;
    minimumLane: string;
    requiresThreatModel: boolean;
    decisionCount: number;
    structuralLanguage: boolean;
}): {
    policyVersion: string;
    kind: string;
    inputs: {
        current: ExecutionPath;
        minimumLane: string;
        requiresThreatModel: boolean;
        decisionCount: number;
        structuralLanguage: boolean;
    };
    inputHash: string;
    result: {
        path: ExecutionPath;
    };
    reasons: string[];
    decisionHash: string;
};
/** Compact skips model QA only while observed changes remain inside the approved compact envelope. */
export declare function requiresQa(record: SpecRecord, run: {
    risk: RiskDecision | null;
    changeSet: ChangeSet | null;
}, spec: Spec): boolean;
/** Targeted QA keeps the complete diff and every obligation, omitting planning prose and successful tool logs. */
export declare function targetedQaContext(context: {
    spec: Spec;
    receipts: GateReceipt[];
    [key: string]: unknown;
}): {
    spec: {
        tasks: {
            id: string;
            title: string;
            acceptanceIds: string[];
            allowedPaths: string[];
            dependsOn: string[];
            minimumLane: "fast" | "standard" | "high";
        }[];
        title: string;
        scope: string[];
        outOfScope: string[];
        acceptance: {
            readonly id: string;
            readonly description: string;
            readonly verification: string;
        }[];
        decisions: {
            readonly question: string;
            readonly answer: string;
        }[];
        decisionCoverage: {
            readonly decisionId: string;
            readonly acceptanceIds: string[];
            readonly rationale: string;
        }[];
        decisionResolutions: {
            readonly decisionId: string;
            readonly value: string;
            readonly sourceQuote: string;
            readonly rationale: string;
        }[];
        minimumLane: "fast" | "standard" | "high";
        experience: {
            readonly uiImpact: "none" | "minor" | "major";
            readonly surfaces: string[];
            readonly rationale: string;
        };
        security: {
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
    };
    receipts: {
        diagnostic: string;
        id: string;
        runId: string;
        gateId: string;
        key: string;
        candidateSha: string;
        configHash: string;
        environmentHash: string;
        status: "passed" | "failed" | "timed_out" | "cancelled" | "spawn_error" | "blocked" | "cached";
        startedAt: number;
        durationMs: number;
        exitCode: number | null;
        stdoutHash: string;
        stderrHash: string;
        reusedFrom: string | null;
        stage: "task" | "full" | undefined;
        dirty: boolean | undefined;
    }[];
    qaScope: {
        mode: string;
        completeDiff: boolean;
        acceptanceIds: string[];
        instruction: string;
    };
};
export declare function adaptiveConfig(config: Config): Config;
