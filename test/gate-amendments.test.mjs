import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, approved, oneTask } from './lifecycle-helpers.mjs';
import { hash } from '../dist/domain/hash.js';
import { specHash } from '../dist/lifecycle/contracts.js';

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

test('a spec approved before a gate field existed still publishes when the run enforced the same gates', async t => {
  const f = fixture(t);
  f.config.workflow.qaLanes = [];
  f.config.workflow.reviewMode = 'solo';
  let d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.', proposal: oneTask() });
  // A spec drafted before a gate field existed froze its gates without it, with a hash chain that
  // is consistent for that shape; the runs it starts parse the config as the contract stands today.
  const stored = f.life.get(d.id);
  for (const gate of stored.data.config.gates) delete gate.readOnly;
  stored.data.configHash = hash(stored.data.config);
  stored.data.contentHash = specHash(stored.data);
  f.life.store.saveDocument(stored, 'test.gate_field_absent');
  d = await f.life.approveSpec(d.id, stored.data.contentHash, 'Test Product Owner', 'Fixture approval after inspecting scope and criteria.');
  d = await f.life.run(d.id);
  assert.equal(d.data.error, null, JSON.stringify(d.data.error));
  assert.ok(d.data.config.gates.every(g => g.readOnly === undefined));
  assert.ok(f.life.store.get(d.data.finalRunId).config.gates.every(g => g.readOnly === false));
  await f.life.publicationCandidate(d.id, 'review');
});

test('the allowance for a malformed role output is amendable and never weakens what it must prove', async t => {
  const f = fixture(t);
  // The whole demonstration spec: the scripted reviewer only passes once both of its tasks are done.
  let d = await approved(f);
  assert.equal(d.data.config.workflow.maxOutputRepairs, 1);
  const before = structuredClone(d.data.approval);

  for (const bad of [3, -1, 1.5, '2']) assert.throws(() => f.life.amendBudget(d.id, { maxOutputRepairs: bad }, actor, note));
  assert.equal(f.life.get(d.id).data.operational?.maxOutputRepairs ?? null, null);

  d = f.life.amendBudget(d.id, { maxOutputRepairs: 2 }, actor, note);
  assert.equal(d.data.operational.maxOutputRepairs, 2);
  // Retrying the shape of an answer is execution-only: the approval, the proof and the gates stand.
  assert.deepEqual(d.data.approval, before);
  assert.equal(d.data.config.workflow.maxOutputRepairs, 1, 'the approved configuration is never rewritten');
  d = await f.life.run(d.id);
  assert.equal(d.data.error, null, JSON.stringify(d.data.error));
  assert.equal(d.data.operational.maxOutputRepairs, 2, 'the amendment survives a run');
});
