import test from 'node:test';
import { neutralSecurityContext } from '../dist/security/owasp.js';
import { planGates, validationRequirements } from '../dist/policy/policy.js';
import { assertRequiredEvidence } from '../dist/quality/review.js';
import { specSchema, validateQa, validateSpec } from '../dist/lifecycle/contracts.js';
import { architectureSchema } from '../dist/lifecycle/pathways.js';
import assert from 'node:assert/strict';
import { validateConfig } from '../dist/domain/contracts.js';
import { qualityContext, validateQualityChecks } from '../dist/quality/review.js';
import { fixture, approved, oneTask, passingQa } from './lifecycle-helpers.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sha = 'a'.repeat(40), configHash = 'b'.repeat(64);
function sample() {
  const config = validateConfig({ schemaVersion: 1, executionMode: 'local-trusted', environment: { id: 'fixture' },
    agent: { type: 'command', command: ['fixture-agent'] }, workflow: { qualityReview: 'evidence' }, gates: [
      { id: 'tests', command: ['node', '--test'], covers: ['unit'] },
      { id: 'browser', command: ['node', 'browser.mjs'], covers: ['browser'], paths: ['ui/**'] },
      { id: 'other', command: ['node', 'check.mjs'] },
    ] });
  const receipt = { id: 'R1', runId: 'RUN', gateId: 'tests', candidateSha: sha, configHash, status: 'passed', exitCode: 0, reusedFrom: null };
  const run = { id: 'RUN', config, configHash, candidateSha: sha, gateIds: ['tests', 'other'],
    changeSet: { files: ['src/math.mjs'], added: [], lines: 2, binary: false }, risk: { lane: 'standard' }, receipts: [receipt] };
  const record = { config, executionPath: 'standard', content: { experience: { uiImpact: 'none' } } };
  const context = qualityContext(record, run);
  const report = { verdict: 'pass', findings: [], qualityChecks: context.axes.map(x => ({ axis: x.axis,
    status: x.required ? 'pass' : 'not_applicable', evidence: 'Inspected the arithmetic contract and its independent tests.',
    paths: x.required ? ['src/math.mjs'] : [], receiptIds: x.axis === 'tests' ? ['R1'] : [], findingIds: [] })) };
  return { record, run, context, report };
}

test('validation evidence distinguishes missing, unselected and observed gates without guessing coverage', () => {
  const { context } = sample();
  assert.deepEqual(context.validation.gates.map(x => [x.id, x.status]), [['tests', 'passed'], ['browser', 'not_selected'], ['other', 'missing']]);
  assert.deepEqual(context.validation.observed, ['unit']);
  assert.ok(context.validation.gaps.includes('browser'));
});

test('quality evidence rejects a receipt from another candidate, config, run or unselected gate', () => {
  for (const change of [{ candidateSha: 'c'.repeat(40) }, { configHash: 'd'.repeat(64) }, { runId: 'OTHER' }, { gateId: 'browser' }]) {
    const { record, run } = sample();
    Object.assign(run.receipts[0], change);
    assert.deepEqual(qualityContext(record, run).validation.observed, []);
  }
});

test('QA must cover each quality axis and reference real paths and observed receipts', () => {
  const { report, context } = sample();
  const paths = new Set(['src/math.mjs']);
  assert.doesNotThrow(() => validateQualityChecks(report, context, paths));
  assert.throws(() => validateQualityChecks(report), /evidence mode/);
  assert.doesNotThrow(() => validateQualityChecks({ verdict: 'pass', findings: [], qualityChecks: [] }));
  for (const change of [q => q.qualityChecks.pop(), q => q.qualityChecks.push(q.qualityChecks[0]),
    q => q.qualityChecks[0].paths.push('invented.mjs'), q => q.qualityChecks[3].receiptIds.push('invented'),
    q => q.qualityChecks[3].receiptIds = [], q => q.qualityChecks[3].status = 'not_applicable']) {
    const bad = structuredClone(report); change(bad);
    assert.throws(() => validateQualityChecks(bad, context, paths), /quality|Quality|receipt|Receipt/);
  }
});

test('unknown quality is not a pass and cosmetic findings cannot request a repair', () => {
  const { report, context } = sample();
  const cosmetic = { ...structuredClone(report), verdict: 'changes_requested',
    findings: [{ id: 'STYLE', severity: 'minor', path: 'src/math.mjs', description: 'A naming preference.' }] };
  assert.throws(() => validateQualityChecks(cosmetic, context, new Set(['src/math.mjs'])), /Minor observations/);
  cosmetic.findings[0].severity = 'major'; cosmetic.findings[0].path = 'invented.mjs';
  assert.throws(() => validateQualityChecks(cosmetic, context, new Set(['src/math.mjs'])), /real repository path/);
  report.qualityChecks[0].status = 'unknown';
  assert.throws(() => validateQualityChecks(report, context, new Set(['src/math.mjs'])), /pass/i);
  report.verdict = 'changes_requested';
  assert.doesNotThrow(() => validateQualityChecks(report, context, new Set(['src/math.mjs'])));
  report.qualityChecks[0].status = 'fail';
  assert.throws(() => validateQualityChecks(report, context, new Set(['src/math.mjs'])), /finding/i);
  report.findings = [{ id: 'F1', severity: 'major', path: 'src/math.mjs', description: 'An invalid input corrupts the result.' }];
  report.qualityChecks[0].findingIds = ['F1'];
  assert.doesNotThrow(() => validateQualityChecks(report, context, new Set(['src/math.mjs'])));
});

test('a cached final receipt is distinct from a missing or failed check', () => {
  const { record, run } = sample();
  Object.assign(run.receipts[0], { status: 'cached', reusedFrom: 'OLDER' });
  let context = qualityContext(record, run);
  assert.deepEqual(context.validation.observed, ['unit']);
  assert.equal(context.validation.gates[0].reusedFrom, 'OLDER');
  run.receipts[0].status = 'failed'; run.receipts[0].exitCode = 1;
  context = qualityContext(record, run);
  assert.deepEqual(context.validation.observed, []);
  assert.equal(context.validation.gates[0].status, 'failed');
});

test('documentation needs no invented behavioral tests; UI changes expose browser coverage gaps', () => {
  const { record, run } = sample();
  run.changeSet.files = ['docs/usage.md'];
  assert.equal(qualityContext(record, run).axes.find(x => x.axis === 'tests').required, false);
  run.changeSet.files = ['ui/card.css'];
  const ui = qualityContext(record, run);
  assert.equal(ui.axes.find(x => x.axis === 'ui').required, true);
  assert.ok(ui.validation.gaps.includes('browser'));
});

test('quality evidence is enforced on import and delivery; unknown evidence does not start code repairs', async t => {
  const f = fixture(t);
  f.config.workflow = { ...f.config.workflow, qualityReview: 'evidence' };
  f.config.gates = f.config.gates.map(g => ({ ...g, covers: g.id === 'unit' ? ['unit'] : [] }));
  let d = await approved(f, oneTask());
  d = await f.life.run(d.id, { manualQa: true });
  assert.equal(d.data.error.code, 'QA_REQUIRED');
  const final = f.life.pipeline.store.get(d.data.finalRunId);
  await assert.rejects(f.life.importQa(d.id, passingQa(d)), /quality/i);
  const context = qualityContext(d.data, final);
  const report = { ...passingQa(d), qualityChecks: context.axes.map(x => ({ axis: x.axis,
    status: x.required ? 'pass' : 'not_applicable', evidence: 'Fixture review inspected arithmetic behavior and the independent test receipt.',
    paths: x.required ? ['src/math.mjs', 'test/math.test.mjs'] : [],
    receiptIds: x.axis === 'tests' ? [final.receipts.find(r => r.gateId === 'unit').id] : [], findingIds: [] })) };
  const invented = structuredClone(report); invented.qualityChecks[0].paths = ['src/invented.mjs'];
  await assert.rejects(f.life.importQa(d.id, invented), /quality/i);
  const unknown = structuredClone(report); unknown.verdict = 'changes_requested'; unknown.qualityChecks[3].status = 'unknown';
  await f.life.importQa(d.id, unknown);
  d = await f.life.run(d.id, { manualQa: true });
  assert.equal(d.data.error.code, 'QA_EVIDENCE');
  assert.equal(d.data.qaRepairs, 0);
  assert.equal(d.data.attempts.length, 1);
  await assert.rejects(f.life.publicationCandidate(d.id, 'review'), /QA/);
  await f.life.importQa(d.id, report);
  d = await f.life.run(d.id, { manualQa: true });
  assert.equal(d.data.status, 'awaiting_review');
  assert.match(readFileSync(d.data.review.qaPath, 'utf8'), /Code quality/);
  assert.match(readFileSync(d.data.review.reviewPath, 'utf8'), /Unverified coverage categories/);
  assert.equal(f.life.summary(d).quality.validation.observed.includes('unit'), true);
  // A stored report cannot bypass quality enforcement at the publication boundary.
  d.data.qa.report.qualityChecks = [];
  f.life.store.saveDocument(d, 'fixture.corrupt_quality');
  await assert.rejects(f.life.publicationCandidate(d.id, 'review'), /quality/i);
});

test('targeted agent QA receives the quality matrix and completes it in the existing QA call', async t => {
  const f = fixture(t);
  const worker = join(f.root, 'quality-qa.mjs');
  writeFileSync(worker, `import { readFileSync } from 'node:fs';
    import assert from 'node:assert/strict';
    const req = JSON.parse(readFileSync(0, 'utf8'));
    assert.equal(req.context.qaScope.mode, 'targeted');
    const q = req.context.qualityReview;
    assert.equal(q.enabled, true);
    const receipt = q.validation.gates.find(g => g.covers.includes('unit')).receiptId;
    assert.ok(receipt);
    console.log(JSON.stringify({ candidateSha: req.context.candidateSha, verdict: 'pass', summary: 'Protocol fixture review.',
      criteria: req.context.spec.acceptance.map(x => ({ id:x.id, status:'pass', evidence:'Fixture inspected arithmetic behavior.' })),
      findings: [], observations: [], qualityChecks: q.axes.map(x => ({ axis:x.axis, status:x.required?'pass':'not_applicable',
        evidence:'Fixture code review and observed final test receipt.', paths:x.required?['src/math.mjs']:[],
        receiptIds:x.axis==='tests'?[receipt]:[], findingIds:[] })) }));`);
  f.config.workflow = { ...f.config.workflow, planningMode: 'adaptive', qualityReview: 'evidence' };
  f.config.gates = f.config.gates.map(g => ({ ...g, covers: g.id === 'unit' ? ['unit'] : [] }));
  f.config.roles.qa = { type: 'command', command: [process.execPath, worker] };
  let d = await approved(f, oneTask());
  d = await f.life.run(d.id);
  assert.equal(d.data.status, 'awaiting_review', JSON.stringify(d.data.error));
  assert.equal(d.data.qa.report.qualityChecks.length, 6);
  assert.equal(f.life.store.documentEvents(d.id).filter(e => e.type === 'invocation.started' && e.data.role === 'qa').length, 1);
  assert.equal(d.data.qaRepairs, 0);
});


test('validation obligations follow executable risk, UI and project boundaries, not documentation size', () => {
  const { run } = sample();
  const required = (files, lane = 'standard') => validationRequirements(run.config, files, lane).map(r => r.id);
  assert.deepEqual(required(['docs/architecture.md'], 'high'), []);
  assert.deepEqual(required(['src/math.mjs']), ['behavior']);
  assert.deepEqual(required(['src/math.ts']), ['behavior', 'build']);
  assert.deepEqual(required(['src/routes/loans.mjs']), ['behavior', 'integration']);
  assert.deepEqual(required(['ui/app.js'], 'fast'), ['behavior', 'browser']);
  assert.deepEqual(required(['src/auth/roles.ts'], 'high'), ['behavior', 'build', 'integration']);
  run.config.validationRules = [{ id: 'domain-boundaries', paths: ['src/domain/**'], requires: ['architecture'] }];
  assert.ok(required(['src/domain/loans.mjs']).includes('rule:domain-boundaries:architecture'));
  run.config.workflow.qualityReview = 'legacy';
  assert.deepEqual(required(['src/auth/roles.ts'], 'high'), []);
});

test('required checks override lane filtering, retain their dependencies and do not select unrelated packages', () => {
  const { run } = sample();
  run.config.gates = validateConfig({ ...run.config, gates: [
    { id: 'prepare-browser', command: ['node', 'prepare.mjs'], lanes: ['high'], paths: ['ui/**'] },
    { id: 'browser', command: ['node', 'browser.mjs'], covers: ['browser'], lanes: ['high'], paths: ['ui/**'], dependsOn: ['prepare-browser'] },
    { id: 'unrelated', command: ['node', 'admin.mjs'], covers: ['browser'], paths: ['admin/**'] },
  ] }).gates;
  assert.deepEqual(planGates(run.config, { ...run.changeSet, files: ['ui/app.js'] }, 'fast').map(g => g.id), ['prepare-browser', 'browser']);
});

test('missing build, integration, browser or architecture proof blocks a pass even with successful unit tests', () => {
  for (const file of ['src/lib.ts', 'src/routes/loans.mjs', 'ui/card.css', 'src/domain/entity.mjs']) {
    const { record, run, report } = sample();
    run.config.validationRules = [{ id: 'boundaries', paths: ['src/domain/**'], requires: ['architecture'] }];
    run.changeSet.files = [file];
    const context = qualityContext(record, run);
    assert.throws(() => assertRequiredEvidence(context.validation), e => e.code === 'QA_EVIDENCE');
    assert.throws(() => validateQualityChecks(report, context, new Set(['src/math.mjs'])), /evidence|applies|browser/i);
  }
});

test('successful receipts discharge requirements only for the affected package and exact candidate', () => {
  const { record, run } = sample();
  run.changeSet.files = ['ui/card.css'];
  run.gateIds.push('browser');
  run.receipts.push({ ...run.receipts[0], id: 'BROWSER', gateId: 'browser' });
  assert.doesNotThrow(() => assertRequiredEvidence(qualityContext(record, run).validation));
  run.config.gates.find(g => g.id === 'browser').paths = ['other-ui/**'];
  assert.throws(() => assertRequiredEvidence(qualityContext(record, run).validation), /browser/);
  run.config.gates.find(g => g.id === 'browser').paths = ['ui/**'];
  run.receipts[1].candidateSha = 'd'.repeat(40);
  assert.throws(() => assertRequiredEvidence(qualityContext(record, run).validation), /browser/);
});

test('declared UI and structural impact still require execution proof when file names are inconclusive', () => {
  const { record, run } = sample();
  record.content.experience.uiImpact = 'minor';
  assert.throws(() => assertRequiredEvidence(qualityContext(record, run).validation), /browser/);
  record.content.experience.uiImpact = 'none'; record.executionPath = 'structural';
  assert.throws(() => assertRequiredEvidence(qualityContext(record, run).validation), /integration/);
});

test('UI review cannot pass with source inspection or unit-test receipts instead of browser execution', () => {
  const { record, run, report } = sample();
  run.changeSet.files = ['ui/card.css']; run.gateIds.push('browser');
  run.receipts.push({ ...run.receipts[0], id: 'BROWSER', gateId: 'browser' });
  const context = qualityContext(record, run);
  const ui = report.qualityChecks.find(c => c.axis === 'ui');
  ui.status = 'pass'; ui.paths = ['ui/card.css']; ui.receiptIds = ['R1'];
  const paths = new Set(['src/math.mjs', 'ui/card.css']);
  assert.throws(() => validateQualityChecks(report, context, paths), /browser receipt/);
  ui.receiptIds = ['BROWSER'];
  assert.doesNotThrow(() => validateQualityChecks(report, context, paths));
});

test('every security negative case must cite a real test file executed by a final behavioral gate', () => {
  const { record, run, report } = sample();
  const spec = specSchema.parse(oneTask());
  spec.security.requirements = [{ id: 'SEC-INPUT', title: 'Reject invalid inputs', owaspTopics: [],
    acceptanceIds: ['AC-MATH'], verification: 'Reject invalid values.', negativeTests: ['Reject strings', 'Reject null'] }];
  // Use a schema-valid topic without binding this regression to the routing catalogue spelling.
  const { owaspTopics } = specSchema.json.properties.security.properties.requirements.items.properties;
  spec.security.requirements[0].owaspTopics = [owaspTopics.items.enum[0]];
  run.config.gates[0].testPaths = ['test/math.test.mjs'];
  const paths = new Set(['src/math.mjs', 'test/math.test.mjs', 'test/unrelated.test.mjs']);
  const context = qualityContext(record, run);
  const qa = { ...report, candidateSha: sha, summary: 'Input rejection verified.',
    criteria: [{ id: 'AC-MATH', status: 'pass', evidence: 'Observed behavior tests.' }], observations: [],
    securityChecks: [{ requirementId: 'SEC-INPUT', status: 'pass', evidence: 'Inspected validation at the boundary.' }],
    negativeTestChecks: [0, 1].map(testIndex => ({ requirementId: 'SEC-INPUT', testIndex, status: 'pass',
      evidence: 'Specific rejection assertion in the inspected suite.', paths: ['test/math.test.mjs'], receiptIds: ['R1'] })) };
  const validate = value => validateQa(value, spec, sha, undefined, { context, paths, candidatePaths: paths });
  assert.doesNotThrow(() => validate(qa));
  for (const change of [q => q.negativeTestChecks.pop(), q => q.negativeTestChecks[1].testIndex = 0,
    q => q.negativeTestChecks[0].paths = ['test/unrelated.test.mjs'], q => q.negativeTestChecks[0].paths = [],
    q => q.negativeTestChecks[0].receiptIds = [], q => q.negativeTestChecks[0].receiptIds = ['FAKE'],
    q => q.negativeTestChecks[0].status = 'unknown']) {
    const bad = structuredClone(qa); change(bad); assert.throws(() => validate(bad), /negative|Negative|Security/);
  }
  assert.throws(() => validateQa(qa, spec, sha, undefined, { context, paths, candidatePaths: new Set(['src/math.mjs']) }), /unknown files/);
  context.validation.gates[0].covers = ['security'];
  assert.throws(() => validate(qa), /behavioral/);
});

test('structural decisions require the constraint, simpler option, risks and reconsideration trigger', () => {
  const decision = { decision: 'Keep a plain function.', rationale: 'One fixed behavior.', constraint: 'Stable public signature.',
    simplerAlternative: 'Use the existing module; no new service is needed.', risks: ['Shared release cycle.'],
    alternatives: ['Separate service'], tradeoffs: ['No independent scaling.'], reconsiderWhen: ['Independent scaling becomes necessary.'] };
  const proposal = { summary: 'Preserve the existing module boundary.', decisions: [decision], inspection: [{ path: 'src/math.mjs', finding: 'Existing entry point.' }] };
  assert.doesNotThrow(() => architectureSchema.parse(proposal));
  for (const field of ['constraint', 'simplerAlternative', 'risks', 'reconsiderWhen']) {
    const missing = structuredClone(proposal); delete missing.decisions[0][field];
    assert.throws(() => architectureSchema.parse(missing), /invalid/);
  }
});

test('compact execution stops on missing required evidence without QA calls or code repair', async t => {
  const f = fixture(t);
  f.config.workflow = { ...f.config.workflow, qualityReview: 'evidence' };
  f.config.gates = f.config.gates.map(g => ({ ...g, covers: g.id === 'unit' ? ['unit'] : [] }));
  f.config.validationRules = [{ id: 'arithmetic-integration', paths: ['src/math.mjs'], requires: ['integration'] }];
  const compactTask = { id: 'MATH', title: 'Multiply', description: 'Add multiplication and its tests.',
    acceptance: ['Multiply positive and negative values correctly.'], allowedPaths: ['src/math.mjs', 'test/math.test.mjs'] };
  let d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Add multiplication.', compactTask });
  d = await f.life.approveSpec(d.id, f.life.summary(d).hash, 'Test Owner', 'Approve the bounded fixture change.');
  d = await f.life.run(d.id);
  assert.equal(d.data.status, 'blocked');
  assert.equal(d.data.error.code, 'QA_EVIDENCE');
  assert.equal(d.data.qa, null);
  assert.equal(d.data.qaRepairs, 0);
  assert.equal(d.data.attempts.length, 1);
  const run = f.life.pipeline.store.get(d.data.attempts[0].runId);
  assert.equal(run.receipts.find(r => r.gateId === 'unit').status, 'passed');
  assert.equal(f.life.store.documentEvents(d.id).filter(e => e.type === 'invocation.started').length, 0);
  await assert.rejects(() => f.life.pipeline.assertValidated(run.id));
  // Resuming does not launch an implementation repair to manufacture missing infrastructure.
  d = await f.life.run(d.id);
  assert.equal(d.data.attempts.length, 1);
  assert.equal(d.data.qaRepairs, 0);
});

test('a browser receipt for one package cannot hide missing coverage for another changed UI', () => {
  const { record, run } = sample();
  run.changeSet.files = ['ui/card.css', 'admin/panel.css']; run.gateIds.push('browser');
  run.receipts.push({ ...run.receipts[0], id: 'BROWSER', gateId: 'browser' });
  const context = qualityContext(record, run);
  assert.deepEqual(context.validation.requirements.find(r => r.id === 'browser').missingPaths, ['admin/panel.css']);
  assert.throws(() => assertRequiredEvidence(context.validation), /admin\/panel.css/);
});

test('local behavioral proof does not force optional expensive suites; test-only edits need no production build', () => {
  const { run } = sample();
  run.config.gates = validateConfig({ ...run.config, gates: [
    { id: 'unit', command: ['node', '--test'], covers: ['unit'], lanes: ['high'] },
    { id: 'browser', command: ['node', 'browser.mjs'], covers: ['browser'], lanes: ['high'] },
    { id: 'integration', command: ['node', 'integration.mjs'], covers: ['integration'], lanes: ['high'] },
  ] }).gates;
  assert.deepEqual(planGates(run.config, run.changeSet, 'standard').map(g => g.id), ['unit']);
  assert.deepEqual(validationRequirements(run.config, ['test/component.test.tsx'], 'high').map(r => r.id), ['behavior']);
});

// Observed on a real store: a spec written before `experience` existed made the whole dashboard listing fail
// with "Erreur interne", because the quality context read that field without guarding it.
test('a spec written before the experience field still yields a quality context', () => {
  const { record, run } = sample();
  const legacy = { ...record, content: { tasks: [], acceptance: [] } };
  const context = qualityContext(legacy, run);
  assert.equal(context.enabled, true);
  assert.equal(context.axes.find(a => a.axis === 'ui').required, false, 'no declared UI impact and no UI file changed');
  const uiChange = qualityContext(legacy, { ...run, changeSet: { ...run.changeSet, files: ['src/routes/+page.svelte'] } });
  assert.equal(uiChange.axes.find(a => a.axis === 'ui').required, true, 'the changed files still decide');
});

// Observed on a real spec: two approved security requirements declared their negative case as a review
// ("confirmed by reviewing the final diff"). No test can cover them, so QA could neither prove nor pass them,
// and the spec was stuck after all ten tasks had been implemented and every check had passed.
test('a negative case the spec defines as a review is assessed as asserted, never as proven', async () => {
  const { record, run, report } = sample();
  const spec = specSchema.parse(oneTask());
  const { owaspTopics } = specSchema.json.properties.security.properties.requirements.items.properties;
  spec.security.requirements = [{ id: 'SEC-SUPPLY', title: 'No dependency or workflow change', owaspTopics: [owaspTopics.items.enum[0]],
    acceptanceIds: ['AC-MATH'], verification: 'No manifest, lockfile or workflow is touched.',
    negativeTests: ['[review] Review of the final diff confirming no manifest, lockfile or workflow change'] }];
  run.config.gates[0].testPaths = ['test/math.test.mjs'];
  const paths = new Set(['src/math.mjs', 'test/math.test.mjs']);
  const context = qualityContext(record, run);
  const qa = { ...report, candidateSha: sha, summary: 'Supply-chain surface unchanged.',
    criteria: [{ id: 'AC-MATH', status: 'pass', evidence: 'Observed behavior tests.' }], observations: [],
    securityChecks: [{ requirementId: 'SEC-SUPPLY', status: 'pass', evidence: 'Read the whole diff.' }],
    negativeTestChecks: [{ requirementId: 'SEC-SUPPLY', testIndex: 0, status: 'review',
      evidence: 'Read every hunk of the final diff: package.json, package-lock.json and .github are untouched.',
      paths: [], receiptIds: [] }] };
  const validate = value => validateQa(value, spec, sha, undefined, { context, paths, candidatePaths: paths });
  assert.doesNotThrow(() => validate(qa), 'the spec itself defined this case as a review');
  assert.throws(() => validateSpec(spec, false, undefined, undefined, { ...neutralSecurityContext(), negativeTestsRequired: true }), /explicit negative security test/, 'review does not satisfy required executable negative coverage');

  // A review says what it inspected, may name the files it read, and never leans on a test receipt.
  const vague = structuredClone(qa); vague.negativeTestChecks[0].evidence = 'Reviewed.';
  assert.throws(() => validate(vague), /inspected and found/);
  const namesRead = structuredClone(qa); namesRead.negativeTestChecks[0].paths = ['src/math.mjs'];
  assert.doesNotThrow(() => validate(namesRead), 'naming the files read is what makes a review checkable');
  const claimsReceipt = structuredClone(qa); claimsReceipt.negativeTestChecks[0].receiptIds = ['R1'];
  assert.throws(() => validate(claimsReceipt), /behavioral test receipt/);
  const originalCase = spec.security.requirements[0].negativeTests[0];
  for (const required of ['Reject unauthorized access with 403.', 'Review of the final diff confirming no changes']) {
    spec.security.requirements[0].negativeTests[0] = required;
    assert.throws(() => validate(qa), /explicit \[review\] marker/, 'QA cannot waive an executable or unmarked case');
  }
  spec.security.requirements[0].negativeTests[0] = originalCase;
  const claimsPass = structuredClone(qa); claimsPass.negativeTestChecks[0].status = 'pass';
  assert.throws(() => validate(claimsPass), /negative-test pass needs actual test files/);
});
