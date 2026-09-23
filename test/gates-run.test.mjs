import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, git } from './helpers.mjs';
import { fixtureConfig } from './lifecycle-helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { runGates, selectGates } from '../dist/gates/run.js';
import { loadConfig, configIssues } from '../dist/config/load.js';
import { validateReceipt } from '../dist/domain/contracts.js';

const node = (code, extra = {}) => ({ command: [process.execPath, '-e', code], ...extra });
function project(t, gates, extra = {}) {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { gates, ...extra });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  return f;
}
const receiptsOf = (dir) => readdirSync(dir).filter(x => x !== 'summary.json').map(x => validateReceipt(JSON.parse(readFileSync(join(dir, x), 'utf8'))));

test('gates follow dependencies, stop dependants of a failure and write valid receipts', async t => {
  const f = project(t, [
    { id: 'lint', ...node('process.exit(0)') },
    { id: 'unit', dependsOn: ['lint'], ...node('console.error("expected 5, received -1"); process.exit(3)') },
    { id: 'e2e', dependsOn: ['unit'], ...node('process.exit(0)') },
  ]);
  const r = await apv(f.repo, ['gates', 'run']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /contrôle\s+statut\s+code\s+durée/);
  assert.match(r.stdout, /lint\s+réussi\s+0/);
  assert.match(r.stdout, /unit\s+échec\s+3/);
  assert.match(r.stdout, /e2e\s+bloqué\s+-/);
  assert.match(r.stdout, /--- unit \(échec\) ---\nfailed\nexpected 5, received -1/);
  assert.match(r.stdout, /Des contrôles échouent\. Reçus : \.apv\/receipts\//);
  const json = (await apv(f.repo, ['gates', 'run', '--json'])).json();
  assert.equal(json.ok, false);
  assert.deepEqual(json.gates.map(g => g.status), ['passed', 'failed', 'blocked']);
  const receipts = receiptsOf(json.receiptsDirectory);
  assert.equal(receipts.length, 3);
  assert.ok(receipts.every(x => x.runId === json.runId && x.candidateSha === json.candidateSha));
  const summary = JSON.parse(readFileSync(join(json.receiptsDirectory, 'summary.json'), 'utf8'));
  assert.equal(summary.ok, false); assert.deepEqual(summary.selected, ['lint', 'unit', 'e2e']);
  // Receipts never dirty the project: the next run still sees a clean tree.
  assert.equal(json.dirty, false);
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
});

test('all green exits 0; --only adds dependencies; unknown ids are refused', async t => {
  const f = project(t, [{ id: 'build', ...node('process.exit(0)') }, { id: 'test', dependsOn: ['build'], ...node('process.exit(0)') }, { id: 'slow', ...node('process.exit(1)') }]);
  const only = await apv(f.repo, ['gates', 'run', '--only', 'test', '--json']);
  assert.equal(only.code, 0, only.stdout);
  assert.deepEqual(only.json().gates.map(g => g.gate), ['build', 'test']);
  assert.deepEqual(only.json().added, ['build']);
  const human = await apv(f.repo, ['gates', 'run', '--only', 'test']);
  assert.match(human.stdout, /Dépendances ajoutées : build/); assert.match(human.stdout, /Tous les contrôles passent\./);
  const unknown = await apv(f.repo, ['gates', 'run', '--only', 'nope']);
  assert.equal(unknown.code, 1); assert.match(unknown.stderr, /GATE_UNKNOWN.*nope/);
  assert.throws(() => selectGates([], ['x']), /Unknown gate/);
});

test('only declared variables reach a gate, and secrets are redacted from diagnostics', async t => {
  const f = project(t, [
    { id: 'env', passEnv: ['APV_VISIBLE'], ...node('process.exit(process.env.APV_VISIBLE === "yes" && process.env.APV_HIDDEN === undefined ? 0 : 1)') },
    { id: 'leak', passEnv: ['APV_API_TOKEN'], ...node('console.log("token=" + process.env.APV_API_TOKEN); process.exit(1)') },
  ]);
  const env = { APV_VISIBLE: 'yes', APV_HIDDEN: 'no', APV_API_TOKEN: 'super-secret-value' };
  const r = await apv(f.repo, ['gates', 'run', '--keep-going', '--json'], env);
  const gates = Object.fromEntries(r.json().gates.map(g => [g.gate, g]));
  assert.equal(gates.env.status, 'passed');
  assert.equal(gates.leak.status, 'failed');
  assert.match(gates.leak.diagnostic, /token=\[REDACTED\]/);
  for (const file of readdirSync(r.json().receiptsDirectory)) assert.doesNotMatch(readFileSync(join(r.json().receiptsDirectory, file), 'utf8'), /super-secret-value/);
});

test('timeouts and missing executables become receipts, not crashes', async t => {
  const f = project(t, [
    { id: 'hang', timeoutMs: 300, ...node('setTimeout(() => {}, 20000)') },
    { id: 'absent', command: ['apv-command-that-does-not-exist'] },
  ]);
  const r = await apv(f.repo, ['gates', 'run', '--keep-going', '--json']);
  assert.equal(r.code, 1);
  const status = Object.fromEntries(r.json().gates.map(g => [g.gate, g.status]));
  assert.deepEqual(status, { hang: 'timed_out', absent: 'spawn_error' });
});

test('a shared resource serialises read-only gates', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'apv3-resource-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'held');
  const exclusive = `const fs=require("fs");if(fs.existsSync(${JSON.stringify(marker)}))process.exit(9);fs.writeFileSync(${JSON.stringify(marker)},"x");setTimeout(()=>{fs.rmSync(${JSON.stringify(marker)});},250);`;
  const f = project(t, ['a', 'b', 'c'].map(id => ({ id, readOnly: true, resources: ['db'], ...node(exclusive) })));
  const r = await apv(f.repo, ['gates', 'run', '--concurrency', '3', '--json']);
  assert.equal(r.code, 0, JSON.stringify(r.json().gates));
});

test('{{baseSha}} needs --base; other placeholders are resolved', async t => {
  const f = project(t, [{ id: 'diff-check', command: ['git', 'diff', '--check', '{{baseSha}}', '{{candidateSha}}'] },
    { id: 'where', ...node('process.exit(process.argv[1] === process.cwd() ? 0 : 1)'), command: [process.execPath, '-e', 'process.exit(process.argv[1] === process.cwd() ? 0 : 1)', '{{workspace}}'] }]);
  const missing = await apv(f.repo, ['gates', 'run']);
  assert.equal(missing.code, 1); assert.match(missing.stderr, /GATE_BASE.*--base/);
  const ok = await apv(f.repo, ['gates', 'run', '--base', 'HEAD~1', '--json']);
  assert.equal(ok.code, 0, JSON.stringify(ok.json().gates));
  assert.equal(ok.json().baseSha, git(f.repo, 'rev-parse', 'HEAD~1'));
});

test('a V2 pipeline.v2.json is read for its gates only', async t => {
  const f = fixture(t);
  const legacy = fixtureConfig();
  legacy.gates = legacy.gates.filter(g => g.id === 'syntax').map(g => ({ ...g, command: [process.execPath, '-e', 'process.exit(0)'] }));
  write(f.repo, 'pipeline.v2.json', { ...legacy, maxRunMs: 1000, workflow: { maxSpecCostUsd: 3 }, roleProfiles: [] });
  const r = await apv(f.repo, ['gates', 'run', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().legacyConfig, true);
  assert.deepEqual(r.json().ignoredSections, ['agent', 'concurrency', 'executionMode', 'maxRunMs', 'roleProfiles', 'schemaVersion', 'workflow']);
  assert.equal(r.json().dirty, true);
  const human = await apv(f.repo, ['gates', 'run']);
  assert.match(human.stdout, /configuration : pipeline\.v2\.json, format V2/);
  assert.match(human.stdout, /modifications non commitées/);
  write(f.repo, '.apv/config.json', { gates: [{ id: 'v3', ...node('process.exit(0)') }] });
  assert.equal(loadConfig(f.repo).legacy, false);
  const explicit = await apv(f.repo, ['gates', 'run', '--config', 'pipeline.v2.json', '--json']);
  assert.deepEqual(explicit.json().gates.map(g => g.gate), ['syntax']);
});

test('configuration problems are all reported and nothing runs', async t => {
  const f = fixture(t);
  assert.equal((await apv(f.repo, ['gates', 'run'])).code, 1);
  write(f.repo, '.apv/config.json', { gates: [{ id: 'a', command: ['true'], dependsOn: ['ghost'] }, { id: 'a', command: ['true'] }, { id: 'b', command: 'true' }] });
  const r = await apv(f.repo, ['gates', 'run']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /\$\.gates\[2\]\.command: expected array/);
  const semantic = configIssues({ gates: [{ id: 'a', command: ['true'], dependsOn: ['ghost'] }, { id: 'a', command: ['true'] }] }).issues.map(i => i.message);
  assert.deepEqual(semantic, ['Duplicate gate id: a', 'Unknown dependency ghost of gate a']);
  assert.match(configIssues({ gates: [{ id: 'a', command: ['true'], dependsOn: ['b'] }, { id: 'b', command: ['true'], dependsOn: ['a'] }] }).issues[0].message, /cycle/);
  assert.match(configIssues([]).issues[0].message, /JSON object/);
  write(f.repo, '.apv/config.json', '{ broken');
  assert.match((await apv(f.repo, ['gates', 'run'])).stderr, /Invalid JSON/);
  assert.equal((await apv(f.repo, ['gates', 'run', '--concurrency', '0'])).code, 2);
  assert.equal((await apv(f.repo, ['gates', 'start'])).code, 2);
  assert.ok(!existsSync(join(f.repo, '.apv/receipts')));
});

test('runGates is usable as a library with an injected environment', async t => {
  const f = project(t, [{ id: 'env', passEnv: ['APV_ONLY_HERE'], ...node('process.exit(process.env.APV_ONLY_HERE === "1" ? 0 : 1)') }]);
  const result = await runGates({ repo: f.repo, config: loadConfig(f.repo).config, env: { PATH: process.env.PATH, APV_ONLY_HERE: '1' } });
  assert.equal(result.ok, true);
  assert.equal(result.receipts[0].exitCode, 0);
});
