import test from 'node:test';
import assert from 'node:assert/strict';
import { taskSchema, MAX_TASK_DESCRIPTION, DEFAULT_LIMITS } from '../dist/domain/contracts.js';

const task = (description) => ({ id: 'T1', title: 'Task', description, acceptance: ['works'], allowedPaths: ['src/**'] });

test('task description holds a threat-modelled UI spec context beyond 30k chars', () => {
  assert.equal(DEFAULT_LIMITS.maxTaskContextChars, 120000);
  assert.equal(MAX_TASK_DESCRIPTION, 400000);
  assert.equal(taskSchema.parse(task('x'.repeat(46000))).description.length, 46000);
});

test('task description remains bounded', () => {
  assert.throws(() => taskSchema.parse(task('x'.repeat(MAX_TASK_DESCRIPTION + 1))));
});
