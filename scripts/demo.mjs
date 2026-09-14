import {mkdtempSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {Pipeline,summarize} from '../dist/index.js';
import {makeDemo,git} from '../examples/fixture.mjs';
const{values}=parseArgs({options:{output:{type:'string'}}});
let root;
if(values.output){root=resolve(values.output);if(existsSync(root))throw new Error('Demo output already exists; choose a new directory.');mkdirSync(root,{recursive:true});}
else root=mkdtempSync(join(tmpdir(),'apv2-demo-'));
const f=makeDemo(root);const p=new Pipeline(f.state);
try{
 const before=git(f.repo,'rev-parse','HEAD');
 const baseline=spawnSync(process.execPath,['--test','test/math.test.mjs'],{cwd:f.repo,encoding:'utf8',env:{PATH:process.env.PATH}});
 if(baseline.status===0)throw new Error('Fixture should fail before the edit.');
 const cold=await p.start(f);if(cold.state!=='awaiting_review')throw new Error(JSON.stringify(cold.error));
 const warm=await p.revalidate(cold.id);if(warm.state!=='awaiting_review')throw new Error(JSON.stringify(warm.error));
 if(!warm.receipts.every(r=>r.status==='cached'))throw new Error('Exact-candidate cache demonstration failed.');
 const ready=await p.approve(warm.id,warm.candidateSha,'DEMO-OPERATOR','SIMULATION ONLY: the deterministic fixture is explicitly approved for this demonstration.');
 const patch=await p.exportPatch(ready.id);writeFileSync(join(root,'candidate.patch'),patch);
 git(f.repo,'apply','--check',join(root,'candidate.patch'));
 if(git(f.repo,'rev-parse','HEAD')!==before || git(f.repo,'status','--porcelain')!=='')throw new Error('Source repository was changed.');
 const report={demonstration:'Offline deterministic worker; no AI call, no real human review, no V1 comparison.',
  root,baselineFailed:baseline.status!==0,sourceUntouched:true,patchApplies:true,
  coldValidationMs:cold.metrics.validationMs,warmValidationMs:warm.metrics.validationMs-cold.metrics.validationMs,
  coldRunActiveMs:cold.metrics.activeMs,warmSessionActiveMs:warm.metrics.activeMs-cold.metrics.activeMs,
  ...summarize(ready)};
 writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');
 writeFileSync(join(root,'events.jsonl'),p.store.events(ready.id).map(e=>JSON.stringify(e)).join('\n')+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{p.close();}
