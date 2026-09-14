import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec, validateQa, specHash, taskOrder } from '../dist/lifecycle/contracts.js';
import { strictSchema } from '../dist/lifecycle/roles.js';
import { specSchema, configSchema, validateConfig } from '../dist/index.js';
import { demoSpec } from './lifecycle-helpers.mjs';
import { classify } from '../dist/policy/policy.js';
import { fixtureConfig } from '../examples/lifecycle-fixture.mjs';
const clone = () => demoSpec();
const rejects = {
    'unknown field': s => { s.autorun = true; }, 'duplicate criterion': s => s.acceptance.push(s.acceptance[0]),
    'duplicate task': s => s.tasks.push(s.tasks[0]), 'missing dependency': s => s.tasks[0].dependsOn.push('MISSING'),
    'dependency cycle': s => s.tasks[0].dependsOn.push('DOC'), 'duplicate dependency': s => s.tasks[1].dependsOn.push('MATH'),
    'unknown criterion': s => s.tasks[0].acceptanceIds.push('MISSING'), 'unsafe glob': s => s.tasks[0].allowedPaths = ['../secret'],
    'blank criterion': s => s.acceptance[0].description = '  ', 'empty paths': s => s.tasks[0].allowedPaths = [],
    'blank title': s => s.title = '   ', 'duplicate criterion reference': s => s.tasks[0].acceptanceIds.push('AC-MATH'),
};
for (const [name, change] of Object.entries(rejects))
    test('spec rejects ' + name, () => { const s = clone(); change(s); assert.throws(() => validateSpec(s)); });
test('open questions allowed in draft, never in approved spec', () => { assert.equal(validateSpec(demoSpec(true)).questions.length, 1); assert.throws(() => validateSpec(demoSpec(true), true), /questions/i); });
test('approved spec requires tasks and complete acceptance coverage', () => { const s = clone(); s.tasks = []; assert.throws(() => validateSpec(s, true)); s.tasks = [clone().tasks[0]]; assert.throws(() => validateSpec(s, true), /criteria/i); });
test('task order follows dependencies, not array order', () => { const s = clone(); s.tasks.reverse(); assert.deepEqual(taskOrder(s).map(t => t.id), ['MATH', 'DOC']); });
test('spec hash binds base, config, repository, revision, decision ledger, security context and content', () => { const input = { repo: '/repo', baseSha: 'a'.repeat(40), configHash: 'b'.repeat(64), decisionLedgerHash: 'e'.repeat(64), securityContextHash: 'f'.repeat(64), revision: 1, content: clone() }; const h = specHash(input); for (const [k, v] of Object.entries({ repo: '/other', baseSha: 'c'.repeat(40), configHash: 'd'.repeat(64), decisionLedgerHash: '1'.repeat(64), securityContextHash: '2'.repeat(64), revision: 2, content: { ...clone(), title: 'Other' } }))
    assert.notEqual(specHash({ ...input, [k]: v }), h); });
function qa() { return { candidateSha: 'a'.repeat(40), verdict: 'pass', summary: 'Reviewed fixture.', criteria: clone().acceptance.map(c => ({ id: c.id, status: 'pass', evidence: 'Observed tests and code.' })), findings: [], observations: [] }; }
for (const [name, change] of Object.entries({ 'wrong SHA': q => q.candidateSha = 'b'.repeat(40), 'missing criterion': q => q.criteria.pop(), 'duplicate criterion': q => q.criteria[1] = q.criteria[0], 'unknown criterion': q => q.criteria[0].id = 'NO', 'pass with unknown': q => q.criteria[0].status = 'unknown', 'pass with blocker': q => q.findings = [{ id: 'F1', severity: 'blocker', path: 'src/math.mjs', description: 'Bug found.' }], 'blank evidence': q => q.criteria[0].evidence = '  ', 'empty SHA': q => q.candidateSha = '' }))
    test('QA rejects ' + name, () => { const q = qa(); change(q); assert.throws(() => validateQa(q, clone(), 'a'.repeat(40))); });
test('QA may report unknown as changes requested', () => { const q = qa(); q.verdict = 'changes_requested'; q.criteria[0].status = 'unknown'; assert.equal(validateQa(q, clone(), q.candidateSha).verdict, 'changes_requested'); });
test('role schema normalizes required fields without mutating runtime defaults', () => { const strict = strictSchema(configSchema.json); assert.equal(strict.required.length, Object.keys(strict.properties).length); assert.ok(!('default' in strict.properties.concurrency)); assert.ok('default' in configSchema.json.properties.concurrency); assert.equal(specSchema.json.additionalProperties, false); });
test('pipeline assistant instructions are sensitive files', () => { assert.equal(classify({ files: ['.agent-pipeline/roles/product.md'], lines: 1, binary: false }, validateConfig(fixtureConfig())).lane, 'high'); });
test('provider schemas use only portable structured-output keywords at every depth', () => {
    const allowed = new Set(['type', 'enum', 'description', 'title', 'properties', 'required', 'additionalProperties', 'items', 'anyOf']);
    const walk = (schema) => { for (const key of Object.keys(schema))
        assert.ok(allowed.has(key), `Unsupported provider keyword ${key}`); if (schema.properties) {
        assert.deepEqual(schema.required, Object.keys(schema.properties));
        assert.equal(schema.additionalProperties, false);
        Object.values(schema.properties).forEach(walk);
    } if (schema.items)
        walk(schema.items); if (schema.anyOf)
        schema.anyOf.forEach(walk); };
    walk(strictSchema(configSchema.json));
    walk(strictSchema(specSchema.json));
});
test('provider literal schema has explicit type and enum instead of const', () => {
    assert.deepEqual(strictSchema({ const: 1 }), { type: 'integer', enum: [1] });
    assert.deepEqual(strictSchema({ const: 'fixed' }), { type: 'string', enum: ['fixed'] });
});
test('provider schema normalization never weakens authoritative runtime validation', () => {
    const proposal = demoSpec();
    proposal.title = 'bad\0title';
    strictSchema(specSchema.json);
    assert.throws(() => validateSpec(proposal));
    const config = fixtureConfig();
    config.concurrency = 999;
    strictSchema(configSchema.json);
    assert.throws(() => validateConfig(config));
});

test('confirmed product decisions must map to acceptance criteria before spec approval', () => {
    const ledger = { schemaVersion: 1, decisions: [{ id:'D-AUTH', subject:'Authentication', value:'email/password', enforcement:'product', status:'confirmed', source:'operator', sourceQuote:'email/password', rationale:'Explicit operator decision.', supersedes:[] }] };
    const spec = clone();
    assert.throws(() => validateSpec(spec, true, ledger), /D-AUTH|decision/i);
    spec.decisionCoverage = [{ decisionId:'D-AUTH', acceptanceIds:[spec.acceptance[0].id], rationale:'Authentication criterion preserves the confirmed login method.' }];
    assert.equal(validateSpec(spec, true, ledger).decisionCoverage[0].decisionId, 'D-AUTH');
});

test('QA cannot pass while a confirmed product decision is unassessed or failed', () => {
    const ledger = { schemaVersion: 1, decisions: [{ id:'D-LOAN-TARGET', subject:'Loan target', value:'A loan references a physical copy', enforcement:'product', status:'confirmed', source:'operator', sourceQuote:'physical copy', rationale:'Explicit domain constraint.', supersedes:[] }] };
    const spec = clone();
    spec.decisionCoverage = [{ decisionId:'D-LOAN-TARGET', acceptanceIds:[spec.acceptance[0].id], rationale:'Criterion verifies the loan relationship.' }];
    const report = qa();
    assert.throws(() => validateQa(report, spec, report.candidateSha, ledger), /D-LOAN-TARGET|decision/i);
    report.decisionChecks = [{ decisionId:'D-LOAN-TARGET', status:'pass', evidence:'Loan model references the physical-copy identifier and tests cover it.' }];
    assert.equal(validateQa(report, spec, report.candidateSha, ledger).verdict, 'pass');
    report.decisionChecks[0].status = 'fail';
    assert.throws(() => validateQa(report, spec, report.candidateSha, ledger), /decision/i);
});

test('ambiguous Product decisions stay questions until an operator-backed resolution is captured', () => {
    const question='Souhaitez-vous inclure le multi-site dans le MVP, ou le laisser hors MVP ?';
    const ledger={schemaVersion:1,decisions:[{id:'D-MULTI',subject:'Multi-site scope',value:'unresolved',enforcement:'product',status:'ambiguous',source:'operator',sourceQuote:'je valide le mvp et le hors mvp; sauf le multi sites',rationale:'Exception scope is ambiguous.',supersedes:[],clarificationQuestion:question,interpretations:['Include multi-site in MVP.','Keep multi-site outside MVP.']}]};
    const draft=clone(); draft.questions=[{id:'Q-MULTI',question}];
    assert.equal(validateSpec(draft,false,ledger).questions[0].question,question);
    assert.throws(()=>validateSpec(draft,true,ledger),/questions|ambiguous/i);
    const resolved=clone();
    resolved.decisionResolutions=[{decisionId:'D-MULTI',value:'outside MVP',sourceQuote:'Le multi-site reste hors MVP.',rationale:'Explicit operator clarification.'}];
    resolved.decisionCoverage=[{decisionId:'D-MULTI',acceptanceIds:[resolved.acceptance[0].id],rationale:'Acceptance keeps multi-site outside this spec.'}];
    const operatorText='Initial request. Operator refinement: Le multi-site reste hors MVP.';
    assert.equal(validateSpec(resolved,true,ledger,operatorText).decisionResolutions[0].value,'outside MVP');
    assert.throws(()=>validateSpec(resolved,true,ledger,'No matching clarification here.'),/source quote/i);
    const report=qa();
    assert.throws(()=>validateQa(report,resolved,report.candidateSha,ledger),/D-MULTI|decision/i);
    report.decisionChecks=[{decisionId:'D-MULTI',status:'pass',evidence:'Candidate and acceptance criteria remain single-site.'}];
    assert.equal(validateQa(report,resolved,report.candidateSha,ledger).verdict,'pass');
});
