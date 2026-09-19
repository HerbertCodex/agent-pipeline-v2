import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit, inventorySources, coverageErrors } from '../scripts/audit-errors.mjs';

const source = text => inventorySources([{ file: 'src/fixture.ts', text }]);
const group = codes => ({ id: 'fixture', codes, operator: 'conditional', operatorAction: 'Inspect retained work.',
  currentGuidance: 'A diagnostic exists.', gap: 'State-specific recovery still needs validation.' });

test('every emitted code has a recovery disposition and dynamic forwarding stays reviewed', () => {
  const { inventory, errors } = audit();
  assert.ok(inventory.invariants > 0);
  assert.deepEqual(errors, []);
});

test('the inventory finds aliases, multiline/conditional codes and stored fallback errors', () => {
  const inventory = source(`
    import { invariant as ensure, PipelineError as Failure } from './errors.js';
    import * as errors from './errors.js';
    // invariant(false, 'COMMENT', 'ignored');
    const prose = "invariant(false, 'STRING', 'ignored')";
    ensure(false, flag ? 'BAD_INPUT' : 'STALE', 'message');
    throw new Failure('NEW_FAILURE', 'message');
    errors.invariant(false, 'NAMESPACE', 'message');
    const fallback = 'WORKFLOW';
    const code = known ? error.code : fallback;
    const report = { code };
    const other = { 'code': flag ? 'EXTERNAL' : 'INTERNAL' };
    const rpc = {code: -32600};
  `);
  assert.equal(inventory.invariants, 2);
  assert.deepEqual(inventory.codes, ['BAD_INPUT', 'EXTERNAL', 'INTERNAL', 'NAMESPACE', 'NEW_FAILURE', 'STALE', 'WORKFLOW']);
  assert.deepEqual(inventory.dynamic.map(x => x.expression), ['error.code']);
});

test('a new code fails coverage until an operator action or justified maintainer disposition is declared', () => {
  const inventory = source(`invariant(false, 'NEW_BLOCK', 'message');`);
  assert.deepEqual(coverageErrors(inventory, { groups: [], forwarding: [] }), ['Undeclared recovery disposition: NEW_BLOCK']);
  const disposition = group(['NEW_BLOCK']);
  assert.deepEqual(coverageErrors(inventory, { groups: [disposition], forwarding: [] }), []);
  disposition.operatorAction = '';
  assert.match(coverageErrors(inventory, { groups: [disposition], forwarding: [] }).join('\n'), /Missing operatorAction/);
});

test('computed error codes cannot silently evade coverage, including a new use of existing forwarding', () => {
  const inventory = source(`throw new PipelineError(selectCode(), 'message');`);
  assert.equal(inventory.dynamic.length, 1);
  const item = { ...inventory.dynamic[0], count: 1, reason: 'Reviewed producer protocol.' };
  assert.match(coverageErrors(inventory, { groups: [], forwarding: [] })[0], /Unreviewed dynamic/);
  assert.deepEqual(coverageErrors(inventory, { groups: [], forwarding: [item] }), []);
  const twice = source(`throw new PipelineError(selectCode(), 'message'); throw new PipelineError(selectCode(), 'again');`);
  assert.match(coverageErrors(twice, { groups: [], forwarding: [item] })[0], /Changed dynamic/);
});

test('obsolete codes and duplicate classifications fail rather than inflate reported coverage', () => {
  const inventory = source(`invariant(false, 'CURRENT', 'message');`);
  const errors = coverageErrors(inventory, { groups: [group(['CURRENT', 'OLD']), group(['CURRENT'])], forwarding: [] });
  assert.deepEqual(errors, ['Obsolete code: OLD', 'Duplicate code: CURRENT']);
});
