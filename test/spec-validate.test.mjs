import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { demoSpec, fixture, oneTask, withSecurity, git } from './lifecycle-helpers.mjs';
import { apv, write, decision } from './cli-helpers.mjs';
import { checkSpec, parseSpecDocument, specText } from '../dist/spec/check.js';
import { specIssues, validateSpec } from '../dist/lifecycle/contracts.js';
import { assessSecurity } from '../dist/security/owasp.js';

test('a complete spec is valid and reports the recomputed security minimum', async t => {
  const f = fixture(t);
  const file = write(f.root, 'spec.json', demoSpec());
  const r = await apv(f.repo, ['spec', 'validate', file]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^Spec valide : Multiplication et documentation/);
  assert.match(r.stdout, /Minimum de sécurité : voie fast/);
  const json = (await apv(f.repo, ['spec', 'validate', file, '--json'])).json();
  assert.equal(json.valid, true); assert.equal(json.mode, 'ready'); assert.equal(json.requestSource, 'spec');
  assert.equal(json.sha, git(f.repo, 'rev-parse', 'HEAD'));
});

test('every schema error is listed at once, not only the first', async t => {
  const f = fixture(t);
  const spec = demoSpec(); delete spec.title; spec.autorun = true; spec.minimumLane = 'none'; spec.acceptance[0].id = '../bad';
  const r = await apv(f.repo, ['spec', 'validate', write(f.root, 'spec.json', spec), '--json']);
  assert.equal(r.code, 1);
  const messages = r.json().issues.map(i => i.message).join('\n');
  for (const expected of [/\$\.title: missing required property/, /unknown property autorun/, /\$\.minimumLane: expected fast\|standard\|high/, /\$\.acceptance\[0\]\.id: invalid string/])
    assert.match(messages, expected);
  assert.equal(r.json().issues.length, 4);
});

test('every semantic error is listed, in human output too', async t => {
  const f = fixture(t);
  const spec = demoSpec();
  spec.tasks[0].acceptanceIds.push('AC-MISSING'); spec.tasks[1].dependsOn.push('GHOST'); spec.acceptance.push({ ...spec.acceptance[1] });
  spec.tasks[0].allowedPaths.push('{a,b}');
  const r = await apv(f.repo, ['spec', 'validate', write(f.root, 'spec.json', spec)]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Spec invalide/);
  assert.match(r.stdout, /4 erreur\(s\)/);
  assert.match(r.stdout, /\[SPEC\] Duplicate item id in acceptance: AC-DOC/);
  assert.match(r.stdout, /\[SPEC\] Task MATH references an unknown acceptance criterion: AC-MISSING/);
  assert.match(r.stdout, /\[GLOB\] Unsupported glob: \{a,b\}/);
  assert.match(r.stdout, /\[SPEC_DAG\] Missing dependency GHOST \(required by DOC\)/);
});

test('the V2 contract still throws the first error only', () => {
  const spec = demoSpec(); spec.tasks[0].acceptanceIds.push('AC-MISSING'); spec.tasks[1].dependsOn.push('GHOST');
  assert.equal(specIssues(spec).length, 2);
  assert.throws(() => validateSpec(spec), /AC-MISSING/);
  const cycle = demoSpec(); cycle.tasks[0].dependsOn.push('DOC');
  assert.deepEqual(specIssues(cycle).map(i => i.code), ['SPEC_DAG']);
});

test('incident 14: the security minimum is recomputed from the request, as at launch', async t => {
  const f = fixture(t);
  const request = 'Expose a REST API endpoint with login and session cookies.';
  const plain = write(f.root, 'plain.json', oneTask());
  // Valid against the spec text alone: nothing security-sensitive is written there.
  assert.equal((await apv(f.repo, ['spec', 'validate', plain])).code, 0);
  const refused = await apv(f.repo, ['spec', 'validate', plain, '--request', request, '--json']);
  assert.equal(refused.code, 1);
  const security = refused.json().issues.find(i => i.code === 'SPEC_SECURITY');
  assert.ok(security, JSON.stringify(refused.json().issues));
  const expected = assessSecurity({ text: request, files: ['src/math.mjs', 'test/math.test.mjs'] });
  for (const topic of expected.topics.map(x => x.id)) assert.match(security.message, new RegExp(topic));
  assert.deepEqual(refused.json().security.topics, expected.topics.map(x => x.id));
  // The same request stored in the document gives the same minimum; a spec covering it is valid.
  const covered = write(f.root, 'covered.json', { request, spec: withSecurity(oneTask(), request) });
  const ok = await apv(f.repo, ['spec', 'validate', covered, '--json']);
  assert.equal(ok.code, 0, JSON.stringify(ok.json().issues));
  assert.equal(ok.json().requestSource, 'document');
  assert.equal(ok.json().security.minimumLane, 'high');
});

test('literal task paths and paths named by the request raise the minimum like V2 did', async t => {
  const f = fixture(t);
  const spec = oneTask(); spec.tasks[0].allowedPaths.push('src/auth/login.mjs');
  const r = await checkSpec({ repo: f.repo, document: parseSpecDocument(spec) });
  assert.equal(r.valid, false);
  assert.ok(r.security.profile.authentication);
  const named = await checkSpec({ repo: f.repo, document: parseSpecDocument(oneTask()), request: 'Update package.json to add a dependency.' });
  assert.ok(named.security.profile.dependencyChange);
});

test('the ledger is read from .apv first, then from the V2 location', async t => {
  const f = fixture(t);
  const file = write(f.root, 'spec.json', demoSpec());
  write(f.repo, '.agent-pipeline/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-V2')] });
  let r = await apv(f.repo, ['spec', 'validate', file, '--json']);
  assert.equal(r.code, 1); assert.equal(r.json().ledgerFile, '.agent-pipeline/DECISIONS.json');
  assert.match(r.json().issues[0].message, /D-V2 is not covered/);
  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-V3')] });
  r = await apv(f.repo, ['spec', 'validate', file, '--json']);
  assert.equal(r.json().ledgerFile, '.apv/DECISIONS.json');
  assert.match(r.json().issues[0].message, /D-V3 is not covered/);
  const covered = demoSpec(); covered.decisionCoverage = [{ decisionId: 'D-V3', acceptanceIds: ['AC-MATH'], rationale: 'Covered by the product criterion.' }];
  assert.equal((await apv(f.repo, ['spec', 'validate', write(f.root, 'covered.json', covered)])).code, 0);
  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-X'), decision('D-X', { sourceQuote: '' })] });
  r = await apv(f.repo, ['spec', 'validate', file, '--json']);
  assert.deepEqual(r.json().issues.map(i => i.code).slice(0, 2), ['DECISION', 'DECISION_SOURCE']);
});

test('open questions pass in draft mode only; the default is the launch rule', async t => {
  const f = fixture(t);
  const file = write(f.root, 'spec.json', demoSpec(true));
  const ready = await apv(f.repo, ['spec', 'validate', file, '--json']);
  assert.equal(ready.code, 1); assert.ok(ready.json().issues.some(i => i.code === 'OPEN_QUESTIONS'));
  assert.equal((await apv(f.repo, ['spec', 'validate', file, '--draft'])).code, 0);
});

test('a resolution must quote the operator request given with the spec', async t => {
  const f = fixture(t);
  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-MULTI', { status: 'ambiguous', value: 'unresolved',
    clarificationQuestion: 'Multi-site in the MVP?', interpretations: ['inside', 'outside'] })] });
  const spec = demoSpec();
  spec.decisionResolutions = [{ decisionId: 'D-MULTI', value: 'outside', sourceQuote: 'second shop stays outside', rationale: 'Operator answer.' }];
  spec.decisionCoverage = [{ decisionId: 'D-MULTI', acceptanceIds: ['AC-MATH'], rationale: 'Scope stays single-site.' }];
  const file = write(f.root, 'spec.json', spec);
  assert.equal((await apv(f.repo, ['spec', 'validate', file, '--request', 'The second shop stays outside the MVP.'])).code, 0);
  const r = await apv(f.repo, ['spec', 'validate', file, '--request', 'Nothing about it.', '--json']);
  assert.equal(r.code, 1); assert.match(r.json().issues[0].message, /source quote/);
});

test('unreadable files and wrong invocations have distinct exit codes', async t => {
  const f = fixture(t);
  const missing = await apv(f.repo, ['spec', 'validate', join(f.root, 'absent.json')]);
  assert.equal(missing.code, 1); assert.match(missing.stdout, /SPEC_FILE/);
  const broken = await apv(f.repo, ['spec', 'validate', write(f.root, 'broken.json', '{ nope')]);
  assert.equal(broken.code, 1); assert.match(broken.stdout, /Invalid JSON/);
  assert.equal((await apv(f.repo, ['spec', 'validate'])).code, 2);
  assert.equal((await apv(f.repo, ['spec', 'check', 'x'])).code, 2);
  assert.equal((await apv(f.repo, ['spec', 'validate', 'a.json', '--nope'])).code, 2);
  const help = await apv(f.repo, ['spec', '--help']);
  assert.equal(help.code, 0); assert.match(help.stdout, /apv spec validate/);
});

test('spec documents: wrapper keys are strict and the fallback text ignores exclusions', () => {
  assert.equal(parseSpecDocument({ request: 'x', spec: { title: 't' } }).request, 'x');
  assert.throws(() => parseSpecDocument({ spec: {}, extra: 1 }), /Unknown property/);
  assert.throws(() => parseSpecDocument({ spec: {}, request: ' ' }), /non-empty/);
  const spec = demoSpec(); spec.outOfScope = ['No login and no password storage.'];
  assert.doesNotMatch(specText(spec), /password/);
  assert.equal(specText({ invalid: true }), '');
});
