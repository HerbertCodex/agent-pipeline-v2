import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, approved, oneTask } from './lifecycle-helpers.mjs';

const actor = 'Test Owner', note = 'Reviewed the additional validation obligation and execution settings.';
const gate = (id, exit = 0) => ({ id, command: [process.execPath, '-e', `process.exit(${exit})`] });

test('invalid gate amendments are rejected atomically before they enter approved history', async t => {
  const f = fixture(t);
  const d = await approved(f, oneTask());
  const before = structuredClone(f.life.get(d.id).data);
  for (const gates of [
    { add: {} }, { resources: [] }, { timeoutMs: null },
    { add: [{ ...gate('extra'), dependsOn: ['absent'] }] },
    { add: [{ ...gate('extra'), dependsOn: ['extra'] }] },
    { add: [{ ...gate('extra'), dependsOn: ['unit'] }], timeoutMs: { unit: 1 } },
  ]) {
    assert.throws(() => f.life.amendBudget(d.id, { gates }, actor, note));
    assert.deepEqual(f.life.get(d.id).data, before);
  }
});

test('an added filtered check still runs at final integration and its failure prevents publication', async t => {
  const f = fixture(t);
  let d = await approved(f);
  d = f.life.amendBudget(d.id, { gates: { add: [{ ...gate('integration-extra', 1), lanes: ['high'], paths: ['unused/**'] }] } }, actor, note);
  d = await f.life.run(d.id);
  assert.deepEqual(d.data.completedTaskIds, ['MATH', 'DOC']);
  assert.equal(d.data.error?.code, 'GATES_FAILED');
  const final = f.life.store.get(d.data.finalRunId);
  assert.equal(final.receipts.find(r => r.gateId === 'integration-extra')?.status, 'failed');
  await assert.rejects(() => f.life.publicationCandidate(d.id, 'review'));
});

test('amending completed validation invalidates proof and reruns checks without repeating implementation', async t => {
  const f = fixture(t);
  let d = await approved(f);
  d = await f.life.run(d.id);
  assert.equal(d.data.error, null);
  const oldFinal = d.data.finalRunId, oldSha = d.data.currentSha;
  const approval = structuredClone(d.data.approval), attempts = structuredClone(d.data.attempts);
  d = f.life.amendBudget(d.id, { maxActiveMs: 600000 }, actor, note);
  assert.equal(d.data.finalRunId, oldFinal, 'a budget-only amendment preserves proof');
  d = f.life.amendBudget(d.id, { gates: { timeoutMs: { unit: 240000 }, resources: { unit: ['build'] }, add: [gate('extra')] } }, actor, note);
  assert.equal(d.data.finalRunId, null);
  assert.equal(d.data.qa, null);
  assert.equal(d.data.review, null);
  assert.deepEqual(d.data.approval, approval);
  await assert.rejects(() => f.life.publicationCandidate(d.id, 'review'), /No integrated candidate/);
  d = await f.life.run(d.id);
  assert.equal(d.data.error, null, JSON.stringify(d.data.error));
  assert.notEqual(d.data.finalRunId, oldFinal);
  assert.equal(d.data.currentSha, oldSha);
  assert.deepEqual(d.data.attempts, attempts, 'completed implementation is preserved');
  const final = f.life.store.get(d.data.finalRunId);
  assert.equal(final.receipts.find(r => r.gateId === 'extra')?.status, 'passed');
  assert.equal(final.config.gates.find(g => g.id === 'unit').timeoutMs, 240000);
  assert.deepEqual(final.config.gates.find(g => g.id === 'unit').resources, ['build']);
  assert.ok(d.data.qa, 'QA is regenerated for the new evidence');
  await f.life.publicationCandidate(d.id, 'review');
});


test('a single proven task is not reused after an execution-only gate amendment', async t => {
  const f = fixture(t);
  f.config.workflow.qaLanes = [];
  f.config.workflow.reviewMode = 'solo';
  let d = await approved(f, oneTask());
  d = await f.life.run(d.id);
  assert.equal(d.data.error, null);
  const oldFinal = d.data.finalRunId;
  d = f.life.amendBudget(d.id, { gates: { timeoutMs: { unit: 240000 } } }, actor, note);
  d = await f.life.run(d.id);
  assert.equal(d.data.error, null, JSON.stringify(d.data.error));
  assert.notEqual(d.data.finalRunId, oldFinal);
  assert.equal(d.data.attempts.length, 1);
  assert.equal(f.life.store.get(d.data.finalRunId).config.gates.find(g => g.id === 'unit').timeoutMs, 240000);
});
