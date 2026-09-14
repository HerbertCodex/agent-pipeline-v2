import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRepository } from '../dist/knowledge/repository.js';
import { fixture, git } from './lifecycle-helpers.mjs';

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
