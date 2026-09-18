// Regression tests replaying provider failures observed during a real Claude-driven project.
// Each wrapper corrupts only the first answer the way a real model did, then behaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture, oneTask, withSecurity, git } from './lifecycle-helpers.mjs';
import { Store } from '../dist/persistence/store.js';
import { planBootstrap } from '../dist/lifecycle/bootstrap.js';
import { executionCapabilities } from '../dist/lifecycle/capabilities.js';
import { candidateSubject } from '../dist/execution/git.js';
import { planLedgerUpdate, applyLedgerUpdate } from '../dist/lifecycle/ledger-update.js';
import { planGarbage, collectGarbage } from '../dist/lifecycle/maintenance.js';
import { validateConfig } from '../dist/domain/contracts.js';

const RUN_WORKER = new URL('./support/run-worker.cjs', import.meta.url).pathname;
const exampleWorker = fileURLToPath(new URL('../examples/lifecycle-worker.mjs', import.meta.url));
const readLog = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

function flakyWorker(root, { corruptProduct = true, corruptDesign = true, corruptQa = true } = {}) {
  const path = join(root, 'flaky-worker.mjs'); const log = join(root, 'flaky.log');
  writeFileSync(path, `import { readFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { runWorker } = createRequire(import.meta.url)(${JSON.stringify(RUN_WORKER)});
const input = readFileSync(0, 'utf8'); const req = JSON.parse(input);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ role: req.role ?? req.protocol, mode: req.context?.mode ?? null, repair: req.repair?.previousError?.code ?? null, capabilities: Boolean(req.context?.executionCapabilities), design: req.task ? (req.task.description.match(/"scope":"(none|task|all)"/)?.[1] ?? null) : undefined, task: req.task?.id }) + '\\n');
const r = runWorker(${JSON.stringify(exampleWorker)}, input);
if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(r.status ?? 1); }
if (req.protocol === 'agent-pipeline/v2') { process.stdout.write(r.stdout); process.exit(0); }
const out = JSON.parse(r.stdout);
if (req.role === 'product' && req.context?.mode !== 'design-proposal') {
  out.experience = { uiImpact: 'major', surfaces: ['Arithmetic screen'], rationale: 'The arithmetic screen changes for users.' };
  const ctx = req.context.securityContext;
  if (ctx.topics.length) {
    out.acceptance.push({ id: 'AC-SEC', description: 'The routed security requirements hold on the screen.', verification: 'Inspect implementation and negative tests.' });
    out.tasks[0].acceptanceIds.push('AC-SEC'); out.minimumLane = ctx.minimumLane;
    out.security = { profile: { ...ctx.profile }, owaspTopics: ctx.topics.map(x => x.id), threatModel: { required: ctx.requiresThreatModel, summary: ctx.requiresThreatModel ? 'Fixture threat model.' : '', assets: ctx.requiresThreatModel ? ['state'] : [], trustBoundaries: ctx.requiresThreatModel ? ['client -> app'] : [], threats: ctx.requiresThreatModel ? [{ id: 'TM-1', category: 'spoofing', description: 'Untrusted input.', mitigations: ['Validate.'], acceptanceIds: ['AC-SEC'] }] : [], assumptions: [] },
      requirements: [{ id: 'SEC-1', title: 'Routed topics', owaspTopics: ctx.topics.map(x => x.id), acceptanceIds: ['AC-SEC'], verification: 'Inspect code.', negativeTests: ctx.negativeTestsRequired ? ['Reject hostile input.'] : [] }], assumptions: [], deferred: [] };
  }
  if (${corruptProduct} && !req.repair) out.acceptance[0].verification = 'x'.repeat(3001);
}
if (req.role === 'product' && req.context?.mode === 'design-proposal') {
  if (${corruptDesign} && !req.repair) out.screens[0].bodyHtml += '<p>Hostile title: <img src=x onerror=alert(1)></p>';
  else out.taskScopes = [{ taskId: 'MATH', screenIds: [out.screens[0].id] }];
}
if (req.role === 'qa') {
  out.securityChecks = req.context.spec.security.requirements.map(x => ({ requirementId: x.id, status: out.verdict === 'pass' ? 'pass' : 'unknown', evidence: 'Fixture inspection.' }));
  out.criteria = out.criteria.map(c => c.id === 'AC-SEC' ? { ...c, status: out.verdict === 'pass' ? 'pass' : 'unknown' } : c);
  if (${corruptQa} && !req.repair) out.candidateSha = '0'.repeat(40);
}
console.log(JSON.stringify(out));
`);
  return { command: [process.execPath, path], log };
}

test('Product, design and QA output-contract violations are repaired once with the controller error', async (t) => {
  const f = fixture(t, { skills: { enabled: ['ui-design'], projectType: 'frontend', maxContextBytes: 16000 } });
  const flaky = flakyWorker(f.root);
  const agent = { type: 'command', command: flaky.command };
  const config = { ...f.config, agent, roles: { product: agent, qa: agent }, workflow: { ...f.config.workflow, maxOutputRepairs: 1 } };
  let d = await f.life.draft({ repo: f.repo, config, request: 'Implement the approved arithmetic example screen.' });
  const repairs = f.life.store.documentEvents(d.id).filter(e => e.type === 'role.output_repair').map(e => e.data.code);
  assert.equal(repairs.length, 2);
  assert.match(repairs[0], /^SCHEMA$|^SPEC/);
  assert.equal(repairs[1], 'DESIGN_MARKUP');
  assert.ok(d.data.design);
  assert.deepEqual(d.data.design.proposal.taskScopes, [{ taskId: 'MATH', screenIds: [d.data.design.proposal.screens[0].id] }]);
  const log = readLog(flaky.log);
  assert.ok(log.filter(x => x.role === 'product' && x.mode !== 'design-proposal').every(x => x.capabilities));
  assert.deepEqual(log.filter(x => x.role === 'product').map(x => x.repair), [null, repairs[0], null, 'DESIGN_MARKUP']);

  d = await f.life.approveSpec(d.id, f.life.summary(d).hash, 'Test Owner', 'Reviewed the specification and its mockup together.');
  const done = await f.life.run(d.id);
  const qaRepair = f.life.store.documentEvents(d.id).filter(e => e.type === 'role.output_repair' && e.data.role === 'qa');
  assert.equal(qaRepair.length >= 1, true);
  assert.match(qaRepair[0].data.code, /^QA/);
  assert.ok(['awaiting_review', 'blocked'].includes(done.data.status));
  const tasks = readLog(flaky.log).filter(x => x.role === 'agent-pipeline/v2' && x.task);
  assert.equal(tasks.find(x => x.task === 'MATH')?.design, 'task');
  if (tasks.some(x => x.task === 'DOC')) assert.equal(tasks.find(x => x.task === 'DOC').design, 'none');
  const mathRun = done.data.attempts.find(a => a.taskId === 'MATH');
  const subject = git(f.repo, 'log', '-1', '--format=%s', f.life.pipeline.store.get(mathRun.runId).candidateSha);
  assert.equal(subject, 'Ajouter la multiplication');
});

test('timeouts and process failures are never retried as output repairs', async (t) => {
  const f = fixture(t);
  const log = join(f.root, 'slow.log'); const slow = join(f.root, 'slow-worker.mjs');
  writeFileSync(slow, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, 'call\\n'); setTimeout(() => {}, 5000);`);
  // The shared deadline includes Git workspace preparation. Leave room for the
  // child to start under suite load; the worker still exceeds the deadline.
  const agent = { type: 'command', command: [process.execPath, slow], timeoutMs: 2000 };
  await assert.rejects(f.life.draft({ repo: f.repo, config: { ...f.config, roles: { product: agent, qa: null }, workflow: { ...f.config.workflow, maxOutputRepairs: 2 } }, request: 'Implement the approved arithmetic example.' }), /timed_out/);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
  const doc = f.life.store.documents('spec')[0];
  assert.equal(f.life.store.documentEvents(doc.id, ['invocation.started']).length, 1);
  assert.equal(f.life.store.documentEvents(doc.id, ['role.output_repair']).length, 0);
});

test('bootstrap repairs a ledger that gives clarification metadata to a confirmed decision', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apv2-bootstrap-repair-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'app'); spawnSync('git', ['init', '-q', repo]);
  const worker = join(root, 'worker.mjs'); const log = join(root, 'calls.log');
  writeFileSync(worker, `import { readFileSync, appendFileSync } from 'node:fs';
const req = JSON.parse(readFileSync(0, 'utf8')); appendFileSync(${JSON.stringify(log)}, JSON.stringify({ protocol: req.protocol, repair: req.repair?.previousError?.code ?? null }) + '\\n');
const decision = { id: 'D-STACK', subject: 'Runtime', value: 'Native Node', enforcement: 'bootstrap', status: 'confirmed', source: 'operator', sourceQuote: 'minimal Node application', rationale: 'Explicit operator choice.', supersedes: [], clarificationQuestion: req.repair ? '' : 'Which Node version?', interpretations: [] };
if (req.protocol === 'agent-pipeline/bootstrap-v2') console.log(JSON.stringify({ projectType: 'backend', summary: 'Minimal Node application.', architecture: { summary: 'A dependency-free Node module is enough.', decisions: [{ decision: 'Native Node ESM', rationale: 'Smallest runnable scaffold.', evidence: ['Operator request'], alternatives: [], tradeoffs: [], reconsiderWhen: ['A framework is requested'] }] }, decisions: [decision], decisionCoverage: [{ decisionId: 'D-STACK', status: 'satisfied', evidence: [{ kind: 'file', reference: 'package.json', detail: 'type module, no dependency' }] }], files: [{ path: 'package.json', content: '{"type":"module"}\\n' }], questions: [], productQuestions: [], deferredQuestions: [], notes: [] }));
else console.log(JSON.stringify({ verdict: 'pass', summary: 'Consistent.', decisions: [{ decisionId: 'D-STACK', status: 'pass', evidence: 'package.json' }], missingOperatorDecisions: [], findings: [] }));
`);
  const store = new Store(join(root, 'state')); t.after(() => store.close());
  const doc = await planBootstrap(store, repo, 'Create a minimal Node application.', { type: 'command', command: [process.execPath, worker], timeoutMs: 30000, passEnv: [] }, undefined, 'solo');
  assert.equal(doc.data.semanticReview.verdict, 'pass');
  assert.ok(doc.data.hash);
  assert.deepEqual(readLog(log).map(x => x.repair), [null, 'DECISION_AMBIGUOUS', null]);
});

test('Product receives the real execution capabilities of the configured Implementer', () => {
  const base = { schemaVersion: 1, executionMode: 'local-trusted', environment: { id: 'x' }, gates: [{ id: 'unit', command: ['npm', 'test'] }], setup: [{ command: ['npm', 'ci', '--ignore-scripts'] }] };
  const claude = executionCapabilities(validateConfig({ ...base, agent: { type: 'claude' } }));
  assert.equal(claude.implementer.shell, false);
  assert.deepEqual(claude.runnerSetup, ['npm ci --ignore-scripts']);
  assert.ok(claude.rules.some(r => /install or update dependencies/.test(r)));
  assert.equal(executionCapabilities(validateConfig({ ...base, agent: { type: 'command', command: ['true'] } })).implementer.shell, 'unknown');
});

test('candidate commit subjects come from the task title', () => {
  assert.equal(candidateSubject('Emprunt, retour et retards', 'run-1'), 'Emprunt, retour et retards');
  assert.equal(candidateSubject('  multi\nline\ttitle ', 'run-1'), 'multi line title');
  assert.equal(candidateSubject('x'.repeat(100), 'run-1').length, 72);
  assert.equal(candidateSubject('', 'run-1'), 'Agent Pipeline V2 candidate run-1');
});

test('decision ledger updates are planned, hash-bound, supersede explicitly and commit', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apv2-ledger-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  run('init', '-q'); run('config', 'user.email', 't@example.com'); run('config', 'user.name', 'Tester');
  mkdirSync(join(root, '.agent-pipeline'));
  const old = { id: 'D-DOMAIN', subject: 'Domain', value: 'unresolved', enforcement: 'product', status: 'ambiguous', source: 'operator', sourceQuote: 'librairie', rationale: 'Ambiguous word.', supersedes: [], clarificationQuestion: 'Which kind of shop?', interpretations: ['library', 'bookshop'] };
  writeFileSync(join(root, '.agent-pipeline/DECISIONS.json'), JSON.stringify({ schemaVersion: 1, decisions: [old] }, null, 2) + '\n');
  run('add', '-A'); run('commit', '-qm', 'init');
  const update = { decisions: [{ id: 'D-DOMAIN-2', subject: 'Domain', value: 'Bookshop that also lends', enforcement: 'product', status: 'confirmed', source: 'operator', sourceQuote: 'Librairie + prêt', rationale: 'Operator answer.', supersedes: ['D-DOMAIN'], clarificationQuestion: '', interpretations: [] }] };
  const plan = await planLedgerUpdate(root, update);
  assert.deepEqual(plan.superseded, ['D-DOMAIN']);
  assert.deepEqual(plan.ledger.decisions.map(d => d.id), ['D-DOMAIN-2']);
  await assert.rejects(applyLedgerUpdate(root, update, 'wrong', 'Tester', 'Record the operator answer.', true), /LEDGER_HASH|changed since/);
  const applied = await applyLedgerUpdate(root, update, plan.hash, 'Tester', 'Record the operator answer.', true);
  assert.equal(JSON.parse(readFileSync(join(root, '.agent-pipeline/DECISIONS.json'), 'utf8')).decisions[0].id, 'D-DOMAIN-2');
  assert.match(readFileSync(join(root, '.agent-pipeline/DECISIONS.md'), 'utf8'), /D-DOMAIN-2/);
  assert.equal(run('log', '-1', '--format=%s'), 'chore(decisions): update decision ledger');
  assert.equal(applied.commitSha, run('rev-parse', 'HEAD'));
  await assert.rejects(planLedgerUpdate(root, { decisions: [{ ...update.decisions[0], id: 'D-X', source: 'derived', status: 'proposed', sourceQuote: '', supersedes: ['D-DOMAIN-2'] }] }), /must be an operator decision/);
  await assert.rejects(planLedgerUpdate(root, update), /already exists/);
});

test('gc removes workspaces of rejected specs only after a dry run, never active material', async (t) => {
  const f = fixture(t, { workflow: { qaLanes: [], maxQaRepairs: 0, maxActiveMs: 300000 } });
  let d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.', proposal: oneTask() });
  d = await f.life.approveSpec(d.id, f.life.summary(d).hash, 'Test Owner', 'Reviewed the specification before execution.');
  d = await f.life.run(d.id);
  const runIds = [...d.data.attempts.map(a => a.runId), ...d.data.validationRunIds];
  assert.equal(planGarbage(f.life).filter(i => runIds.some(id => i.path.endsWith(id))).length, 0, 'active spec material is kept');
  f.life.reject(d.id, 'Rejected in the garbage collection regression test.');
  const plan = planGarbage(f.life).filter(i => runIds.some(id => i.path.endsWith(id)) || i.path.endsWith(d.id));
  assert.ok(plan.some(i => i.kind === 'review-workspace'));
  assert.ok(plan.length > 0);
  const { removed, failed } = await collectGarbage(f.life, plan);
  assert.deepEqual(failed, []);
  assert.equal(removed.length, plan.length);
  assert.ok(plan.every(i => !existsSync(i.path)));
  assert.equal(git(f.repo, 'worktree', 'list').split('\n').length, 1);
});

test('an Implementer without a shell cannot be given a tool-generated file, and generatedPaths adapts per stack', async (t) => {
  const f = fixture(t);
  const claudeConfig = { ...f.config, agent: { type: 'claude' }, roles: { product: null, qa: null } };
  const spec = withSecurity(oneTask(), 'Dependency change.'); spec.tasks[0].allowedPaths = [...spec.tasks[0].allowedPaths, 'package-lock.json'];
  await assert.rejects(f.life.draft({ repo: f.repo, config: claudeConfig, request: 'Implement the approved arithmetic example.', proposal: spec }), /SPEC_CAPABILITY|no shell to regenerate/);
  const custom = await f.life.draft({ repo: f.repo, config: { ...claudeConfig, workflow: { ...f.config.workflow, generatedPaths: ['**/*.generated.ts'] } }, request: 'Implement the approved arithmetic example.', proposal: spec });
  assert.ok(custom.data.content.tasks[0].allowedPaths.includes('package-lock.json'), 'a project may declare its own generated paths');
  const commandSpec = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.', proposal: spec });
  assert.ok(commandSpec.data.content, 'wrappers with unknown capabilities are not guessed');
});

test('task context and QA diff limits are configurable within bounded ceilings', async (t) => {
  const base = { schemaVersion: 1, executionMode: 'local-trusted', environment: { id: 'x' }, agent: { type: 'command', command: ['true'] }, gates: [{ id: 'g', command: ['true'] }] };
  assert.deepEqual(validateConfig(base).limits, { maxTaskContextChars: 120000, maxQaDiffBytes: 524288 });
  assert.equal(validateConfig({ ...base, limits: { maxTaskContextChars: 250000 } }).limits.maxTaskContextChars, 250000);
  assert.throws(() => validateConfig({ ...base, limits: { maxTaskContextChars: 500000 } }));
  const f = fixture(t, { limits: { maxTaskContextChars: 10000 }, workflow: { qaLanes: [], maxQaRepairs: 0, maxActiveMs: 300000 } });
  const spec = oneTask(); spec.tasks[0].description = 'Implement multiply with tests. ' + 'Context detail. '.repeat(700);
  let d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.', proposal: spec });
  d = await f.life.approveSpec(d.id, f.life.summary(d).hash, 'Test Owner', 'Reviewed the specification before execution.');
  const result = await f.life.run(d.id);
  assert.equal(result.data.error?.code, 'TASK_CONTEXT');
  assert.match(result.data.error.message, /limits\.maxTaskContextChars 10000/);
});

test('an invalid path pattern proposed by a role is an output-contract violation eligible for repair', async () => {
  const { isRepairableOutputError } = await import('../dist/lifecycle/roles.js');
  const { matches } = await import('../dist/policy/policy.js');
  let error; try { matches('a', 'src/{a,b}.ts'); } catch (e) { error = e; }
  assert.equal(error?.code, 'GLOB');
  assert.equal(isRepairableOutputError(error), true);
});
