import { type Infer } from '../domain/schema.js';
export declare const owaspTopicIds: readonly ["threat-modeling", "authentication", "password-storage", "session-management", "authorization", "input-validation", "injection-prevention", "xss", "csrf", "content-security-policy", "file-upload", "ssrf", "rest-security", "data-protection", "secrets-management", "logging-monitoring", "software-supply-chain", "github-actions", "ai-agent-security", "llm-prompt-injection", "secure-coding-with-ai", "mcp-security"];
export type OwaspTopicId = typeof owaspTopicIds[number];
export interface OwaspTopic {
    id: OwaspTopicId;
    title: string;
    url: string;
    purpose: string;
}
export declare const owaspCatalog: readonly OwaspTopic[];
export declare const securityProfileSchema: import("../domain/schema.js").Schema<{
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
}>;
export type SecurityProfile = Infer<typeof securityProfileSchema>;
export declare const securityContextSchema: import("../domain/schema.js").Schema<{
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
    readonly topics: {
        readonly id: "csrf" | "threat-modeling" | "authentication" | "password-storage" | "session-management" | "authorization" | "input-validation" | "injection-prevention" | "xss" | "content-security-policy" | "file-upload" | "ssrf" | "rest-security" | "data-protection" | "secrets-management" | "logging-monitoring" | "software-supply-chain" | "github-actions" | "ai-agent-security" | "llm-prompt-injection" | "secure-coding-with-ai" | "mcp-security";
        readonly reason: string;
        readonly sourceUrl: string;
    }[];
    readonly requiresThreatModel: boolean;
    readonly negativeTestsRequired: boolean;
    readonly minimumLane: "fast" | "standard" | "high";
    readonly untrustedContext: boolean;
    readonly signals: string[];
    readonly note: string;
}>;
export type SecurityContext = Infer<typeof securityContextSchema>;
export declare function neutralSecurityContext(): SecurityContext;
export declare function assessSecurity(input: {
    text: string;
    projectType?: string;
    files?: string[];
}): SecurityContext;
export declare function topicById(id: OwaspTopicId): OwaspTopic;
