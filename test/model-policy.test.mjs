import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { agentSchema, validateConfig } from '../dist/domain/contracts.js';
import { s } from '../dist/domain/schema.js';
import { roleAgent, modelPlan } from '../dist/adapters/routing.js';
import { validateModelSelection, applyModelSelection } from '../dist/adapters/model-selection.js';
import { ensureModelReady, assertModelResponse } from '../dist/adapters/model-check.js';
import { budgetedAgent, invocationTotals } from '../dist/adapters/invocations.js';
import { replaceModel } from '../dist/knowledge/models.js';
import { planInstallation } from '../dist/lifecycle/onboarding.js';
import { bootstrapHash } from '../dist/lifecycle/bootstrap.js';
import { runRole } from '../dist/lifecycle/roles.js';
import { fixture, approved, oneTask } from './lifecycle-helpers.mjs';

const selection = () => validateModelSelection({
  quick:{provider:'codex',model:'fast-id',effort:'low'},
  deep:{provider:'codex',model:'deep-id',effort:'high'},
  qa:{provider:'claude',model:'review-id',effort:'high'},
});
function native(f, type='claude', body='') {
  const path=join(f.root,`${type}-model-double.mjs`); const log=join(f.root,`${type}-calls.jsonl`);
  writeFileSync(path,`#!${process.execPath}\nimport {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2);if(args.includes('--version')){console.log('test-cli 1.2.3');process.exit(0);}
const input=readFileSync(0,'utf8');const probe=input.startsWith('Compatibility check only.');
const model=args[args.indexOf('--model')+1];appendFileSync(${JSON.stringify(log)},JSON.stringify({input,probe,model,cwd:process.cwd(),args})+'\\n');
${body}
const output=probe?{ready:true}:{answer:'project-answer'};
if(${JSON.stringify(type)}==='claude')console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:output,total_cost_usd:0.02,num_turns:1}));
else {writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(output));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));}
`,{mode:0o700});
  return {agent:agentSchema.parse({type,command:[path],model:'tested-model',effort:'high',preflight:'probe',timeoutMs:10000}),log,
    calls:()=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').map(JSON.parse):[]};
}
function probeOptions(f,doc,extra={}) {return {store:f.life.store,owner:{kind:'document',id:doc.id},env:{PATH:process.env.PATH},...extra};}

test('new-project selection keeps QA independent across lanes and enables probes',async t=>{
  const f=fixture(t); const p=await planInstallation(f.life.store,f.repo,{modelSelection:selection()});
  assert.equal(roleAgent(p.data.config,'implementer','standard').model,'fast-id');
  assert.equal(roleAgent(p.data.config,'implementer','high').model,'deep-id');
  for(const lane of ['fast','standard','high']) {const qa=roleAgent(p.data.config,'qa',lane);assert.equal(qa.model,'review-id');assert.equal(qa.type,'claude');assert.equal(qa.preflight,'probe');}
  assert.equal(p.data.config.workflow.qaProfile,'deep');
  assert.ok(modelPlan(p.data.config).filter(x=>x.role==='qa').every(x=>x.effectiveLane==='high'));
  assert.equal(existsSync(join(f.repo,'pipeline.v2.json')),false);
});
test('deep QA policy uses high route even on a standard task; legacy keeps lane routing',t=>{
 const f=fixture(t); const c=validateConfig({...f.config,agent:{type:'claude'},roles:{},workflow:{qaProfile:'deep'},roleProfiles:[{provider:'claude',role:'qa',quick:{model:'small',effort:'low'},deep:{model:'review',effort:'high'}}]});
 assert.equal(roleAgent(c,'qa','standard').model,'review');
 assert.equal(roleAgent(validateConfig({...c,workflow:{...c.workflow,qaProfile:'lane'}}),'qa','standard').model,'small');
 const routed=validateConfig({...c,modelRouting:[{provider:'claude',role:'qa',lane:'high',model:'explicit-review',effort:'high'}]});
 assert.equal(roleAgent(routed,'qa','standard').model,'explicit-review');
});
test('model selection rejects missing choices and cross-provider quick/deep mixing',()=>{
 assert.throws(()=>validateModelSelection({...selection(),qa:undefined}));
 assert.throws(()=>validateModelSelection({...selection(),deep:{provider:'claude',model:'x',effort:'high'}}),/same provider/);
});
test('bootstrap approval hash binds the chosen QA model',()=>{
 const base={directory:'/tmp/example',request:'Example request',revision:1,provider:agentSchema.parse({type:'codex'}),reviewMode:'solo',proposal:{},semanticReview:{}};
 const selected={...base,modelSelection:selection()};
 assert.notEqual(bootstrapHash(base),bootstrapHash(selected));
 assert.notEqual(bootstrapHash(selected),bootstrapHash({...selected,modelSelection:{...selection(),qa:{...selection().qa,model:'different'}}}));
});
for(const type of ['claude','codex']) test(`${type} probe sends no project data, is cached and accounts for usage`,async t=>{
 const f=fixture(t);const doc=await approved(f,oneTask());const n=native(f,type);const opts=probeOptions(f,doc);
 await ensureModelReady(n.agent,opts);await ensureModelReady(n.agent,opts);
 const calls=n.calls();assert.equal(calls.length,1);assert.equal(calls[0].probe,true);assert.ok(!calls[0].input.includes(f.repo));assert.notEqual(calls[0].cwd,f.repo);assert.equal(existsSync(calls[0].cwd),false);
 if(type==='claude'){assert.equal(calls[0].args[calls[0].args.indexOf('--tools')+1],'');assert.equal(calls[0].args[calls[0].args.indexOf('--max-budget-usd')+1],'0.25');}
 const events=f.life.store.documentEvents(doc.id);assert.ok(events.some(e=>e.type==='model.preflight_reused'));
 const cost=invocationTotals(events);assert.equal(cost.pendingInvocations,0);assert.equal(type==='claude'?cost.knownUsd:cost.unknownInvocations,type==='claude'?0.02:1);
 await ensureModelReady({...n.agent,model:'other-id'},opts);assert.equal(n.calls().length,2);
});
test('failed model probe prevents the long role call and remains charged',async t=>{
 const f=fixture(t);const doc=await approved(f,oneTask());const n=native(f,'claude',`console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,result:'Model not found',total_cost_usd:0.01}));process.exit(1);`);
 await assert.rejects(()=>runRole({store:f.life.store,documentId:doc.id,budgetDocumentId:doc.id,repo:f.repo,sha:doc.data.baseSha,role:'product',agent:n.agent,passEnv:['PATH'],schema:s.object({answer:s.string(1,100)}),context:{request:'PRIVATE_PROJECT_REQUEST'},maxRepairs:2}),e=>e.code==='MODEL_UNAVAILABLE');
 assert.equal(n.calls().length,1);assert.ok(n.calls().every(c=>c.probe&&!c.input.includes('PRIVATE_PROJECT_REQUEST')));
 assert.equal(f.life.costSummary(doc.id).knownUsd,0.01);
 assert.equal(f.life.store.documentEvents(doc.id).filter(e=>e.type==='role.output_repair').length,0);
});
test('probe spending is deducted before a project role can start',async t=>{
 const f=fixture(t,{workflow:{maxSpecCostUsd:0.01}});const doc=await approved(f,oneTask());const n=native(f);
 await assert.rejects(()=>runRole({store:f.life.store,documentId:doc.id,budgetDocumentId:doc.id,repo:f.repo,sha:doc.data.baseSha,role:'qa',agent:n.agent,passEnv:['PATH'],schema:s.object({answer:s.string(1,100)}),context:{request:'private'}}),e=>e.code==='COST_BUDGET');
 assert.equal(n.calls().length,1);assert.equal(n.calls()[0].args[n.calls()[0].args.indexOf('--max-budget-usd')+1],'0.01');
});
test('successful preflight proceeds to the requested native role',async t=>{
 const f=fixture(t);const doc=await approved(f,oneTask());const n=native(f);
 const output=await runRole({store:f.life.store,documentId:doc.id,budgetDocumentId:doc.id,repo:f.repo,sha:doc.data.baseSha,role:'qa',agent:n.agent,passEnv:['PATH'],schema:s.object({answer:s.string(1,100)}),context:{request:'project-content'}});
 assert.equal(output.answer,'project-answer');assert.deepEqual(n.calls().map(c=>c.probe),[true,false]);assert.equal(f.life.costSummary(doc.id).knownUsd,0.04);
});
test('model diagnostics distinguish authentication and unsupported effort from retirement',()=>{
 const a=agentSchema.parse({type:'claude',model:'chosen'}); const failed=text=>({status:'failed',stdout:'',stderr:text});
 assert.throws(()=>assertModelResponse(a,failed('Invalid API key')),e=>e.code==='MODEL_AUTH');
 assert.throws(()=>assertModelResponse(a,failed('reasoning effort is not supported')),e=>e.code==='MODEL_EFFORT');
 assert.throws(()=>assertModelResponse(a,failed('Model chosen does not exist')),e=>e.code==='MODEL_UNAVAILABLE');
 assert.doesNotThrow(()=>assertModelResponse(a,{status:'passed',stderr:'',stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Document says model not found'})}));
 assert.throws(()=>assertModelResponse(a,failed('rate limit exceeded')),e=>e.code==='PROVIDER_RATE_LIMIT');
});

test('subscription preflight and role calls omit USD flags even with an exhausted spec ceiling', async t=>{
 const f=fixture(t,{workflow:{maxSpecCostUsd:0.01}}); const doc=await approved(f,oneTask()); const n=native(f);
 f.life.store.documentEvent(doc.id,'invocation.finished',{invocationId:'historical',usage:{costUsd:50}});
 const agent={...n.agent,usageMode:'subscription',maxBudgetUsd:0.01};
 const options={store:f.life.store,documentId:doc.id,budgetDocumentId:doc.id,repo:f.repo,sha:doc.data.baseSha,role:'qa',agent,passEnv:['PATH'],schema:s.object({answer:s.string(1,100)}),context:{request:'project'}};
 assert.equal((await runRole(options)).answer,'project-answer');
 assert.equal(n.calls().length,2);
 assert.ok(n.calls().every(c=>!c.args.includes('--max-budget-usd')));
 const events=f.life.store.documentEvents(doc.id,['invocation.started']);
 assert.ok(events.every(e=>e.data.usageMode==='subscription'&&e.data.decision.result.monetaryCeiling===null));
 assert.ok(f.life.summary(f.life.get(doc.id)).timing.phases.find(p=>p.phase==='qa').durationMs>0);
});

test('Product preserves a classified quota through the planning error wrapper and summary', async t=>{
 const f=fixture(t); const n=native(f,'claude', `console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,result:'You have hit your weekly limit'}));process.exit(0);`);
 const config={...f.config,roles:{product:{...n.agent,usageMode:'subscription',preflight:'off'}}};
 await assert.rejects(()=>f.life.draft({repo:f.repo,config,request:'Implement the approved arithmetic example.'}),e=>e.code==='PROVIDER_QUOTA');
 const doc=f.life.store.documents('spec')[0];
 assert.equal(doc.data.error.code,'PROVIDER_QUOTA');
 assert.equal(f.life.summary(doc).stop.category,'quota');
 assert.equal(n.calls().length,1);
});

test('changing the QA model requires a new full assessment, unchanged model reuses its checkpoint',async t=>{
 const f=fixture(t);const doc=await approved(f,oneTask());const n=native(f);
 const options={store:f.life.store,documentId:doc.id,budgetDocumentId:doc.id,repo:f.repo,sha:doc.data.baseSha,role:'qa',agent:n.agent,passEnv:['PATH'],schema:s.object({answer:s.string(1,100)}),context:{request:'project'}};
 await runRole(options);await runRole(options);assert.equal(n.calls().length,2);
 await runRole({...options,agent:{...n.agent,model:'new-review-model'}});
 assert.equal(n.calls().length,4);
 const request=JSON.parse(n.calls().at(-1).input.split('\n').at(-1));
 assert.match(request.repair.instruction,/Independently reassess/);
 assert.ok(request.outputSchema.properties.answer);
 assert.ok(!request.outputSchema.properties.patches);
 // A simultaneous schema change must not turn the independent review into a field patch.
 await runRole({...options,agent:{...n.agent,model:'third-review-model'},schema:s.object({answer:s.string(1,100),inspected:s.default(s.array(s.string()),[])})});
 const changed=JSON.parse(n.calls().at(-1).input.split('\n').at(-1));
 assert.match(changed.repair.instruction,/Independently reassess/);
 assert.ok(changed.outputSchema.properties.inspected);
 assert.ok(!changed.outputSchema.properties.patches);
});
test('global implementation tuning cannot replace dedicated QA, but explicit QA amendment can',async t=>{
 const f=fixture(t,{roles:{qa:{type:'claude',model:'review',effort:'high'}}});const doc=await approved(f,oneTask());const a=roleAgent(doc.data.config,'qa','standard');
 f.life.amendBudget(doc.id,{agent:{model:'cheap',effort:'low'}},'Test Owner','Tune implementation without downgrading QA.');
 assert.equal(budgetedAgent(f.life.store,doc.id,a,true,'qa').model,'review');assert.equal(budgetedAgent(f.life.store,doc.id,a,true,'qa').effort,'high');
 assert.equal(budgetedAgent(f.life.store,doc.id,a,true,'implementer').model,'cheap');
 f.life.amendBudget(doc.id,{roles:{qa:{model:'replacement',effort:'high'}}},'Test Owner','Replace the retired QA identifier explicitly.');
 assert.equal(budgetedAgent(f.life.store,doc.id,a,true,'qa').model,'replacement');
 assert.equal(f.life.summary(f.life.get(doc.id)).models.find(m=>m.role==='qa').model,'replacement');
 assert.throws(()=>f.life.amendBudget(doc.id,{roles:{qa:{type:'codex'}}},'Test Owner','Must not change provider through budget.'),/cannot change/);
});
test('explicit model replacement updates only exact provider matches, preserving checks and permissions',t=>{
 const f=fixture(t);const config=applyModelSelection(validateConfig(f.config),selection());
 const next=replaceModel(config,'codex','fast-id','new-id');
 assert.equal(config.agent.model,'fast-id');assert.equal(next.agent.model,'new-id');assert.equal(next.roleProfiles[0].quick.model,'new-id');assert.equal(next.roleProfiles[0].deep.model,'deep-id');assert.equal(next.roles.qa.model,'review-id');
 assert.deepEqual(next.gates,config.gates);assert.deepEqual(next.agent.passEnv,config.agent.passEnv);
 assert.throws(()=>replaceModel(config,'claude','fast-id','new-id'),/No matching/);
});
test('models CLI is offline by default and replacement refuses to overwrite',t=>{
 const f=fixture(t);const config=applyModelSelection(validateConfig(f.config),selection());const input=join(f.root,'config.json');writeFileSync(input,JSON.stringify(config));
 const run=args=>spawnSync(process.execPath,[resolve('dist/cli.js'),...args],{encoding:'utf8',timeout:10000});
 const report=run(['models','check','--config',input]);assert.equal(report.status,0,report.stderr);assert.match(report.stdout,/No model contacted/);assert.match(report.stdout,/review-id/);
 const result=run(['models','replace','--config',input,'--provider','codex','--from','fast-id','--to','replacement','--output',input]);assert.notEqual(result.status,0);assert.equal(JSON.parse(readFileSync(input)).agent.model,'fast-id');
});
test('cancelled probe terminates without a success cache entry',async t=>{
 const f=fixture(t);const doc=await approved(f,oneTask());const n=native(f,'claude',`await new Promise(r=>setTimeout(r,10000));`);const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),150);t.after(()=>clearTimeout(timer));
 await assert.rejects(()=>ensureModelReady(n.agent,probeOptions(f,doc,{signal:controller.signal})),e=>e.code==='CANCELLED');
 assert.ok(!f.life.store.documentEvents(doc.id).some(e=>e.type==='model.preflight_passed'));
});
test('malformed successful probe output is rejected and never cached',async t=>{
 const f=fixture(t);const doc=await approved(f,oneTask());const n=native(f,'claude',`console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{ready:false},total_cost_usd:0.01}));process.exit(0);`);
 for(let attempt=0;attempt<2;attempt++)await assert.rejects(()=>ensureModelReady(n.agent,probeOptions(f,doc)),e=>e.code==='MODEL_CHECK');
 assert.equal(n.calls().length,2);assert.equal(f.life.costSummary(doc.id).knownUsd,0.02);
});
test('relative native executable is resolved from invocation workspace while probe runs outside it',async t=>{
 const f=fixture(t);const doc=await approved(f,oneTask());const n=native(f);
 await ensureModelReady({...n.agent,command:['./claude-model-double.mjs']},probeOptions(f,doc,{cwd:f.root}));
 assert.equal(n.calls().length,1);assert.notEqual(n.calls()[0].cwd,f.root);
});
test('quota stop during preflight preserves the provider explanation and redacts credentials',async t=>{
 const f=fixture(t);const doc=await approved(f,oneTask());const n=native(f,'claude',`console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,result:'Session quota reached; account=secret-test-token',total_cost_usd:0.01}));process.exit(0);`);
 await assert.rejects(()=>ensureModelReady(n.agent,probeOptions(f,doc,{env:{PATH:process.env.PATH,TEST_API_KEY:'secret-test-token'}})),e=>e.code==='MODEL_CHECK'&&/Session quota reached/.test(e.message)&&!/secret-test-token/.test(e.message));
 assert.equal(n.calls().length,1);
});
test('onboard CLI accepts the selection file and rejects conflicting provider flags',t=>{
 const f=fixture(t);const file=join(f.root,'models.json');writeFileSync(file,JSON.stringify(selection()));
 const args=[resolve('dist/cli.js'),'onboard','--repo',f.repo,'--state-dir',f.state,'--models',file,'--quiet'];
 const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:15000});
 assert.ok([0,2].includes(result.status),result.stderr);const plan=JSON.parse(result.stdout);
 assert.equal(plan.models.find(m=>m.role==='qa').model,'review-id');
 const invalid=spawnSync(process.execPath,[...args,'--provider','codex'],{encoding:'utf8',timeout:10000});
 assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/Use --models FILE by itself/);
});
