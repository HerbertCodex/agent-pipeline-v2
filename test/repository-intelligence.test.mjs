import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRepository } from '../dist/knowledge/repository.js';
import { focusedIntelligence } from '../dist/knowledge/focus.js';
import { fixture, git } from './lifecycle-helpers.mjs';

test('selected context reports omitted declarations and retains task files and referencing tests', () => {
  const declarations = Array.from({length:200},(_,i)=>({name:`operation${i}`,path:`src/unit${i}.mjs`,line:1,kind:'function'}));
  const source = {sha:'a'.repeat(40),fileCount:200,manifests:[],architectureFiles:[],securityFiles:[],relevantFiles:['src/unit0.mjs'],reuseCandidates:[],
    inventory:{sha:'a'.repeat(40),languages:[],unitExtensions:[],exported:declarations,units:declarations.map(d=>d.path),omitted:{exported:4,units:3,internalSymbols:0,testFiles:0},truncated:false,note:'full'},
    referencingTests:[{path:'test/unit199.test.mjs',tokens:['unit199'],outsideScope:true}],note:'full'};
  const selected = focusedIntelligence(source,['src/unit199.mjs']);
  assert.deepEqual(selected.inventory.exported.map(d=>d.name),['operation0','operation199']);
  assert.equal(selected.inventory.omitted.exported,202);
  assert.deepEqual(selected.referencingTests,source.referencingTests);
  assert.ok(JSON.stringify(selected).length < JSON.stringify(source).length);
  assert.equal(source.inventory.exported.length,200);
});

test('repository intelligence surfaces reuse candidates and follows the current immutable SHA', async (t) => {
  const f = fixture(t);
  const oldSha = git(f.repo, 'rev-parse', 'HEAD');
  const before = await inspectRepository(f.repo, oldSha, 'reuse addition add arithmetic');
  assert.ok(before.reuseCandidates.some(x => x.name === 'add' && x.path === 'src/math.mjs'));
  writeFileSync(join(f.repo, 'src/loans.mjs'), 'export function calculateDueDate(start, days) { return new Date(start.getTime() + days * 86400000); }\n');
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'add reusable loan helper');
  const newSha = git(f.repo, 'rev-parse', 'HEAD');
  const stale = await inspectRepository(f.repo, oldSha, 'calculate due date loan');
  const current = await inspectRepository(f.repo, newSha, 'calculate due date loan');
  assert.equal(stale.reuseCandidates.some(x => x.name === 'calculateDueDate'), false);
  assert.ok(current.reuseCandidates.some(x => x.name === 'calculateDueDate' && x.path === 'src/loans.mjs'));
  assert.equal(current.sha, newSha);
});
