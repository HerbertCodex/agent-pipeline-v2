// A mockup is displayed content: it may quote markup, paths and URLs as text without loading anything.
// It may also show the project's own typography, and a later increment must extend one visual direction
// instead of inventing a new one. Abandoned lifecycle documents must be removable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, oneTask, git, approved, withSecurity } from './lifecycle-helpers.mjs';
import { scanTags } from '../dist/lifecycle/service.js';
import { specHash } from '../dist/lifecycle/contracts.js';
import { planPurge, purgeDocuments, purgeProtections } from '../dist/lifecycle/maintenance.js';

const RUN_WORKER = new URL('./support/run-worker.cjs', import.meta.url).pathname;
const exampleWorker = fileURLToPath(new URL('../examples/lifecycle-worker.mjs', import.meta.url));
const readLog = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

/** Worker delegating to the fixture worker, then rewriting only the design answer. */
function designWorker(root, name, patch) {
  const path = join(root, `${name}.mjs`); const log = join(root, `${name}.log`);
  writeFileSync(path, `import { readFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { runWorker } = createRequire(import.meta.url)(${JSON.stringify(RUN_WORKER)});
const input = readFileSync(0, 'utf8'); const req = JSON.parse(input);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ role: req.role ?? req.protocol, mode: req.context?.mode ?? null,
  repair: req.repair?.previousError?.code ?? null,
  established: req.context?.establishedDesign ? req.context.establishedDesign.specId : null,
  instructions: req.context?.instructions?.length ?? 0 }) + '\\n');
const r = runWorker(${JSON.stringify(exampleWorker)}, input);
if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(r.status ?? 1); }
if (req.protocol === 'agent-pipeline/v2') { process.stdout.write(r.stdout); process.exit(0); }
const out = JSON.parse(r.stdout);
if (req.role === 'product' && req.context?.mode !== 'design-proposal')
  out.experience = { uiImpact: 'major', surfaces: ['Arithmetic screen'], rationale: 'The arithmetic screen changes for users.' };
if (req.role === 'product' && req.context?.mode === 'design-proposal') {
  out.taskScopes = [{ taskId: 'MATH', screenIds: [out.screens[0].id] }];
  ${patch}
}
console.log(JSON.stringify(out));
`);
  const agent = { type: 'command', command: [process.execPath, path] };
  return { agent, roles: { product: agent, qa: agent }, log };
}

const REQUEST = 'Create a distinctive arithmetic dashboard.';
const NEXT_REQUEST = 'Add a second arithmetic screen to the same dashboard.';
const frontend = { skills: { enabled: ['ui-design'], projectType: 'frontend', maxContextBytes: 16000 } };
function uiSpec(request) {
  const s = oneTask();
  s.title = 'Arithmetic dashboard';
  s.problem = 'The frontend needs a clear arithmetic dashboard before implementation begins.';
  s.scope = ['Design and implement the arithmetic dashboard.'];
  s.tasks[0] = { ...s.tasks[0], title: 'Implement dashboard UI', description: 'Implement the approved arithmetic screen.', allowedPaths: ['src/math.mjs'] };
  s.experience = { uiImpact: 'major', surfaces: ['Arithmetic dashboard'], rationale: 'The task changes the primary user-facing screen.' };
  return withSecurity(s, request, 'frontend');
}

test('tag scanning reads elements, not prose, and a quoted ">" cannot hide an attribute', () => {
  const tags = scanTags('<p title="a > b" data-x=\'1\'>3 &lt; 4 and src= in text</p><img alt="x" onclick="steal()">');
  assert.deepEqual(tags.map(t => t.name), ['p', 'p', 'img'], 'closing tags are scanned too');
  assert.deepEqual(tags[0].attributes.map(a => a.name), ['title', 'data-x']);
  assert.equal(tags[0].attributes[0].value, 'a > b', 'a quoted ">" does not end the tag');
  assert.deepEqual(tags[2].attributes.map(a => a.name), ['alt', 'onclick']);
  assert.equal(scanTags('temperature < 5 degrees and a > b').length, 0);
});

test('a mockup may show markup and paths as text, and carry the project fonts inline', async (t) => {
  const f = fixture(t, frontend);
  mkdirSync(join(f.repo, 'static/fonts'), { recursive: true });
  writeFileSync(join(f.repo, 'static/fonts/serif.woff2'), Buffer.from('wOF2fixture-font-bytes'));
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'Add the project font');
  const w = designWorker(f.root, 'assets', `
  out.assets = [{ id: 'serif', path: 'static/fonts/serif.woff2', reason: 'The project typeface.' }];
  out.css += '@font-face{font-family:Fixture;src:url(asset:serif) format("woff2")}h1{font-family:Fixture,serif}';
  out.screens[0].bodyHtml += '<section><h2>Code sample</h2><pre>&lt;img src="/logo.png" alt=""&gt;</pre><p>Ecrire src= dans le texte reste du texte, comme https://exemple.fr</p></section>';`);
  const doc = await f.life.draft({ repo: f.repo, config: { ...f.config, agent: w.agent, roles: w.roles }, request: REQUEST, proposal: uiSpec(REQUEST) });
  assert.ok(doc.data.design, 'a frontend spec gets a design');
  assert.deepEqual(readLog(w.log).filter(x => x.mode === 'design-proposal').map(x => x.repair), [null], 'legitimate text must not trigger a repair');
  const preview = readFileSync(doc.data.design.screenPaths[0], 'utf8');
  assert.match(preview, /url\("data:font\/woff2;base64,[A-Za-z0-9+/=]+"\)/, 'the font is inlined into the preview');
  assert.match(preview, /font-src data:/, 'the preview CSP allows the inlined font and nothing else');
  assert.doesNotMatch(preview, /url\(asset:/);
  assert.deepEqual(doc.data.design.inlinedAssets.map(a => a.id), ['serif']);
  assert.match(doc.data.design.proposal.css, /url\(asset:serif\)/, 'the stored proposal keeps the reference, not the bytes');
  assert.match(readFileSync(doc.data.design.indexPath, 'utf8'), /serif \(static\/fonts\/serif\.woff2\)/);
});

test('a mockup cannot load anything the operator did not put in the repository', async (t) => {
  for (const [name, patch, expected] of [
    ['remote-font', `out.css += '@font-face{font-family:X;src:url("https://fonts.example.com/x.woff2")}';`, /url\(https:\/\/fonts\.example\.com/],
    ['undeclared', `out.css += 'h1{background:url(asset:missing)}';`, /not declared in assets/],
    ['import', `out.css = '@import "theme.css";' + out.css;`, /import stylesheets/],
    ['image', `out.screens[0].bodyHtml += '<img src="/logo.png" alt="">';`, /Attribute src/],
    ['handler', `out.screens[0].bodyHtml += '<button data-x="a > b" onclick="steal()">Go</button>';`, /Event handler onclick/],
    ['remote-link', `out.screens[0].bodyHtml += '<a href="https://exemple.fr/tracker">Suite</a>';`, /Remote href/],
  ]) {
    const f = fixture(t, frontend);
    const w = designWorker(f.root, name, patch);
    await assert.rejects(
      f.life.draft({ repo: f.repo, config: { ...f.config, agent: w.agent, roles: w.roles }, request: REQUEST, proposal: uiSpec(REQUEST) }),
      error => { assert.match(error.message, expected); return true; },
      `${name} must be refused`);
  }
});

test('a later spec extends the visual direction already approved for the repository', async (t) => {
  const f = fixture(t, frontend);
  const w = designWorker(f.root, 'continuity', '');
  const config = { ...f.config, agent: w.agent, roles: w.roles };
  let first = await f.life.draft({ repo: f.repo, config, request: REQUEST, proposal: uiSpec(REQUEST) });
  const designs = () => readLog(w.log).filter(x => x.mode === 'design-proposal');
  assert.equal(designs().at(-1).established, null, 'the first design has nothing to continue');
  const beforeApproval = designs().at(-1).instructions;
  first = await f.life.approveSpec(first.id, f.life.summary(first).hash, 'Test Owner', 'Reviewed the specification and visual mockup together.');
  const second = await f.life.draft({ repo: f.repo, config, request: NEXT_REQUEST, proposal: uiSpec(NEXT_REQUEST) });
  assert.equal(designs().at(-1).established, first.id, 'the second design receives the approved direction');
  assert.ok(designs().at(-1).instructions > beforeApproval, 'and the instructions that tell it to extend rather than redraw');
  assert.equal(second.data.design.reusedFrom, first.id);
  assert.match(readFileSync(second.data.design.indexPath, 'utf8'), new RegExp(`Continues the visual direction approved for spec ${first.id}`));
});

test('abandoned lifecycle documents can be purged with their runs and workspaces, active ones cannot', async (t) => {
  const f = fixture(t);
  const kept = await approved(f);
  const dropped = f.life.reject((await f.life.draft({ repo: f.repo, config: f.config, request: 'Abandon this one.' })).id, 'Superseded by another increment.');
  assert.equal(dropped.data.status, 'rejected');

  assert.deepEqual(planPurge(f.life).map(x => x.id), [], 'a document is never purged on age alone before the delay');
  const plan = planPurge(f.life, { olderThanDays: 0 });
  assert.deepEqual(plan.map(x => x.id), [dropped.id], 'only the terminal document is proposed');
  assert.equal(plan[0].reason, 'rejected spec');
  assert.deepEqual(planPurge(f.life, { ids: [kept.id] }).map(x => x.id), [], 'an explicit id does not lift the state guard');

  const result = await purgeDocuments(f.life, plan);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.purged.map(x => x.id), [dropped.id]);
  assert.throws(() => f.life.get(dropped.id), /Unknown spec/);
  assert.equal(f.life.get(kept.id).id, kept.id, 'the purge never touches another document');
  for (const runId of plan[0].runIds) assert.throws(() => f.life.pipeline.store.get(runId), /Unknown run/);
  for (const workspace of plan[0].workspaces) assert.equal(existsSync(workspace.path), false);
});

// Observed while piloting: a spec with no questions but one no-regression criterion attached to no task
// was accepted as a draft and refused 16 minutes later, at approval, by SPEC_COVERAGE. A draft that asks
// nothing claims to be complete, so the structural rules must hold immediately — and then the bounded
// output repair can fix them in one extra call.
test('a spec that asks no question must already cover every criterion with a task', async (t) => {
  const f = fixture(t);
  const w = designWorker(f.root, 'coverage', '');
  const orphan = (spec) => {
    spec.acceptance.push({ id: 'AC-AUTH-UNCHANGED', description: 'The existing arithmetic behaviour is unchanged by this increment.', verification: 'Inspect the diff: no existing arithmetic file is touched.' });
    return spec;
  };
  await assert.rejects(
    f.life.draft({ repo: f.repo, config: { ...f.config, agent: w.agent, roles: w.roles }, request: 'Implement the approved arithmetic example.', proposal: orphan(oneTask()) }),
    error => { assert.match(error.message, /AC-AUTH-UNCHANGED/); return true; },
    'the uncovered criterion must be reported at draft time, not at approval');

  const attached = orphan(oneTask());
  attached.tasks[0].acceptanceIds.push('AC-AUTH-UNCHANGED');
  const doc = await f.life.draft({ repo: f.repo, config: { ...f.config, agent: w.agent, roles: w.roles }, request: 'Implement the approved arithmetic example.', proposal: attached });
  assert.equal(doc.data.status, 'draft');

  // A rule added later must never make an already stored document unreadable: the first version of this
  // fix validated readiness on load, and every spec written before it stopped opening.
  const stored = f.life.get(doc.id);
  stored.data.content.acceptance.push({ id: 'AC-LEGACY-ORPHAN', description: 'Criterion written before the rule existed.', verification: 'Inspect the diff.' });
  stored.data.contentHash = specHash(stored.data);
  f.life.store.saveDocument(stored, 'test.legacy_content', {});
  assert.equal(f.life.get(doc.id).data.content.acceptance.at(-1).id, 'AC-LEGACY-ORPHAN', 'an older stored spec still loads');

  // A draft that does ask a question is still allowed to be incomplete.
  const asking = orphan(oneTask());
  asking.questions.push({ id: 'Q-1', question: 'Faut-il conserver la signature actuelle ?' });
  const open = await f.life.draft({ repo: f.repo, config: { ...f.config, agent: w.agent, roles: w.roles }, request: 'Implement the approved arithmetic example.', proposal: asking });
  assert.equal(open.data.content.questions.length, 1);
});

// A purge must not delete the spec whose approved visual direction the next design continues.
test('prune keeps the spec holding the visual direction the next design continues', async (t) => {
  const f = fixture(t, frontend);
  const w = designWorker(f.root, 'reference', '');
  const config = { ...f.config, agent: w.agent, roles: w.roles };
  let reference = await f.life.draft({ repo: f.repo, config, request: REQUEST, proposal: uiSpec(REQUEST) });
  reference = await f.life.approveSpec(reference.id, f.life.summary(reference).hash, 'Test Owner', 'Reviewed the specification and visual mockup together.');
  const closed = f.life.get(reference.id);
  closed.data.status = 'closed';
  f.life.store.saveDocument(closed, 'test.closed', {});

  assert.deepEqual(purgeProtections(f.life).map(x => x.id), [reference.id]);
  assert.ok(!planPurge(f.life, { olderThanDays: 0 }).some(x => x.id === reference.id), 'the design reference is never proposed');
  assert.ok(!planPurge(f.life, { ids: [reference.id] }).length, 'not even when named explicitly');
});
