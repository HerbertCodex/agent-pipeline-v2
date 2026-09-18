import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, oneTask, approved, withSecurity, git } from './lifecycle-helpers.mjs';
import { validateConfig, agentSchema } from '../dist/domain/contracts.js';
import { s } from '../dist/domain/schema.js';
import { runRole } from '../dist/lifecycle/roles.js';
import { compactProposal } from '../dist/lifecycle/compact.js';
import { assessSecurity } from '../dist/security/owasp.js';
import { pathsMentioned } from '../dist/security/change-signals.js';
import { applyRepairPatch } from '../dist/adapters/repair.js';
import { invocationTotals, budgetedAgent } from '../dist/adapters/invocations.js';
import { providerProfile } from '../dist/adapters/providers.js';
import { providerUsage } from '../dist/adapters/usage.js';
import { roleAgent } from '../dist/adapters/routing.js';

test('cost ledger distinguishes failures, unknowns, pending calls and duplicate events', () => {
  const events = [
    { type: 'invocation.started', data: { invocationId: 'failed' } },
    { type: 'invocation.finished', data: { invocationId: 'failed', status: 'failed', usage: { costUsd: 5.2 } } },
    { type: 'invocation.finished', data: { invocationId: 'failed', usage: { costUsd: 5.2 } } },
    { type: 'invocation.finished', data: { invocationId: 'unknown', usage: null } },
    { type: 'invocation.started', data: { invocationId: 'interrupted' } },
  ];
  assert.deepEqual(invocationTotals(events), { knownUsd: 5.2, unknownInvocations: 1, pendingInvocations: 1 });
  assert.equal(providerProfile('claude').maxTurns, agentSchema.parse({ type: 'claude' }).maxTurns);
  assert.equal(providerProfile('claude').maxBudgetUsd, null);
  const usage = providerUsage('codex', '{"type":"turn.completed","usage":{"input_tokens":200,"output_tokens":20,"cached_input_tokens":150}}\npartial');
  assert.equal(usage.costUsd, null); assert.equal(usage.tokens.cacheRead, 150);
  assert.equal(usage.providerMessage, null);
});

test('patch repairs preserve unaffected values and reject prototype traversal', () => {
  const original = { title: 'Unchanged', acceptance: [{ verification: 'bad' }] };
  const repaired = applyRepairPatch(original, { patches: [{ path: '/acceptance/0/verification', valueJson: '"A real check"' }] });
  assert.equal(repaired.title, 'Unchanged'); assert.equal(repaired.acceptance[0].verification, 'A real check');
  assert.equal(original.acceptance[0].verification, 'bad');
  for (const path of ['/__proto__/polluted', '/constructor/prototype', '/acceptance/99/verification', '/bad~escape'])
    assert.throws(() => applyRepairPatch(original, { patches: [{ path, valueJson: 'true' }] }));
  assert.equal({}.polluted, undefined);
  assert.deepEqual(applyRepairPatch({ wrong: 1 }, { patches: [{ path: '/wrong', op: 'remove' }, { path: '/required', op: 'set', valueJson: '"present"' }] }), { required: 'present' });
});

test('patch repair removes one invalid inspection item without replacing or mutating the retained array', () => {
  const previous = { inspection: [{ path: 'src/guard.mjs' }, { path: '(repository tree)' }, { path: 'package.json' }] };
  const repaired = applyRepairPatch(previous, { patches: [
    { path: '/inspection/1', op: 'remove' },
    { path: '/inspection/1/finding', valueJson: '"Existing ESM module"' },
  ] });
  assert.deepEqual(repaired.inspection, [{ path: 'src/guard.mjs' }, { path: 'package.json', finding: 'Existing ESM module' }]);
  assert.equal(previous.inspection.length, 3);
  assert.equal(previous.inspection[1].path, '(repository tree)');
  assert.deepEqual(applyRepairPatch({ requirements: [] }, { patches: [
    { path: '/requirements/0', valueJson: '{"id":"SEC-1"}' },
    { path: '/requirements/-', valueJson: '{"id":"SEC-2"}' },
    { path: '/requirements/0/id', valueJson: '"SEC-0"' },
  ] }), { requirements: [{ id: 'SEC-0' }, { id: 'SEC-2' }] });
  assert.throws(() => applyRepairPatch({ requirements: [] }, { patches: [{ path: '/requirements/1', valueJson: '{}' }] }), /Invalid repair/);
  for (const index of ['-1', '3', '01', '-', 'length', '__proto__'])
    assert.throws(() => applyRepairPatch(previous, { patches: [{ path: `/inspection/${index}`, op: 'remove' }] }));
});

test('dependency exclusions and architecture document paths do not invent scope', () => {
  const request = 'Améliorer le titre, sans ajouter de dépendances. Consulter .agent-pipeline/ARCHITECTURE.md.';
  const ctx = assessSecurity({ text: request, files: [] });
  assert.equal(ctx.profile.dependencyChange, false); assert.equal(ctx.profile.ciCd, false);
  assert.equal(assessSecurity({ text: 'Do not change dependencies; update the CI workflow.' }).profile.ciCd, true);
  assert.equal(assessSecurity({ text: 'Add a dependency and update the lockfile.' }).profile.dependencyChange, true);
  assert.equal(assessSecurity({ text: 'No dependency changes.', files: ['package.json'] }).profile.dependencyChange, true, 'explicit changed manifest remains a strong signal');
  assert.deepEqual(pathsMentioned('Do not modify package.json.', ['package.json']), []);
  assert.deepEqual(pathsMentioned('Update package.json.', ['package.json']), ['package.json']);
});

test('compact scope avoids Product calls while preserving approval and sensitive escalation', async t => {
  const f = fixture(t);
  const config = validateConfig(f.config);
  const task = { id: 'MATH', title: 'Add multiplication', description: 'Implement multiplication in the existing math module.', acceptance: ['multiply(2,3) returns 6'], allowedPaths: ['src/math.mjs', 'test/math.test.mjs'] };
  const proposal = compactProposal(task, task.description, config);
  const d = await f.life.draft({ repo: f.repo, config, request: task.description, proposal });
  assert.equal(d.data.approval, null); assert.equal(d.data.content.tasks.length, 1);
  assert.equal(d.data.content.minimumLane, 'standard');
  assert.equal(f.life.store.documentEvents(d.id).filter(e => e.type === 'invocation.started').length, 0);
  await assert.rejects(() => f.life.run(d.id), /approval/i);
  for (const path of ['package.json', 'src/auth/session.ts', 'src/**'])
    assert.throws(() => compactProposal({ ...task, allowedPaths: [path] }, task.description, config), /Compact|Structural/);
  assert.throws(() => compactProposal(task, 'Change the architecture and database migration.', config), /Structural/);
});

test('operational amendment preserves the approved hash and caps every remaining call', async t => {
  const f = fixture(t); const d = await approved(f, oneTask());
  const oldHash = d.data.contentHash; const oldConfig = d.data.configHash; const approval = d.data.approval;
  f.life.store.documentEvent(d.id, 'invocation.finished', { invocationId: 'failed-product', usage: { costUsd: 5.2 } });
  const amended = f.life.amendBudget(d.id, { maxSpecCostUsd: 7.5, maxActiveMs: 600000, agent: { effort: 'medium' } }, 'Test Operator', 'Retained scope; measured allowance for the remaining work.');
  assert.equal(amended.data.contentHash, oldHash); assert.equal(amended.data.configHash, oldConfig);
  assert.deepEqual(amended.data.approval, approval);
  const agent = budgetedAgent(f.life.store, d.id, providerProfile('claude'));
  assert.ok(agent.maxBudgetUsd > 2.28 && agent.maxBudgetUsd <= 2.3); assert.equal(agent.effort, 'medium');
  assert.throws(() => f.life.amendBudget(d.id, { agent: { command: ['evil'] } }, 'Test Operator', 'Never expand execution permissions.'), /cannot change/);
  f.life.amendBudget(d.id, { maxSpecCostUsd: 5 }, 'Test Operator', 'Stop further paid invocations at the current boundary.');
  assert.throws(() => budgetedAgent(f.life.store, d.id, providerProfile('claude')), /reached/);
  assert.equal(budgetedAgent(f.life.store, d.id, providerProfile('claude'), true).effort, 'medium');
});

function fakeClaude(f, code) {
  const executable = join(f.root, 'claude-double');
  writeFileSync(executable, `#!${process.execPath}\nimport { readFileSync, appendFileSync } from 'node:fs';\nconst input = readFileSync(0, 'utf8');\nconst request = JSON.parse(input.split('\\n').at(-1));\n${code}\n`, { mode: 0o700 });
  return agentSchema.parse({ type: 'claude', command: [executable], timeoutMs: 10000 });
}

test('rejected native output is retained, charged and patched on resume without re-exploration', async t => {
  const f = fixture(t); const d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement multiplication.', proposal: oneTask() });
  const agent = fakeClaude(f, `
const out = request.repair ? { patches: [{ path: '/answer', valueJson: '"fixed"' }] } : { answer: '' };
if (request.repair && request.repair.previousOutput.answer !== '') throw new Error('Checkpoint was lost');
if (request.repair && (request.repair.targetSchema.properties.answer.minLength !== 1 || !request.outputSchema.properties.patches)) throw new Error('Repair needs both the target document schema and patch transport schema');
if (request.repair && !request.repair.patchRules.includes('appends')) throw new Error('Repair needs explicit array semantics');
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0.75,num_turns:2,structured_output:out}));`);
  const options = { store: f.life.store, documentId: d.id, budgetDocumentId: d.id, repo: f.repo, sha: d.data.baseSha, role: 'product', agent, passEnv: [], schema: s.object({ answer: s.string(1, 30) }), context: { request: 'Exact retained context' }, maxRepairs: 0 };
  await assert.rejects(() => runRole(options), /invalid string/);
  assert.equal(f.life.costSummary(d.id).knownUsd, 0.75);
  const rejected = f.life.store.documentEvents(d.id, ['role.output_rejected']).at(-1).data;
  assert.equal(rejected.retrying, false);
  assert.equal(rejected.error.code, 'SCHEMA');
  assert.equal(rejected.error.path, '$.answer');
  assert.match(rejected.outputHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(await runRole(options), { answer: 'fixed' });
  assert.equal(f.life.costSummary(d.id).knownUsd, 1.5);
  const count = f.life.store.documentEvents(d.id).filter(e => e.type === 'invocation.started').length;
  assert.deepEqual(await runRole(options), { answer: 'fixed' });
  assert.equal(f.life.store.documentEvents(d.id).filter(e => e.type === 'invocation.started').length, count, 'a valid checkpoint is reused with no new call');
});

test('native patch repair refuses a whole-document rewrite and retains the last checkpoint', async t => {
  const f = fixture(t);
  const d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement multiplication.', proposal: oneTask() });
  const agent = fakeClaude(f, `
let out = { answer: '', preserved: 'Operator decision' };
if (request.repair?.attempt === 1) out = { answer: 'valid', preserved: 'Unrequested replacement' };
if (request.repair?.attempt === 2) {
  if (request.repair.targetSchema.properties.preserved.type !== 'string') throw new Error('Original contract was lost');
  if (request.repair.previousOutput.preserved !== 'Operator decision') throw new Error('Retained output changed');
  out = { patches: [{ path: '/answer', valueJson: '"valid"' }] };
}
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0.1,structured_output:out}));`);
  const result = await runRole({ store: f.life.store, documentId: d.id, budgetDocumentId: d.id, repo: f.repo, sha: d.data.baseSha,
    role: 'product', agent, passEnv: [], schema: s.object({ answer: s.string(1, 30), preserved: s.string() }), context: {}, maxRepairs: 2 });
  assert.deepEqual(result, { answer: 'valid', preserved: 'Operator decision' });
  assert.equal(f.life.store.documentEvents(d.id, ['invocation.started']).length, 3);
  assert.equal(f.life.store.documentEvents(d.id, ['role.output_rejected']).length, 2);
});

test('role checkpoints are reused only for the same SHA, context, schema and guidance', async t => {
  const f = fixture(t);
  const d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement multiplication.', proposal: oneTask() });
  const agent = fakeClaude(f, `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0.1,structured_output:{answer:'valid'}}));`);
  const options = { store: f.life.store, documentId: d.id, budgetDocumentId: d.id, repo: f.repo, sha: d.data.baseSha,
    role: 'product', agent, passEnv: [], schema: s.object({ answer: s.string(1, 30) }), context: { request: 'Original request' } };
  const count = () => f.life.store.documentEvents(d.id, ['invocation.started']).length;
  await runRole(options);
  await runRole(options);
  assert.equal(count(), 1);
  await runRole({ ...options, context: { request: 'Changed request' } });
  assert.equal(count(), 2);
  await runRole({ ...options, schema: s.object({ answer: s.string(2, 30) }) });
  assert.equal(count(), 3);
  await runRole({ ...options, skills: { enabled: ['clean-code'], projectType: 'backend', maxContextBytes: 16000 } });
  assert.equal(count(), 4);
  writeFileSync(join(f.repo, 'README.md'), 'Changed baseline\n');
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'New baseline');
  await runRole({ ...options, sha: git(f.repo, 'rev-parse', 'HEAD') });
  assert.equal(count(), 5);
  await runRole(options);
  assert.equal(count(), 5, 'a different context must not overwrite the original checkpoint');
});

test('failed provider process contributes declared spending even without usable output', async t => {
  const f = fixture(t); const d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement multiplication.', proposal: oneTask() });
  const agent = fakeClaude(f, `console.log(JSON.stringify({type:'result',subtype:'error_max_budget_usd',is_error:true,total_cost_usd:5.2,num_turns:26})); process.exitCode=1;`);
  await assert.rejects(() => runRole({ store: f.life.store, documentId: d.id, repo: f.repo, sha: d.data.baseSha, role: 'product', agent, passEnv: [], schema: s.object({ answer: s.string() }), context: {} }), /cost ceiling/);
  assert.deepEqual(f.life.costSummary(d.id), { knownUsd: 5.2, unknownInvocations: 0, pendingInvocations: 0, ceilingUsd: 25 });
});

test('minor UI change reuses conventions without a full design invocation', async t => {
  const f = fixture(t, { skills: { enabled: ['ui-design'], projectType: 'frontend', maxContextBytes: 16000 } });
  const config = validateConfig(f.config);
  const task = { id: 'DOC', title: 'Correct UI label', description: 'Correct one label in an existing component.', acceptance: ['The label uses the specified spelling.'], allowedPaths: ['src/label.js'] };
  const proposal = compactProposal(task, task.description, config);
  const d = await f.life.draft({ repo: f.repo, config, request: task.description, proposal });
  assert.equal(d.data.content.experience.uiImpact, 'minor'); assert.equal(d.data.design, null);
  assert.equal(f.life.store.documentEvents(d.id).filter(e => e.type === 'invocation.started').length, 0);
});

test('model routing is role, provider and risk specific without changing tools or budgets', async t => {
  const f = fixture(t);
  const config = validateConfig({ ...f.config, agent: { type: 'claude', model: 'base-model' },
    roles: { product: { type: 'codex', model: 'product-model' } },
    modelRouting: [{ provider: 'claude', role: 'implementer', lane: 'high', model: 'reviewed-high-model', effort: 'high' }] });
  assert.equal(roleAgent(config, 'implementer', 'high').model, 'reviewed-high-model');
  assert.equal(roleAgent(config, 'implementer', 'standard').model, 'base-model');
  assert.equal(roleAgent(config, 'product', 'high').model, 'product-model');
  assert.equal(roleAgent(config, 'design', 'high').model, 'product-model');
  assert.equal(roleAgent(config, 'implementer', 'high').maxBudgetUsd, config.agent.maxBudgetUsd);
  assert.throws(() => validateConfig({ ...config, modelRouting: [...config.modelRouting, ...config.modelRouting] }), /Duplicate model route/);
});

test('a valid checkpoint can be reused at an exhausted monetary ceiling', async t => {
  const f = fixture(t); const d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement multiplication.', proposal: oneTask() });
  const agent = fakeClaude(f, `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:1,structured_output:{answer:'kept'}}));`);
  const options = { store: f.life.store, documentId: d.id, budgetDocumentId: d.id, repo: f.repo, sha: d.data.baseSha, role: 'product', agent, passEnv: [], schema: s.object({ answer: s.string() }), context: { request: 'same request' } };
  await runRole(options);
  f.life.amendBudget(d.id, { maxSpecCostUsd: 1 }, 'Test Operator', 'No further paid calls are authorized.');
  assert.deepEqual(await runRole(options), { answer: 'kept' });
  assert.equal(f.life.store.documentEvents(d.id).filter(e => e.type === 'invocation.started').length, 1);
});

test('failed implementation spending is included in the owning spec', async t => {
  const f = fixture(t);
  const agent = fakeClaude(f, `console.log(JSON.stringify({type:'result',subtype:'error_max_budget_usd',is_error:true,total_cost_usd:2.3,num_turns:8})); process.exitCode=1;`);
  let doc = await f.life.draft({ repo: f.repo, config: { ...f.config, agent }, request: 'Implement multiplication.', proposal: oneTask() });
  doc = await f.life.approveSpec(doc.id, doc.data.contentHash, 'Test Owner', 'Approve the fixture task and its checks.');
  doc = await f.life.run(doc.id);
  assert.equal(doc.data.status, 'blocked');
  assert.equal(f.life.costSummary(doc.id).knownUsd, 2.3);
  const events = f.life.store.events(doc.data.attempts[0].runId);
  assert.equal(events.find(e => e.type === 'invocation.finished').data.status, 'failed');
});

test('failed refinement keeps the previous spec readable and accounts planning time', async t => {
  const f = fixture(t);
  const d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement multiplication.', proposal: oneTask() });
  await assert.rejects(() => f.life.refine(d.id, 'Also change the dependencies.', oneTask()), /security|Security/);
  const saved = f.life.get(d.id);
  assert.equal(saved.data.content.title, d.data.content.title);
  assert.equal(saved.data.error.code, 'PRODUCT');
  assert.ok(saved.data.planningMs > 0); assert.equal(saved.data.planningStartedAt, null);
  assert.match(f.life.summary(saved).nextAction, /plan-resume/);
  await assert.rejects(() => f.life.approveSpec(saved.id, saved.data.contentHash, 'Test Owner', 'Do not approve an unfinished refinement.'), /failed planning/);
});

test('provider budget stop with exit zero is accounted but never retried as a schema error', async t => {
  const f = fixture(t); const d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement multiplication.', proposal: oneTask() });
  const agent = fakeClaude(f, `console.log(JSON.stringify({type:'result',subtype:'error_max_budget_usd',is_error:true,total_cost_usd:5.2}));`);
  await assert.rejects(() => runRole({ store: f.life.store, documentId: d.id, repo: f.repo, sha: d.data.baseSha, role: 'product', agent, passEnv: [], schema: s.object({ answer: s.string() }), context: {}, maxRepairs: 2 }), /provider stopped/);
  assert.equal(f.life.costSummary(d.id).knownUsd, 5.2);
  assert.equal(f.life.store.documentEvents(d.id, ['invocation.started']).length, 1);
  assert.deepEqual(f.life.store.documentEvents(d.id, ['invocation.finished']).map(e => e.type), ['invocation.finished']);
  assert.deepEqual(f.life.store.documentEvents(d.id, []), []);
});

test('Design failure resumes the accepted Product spec without paying for another Product call', async t => {
  const f = fixture(t, { skills: { enabled: ['ui-design'], projectType: 'frontend', maxContextBytes: 16000 } });
  const request = 'Implement the arithmetic screen.';
  const spec = withSecurity(oneTask(), request, 'frontend');
  spec.experience = { uiImpact: 'major', surfaces: ['Arithmetic'], rationale: 'An initial screen needs a visual proposal.' };
  const design = { summary: 'Arithmetic screen', rationale: 'Simple existing conventions.', visualDirection: 'Neutral readable layout.', implementationBrief: 'Use the approved module.', css: 'main { color: #111; }',
    screens: [{ id: 'main', title: 'Arithmetic', purpose: 'Show results.', bodyHtml: '<main><h1>Arithmetic</h1></main>', states: ['Result'], responsive: 'Fluid width.' }],
    decisions: [{ decision: 'Reuse the module.', rationale: 'No additional structure is needed.', alternatives: [], tradeoffs: [] }], avoid: [], references: [], questions: [] };
  const log = join(f.root, 'role.log');
  const code = fail => `
const designMode=request.context.mode==='design-proposal';
appendFileSync(${JSON.stringify(log)},(designMode?'design':'product')+'\\n');
const fail=designMode && ${fail};
console.log(JSON.stringify({type:'result',subtype:fail?'error_max_budget_usd':'success',is_error:fail,total_cost_usd:0.25,structured_output:designMode?${JSON.stringify(design)}:${JSON.stringify(spec)}}));
if(fail) process.exitCode=1;`;
  const agent = fakeClaude(f, code(true));
  await assert.rejects(() => f.life.draft({ repo: f.repo, config: { ...f.config, agent, roles: { ...f.config.roles, product: agent, design: agent } }, request }), /cost ceiling/);
  const saved = f.life.store.documents('spec')[0];
  assert.ok(saved.data.content); assert.equal(saved.data.design, null);
  const hash = saved.data.contentHash;
  fakeClaude(f, code(false));
  const resumed = await f.life.resumePlanning(saved.id);
  assert.equal(resumed.data.contentHash, hash); assert.ok(resumed.data.design); assert.equal(resumed.data.error, null);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['product', 'design', 'design']);
  assert.equal(f.life.costSummary(saved.id).knownUsd, 0.75);
  assert.ok(resumed.data.planningMs > saved.data.planningMs);
});
