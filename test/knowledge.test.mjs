import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { catalog, guidanceFor, installedAssets, readRole, asset } from '../dist/knowledge/catalog.js';
import { skillNames, roleNames, skillsSchema } from '../dist/domain/knowledge.js';
import { validateConfig } from '../dist/domain/contracts.js';
import { providerProfile } from '../dist/adapters/providers.js';
import { planInstallation, applyInstallation } from '../dist/lifecycle/onboarding.js';
import { fixture as lifeFixture, git } from './lifecycle-helpers.mjs';
import { fixture, rawConfig } from './helpers.mjs';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const call = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000 });
const full = (extra = {}) => skillsSchema.parse({ enabled: [...skillNames], projectType: 'fullstack', ...extra });
for (const role of roleNames) test(`runtime role ${role} is the shipped Markdown source`, () => {
  const expected = readFileSync(new URL(`../roles/${role}.md`, import.meta.url), 'utf8');
  assert.equal(readRole(role).instructions, expected);
  assert.equal(guidanceFor(role, full()).role.instructions, expected);
  assert.match(readRole(role).sha256, /^[a-f0-9]{64}$/);
});
for (const id of skillNames) test(`portable skill ${id} has valid metadata and real relative references`, () => {
  const s = catalog().find(s => s.id === id); assert.ok(s); assert.match(s.instructions, /^---\nname: /);
  assert.match(s.instructions, /description:/); assert.ok(s.resources.length >= 4);
  for (const link of s.instructions.matchAll(/\]\(((?:references|assets)\/[^)]+)\)/g)) {
    assert.ok(s.resources.some(r => r.path === `skills/${id}/${link[1]}`));
  }
  assert.match(s.bundleHash, /^[a-f0-9]{64}$/);
});
test('skills remain disabled for old configs; duplicate and unknown IDs refused', () => {
  assert.deepEqual(validateConfig(rawConfig()).skills.enabled, []);
  assert.throws(() => validateConfig(rawConfig({ skills: { enabled: ['invented'] } })));
  assert.throws(() => validateConfig(rawConfig({ skills: { enabled: ['tdd','tdd'] } })), /Duplicate/);
});
test('routing is deterministic and skips UI on backend/unknown and all skills for Setup', () => {
  const g = guidanceFor('implementer', full(), 'Refactor architecture, screen UI and design');
  assert.equal(g.skills.length, 6); assert.deepEqual(g, guidanceFor('implementer', full(), 'Refactor architecture, screen UI and design'));
  assert.equal(guidanceFor('setup', full(), 'refactor UI').skills.length, 0);
  for (const projectType of ['backend','unknown','library']) assert.ok(!guidanceFor('qa',full({projectType}),'UI screen').skills.some(s=>s.id==='ui-design'));
  assert.ok(guidanceFor('product', full(), 'une page avec formulaire').skills.some(s=>s.id==='ui-design'));
  assert.ok(!guidanceFor('implementer', full(), 'fix integer addition').skills.some(s=>s.id==='design-patterns'));
});
test('context budget never silently truncates a skill and records skipped reasons', () => {
  const g = guidanceFor('implementer', full({ maxContextBytes: 1024 }), 'refactor architecture UI');
  assert.ok(g.bytes <= 1024); assert.ok(g.skipped.some(s=>s.reason==='context-budget'));
  for (const s of g.skills) assert.equal(s.instructions,catalog().find(x=>x.id===s.id).instructions);
});
test('asset loader rejects escapes and unknown role', () => {
  for (const p of ['../package.json','/etc/passwd','roles/../../x','roles\\qa.md']) assert.throws(()=>asset(p));
  assert.throws(()=>readRole('unknown'));
});
test('implementation actually receives the selected instructions and journals their hashes', async t => {
  const f = fixture(t); const code = `import {readFileSync,writeFileSync} from 'node:fs';import assert from 'node:assert/strict';
  const r=JSON.parse(readFileSync(0,'utf8'));assert.equal(r.guidance.role.id,'implementer');assert.ok(r.guidance.skills.some(s=>s.id==='tdd'));assert.ok(r.guidance.role.instructions.includes('Do not modify controller state'));
  writeFileSync('src/math.mjs','export const add=(a,b)=>a+b;\\n');console.log(JSON.stringify({summary:'Validated injected guidance fixture, not a model.'}));`;
  const run = await f.pipeline.start({repo:f.repo,task:f.task,config:{...f.config,skills:full(),agent:{type:'command',command:[process.execPath,'--input-type=module','-e',code]}}});
  assert.equal(run.state,'awaiting_review',JSON.stringify(run.error));
  const e=f.pipeline.store.events(run.id).find(e=>e.type==='agent.guidance');assert.ok(e);assert.ok(e.data.skills.some(s=>s.id==='tdd'));
});
test('onboarding copies exact roles, skills and references and preserves CLAUDE.md', async t => {
  const f=lifeFixture(t);writeFileSync(join(f.repo,'CLAUDE.md'),'# Existing Claude instructions\nKeep me.\n');git(f.repo,'add','.');git(f.repo,'commit','-qm','Claude guide');
  const config={...f.config,agent:providerProfile('claude'),roles:{product:null,qa:null},skills:full()};
  const plan=await planInstallation(f.life.store,f.repo,{config});
  assert.ok(plan.data.files.some(f=>f.path==='.agent-pipeline/skills/tdd/SKILL.md'));
  await applyInstallation(f.life.store,plan.id,plan.data.hash,'Test','Explicit fixture review.',true);
  for(const a of installedAssets(full())) assert.equal(readFileSync(join(f.repo,a.path),'utf8'),a.content);
  assert.match(readFileSync(join(f.repo,'CLAUDE.md'),'utf8'),/Keep me/);
  const result=call('inspect','--repo',f.repo);assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);
  assert.equal(report.drift.length,0);assert.equal(report.roles.find(r=>r.role==='implementer').provider,'claude');
  writeFileSync(join(f.repo,'.agent-pipeline/roles/qa.md'),'Tampered guide');
  assert.ok(JSON.parse(call('inspect','--repo',f.repo).stdout).drift.some(x=>x.status==='different-from-package'));
});
test('CLI discovery works without a provider and refuses invented names', () => {
  for (const args of [['roles'],['skills','list'],['providers'],['roles','product'],['skills','show','tdd']]) assert.equal(call(...args).status,0);
  assert.equal(call('roles','unknown').status,1);assert.equal(call('skills','show','../../etc/passwd').status,1);
  const providers=JSON.parse(call('providers').stdout).providers;assert.equal(providers.length,3);assert.ok(providers.every(p=>p.authenticatedPilot!=='passed'));
});
test('CLI --provider claude selects Claude without executing it', async t => {
  const f=lifeFixture(t);const result=call('onboard','--repo',f.repo,'--provider','claude','--state-dir',f.state);
  assert.equal(result.status,0,result.stderr);const plan=JSON.parse(result.stdout);assert.equal(plan.config.agent.type,'claude');assert.equal(plan.config.skills.enabled.length,6);
  assert.ok(plan.files.some(f=>f.path==='CLAUDE.md'));assert.ok(!plan.config.agent.passEnv.includes('CODEX_API_KEY'));
  assert.equal(call('onboard','--repo',f.repo,'--provider','invented','--state-dir',f.state).status,1);
  assert.equal(call('onboard','--repo',f.repo,'--provider','claude','--agent','foo','--state-dir',f.state).status,1);
});
test('inspection never executes a configured provider', async t => {
  const f=fixture(t);const executable=join(f.root,'do-not-run');const marker=join(f.root,'called');
  writeFileSync(executable,`#!/bin/sh\ntouch '${marker}'\n`);chmodSync(executable,0o700);
  writeFileSync(join(f.repo,'pipeline.v2.json'),JSON.stringify({...f.config,agent:{type:'claude',command:[executable]}}));
  const report=JSON.parse(call('inspect','--repo',f.repo).stdout);assert.equal(report.roles[0].local.available,true);
  assert.throws(()=>readFileSync(marker));
});
test('inspect refuses to follow a symlinked generated guide', async t => {
  const f=lifeFixture(t);const plan=await planInstallation(f.life.store,f.repo,{config:f.config});await applyInstallation(f.life.store,plan.id,plan.data.hash,'Test','Fixture permission.');
  const fs=await import('node:fs');fs.unlinkSync(join(f.repo,'.agent-pipeline/roles/product.md'));symlinkSync('/etc/passwd',join(f.repo,'.agent-pipeline/roles/product.md'));
  const report=JSON.parse(call('inspect','--repo',f.repo).stdout);assert.ok(report.drift.some(x=>x.status==='symlink-refused'));
});
