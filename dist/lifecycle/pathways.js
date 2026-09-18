import { s } from '../domain/schema.js';
import { specSchema, securityPlanSchema } from './contracts.js';
import { assessSecurity } from '../security/owasp.js';
import { matches } from '../policy/policy.js';
import { changeLanguage } from '../security/change-signals.js';
const id = s.string(1, 80, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
/** A bounded Product transport. The controller restores lanes and validates the full spec. */
export const briefSpecSchema = s.object({
    title: s.string(1, 200), problem: s.string(10, 1200),
    scope: s.array(s.string(1, 500), 1, 8), outOfScope: s.array(s.string(1, 500), 0, 8),
    acceptance: s.array(s.object({ id, description: s.string(1, 600), verification: s.string(1, 600) }), 1, 12),
    decisions: s.array(s.object({ question: s.string(1, 300), answer: s.string(1, 800) }), 0, 6),
    decisionCoverage: s.array(s.object({ decisionId: id, acceptanceIds: s.array(id, 1, 12), rationale: s.string(1, 600) }), 0, 30),
    decisionResolutions: s.array(s.object({ decisionId: id, value: s.string(1, 1000), sourceQuote: s.string(1, 1000), rationale: s.string(1, 600) }), 0, 12),
    questions: s.array(s.object({ id, question: s.string(1, 600) }), 0, 6),
    tasks: s.array(s.object({ id, title: s.string(1, 200), description: s.string(1, 2000),
        acceptanceIds: s.array(id, 1, 12), allowedPaths: s.array(s.string(1, 500), 1, 30), dependsOn: s.array(id, 0, 3) }), 0, 3),
    experience: s.object({ uiImpact: s.enum(['none', 'minor', 'major']), surfaces: s.array(s.string(1, 300), 0, 10), rationale: s.string(1, 600) }),
    // Security and confirmed decisions are never dropped to fit a shorter prompt.
    security: securityPlanSchema,
});
export function expandBrief(brief) {
    return specSchema.parse({ ...brief, minimumLane: 'standard', tasks: brief.tasks.map(t => ({ ...t, minimumLane: 'standard' })) });
}
export const architectureSchema = s.object({
    summary: s.string(10, 2000),
    decisions: s.array(s.object({ decision: s.string(1, 800), rationale: s.string(1, 1200),
        alternatives: s.array(s.string(1, 600), 1, 5), tradeoffs: s.array(s.string(1, 600), 1, 5), reconsiderWhen: s.array(s.string(1, 600), 1, 5) }), 1, 6),
    inspection: s.array(s.object({ path: s.string(1, 500), finding: s.string(1, 1000) }), 1, 20),
});
/** Conservative route selection. A more demanding route never falls back during a draft. */
export function selectPath(request, security, current) {
    const text = changeLanguage(request).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (current === 'structural' || security.minimumLane === 'high' || security.requiresThreatModel ||
        /\b(migrat\w*|refonte|architectur\w*|breaking change|public (?:api|interface))\b/i.test(text))
        return 'structural';
    return current ?? 'standard';
}
/** Compact skips model QA only while observed changes remain inside the approved compact envelope. */
export function requiresQa(record, run, spec) {
    if (!record.executionPath)
        return record.config.workflow.qaLanes.includes(run.risk.lane);
    if (record.executionPath !== 'compact' || run.risk?.lane === 'high' || record.config.workflow.reviewMode === 'regulated')
        return true;
    const files = run.changeSet?.files ?? [];
    const security = assessSecurity({ text: '', files, projectType: record.config.skills.projectType });
    return !files.length || files.length > 8 || security.minimumLane === 'high' || security.negativeTestsRequired ||
        security.topics.length > 0 || spec.security.requirements.length > 0 ||
        files.some(f => !spec.tasks.some(t => t.allowedPaths.some(p => matches(f, p))));
}
/** Targeted QA keeps the complete diff and every obligation, omitting planning prose and successful tool logs. */
export function targetedQaContext(context) {
    const { problem: _problem, questions: _questions, tasks, ...obligations } = context.spec;
    return { ...context, spec: { ...obligations, tasks: tasks.map(({ description: _description, ...task }) => task) },
        receipts: context.receipts.map(({ diagnostic, ...receipt }) => ({ ...receipt, diagnostic: ['passed', 'cached'].includes(receipt.status) ? '' : diagnostic })),
        qaScope: { mode: 'targeted', completeDiff: true, acceptanceIds: context.spec.acceptance.map(a => a.id),
            instruction: 'Review every listed criterion, decision and security requirement against the complete diff and receipts. Read candidate files when needed. Planning prose and successful command logs were omitted, never code changes or acceptance obligations.' } };
}
export function adaptiveConfig(config) {
    return { ...config, workflow: { ...config.workflow, planningMode: 'adaptive' } };
}
//# sourceMappingURL=pathways.js.map