// The design chain must carry the approved mockup all the way: the Implementer receives its markup, QA
// compares against it, and the preview files survive the review workspace. An external audit reproduced the
// opposite on every link, and a green suite did not see it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, oneTask, withSecurity } from './lifecycle-helpers.mjs';

const exampleWorker = fileURLToPath(new URL('../examples/lifecycle-worker.mjs', import.meta.url));
const readLog = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const MARKER = 'x-approved-mockup-marker';

/** Records every request the roles receive, and marks the mockup so it can be traced downstream. */
function tracingWorker(root) {
  const path = join(root, 'tracing-worker.mjs'); const log = join(root, 'tracing.log');
  writeFileSync(path, `import { readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const input = readFileSync(0, 'utf8'); const req = JSON.parse(input);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  role: req.role ?? req.protocol, mode: req.context?.mode ?? null, task: req.task?.id ?? null,
  taskSeesMockup: req.task ? req.task.description.includes(${JSON.stringify(MARKER)}) : null,
  qaSeesMockup: req.role === 'qa' ? JSON.stringify(req.context?.approvedDesign ?? null).includes(${JSON.stringify(MARKER)}) : null,
}) + '\\n');
const r = spawnSync(process.execPath, [${JSON.stringify(exampleWorker)}], { input, encoding: 'utf8' });
if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(r.status ?? 1); }
if (req.protocol === 'agent-pipeline/v2') { process.stdout.write(r.stdout); process.exit(0); }
const out = JSON.parse(r.stdout);
if (req.role === 'product' && req.context?.mode !== 'design-proposal')
  out.experience = { uiImpact: 'major', surfaces: ['Arithmetic screen'], rationale: 'The arithmetic screen changes for users.' };
if (req.role === 'product' && req.context?.mode === 'design-proposal') {
  out.screens[0].bodyHtml = '<main class="' + ${JSON.stringify(MARKER)} + '"><h1>Multiply</h1></main>';
  out.taskScopes = [{ taskId: 'MATH', screenIds: [out.screens[0].id] }];
}
if (req.role === 'qa') {
  // This spec has no documentation task, which the fixture QA would fail on; the point here is the design chain.
  out.verdict = 'pass';
  out.summary = 'Fixture review of the arithmetic screen.';
  out.findings = [];
  out.criteria = req.context.spec.acceptance.map(a => ({ id: a.id, status: 'pass', evidence: 'Fixture inspection.' }));
  out.securityChecks = req.context.spec.security.requirements.map(x => ({ requirementId: x.id, status: out.verdict === 'pass' ? 'pass' : 'unknown', evidence: 'Fixture inspection.' }));
  out.criteria = out.criteria.map(c => c.id === 'AC-SEC' ? { ...c, status: out.verdict === 'pass' ? 'pass' : 'unknown' } : c);
}
console.log(JSON.stringify(out));
`);
  const agent = { type: 'command', command: [process.execPath, path] };
  return { agent, roles: { product: agent, qa: agent }, log };
}

const REQUEST = 'Create a distinctive arithmetic dashboard.';
function uiSpec() {
  const s = oneTask();
  s.title = 'Arithmetic dashboard';
  s.problem = 'The frontend needs a clear arithmetic dashboard before implementation begins.';
  s.scope = ['Design and implement the arithmetic dashboard.'];
  s.tasks[0] = { ...s.tasks[0], title: 'Implement dashboard UI', description: 'Implement the approved arithmetic screen.' };
  s.experience = { uiImpact: 'major', surfaces: ['Arithmetic dashboard'], rationale: 'The task changes the primary user-facing screen.' };
  return withSecurity(s, REQUEST, 'frontend');
}

test('the approved mockup reaches the Implementer and QA, and survives the review workspace', async (t) => {
  const f = fixture(t, { skills: { enabled: ['ui-design'], projectType: 'frontend', maxContextBytes: 16000 } });
  const w = tracingWorker(f.root);
  const config = { ...f.config, agent: w.agent, roles: w.roles };
  let d = await f.life.draft({ repo: f.repo, config, request: REQUEST, proposal: uiSpec() });
  assert.ok(d.data.design, 'a frontend spec gets a design');
  const previews = d.data.design.screenPaths;
  assert.ok(previews.every(existsSync), 'previews exist before approval');

  d = await f.life.approveSpec(d.id, f.life.summary(d).hash, 'Test Owner', 'Reviewed the specification and visual mockup together.');
  d = await f.life.run(d.id);
  assert.ok(['ready', 'awaiting_review'].includes(d.data.status), JSON.stringify(d.data.error));

  const log = readLog(w.log);
  const implementer = log.filter(x => x.task && x.taskSeesMockup !== null);
  assert.ok(implementer.length > 0, 'the Implementer was invoked');
  assert.ok(implementer.some(x => x.taskSeesMockup), 'the Implementer receives the approved markup, not only a paraphrase');
  const qa = log.filter(x => x.role === 'qa');
  assert.ok(qa.length > 0 && qa.every(x => x.qaSeesMockup), 'QA receives the approved design');

  assert.ok(previews.every(existsSync), 'the review workspace must not delete the approved previews');
  assert.ok(existsSync(d.data.design.indexPath));
  assert.match(readFileSync(d.data.review.reviewPath, 'utf8'), /Approved design:/, 'the reviewer is pointed at the mockup');
  assert.ok(existsSync(d.data.review.candidateDirectory));
});

test('a replaced QA report regenerates the review documents on the same candidate', async (t) => {
  const f = fixture(t);
  let d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.' });
  d = await f.life.approveSpec(d.id, d.data.contentHash, 'Test Owner', 'Fixture approval after inspecting scope and criteria.');
  d = await f.life.run(d.id);
  const first = readFileSync(d.data.review.qaPath, 'utf8');
  const bundle = d.data.review.bundleHash;
  assert.ok(bundle, 'the review records the identity of what it describes');

  const replaced = { ...d.data.qa.report, summary: 'Second QA pass: unchanged candidate, different assessment.',
    observations: ['La relecture a été refaite sur le même candidat.'] };
  d = await f.life.importQa(d.id, replaced);
  d = await f.life.run(d.id);
  const second = readFileSync(d.data.review.qaPath, 'utf8');
  assert.notEqual(second, first, 'QA.md must follow the report it documents');
  assert.match(second, /Second QA pass/);
  assert.notEqual(d.data.review.bundleHash, bundle);
  assert.ok(existsSync(d.data.review.candidateDirectory), 'the candidate worktree is reused, not rebuilt for nothing');
});
