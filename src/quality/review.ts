import { s, type Infer } from '../domain/schema.js';
import { invariant } from '../domain/errors.js';
import { validationKinds, type Run } from '../domain/contracts.js';
import type { SpecRecord } from '../lifecycle/contracts.js';
import { validRelativePath, gateApplies, isCodeChange, isUiChange, validationRequirements, type ValidationRequirement } from '../policy/policy.js';

export const qualityAxes = ['architecture', 'simplicity', 'reuse', 'tests', 'operations', 'ui'] as const;
const ref = s.string(1, 80, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const qualityCheckSchema = s.object({
  axis: s.enum(qualityAxes), status: s.enum(['pass', 'fail', 'unknown', 'not_applicable']),
  evidence: s.string(1, 1600), paths: s.array(s.string(1, 500), 0, 12),
  receiptIds: s.array(ref, 0, 20), findingIds: s.array(ref, 0, 10),
});
export type QualityCheck = Infer<typeof qualityCheckSchema>;

/** Describes receipts already verified by the pipeline, not test quality or semantic coverage. */
export function validationEvidence(run: Run) {
  const gates = run.config.gates.map(g => {
    const selected = run.gateIds.includes(g.id);
    const receipts = selected ? run.receipts.filter(r => r.gateId === g.id && r.runId === run.id &&
      r.candidateSha === run.candidateSha && r.configHash === run.configHash) : [];
    const receipt = receipts.length === 1 ? receipts[0] : undefined;
    const applicable = gateApplies(g, run.changeSet?.files ?? []);
    const observed = applicable && receipt && ['passed', 'cached'].includes(receipt.status) && receipt.exitCode === 0;
    return { id: g.id, covers: g.covers ?? [], paths: g.paths, testPaths: g.testPaths ?? [], command: g.command, selected, applicable,
      status: !selected ? 'not_selected' : receipt?.status ?? 'missing',
      receiptId: observed ? receipt.id : null, reusedFrom: receipt?.reusedFrom ?? null };
  });
  const observed = validationKinds.filter(kind => gates.some(g => g.receiptId && g.covers.includes(kind)));
  return { gates, observed, gaps: validationKinds.filter(kind => !observed.includes(kind)),
    note: 'Coverage labels describe reviewed commands, not proof that every case was tested. Missing/unselected/unlabelled gates are not passes. In-session feedback and agent claims are not final receipts.' };
}

const guidance: Record<typeof qualityAxes[number], string> = {
  architecture: 'Check existing boundaries, dependency direction and the approved architecture decision; a local edit needs no new ADR or pattern.',
  simplicity: 'Name a present need for new abstractions; avoid speculative frameworks and arbitrary line-count rules.',
  reuse: 'Compare responsibilities with existing modules, not just names. Explain parallel implementations with actual paths.',
  tests: 'Inspect behavior, boundary/negative cases and regression relevance. Cite final behavioral-test receipts; do not invent a pre-change failing run.',
  operations: 'Assess partial writes, migrations, cancellation, retries, idempotence and diagnostics only where the change needs them.',
  ui: 'Review real states, keyboard behavior, responsive layout and existing CSS conventions. Distinguish source inspection from observed browser checks.',
};

export function qualityContext(record: Pick<SpecRecord, 'config' | 'content' | 'executionPath' | 'architecture'>, run: Run) {
  const files = run.changeSet?.files ?? [];
  const code = isCodeChange(files);
  const declaredUi = record.content?.experience?.uiImpact;
  const ui = (declaredUi !== undefined && declaredUi !== 'none') || isUiChange(files);
  const requirements = validationRequirements(run.config, files, run.risk?.lane ?? 'standard');
  if (record.config.workflow.qualityReview === 'evidence') {
    if (ui && !requirements.some(r => r.id === 'browser')) requirements.push({ id: 'browser', anyOf: ['browser'], reason: 'Approved UI impact.' });
    if (code && record.executionPath === 'structural' && !requirements.some(r => r.id === 'integration'))
      requirements.push({ id: 'integration', anyOf: ['integration'], reason: 'Structural change needs integration validation.' });
  }
  const validation = requiredEvidence(run, requirements);
  return { enabled: record.config.workflow.qualityReview === 'evidence', candidateSha: run.candidateSha,
    axes: qualityAxes.map(axis => ({ axis, required: axis === 'ui' ? ui : axis === 'operations' ? run.risk?.lane === 'high' : code,
      guidance: guidance[axis] })), validation };
}
export function requiredEvidence(run: Run, requirements = validationRequirements(run.config, run.changeSet?.files ?? [], run.risk?.lane ?? 'standard')) {
  const validation = validationEvidence(run);
  return { ...validation, requirements: requirements.map(r => {
    const gates = validation.gates.filter(g => g.receiptId && g.covers.some(k => r.anyOf.includes(k)) && (!r.paths?.length || gateApplies(g, r.paths)));
    return { ...r, receiptIds: gates.map(g => g.receiptId!), missingPaths: (r.paths ?? []).filter(p => !gates.some(g => gateApplies(g, [p]))) };
  }) };
}
export function assertRequiredEvidence(validation: { requirements: (ValidationRequirement & { receiptIds: string[]; missingPaths: string[] })[] }): void {
  const missing = validation.requirements.filter(r => !r.receiptIds.length || r.missingPaths.length);
  invariant(!missing.length, 'QA_EVIDENCE', `Required validation evidence missing: ${missing.map(r => `${r.id} (${r.anyOf.join(' or ')}): ${r.reason}${r.missingPaths.length ? ` Uncovered paths: ${r.missingPaths.join(', ')}` : ''}`).join('; ')}. Configure and approve the relevant commands; agent claims cannot replace final receipts.`);
}
export type QualityContext = ReturnType<typeof qualityContext>;
type Review = { verdict: string; qualityChecks?: QualityCheck[]; criteria?: { status: string }[];
  decisionChecks?: { status: string }[]; securityChecks?: { status: string }[];
  findings: { id: string; severity: string; path: string; description: string }[] };

/** References are checked against controller data. Their semantic adequacy remains a reviewer judgement. */
export function validateQualityChecks(report: Review, context?: QualityContext, paths?: ReadonlySet<string>): void {
  const checks = report.qualityChecks ?? [];
  invariant(context?.enabled || checks.length === 0, 'QA_QUALITY', 'Quality checks require evidence mode and controller context; use [] in legacy mode');
  const axes = checks.map(x => x.axis);
  invariant(new Set(axes).size === axes.length, 'QA_QUALITY', 'Duplicate quality axis');
  if (context?.enabled) invariant(qualityAxes.every(axis => axes.includes(axis)) && checks.length === qualityAxes.length,
    'QA_QUALITY', 'QA quality review must assess each axis exactly once');
  if (context?.enabled) invariant(report.findings.every(f => f.severity === 'minor' ||
    validRelativePath(f.path) && (!paths || paths.has(f.path)) && f.description.trim().length > 0),
  'QA_QUALITY', 'Blocking quality findings require a real repository path and concrete evidence');
  for (const check of checks) {
    invariant(check.evidence.trim().length > 0, 'QA_QUALITY', 'Blank quality evidence');
    invariant(check.paths.every(p => validRelativePath(p) && (!paths || paths.has(p))), 'QA_QUALITY', `Unknown quality evidence path for ${check.axis}`);
    invariant(check.findingIds.every(id => report.findings.some(f => f.id === id)), 'QA_QUALITY', 'Unknown quality finding reference');
    if (context) {
      invariant(check.receiptIds.every(id => context.validation.gates.some(g => g.receiptId === id)), 'QA_QUALITY', 'Unknown or unobserved quality receipt');
      const required = context.axes.find(x => x.axis === check.axis)?.required;
      invariant(!required || check.status !== 'not_applicable', 'QA_QUALITY', `Quality axis ${check.axis} applies to this change`);
      if (check.status === 'pass') {
        invariant(check.paths.length > 0, 'QA_QUALITY', `Quality pass for ${check.axis} requires inspected paths`);
        if (check.axis === 'tests') invariant(check.receiptIds.some(id => context.validation.gates.some(g => g.receiptId === id &&
          g.covers.some(kind => ['unit', 'integration', 'browser'].includes(kind)))), 'QA_QUALITY', 'Quality tests pass requires an observed behavioral-test receipt; otherwise report unknown');
        if (check.axis === 'ui') invariant(check.receiptIds.some(id => context.validation.gates.some(g => g.receiptId === id && g.covers.includes('browser'))),
          'QA_QUALITY', 'Quality UI pass requires an observed browser receipt; otherwise report unknown');
      }
    }
    if (check.status === 'fail') invariant(check.findingIds.some(id => report.findings.some(f => f.id === id &&
      f.severity !== 'minor' && validRelativePath(f.path) && (!paths || paths.has(f.path)) && f.description.trim().length > 0)),
    'QA_QUALITY', `Quality failure for ${check.axis} requires a concrete blocking finding with a real path`);
  }
  if (report.verdict === 'pass') {
    if (context?.enabled) assertRequiredEvidence(context.validation);
    invariant(checks.every(c => c.status === 'pass' || c.status === 'not_applicable'),
      'QA_QUALITY', 'QA pass contradicts failed or unknown quality evidence');
  }
  if (context?.enabled && report.verdict === 'changes_requested') invariant(report.findings.some(f => f.severity !== 'minor') ||
    [...checks, ...(report.criteria ?? []), ...(report.decisionChecks ?? []), ...(report.securityChecks ?? [])].some(c => c.status === 'fail' || c.status === 'unknown'),
    'QA_QUALITY', 'Minor observations alone do not justify changes_requested or an implementation repair');
}

export function qualityMarkdown(context: QualityContext): string {
  return ['## Required validation', '', ...context.validation.requirements.map(r =>
    `- ${r.id}: ${r.receiptIds.length && !r.missingPaths.length ? 'observed' : 'MISSING'}; ${r.reason} Receipts: ${r.receiptIds.join(', ') || 'none'}; uncovered paths: ${r.missingPaths.join(', ') || 'none'}`),
  '', '## Validation coverage', '', ...context.validation.gates.map(g =>
    `- ${g.id}: ${g.status}; coverage: ${g.covers.join(', ') || 'unlabelled'}${g.receiptId ? `; receipt: ${g.receiptId}` : ''}${g.reusedFrom ? `; reused from: ${g.reusedFrom}` : ''}`),
  '', `Unverified coverage categories: ${context.validation.gaps.join(', ') || 'none'}. These are coverage gaps, not automatically required new tools.`,
  context.validation.note, ''].join('\n');
}
