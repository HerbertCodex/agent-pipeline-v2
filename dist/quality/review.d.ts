import { type Infer } from '../domain/schema.js';
import { type Run } from '../domain/contracts.js';
import type { SpecRecord } from '../lifecycle/contracts.js';
import { type ValidationRequirement } from '../policy/policy.js';
export declare const qualityAxes: readonly ["architecture", "simplicity", "reuse", "tests", "operations", "ui"];
export declare const qualityCheckSchema: import("../domain/schema.js").Schema<{
    readonly axis: "architecture" | "simplicity" | "reuse" | "tests" | "operations" | "ui";
    readonly status: "unknown" | "pass" | "fail" | "not_applicable";
    readonly evidence: string;
    readonly paths: string[];
    readonly receiptIds: string[];
    readonly findingIds: string[];
}>;
export type QualityCheck = Infer<typeof qualityCheckSchema>;
/** Describes receipts already verified by the pipeline, not test quality or semantic coverage. */
export declare function validationEvidence(run: Run): {
    gates: {
        id: string;
        covers: ("security" | "unit" | "integration" | "browser" | "build" | "lint" | "typecheck" | "architecture")[];
        paths: string[];
        testPaths: string[];
        command: string[];
        selected: boolean;
        applicable: boolean;
        status: string;
        receiptId: string | null;
        reusedFrom: string | null;
    }[];
    observed: ("security" | "unit" | "integration" | "browser" | "build" | "lint" | "typecheck" | "architecture")[];
    gaps: ("security" | "unit" | "integration" | "browser" | "build" | "lint" | "typecheck" | "architecture")[];
    note: string;
};
export declare function qualityContext(record: Pick<SpecRecord, 'config' | 'content' | 'executionPath' | 'architecture'>, run: Run): {
    enabled: boolean;
    candidateSha: string | null;
    axes: {
        axis: "architecture" | "simplicity" | "reuse" | "tests" | "operations" | "ui";
        required: boolean;
        guidance: string;
    }[];
    validation: {
        requirements: {
            receiptIds: string[];
            missingPaths: string[];
            id: string;
            anyOf: import("../domain/contracts.js").Gate["covers"];
            reason: string;
            paths?: string[];
        }[];
        gates: {
            id: string;
            covers: ("security" | "unit" | "integration" | "browser" | "build" | "lint" | "typecheck" | "architecture")[];
            paths: string[];
            testPaths: string[];
            command: string[];
            selected: boolean;
            applicable: boolean;
            status: string;
            receiptId: string | null;
            reusedFrom: string | null;
        }[];
        observed: ("security" | "unit" | "integration" | "browser" | "build" | "lint" | "typecheck" | "architecture")[];
        gaps: ("security" | "unit" | "integration" | "browser" | "build" | "lint" | "typecheck" | "architecture")[];
        note: string;
    };
};
export declare function requiredEvidence(run: Run, requirements?: ValidationRequirement[]): {
    requirements: {
        receiptIds: string[];
        missingPaths: string[];
        id: string;
        anyOf: import("../domain/contracts.js").Gate["covers"];
        reason: string;
        paths?: string[];
    }[];
    gates: {
        id: string;
        covers: ("security" | "unit" | "integration" | "browser" | "build" | "lint" | "typecheck" | "architecture")[];
        paths: string[];
        testPaths: string[];
        command: string[];
        selected: boolean;
        applicable: boolean;
        status: string;
        receiptId: string | null;
        reusedFrom: string | null;
    }[];
    observed: ("security" | "unit" | "integration" | "browser" | "build" | "lint" | "typecheck" | "architecture")[];
    gaps: ("security" | "unit" | "integration" | "browser" | "build" | "lint" | "typecheck" | "architecture")[];
    note: string;
};
export declare function assertRequiredEvidence(validation: {
    requirements: (ValidationRequirement & {
        receiptIds: string[];
        missingPaths: string[];
    })[];
}): void;
export type QualityContext = ReturnType<typeof qualityContext>;
type Review = {
    verdict: string;
    qualityChecks?: QualityCheck[];
    criteria?: {
        status: string;
    }[];
    decisionChecks?: {
        status: string;
    }[];
    securityChecks?: {
        status: string;
    }[];
    findings: {
        id: string;
        severity: string;
        resolution?: 'required' | 'advisory';
        path: string;
        description: string;
    }[];
};
/** Severity describes impact; a small correction can still be required for delivery. */
export declare function findingRequiresFix(finding: {
    severity: string;
    resolution?: string;
}): boolean;
/** References are checked against controller data. Their semantic adequacy remains a reviewer judgement. */
export declare function validateQualityChecks(report: Review, context?: QualityContext, paths?: ReadonlySet<string>): void;
export declare function qualityMarkdown(context: QualityContext): string;
export {};
