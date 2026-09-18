import type { CostSummary } from '../adapters/invocations.js';
import { invariant } from '../domain/errors.js';

export interface EvaluationSample {
  caseId: string; configuration: string; success: boolean; wallMs: number;
  planningMs: number; activeMs: number; cost: CostSummary;
  invocations?: number; inputBytes?: number;
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
export function compareEvaluations(reports: EvaluationRun[]) {
  invariant(reports.length >= 2, 'EVALUATION', 'Compare at least two configurations');
  const first = reports[0]!;
  invariant(first.caseSetHash && first.checksHash, 'EVALUATION', 'Reports must identify their cases and checks');
  const coverage = (r: EvaluationRun) => [...r.samples.map(s => s.caseId)].sort().join('\n');
  invariant(new Set(reports.map(r => r.configuration)).size === reports.length, 'EVALUATION', 'Configuration labels must be distinct');
  invariant(reports.every(r => r.caseSetHash === first.caseSetHash && r.checksHash === first.checksHash &&
    r.expectedSamples === first.expectedSamples && coverage(r) === coverage(first)), 'EVALUATION', 'Compare the same cases, checks and repetitions');
  invariant(reports.every(r => r.samples.every(s => s.configuration === r.configuration && Number.isFinite(s.wallMs) && s.wallMs >= 0 && Number.isFinite(s.cost.knownUsd) && s.cost.knownUsd >= 0)), 'EVALUATION', 'Invalid sample identity or measurement');
  const aggregates = evaluationReport(reports.flatMap(r => r.samples));
  const complete = reports.every(r => !r.stoppedReason && r.samples.length === r.expectedSamples);
  const qualified = complete ? aggregates.filter(a => a.successRate === 1 && a.costComplete) : [];
  return { complete, aggregates,
    fastestPassingConfiguration: [...qualified].sort((a,b) => (a.p50WallMs ?? Infinity) - (b.p50WallMs ?? Infinity))[0]?.configuration ?? null,
    cheapestPassingConfiguration: [...qualified].sort((a,b) => a.knownUsd - b.knownUsd)[0]?.configuration ?? null,
    cases: [...new Set(first.samples.map(s => s.caseId))].map(caseId => ({ caseId,
      results: reports.map(r => ({ configuration: r.configuration, samples: r.samples.filter(s => s.caseId === caseId) })) })),
    limitation: 'Provisional comparison of observed checks on matched cases. Human review of architecture, readability and regression tests is still required. No automatic model-policy change.' };
}
function quantile(values: number[], q: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]! : null;
}
/** All attempts, including failures, contribute to cost and latency. Unknown costs stay unknown. */
export function evaluationReport(samples: EvaluationSample[]) {
  return [...new Set(samples.map(s => s.configuration))].map(configuration => {
    const group = samples.filter(s => s.configuration === configuration);
    const successCount = group.filter(s => s.success).length;
    const knownUsd = group.reduce((n, s) => n + s.cost.knownUsd, 0);
    const unknownInvocations = group.reduce((n, s) => n + s.cost.unknownInvocations, 0);
    const pendingInvocations = group.reduce((n, s) => n + s.cost.pendingInvocations, 0);
    return { configuration, attempts: group.length, successes: successCount, successRate: successCount / group.length,
      p50WallMs: quantile(group.map(s => s.wallMs), 0.5), p95WallMs: quantile(group.map(s => s.wallMs), 0.95),
      knownUsd, unknownInvocations, pendingInvocations, costComplete: unknownInvocations === 0 && pendingInvocations === 0,
      knownUsdPerSuccessIncludingFailures: successCount ? knownUsd / successCount : null,
      medianPlanningMs: quantile(group.map(s => s.planningMs), 0.5),
      medianActiveMs: quantile(group.map(s => s.activeMs), 0.5),
      invocations: group.reduce((n, s) => n + (s.invocations ?? 0), 0),
      inputBytes: group.reduce((n, s) => n + (s.inputBytes ?? 0), 0),
    };
  });
}
