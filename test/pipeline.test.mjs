import {test} from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Pipeline } from '../dist/index.js';
import { fixture,worker,git } from './helpers.mjs';

test('full real Git edit -> test -> review -> exact patch; host tree untouched',async t=>{
 const f=fixture(t);const before=git(f.repo,'rev-parse','HEAD');
 assert.throws(()=>execFileSync(process.execPath,['--test','test/math.test.mjs'],{cwd:f.repo,stdio:'pipe',env:{PATH:process.env.PATH}}));
 const run=await f.start();assert.equal(run.state,'awaiting_review',JSON.stringify(run.error));assert.equal(run.risk.lane,'standard');
 assert.notEqual(run.candidateSha,before);assert.equal(run.receipts[0].status,'passed');assert.equal(git(f.repo,'rev-parse','HEAD'),before);assert.equal(git(f.repo,'status','--porcelain'),'');
 await assert.rejects(()=>f.pipeline.exportPatch(run.id),/Only ready/);
 const ready=await f.pipeline.approve(run.id,run.candidateSha,'Alice','Checked acceptance criteria against the diff.');assert.equal(ready.state,'ready');
 const patch=await f.pipeline.exportPatch(run.id);assert.ok(patch.includes('a + b'));const path=join(f.root,'out.patch');writeFileSync(path,patch);git(f.repo,'apply','--check',path);
 const events=f.pipeline.store.events(run.id);assert.ok(events.some(e=>e.type==='candidate.created'));assert.ok(events.some(e=>e.type==='review.approved'));
});
test('fast documentation path avoids the review handoff',async t=>{
 const f=fixture(t,{task:{allowedPaths:['docs/**']},config:{agent:{type:'command',command:worker("writeFileSync('docs/guide.md','Improved guide.\\n');")},gates:[{id:'doc',command:[process.execPath,'-e',"const fs=require('fs');if(!fs.readFileSync('docs/guide.md','utf8').includes('Improved'))process.exit(1)"]}]}});
 const run=await f.start();assert.equal(run.state,'ready',JSON.stringify(run.error));assert.equal(run.risk.lane,'fast');assert.equal(run.approvals.length,0);
});
test('sensitive path automatically escalates and requires two distinct reviewer labels',async t=>{
 const f=fixture(t,{task:{allowedPaths:['src/auth.mjs']},config:{agent:{type:'command',command:worker("writeFileSync('src/auth.mjs','export const allowed = false;\\n');")},gates:[{id:'syntax',command:[process.execPath,'--check','src/auth.mjs']}]}});
 const run=await f.start();assert.equal(run.state,'awaiting_review',JSON.stringify(run.error));assert.equal(run.risk.lane,'high');
 let r=await f.pipeline.approve(run.id,run.candidateSha,'Alice','Checked the authorization boundary.');assert.equal(r.state,'awaiting_review');
 await assert.rejects(()=>f.pipeline.approve(run.id,run.candidateSha,' alice ','Another review from the same person.'),/twice/);
 r=await f.pipeline.approve(run.id,run.candidateSha,'Bob','Independent security review recorded.');assert.equal(r.state,'ready');
});
test('out-of-scope modifications fail before any gate executes',async t=>{
 const f=fixture(t,{config:{agent:{type:'command',command:worker("writeFileSync('README.md','Unexpected edit.\\n');")}}});
 const r=await f.start();assert.equal(r.state,'failed');assert.equal(r.error.code,'SCOPE');assert.equal(f.pipeline.store.events(r.id).filter(e=>e.type==='gate.started').length,0);
});
test('no-op agent is not a completed task',async t=>{
 const f=fixture(t,{config:{agent:{type:'command',command:worker('')}}});const r=await f.start();assert.equal(r.state,'failed');assert.equal(r.error.code,'NO_CHANGE');
});
test('malformed/authoritative agent output is rejected',async t=>{
 const f=fixture(t,{config:{agent:{type:'command',command:[process.execPath,'-e',"console.log(JSON.stringify({summary:'done',passed:true}))"]}}});const r=await f.start();assert.equal(r.error.code,'AGENT_OUTPUT');
});
test('failed checks cannot be approved',async t=>{
 const f=fixture(t,{config:{gates:[{id:'fail',command:[process.execPath,'-e','process.exit(1)']}]}});
 const r=await f.start();assert.equal(r.state,'failed');assert.equal(r.receipts[0].status,'failed');await assert.rejects(()=>f.pipeline.approve(r.id,r.candidateSha,'Alice','Trying to waive a failed test.'),/not awaiting/);
});
test('bounded repair can fix a failed candidate without new Product/QA calls',async t=>{
 const code="writeFileSync('src/math.mjs',request.previousFailures.length ? 'export const add = (a,b) => a + b;\\n' : 'export const add = (a,b) => a * b;\\n');";
 const f=fixture(t,{config:{maxRepairAttempts:1,agent:{type:'command',command:worker(code)}}});
 const r=await f.start();assert.equal(r.state,'awaiting_review',JSON.stringify(r.error));assert.equal(r.metrics.repairAttempts,1);
 assert.equal(f.pipeline.store.events(r.id).filter(e=>e.type==='candidate.created').length,2);
});
test('repair budget stops an unproductive agent',async t=>{
 const f=fixture(t,{config:{maxRepairAttempts:1,agent:{type:'command',command:worker("writeFileSync('src/math.mjs','export const add = (a,b) => a * b;\\n');")}}});
 const r=await f.start();assert.equal(r.state,'failed');assert.equal(r.metrics.repairAttempts,1);assert.equal(r.error?.code,'REPAIR_NO_CHANGE');
});
test('gate mutations invalidate every would-be cached proof',async t=>{
 const f=fixture(t,{config:{gates:[{id:'mutator',command:[process.execPath,'-e',"require('fs').writeFileSync('README.md','mutated')"],cacheTtlMs:10000}]}});
 const r=await f.start();assert.equal(r.state,'failed');assert.equal(r.error.code,'DIRTY');assert.equal(f.pipeline.store.cached(r.receipts[0].key),null);
});
test('fresh validator does not trust ignored output planted by agent',async t=>{
 const code="mkdirSync('node_modules',{recursive:true});writeFileSync('node_modules/fake-proof','PASSED');writeFileSync('src/math.mjs','export const add = (a,b) => a + b;\\n');";
 const f=fixture(t,{config:{agent:{type:'command',command:worker(code)},gates:[{id:'isolation',command:[process.execPath,'-e',"if(require('fs').existsSync('node_modules/fake-proof'))process.exit(1)"]}]}});
 const r=await f.start();assert.equal(r.state,'awaiting_review',JSON.stringify(r.error));assert.equal(existsSync(join(r.validationWorkspace,'node_modules/fake-proof')),false);
});
test('revalidation reuses only sealed, opted-in exact-candidate proofs',async t=>{
 const f=fixture(t,{config:{gates:[{id:'unit',command:[process.execPath,'--test','test/math.test.mjs'],cacheTtlMs:10000}]}});
 const r=await f.start();assert.equal(r.state,'awaiting_review',JSON.stringify(r.error));const first=r.receipts[0];
 const again=await f.pipeline.revalidate(r.id);assert.equal(again.state,'awaiting_review',JSON.stringify(again.error));assert.equal(again.receipts[0].status,'cached');assert.equal(again.receipts[0].reusedFrom,first.id);
});
test('cache disabled by default re-executes a gate',async t=>{
 const f=fixture(t);const r=await f.start();const again=await f.pipeline.revalidate(r.id);assert.equal(again.receipts[0].status,'passed');assert.notEqual(again.receipts[0].id,r.receipts[0].id);
});
test('changed allowed environment variable invalidates cache',async t=>{
 const name='APV2_TEST_ENV_INPUT';process.env[name]='one';t.after(()=>delete process.env[name]);
 const f=fixture(t,{config:{gates:[{id:'unit',command:[process.execPath,'--test','test/math.test.mjs'],passEnv:[name],cacheTtlMs:10000}]}});
 const r=await f.start();process.env[name]='two';const again=await f.pipeline.revalidate(r.id);assert.equal(again.receipts[0].status,'passed');assert.notEqual(again.receipts[0].key,r.receipts[0].key);
});
test('revalidation invalidates prior approvals even with cached proofs',async t=>{
 const f=fixture(t);let r=await f.start();r=await f.pipeline.approve(r.id,r.candidateSha,'Alice','Reviewed the exact candidate commit.');
 const again=await f.pipeline.revalidate(r.id);assert.equal(again.state,'awaiting_review');assert.equal(again.approvals.length,0);
});
test('wrong candidate SHA is never approved',async t=>{
 const f=fixture(t);const r=await f.start();await assert.rejects(()=>f.pipeline.approve(r.id,'0'.repeat(40),'Alice','Wrong commit must never be accepted.'),/exact candidate/);
});
test('a dirty candidate after validation cannot be approved',async t=>{
 const f=fixture(t);const r=await f.start();writeFileSync(join(r.workspace,'src/math.mjs'),'changed after validation');
 await assert.rejects(()=>f.pipeline.approve(r.id,r.candidateSha,'Alice','Review of a stale worktree.'),/uncommitted/);
});
test('expired evidence requires revalidation',async t=>{
 const f=fixture(t);const r=await f.start();r.validatedAt=Date.now()-r.config.validationMaxAgeMs-1;f.pipeline.store.save(r,'test.expire');
 await assert.rejects(()=>f.pipeline.approve(r.id,r.candidateSha,'Alice','Review after expiration should fail.'),/expired/);
});
test('rejection is terminal and retained',async t=>{
 const f=fixture(t);const r=await f.start();const rejected=f.pipeline.reject(r.id,'The business requirement is not met.');assert.equal(rejected.state,'rejected');await assert.rejects(()=>f.pipeline.execute(r.id),/Terminal/);
});
test('resume of completed validation performs no work',async t=>{
 const f=fixture(t);const r=await f.start();const count=f.pipeline.store.events(r.id).length;await f.pipeline.execute(r.id);assert.equal(f.pipeline.store.events(r.id).length,count);
});
test('restart with a new Pipeline instance preserves the run',async t=>{
 const f=fixture(t);const r=await f.start();const other=new Pipeline(f.state);try{assert.equal(other.store.get(r.id).candidateSha,r.candidateSha);}finally{other.close();}
});
test('cancellation during agent does not silently rerun it',async t=>{
 const f=fixture(t,{config:{agent:{type:'command',command:worker("writeFileSync('src/math.mjs','export const add = (a,b) => a+b;\\n');await new Promise(r=>setTimeout(r,10000));")}}});
 const created=await f.pipeline.create({repo:f.repo,task:f.task,config:f.config});const c=new AbortController();
 const polling=setInterval(()=>{const r=f.pipeline.store.get(created.id);if(r.state==='implementing' && existsSync(join(r.workspace,'src/math.mjs')) && readFileSync(join(r.workspace,'src/math.mjs'),'utf8').includes('a+b'))c.abort();},10);
 let r;try{r=await f.pipeline.execute(created.id,{signal:c.signal});}finally{clearInterval(polling);}
 assert.equal(r.state,'interrupted');assert.equal(r.resumeFrom,'implementing');
 await assert.rejects(()=>f.pipeline.execute(r.id),/Agent was interrupted/);
 const resumed=await f.pipeline.execute(r.id,{acceptCurrentCandidate:true});assert.equal(resumed.state,'awaiting_review',JSON.stringify(resumed.error));
});
test('run time budget yields interruption, not success',async t=>{
 const f=fixture(t,{config:{maxRunMs:200,agent:{type:'command',command:worker('await new Promise(r=>setTimeout(r,10000));')}}});
 const r=await f.start();assert.equal(r.state,'interrupted');assert.equal(r.error.code,'BUDGET');assert.equal(r.remainingMs,0);
});
test('setup failure is infrastructure failure, not repairable code',async t=>{
 const f=fixture(t,{config:{setup:[{command:[process.execPath,'-e','process.exit(1)']}]}});const r=await f.start();assert.equal(r.state,'failed');assert.equal(r.error.code,'SETUP');assert.equal(r.metrics.repairAttempts,0);
});
test('gate infrastructure timeout is never turned into success',async t=>{
 const f=fixture(t,{config:{gates:[{id:'slow',command:[process.execPath,'-e','setInterval(()=>{},1000)'],timeoutMs:50}]}});const r=await f.start();assert.equal(r.state,'failed');assert.equal(r.receipts[0].status,'timed_out');
});
test('state stored inside source repository is refused',async t=>{
 const f=fixture(t);const p=new Pipeline(join(f.repo,'state'));try{await assert.rejects(()=>p.create({repo:f.repo,task:f.task,config:f.config}),/disjoint/);}finally{p.close();}
});
test('source dirty files cannot silently become task input',async t=>{
 const f=fixture(t);writeFileSync(join(f.repo,'untracked.txt'),'operator changes');await assert.rejects(()=>f.start(),/uncommitted/);
});
