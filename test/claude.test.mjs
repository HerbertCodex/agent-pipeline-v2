import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync,chmodSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCommand,claudeOutput } from '../dist/adapters/claude.js';
import { providerProfile } from '../dist/adapters/providers.js';
import { agentSchema,validateConfig,agentOutputSchema } from '../dist/domain/contracts.js';
import { fixture,rawConfig } from './helpers.mjs';
import { fixture as lifeFixture } from './lifecycle-helpers.mjs';
import { planInstallation,applyInstallation } from '../dist/lifecycle/onboarding.js';
const ok = structured_output => ({type:'result',subtype:'success',is_error:false,structured_output,permission_denials:[]});
for(const ro of [true,false]) test(`Claude argv explicitly limits tools (readOnly=${ro})`,()=>{
 const c=claudeCommand(providerProfile('claude'),agentOutputSchema.json,ro);const opt=k=>c[c.indexOf(k)+1];
 assert.equal(opt('--permission-mode'),'dontAsk');assert.equal(opt('--output-format'),'json');assert.equal(opt('--max-turns'),'32');
 assert.equal(opt('--tools'),ro?'Read,Glob,Grep':'Read,Glob,Grep,Edit,Write');assert.equal(opt('--tools').includes('Bash'),false);
 assert.ok(c.includes('--disable-slash-commands'));assert.ok(c.includes('--no-session-persistence'));assert.ok(c.includes('--strict-mcp-config'));
 assert.ok(!c.some(v=>v.includes('bypassPermissions')||v.includes('dangerously')));assert.equal(JSON.parse(opt('--settings')).disableAllHooks,true);
});
test('Claude extracts structured_output, not prose or an embedded claim',()=>{
 assert.deepEqual(claudeOutput(JSON.stringify(ok({summary:'ok'}))),{summary:'ok'});
 for(const envelope of [[],{}, {summary:'ok'}, {...ok(null)}, {...ok({summary:'ok'}),is_error:true}, {...ok({summary:'ok'}),subtype:'error_max_turns'}, {...ok({summary:'ok'}),permission_denials:[{tool_name:'Bash'}]}, {...ok(undefined),result:'{"summary":"looks green"}'}]) assert.throws(()=>claudeOutput(JSON.stringify(envelope)));
 assert.throws(()=>claudeOutput('noise\n'+JSON.stringify(ok({summary:'ok'}))));
});
test('native config rejects free arguments and invalid budget/turn count',()=>{
 for(const agent of [{type:'claude',command:['claude','--dangerously-skip-permissions']},{type:'claude',maxTurns:0},{type:'claude',maxBudgetUsd:-1}]) assert.throws(()=>validateConfig(rawConfig({agent})));
 assert.equal(validateConfig(rawConfig({agent:{type:'claude'}})).agent.type,'claude');
});
function stub(f, body) {
 const path=join(f.root,'fake-claude');writeFileSync(path,`#!${process.execPath}\nconst fs=require('fs');const assert=require('node:assert/strict');const args=process.argv.slice(2);const raw=fs.readFileSync(0,'utf8');const req=JSON.parse(raw.slice(raw.indexOf('{')));\n${body}`);chmodSync(path,0o700);return path;
}
test('Claude implementation contract modifies a real worktree and receives skills',async t=>{
 const f=fixture(t);const executable=stub(f,`assert.ok(args.includes('--json-schema'));assert.equal(args[args.indexOf('--tools')+1],'Read,Glob,Grep,Edit,Write');assert.ok(req.guidance.skills.some(s=>s.id==='tdd'));fs.writeFileSync('src/math.mjs','export const add=(a,b)=>a+b;\\n');console.log(JSON.stringify(${JSON.stringify(ok({summary:'Claude protocol stub, not a model.'}))}));`);
 const r=await f.pipeline.start({repo:f.repo,task:f.task,config:{...f.config,skills:{enabled:['tdd']},agent:{type:'claude',command:[executable]}}});
 assert.equal(r.state,'awaiting_review',JSON.stringify(r.error));assert.match(r.summary,/stub/);
});
for(const mode of ['error','denial','prose','claims']) test(`Claude ${mode} cannot become a successful implementation`,async t=>{
 const f=fixture(t);let result=ok({summary:'no'});if(mode==='error')result.subtype='error_max_budget_usd';if(mode==='denial')result.permission_denials=['Bash'];if(mode==='claims')result.structured_output={summary:'no',passed:true};
 const executable=stub(f,`fs.writeFileSync('src/math.mjs','export const add=(a,b)=>a+b;\\n');console.log(${JSON.stringify(mode==='prose'?'All tests passed':JSON.stringify(result))});`);
 const r=await f.pipeline.start({repo:f.repo,task:f.task,config:{...f.config,agent:{type:'claude',command:[executable]}}});assert.equal(r.state,'failed');assert.equal(r.receipts.length,0);
});
/** Every lifecycle and run event with its offset, printed as TAP diagnostics when the lifecycle does not finish. */
function timeline(t,life,doc){
 const events=[...life.store.documentEvents(doc.id).map(e=>({at:e.at,source:'spec',type:e.type,data:e.data}))];
 for(const runId of new Set([...doc.data.attempts.map(a=>a.runId),...doc.data.validationRunIds])) events.push(...life.store.events(runId).map(e=>({at:e.at,source:'run:'+runId.slice(0,8),type:e.type,data:e.data})));
 events.sort((a,b)=>a.at-b.at);const start=events[0]?.at??0;
 for(const e of events){const d=e.data??{};const detail=['role','taskId','gateId','status','pid','state','durationMs'].filter(k=>d[k]!==undefined).map(k=>k+'='+d[k]).join(' ');
  t.diagnostic(`+${String(e.at-start).padStart(7)}ms ${e.source.padEnd(13)} ${e.type} ${detail} ${d.timingsMs?JSON.stringify(d.timingsMs):''}`);}
}
// Transport double only. The fixture runs real Git, gates, repair and lifecycle transitions.
for(const provider of ['claude','codex']) test(`full lifecycle with ${provider} protocol double, Product and QA repair`,async t=>{
 const f=lifeFixture(t);const path=join(f.root,'fake-'+provider);const runWorkerPath=fileURLToPath(new URL('./support/run-worker.cjs',import.meta.url));const worker=fileURLToPath(new URL('../examples/lifecycle-worker.mjs',import.meta.url));
 writeFileSync(path,`#!${process.execPath}
 const fs=require('fs'),assert=require('node:assert/strict'),cp=require('node:child_process');const args=process.argv.slice(2);
 // Phase markers on stderr: if this double stalls, the controller's timeout diagnostic shows the last phase reached.
 const workerOutput=r=>{if(r.error||r.status!==0){mark('worker failed '+(r.error?r.error.code:'exit '+r.status)+' '+String(r.stderr||'').slice(0,500));process.exit(1);}return r.stdout;};
 const mark=p=>fs.writeSync(2,'[double '+process.pid+' +'+Math.round(process.uptime()*1000)+'ms] '+p+String.fromCharCode(10));mark('started');
 const raw=fs.readFileSync(0,'utf8');mark('stdin read '+raw.length);const req=JSON.parse(raw.slice(raw.indexOf('{')));mark('role '+(req.role??'implementer'));
 if(${JSON.stringify(provider)}==='claude'){assert.equal(args[args.indexOf('--tools')+1],req.role?'Read,Glob,Grep':'Read,Glob,Grep,Edit,Write');assert.ok(args.includes('--strict-mcp-config'));}
 else assert.equal(args[args.indexOf('--sandbox')+1],req.role?'read-only':'workspace-write');
 if(req.role==='qa'){assert.ok(req.context.diff.includes('diff --git'));assert.ok(req.context.diff.includes('multiply'));assert.equal(req.guidance.role.id,'qa');}
 const output=req.role==='setup'?{config:req.context.proposal.config,questions:[],notes:['Provider protocol double only.']}:(mark('worker start'),JSON.parse(workerOutput(require(${JSON.stringify(runWorkerPath)}).runWorker(${JSON.stringify(worker)},JSON.stringify(req)))));
 mark('worker done');
 if(${JSON.stringify(provider)}==='claude')console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:output,permission_denials:[]}));
 else fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(output));
 mark('output written');
 `);chmodSync(path,0o700);
 // A stuck provider must fail on its own bounded timeout with a precise diagnostic, not silently consume
 // the whole lifecycle budget: that is what made an intermittent macOS stall impossible to locate.
 const agent=agentSchema.parse({type:provider,command:[path],timeoutMs:60000});
 const config={...f.config,agent,roles:{product:agent,qa:agent},skills:{enabled:['clean-code','security','tdd']}};
 const plan=await planInstallation(f.life.store,f.repo,{config,agent,assist:true});await applyInstallation(f.life.store,plan.id,plan.data.hash,'Fixture operator','Simulation: approve fixture plan.',true);
 let doc=await f.life.draft({repo:f.repo,config,request:'Ajouter la multiplication, les tests positifs et négatifs et sa documentation.'});
 assert.equal(doc.data.content.questions.length,0);doc=await f.life.approveSpec(doc.id,doc.data.contentHash,'Fixture PO','Simulation: approve the actual fixture spec.');
 doc=await f.life.run(doc.id);
 if(doc.data.status!=='awaiting_review') timeline(t,f.life,doc);
 assert.equal(doc.data.status,'awaiting_review',JSON.stringify(doc.data.error));assert.equal(doc.data.qa.report.verdict,'pass');assert.equal(doc.data.qaRepairs,1);
 const roleEvents=f.life.store.documentEvents(doc.id).filter(e=>e.type==='role.started');assert.ok(roleEvents.some(e=>e.data.provider===provider&&e.data.guidance.role.id==='product'));
 assert.ok(roleEvents.some(e=>e.data.guidance.skills.some(s=>s.id==='tdd')));
});
