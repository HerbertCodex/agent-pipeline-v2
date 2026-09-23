import {test} from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../dist/domain/hash.js';
import { validateReceipt } from '../dist/domain/contracts.js';
import { proofKey,environmentIdentity,executableIdentity } from '../dist/evidence/key.js';
import { receipt,cfg } from './helpers.mjs';

test('empty proof identity is rejected, unlike the V1 empty strings defect',()=>{
 assert.throws(()=>validateReceipt(receipt('a','passed',{candidateSha:''})));
});
test('a successful receipt requires exit 0 and both stream digests',()=>{
 assert.equal(validateReceipt(receipt('a','passed')).status,'passed');
 assert.throws(()=>validateReceipt(receipt('a','passed',{exitCode:1})),/exit 0/);
 assert.throws(()=>validateReceipt(receipt('a','passed',{stdoutHash:''})),/digests/);
 assert.throws(()=>validateReceipt(receipt('a','failed',{reusedFrom:'other'})),/cache hits/);
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
