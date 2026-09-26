import { s, type Infer } from '../domain/schema.js';
import { invariant } from '../domain/errors.js';
import { lanes, type Config, type Lane } from '../domain/contracts.js';
import { matches } from '../policy/policy.js';
import { hash } from '../domain/hash.js';
import { confirmedDecisions, ambiguousDecisions, decisionApplies, decisionLedgerIssues, decisionReason, validateDecisionLedger, type DecisionLedger, type DecisionTarget } from './decisions.js';
import { IssueList, schemaIssues, type Issue } from '../domain/issues.js';
import { owaspTopicIds, securityProfileSchema, neutralSecurityContext, type SecurityContext } from '../security/owasp.js';
import { qualityCheckSchema, validateQualityChecks, findingRequiresFix, type QualityContext } from '../quality/review.js';
const id = s.string(1, 80, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const sha = s.string(40, 64, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const neutralSecurityProfile = securityProfileSchema.parse({});
export const threatModelSchema = s.object({
    required: s.boolean(),
    summary: s.string(0, 12000),
    assets: s.array(s.string(1, 1000), 0, 50),
    trustBoundaries: s.array(s.string(1, 1500), 0, 50),
    threats: s.array(s.object({
        id, category: s.enum(['spoofing','tampering','repudiation','information-disclosure','denial-of-service','elevation-of-privilege','abuse-case','supply-chain','prompt-injection'] as const),
        description: s.string(1, 3000),
        mitigations: s.array(s.string(1, 3000), 1, 30),
        acceptanceIds: s.array(id, 1, 100),
    }), 0, 100),
    assumptions: s.array(s.string(1, 2000), 0, 50),
});
const neutralThreatModel = threatModelSchema.parse({ required:false, summary:'', assets:[], trustBoundaries:[], threats:[], assumptions:[] });
export const securityPlanSchema = s.object({
    profile: s.default(securityProfileSchema, neutralSecurityProfile),
    owaspTopics: s.default(s.array(s.enum(owaspTopicIds), 0, owaspTopicIds.length), []),
    threatModel: s.default(threatModelSchema, neutralThreatModel),
    requirements: s.default(s.array(s.object({
        id, title: s.string(1, 500),
        owaspTopics: s.array(s.enum(owaspTopicIds), 1, owaspTopicIds.length),
        acceptanceIds: s.array(id, 1, 100),
        verification: s.string(1, 4000),
        negativeTests: s.array(s.string(1, 3000), 0, 30),
    }), 0, 100), []),
    assumptions: s.default(s.array(s.string(1, 3000), 0, 100), []),
    deferred: s.default(s.array(s.string(1, 3000), 0, 100), []),
});
const neutralSecurityPlan = securityPlanSchema.parse({});
export const specTaskSchema = s.object({
    id, title: s.string(1, 500), description: s.string(1, 12000),
    acceptanceIds: s.array(id, 1, 100), allowedPaths: s.array(s.string(1, 500), 1, 100),
    dependsOn: s.array(id, 0, 20), minimumLane: s.enum(lanes),
});
export const replanSchema = s.object({
    reason: s.string(20, 4000),
    tasks: s.array(specTaskSchema, 1, 20),
});
export const specSchema = s.object({
    title: s.string(1, 500), problem: s.string(10, 20000),
    scope: s.array(s.string(1, 3000), 1, 100), outOfScope: s.array(s.string(1, 3000), 0, 100),
    acceptance: s.array(s.object({ id, description: s.string(1, 3000), verification: s.string(1, 3000) }), 1, 100),
    decisions: s.array(s.object({ question: s.string(1, 2000), answer: s.string(1, 4000) }), 0, 100),
    decisionCoverage: s.default(s.array(s.object({
        decisionId: id, acceptanceIds: s.array(id, 1, 100), rationale: s.string(1, 4000),
    }), 0, 200), []),
    decisionResolutions: s.default(s.array(s.object({
        decisionId: id, value: s.string(1, 4000), sourceQuote: s.string(1, 4000), rationale: s.string(1, 4000),
    }), 0, 100), []),
    questions: s.array(s.object({ id, question: s.string(1, 3000) }), 0, 100),
    tasks: s.array(specTaskSchema, 0, 20),
    minimumLane: s.enum(lanes),
    experience: s.default(s.object({
        uiImpact: s.enum(['none', 'minor', 'major']),
        surfaces: s.array(s.string(1, 300), 0, 30),
        rationale: s.string(1, 4000),
    }), { uiImpact: 'none', surfaces: [], rationale: 'No user-interface change declared.' }),
    security: s.default(securityPlanSchema, neutralSecurityPlan),
});
export type Spec = Infer<typeof specSchema>;
export const qaSchema = s.object({
    candidateSha: sha, verdict: s.enum(['pass', 'changes_requested']), summary: s.string(1, 12000),
    criteria: s.array(s.object({ id, status: s.enum(['pass', 'fail', 'unknown']), evidence: s.string(1, 4000) }), 1, 100),
    findings: s.array(s.object({
        id, severity: s.enum(['blocker', 'major', 'minor']),
        // Missing on historical reports; severity still makes blocker/major findings mandatory.
        resolution: s.default(s.enum(['required', 'advisory']), 'advisory'),
        path: s.string(0, 500), description: s.string(1, 4000),
    }), 0, 100),
    observations: s.array(s.string(1, 3000), 0, 100),
    decisionChecks: s.default(s.array(s.object({ decisionId: id, status: s.enum(['pass','fail','unknown']), evidence: s.string(1, 4000) }), 0, 200), []),
    securityChecks: s.default(s.array(s.object({ requirementId: id, status: s.enum(['pass','fail','unknown']), evidence: s.string(1, 4000) }), 0, 200), []),
    qualityChecks: s.default(s.array(qualityCheckSchema, 0, 6), []),
    negativeTestChecks: s.default(s.array(s.object({
        // `review` is for a negative case the approved spec itself defines as a review rather than a test
        // with the explicit `[review] ` prefix: it can never carry a behavioral receipt, and
        // it is reported as asserted-by-review so the human reviewer sees exactly what no test proves.
        requirementId: id, testIndex: s.number(0, 29), status: s.enum(['pass', 'fail', 'unknown', 'review']),
        evidence: s.string(1, 1600), paths: s.array(s.string(1, 500), 0, 12), receiptIds: s.array(id, 0, 20),
        inspectedPaths: s.default(s.array(s.string(1, 500), 0, 12), []),
    }), 0, 3000), []),
});
export type QaReport = Infer<typeof qaSchema>;

export const designProposalSchema = s.object({
    summary: s.string(1, 8000),
    rationale: s.string(1, 12000),
    visualDirection: s.string(1, 8000),
    implementationBrief: s.string(1, 12000),
    css: s.string(1, 20000),
    screens: s.array(s.object({
        id, title: s.string(1, 300), purpose: s.string(1, 3000),
        bodyHtml: s.string(1, 12000),
        states: s.array(s.string(1, 500), 0, 20),
        responsive: s.string(1, 3000),
    }), 1, 8),
    decisions: s.array(s.object({
        decision: s.string(1, 1000), rationale: s.string(1, 4000),
        alternatives: s.array(s.string(1, 2000), 0, 10),
        tradeoffs: s.array(s.string(1, 2000), 0, 10),
    }), 1, 30),
    avoid: s.array(s.string(1, 1000), 0, 30),
    references: s.array(s.object({ path: s.string(1, 500), reason: s.string(1, 2000) }), 0, 30),
    // Repository files (fonts, images) the mockup needs. The controller inlines them into the preview
    // as data: URIs, so a preview can show the project's real typography without any network access.
    assets: s.default(s.array(s.object({ id, path: s.string(1, 500), reason: s.string(1, 2000) }), 0, 8), []),
    // The project's own global stylesheets, loaded by the preview before `css`, so a mockup only writes what
    // it adds instead of reproducing the existing stylesheet.
    stylesheets: s.default(s.array(s.object({ path: s.string(1, 500), reason: s.string(1, 2000) }), 0, 4), []),
    questions: s.array(s.object({ id, question: s.string(1, 3000) }), 0, 30),
    // Which spec tasks implement visual work and which screens each needs. Empty keeps the legacy
    // behaviour (every task receives the whole design); a listed task with no screen receives only
    // the shared direction; an unlisted task receives no design context.
    taskScopes: s.default(s.array(s.object({ taskId: id, screenIds: s.array(id, 0, 8) }), 0, 20), []),
});
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
    inlinedAssets?: { id: string; path: string; bytes: number }[];
    /** Repository stylesheets loaded by the previews before the proposal's own css. */
    loadedStylesheets?: { path: string; bytes: number }[];
}

export interface SpecCheckOptions {
    /** Approval-time rules: no open question, no unresolved ambiguity, every criterion implemented. */
    ready?: boolean;
    ledger?: DecisionLedger;
    /** Accumulated operator request; decision resolutions must quote it. */
    operatorText?: string;
    /** Security minimum the spec must preserve, recomputed from the request and the repository. */
    securityContext?: SecurityContext;
    /** Id of the spec (its file name without `.json`): a decision whose `scope.specs` names it concerns it. */
    specId?: string;
}

/** Every semantic problem of a parsed spec, in the order V2 checked them (V2 stopped at the first). */
export function specRuleIssues(spec: Spec, options: SpecCheckOptions = {}): Issue[] {
    const list = new IssueList();
    const ledgerIssues = decisionLedgerIssues(options.ledger ?? { schemaVersion: 1, decisions: [] });
    list.items.push(...ledgerIssues);
    // An invalid ledger cannot drive decision checks; the other rules are still reported.
    const decisions: DecisionLedger = ledgerIssues.length ? { schemaVersion: 1, decisions: [] } : validateDecisionLedger(options.ledger ?? { schemaVersion: 1, decisions: [] });
    const texts = [spec.title, spec.problem, ...spec.scope, ...spec.outOfScope, ...spec.acceptance.flatMap(a => [a.description, a.verification]), ...spec.decisions.flatMap(d => [d.question, d.answer]), ...spec.questions.map(q => q.question), ...spec.tasks.flatMap(t => [t.title, t.description]), spec.experience.rationale, ...spec.experience.surfaces];
    list.check(texts.every(t => t.trim().length > 0), 'SPEC', 'Blank semantic text is not accepted');
    for (const [name, group] of [['acceptance', spec.acceptance], ['questions', spec.questions], ['tasks', spec.tasks]] as const) {
        const ids = group.map(x => x.id);
        const duplicates = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
        list.check(!duplicates.length, 'SPEC', `Duplicate item id in ${name}: ${duplicates.join(', ')}`);
    }
    const coverageIds = spec.decisionCoverage.map(x => x.decisionId);
    list.check(new Set(coverageIds).size === coverageIds.length, 'SPEC_DECISIONS', 'Duplicate decision coverage');
    const resolutionIds = spec.decisionResolutions.map(x => x.decisionId);
    list.check(new Set(resolutionIds).size === resolutionIds.length, 'SPEC_DECISIONS', 'Duplicate decision resolution');
    const knownDecisions = new Set(decisions.decisions.map(d => d.id));
    const unknownCoverage = spec.decisionCoverage.filter(x => !knownDecisions.has(x.decisionId)).map(x => x.decisionId);
    list.check(!unknownCoverage.length, 'SPEC_DECISIONS', `Spec references an unknown project decision: ${unknownCoverage.join(', ')}. Allowed decisionCoverage IDs from decisionLedger: ${[...knownDecisions].join(', ') || 'none; return decisionCoverage: []'}. Local spec/architecture decisions do not create ledger IDs.`);
    const ambiguousProduct = new Map(ambiguousDecisions(decisions, 'product').map(d => [d.id, d]));
    for (const resolution of spec.decisionResolutions) {
        list.check(ambiguousProduct.has(resolution.decisionId), 'SPEC_DECISIONS', `Resolution references a decision that is not an ambiguous Product decision: ${resolution.decisionId}`);
        if (options.operatorText !== undefined) list.check(options.operatorText.toLocaleLowerCase('en-US').includes(resolution.sourceQuote.trim().toLocaleLowerCase('en-US')), 'SPEC_DECISIONS', `Resolution ${resolution.decisionId} source quote is not present in the accumulated operator request`);
    }
    const criteria = new Set(spec.acceptance.map(x => x.id));
    for (const item of spec.decisionCoverage) list.check(item.acceptanceIds.every(id => criteria.has(id)), 'SPEC_DECISIONS', `Decision ${item.decisionId} references an unknown acceptance criterion`);
    const security = options.securityContext ?? neutralSecurityContext();
    const requiredTopics = new Set(security.topics.map(t => t.id));
    const declaredTopics = new Set(spec.security.owaspTopics);
    const missingTopics = [...requiredTopics].filter(topic => !declaredTopics.has(topic));
    const missingMappings = [...requiredTopics].filter(topic => !spec.security.requirements.some(r => r.owaspTopics.includes(topic)));
    const downgraded = (['authentication','authorization','sensitiveData','sessionState','fileUploads','externalRequests','database','multiTenant','secrets','api','webUi','ciCd','dependencyChange','aiAgent','mcp'] as const)
        .filter(key => security.profile[key] && !spec.security.profile[key]);
    // Return the complete minimum-coverage gap in one round instead of paying for
    // successive repairs that each discover only the next missing topic.
    list.check(!missingTopics.length && !missingMappings.length && !downgraded.length, 'SPEC_SECURITY',
        `Product security plan must preserve the controller minimum. Missing security.owaspTopics: ${missingTopics.join(', ') || 'none'}. Missing security.requirements mappings (with valid acceptanceIds and verification): ${missingMappings.join(', ') || 'none'}. Security profile cannot downgrade detected surfaces: ${downgraded.join(', ') || 'none'}. Cover existing trust boundaries and exclusions without inventing out-of-scope features.`);
    if (security.profile.exposure !== 'unknown') list.check(spec.security.profile.exposure === security.profile.exposure, 'SPEC_SECURITY', `Security exposure must preserve detected value ${security.profile.exposure}`);
    const requirementIds = spec.security.requirements.map(r => r.id);
    list.check(new Set(requirementIds).size === requirementIds.length, 'SPEC_SECURITY', 'Duplicate security requirement id');
    for (const requirement of spec.security.requirements) {
        list.check(requirement.acceptanceIds.every(x => criteria.has(x)), 'SPEC_SECURITY', `Security requirement ${requirement.id} references an unknown acceptance criterion`);
        list.check(new Set(requirement.owaspTopics).size === requirement.owaspTopics.length, 'SPEC_SECURITY', `Security requirement ${requirement.id} repeats an OWASP topic`);
    }
    if (security.negativeTestsRequired) list.check(spec.security.requirements.some(r => r.negativeTests.some(test => !test.startsWith('[review] '))), 'SPEC_SECURITY', 'Security-sensitive behavior requires at least one explicit negative security test');
    if (security.requiresThreatModel) {
        list.check(spec.security.threatModel.required, 'SPEC_SECURITY', 'A threat model is required for the detected security surfaces');
        list.check(spec.security.threatModel.assets.length > 0 && spec.security.threatModel.trustBoundaries.length > 0 && spec.security.threatModel.threats.length > 0, 'SPEC_SECURITY', 'Threat model must name assets, trust boundaries and threats');
    }
    const threatIds = spec.security.threatModel.threats.map(t => t.id);
    list.check(new Set(threatIds).size === threatIds.length, 'SPEC_SECURITY', 'Duplicate threat id');
    for (const threat of spec.security.threatModel.threats) list.check(threat.acceptanceIds.every(x => criteria.has(x)), 'SPEC_SECURITY', `Threat ${threat.id} references an unknown acceptance criterion`);
    // A scoped decision (field `scope` of the ledger) is required only by the specs it concerns; an unscoped one by every spec.
    const target: DecisionTarget = { specId: options.specId, paths: spec.tasks.flatMap(t => t.allowedPaths) };
    const reasons = new Map(decisions.decisions.map(d => [d.id, decisionReason(d, target)]));
    const requiredDecisionIds = new Set([...confirmedDecisions(decisions, 'product').filter(d => reasons.get(d.id) !== null).map(d=>d.id), ...resolutionIds]);
    for (const decisionId of requiredDecisionIds) {
        const item = spec.decisionCoverage.find(x => x.decisionId === decisionId);
        const why = reasons.get(decisionId);
        list.check(item && item.acceptanceIds.length > 0, 'SPEC_DECISIONS', `Product decision ${decisionId} is not covered by acceptance criteria. ` +
            `Elle est exigée ici${why ? ` : ${why}` : ' (résolue par la spec)'}. Solution : rattache-la à un critère (decisionCoverage : decisionId, acceptanceIds, rationale)` +
            (decisions.decisions.find(d => d.id === decisionId)?.scope ? '.' : ` ; si elle ne concerne pas cette spec, donne-lui un périmètre au registre (champ scope : paths, motifs des fichiers qu'elle concerne, ou specs, identifiants) par une décision qui la remplace (supersedes, apv ledger plan puis apply) : elle ne sera plus exigée que des specs dont les tâches touchent ce périmètre.`));
    }
    for(const decision of ambiguousProduct.values()) {
        if(spec.decisionResolutions.some(r=>r.decisionId===decision.id)) continue;
        if(reasons.get(decision.id) === null) continue;
        list.check(spec.questions.some(q=>q.question.trim().toLocaleLowerCase('en-US')===decision.clarificationQuestion.trim().toLocaleLowerCase('en-US')), 'SPEC_DECISIONS', `Unresolved ambiguous decision ${decision.id} must be asked using its recorded clarification question`);
    }
    const tasks = new Map(spec.tasks.map(t => [t.id, t]));
    const visiting = new Set<string>();
    const done = new Set<string>();
    const reported = new Set<string>();
    const once = (key: string, code: string, message: string): void => { if (!reported.has(key)) { reported.add(key); list.check(false, code, message); } };
    function visit(taskId: string, from: string): void {
        if (done.has(taskId)) return;
        if (visiting.has(taskId)) { once(`cycle:${taskId}`, 'SPEC_DAG', `Task dependency cycle at ${taskId}`); return; }
        const task = tasks.get(taskId);
        if (!task) { once(`missing:${taskId}`, 'SPEC_DAG', `Missing dependency ${taskId} (required by ${from})`); return; }
        visiting.add(taskId);
        task.dependsOn.forEach(dep => visit(dep, taskId));
        visiting.delete(taskId);
        done.add(taskId);
    }
    for (const task of spec.tasks) {
        list.check(new Set(task.dependsOn).size === task.dependsOn.length, 'SPEC_DAG', `Duplicate dependency in task ${task.id}`);
        list.check(new Set(task.acceptanceIds).size === task.acceptanceIds.length, 'SPEC', `Duplicate task criterion in task ${task.id}`);
        const unknown = task.acceptanceIds.filter(c => !criteria.has(c));
        list.check(!unknown.length, 'SPEC', `Task ${task.id} references an unknown acceptance criterion: ${unknown.join(', ')}`);
        for (const pattern of task.allowedPaths)
            list.attempt('GLOB', () => matches('probe', pattern));
        visit(task.id, task.id);
    }
    if (options.ready) {
        list.check(spec.questions.length === 0, 'OPEN_QUESTIONS', 'Resolve Product questions before approval');
        const unresolved=ambiguousDecisions(decisions,'product').filter(d=>!spec.decisionResolutions.some(r=>r.decisionId===d.id) && reasons.get(d.id) !== null);
        list.check(unresolved.length===0,'OPEN_QUESTIONS',`Resolve ambiguous Product decisions before approval: ${unresolved.map(d=>d.id).join(', ')}`);
        list.items.push(...specReadinessIssues(spec));
    }
    return list.items;
}

/** Every problem of an unparsed spec document: schema first (all of it), then the spec rules. */
export function specIssues(value: unknown, options: SpecCheckOptions = {}): Issue[] {
    const { value: spec, issues } = schemaIssues(specSchema, value);
    return spec ? specRuleIssues(spec, options) : issues;
}

export function validateSpec(value: unknown, ready = false, ledger: DecisionLedger = { schemaVersion: 1, decisions: [] }, operatorText?: string, securityContext: SecurityContext = neutralSecurityContext()): Spec {
    const spec = specSchema.parse(value);
    const list = new IssueList();
    list.items.push(...specRuleIssues(spec, { ready, ledger, securityContext, ...(operatorText !== undefined ? { operatorText } : {}) }));
    list.throwFirst();
    return spec;
}
function specReadinessIssues(spec: Spec): Issue[] {
    const list = new IssueList();
    list.check(spec.tasks.length > 0, 'SPEC', 'A spec without open questions needs executable tasks');
    const covered = new Set(spec.tasks.flatMap(t => t.acceptanceIds));
    const orphans = spec.acceptance.map(a => a.id).filter(c => !covered.has(c));
    list.check(orphans.length === 0, 'SPEC_COVERAGE', `Some criteria have no implementing task: ${orphans.join(', ')}. Attach each one to the task whose change demonstrates it, including no-regression criteria.`);
    return list.items;
}
/**
 * Structural rules an executable spec must satisfy. Applied at approval, and to freshly produced Product
 * output that asks no question: a spec that asks nothing claims to be complete. It is deliberately not
 * applied when reading a stored document: an old document must stay loadable, whatever rule came later.
 */
export function assertSpecReadiness(spec: Spec): Spec {
    const list = new IssueList(); list.items.push(...specReadinessIssues(spec)); list.throwFirst();
    return spec;
}
export function taskOrder(spec: Spec): Spec['tasks'] {
    validateSpec(spec, true);
    const ordered: Spec['tasks'] = [];
    const done = new Set<string>();
    function visit(id: string): void { if (done.has(id))
        return; const t = spec.tasks.find(x => x.id === id)!; t.dependsOn.forEach(visit); done.add(id); ordered.push(t); }
    spec.tasks.forEach(t => visit(t.id));
    return ordered;
}
export function validateQa(value: unknown, spec: Spec, candidateSha: string, ledger: DecisionLedger = { schemaVersion: 1, decisions: [] }, quality?: { context: QualityContext; paths: ReadonlySet<string>; candidatePaths?: ReadonlySet<string> }): QaReport {
    const qa = qaSchema.parse(value);
    const checkedSpec = specSchema.parse(spec);
    const decisions = validateDecisionLedger(ledger);
    validateQualityChecks(qa, quality?.context, quality?.paths);
    if (quality?.context.enabled) {
        const expected = checkedSpec.security.requirements.flatMap(r => r.negativeTests.map((_, index) => `${r.id}:${index}`));
        const keys = qa.negativeTestChecks.map(c => `${c.requirementId}:${c.testIndex}`);
        invariant(new Set(keys).size === keys.length && keys.length === expected.length && expected.every(k => keys.includes(k)),
            'QA_SECURITY', 'Assess every declared negative test exactly once using requirementId and zero-based testIndex');
        for (const check of qa.negativeTestChecks) {
            const gates = quality.context.validation.gates;
            invariant(check.evidence.trim().length > 0 && [...check.paths, ...check.inspectedPaths].every(p => (quality.candidatePaths ?? quality.paths).has(p)) &&
                check.receiptIds.every(id => gates.some(g => g.receiptId === id)), 'QA_SECURITY', 'Negative-test evidence references unknown files or receipts');
            if (check.status === 'review') {
                const declared = checkedSpec.security.requirements.find(r => r.id === check.requirementId)!.negativeTests[check.testIndex]!;
                invariant(declared.startsWith('[review] '), 'QA_REVIEW_AUTHORIZATION', `Negative case ${check.requirementId}[${check.testIndex}] requires test evidence. A review-only assessment needs an explicit [review] marker approved through a spec criterion amendment.`);
                // `paths` on older review reports names inspected files, never executed tests.
                invariant(check.evidence.trim().length >= 40 && !check.receiptIds.some(rid => gates.some(g =>
                    g.receiptId === rid && g.covers.some(k => ['unit', 'integration', 'browser'].includes(k)))),
                    'QA_SECURITY', 'A review-only negative case says what was inspected and found, and cannot cite a behavioral test receipt');
            }
            if (check.status === 'pass') invariant(check.paths.length > 0 && check.paths.every(p => gates.some(g =>
                g.receiptId && check.receiptIds.includes(g.receiptId) && g.covers.some(k => ['unit', 'integration', 'browser'].includes(k)) &&
                g.testPaths.some(pattern => matches(p, pattern)))), 'QA_SECURITY', 'A negative-test pass needs actual test files covered by a successful behavioral gate testPaths');
            const requirementCheck = qa.securityChecks.find(c => c.requirementId === check.requirementId);
            if (qa.verdict === 'pass' || requirementCheck?.status === 'pass') invariant(check.status === 'pass' || check.status === 'review', 'QA_SECURITY', 'Security pass contradicts negative-test evidence');
        }
    } else invariant(!qa.negativeTestChecks.length, 'QA_SECURITY', 'Negative-test receipts require evidence mode and controller context');
    invariant([qa.summary, ...qa.criteria.map(c => c.evidence), ...qa.findings.map(f => f.description), ...qa.observations].every(t => t.trim().length > 0), 'QA', 'Blank QA evidence is not accepted');
    invariant(qa.candidateSha === candidateSha, 'QA_SHA', 'QA must name the exact candidate');
    const ids = qa.criteria.map(c => c.id);
    invariant(new Set(ids).size === ids.length && ids.length === checkedSpec.acceptance.length && checkedSpec.acceptance.every(c => ids.includes(c.id)), 'QA_COVERAGE', 'QA must assess every criterion exactly once');
    invariant(new Set(qa.findings.map(f => f.id)).size === qa.findings.length, 'QA', 'Duplicate finding id');
    invariant(new Set(qa.decisionChecks.map(d => d.decisionId)).size === qa.decisionChecks.length, 'QA_DECISIONS', 'Duplicate decision check');
    invariant(new Set(qa.securityChecks.map(d => d.requirementId)).size === qa.securityChecks.length, 'QA_SECURITY', 'Duplicate security check');
    for (const requirement of checkedSpec.security.requirements) {
        const check = qa.securityChecks.find(x => x.requirementId === requirement.id);
        invariant(check, 'QA_SECURITY', `QA did not assess security requirement ${requirement.id}`);
        if (qa.verdict === 'pass') invariant(check.status === 'pass', 'QA_SECURITY', `QA pass contradicts security requirement ${requirement.id}`);
    }
    const scopeTarget: DecisionTarget = { paths: checkedSpec.tasks.flatMap(t => t.allowedPaths) };
    const requiredDecisionIds = new Set([...confirmedDecisions(decisions, 'product').filter(d => decisionApplies(d, scopeTarget)).map(d=>d.id), ...checkedSpec.decisionResolutions.map(r=>r.decisionId)]);
    for (const decisionId of requiredDecisionIds) {
        const check = qa.decisionChecks.find(d => d.decisionId === decisionId);
        invariant(check, 'QA_DECISIONS', `QA did not assess required decision ${decisionId}`);
        if (qa.verdict === 'pass') invariant(check.status === 'pass', 'QA_DECISIONS', `QA pass contradicts decision ${decisionId}`);
    }
    if (qa.verdict === 'pass')
        invariant(qa.criteria.every(c => c.status === 'pass') && qa.decisionChecks.every(d => d.status === 'pass') && qa.securityChecks.every(d => d.status === 'pass') && !qa.findings.some(findingRequiresFix), 'QA_VERDICT', 'QA pass contradicts failed/unknown criteria, decisions or blocking findings');
    return qa;
}
export function stricter(...values: Lane[]): Lane { return lanes[Math.max(...values.map(v => lanes.indexOf(v)))]!; }
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
    previous: { description: string; verification: string };
    description: string;
    verification: string;
    /** Security requirements linked to this criterion that carried the same unsatisfiable constraint. */
    requirements?: { id: string; previous: string; verification: string; reviewTests?: { index: number; previous: string }[];
        previousNegativeTests?: string[]; negativeTests?: string[] }[];
    reason: string;
    hash: string;
    status: 'pending' | 'approved';
    at: number;
    approvedAt: number | null;
    reviewer: string | null;
    note: string | null;
}
export function criterionAmendmentHash(a: Pick<CriterionAmendment, 'criterionId' | 'previous' | 'description' | 'verification' | 'reason' | 'requirements'>): string {
    return hash({ criterionId: a.criterionId, previous: a.previous, description: a.description, verification: a.verification, reason: a.reason, requirements: a.requirements ?? [] });
}
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
    qaRepairAuthorization?: { at: number; reviewer: string; note: string } | null;
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
    impactAdvice?: { test: string; changedBy: string; assignedTo: string | null; tokens: string[]; evidence: 'declared-later' | 'resolved-import' }[];
    /** Tasks whose declared file surface is larger than one agent session usually completes. Advisory only. */
    sizeAdvice?: { taskId: string; title: string; paths: number }[];
    review: ReviewWorkspace | null;
    sessionStartedAt: number | null;
    activeMs: number;
    planningMs?: number;
    planningStartedAt?: number | null;
    operational?: { maxSpecCostUsd: number | null; maxActiveMs: number;
        /** Retries allowed when a role returns a malformed output; execution-only, proves nothing less. */
        maxOutputRepairs?: number;
        /** Execution-only gate changes: strictly more proof, never less. See amendBudget. */
        gates?: { add: import('../domain/contracts.js').Config['gates']; resources: Record<string, string[]>; timeoutMs: Record<string, number> }; agent: Partial<Pick<import('../domain/contracts.js').AgentConfig, 'model' | 'effort' | 'timeoutMs' | 'maxTurns' | 'maxBudgetUsd' | 'usageMode'>> | null; roles?: Partial<Record<'product' | 'design' | 'implementer' | 'qa', Partial<Pick<import('../domain/contracts.js').AgentConfig, 'model' | 'effort' | 'timeoutMs' | 'maxTurns' | 'maxBudgetUsd' | 'usageMode'>>>>; at: number; reviewer: string; note: string };
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
export function specHash(record: Pick<SpecRecord, 'repo' | 'baseSha' | 'configHash' | 'revision' | 'decisionLedgerHash' | 'securityContextHash' | 'content' | 'executionPath' | 'architecture'>): string {
    return hash({ repo: record.repo, baseSha: record.baseSha, configHash: record.configHash, revision: record.revision, decisionLedgerHash: record.decisionLedgerHash, securityContextHash: record.securityContextHash, content: record.content,
        ...(record.executionPath ? { executionPath: record.executionPath, architecture: record.architecture ?? null } : {}) });
}
export function approvalHash(record: Pick<SpecRecord, 'contentHash' | 'design'>): string | null {
    if (!record.contentHash) return null;
    return record.design ? hash({ spec: record.contentHash, design: record.design.hash }) : record.contentHash;
}
export function reviewer(name: string, note: string): void {
    invariant(name.trim().length >= 3 && name.length <= 120 && note.trim().length >= 10 && note.length <= 4000, 'REVIEW', 'Provide a reviewer name and meaningful note');
}
export function specMarkdown(record: SpecRecord, id: string): string {
    const s = record.content;
    if (!s)
        return `# Spec ${id}\n\nProduct has not produced a valid proposal.\n`;
    const lines = [`# ${s.title}`, '', `Spec: ${id} · revision ${record.revision} · ${record.status}`, `Approval hash: ${approvalHash(record)}`, `Decision ledger: ${record.decisionLedgerHash}`, '', s.problem, '', '## Scope', ...s.scope.map(x => `- ${x}`), '', '## Out of scope', ...s.outOfScope.map(x => `- ${x}`), '', '## Acceptance'];
    if (record.executionPath) lines.splice(5, 0, `Execution path: ${record.executionPath}`);
    if (record.architecture) lines.push('## Architecture', record.architecture.summary, ...record.architecture.decisions.map(d => `- ${d.decision}: ${d.rationale}\n  Constraint: ${d.constraint ?? d.rationale}\n  Simpler alternative: ${d.simplerAlternative ?? 'not recorded'}\n  Risks: ${d.risks?.join('; ') ?? 'not recorded'}\n  Alternatives: ${d.alternatives.join('; ')}\n  Tradeoffs: ${d.tradeoffs.join('; ')}\n  Reconsider when: ${d.reconsiderWhen.join('; ')}`), '');
    for (const c of s.acceptance)
        lines.push(`### ${c.id}`, c.description, `Verification: ${c.verification}`, '');
    if (s.decisionCoverage.length) lines.push('## Project decision coverage', ...s.decisionCoverage.map(x => `- ${x.decisionId} → ${x.acceptanceIds.join(', ')}: ${x.rationale}`), '');
    lines.push('## Security', `Minimum lane: ${record.securityContext.minimumLane}`, `OWASP topics: ${s.security.owaspTopics.join(', ') || 'none'}`, `Threat model: ${s.security.threatModel.required ? 'required' : 'not required'}`);
    if (s.security.requirements.length) lines.push(...s.security.requirements.map(x => `- **${x.id}** ${x.title} → ${x.acceptanceIds.join(', ')} [${x.owaspTopics.join(', ')}]`));
    if (s.security.threatModel.threats.length) lines.push('', '### Threats', ...s.security.threatModel.threats.map(x => `- **${x.id}** (${x.category}): ${x.description}`));
    lines.push('', '## Experience', `UI impact: ${s.experience.uiImpact}`, `Surfaces: ${s.experience.surfaces.join(', ') || 'none'}`, s.experience.rationale, '', '## Decisions', ...s.decisions.map(x => `- ${x.question}: ${x.answer}`), '', '## Open questions', ...s.questions.map(x => `- ${x.id}: ${x.question}`), '', '## Tasks');
    for (const t of s.tasks)
        lines.push(`### ${t.id} — ${t.title}`, t.description, `Criteria: ${t.acceptanceIds.join(', ')}`, `Paths: ${t.allowedPaths.join(', ')}`, `Dependencies: ${t.dependsOn.join(', ') || 'none'}`, '');
    return lines.join('\n') + '\n';
}
