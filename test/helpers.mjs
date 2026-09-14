import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Pipeline } from '../dist/index.js';
import { validateConfig,taskSchema } from '../dist/domain/contracts.js';
export function git(repo,...args) {
  return execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{
    cwd: repo,encoding: 'utf8',stdio: ['ignore','pipe','pipe'],env: {...process.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@localhost',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@localhost'},
  }).trim();
}
export const baseTask = { id:'TASK-1',title:'Fix addition',description:'Correct add(a,b) so it returns a + b.',acceptance:['add(2,3) returns 5','add(-2,3) returns 1'],allowedPaths:['src/math.mjs'] };
export const worker = (code = "writeFileSync('src/math.mjs','export const add = (a, b) => a + b;\\n');") => [process.execPath,'--input-type=module','-e',`
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8'));
${code}
console.log(JSON.stringify({summary:'Deterministic test worker completed its edit.'}));
`];
export function rawConfig(overrides={}) {
  return {schemaVersion:1,executionMode:'local-trusted',environment:{id:'test-fixture-v1'},agent:{type:'command',command:worker()},
    gates:[{id:'unit',command:[process.execPath,'--test','test/math.test.mjs']}],
    maxRunMs:15000,maxRepairAttempts:0,...overrides};
}
export const cfg = (overrides={}) => validateConfig(rawConfig(overrides));
export const task = (overrides={}) => taskSchema.parse({...baseTask,...overrides});
export function fixture(t,options={}) {
  const root=mkdtempSync(join(tmpdir(),'apv2-test-'));const repo=join(root,'repo');mkdirSync(repo);
  const files={
    '.gitignore':'node_modules/\ndist/\n',
    'README.md':'# Fixture\n',
    'docs/guide.md':'Old guide.\n',
    'src/math.mjs':'export const add = (a, b) => a - b;\n',
    'test/math.test.mjs':"import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from '../src/math.mjs';test('addition',()=>{assert.equal(add(2,3),5);assert.equal(add(-2,3),1)});\n",
    ...options.files,
  };
  for (const [p,text] of Object.entries(files)) {mkdirSync(dirname(join(repo,p)),{recursive:true});writeFileSync(join(repo,p),text);}
  git(repo,'init','-q');git(repo,'add','.');git(repo,'commit','-qm','fixture');
  const state=join(root,'state');const pipeline=new Pipeline(state);
  t.after(()=>{try{pipeline.close();}catch{}rmSync(root,{recursive:true,force:true});});
  const config=rawConfig(options.config);const taskValue={...baseTask,...options.task};
  return {root,repo,state,pipeline,config,task:taskValue,start:()=>pipeline.start({repo,task:taskValue,config})};
}
export function receipt(gateId='gate',status='passed',extra={}) {
  return {id:crypto.randomUUID(),runId:'run',gateId,key:'a'.repeat(64),candidateSha:'b'.repeat(40),configHash:'c'.repeat(64),environmentHash:'d'.repeat(64),
    status,startedAt:Date.now(),durationMs:1,exitCode:['passed','cached'].includes(status)?0:1,stdoutHash:'0'.repeat(64),stderrHash:'0'.repeat(64),diagnostic:'',reusedFrom:null,...extra};
}
