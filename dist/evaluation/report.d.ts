import type { CostSummary } from '../adapters/invocations.js';
export interface EvaluationSample {
    caseId: string;
    configuration: string;
    success: boolean;
    wallMs: number;
    planningMs: number;
    activeMs: number;
    cost: CostSummary;
    invocations?: number;
    inputBytes?: number;
}
export interface EvaluationRun {
    configuration: string;
    caseSetHash: string;
    checksHash: string;
    expectedSamples: number;
    stoppedReason?: string | null;
    samples: EvaluationSample[];
}
/** Compare matched cases and checks. This ranks observed automated results, not human code quality. */
export declare function compareEvaluations(reports: EvaluationRun[]): {
    complete: boolean;
    aggregates: {
        configuration: string;
        attempts: number;
        successes: number;
        successRate: number;
        p50WallMs: number | null;
        p95WallMs: number | null;
        knownUsd: number;
        unknownInvocations: number;
        pendingInvocations: number;
        costComplete: boolean;
        knownUsdPerSuccessIncludingFailures: number | null;
        medianPlanningMs: number | null;
        medianActiveMs: number | null;
        invocations: number;
        inputBytes: number;
    }[];
    fastestPassingConfiguration: string | null;
    cheapestPassingConfiguration: string | null;
    cases: {
        caseId: string;
        results: {
            configuration: string;
            samples: EvaluationSample[];
        }[];
    }[];
    limitation: string;
};
/** All attempts, including failures, contribute to cost and latency. Unknown costs stay unknown. */
export declare function evaluationReport(samples: EvaluationSample[]): {
    configuration: string;
    attempts: number;
    successes: number;
    successRate: number;
    p50WallMs: number | null;
    p95WallMs: number | null;
    knownUsd: number;
    unknownInvocations: number;
    pendingInvocations: number;
    costComplete: boolean;
    knownUsdPerSuccessIncludingFailures: number | null;
    medianPlanningMs: number | null;
    medianActiveMs: number | null;
    invocations: number;
    inputBytes: number;
}[];
