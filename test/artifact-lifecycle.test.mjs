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
import { planGarbage } from '../dist/lifecycle/maintenance.js';
import { fixture as lifecycleFixture, oneTask, withSecurity, git as gitOf } from './lifecycle-helpers.mjs';

const RUN_WORKER = new URL('./support/run-worker.cjs', import.meta.url).pathname;
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
import { createRequire } from 'node:module';
const { runWorker } = createRequire(import.meta.url)(${JSON.stringify(RUN_WORKER)});
const input = readFileSync(0, 'utf8'); const req = JSON.parse(input);
const r = runWorker(${JSON.stringify(new URL('../examples/lifecycle-worker.mjs', import.meta.url).pathname)}, input);
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
  assert.match(blocked({ code: 'NO_CHANGE', message: 'Agent produced no effective change' }), /changed nothing.*spec retry .* --confirm/);
  assert.match(blocked({ code: 'STALE_EVIDENCE', message: 'Validation expired; revalidate before approval/export' }), /spec verify /);
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

// A running spec is immutable by design, but a criterion can turn out to forbid what the approved change
// requires. Observed on a real increment: a schema migration added a table, one existing test asserted the
// table list, and a criterion promised that test would not change. Eighteen criteria passed and the only
// exit was to discard a finished candidate.
test('an unsatisfiable criterion can be corrected with explicit approval, without touching anything else', async (t) => {
  const f = lifecycleFixture(t);
  let d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.' });
  const criterion = d.data.content.acceptance[0];
  d = await f.life.approveSpec(d.id, d.data.contentHash, 'Test Owner', 'Fixture approval after inspecting scope and criteria.');

  const correction = { description: `${criterion.description} Les tests de forme peuvent changer.`, verification: `${criterion.verification} Relire le diff.`, reason: 'Le critère interdit ce que la migration approuvée impose.' };
  assert.throws(() => f.life.planCriterionAmendment(d.id, criterion.id, correction), /Execution has not started/, 'before execution, the spec is refined, not amended');

  d = await f.life.run(d.id);
  assert.ok(['ready', 'awaiting_review'].includes(d.data.status), JSON.stringify(d.data.error));
  const qaBefore = d.data.qa;

  assert.throws(() => f.life.planCriterionAmendment(d.id, 'AC-DOES-NOT-EXIST', correction), /Unknown acceptance criterion/);
  assert.throws(() => f.life.planCriterionAmendment(d.id, criterion.id, { ...correction, reason: 'trop court' }), /Explain why/);
  assert.throws(() => f.life.planCriterionAmendment(d.id, criterion.id, { ...correction, description: criterion.description, verification: criterion.verification }), /identical/);

  d = f.life.planCriterionAmendment(d.id, criterion.id, correction);
  const pending = d.data.criterionAmendments.at(-1);
  assert.equal(pending.status, 'pending');
  assert.deepEqual(pending.previous, { description: criterion.description, verification: criterion.verification });
  assert.deepEqual(f.life.get(d.id).data.content.acceptance[0], criterion, 'a pending correction changes nothing');

  assert.throws(() => f.life.approveCriterionAmendment(d.id, pending.id, 'wrong-hash', 'Test Owner', 'Approbation du critère corrigé après lecture.'), /exact corrected criterion hash/);
  d = f.life.approveCriterionAmendment(d.id, pending.id, pending.hash, 'Test Owner', 'Approbation du critère corrigé après lecture du diff.');
  assert.equal(d.data.criterionAmendments.at(-1).status, 'approved');
  assert.equal(d.data.status, 'running', 'the spec reopens for assessment');
  assert.equal(d.data.qa, null, 'the previous QA no longer applies to the corrected criterion');
  assert.equal(d.data.review, null);
  assert.ok(qaBefore, 'there was a QA report to invalidate');

  const stored = f.life.get(d.id).data;
  assert.deepEqual(stored.content.acceptance[0], criterion, 'the approved text stays auditable in the store');
  d = await f.life.run(d.id);
  assert.ok(['ready', 'awaiting_review'].includes(d.data.status), JSON.stringify(d.data.error));
  assert.equal(d.data.qa.report.criteria.length, stored.content.acceptance.length);
  const events = f.life.store.documentEvents(d.id).map(e => e.type);
  assert.ok(events.includes('criterion.amendment_proposed') && events.includes('criterion.amendment_approved'));
});

// Observed on the real increment right after the criterion correction was approved: QA still judged the
// original wording, because its context carried the stored spec text instead of the effective one. It also
// reported an approved scope amendment as out of scope, and two security requirements linked to the
// criterion kept the same unsatisfiable constraint. The previous test only counted criteria.
test('QA judges the effective spec: corrected criterion, corrected requirements and amended scope', async (t) => {
  const f = lifecycleFixture(t);
  const log = join(f.root, 'qa-context.log');
  const exampleWorker = new URL('../examples/lifecycle-worker.mjs', import.meta.url).pathname;
  const worker = join(f.root, 'qa-tracing-worker.mjs');
  writeFileSync(worker, `import { readFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { runWorker } = createRequire(import.meta.url)(${JSON.stringify(RUN_WORKER)});
const input = readFileSync(0, 'utf8'); const req = JSON.parse(input);
if (req.role === 'qa') appendFileSync(${JSON.stringify(log)}, JSON.stringify({ spec: req.context.spec, amendments: req.context.approvedAmendments, summaries: req.context.taskSummaries }) + '\\n');
if (req.protocol === 'agent-pipeline/v2' && req.task.description.startsWith('Correct the following QA findings')) appendFileSync(${JSON.stringify(log)}, JSON.stringify({ repair: req.task.description }) + '\\n');
const r = runWorker(${JSON.stringify(exampleWorker)}, input);
if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(r.status ?? 1); }
process.stdout.write(r.stdout);
`);
  const agent = { type: 'command', command: [process.execPath, worker] };
  const config = { ...f.config, agent, roles: { product: agent, qa: agent } };
  const request = 'Implement the approved arithmetic example.';
  const spec = withSecurity(oneTask(), 'Ajouter une page de connexion avec mot de passe.', 'unknown');
  let d = await f.life.draft({ repo: f.repo, config, request, proposal: spec });
  d = await f.life.approveSpec(d.id, d.data.contentHash, 'Test Owner', 'Fixture approval after inspecting scope and criteria.');
  d = await f.life.run(d.id);
  const requirement = d.data.content.security.requirements[0];
  assert.ok(requirement, 'the fixture has a security requirement to correct');
  const target = d.data.content.acceptance.find(a => a.id === requirement.acceptanceIds[0]);
  const unrelated = d.data.content.acceptance.find(a => !requirement.acceptanceIds.includes(a.id));
  assert.ok(unrelated, 'the fixture has a criterion the requirement does not verify');
  assert.throws(() => f.life.planCriterionAmendment(d.id, unrelated.id, { description: `${unrelated.description} Corrigé.`, verification: unrelated.verification,
    reason: 'Le critère interdit ce que le changement approuvé impose.', requirements: [{ id: requirement.id, verification: 'Nouvelle vérification observable.' }] }),
    /does not verify/, 'a requirement can only be corrected with the criterion it verifies');

  // An approved scope amendment, as the controller records it after the operator accepts it.
  const withScope = f.life.get(d.id);
  withScope.data.scopeAmendments.push({ id: 'AMD-SCOPE', taskId: 'MATH', paths: ['src/extra/allowed.mjs'], reason: 'Test existant rendu faux par le changement approuvé.',
    status: 'approved', sourceRunId: withScope.data.attempts[0].runId, candidateSha: withScope.data.currentSha, at: Date.now(), approvedAt: Date.now(), reviewer: 'Test Owner', note: 'Approuvé.' });
  f.life.store.saveDocument(withScope, 'test.scope_amendment', {});
  d = f.life.get(d.id);

  d = f.life.planCriterionAmendment(d.id, target.id, { description: `${target.description} Les tests de forme peuvent changer.`, verification: `${target.verification} Relire le diff.`,
    reason: 'Le critère interdit ce que le changement approuvé impose.', requirements: [{ id: requirement.id, verification: 'Les suites restent vertes ; seule la liste des tables peut changer.' }] });
  const pending = d.data.criterionAmendments.at(-1);
  d = f.life.approveCriterionAmendment(d.id, pending.id, pending.hash, 'Test Owner', 'Approbation du critère et de son exigence liée.');
  d = await f.life.run(d.id);

  const entries = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const seen = entries.filter(e => e.spec).at(-1);
  // QA reads what each attempt reported; a repair knows it may reach outside scope through an amendment.
  assert.ok(seen.summaries.some(x => x.taskId === 'MATH' && x.summary.length > 0), 'QA receives the task summaries');

  assert.equal(seen.spec.acceptance.find(a => a.id === target.id).description, `${target.description} Les tests de forme peuvent changer.`, 'QA reads the corrected criterion, not the stored text');
  assert.equal(seen.spec.security.requirements.find(q => q.id === requirement.id).verification, 'Les suites restent vertes ; seule la liste des tables peut changer.');
  assert.equal(seen.amendments.criteria.at(-1).reason, 'Le critère interdit ce que le changement approuvé impose.');
  assert.equal(seen.amendments.criteria.at(-1).reviewer, 'Test Owner');
  assert.ok(seen.spec.tasks.find(x => x.id === 'MATH').allowedPaths.includes('src/extra/allowed.mjs'), 'QA sees the approved scope amendment in the task');
  assert.deepEqual(seen.amendments.scope.map(a => a.paths), [['src/extra/allowed.mjs']]);
  assert.equal(f.life.get(d.id).data.content.security.requirements[0].verification, requirement.verification, 'the stored requirement text stays auditable');
});

// Observed on a real project: a spec rejected while its run pointer was still set stayed "active" forever,
// so gc never collected its workspaces; and closing a reviewed, operator-merged spec required a delivery bundle.
test('a rejected spec releases its run pointer and its workspaces become collectable', async (t) => {
  const f = lifecycleFixture(t);
  let d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.' });
  d = await f.life.approveSpec(d.id, d.data.contentHash, 'Test Owner', 'Fixture approval after inspecting scope and criteria.');
  d = await f.life.run(d.id);
  const runId = d.data.attempts[0].runId;

  // A document written before the fix: rejected, with the pointer left behind.
  const legacy = f.life.get(d.id);
  Object.assign(legacy.data, { status: 'rejected', activeRunId: runId });
  f.life.store.saveDocument(legacy, 'test.legacy_rejection', {});
  const items = planGarbage(f.life).map(x => x.path);
  assert.ok(items.some(p => p.endsWith(`/${runId}`)), 'a leftover pointer without a live process no longer pins the workspace');

  let other = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example again.' });
  const withPointer = f.life.get(other.id);
  withPointer.data.activeRunId = runId;
  f.life.store.saveDocument(withPointer, 'test.pointer', {});
  other = f.life.reject(other.id, 'Superseded by another increment.');
  assert.equal(other.data.activeRunId, null, 'rejecting releases the pointer');
  assert.equal(f.life.store.documentEvents(other.id).at(-1).data.releasedRunId, runId);
});

test('a reviewed spec merged by the operator closes without a delivery bundle', async (t) => {
  const f = lifecycleFixture(t);
  let d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.' });
  d = await f.life.approveSpec(d.id, d.data.contentHash, 'Test Owner', 'Fixture approval after inspecting scope and criteria.');
  d = await f.life.run(d.id);
  assert.equal(d.data.status, 'awaiting_review');
  gitOf(f.repo, 'update-ref', 'refs/heads/integration', d.data.currentSha);
  const merged = gitOf(f.repo, 'rev-parse', 'refs/heads/integration');
  await assert.rejects(f.life.closeLocal(d.id, 'integration', merged, 'Test Owner', 'Merged by the operator after reading.'), /Review the validated candidate/, 'an unreviewed candidate cannot be closed');
  d = await f.life.review(d.id, d.data.currentSha, 'Test Owner', 'Read the candidate and approved it.');
  assert.equal(d.data.status, 'ready');
  d = await f.life.closeLocal(d.id, 'integration', merged, 'Test Owner', 'Merged by the operator after reading.');
  assert.equal(d.data.status, 'closed');
  assert.equal(d.data.delivery, null, 'no bundle was needed');
  assert.equal(f.life.store.documentEvents(d.id).at(-1).data.delivered, false);
});

// Observed on a real increment: Product put two tests broken by the first task's schema change into a later
// task, or into none, and the first task stopped on a scope amendment. The operator is now told before approving.
test('Product output is annotated with existing tests the task order leaves behind', async (t) => {
  const f = lifecycleFixture(t);
  const spec = oneTask();
  spec.acceptance.push({ id: 'AC-DOC', description: 'The multiplication is documented for readers.', verification: 'Read docs/math.md.' });
  spec.tasks = [
    { ...spec.tasks[0], id: 'CODE', allowedPaths: ['src/math.mjs'], acceptanceIds: ['AC-MATH'], dependsOn: [] },
    { id: 'LATER', title: 'Tests and documentation', description: 'Update the tests and the documentation.', acceptanceIds: ['AC-DOC'], allowedPaths: ['test/math.test.mjs', 'docs/math.md'], dependsOn: ['CODE'], minimumLane: 'fast' },
  ];
  const d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.', proposal: spec });
  const advice = f.life.summary(d).impactAdvice;
  assert.deepEqual(advice.map(a => [a.test, a.changedBy, a.assignedTo]), [['test/math.test.mjs', 'CODE', 'LATER']]);
  assert.ok(f.life.store.documentEvents(d.id).find(e => e.type === 'product.proposed').data.impactAdvice.length === 1);

  const together = oneTask();
  const clean = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.', proposal: together });
  assert.deepEqual(f.life.summary(clean).impactAdvice, [], 'a test in the task that changes its subject raises nothing');
});

// Observed on a real cleanup spec: QA flagged a comment made false in a file outside every task, and the repair
// agent, confined to the approved paths, changed nothing; the spec stopped on NO_CHANGE.
test('a QA repair is told it may reach outside scope through an amendment, and sees what tasks reported', async (t) => {
  const f = lifecycleFixture(t);
  const log = join(f.root, 'repair.log');
  const exampleWorker = new URL('../examples/lifecycle-worker.mjs', import.meta.url).pathname;
  const worker = join(f.root, 'repair-tracing-worker.mjs');
  writeFileSync(worker, `import { readFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { runWorker } = createRequire(import.meta.url)(${JSON.stringify(RUN_WORKER)});
const input = readFileSync(0, 'utf8'); const req = JSON.parse(input);
if (req.protocol === 'agent-pipeline/v2') appendFileSync(${JSON.stringify(log)}, JSON.stringify({ task: req.task.id, description: req.task.description }) + '\\n');
const r = runWorker(${JSON.stringify(exampleWorker)}, input);
if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(r.status ?? 1); }
process.stdout.write(r.stdout);
`);
  const config = { ...f.config, agent: { type: 'command', command: [process.execPath, worker] } };
  let d = await f.life.draft({ repo: f.repo, config, request: 'Implement the approved arithmetic example.' });
  d = await f.life.approveSpec(d.id, d.data.contentHash, 'Test Owner', 'Fixture approval after inspecting scope and criteria.');
  d = await f.life.run(d.id);
  assert.equal(d.data.qaRepairs, 1, 'the fixture QA requested one repair');
  const repair = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(e => e.description.startsWith('Correct the following QA findings'));
  assert.ok(repair, 'the repair request was captured');
  assert.match(repair.description, /explicit scope amendment/);
  assert.match(repair.description, /"taskSummaries":\[\{"taskId":"MATH"/);
});

// Observed on a real cleanup spec: after a framework fix to the repair guidance, `spec retry` replayed the
// failed repair with its frozen description and scope, so the fix could not apply to the spec it was for.
test('a retried attempt is rebuilt from the current state, not replayed frozen', async (t) => {
  const f = lifecycleFixture(t);
  const exampleWorker = new URL('../examples/lifecycle-worker.mjs', import.meta.url).pathname;
  const worker = join(f.root, 'idle-repair-worker.mjs');
  writeFileSync(worker, `import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { runWorker } = createRequire(import.meta.url)(${JSON.stringify(RUN_WORKER)});
const input = readFileSync(0, 'utf8'); const req = JSON.parse(input);
if (req.protocol === 'agent-pipeline/v2' && req.task.description.startsWith('Correct the following QA findings')) {
  console.log(JSON.stringify({ summary: 'Nothing changed: the finding is outside the files I may edit.' }));
  process.exit(0);
}
const r = runWorker(${JSON.stringify(exampleWorker)}, input);
if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(r.status ?? 1); }
process.stdout.write(r.stdout);
`);
  const config = { ...f.config, agent: { type: 'command', command: [process.execPath, worker] } };
  let d = await f.life.draft({ repo: f.repo, config, request: 'Implement the approved arithmetic example.' });
  d = await f.life.approveSpec(d.id, d.data.contentHash, 'Test Owner', 'Fixture approval after inspecting scope and criteria.');
  d = await f.life.run(d.id);
  assert.equal(d.data.error?.code, 'NO_CHANGE', JSON.stringify(d.data.error));
  const failedRun = f.life.pipeline.store.get(d.data.activeRunId);
  assert.ok(!failedRun.task.allowedPaths.includes('docs/extra.md'));

  // The operator approves a scope amendment after the failure.
  const amended = f.life.get(d.id);
  amended.data.scopeAmendments.push({ id: 'AMD-LATER', taskId: 'QA-REPAIR-1', paths: ['docs/extra.md'], reason: 'Commentaire rendu faux hors périmètre.',
    status: 'approved', sourceRunId: failedRun.id, candidateSha: amended.data.currentSha, requestedAt: Date.now(), approvedAt: Date.now(), reviewer: 'Test Owner', note: 'Approuvé.' });
  f.life.store.saveDocument(amended, 'test.scope_amendment', {});

  d = await f.life.retry(d.id, true);
  const replacement = f.life.pipeline.store.get(d.data.activeRunId);
  assert.notEqual(replacement.id, failedRun.id);
  assert.ok(replacement.task.allowedPaths.includes('docs/extra.md'), 'the retried repair carries the amendment approved after the failure');
  assert.match(replacement.task.description, /explicit scope amendment/);
  assert.match(replacement.task.description, /"taskSummaries"/);
  assert.equal(d.data.attempts.at(-1).kind, 'qa-repair');
});
