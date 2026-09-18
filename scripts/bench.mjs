import {performance} from 'node:perf_hooks';
import {cpus,availableParallelism,platform,release} from 'node:os';
import {parseArgs} from 'node:util';
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateConfig} from '../dist/domain/contracts.js';
import {schedule} from '../dist/engine/scheduler.js';
import {runProcess,environment} from '../dist/execution/process.js';
const{values}=parseArgs({options:{output:{type:'string'},repetitions:{type:'string'}}});
const repeats=Number(values.repetitions??5);if(!Number.isInteger(repeats)||repeats<1||repeats>50)throw new Error('Repetitions must be in [1,50]');
const config=validateConfig({schemaVersion:1,executionMode:'local-trusted',environment:{id:'synthetic-benchmark'},agent:{type:'command',command:['true']},
 gates:[['a',180,[]],['b',180,[]],['c',180,[]],['d',50,['a','b']]].map(([id,ms,dependsOn])=>({id,dependsOn,readOnly:true,command:[process.execPath,'-e',`setTimeout(()=>{},${ms})`]}))});
const samples={serial:[],parallel:[]};
function receipt(g,status='passed',durationMs=0){return{id:randomUUID(),runId:'bench',gateId:g.id,key:'a'.repeat(64),candidateSha:'b'.repeat(40),configHash:'c'.repeat(64),environmentHash:'d'.repeat(64),status,startedAt:Date.now(),durationMs,exitCode:status==='passed'?0:null,stdoutHash:'',stderrHash:'',diagnostic:'',reusedFrom:null};}
for(let i=0;i<repeats;i++){
 // Alternate the order to reduce a systematic cold-start advantage.
 for(const[name,concurrency]of(i%2?[['parallel',3],['serial',1]]:[['serial',1],['parallel',3]])){
  const start=performance.now();const results=await schedule(config.gates,{concurrency,failFast:true,signal:new AbortController().signal,
   blocked:g=>receipt(g,'blocked'),execute:async(g,signal)=>{const r=await runProcess({command:g.command,cwd:process.cwd(),env:environment(['PATH']),timeoutMs:5000,signal});return receipt(g,r.status,r.durationMs);}});
  if(!results.every(r=>r.status==='passed'))throw new Error('Benchmark command failed');
  samples[name].push({wallMs:performance.now()-start,commandSumMs:results.reduce((s,r)=>s+r.durationMs,0),executed:results.length});
 }
}
const quantile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*q)-1];
const median=name=>quantile(samples[name].map(s=>s.wallMs),0.5);
const report={kind:'SYNTHETIC scheduler benchmark: three 180ms timers plus a dependent 50ms timer; real Node child processes.',
 limitation:'Not an AI task benchmark, not a V1/V2 comparison, not a production latency claim.',
 node:process.version,platform:platform(),kernel:release(),cpu:cpus()[0]?.model,availableParallelism:availableParallelism(),repetitions:repeats,
 serialMedianMs:median('serial'),parallelMedianMs:median('parallel'),observedSchedulerRatio:median('serial')/median('parallel'),samples};
if(values.output){const file=resolve(values.output);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report,null,2));
