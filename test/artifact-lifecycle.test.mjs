// An external audit reproduced three local losses: a failed semantic review discarded the whole Setup
// proposal, a ledger commit carried unrelated staged work, and a design asset could be read through a
// symlinked directory of the repository. Each one is cheap to cause and invisible in a green suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/persistence/store.js';
import { planBootstrap } from '../dist/lifecycle/bootstrap.js';
import { applyLedgerUpdate, planLedgerUpdate } from '../dist/lifecycle/ledger-update.js';
import { fixture as lifecycleFixture, oneTask, withSecurity, git as gitOf } from './lifecycle-helpers.mjs';

const run = (cwd, args) => {
  const r = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${args.join(' ')}\n${r.stderr}`); return r.stdout.trim();
};

/** Setup worker whose proposal is valid but whose semantic review keeps citing an unknown decision. */
function failingReviewFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'apv2-artifact-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'app'); run(root, ['git', 'init', repo]);
  const worker = join(root, 'worker.mjs');
  writeFileSync(worker, String.raw`let text='';for await (const c of process.stdin) text+=c;const input=JSON.parse(text);
const decision={id:'D-STACK',subject:'Runtime stack',value:'Native Node ESM',enforcement:'bootstrap',status:'confirmed',source:'operator',sourceQuote:'minimal Node application',rationale:'The operator explicitly asked for a minimal Node application.',supersedes:[]};
if(input.protocol==='agent-pipeline/bootstrap-v2'){console.log(JSON.stringify({projectType:'backend',summary:'Minimal Node application with a real built-in test.',architecture:{summary:'A small dependency-free Node module fits the requested arithmetic bootstrap and keeps the initial surface minimal.',decisions:[{decision:'Use native Node ESM with node:test.',rationale:'The request needs one small function and a real test without adding framework complexity.',evidence:['The operator explicitly requested a minimal Node application.','Node >=22.16 is already required by the framework.'],alternatives:[{option:'Add a web framework',reasonNotChosen:'No HTTP or UI requirement exists in the bootstrap request.'}],tradeoffs:['Deliberately minimal; a framework may be added if later requirements justify it.'],reconsiderWhen:['The application needs HTTP routing, persistence, UI, or external packages.']}]},decisions:[decision],decisionCoverage:[{decisionId:'D-STACK',status:'satisfied',evidence:[{kind:'file',reference:'package.json',detail:'ESM package manifest implements the selected runtime.'}]}],files:[{path:'package.json',content:JSON.stringify({name:'new-app',private:true,type:'module',scripts:{test:'node --test'}},null,2)+'\n'},{path:'src/add.js',content:'export const add=(a,b)=>a+b;\n'}],questions:[],productQuestions:[],deferredQuestions:[],notes:['No dependencies required.']}));}
else{console.log(JSON.stringify({verdict:'changes_requested',summary:'Review citing a decision that does not exist.',decisions:[{decisionId:'D-DOES-NOT-EXIST',status:'covered',evidence:'invented'}],missingOperatorDecisions:[],findings:[{severity:'blocker',description:'Invented decision reference.'}]}));}
`);
  return { root, repo, worker };
}

test('a failed semantic review keeps the Setup proposal and records why the round ended', async (t) => {
  const f = failingReviewFixture(t);
  const store = new Store(join(f.root, 'state'));
  t.after(() => store.close());
  await assert.rejects(planBootstrap(store, f.repo, 'Create a minimal Node application with an addition function.',
    { type: 'command', command: [process.execPath, f.worker], timeoutMs: 30000, passEnv: [] }));

  const [doc] = store.documents('bootstrap');
  assert.ok(doc, 'the plan document survives the failure');
  assert.notEqual(doc.data.proposal.summary, 'pending', 'the expensive Setup proposal is not discarded');
  assert.deepEqual(doc.data.proposal.files.map(x => x.path), ['package.json', 'src/add.js']);
  assert.equal(doc.data.hash, '', 'an unreviewed proposal cannot be approved');
  const events = store.documentEvents(doc.id).map(e => e.type);
  assert.ok(events.includes('bootstrap.proposal_checkpoint'), 'the proposal is persisted before the review');
  assert.ok(events.includes('bootstrap.failed'), 'the failure is recorded, not silent');
  assert.match(doc.data.semanticReview.summary, /^Bootstrap round failed/, 'the recorded review says the round failed');
  assert.ok(doc.data.semanticReview.findings[0].description.length > 10, 'the diagnosis keeps the controller error');
});

test('a ledger commit carries the ledger only, never work the operator had staged', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apv2-ledger-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'app');
  run(root, ['git', 'init', repo]);
  run(repo, ['git', 'config', 'user.email', 'test@example.invalid']);
  run(repo, ['git', 'config', 'user.name', 'Fixture']);
  writeFileSync(join(repo, 'README.md'), '# app\n');
  run(repo, ['git', 'add', '.']); run(repo, ['git', 'commit', '-qm', 'base']);
  mkdirSync(join(repo, '.agent-pipeline'), { recursive: true });
  writeFileSync(join(repo, '.agent-pipeline/DECISIONS.json'), JSON.stringify({ schemaVersion: 1, decisions: [] }, null, 2) + '\n');
  run(repo, ['git', 'add', '.']); run(repo, ['git', 'commit', '-qm', 'empty ledger']);

  writeFileSync(join(repo, 'unrelated-staged.txt'), 'work in progress\n');
  run(repo, ['git', 'add', 'unrelated-staged.txt']);

  const update = { decisions: [{ id: 'D-NEW', subject: 'Sujet', value: 'Valeur', enforcement: 'product', status: 'confirmed', source: 'operator', sourceQuote: 'citation', rationale: 'Raison suffisante pour le test.', supersedes: [] }] };
  const plan = await planLedgerUpdate(repo, update);
  await applyLedgerUpdate(repo, update, plan.hash, 'Fixture Reviewer', 'Ajout de la décision pour le test.', true);

  const committed = run(repo, ['git', 'show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean).sort();
  assert.deepEqual(committed, ['.agent-pipeline/DECISIONS.json', '.agent-pipeline/DECISIONS.md']);
  assert.match(run(repo, ['git', 'status', '--porcelain=v1', '--', 'unrelated-staged.txt']), /^A/, 'the staged work stays staged, untouched');
});

test('a design asset cannot be read through a symlinked directory of the repository', async (t) => {
  const f = lifecycleFixture(t, { skills: { enabled: ['ui-design'], projectType: 'frontend', maxContextBytes: 16000 } });
  const outside = mkdtempSync(join(tmpdir(), 'apv2-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret.png'), Buffer.from('audit-marker-outside-the-repository'));
  // Ignored by Git, exactly as the audit reproduced it: the repository stays clean and the link is local.
  writeFileSync(join(f.repo, '.gitignore'), 'node_modules/\ndist/\nassets\n');
  gitOf(f.repo, 'add', '.'); gitOf(f.repo, 'commit', '-qm', 'Ignore the local assets directory');
  symlinkSync(outside, join(f.repo, 'assets'));

  const worker = join(f.root, 'escaping-worker.mjs');
  writeFileSync(worker, `import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const input = readFileSync(0, 'utf8'); const req = JSON.parse(input);
const r = spawnSync(process.execPath, [${JSON.stringify(new URL('../examples/lifecycle-worker.mjs', import.meta.url).pathname)}], { input, encoding: 'utf8' });
if (req.protocol === 'agent-pipeline/v2') { process.stdout.write(r.stdout); process.exit(0); }
const out = JSON.parse(r.stdout);
if (req.role === 'product' && req.context?.mode === 'design-proposal') {
  out.assets = [{ id: 'leak', path: 'assets/secret.png', reason: 'Illustration.' }];
  out.css += 'body{background:url(asset:leak)}';
  out.taskScopes = [{ taskId: 'MATH', screenIds: [out.screens[0].id] }];
}
if (req.role === 'product' && req.context?.mode !== 'design-proposal')
  out.experience = { uiImpact: 'major', surfaces: ['Arithmetic screen'], rationale: 'The arithmetic screen changes for users.' };
console.log(JSON.stringify(out));
`);
  const agent = { type: 'command', command: [process.execPath, worker] };
  const spec = oneTask();
  spec.title = 'Arithmetic dashboard';
  spec.problem = 'The frontend needs a clear arithmetic dashboard before implementation begins.';
  spec.experience = { uiImpact: 'major', surfaces: ['Arithmetic dashboard'], rationale: 'The task changes the primary user-facing screen.' };
  const request = 'Create a distinctive arithmetic dashboard.';
  await assert.rejects(
    f.life.draft({ repo: f.repo, config: { ...f.config, agent, roles: { product: agent, qa: agent } }, request, proposal: withSecurity(spec, request, 'frontend') }),
    error => { assert.match(error.message, /resolves outside the repository|not a file tracked/); return true; });

  const review = join(f.root, 'repo-review');
  assert.ok(!existsSync(review) || !readFileSync(join(f.root, 'flaky.log'), 'utf8').includes('audit-marker'), 'nothing outside the repository was copied');
});

// The audit replayed `apv2 spec run` on a spec blocked by SCOPE_AMENDMENT_REQUIRED because the summary
// recommended exactly that, and got the same stop. A blocked spec must name the action that lifts its blocker.
test('the next action of a blocked spec lifts its blocker instead of repeating it', async (t) => {
  const f = lifecycleFixture(t);
  let d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.' });
  d = await f.life.approveSpec(d.id, d.data.contentHash, 'Test Owner', 'Fixture approval after inspecting scope and criteria.');

  const blocked = (error, extra = {}) => {
    const doc = f.life.get(d.id);
    Object.assign(doc.data, { status: 'blocked', error }, extra);
    f.life.store.saveDocument(doc, 'test.blocked', {});
    return f.life.summary(f.life.get(d.id)).nextAction;
  };

  const amendment = { id: 'AMD-1', taskId: 'MATH', paths: ['test/math.test.mjs'], reason: 'Le test existant change.', status: 'pending', sourceRunId: 'run-1', at: Date.now() };
  assert.match(blocked({ code: 'SCOPE_AMENDMENT_REQUIRED', message: 'Candidate needs files outside the approved execution paths' }, { scopeAmendments: [amendment] }),
    /spec amend .* --amendment AMD-1 --approve/, 'the amendment id is given, not left to be found');
  assert.match(blocked({ code: 'REPAIR_NO_CHANGE', message: 'The repair produced the same candidate' }, { scopeAmendments: [] }), /spec retry .* --confirm/);
  assert.match(blocked({ code: 'CANCELLED', message: 'Spec execution cancelled' }), /spec recover .* --confirm-stopped/);
  assert.match(blocked({ code: 'QA_REJECTED', message: 'QA requests changes; automatic repair budget exhausted.' }), /follow-up spec/);
  assert.match(blocked({ code: 'GATE', message: 'unit failed' }), /Resolve GATE before running again/);
});

// A single-task spec validated the same candidate twice: the reuse shortcut asked for a run flagged for
// human review, which per-task runs never are. Reuse must depend on the proof, and on not lowering review.
test('a single-task spec reuses its proven validation instead of replaying every gate', async (t) => {
  const f = lifecycleFixture(t);
  // The fixture QA judges a documentation task this spec does not have; the point here is gate reuse.
  // A fast lane needs no approval, so reusing the task's own validation cannot weaken human review.
  const config = { ...f.config, workflow: { ...f.config.workflow, qaLanes: [] },
    risk: { ...f.config.risk, fastPaths: ['src/**', 'test/**'], maxFastFiles: 10, maxFastLines: 500 } };
  const spec = oneTask(); spec.minimumLane = 'fast'; spec.tasks[0] = { ...spec.tasks[0], minimumLane: 'fast' };
  let d = await f.life.draft({ repo: f.repo, config, request: 'Implement the approved arithmetic example.', proposal: spec });
  d = await f.life.approveSpec(d.id, d.data.contentHash, 'Test Owner', 'Fixture approval after inspecting scope and criteria.');
  d = await f.life.run(d.id);
  assert.ok(['ready', 'awaiting_review'].includes(d.data.status), JSON.stringify(d.data.error));

  const events = f.life.store.documentEvents(d.id);
  const reused = events.find(e => e.type === 'integration.reused');
  assert.ok(reused, 'the single task already validated this exact candidate');
  assert.equal(d.data.finalRunId, d.data.attempts[0].runId);
  assert.deepEqual([...new Set(reused.data.gates)].sort(), config.gates.map(g => g.id).sort(), 'reuse requires every configured gate');
  assert.equal(d.data.validationRunIds.length, 0, 'no second validation run was created for the same candidate');
  assert.equal(f.life.pipeline.store.get(d.data.finalRunId).risk.lane, 'fast');
});

// The counterpart: when the lane does require approvals, reusing a per-task run would silently drop them,
// so the integration validation still runs. The second validation is a decision, not an accident.
test('reuse is refused when it would lower the approvals the integration requires', async (t) => {
  const f = lifecycleFixture(t);
  const config = { ...f.config, workflow: { ...f.config.workflow, qaLanes: [], reviewMode: 'team' } };
  let d = await f.life.draft({ repo: f.repo, config, request: 'Implement the approved arithmetic example.', proposal: oneTask() });
  d = await f.life.approveSpec(d.id, d.data.contentHash, 'Test Owner', 'Fixture approval after inspecting scope and criteria.');
  d = await f.life.run(d.id);
  assert.equal(f.life.pipeline.store.get(d.data.attempts[0].runId).risk.lane, 'standard');
  assert.equal(d.data.validationRunIds.length, 1, 'a standard lane keeps its reviewable integration run');
  assert.equal(d.data.status, 'awaiting_review');
});
