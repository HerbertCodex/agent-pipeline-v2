import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync,spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {validateReceipt,receiptSchema} from '../dist/domain/contracts.js';
import {processAlive} from '../dist/persistence/store.js';
import {schedule} from '../dist/engine/scheduler.js';
import {runProcess,environment} from '../dist/execution/process.js';
import {cfg,fixture,worker,receipt,git} from './helpers.mjs';
import {lifecycleHelp} from '../dist/lifecycle/cli.js';
const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
function call(args){return spawnSync(process.execPath,[cli,...args],{encoding:'utf8',env:{PATH:process.env.PATH},timeout:20000});}
for(const[name,patch]of[
 ['invalid intermediate SHA length',{candidateSha:'a'.repeat(41)}],['empty config hash',{configHash:''}],
 ['NaN duration',{durationMs:NaN}],['negative duration',{durationMs:-1}],['false pass with nonzero exit',{exitCode:1}],
 ['missing success stream digests',{stdoutHash:''}],['forged cached status',{status:'cached',reusedFrom:null}],
 ['unknown field',{trustMe:true}],
])test(`receipt schema refuses ${name}`,()=>assert.throws(()=>validateReceipt({...receipt(),...patch})));
test('receipt schema is generated with strict fields',()=>assert.equal(receiptSchema.json.additionalProperties,false));
test('receipt-only caching refuses artifact-producing checks',()=>assert.throws(()=>cfg({gates:[{id:'build',command:['true'],outputs:['dist/**'],cacheTtlMs:1000}]}),/output-free/));
test('receipt-only caching refuses dependency chains without an artifact cache',()=>assert.throws(()=>cfg({gates:[{id:'build',command:['true'],cacheTtlMs:1000},{id:'test',command:['true'],dependsOn:['build']}]}),/independent/));
test('sealing a modified receipt does not certify a different observation',async t=>{
 const f=fixture(t);const r=await f.pipeline.create({repo:f.repo,task:f.task,config:f.config});const proof=receipt('unit','passed',{runId:r.id});f.pipeline.store.addReceipt(proof);
 assert.throws(()=>f.pipeline.store.seal({...proof,stdoutHash:'1'.repeat(64)},1000),/persisted runner/);
});
test('two different runs cannot race shared resources in one local store',async t=>{
 const f=fixture(t);const a=await f.pipeline.create({repo:f.repo,task:f.task,config:f.config});const b=await f.pipeline.create({repo:f.repo,task:{...f.task,id:'TASK-2'},config:f.config});
 const token=f.pipeline.store.acquireExecution(a.id);
 try{await assert.rejects(()=>f.pipeline.execute(b.id),/Another execution/);assert.equal(f.pipeline.store.get(b.id).state,'created');}finally{f.pipeline.store.releaseExecution(a.id,token);}
});
test('scheduler drains siblings even when blocked-result bookkeeping throws',async()=>{
 const gates=cfg({gates:[{id:'a',command:['true'],readOnly:true},{id:'b',command:['true'],readOnly:true},{id:'c',command:['true'],readOnly:true,dependsOn:['a']}]}).gates;
 let drained=false;
 await assert.rejects(()=>schedule(gates,{concurrency:2,failFast:true,signal:new AbortController().signal,
  blocked:()=>{throw new Error('bookkeeping failed')},execute:async(g,signal)=>{
   if(g.id==='a'){await sleep(10);return receipt('a','failed');}
   await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await sleep(20);drained=true;return receipt('b','cancelled');
  }}),/bookkeeping failed/);assert.equal(drained,true);
});
test('POSIX normal leader exit also stops a background child',async()=>{
 const result=await runProcess({command:[process.execPath,'-e',`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);child.unref();`],cwd:process.cwd(),env:environment(['PATH']),timeoutMs:2000});
 assert.equal(result.status,'passed');const pid=Number(result.stdout.trim());assert.ok(pid>0);
 // Group termination is asynchronous; wait for its effect without assuming a 20 ms scheduling window.
 const deadline=Date.now()+1000;
 while(processAlive(pid)&&Date.now()<deadline) await sleep(10);
 assert.equal(processAlive(pid),false,'The background child must stop after its leader exits');
});
test('CLI help and version work without a project or API credentials',()=>{
 assert.equal(call(['--help']).status,0);const version=call(['--version']);assert.equal(version.status,0);assert.match(version.stdout,/2.0.0-alpha.8/);
});
test('CLI init never overwrites an existing operator config',t=>{
 const root=mkdtempSync(join(tmpdir(),'apv2-cli-init-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 assert.equal(call(['init','--repo',root]).status,0);const previous=readFileSync(join(root,'pipeline.v2.json'),'utf8');
 assert.equal(call(['init','--repo',root]).status,1);assert.equal(readFileSync(join(root,'pipeline.v2.json'),'utf8'),previous);
});
test('CLI complete workflow returns review exit code 2 then exports a patch',async t=>{
 const f=fixture(t);const taskPath=join(f.root,'task.json'),configPath=join(f.root,'config.json');writeFileSync(taskPath,JSON.stringify(f.task));writeFileSync(configPath,JSON.stringify(f.config));
 const first=call(['run','--repo',f.repo,'--task',taskPath,'--config',configPath,'--state-dir',f.state]);assert.equal(first.status,2,first.stderr);const r=JSON.parse(first.stdout);
 const status=call(['status',r.id,'--state-dir',f.state]);assert.equal(status.status,0);assert.equal(JSON.parse(status.stdout).state,'awaiting_review');
 const approved=call(['approve',r.id,'--sha',r.candidateSha,'--reviewer','CLI Tester','--note','Reviewed the exact candidate in the integration test.','--state-dir',f.state]);assert.equal(approved.status,0,approved.stderr);
 const output=join(f.root,'cli.patch');const exported=call(['export',r.id,'--output',output,'--state-dir',f.state]);assert.equal(exported.status,0,exported.stderr);git(f.repo,'apply','--check',output);
 const overwrite=call(['export',r.id,'--output',output,'--state-dir',f.state]);assert.equal(overwrite.status,1);
});
test('Codex adapter contract uses schema, workspace sandbox, stdin and final file (stub, not a model)',async t=>{
 const f=fixture(t);const executable=join(f.root,'fake-codex');
 writeFileSync(executable,`#!${process.execPath}
 const fs=require('fs');const assert=require('assert/strict');const args=process.argv.slice(2);assert.equal(args[0],'exec');
 assert.equal(args[args.indexOf('--sandbox')+1],'workspace-write');assert.equal(args.at(-1),'-');
 const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));assert.equal(schema.additionalProperties,false);
 assert.ok(fs.readFileSync(0,'utf8').includes('agent-pipeline/v2'));fs.writeFileSync('src/math.mjs','export const add=(a,b)=>a+b;\\n');
 fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({summary:'Provider CLI stub: no network/model involved.'}));
 `);chmodSync(executable,0o700);
 const r=await f.pipeline.start({repo:f.repo,task:f.task,config:{...f.config,agent:{type:'codex',command:[executable]}}});
 assert.equal(r.state,'awaiting_review',JSON.stringify(r.error));assert.match(r.summary,/stub/);
});
test('an interrupted agent never imports an unchecked symlink candidate',async t=>{
 const f=fixture(t,{task:{allowedPaths:['src/**']},config:{agent:{type:'command',command:worker("const {symlinkSync}=await import('node:fs');symlinkSync('/etc/passwd','src/link');writeFileSync('src/math.mjs','export const add=(a,b)=>a+b;\\n');")}}});
 const r=await f.start();assert.equal(r.state,'failed');assert.equal(r.error.code,'SYMLINK');
});
test('real SIGKILL of a controller leaves a durable lease; explicit recovery does not rerun the agent',async t=>{
 const f=fixture(t);const info=join(f.root,'crash-info.json');
 const moduleUrl=new URL('../dist/index.js',import.meta.url).href;
 const gitUrl=new URL('../dist/execution/git.js',import.meta.url).href;
 const code=`import {Pipeline} from ${JSON.stringify(moduleUrl)};import {Git} from ${JSON.stringify(gitUrl)};import {writeFileSync} from 'node:fs';
 const p=new Pipeline(${JSON.stringify(f.state)});const r=await p.create(${JSON.stringify({repo:f.repo,task:f.task,config:f.config})});
 p.store.acquire(r.id);p.store.acquireExecution(r.id);const git=new Git();await git.workspace(r.repo,r.workspace,r.baseSha);
 writeFileSync(r.workspace+'/src/math.mjs','export const add=(a,b)=>a+b;\\n');r.state='implementing';r.sessionStartedAt=Date.now();p.store.save(r,'test.crash_window');
 writeFileSync(${JSON.stringify(info)},JSON.stringify({id:r.id}));console.log('READY');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',d=>stderr+=d);
 t.after(()=>{try{child.kill('SIGKILL')}catch{}});
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Crash fixture failed to start: '+stderr)),5000);
  child.stdout.on('data',d=>{if(String(d).includes('READY')){clearTimeout(timer);resolve();}});
  child.once('error',e=>{clearTimeout(timer);reject(e)});
 });
 const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await closed;
 const{id}=JSON.parse(readFileSync(info,'utf8'));assert.throws(()=>f.pipeline.store.acquire(id),/locked/);
 const recovered=f.pipeline.recover(id,true);assert.equal(recovered.state,'interrupted');assert.equal(recovered.resumeFrom,'implementing');
 await assert.rejects(()=>f.pipeline.execute(id),/Agent was interrupted/);
 const resumed=await f.pipeline.execute(id,{acceptCurrentCandidate:true});assert.equal(resumed.state,'awaiting_review',JSON.stringify(resumed.error));
 assert.equal(f.pipeline.store.events(id).filter(e=>e.type==='agent.started').length,0);
});

test('recovery after the final validation checkpoint preserves completion and closes the session',async t=>{
 const f=fixture(t);const r=await f.start();r.sessionStartedAt=Date.now()-10;f.pipeline.store.save(r,'test.crash_after_checkpoint');
 const recovered=f.pipeline.recover(r.id,true);assert.equal(recovered.state,'awaiting_review');assert.equal(recovered.sessionStartedAt,null);
 const again=await f.pipeline.execute(r.id);assert.equal(again.state,'awaiting_review');
});
test('export rechecks required approvals even if a bad internal caller marks the run ready',async t=>{
 const f=fixture(t);const r=await f.start();r.state='ready';f.pipeline.store.save(r,'test.invalid_ready');
 await assert.rejects(()=>f.pipeline.exportPatch(r.id),/Required approvals/);
});
test('review rejects a receipt altered after the runner persisted it',async t=>{
 const f=fixture(t);const r=await f.start();r.receipts[0].stdoutHash='f'.repeat(64);f.pipeline.store.save(r,'test.altered_receipt');
 await assert.rejects(()=>f.pipeline.approve(r.id,r.candidateSha,'Alice','Changed receipt must be rejected.'),/persisted runner/);
});
// `prune` existed in the lifecycle router and in the help, but not in the dispatch list of cli.ts, so the
// binary answered "Unknown command prune". Every command the help documents must reach its handler.
test('every documented lifecycle command is routed by the binary',()=>{
 const state=mkdtempSync(join(tmpdir(),'apv2-cli-routing-'));const cwd=mkdtempSync(join(tmpdir(),'apv2-cli-cwd-'));
 const documented=[...new Set([...lifecycleHelp.matchAll(/^\s*apv2 ([a-z-]+)/gm)].map(m=>m[1]))];
 assert.ok(documented.includes('prune')&&documented.includes('gc')&&documented.length>=6,`unexpected help: ${documented}`);
 for(const command of documented){
  const r=spawnSync(process.execPath,[cli,command,'--state-dir',state],{encoding:'utf8',cwd,env:{PATH:process.env.PATH},timeout:20000});
  assert.doesNotMatch(`${r.stdout}${r.stderr}`,/Unknown command/,`apv2 ${command} is documented but not routed`);
 }
 rmSync(state,{recursive:true,force:true});rmSync(cwd,{recursive:true,force:true});
});
// A worktree helper link to node_modules was committed once: `node_modules/` ignores directories, not a link,
// and Git then replaced a real, ignored node_modules with that link on the next fast-forward.
test('the repository tracks no symbolic link', { skip: !existsSync(new URL('../.git', import.meta.url)) }, () => {
 const root = fileURLToPath(new URL('..', import.meta.url));
 const r = spawnSync('git', ['ls-files', '-s'], { cwd: root, encoding: 'utf8' });
 assert.equal(r.status, 0, r.stderr);
 assert.deepEqual(r.stdout.split('\n').filter(l => l.startsWith('120000 ')), []);
});
