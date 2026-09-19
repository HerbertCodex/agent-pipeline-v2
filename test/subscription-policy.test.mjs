import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { fixture, approved, oneTask } from './lifecycle-helpers.mjs';
import { agentSchema, validateConfig } from '../dist/domain/contracts.js';
import { budgetedAgent, invocationTotals } from '../dist/adapters/invocations.js';
import { executionAgent, specCostCeiling } from '../dist/adapters/billing.js';
import { modelPlan, resolveModelDecision, roleAgent } from '../dist/adapters/routing.js';
import { pathDecision, resolvePathDecision } from '../dist/lifecycle/pathways.js';
import { providerStop, stopAdvice } from '../dist/adapters/stops.js';
import { phaseTimings } from '../dist/lifecycle/timings.js';
import { claudeCommand } from '../dist/adapters/claude.js';
import { planGates } from '../dist/policy/policy.js';
import { hash } from '../dist/domain/hash.js';
import { executionCapabilities } from '../dist/lifecycle/capabilities.js';

test('subscription removes monetary flags but keeps time, turns and explicit model policy', () => {
  const agent = agentSchema.parse({ type: 'claude', model: 'pinned', usageMode: 'subscription', maxBudgetUsd: 0.01, maxTurns: 40, timeoutMs: 50000 });
  const effective = executionAgent(agent);
  assert.equal(effective.maxBudgetUsd, null);
  assert.equal(effective.timeoutMs, 50000);
  assert.equal(effective.maxTurns, 40);
  assert.ok(!claudeCommand(agent, {}, true).includes('--max-budget-usd'));
  assert.throws(() => executionAgent({ ...agent, model: '' }), e => e.code === 'MODEL_SELECTION');
  assert.throws(() => executionAgent({ ...agent, model: 'YOUR_MODEL_ID' }), e => e.code === 'MODEL_SELECTION');
  assert.doesNotThrow(() => executionAgent({ ...agent, usageMode: 'legacy', model: '' }));
  const config = validateConfig({ schemaVersion: 1, executionMode: 'local-trusted', environment: { id: 'subscription-policy-test' }, agent, gates: [{ id: 'test', command: ['node', '--test'] }] });
  assert.equal(executionCapabilities(config).attempt.providerBudgetUsd, null);
});

test('subscription migration preserves approval, receipts and historical costs and can resume', async t => {
  const f = fixture(t, { workflow: { maxSpecCostUsd: 0.01, qaLanes: [] } });
  let doc = await approved(f, oneTask());
  const original = structuredClone(doc.data);
  f.life.store.documentEvent(doc.id, 'invocation.finished', { invocationId: 'old', usage: { costUsd: 25 } });
  doc = f.life.amendBudget(doc.id, { maxSpecCostUsd: null, agent: { usageMode: 'subscription' } }, 'Test Owner', 'Use included account usage without imposing a dollar ceiling.');
  assert.equal(specCostCeiling(doc.data), null);
  assert.deepEqual(doc.data.approval, original.approval);
  assert.equal(doc.data.contentHash, original.contentHash);
  assert.deepEqual(doc.data.attempts, original.attempts);
  assert.equal(f.life.costSummary(doc.id).knownUsd, 25);
  // A later unrelated amendment must not reinstate 25 USD through null-coalescing.
  doc = f.life.amendBudget(doc.id, { maxActiveMs: 500000 }, 'Test Owner', 'Adjust the time without changing the monetary policy.');
  assert.equal(specCostCeiling(doc.data), null);
  doc = await f.life.run(doc.id);
  assert.equal(doc.data.error, null);
  assert.ok(doc.data.currentSha);
  const summary = f.life.summary(doc);
  assert.equal(summary.cost.ceilingUsd, null);
  assert.ok(summary.timing.phases.find(p => p.phase === 'implementer').durationMs > 0);
});

test('mixed billing excludes subscription estimates from QA budget without hiding them', async t => {
  const f = fixture(t, { agent: { type: 'claude', model: 'implementation', usageMode: 'subscription' },
    roles: { qa: { type: 'claude', model: 'review', usageMode: 'metered' } }, workflow: { maxSpecCostUsd: 3 } });
  const doc = await approved(f, oneTask());
  for (const [invocationId, usageMode, costUsd] of [['included', 'subscription', 100], ['paid', 'metered', 2]])
    f.life.store.documentEvent(doc.id, 'invocation.finished', { invocationId, usageMode, usage: { costUsd } });
  const qa = roleAgent(doc.data.config, 'qa', 'high');
  assert.equal(budgetedAgent(f.life.store, doc.id, qa, false, 'qa').maxBudgetUsd, 1);
  assert.equal(budgetedAgent(f.life.store, doc.id, doc.data.config.agent).maxBudgetUsd, null);
  assert.equal(f.life.costSummary(doc.id).knownUsd, 102);
  assert.equal(f.life.costSummary(doc.id).budget.knownUsd, 2);
  const unknown = [{ type: 'invocation.finished', data: { invocationId: 'unknown', usageMode: 'subscription', usage: null } }];
  assert.equal(invocationTotals(unknown).unknownInvocations, 1);
  assert.equal(invocationTotals(unknown, true).unknownInvocations, 0);
});

test('null ceiling does not silently remove an explicit metered per-call cap', async t => {
  const f = fixture(t); const doc = await approved(f, oneTask());
  f.life.amendBudget(doc.id, { maxSpecCostUsd: null }, 'Test Owner', 'Disable only the global monetary ceiling.');
  const agent = agentSchema.parse({ type: 'claude', model: 'fixed', usageMode: 'metered', maxBudgetUsd: 2 });
  assert.equal(budgetedAgent(f.life.store, doc.id, agent).maxBudgetUsd, 2);
});

test('a provider quota stop retains the implementation without accepting or retrying it', async t => {
  const f = fixture(t);
  const worker = resolve(f.root, 'quota-cli.mjs');
  writeFileSync(worker, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
writeFileSync('src/math.mjs','export const add = (a,b) => a+b;\\nexport const multiply = (a,b) => a*b;\\n');
console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,result:'You have hit your weekly limit',total_cost_usd:2}));`, { mode: 0o700 });
  f.config.agent = { type: 'claude', command: [worker], model: 'pinned', usageMode: 'subscription' };
  const doc = await approved(f, oneTask());
  const stopped = await f.life.run(doc.id);
  assert.equal(stopped.data.error.code, 'PROVIDER_QUOTA');
  assert.equal(f.life.summary(stopped).stop.category, 'quota');
  const run = f.life.pipeline.store.get(stopped.data.activeRunId);
  assert.equal(run.state, 'interrupted');
  assert.match(readFileSync(resolve(run.workspace, 'src/math.mjs'), 'utf8'), /multiply/);
  assert.deepEqual(stopped.data.completedTaskIds, []);
  assert.equal(f.life.pipeline.store.events(run.id, ['invocation.started']).length, 1);
});

test('amending a completed QA model invalidates review but preserves approval, candidate and checks', async t => {
  const f = fixture(t);
  const initial = await approved(f, oneTask());
  const done = await f.life.run(initial.id);
  assert.ok(done.data.qa, JSON.stringify(done.data.error));
  const before = structuredClone(done.data);
  const run = f.life.pipeline.store.get(before.finalRunId);
  const recorded = f.life.pipeline.store.events(run.id, ['validation.started']).at(-1).data.decision;
  assert.equal(recorded.inputs.configHash, hash(run.config));
  assert.deepEqual(planGates(JSON.parse(JSON.stringify(run.config)), recorded.inputs.changeSet, recorded.inputs.lane).map(g => g.id), recorded.result.gateIds);
  const amended = f.life.amendBudget(done.id, { roles: { qa: { model: 'new-review-policy' } } }, 'Test Owner', 'Request a new independent review with the selected model.');
  assert.equal(amended.data.qa, null);
  assert.equal(amended.data.review, null);
  assert.equal(amended.data.status, 'approved');
  assert.equal(amended.data.currentSha, before.currentSha);
  assert.equal(amended.data.finalRunId, before.finalRunId);
  assert.deepEqual(amended.data.approval, before.approval);
  assert.deepEqual(amended.data.completedTaskIds, before.completedTaskIds);
  const rerun = await f.life.run(done.id);
  assert.ok(rerun.data.qa, JSON.stringify(rerun.data.error));
  assert.equal(rerun.data.currentSha, before.currentSha);
  assert.equal(rerun.data.attempts.length, before.attempts.length);
});

test('path and model decisions replay after serialization with stable identities and QA precedence', t => {
  const f = fixture(t); const config = validateConfig({ ...f.config, roles: { qa: { type: 'claude', model: 'base-review' } },
    workflow: { qaProfile: 'deep' }, roleProfiles: [{ provider: 'claude', role: 'qa', quick: { model: 'small', effort: 'low' }, deep: { model: 'review', effort: 'high' } }],
    modelRouting: [{ provider: 'claude', role: 'qa', lane: 'high', model: 'explicit-review', effort: 'high' }] });
  const plan = modelPlan(config, { agent: { model: 'cheap' } });
  const qa = plan.find(m => m.role === 'qa' && m.lane === 'standard');
  assert.equal(qa.model, 'explicit-review');
  assert.deepEqual(resolveModelDecision(JSON.parse(JSON.stringify(qa.decision.inputs))), qa.decision);
  const changed = modelPlan(config, { roles: { qa: { model: 'replacement' } } }).find(m => m.role === 'qa' && m.lane === 'standard');
  assert.equal(changed.model, 'replacement');
  assert.notEqual(changed.decision.decisionHash, qa.decision.decisionHash);
  const path = pathDecision('Fix the sum.', { minimumLane: 'fast', requiresThreatModel: false }, 'standard', 31);
  assert.equal(path.result.path, 'structural');
  assert.deepEqual(resolvePathDecision(JSON.parse(JSON.stringify(path.inputs))), path);
});

test('quota, money, time and provider outages have distinct diagnoses; successful prose is ignored', () => {
  const agent = agentSchema.parse({ type: 'claude' });
  const failed = message => ({ status: 'failed', stdout: JSON.stringify({ type: 'result', is_error: true, subtype: 'error', result: message }), stderr: '' });
  for (const [message, code] of [['You have hit your weekly limit', 'PROVIDER_QUOTA'], ['rate limit exceeded', 'PROVIDER_RATE_LIMIT'], ['overloaded_error', 'PROVIDER_UNAVAILABLE'], ['error_max_budget_usd', 'PROVIDER_BUDGET'], ['error_max_turns', 'PROVIDER_TURNS']]) {
    const result = providerStop(agent, failed(message));
    assert.equal(result.code, code);
    assert.equal(stopAdvice(result).automaticRetry, false);
  }
  assert.equal(providerStop(agent, { status: 'timed_out', stdout: '', stderr: '' }).code, 'AGENT_TIMEOUT');
  assert.equal(providerStop(agent, { status: 'passed', stdout: JSON.stringify({ type: 'result', subtype: 'success', result: 'Example: rate limit exceeded' }), stderr: '' }), null);
  assert.equal(providerStop({ ...agent, type: 'codex' }, { status: 'passed', stdout: JSON.stringify({ type: 'turn.failed', error: { code: 'usage_limit_reached', message: 'Limit hit' } }), stderr: '' }).code, 'PROVIDER_QUOTA');
});

test('phase timing counts repairs and each run once, separates preflight and open invocations', () => {
  const events = [
    { at: 10, type: 'invocation.finished', data: { invocationId: 'old', role: 'product', durationMs: 20 } },
    { at: 40, type: 'invocation.finished', data: { invocationId: 'probe', role: 'model-check', durationMs: 5 } },
    { at: 80, type: 'role.phase_finished', data: { role: 'qa', startedAt: 30, durationMs: 50, preflightMs: 5 } },
    { at: 90, type: 'invocation.started', data: { invocationId: 'open', role: 'qa' } },
  ];
  const run = { id: 'same', metrics: { preparationMs: 5, agentMs: 20, validationMs: 30 } };
  const a = phaseTimings(events, [{ run, events: [] }, { run, events: [] }], 100);
  assert.equal(a.phases.find(p => p.phase === 'product').durationMs, 20);
  assert.equal(a.phases.find(p => p.phase === 'qa').durationMs, 45);
  assert.equal(a.phases.find(p => p.phase === 'validation').durationMs, 30);
  assert.equal(a.preflightMs, 5);
  assert.equal(a.active[0].elapsedMs, 10);
  assert.equal(a.historicalPartial, true);
  assert.equal(phaseTimings([], [{run, events:[]}], 100).historicalPartial, false, 'a compact task with no planning calls does not imply missing historical timings');
});

test('subscription evaluation preview never adds USD ceilings or starts providers', () => {
  const result = spawnSync(process.execPath, [resolve('scripts/evaluate.mjs'), '--usage-mode', 'subscription'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.executed, false);
  assert.equal(preview.totalBudgetUsd, null);
  assert.equal(preview.perSpecBudgetUsd, null);
});
