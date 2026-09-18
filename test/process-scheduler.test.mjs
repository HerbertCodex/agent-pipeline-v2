import {test} from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess,environment,redact,expandCommand } from '../dist/execution/process.js';
import { schedule } from '../dist/engine/scheduler.js';
import { cfg,receipt } from './helpers.mjs';
const run = (code,opts={})=>runProcess({command:[process.execPath,'-e',code],cwd:process.cwd(),env:environment(['PATH']),timeoutMs:3000,...opts});

test('process captures a real exit code, not text claiming success',async()=>{
 const r=await run("console.log('PASSED');process.exit(7)");assert.equal(r.status,'failed');assert.equal(r.exitCode,7);
});
test('process receives stdin',async()=>assert.equal((await run("process.stdin.pipe(process.stdout)",{input:'hello'})).stdout,'hello'));
test('arguments never use shell expansion',async()=>{
 const r=await runProcess({command:[process.execPath,'-e','console.log(process.argv[1])','$(touch /tmp/apv2-should-not-exist)'],cwd:process.cwd(),env:{},timeoutMs:1000});
 assert.equal(r.stdout.trim(),'$(touch /tmp/apv2-should-not-exist)');
});
test('per-command timeout terminates the process',async()=>assert.equal((await run('setInterval(()=>{},1000)',{timeoutMs:60})).status,'timed_out'));
test('external cancellation is not reported as success',async()=>{
 const c=new AbortController();setTimeout(()=>c.abort(),60);const r=await run('setInterval(()=>{},1000)',{signal:c.signal});assert.equal(r.status,'cancelled');
});
test('pre-aborted command is never spawned',async()=>{
 const c=new AbortController();c.abort();let spawned=false;const r=await run('process.exit(0)',{signal:c.signal,onStart:()=>{spawned=true}});assert.equal(r.status,'cancelled');assert.equal(spawned,false);
});
test('missing executable reports spawn_error',async()=>{
 const r=await runProcess({command:['/definitely/missing/apv2'],cwd:process.cwd(),env:{},timeoutMs:1000});assert.equal(r.status,'spawn_error');
});
test('output capture is bounded while digest covers full stream',async()=>{
 const r=await run("process.stdout.write('x'.repeat(40000))",{maxOutputBytes:1000});assert.equal(r.stdout.length,1000);assert.equal(r.truncated,true);
 assert.equal(r.stdoutHash,createHash('sha256').update('x'.repeat(40000)).digest('hex'));
});
test('failed process bookkeeping terminates the command',async()=>{
 await assert.rejects(()=>run('setInterval(()=>{},1000)',{onStart:()=>{throw new Error('cannot persist process')}}),/cannot persist/);
});
test('environment is an explicit allowlist',()=>{
 assert.deepEqual(environment(['PATH'],{PATH:'/bin',SECRET_TOKEN:'secret'}),{PATH:'/bin'});
});
test('known secrets are redacted in diagnostics',()=>assert.equal(redact('failure abcdefg',{API_KEY:'abcdefg'}),'failure [REDACTED]'));
test('whole argument substitutions preserve data without shell interpretation',()=>assert.deepEqual(expandCommand(['git','diff','{{baseSha}}'],{baseSha:'x; echo nope'}),['git','diff','x; echo nope']));
test('partial or unknown placeholders are refused',()=>{assert.throws(()=>expandCommand(['x{{baseSha}}'],{baseSha:'a'}));assert.throws(()=>expandCommand(['{{unknown}}'],{}));});
function gates(values){return cfg({gates:values.map(v=>({command:['true'],readOnly:true,...v}))}).gates;}
const blocked=(g,reason)=>receipt(g.id,'blocked',{diagnostic:reason});
test('independent gates actually overlap up to the configured limit',async()=>{
 let active=0,max=0;const r=await schedule(gates([{id:'a'},{id:'b'},{id:'c'},{id:'d'}]),{concurrency:2,failFast:true,signal:new AbortController().signal,blocked,
 execute:async g=>{active++;max=Math.max(max,active);await sleep(20);active--;return receipt(g.id)}});
 assert.equal(max,2);assert.equal(r.length,4);
});
test('dependency gates wait for successful parents',async()=>{
 const order=[];await schedule(gates([{id:'a'},{id:'b',dependsOn:['a']}]),{concurrency:2,failFast:true,signal:new AbortController().signal,blocked,
 execute:async g=>{order.push(`${g.id}:start`);await sleep(10);order.push(`${g.id}:end`);return receipt(g.id)}});
 assert.deepEqual(order,['a:start','a:end','b:start','b:end']);
});
test('exclusive resource locks prevent overlapping database users',async()=>{
 let active=0,max=0;await schedule(gates([{id:'a',resources:['db']},{id:'b',resources:['db']}]),{concurrency:2,failFast:true,signal:new AbortController().signal,blocked,
 execute:async g=>{active++;max=Math.max(max,active);await sleep(15);active--;return receipt(g.id)}});assert.equal(max,1);
});
test('failed dependencies are blocked, not skipped-as-success',async()=>{
 let calls=0;const results=await schedule(gates([{id:'a'},{id:'b',dependsOn:['a']}]),{concurrency:2,failFast:false,signal:new AbortController().signal,blocked,
 execute:async g=>{calls++;return receipt(g.id,'failed')}});assert.equal(calls,1);assert.equal(results[1].status,'blocked');
});
test('fail-fast aborts running siblings and drains them before returning',async()=>{
 let drained=false;await schedule(gates([{id:'a'},{id:'b'}]),{concurrency:2,failFast:true,signal:new AbortController().signal,blocked,
 execute:async(g,signal)=>{if(g.id==='a'){await sleep(10);return receipt(g.id,'failed');}await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await sleep(15);drained=true;return receipt(g.id,'cancelled');}});assert.equal(drained,true);
});
test('scheduler drains running siblings after an execution exception',async()=>{
 let drained=false;await assert.rejects(()=>schedule(gates([{id:'a'},{id:'b'}]),{concurrency:2,failFast:true,signal:new AbortController().signal,blocked,
 execute:async(g,signal)=>{if(g.id==='a'){await sleep(5);throw new Error('executor failure');}await new Promise(r=>signal.addEventListener('abort',r,{once:true}));drained=true;return receipt(g.id,'cancelled');}}),/executor failure/);assert.equal(drained,true);
});
test('pre-cancelled scheduler launches no gate',async()=>{
 const c=new AbortController();c.abort();let count=0;const results=await schedule(gates([{id:'a'}]),{concurrency:1,failFast:true,signal:c.signal,blocked,execute:async()=>{count++;return receipt()}});
 assert.equal(count,0);assert.equal(results[0].status,'blocked');
});

test('legacy build, check and e2e commands cannot overwrite shared generated artifacts', async t => {
 const root = mkdtempSync(join(tmpdir(), 'apv2-generated-'));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 const plan = cfg({ gates: ['build', 'check', 'e2e'].map(id => ({ id,
   // Different or missing named resources must not bypass protection of the shared workspace.
   resources: id === 'check' ? ['project-checks'] : [],
   command: [process.execPath, '--input-type=module', '-e', `
     import {writeFileSync,readFileSync} from 'node:fs';
     writeFileSync('generated-manifest', '${id}');
     await new Promise(r=>setTimeout(r, 80));
     if(readFileSync('generated-manifest','utf8') !== '${id}') process.exit(9);
   `],
 })) }).gates;
 // Also exercise raw legacy in-memory gates without the new schema field.
 for (const gate of plan) delete gate.readOnly;
 let active = 0, max = 0;
 const results = await schedule(plan, { concurrency: 3, failFast: false, signal: new AbortController().signal, blocked,
   execute: async g => {
     max = Math.max(max, ++active);
     try {
       const observed = await runProcess({ command: g.command, cwd: root, env: environment(['PATH']), timeoutMs: 3000 });
       return receipt(g.id, observed.status, { exitCode: observed.exitCode, diagnostic: observed.stderr });
     } finally { active--; }
   },
 });
 assert.equal(max, 1);
 assert.ok(results.every(r => r.status === 'passed'), JSON.stringify(results));
});

test('a workspace writer excludes readers as well as other writers', async () => {
 let readers = 0, writing = false, peakReaders = 0;
 await schedule(gates([{id:'read1'}, {id:'write',readOnly:false}, {id:'read2'}, {id:'write2',readOnly:false}]), {
  concurrency: 3, failFast: false, signal: new AbortController().signal, blocked,
  execute: async g => {
   assert.equal(writing, false);
   if (g.readOnly) peakReaders = Math.max(peakReaders, ++readers);
   else { assert.equal(readers, 0); writing = true; }
   await sleep(15);
   if (g.readOnly) readers--; else writing = false;
   return receipt(g.id);
  },
 });
 assert.equal(peakReaders, 2);
});
