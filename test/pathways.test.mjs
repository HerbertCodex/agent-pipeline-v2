import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, oneTask, withSecurity } from './lifecycle-helpers.mjs';
import { specSchema, specHash } from '../dist/lifecycle/contracts.js';
import { briefSpecSchema, expandBrief, requiresQa, selectPath, targetedQaContext } from '../dist/lifecycle/pathways.js';
import { validateConfig } from '../dist/domain/contracts.js';
import { assessSecurity } from '../dist/security/owasp.js';
import { roleAgent } from '../dist/adapters/routing.js';

function worker(f, request) {
  const spec = specSchema.parse(withSecurity(oneTask(), request));
  const brief = structuredClone(spec); delete brief.minimumLane; brief.tasks.forEach(t => delete t.minimumLane);
  const file = join(f.root, 'adaptive-worker.mjs');
  writeFileSync(file, `import {readFileSync,writeFileSync} from 'node:fs';
const req=JSON.parse(readFileSync(0,'utf8'));
if(req.context?.mode==='architecture-decision') console.log(JSON.stringify({summary:'Keep the existing arithmetic boundary.',decisions:[{decision:'Extend the module.',rationale:'The operation belongs here.',alternatives:['New service'],tradeoffs:['Shared module'],reconsiderWhen:['Independent deployment needed']}],inspection:[{path:'src/math.mjs',finding:'Existing arithmetic functions.'}]}));
else if(req.role==='product') console.log(JSON.stringify(req.context?.mode==='product-brief'?${JSON.stringify(brief)}:${JSON.stringify(spec)}));
else if(req.role==='qa') console.log(JSON.stringify({candidateSha:req.context.candidateSha,verdict:'pass',summary:'Fixture review',criteria:req.context.spec.acceptance.map(c=>({id:c.id,status:'pass',evidence:'Observed fixture gates.'})),securityChecks:req.context.spec.security.requirements.map(r=>({requirementId:r.id,status:'pass',evidence:'Fixture contract review.'})),findings:[],observations:[]}));
else {writeFileSync('src/math.mjs','export const add=(a,b)=>a+b; export const multiply=(a,b)=>a*b;\\n'); console.log(JSON.stringify({summary:'Implemented multiplication in existing module.'}));}
`);
  const agent = { type: 'command', command: [process.execPath, file], timeoutMs: 10000 };
  return { ...f.config, agent, roles: { product: agent, qa: agent }, workflow: { ...f.config.workflow, planningMode: 'adaptive' } };
}
const invocations = (f, d) => [
  ...f.life.store.documentEvents(d.id, ['invocation.started']),
  ...d.data.attempts.flatMap(a => f.life.pipeline.store.events(a.runId, ['invocation.started'])),
];

test('compact path makes one implementation call and keeps final checks without model QA', async t => {
  const f = fixture(t); const request = 'Add multiplication in the existing arithmetic module.';
  const config = worker(f, request);
  const task = { id: 'MATH', title: 'Add multiplication', description: request, acceptance: ['multiply(2,3) returns 6'], allowedPaths: ['src/math.mjs'] };
  let d = await f.life.draft({ repo: f.repo, config, request, compactTask: task });
  assert.equal(d.data.executionPath, 'compact');
  d = await f.life.approveSpec(d.id, f.life.summary(d).hash, 'Test owner', 'Approve bounded fixture task.');
  d = await f.life.run(d.id);
  assert.equal(d.data.status, 'awaiting_review', JSON.stringify(d.data.error));
  assert.equal(d.data.qa, null);
  assert.deepEqual(invocations(f, d).map(e => e.data.role), ['implementer']);
  assert.ok(f.life.pipeline.store.get(d.data.finalRunId).receipts.every(r => ['passed','cached'].includes(r.status)));
  d = await f.life.review(d.id, d.data.currentSha, 'Test reviewer', 'Reviewed the compact diff and passing checks.');
  assert.equal(d.data.status, 'ready', JSON.stringify(d.data.error));
  assert.equal((await f.life.publicationCandidate(d.id)).candidateSha, d.data.currentSha);
});

test('standard path uses short Product and independent targeted QA', async t => {
  const f = fixture(t); const request = 'Add multiplication in the existing arithmetic module.';
  let d = await f.life.draft({ repo: f.repo, config: worker(f, request), request });
  assert.equal(d.data.executionPath, 'standard');
  assert.ok(f.life.store.documentEvents(d.id, ['role.started']).some(e => e.data.mode === 'product-brief'));
  d = await f.life.approveSpec(d.id, f.life.summary(d).hash, 'Test owner', 'Approve standard fixture task.');
  d = await f.life.run(d.id);
  assert.equal(d.data.status, 'awaiting_review', JSON.stringify(d.data.error));
  assert.equal(d.data.qa.report.verdict, 'pass');
  assert.ok(f.life.store.documentEvents(d.id, ['qa.context_selected']).some(e => e.data.mode === 'targeted' && e.data.completeDiff));
});

test('structural path records architecture before planning and enforces high validation', async t => {
  const f = fixture(t); const request = 'Restructure the architecture of the arithmetic module and add multiplication.';
  let d = await f.life.draft({ repo: f.repo, config: worker(f, request), request });
  assert.equal(d.data.executionPath, 'structural'); assert.ok(d.data.architecture);
  assert.equal(d.data.content.minimumLane, 'high');
  assert.ok(d.data.content.tasks.every(t => t.minimumLane === 'high'));
  const modes = f.life.store.documentEvents(d.id, ['role.started']).map(e => e.data.mode);
  assert.equal(modes[0], 'architecture-decision');
  assert.notEqual(specHash(d.data), specHash({ ...d.data, architecture: null }));
  d = await f.life.approveSpec(d.id, f.life.summary(d).hash, 'Test owner', 'Approve architecture and structural fixture.');
  d = await f.life.run(d.id);
  assert.equal(d.data.status, 'awaiting_review', JSON.stringify(d.data.error));
  assert.equal(f.life.pipeline.store.get(d.data.finalRunId).risk.lane, 'high');
  assert.ok(f.life.store.documentEvents(d.id, ['qa.context_selected']).some(e => e.data.mode === 'full'));
});

test('failed structural refinement retains a readable previous spec and architecture hash', async t => {
  const f = fixture(t); const request = 'Add multiplication in the existing arithmetic module.';
  const config = worker(f, request);
  const d = await f.life.draft({ repo: f.repo, config, request });
  const { readFileSync } = await import('node:fs');
  const file = config.agent.command[1];
  const source = readFileSync(file, 'utf8');
  writeFileSync(file, source.replace("if(req.context?.mode==='architecture-decision')", "if(req.role==='product' && req.context?.mode!=='architecture-decision') process.exit(1);\nif(req.context?.mode==='architecture-decision')"));
  await assert.rejects(() => f.life.refine(d.id, 'Change the architecture of the arithmetic module.'), /failed/);
  const retained = f.life.get(d.id);
  assert.equal(retained.data.executionPath, 'structural');
  assert.ok(retained.data.architecture);
  assert.equal(retained.data.contentHash, specHash(retained.data));
  assert.equal(retained.data.content.title, d.data.content.title);
  await assert.rejects(() => f.life.approveSpec(d.id, f.life.summary(retained).hash, 'Test owner', 'Cannot approve an unfinished refinement.'), /failed planning/);
});

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

test('quick/deep role profiles are explicit, provider-specific and preserve limits', () => {
  const config = validateConfig({schemaVersion:1,executionMode:'local-trusted',environment:{id:'test'},agent:{type:'claude',maxTurns:20},gates:[{id:'test',command:['true']}],
    roleProfiles:[{provider:'claude',role:'implementer',quick:{model:'quick-pinned',effort:'low'},deep:{model:'deep-pinned',effort:'high'}}]});
  assert.equal(roleAgent(config,'implementer','standard').model,'quick-pinned');
  assert.equal(roleAgent(config,'implementer','high').model,'deep-pinned');
  assert.equal(roleAgent(config,'implementer','high').maxTurns,20);
  assert.throws(()=>validateConfig({...config,roleProfiles:[...config.roleProfiles,...config.roleProfiles]}),/Duplicate role profile/);
});
