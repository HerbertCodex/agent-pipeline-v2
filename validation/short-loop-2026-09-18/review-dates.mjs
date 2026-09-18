// Independent post-run review probes. These were not part of the model's fixed oracle.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

if (!process.argv[2]) throw new Error('Usage: node review-dates.mjs TRUSTED_CANDIDATE_DATES_MODULE');
const { isOverdue } = await import(pathToFileURL(resolve(process.argv[2])));
const probes = [
  ['century is not a leap year', () => assert.throws(() => isOverdue('2100-02-29', '2100-03-01'), RangeError)],
  ['400-year boundary is a leap year', () => assert.equal(isOverdue('2000-02-29', '2000-03-01'), true)],
  ['lower year bound', () => assert.throws(() => isOverdue('0999-12-31', '1000-01-01'), RangeError)],
  ['reject trailing newline', () => assert.throws(() => isOverdue('2026-09-18\n', '2026-09-19'), RangeError)],
  ['null-prototype non-string input', () => assert.throws(() => isOverdue(Object.create(null), '2026-09-19'), RangeError)],
  ['invalid input must not execute user coercion', () => {
    let calls = 0;
    const value = { toString() { calls++; throw new Error('Coercion must not run'); } };
    assert.throws(() => isOverdue(value, '2026-09-19'), RangeError);
    assert.equal(calls, 0);
  }],
];
const results = probes.map(([name, check]) => {
  try { check(); return { name, passed: true }; }
  catch (error) { return { name, passed: false, error: error.message }; }
});
console.log(JSON.stringify({ independentReview: true, results }, null, 2));
if (results.some(r => !r.passed)) process.exitCode = 1;
