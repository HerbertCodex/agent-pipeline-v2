import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, approved, oneTask } from './lifecycle-helpers.mjs';
import { worker } from './helpers.mjs';

for (const maxRepairAttempts of [0, 3]) test(`retry after scope revalidation restores the spec repair policy (${maxRepairAttempts})`, async t => {
  const f = fixture(t);
  const counter = join(f.root, 'agent-calls.txt');
  f.config.maxRepairAttempts = maxRepairAttempts;
  f.config.workflow = { ...f.config.workflow, qaLanes: [] };
  f.config.agent = { type: 'command', command: worker(`
const counter = ${JSON.stringify(counter)};
writeFileSync(counter, String((existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1));
const repairing = request.previousFailures.some(f => f.gateId === 'unit');
writeFileSync('src/math.mjs', 'export const add = (a,b) => a+b;\\nexport const multiply = (a,b) => ' + (repairing ? 'a*b' : 'a+b') + ';\\n');
writeFileSync('test/math.test.mjs', "import {test} from 'node:test';import assert from 'node:assert/strict';import {multiply} from '../src/math.mjs';test('positive multiplication',()=>assert.equal(multiply(2,3),6));test('negative multiplication',()=>assert.equal(multiply(-2,3),-6));\\n");
// Existing, but outside the approved task: the controller must request an amendment first.
writeFileSync('docs/math.md', '# Math\\n\\nmultiply(2, 3) returns 6.\\n');
`) };
  let doc = await approved(f, oneTask());
  doc = await f.life.run(doc.id);
  assert.equal(doc.data.error?.code, 'SCOPE_AMENDMENT_REQUIRED');
  assert.equal(readFileSync(counter, 'utf8'), '1');
  const amendment = doc.data.scopeAmendments.find(a => a.status === 'pending');
  assert.deepEqual(amendment.paths, ['docs/math.md']);
  doc = await f.life.approveScopeAmendment(doc.id, amendment.id, 'Test Owner', 'Reviewed the documentation addition for this candidate.');
  const validationId = doc.data.activeRunId;
  assert.equal(f.life.store.get(validationId).config.maxRepairAttempts, 0);
  doc = await f.life.run(doc.id);
  assert.equal(doc.data.error?.code, 'GATES_FAILED');
  assert.equal(readFileSync(counter, 'utf8'), '1', 'scope approval validates retained code without invoking the agent');
  assert.equal(f.life.store.get(validationId).metrics.repairAttempts, 0);
  const configBefore = structuredClone(doc.data.config);
  const baseBefore = doc.data.currentSha;
  const historyBefore = structuredClone(doc.data.attempts);
  doc = await f.life.retry(doc.id, true);
  const replacementId = doc.data.activeRunId;
  const replacement = f.life.store.get(replacementId);
  assert.equal(replacement.config.maxRepairAttempts, maxRepairAttempts, 'temporary validation-only limits must not leak into a new implementation');
  assert.deepEqual(replacement.config, configBefore, 'all gates, roles and budgets still come from the approved spec');
  assert.equal(replacement.baseSha, baseBefore);
  assert.ok(replacement.task.allowedPaths.includes('docs/math.md'));
  assert.match(replacement.task.description, /positive multiplication/);
  assert.deepEqual(doc.data.attempts.slice(0, -1), historyBefore);
  doc = await f.life.run(doc.id);
  const retried = f.life.store.get(replacementId);
  if (maxRepairAttempts === 0) {
    assert.equal(doc.data.error?.code, 'GATES_FAILED');
    assert.equal(retried.metrics.repairAttempts, 0, 'an intentional zero repair limit remains respected');
    assert.equal(readFileSync(counter, 'utf8'), '2');
  } else {
    assert.equal(doc.data.error, null, JSON.stringify(doc.data.error));
    assert.deepEqual(doc.data.completedTaskIds, ['MATH']);
    assert.equal(retried.metrics.repairAttempts, 1, 'the replacement can actually observe and repair a failing test');
    assert.equal(readFileSync(counter, 'utf8'), '3');
    assert.ok(retried.receipts.every(r => ['passed', 'cached'].includes(r.status)));
  }
});
