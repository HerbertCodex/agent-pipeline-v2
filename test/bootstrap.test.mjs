import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/persistence/store.js';
import { planBootstrap, refineBootstrap, applyBootstrap } from '../dist/lifecycle/bootstrap.js';
import { roleAgent } from '../dist/adapters/routing.js';

const run = (cwd,args) => {
  const r=spawnSync(args[0],args.slice(1),{cwd,encoding:'utf8'});
  assert.equal(r.status,0,`${args.join(' ')}\n${r.stderr}`); return r.stdout.trim();
};

test('explicit selection uses deep Codex for bootstrap, Claude for review, and survives onboarding', async t => {
  const f=fixture(); const store=new Store(f.state); t.after(()=>store.close());
  const bin=join(f.root,'bin'); mkdirSync(bin); const log=join(f.root,'native-calls.jsonl');
  const wrapper=join(bin,'native.mjs');
  writeFileSync(wrapper,`#!${process.execPath}\nimport {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);if(args.includes('--version')){console.log('fixture 1');process.exit(0);}
const text=readFileSync(0,'utf8');const probe=text.startsWith('Compatibility check only.');
const request=probe?null:JSON.parse(text.slice(text.indexOf('{')));
appendFileSync(${JSON.stringify(log)},JSON.stringify({probe,model:args[args.indexOf('--model')+1],protocol:request?.protocol})+'\\n');
let value={ready:true};if(!probe){const r=spawnSync(process.execPath,[${JSON.stringify(f.worker)}],{input:JSON.stringify(request),encoding:'utf8'});if(r.status!==0)process.exit(4);value=JSON.parse(r.stdout);}
if(args.includes('exec')){writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(value));console.log(JSON.stringify({type:'turn.completed'}));}
else console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:value,total_cost_usd:0.01}));
`,{mode:0o700});
  symlinkSync(wrapper,join(bin,'codex')); symlinkSync(wrapper,join(bin,'claude'));
  const oldPath=process.env.PATH;process.env.PATH=bin+':'+oldPath;t.after(()=>{process.env.PATH=oldPath;});
  const selection={quick:{provider:'codex',model:'quick-test',effort:'low'},deep:{provider:'codex',model:'deep-test',effort:'high'},qa:{provider:'claude',model:'qa-test',effort:'high'}};
  const doc=await planBootstrap(store,f.repo,'Create a minimal Node application with an addition function.',undefined,undefined,'solo',selection);
  const calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c=>[c.model,c.probe]),[['deep-test',true],['deep-test',false],['qa-test',true],['qa-test',false]]);
  assert.equal(calls[3].protocol,'agent-pipeline/bootstrap-review-v1');
  const result=await applyBootstrap(store,doc.id,doc.data.hash,'Test Owner','Approve the explicit profiles and bootstrap.',true);
  assert.equal(roleAgent(result.onboarding.data.config,'qa','standard').model,'qa-test');
  assert.equal(roleAgent(result.onboarding.data.config,'implementer','standard').model,'quick-test');
  assert.equal(roleAgent(result.onboarding.data.config,'implementer','high').model,'deep-test');
});
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'apv2-bootstrap-test-'));
  const repo=join(root,'app'); run(root,['git','init',repo]);
  const worker=join(root,'worker.mjs');
  writeFileSync(worker,String.raw`let text='';for await (const c of process.stdin) text+=c;const input=JSON.parse(text);
const decision={id:'D-STACK',subject:'Runtime stack',value:'Native Node ESM',enforcement:'bootstrap',status:'confirmed',source:'operator',sourceQuote:'minimal Node application',rationale:'The operator explicitly asked for a minimal Node application.',supersedes:[]};
if(input.protocol==='agent-pipeline/bootstrap-v2'){console.log(JSON.stringify({projectType:'backend',summary:'Minimal Node application with a real built-in test.',architecture:{summary:'A small dependency-free Node module fits the requested arithmetic bootstrap and keeps the initial surface minimal.',decisions:[{decision:'Use native Node ESM with node:test.',rationale:'The request needs one small function and a real test without adding framework complexity.',evidence:['The operator explicitly requested a minimal Node application.','Node >=22.16 is already required by the framework.'],alternatives:[{option:'Add a web framework',reasonNotChosen:'No HTTP or UI requirement exists in the bootstrap request.'}],tradeoffs:['Deliberately minimal; a framework may be added if later requirements justify it.'],reconsiderWhen:['The application needs HTTP routing, persistence, UI, or external packages.']}]},decisions:[decision],decisionCoverage:[{decisionId:'D-STACK',status:'satisfied',evidence:[{kind:'file',reference:'package.json',detail:'ESM package manifest implements the selected runtime.'}]}],files:[{path:'package.json',content:JSON.stringify({name:'new-app',private:true,type:'module',scripts:{test:'node --test'}} ,null,2)+'\n'},{path:'package-lock.json',content:JSON.stringify({name:'new-app',lockfileVersion:3,requires:true,packages:{'':{name:'new-app'}}},null,2)+'\n'},{path:'src/add.js',content:'export const add=(a,b)=>a+b;\n'},{path:'test/add.test.js',content:"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\ntest('adds',()=>assert.equal(add(1,2),3));\n"}],questions:[],productQuestions:[],deferredQuestions:[],notes:['No dependencies required.']}));}
else if(input.protocol==='agent-pipeline/bootstrap-review-v1'){console.log(JSON.stringify({verdict:'pass',summary:'Proposal matches the explicit Node decision.',decisions:[{decisionId:'D-STACK',status:'pass',evidence:'package.json uses native Node ESM and no conflicting framework is proposed.'}],missingOperatorDecisions:[],findings:[]}));}
else process.exit(3);`);
  return {root,repo,worker,state:join(root,'state')};
}

test('empty Git repository is planned without writes, then committed and handed to onboard', async () => {
  const f=fixture(); const store=new Store(f.state);
  try {
    const doc=await planBootstrap(store,f.repo,'Create a minimal Node application with an addition function.',{type:'command',command:[process.execPath,f.worker],timeoutMs:30000,passEnv:[]});
    assert.equal(doc.data.proposal.files.length,4);
    assert.equal(existsSync(join(f.repo,'package.json')),false);
    const head=spawnSync('git',['rev-parse','--verify','HEAD'],{cwd:f.repo,encoding:'utf8'});
    assert.notEqual(head.status,0);
  } finally { store.close(); }
});

test('bootstrap accepts the Git repository root through a symlinked ancestor', async () => {
  const root=mkdtempSync(join(tmpdir(),'apv2-bootstrap-realpath-'));
  const physical=join(root,'physical'); mkdirSync(physical);
  const alias=join(root,'alias'); symlinkSync(physical,alias,'dir');
  const repo=join(alias,'app'); run(root,['git','init',repo]);
  const worker=join(root,'worker.mjs');
  writeFileSync(worker,String.raw`let text='';for await (const c of process.stdin) text+=c;const input=JSON.parse(text);
const decision={id:'D-STACK',subject:'Runtime stack',value:'Native Node ESM',enforcement:'bootstrap',status:'confirmed',source:'operator',sourceQuote:'minimal Node application',rationale:'The operator explicitly asked for a minimal Node application.',supersedes:[]};
if(input.protocol==='agent-pipeline/bootstrap-v2'){console.log(JSON.stringify({projectType:'backend',summary:'Minimal Node application.',architecture:{summary:'A minimal dependency-free Node scaffold matches the request.',decisions:[{decision:'Use native Node ESM.',rationale:'No framework is required for the requested bootstrap.',evidence:['The operator requested a minimal Node application.'],alternatives:[],tradeoffs:[],reconsiderWhen:['The application needs a framework.']}]},decisions:[decision],decisionCoverage:[{decisionId:'D-STACK',status:'satisfied',evidence:[{kind:'file',reference:'package.json',detail:'ESM package manifest implements the selected runtime.'}]}],files:[{path:'package.json',content:JSON.stringify({name:'new-app',private:true,type:'module'},null,2)+'\n'}],questions:[],productQuestions:[],deferredQuestions:[],notes:[]}));}
else if(input.protocol==='agent-pipeline/bootstrap-review-v1'){console.log(JSON.stringify({verdict:'pass',summary:'Proposal matches the explicit Node decision.',decisions:[{decisionId:'D-STACK',status:'pass',evidence:'package.json uses native Node ESM.'}],missingOperatorDecisions:[],findings:[]}));}
else process.exit(3);`);
  const store=new Store(join(root,'state'));
  try {
    const doc=await planBootstrap(store,repo,'Create a minimal Node application.',{type:'command',command:[process.execPath,worker],timeoutMs:30000,passEnv:[]});
    assert.equal(doc.data.directory,repo);
    assert.equal(doc.data.semanticReview.verdict,'pass');
    assert.equal(doc.data.hash.length,64);
  } finally { store.close(); }
});

test('bootstrap apply requires explicit commit and creates immutable base + onboarding plan', async () => {
  const f=fixture(); const store=new Store(f.state);
  try {
    const doc=await planBootstrap(store,f.repo,'Create a minimal Node application with an addition function.',{type:'command',command:[process.execPath,f.worker],timeoutMs:30000,passEnv:[]},undefined,'solo');
    assert.equal(doc.data.reviewMode,'solo');
    assert.equal(existsSync(join(f.repo,'package.json')),false);
    await assert.rejects(()=>applyBootstrap(store,doc.id,doc.data.hash,'Herbert','Reviewed bootstrap manifest and approve creation.',false),/requires --commit/);
    const result=await applyBootstrap(store,doc.id,doc.data.hash,'Herbert','Reviewed bootstrap manifest and approve creation.',true);
    assert.equal(readFileSync(join(f.repo,'src/add.js'),'utf8'),'export const add=(a,b)=>a+b;\n'); const arch = readFileSync(join(f.repo,'.agent-pipeline/ARCHITECTURE.md'),'utf8'); assert.match(arch,/Why|Evidence|Reconsider|reconsider/i); assert.match(arch,/native Node ESM/i); assert.ok(existsSync(join(f.repo,'.agent-pipeline/DECISIONS.json'))); const ledger=JSON.parse(readFileSync(join(f.repo,'.agent-pipeline/DECISIONS.json'),'utf8')); assert.equal(ledger.decisions[0].id,'D-STACK');
    assert.match(run(f.repo,['git','rev-parse','HEAD']),/^[a-f0-9]{40}$/);
    assert.equal(run(f.repo,['git','status','--porcelain']),'');
    assert.equal(result.bootstrap.data.applied,true);
    assert.ok(result.onboarding.data.hash.length>10);
    assert.equal(result.onboarding.data.inventory.stack,'node-javascript');
    assert.equal(result.onboarding.data.questions.length,0);
    assert.equal(result.onboarding.data.config.workflow.reviewMode,'solo');
  } finally { store.close(); }
});

test('bootstrap rejects .git paths and non-empty targets', async () => {
  const f=fixture(); const store=new Store(f.state);
  try {
    writeFileSync(join(f.repo,'keep.txt'),'existing\n');
    await assert.rejects(()=>planBootstrap(store,f.repo,'Create a minimal project safely.',{type:'command',command:[process.execPath,f.worker],timeoutMs:30000,passEnv:[]}),/must contain no application files/);
  } finally { store.close(); }
});


test('semantic review blocks a schema-valid proposal that contradicts an operator decision', async () => {
  const f=fixture(); const bad=join(f.root,'bad-worker.mjs');
  writeFileSync(bad,String.raw`let text='';for await(const c of process.stdin)text+=c;const input=JSON.parse(text);if(input.protocol==='agent-pipeline/bootstrap-v2'){console.log(JSON.stringify({projectType:'fullstack',summary:'Schema-valid but semantically wrong.',architecture:{summary:'Wrong auth choice despite explicit request.',decisions:[{decision:'Use member-number login',rationale:'Wrong on purpose for regression.',evidence:['fixture'],alternatives:[],tradeoffs:[],reconsiderWhen:['operator corrects it']}]},decisions:[{id:'D-AUTH',subject:'Authentication',value:'email/password',enforcement:'bootstrap',status:'confirmed',source:'operator',sourceQuote:'email/password',rationale:'Explicit operator choice.',supersedes:[]}],decisionCoverage:[{decisionId:'D-AUTH',status:'satisfied',evidence:[{kind:'file',reference:'src/auth.txt',detail:'Worker falsely claims coverage.'}]}],files:[{path:'src/auth.txt',content:'Login with member number\\n'}],questions:[],productQuestions:[],deferredQuestions:[],notes:[]}));}else if(input.protocol==='agent-pipeline/bootstrap-review-v1'){console.log(JSON.stringify({verdict:'changes_requested',summary:'Authentication contradicts the operator decision.',decisions:[{decisionId:'D-AUTH',status:'fail',evidence:'The file says member number while the request says email/password.'}],missingOperatorDecisions:[],findings:[{severity:'blocker',description:'Authentication method is inconsistent.'}]}));}else process.exit(3);`);
  const store=new Store(f.state); try {
    const doc=await planBootstrap(store,f.repo,'Create a web app with email/password authentication.',{type:'command',command:[process.execPath,bad],timeoutMs:30000,passEnv:[]});
    assert.equal(doc.data.semanticReview.verdict,'changes_requested'); assert.equal(doc.data.hash,'');
    await assert.rejects(()=>applyBootstrap(store,doc.id,'a'.repeat(64),'Herbert','Reviewed invalid bootstrap proposal.',true),/semantic consistency/i);
    assert.equal(existsSync(join(f.repo,'src/auth.txt')),false);
  } finally { store.close(); }
});

test('bootstrap refine preserves confirmed operator decisions unless latest refinement explicitly supersedes them', async () => {
  const f=fixture(); const store=new Store(f.state); try {
    const doc=await planBootstrap(store,f.repo,'Create a minimal Node application with an addition function.',{type:'command',command:[process.execPath,f.worker],timeoutMs:30000,passEnv:[]});
    const refined=await refineBootstrap(store,doc.id,'Keep the same Node stack and add documentation.');
    assert.equal(refined.data.proposal.decisions.find(d=>d.id==='D-STACK').value,'Native Node ESM');
    assert.equal(refined.data.revision,2); assert.equal(refined.data.semanticReview.verdict,'pass');
  } finally { store.close(); }
});

test('approval-with-exception wording cannot be silently converted into a confirmed decision', async () => {
  const f=fixture(); const bad=join(f.root,'ambiguous-as-confirmed.mjs');
  writeFileSync(bad,String.raw`let text='';for await(const c of process.stdin)text+=c;const input=JSON.parse(text);if(input.protocol==='agent-pipeline/bootstrap-v2'){console.log(JSON.stringify({projectType:'fullstack',summary:'Incorrectly resolves ambiguous multi-site wording.',architecture:{summary:'Neutral fixture architecture for ambiguity regression.',decisions:[{decision:'Use a neutral web scaffold',rationale:'Fixture only; business scope should remain unresolved.',evidence:['operator request'],alternatives:[],tradeoffs:[],reconsiderWhen:['product scope changes']}]},decisions:[{id:'D-MULTI',subject:'Multi-site scope',value:'included in MVP',enforcement:'product',status:'confirmed',source:'operator',sourceQuote:'je valide le mvp et le hors mvp; sauf le multi sites',rationale:'Wrongly guessed interpretation.',supersedes:[]}],decisionCoverage:[],files:[{path:'README.md',content:'# App\n'}],questions:[],productQuestions:[],deferredQuestions:[],notes:[]}));}else if(input.protocol==='agent-pipeline/bootstrap-review-v1'){console.log(JSON.stringify({verdict:'pass',summary:'Should never be reached.',decisions:[{decisionId:'D-MULTI',status:'pass',evidence:'wrong'}],missingOperatorDecisions:[],findings:[]}));}else process.exit(3);`);
  const store=new Store(f.state); try {
    await assert.rejects(()=>planBootstrap(store,f.repo,'Je veux une app web. je valide le mvp et le hors mvp; sauf le multi sites',{type:'command',command:[process.execPath,bad],timeoutMs:30000,passEnv:[]}),/ambiguous|exception|DECISION_AMBIGUOUS/i);
    assert.equal(existsSync(join(f.repo,'README.md')),false);
  } finally { store.close(); }
});

test('ambiguous Product decision may cross neutral bootstrap, then requires explicit superseding clarification', async () => {
  const f=fixture(); const worker=join(f.root,'ambiguity-worker.mjs');
  writeFileSync(worker,String.raw`let text='';for await(const c of process.stdin)text+=c;const input=JSON.parse(text);if(input.protocol==='agent-pipeline/bootstrap-v2'){const previous=input.previousProposal;if(!previous){console.log(JSON.stringify({projectType:'fullstack',summary:'Neutral scaffold; multi-site scope remains a Product ambiguity.',architecture:{summary:'The initial web substrate does not need to encode multi-site business policy.',decisions:[{decision:'Keep business site policy out of bootstrap',rationale:'The exception wording has more than one material interpretation and is not required for a neutral scaffold.',evidence:['operator wording is ambiguous'],alternatives:[{option:'Guess inclusion',reasonNotChosen:'Would invent product scope.'},{option:'Guess exclusion',reasonNotChosen:'Would invent product scope.'}],tradeoffs:['Product must clarify before spec approval.'],reconsiderWhen:['operator clarifies the multi-site scope']}]},decisions:[{id:'D-MULTI',subject:'Multi-site scope',value:'unresolved',enforcement:'product',status:'ambiguous',source:'operator',sourceQuote:'je valide le mvp et le hors mvp; sauf le multi sites',rationale:'The scope of the exception is not safe to infer.',supersedes:[],clarificationQuestion:'Souhaitez-vous inclure le multi-site dans le MVP, ou le laisser hors MVP ?',interpretations:['Multi-site is included in the MVP.','Multi-site remains outside the MVP.']}],decisionCoverage:[],files:[{path:'README.md',content:'# Library app\n'}],questions:[],productQuestions:['Souhaitez-vous inclure le multi-site dans le MVP, ou le laisser hors MVP ?'],deferredQuestions:[],notes:[]}));}else{console.log(JSON.stringify({projectType:'fullstack',summary:'Neutral scaffold with clarified multi-site scope recorded for Product.',architecture:previous.architecture,decisions:[{id:'D-MULTI-RESOLVED',subject:'Multi-site scope',value:'outside MVP',enforcement:'product',status:'confirmed',source:'operator',sourceQuote:'Le multi-site reste hors MVP.',rationale:'Explicit clarification from the operator.',supersedes:['D-MULTI'],clarificationQuestion:'',interpretations:[]}],decisionCoverage:[],files:[{path:'README.md',content:'# Library app\n'}],questions:[],productQuestions:[],deferredQuestions:[],notes:[]}));}}else if(input.protocol==='agent-pipeline/bootstrap-review-v1'){const d=input.decisionLedger.decisions[0];console.log(JSON.stringify({verdict:'pass',summary:d.status==='ambiguous'?'Product ambiguity is preserved and does not affect the neutral scaffold.':'The explicit clarification is preserved.',decisions:[{decisionId:d.id,status:d.status==='ambiguous'?'ambiguous':'pass',evidence:'The neutral scaffold does not decide multi-site business behavior.'}],missingOperatorDecisions:[],findings:[]}));}else process.exit(3);`);
  const store=new Store(f.state); try {
    const first=await planBootstrap(store,f.repo,'Je veux une app web. je valide le mvp et le hors mvp; sauf le multi sites',{type:'command',command:[process.execPath,worker],timeoutMs:30000,passEnv:[]},undefined,'solo');
    assert.equal(first.data.proposal.decisions[0].status,'ambiguous');
    assert.equal(first.data.proposal.questions.length,0);
    assert.equal(first.data.proposal.productQuestions.length,1);
    assert.equal(first.data.semanticReview.verdict,'pass');
    assert.equal(first.data.hash.length,64);
    const refined=await refineBootstrap(store,first.id,'Le multi-site reste hors MVP.');
    assert.equal(refined.data.proposal.decisions[0].status,'confirmed');
    assert.deepEqual(refined.data.proposal.decisions[0].supersedes,['D-MULTI']);
    assert.equal(refined.data.proposal.productQuestions.length,0);
    assert.equal(refined.data.semanticReview.verdict,'pass');
    assert.equal(refined.data.hash.length,64);
  } finally { store.close(); }
});
