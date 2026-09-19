import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, approved, oneTask, passingQa, git } from './lifecycle-helpers.mjs';
import { validateQa, qaSchema } from '../dist/lifecycle/contracts.js';
import { qualityContext, validateQualityChecks } from '../dist/quality/review.js';
import { proposeConfiguration } from '../dist/lifecycle/onboarding.js';
import { planGates } from '../dist/policy/policy.js';

const sha = 'a'.repeat(40);
const finding = { id: 'CLEANUP', severity: 'minor', resolution: 'required', path: 'src/math.mjs',
  description: 'legacySort has no callers or public entry point after this change replaced its last caller.' };
function report() {
  return { candidateSha: sha, verdict: 'pass', summary: 'Reviewed arithmetic.',
    criteria: oneTask().acceptance.map(c => ({ id: c.id, status: 'pass', evidence: 'Observed arithmetic test and source.' })),
    findings: [{ ...finding }], observations: [] };
}

test('required minor cleanup blocks QA pass even without evidence mode; advisory debt stays compatible', () => {
  const q = report();
  assert.throws(() => validateQa(q, oneTask(), sha), /correction|blocking/);
  q.verdict = 'changes_requested';
  assert.equal(validateQa(q, oneTask(), sha).findings[0].severity, 'minor');
  q.findings[0].path = '../outside';
  assert.throws(() => validateQa(q, oneTask(), sha), /real repository path/);
  q.findings[0].path = finding.path;
  q.verdict = 'pass'; q.findings[0].resolution = 'advisory';
  assert.equal(validateQa(q, oneTask(), sha).verdict, 'pass');
  q.findings[0].severity = 'major';
  assert.throws(() => validateQa(q, oneTask(), sha), /correction|blocking/);
  // Legacy major findings may describe a non-file issue; do not rewrite their historical contract.
  q.verdict = 'changes_requested'; q.findings[0].path = '';
  assert.equal(validateQa(q, oneTask(), sha).verdict, 'changes_requested');
  q.verdict = 'pass'; q.findings[0].path = finding.path;
  q.findings[0].severity = 'minor'; delete q.findings[0].resolution;
  assert.equal(qaSchema.parse(q).findings[0].resolution, 'advisory');
  assert.equal(validateQa(q, oneTask(), sha).verdict, 'pass');
});

function cleanupFixture(t, repairs = 1) {
  const f = fixture(t);
  const worker = join(f.root, 'cleanup-worker.mjs');
  writeFileSync(worker, `import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const req = JSON.parse(readFileSync(0, 'utf8'));
if (req.role === 'qa') {
  const needsCleanup = readFileSync('src/math.mjs', 'utf8').includes('legacySort');
  const q = req.context.qualityReview;
  const receipt = q.validation.gates.find(g => g.covers.includes('unit')).receiptId;
  console.log(JSON.stringify({candidateSha:req.context.candidateSha, verdict:needsCleanup?'changes_requested':'pass',
    summary:'Fixture inspected usage and test receipts.',
    criteria:req.context.spec.acceptance.map(c=>({id:c.id,status:'pass',evidence:'Multiplication is implemented and tested.'})),
    findings:needsCleanup?[${JSON.stringify(finding)}]:[{id:'OLD',severity:'minor',resolution:'advisory',path:'docs/math.md',description:'Pre-existing documentation debt outside this change.'}],
    observations:[], qualityChecks:q.axes.map(x=>({axis:x.axis,status:x.axis==='simplicity'&&needsCleanup?'fail':x.required?'pass':'not_applicable',
      evidence:'Inspected module exports, callers and final arithmetic tests.',paths:x.required?['src/math.mjs']:[],
      receiptIds:x.axis==='tests'?[receipt]:[], findingIds:x.axis==='simplicity'&&needsCleanup?['CLEANUP']:[]}))}));
} else {
  if(req.task.id==='MATH') {
    writeFileSync('src/math.mjs','export const add=(a,b)=>a+b;\\nexport const multiply=(a,b)=>a*b;\\nconst legacySort=()=>0;\\n');
    writeFileSync('test/math.test.mjs',"import{test}from'node:test';import assert from'node:assert/strict';import{add,multiply}from'../src/math.mjs';test('arithmetic',()=>{assert.equal(add(2,3),5);assert.equal(multiply(2,3),6);assert.equal(multiply(-2,3),-6)});\\n");
  } else {
    assert.equal(req.task.id,'SPEC-INTEGRATION');
    assert.match(req.task.description,/resolution=required/);
    assert.match(req.task.description,/legacySort/);
    writeFileSync('src/math.mjs',readFileSync('src/math.mjs','utf8').replace('const legacySort=()=>0;\\n',''));
  }
  console.log(JSON.stringify({summary:'Fixture implemented the feature or removed its obsolete helper.'}));
}`);
  f.config.agent = { type: 'command', command: [process.execPath, worker] };
  f.config.roles.qa = f.config.agent;
  f.config.workflow = { ...f.config.workflow, qualityReview: 'evidence', maxQaRepairs: repairs };
  f.config.gates = f.config.gates.map(g => ({ ...g, covers: g.id === 'unit' ? ['unit'] : [] }));
  return f;
}

test('minor required cleanup runs an actual repair, validates the new candidate, then accepts advisory debt', async t => {
  const f = cleanupFixture(t);
  let d = await approved(f, oneTask());
  const originalDocs = readFileSync(join(f.repo, 'docs/math.md'), 'utf8');
  d = await f.life.run(d.id);
  assert.equal(d.data.status, 'awaiting_review', JSON.stringify(d.data.error));
  assert.equal(d.data.qaRepairs, 1);
  assert.equal(d.data.validationRunIds.length, 2);
  assert.equal(d.data.qa.report.verdict, 'pass');
  assert.equal(d.data.qa.report.findings[0].resolution, 'advisory');
  assert.doesNotMatch(git(f.repo, 'show', `${d.data.currentSha}:src/math.mjs`), /legacySort/);
  assert.equal(git(f.repo, 'show', `${d.data.currentSha}:docs/math.md`).trim(), originalDocs.trim());
  const final = f.life.pipeline.store.get(d.data.finalRunId);
  assert.ok(final.receipts.every(r => r.candidateSha === d.data.currentSha));
  assert.match(readFileSync(d.data.review.qaPath, 'utf8'), /observation/);
  // A mutated persisted report must be rejected again at publication, regardless of its pass verdict.
  d.data.qa.report.findings = [{ ...finding }];
  f.life.store.saveDocument(d, 'fixture.corrupt_cleanup');
  await assert.rejects(f.life.publicationCandidate(d.id, 'review'), /correction|blocking/);
});

test('required cleanup cannot become a silent pass when repair allowance is exhausted', async t => {
  const f = cleanupFixture(t, 0);
  let d = await approved(f, oneTask());
  d = await f.life.run(d.id);
  assert.equal(d.data.error.code, 'QA_REJECTED');
  assert.equal(d.data.qaRepairs, 0);
  assert.equal(d.data.qa.report.findings[0].resolution, 'required');
  assert.equal(d.data.qa.report.findings[0].severity, 'minor');
  await assert.rejects(f.life.publicationCandidate(d.id, 'review'), /QA|ready|review/i);
});

test('required cleanup needs a real inspected path and supports a failed simplicity axis', async t => {
  const f = fixture(t);
  f.config.workflow = { ...f.config.workflow, qualityReview: 'evidence' };
  f.config.gates = f.config.gates.map(g => ({ ...g, covers: g.id === 'unit' ? ['unit'] : [] }));
  let d = await approved(f, oneTask());
  d = await f.life.run(d.id, { manualQa: true });
  const final = f.life.pipeline.store.get(d.data.finalRunId);
  const context = qualityContext(d.data, final);
  const q = { ...passingQa(d), verdict: 'changes_requested', findings: [{ ...finding }],
    qualityChecks: context.axes.map(x => ({ axis: x.axis, status:x.axis === 'simplicity'?'fail':x.required?'pass':'not_applicable',
      evidence: 'Inspected the changed module and observed arithmetic tests.', paths:x.required?['src/math.mjs']:[],
      receiptIds:x.axis==='tests'?[final.receipts.find(r=>r.gateId==='unit').id]:[], findingIds:x.axis==='simplicity'?['CLEANUP']:[] })) };
  await f.life.importQa(d.id, q);
  q.findings[0].path = 'src/missing.mjs';
  await assert.rejects(f.life.importQa(d.id, q), /real repository path/);
  q.findings[0].path = finding.path;
  q.findings[0].resolution = 'advisory';
  assert.throws(() => validateQualityChecks(q, context, new Set([finding.path])), /blocking finding/);
});

test('onboarding proposes one existing dead-code check across all lanes without inventing tools', () => {
  const inventory = { stack:'node-typescript', packageManager:'npm', scripts:{test:'node --test'}, warnings:[], projectType:'backend', securityScripts:[] };
  const missing = proposeConfiguration(inventory);
  assert.ok(!missing.config.gates.some(g => g.id === 'dead-code'));
  assert.ok(missing.notes.some(n => /No non-interactive dead-code/.test(n)));
  const found = proposeConfiguration({ ...inventory, scripts:{ ...inventory.scripts, 'check:dead-code':'knip', knip:'knip' } });
  const gate = found.config.gates.find(g => g.id === 'dead-code');
  assert.deepEqual(gate.command, ['npm','run','check:dead-code']);
  assert.equal(gate.mandatory, true);
  for(const lane of ['fast','standard','high']) assert.ok(planGates(found.config, {files:['src/math.ts'],added:[],lines:1,binary:false}, lane).some(g=>g.id==='dead-code'));
  assert.equal(found.config.gates.filter(g=>g.id==='dead-code').length, 1);
  const projectScript = proposeConfiguration({ ...inventory, scripts: { ...inventory.scripts, deadcode: 'svelte-kit sync && knip' } });
  assert.deepEqual(projectScript.config.gates.find(g => g.id === 'dead-code').command, ['npm', 'run', 'deadcode']);
  for(const command of ['knip --watch','knip --fix','knip --write']) {
    assert.ok(!proposeConfiguration({...inventory,scripts:{...inventory.scripts,knip:command}}).config.gates.some(g=>g.id==='dead-code'));
  }
});
