import {test} from 'node:test';
import assert from 'node:assert/strict';
import { taskSchema,configSchema,agentOutputSchema,transition } from '../dist/domain/contracts.js';
import { hash,canonical } from '../dist/domain/hash.js';
import { matches,validRelativePath,classify,planGates,assertScope,validateDag,requiredApprovals } from '../dist/policy/policy.js';
import { cfg,task,rawConfig,baseTask } from './helpers.mjs';

test('task parsing supplies defaults and clones arrays',()=>{
  const a=taskSchema.parse(baseTask);assert.equal(a.minimumLane,'fast');a.acceptance.push('extra');assert.equal(baseTask.acceptance.length,2);
});
for (const [name,patch] of [
  ['empty description',{description:''}],['missing acceptance',{acceptance:[]}],['empty scope',{allowedPaths:[]}],
  ['unknown key',{approved:true}],['invalid id',{id:'../evil'}],['invalid lane',{minimumLane:'none'}],
]) test(`task refuses ${name}`,()=>assert.throws(()=>taskSchema.parse({...baseTask,...patch})));
for (const [name,patch] of [
  ['missing local-trusted acknowledgement',{executionMode:'sandbox'}],['empty gates',{gates:[]}],
  ['zero concurrency',{concurrency:0}],['unbounded repairs',{maxRepairAttempts:99}],
  ['shell string',{agent:{type:'command',command:'echo hello'}}],
  ['unknown permission bypass',{allowUnsafe:true}],
  ['unknown environment keys',{environment:{id:'env',SECRET:'plaintext'}}],
]) test(`config refuses ${name}`,()=>assert.throws(()=>cfg(patch)));
test('empty command agent rejected',()=>assert.throws(()=>cfg({agent:{type:'command'}}),/argv/));
test('duplicate gate ids rejected',()=>assert.throws(()=>cfg({gates:[{id:'a',command:['true']},{id:'a',command:['true']}]}),/Duplicate/));
test('unknown dependency rejected',()=>assert.throws(()=>cfg({gates:[{id:'a',command:['true'],dependsOn:['missing']}]}),/Unknown/));
test('cycle rejected before executing any gate',()=>assert.throws(()=>validateDag(cfg({gates:[{id:'a',command:['true'],dependsOn:['b']},{id:'b',command:['true'],dependsOn:['a']}]}).gates),/cycle/));
test('agent cannot submit an authoritative verdict',()=>assert.throws(()=>agentOutputSchema.parse({summary:'done',passed:true}),/unknown/));
test('agent summary cannot be empty',()=>assert.throws(()=>agentOutputSchema.parse({summary:''})));
test('JSON schemas expose strict additionalProperties and required fields',()=>{
  assert.equal(configSchema.json.additionalProperties,false);assert.ok(configSchema.json.required.includes('executionMode'));
  assert.ok(!taskSchema.json.required.includes('minimumLane'));
});
test('prototype-looking input fields are rejected',()=>assert.throws(()=>taskSchema.parse(JSON.parse(JSON.stringify(baseTask).slice(0,-1)+',"__proto__":{"x":true}}'))));
test('canonical hashes are independent of object key order',()=>assert.equal(hash({z:1,a:[2,3]}),hash({a:[2,3],z:1})));
test('hash differentiates array order and types',()=>{assert.notEqual(hash([1,2]),hash([2,1]));assert.notEqual(hash(1),hash('1'));assert.throws(()=>canonical(undefined));});
for (const [path,glob,expected] of [
  ['README.md','*.md',true],['docs/a.md','*.md',false],['docs/a/b.md','docs/**',true],
  ['AGENTS.md','**/AGENTS.md',true],['src/x/AGENTS.md','**/AGENTS.md',true],
  ['src/a.ts','src/?.ts',true],['src/aa.ts','src/?.ts',false],['src/a.ts','src/*.ts',true],
  ['package-lock.json','**/package-lock.json',true],['apps/a/package-lock.json','**/package-lock.json',true],
]) test(`glob ${glob} on ${path}`,()=>assert.equal(matches(path,glob),expected));
for (const path of ['/etc/passwd','../outside','a/../b','a\\b','C:/x','a//b','./a','a\0b']) test(`reject non-relative path ${JSON.stringify(path)}`,()=>assert.equal(validRelativePath(path),false));
test('unsupported globs fail instead of silently matching nothing',()=>assert.throws(()=>matches('a','{a,b}'),/Unsupported/));
test('brace expansion and negation still fail loudly',()=>{ for (const g of ['{a,b}','!src/**','src/!x/*']) assert.throws(()=>matches('a',g),/Unsupported/); });
test('brackets and parentheses are literal path characters, never character classes',()=>{
  assert.equal(matches('src/routes/items/[id]/page.ts','src/routes/items/[id]/page.ts'),true);
  assert.equal(matches('src/routes/items/[id]/edit.ts','src/routes/items/[id]/*'),true);
  assert.equal(matches('pages/[...slug].tsx','pages/[...slug].tsx'),true);
  assert.equal(matches('app/(shop)/cart/view.ts','app/(shop)/**'),true);
  assert.equal(matches('src/routes/items/i/page.ts','src/routes/items/[id]/page.ts'),false);
  assert.doesNotThrow(()=>assertScope(['src/routes/items/[id]/page.ts'],task({allowedPaths:['src/routes/items/[id]/page.ts']})));
});
test('scope includes deletions and is not substring based',()=>{assertScope(['src/a.ts'],task({allowedPaths:['src/**']}));assert.throws(()=>assertScope(['src2/a.ts'],task({allowedPaths:['src/**']})),/Out-of-scope/);});
test('bounded new companion files can expand scope automatically but sensitive files cannot',()=>{ const t=task({allowedPaths:['src/page.ts'],allowedNewPaths:['src/*'],maxNewFiles:2}); assert.deepEqual(assertScope({files:['src/page.ts','src/page.server.ts'],added:['src/page.server.ts'],lines:4,binary:false},t),['src/page.server.ts']); assert.throws(()=>assertScope({files:['src/auth.ts'],added:['src/auth.ts'],lines:1,binary:false},t),/Out-of-scope/); });
test('small documentation follows fast path',()=>assert.equal(classify({files:['docs/guide.md'],lines:5,binary:false},cfg()).lane,'fast'));
for (const path of ['src/auth/access.ts','package-lock.json','AGENTS.md','.github/workflows/test.yml','db/migrations/001.sql','docs/security/guide.md'])
  test(`sensitive path cannot become fast: ${path}`,()=>assert.equal(classify({files:[path],lines:1,binary:false},cfg({risk:{fastPaths:['**']}})).lane,'high'));
test('binary changes force high assurance',()=>assert.equal(classify({files:['docs/image.png'],lines:0,binary:true},cfg()).lane,'high'));
test('unknown code and oversized docs default to standard',()=>{
  assert.equal(classify({files:['src/a.ts'],lines:1,binary:false},cfg()).lane,'standard');
  assert.equal(classify({files:['README.md'],lines:1000,binary:false},cfg()).lane,'standard');
});
test('minimum requested assurance can only raise the lane',()=>assert.equal(classify({files:['README.md'],lines:1,binary:false},cfg(),'high').lane,'high'));
test('gate dependencies are included even outside their own lane/path filters',()=>{
  const c=cfg({gates:[{id:'build',command:['true'],lanes:['high'],paths:['never/**']},{id:'test',command:['true'],dependsOn:['build']}]});
  assert.deepEqual(planGates(c,{files:['src/a'],lines:1,binary:false},'standard').map(x=>x.id),['build','test']);
});
test('mandatory checks cannot be removed by lane or path filters',()=>{
  const c=cfg({gates:[{id:'security',command:['true'],mandatory:true,paths:['never/**'],lanes:['high']}]});
  assert.equal(planGates(c,{files:['README.md'],lines:1,binary:false},'fast').length,1);
});
test('high lane runs all configured checks',()=>{
  const c=cfg({gates:[{id:'doc',command:['true'],paths:['docs/**'],lanes:['fast']}]});
  assert.equal(planGates(c,{files:['auth/a.ts'],lines:1,binary:false},'high').length,1);
});
test('empty selected validation is an error, never success',()=>assert.throws(()=>planGates(cfg({gates:[{id:'a',command:['true'],lanes:['high']}]}),{files:['README.md'],lines:1,binary:false},'fast'),/No checks/));
test('approval thresholds adapt to solo, team and regulated review modes',()=>{ assert.deepEqual(['fast','standard','high'].map(x=>requiredApprovals(x,'team')),[0,1,2]); assert.deepEqual(['fast','standard','high'].map(x=>requiredApprovals(x,'solo')),[0,1,1]); assert.deepEqual(['fast','standard','high'].map(x=>requiredApprovals(x,'regulated')),[1,1,2]); });
test('state machine refuses skipped verification',()=>assert.throws(()=>transition({state:'implementing'},'ready'),/Illegal transition/));
test('valid transition updates state',()=>{const r={state:'created'};transition(r,'preparing');assert.equal(r.state,'preparing');});
