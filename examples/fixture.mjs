import {mkdirSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
export function git(repo,...args){return execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{
 cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,GIT_AUTHOR_NAME:'Demo',GIT_AUTHOR_EMAIL:'demo@localhost',GIT_COMMITTER_NAME:'Demo',GIT_COMMITTER_EMAIL:'demo@localhost'},
}).trim();}
export function makeDemo(root){
 const repo=join(root,'repo');mkdirSync(repo,{recursive:true});
 const files={'.gitignore':'node_modules/\ndist/\n','README.md':'# Agent Pipeline V2 fixture\n',
  'src/math.mjs':'export const add = (a, b) => a - b;\n',
  'test/math.test.mjs':"import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from '../src/math.mjs';test('addition positive',()=>assert.equal(add(2,3),5));test('addition negative',()=>assert.equal(add(-2,3),1));\n"};
 for(const[p,text]of Object.entries(files)){mkdirSync(dirname(join(repo,p)),{recursive:true});writeFileSync(join(repo,p),text,{flag:'wx'});}
 git(repo,'init','-q');git(repo,'add','.');git(repo,'commit','-qm','demo baseline with a bug');
 const task={id:'DEMO-ADD',title:'Réparer une addition',description:'Corriger add pour les arguments positifs et négatifs.',acceptance:['add(2,3) vaut 5','add(-2,3) vaut 1'],allowedPaths:['src/math.mjs']};
 const config={schemaVersion:1,executionMode:'local-trusted',environment:{id:'offline-demo-v1'},
  agent:{type:'command',command:[process.execPath,fileURLToPath(new URL('./demo-agent.mjs',import.meta.url))]},
  gates:[
   {id:'syntax',command:[process.execPath,'--check','src/math.mjs'],cacheTtlMs:60000},
   {id:'unit',command:[process.execPath,'--test','test/math.test.mjs'],cacheTtlMs:60000},
   {id:'diff-check',command:['git','diff','--check','{{baseSha}}','{{candidateSha}}'],mandatory:true,cacheTtlMs:60000},
  ],concurrency:3,maxRepairAttempts:0,maxRunMs:30000};
 writeFileSync(join(root,'task.json'),JSON.stringify(task,null,2)+'\n');writeFileSync(join(root,'config.json'),JSON.stringify(config,null,2)+'\n');
 return {repo,task,config,state:join(root,'state')};
}
