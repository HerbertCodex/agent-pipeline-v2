import {test} from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../dist/domain/hash.js';
import { proofKey,environmentIdentity,executableIdentity } from '../dist/evidence/key.js';
import { Store } from '../dist/persistence/store.js';
import { fixture,receipt,cfg } from './helpers.mjs';

async function created(f){return f.pipeline.create({repo:f.repo,task:f.task,config:f.config});}
test('optimistic locking rejects a stale writer',async t=>{
 const f=fixture(t);const a=await created(f);const b=f.pipeline.store.get(a.id);f.pipeline.store.save(a,'first');assert.throws(()=>f.pipeline.store.save(b,'stale'),/Stale/);
});
test('run and its event are written together',async t=>{
 const f=fixture(t);const r=await created(f);f.pipeline.store.save(r,'example.change',{answer:42});const last=f.pipeline.store.events(r.id).at(-1);assert.equal(last.type,'example.change');assert.equal(last.data.answer,42);
});
test('concurrent lease acquisition is rejected across connections',async t=>{
 const f=fixture(t);const r=await created(f);const token=f.pipeline.store.acquire(r.id);const other=new Store(f.state);
 try{assert.throws(()=>other.acquire(r.id),/locked/);other.release(r.id,'wrong-token');assert.throws(()=>other.acquire(r.id),/locked/);}finally{other.close();f.pipeline.store.release(r.id,token);}
});
test('recovery cannot steal a live controller lease',async t=>{
 const f=fixture(t);const r=await created(f);const token=f.pipeline.store.acquire(r.id);try{assert.throws(()=>f.pipeline.recover(r.id,true),/still alive/);}finally{f.pipeline.store.release(r.id,token);}
});
test('recovery requires explicit operator confirmation',async t=>{
 const f=fixture(t);const r=await created(f);assert.throws(()=>f.pipeline.recover(r.id,false),/explicit confirmation/);
});
test('recovery refuses a known live child even without a controller lease',async t=>{
 const f=fixture(t);const r=await created(f);const id=f.pipeline.store.startChild(r.id,process.pid);assert.throws(()=>f.pipeline.recover(r.id,true),/still alive/);f.pipeline.store.finishChild(id);
});
test('unsealed successful command cannot populate cache',async t=>{
 const f=fixture(t);const r=await created(f);const proof=receipt('a','passed',{runId:r.id});f.pipeline.store.addReceipt(proof);assert.equal(f.pipeline.store.cached(proof.key),null);
});
test('sealed proof expires and a cache hit cannot extend the original TTL',async t=>{
 const f=fixture(t);const r=await created(f);const proof=receipt('a','passed',{runId:r.id,startedAt:1000,durationMs:10});f.pipeline.store.addReceipt(proof);f.pipeline.store.seal(proof,100);
 assert.equal(f.pipeline.store.cached(proof.key,1050).id,proof.id);assert.equal(f.pipeline.store.cached(proof.key,1111),null);
 const reused=receipt('a','cached',{runId:r.id,startedAt:1050,reusedFrom:proof.id});f.pipeline.store.addReceipt(reused);f.pipeline.store.seal(reused,1000);assert.equal(f.pipeline.store.cached(proof.key,1200),null);
});
test('failed proof is never cached',async t=>{
 const f=fixture(t);const r=await created(f);const proof=receipt('a','failed',{runId:r.id});f.pipeline.store.addReceipt(proof);f.pipeline.store.seal(proof,10000);assert.equal(f.pipeline.store.cached(proof.key),null);
});
test('empty proof identity is rejected, unlike the V1 empty strings defect',async t=>{
 const f=fixture(t);const r=await created(f);assert.throws(()=>f.pipeline.store.addReceipt(receipt('a','passed',{runId:r.id,candidateSha:''})));
});
const input={repository:'/repo',baseSha:'a'.repeat(40),candidateSha:'b'.repeat(40),taskHash:'c'.repeat(64),configHash:'d'.repeat(64),environmentHash:'e'.repeat(64),workspace:'/validation',gate:cfg().gates[0],dependencyKeys:[],executable:{path:'/node',sha256:'f'.repeat(64)}};
for(const [name,change]of Object.entries({candidateSha:'c'.repeat(40),baseSha:'d'.repeat(40),configHash:'f'.repeat(64),environmentHash:'a'.repeat(64),taskHash:'b'.repeat(64),workspace:'/other',repository:'/fork',dependencyKeys:['different'],executable:{path:'/node',sha256:'0'.repeat(64)},gate:{...input.gate,command:['another-command']}}))
 test(`evidence key invalidates when ${name} changes`,()=>assert.notEqual(proofKey(input),proofKey({...input,[name]:change})));
test('full lockfile mutation contributes a different candidate identity',()=>{
 const oldLock={lockfileVersion:3,packages:{'node_modules/foo':{version:'1.0.0'}}};const newLock={lockfileVersion:3,packages:{'node_modules/foo':{version:'1.1.0'}}};
 assert.notEqual(hash(oldLock),hash(newLock));assert.notEqual(proofKey({...input,candidateSha:hash(oldLock)}),proofKey({...input,candidateSha:hash(newLock)}));
});
test('environment id and allowed values affect identity without persisting plaintext',()=>{
 assert.notEqual(environmentIdentity('a',{TOKEN:'x'},{}),environmentIdentity('a',{TOKEN:'y'},{}));assert.notEqual(environmentIdentity('a',{},{}),environmentIdentity('b',{},{}));
});
test('executable identity hashes the actual binary',async()=>{
 const id=await executableIdentity(process.execPath,process.cwd(),process.env);assert.match(id.sha256,/^[a-f0-9]{64}$/);
});
