import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fixture, approved, demoSpec, git } from './lifecycle-helpers.mjs';
import { worker } from './helpers.mjs';
import { Lifecycle } from '../dist/index.js';

// Real ESM linking failure: the task replaces add, but its existing caller still imports it.
// The first repair writes exactly the same bytes. A fresh attempt only fixes the export if
// the controller actually supplies the missing-export diagnostic (not just a generic error).
async function brokenExport(t) {
  const f = fixture(t);
  const calls = join(f.root, 'calls.json');
  f.config.maxRepairAttempts = 1;
  f.config.agent = { type: 'command', command: worker(`
const callsFile = ${JSON.stringify(calls)};
const calls = existsSync(callsFile) ? JSON.parse(readFileSync(callsFile, 'utf8')) : [];
calls.push(request.task.id); writeFileSync(callsFile, JSON.stringify(calls));
if (request.task.id === 'DOC') {
  writeFileSync('docs/math.md', '# Math\\n\\nmultiply(2, 3) returns 6.\\n');
} else {
  const informed = request.task.description.includes("does not provide an export named 'add'");
  writeFileSync('src/math.mjs', (informed ? 'export const add = (a,b) => a+b;\\n' : '') + 'export const multiply = (a,b) => a*b;\\n');
  if (informed) writeFileSync('test/math.test.mjs', "import {test} from 'node:test';import assert from 'node:assert/strict';import {add,multiply} from '../src/math.mjs';test('addition',()=>assert.equal(add(2,3),5));test('positive multiplication',()=>assert.equal(multiply(2,3),6));test('negative multiplication',()=>assert.equal(multiply(-2,3),-6));\\n");
}
`) };
  f.config.gates.unshift({ id: 'build', command: [process.execPath, '--input-type=module', '-e', "import {add} from './src/math.mjs'; if(add(2,3)!==5) process.exit(1);"] });
  const spec = demoSpec();
  spec.tasks[1].dependsOn = [];
  spec.tasks[0].dependsOn = ['DOC'];
  let doc = await approved(f, spec);
  doc = await f.life.run(doc.id);
  assert.equal(doc.data.error?.code, 'REPAIR_NO_CHANGE', JSON.stringify(doc.data.error));
  assert.deepEqual(doc.data.completedTaskIds, ['DOC']);
  const failed = f.life.store.get(doc.data.activeRunId);
  assert.equal(failed.metrics.repairAttempts, 1);
  assert.match(failed.receipts.find(r => r.gateId === 'build').diagnostic, /does not provide an export named 'add'/);
  return { ...f, doc, failed, calls };
}

for (const legacy of [false, true]) test(`missing export -> no-change repair -> informed successful retry${legacy ? ' (legacy empty receipts)' : ''}`, async t => {
  const f = await brokenExport(t);
  const original = structuredClone(f.failed.receipts);
  if (legacy) {
    f.failed.receipts = [];
    f.life.store.save(f.failed, 'fixture.legacy_no_change');
  }
  const diagnostics = f.life.summary(f.doc).failedChecks;
  assert.match(diagnostics.find(r => r.gateId === 'build').diagnostic, /does not provide an export named 'add'/);
  assert.ok(diagnostics.every(r => r.authoritative === false));
  assert.deepEqual(f.life.store.get(f.failed.id).receipts, legacy ? [] : original, 'recovery does not fabricate current validation proofs');
  if (legacy) assert.deepEqual(f.life.store.failureDiagnostics({ ...f.failed, candidateSha: f.doc.data.baseSha }), [], 'do not recover a different candidate');
  let doc = await f.life.retry(f.doc.id, true);
  const replacement = f.life.store.get(doc.data.activeRunId);
  assert.match(replacement.task.description, /does not provide an export named 'add'/);
  assert.equal(replacement.baseSha, f.doc.data.currentSha);
  doc = await f.life.run(doc.id);
  assert.equal(doc.data.error, null, JSON.stringify(doc.data.error));
  assert.deepEqual(doc.data.completedTaskIds, ['DOC', 'MATH']);
  assert.equal(doc.data.qa.report.verdict, 'pass');
  assert.equal(JSON.parse(readFileSync(f.calls, 'utf8')).filter(id => id === 'DOC').length, 1);
  if (legacy) {
    f.life.store.event(f.failed.id, 'validation.started', { gateIds: f.failed.gateIds });
    assert.deepEqual(f.life.store.failureDiagnostics(f.failed), [], 'never recover failures from an older validation cycle');
  }
});

test('reviewed remaining-plan revision keeps the proven frontier, history and obligations', async t => {
  const f = await brokenExport(t);
  f.life.store.event(f.failed.id, 'invocation.finished', { invocationId: 'fixture-reported-cost', usage: { costUsd: 2.27 } });
  const costBefore = f.life.costSummary(f.doc.id);
  assert.equal(costBefore.knownUsd, 2.27);
  const before = structuredClone(f.doc.data);
  const input = { reason: 'Keep the existing export until its callers have migrated.', tasks: before.content.tasks.filter(t => t.id === 'MATH').map(t => ({ ...t,
    description: t.description + ' Keep add compatible with existing callers until migration is validated.',
    allowedPaths: [...t.allowedPaths, 'README.md'],
  })) };
  const changed = structuredClone(input);
  changed.tasks.push(before.content.tasks.find(t => t.id === 'DOC'));
  assert.throws(() => f.life.planRemainingTasks(f.doc.id, changed), /remaining task IDs/);
  assert.throws(() => f.life.planRemainingTasks(f.doc.id, { ...input, config: { gates: [] } }), /unknown property/);
  assert.throws(() => f.life.planRemainingTasks(f.doc.id, { ...input, tasks: input.tasks.map(t => ({ ...t, minimumLane: 'fast' })) }), /Cannot lower/);
  assert.throws(() => f.life.planRemainingTasks(f.doc.id, { ...input, tasks: input.tasks.map(t => ({ ...t, acceptanceIds: ['AC-DOC'] })) }), /acceptance obligations/);
  assert.throws(() => f.life.planRemainingTasks(f.doc.id, { ...input, tasks: input.tasks.map(t => ({ ...t, dependsOn: ['MATH'] })) }), /cycle/);
  const file = join(f.root, 'remaining-tasks.json');
  writeFileSync(file, JSON.stringify(input));
  const output = execFileSync(process.execPath, ['dist/cli.js', 'spec', 'replan', f.doc.id, '--file', file, '--state-dir', f.state, '--quiet'], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).planRevision.status, 'pending');
  let doc = f.life.get(f.doc.id);
  const plan = doc.data.planRevisions.at(-1);
  assert.deepEqual(doc.data.content, before.content, 'proposal does not change approved work');
  await assert.rejects(() => f.life.approveRemainingTasks(doc.id, plan.id, 'wrong', 'Test Owner', 'Reviewed remaining tasks and kept all obligations.'), /exact pending plan hash/);
  const token = f.life.store.acquireDocument(doc.id);
  try { await assert.rejects(() => f.life.approveRemainingTasks(doc.id, plan.id, plan.hash, 'Test Owner', 'Reviewed remaining tasks and kept all obligations.'), /locked/i); }
  finally { f.life.store.releaseDocument(doc.id, token); }
  doc = await f.life.approveRemainingTasks(doc.id, plan.id, plan.hash, 'Test Owner', 'Reviewed remaining tasks and kept all obligations.');
  assert.equal(doc.data.currentSha, before.currentSha);
  assert.deepEqual(doc.data.completedTaskIds, before.completedTaskIds);
  assert.deepEqual(doc.data.attempts, before.attempts);
  assert.deepEqual(doc.data.config, before.config);
  assert.deepEqual(doc.data.content.acceptance, before.content.acceptance);
  assert.deepEqual(doc.data.content.security, before.content.security);
  assert.equal(doc.data.activeMs, before.activeMs);
  assert.deepEqual(f.life.costSummary(doc.id), costBefore, 'declared spending and unknown calls are preserved');
  assert.equal(doc.data.activeRunId, null);
  assert.equal(doc.data.finalRunId, null);
  assert.equal(doc.data.qa, null);
  assert.equal(doc.data.review, null);
  assert.deepEqual(doc.data.planRevisions[0].previousContent, before.content);
  assert.deepEqual(doc.data.planRevisions[0].previousApproval, before.approval);
  assert.notEqual(doc.data.contentHash, before.contentHash);
  // Approval and resume survive a fresh controller, without replacing the spec document.
  const resumed = new Lifecycle(f.state); t.after(() => resumed.close());
  doc = await resumed.run(doc.id);
  assert.equal(doc.data.error, null, JSON.stringify(doc.data.error));
  assert.equal(doc.data.qa.report.verdict, 'pass');
  assert.equal(doc.id, f.doc.id);
  assert.equal(doc.data.attempts.length, before.attempts.length + 1);
  const latest = resumed.store.get(doc.data.attempts.at(-1).runId);
  assert.equal(latest.baseSha, before.currentSha);
  assert.match(latest.task.description, /does not provide an export named 'add'/);
  assert.equal(JSON.parse(readFileSync(f.calls, 'utf8')).filter(id => id === 'DOC').length, 1);
  const final = resumed.store.get(doc.data.finalRunId);
  assert.ok(final.receipts.every(r => ['passed', 'cached'].includes(r.status)));
  assert.equal(final.candidateSha, doc.data.currentSha);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before.baseSha, 'source branch remains unchanged');
});

test('remaining-plan approval refuses a stale frontier', async t => {
  const f = await brokenExport(t);
  const doc = f.life.planRemainingTasks(f.doc.id, { reason: 'Preserve compatibility until the caller migration is complete.',
    tasks: f.doc.data.content.tasks.filter(t => t.id === 'MATH').map(t => ({ ...t, description: t.description + ' Preserve add.' })) });
  const plan = doc.data.planRevisions.at(-1);
  doc.data.operational = { maxSpecCostUsd: 30, maxActiveMs: 300000, agent: null, at: Date.now(), reviewer: 'Test Owner', note: 'New operational ceiling after planning.' };
  f.life.store.saveDocument(doc, 'fixture.operational_changed');
  await assert.rejects(() => f.life.approveRemainingTasks(doc.id, plan.id, plan.hash, 'Test Owner', 'Reviewed plan against an outdated execution frontier.'), /frontier or its approval changed/);
});
