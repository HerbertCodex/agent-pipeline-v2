import test from 'node:test';
import assert from 'node:assert/strict';
import { oneTask } from './lifecycle-helpers.mjs';
import { specSchema, specHash } from '../dist/lifecycle/contracts.js';
import { briefSpecSchema, expandBrief, requiresQa, selectPath, targetedQaContext } from '../dist/lifecycle/pathways.js';
import { validateConfig } from '../dist/domain/contracts.js';
import { assessSecurity } from '../dist/security/owasp.js';

test('brief transport bounds prose and restores controller lanes without losing obligations', () => {
  const brief = specSchema.parse(oneTask()); delete brief.minimumLane; brief.tasks.forEach(t => delete t.minimumLane);
  const result = expandBrief(briefSpecSchema.parse(brief));
  assert.equal(result.minimumLane, 'standard');
  assert.deepEqual(result.acceptance, brief.acceptance);
  assert.throws(() => briefSpecSchema.parse({ ...brief, problem: 'x'.repeat(1201) }), /invalid string/);
  assert.throws(() => briefSpecSchema.parse({ ...brief, tasks: Array(4).fill(brief.tasks[0]) }), /invalid array/);
});

test('observed risk escalates compact QA and structural routing cannot downgrade', () => {
  const config = validateConfig({ schemaVersion: 1, executionMode: 'local-trusted', environment: { id:'test' }, agent:{type:'codex'}, gates:[{id:'test',command:['true']}] });
  const spec = specSchema.parse(oneTask());
  const record = { config, executionPath:'compact' };
  const run = {risk:{lane:'standard'},changeSet:{files:['src/math.mjs']}};
  assert.equal(requiresQa(record,run,spec),false);
  assert.equal(requiresQa(record,{...run,risk:{lane:'high'}},spec),true);
  assert.equal(requiresQa(record,{...run,changeSet:{files:['src/auth/access.ts']}},spec),true);
  assert.equal(requiresQa(record,{...run,changeSet:{files:['src/unapproved.ts']}},spec),true);
  assert.equal(selectPath('Small edit',assessSecurity({text:''}),'structural'),'structural');
  assert.equal(selectPath('Add migration',assessSecurity({text:''}),'standard'),'structural');
  assert.equal(selectPath('Fix a label without architecture changes.',assessSecurity({text:''}),'standard'),'standard');
  assert.equal(assessSecurity({text:'Preserve the function and avoid adding dependencies.'}).profile.dependencyChange,false);
});

test('targeted QA retains every criterion, security obligation and byte of diff', () => {
  const spec = specSchema.parse(oneTask()); spec.tasks[0].description = 'Planning detail '.repeat(500);
  const diff = 'diff --git a/code b/code\n+changed code';
  const context = { spec, diff, decisionLedger:{decisions:[{id:'D-1'}]}, receipts:[{status:'passed',diagnostic:'large successful log',gateId:'test'}] };
  const focused = targetedQaContext(context);
  assert.equal(focused.diff,diff); assert.deepEqual(focused.spec.acceptance,spec.acceptance);
  assert.deepEqual(focused.spec.security,spec.security); assert.deepEqual(focused.decisionLedger,context.decisionLedger);
  assert.ok(JSON.stringify(focused).length < JSON.stringify(context).length);
});
