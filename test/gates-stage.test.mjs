import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, git } from './helpers.mjs';
import { fixtureConfig } from './lifecycle-helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { runGates, stageGates, gatesConfigHash } from '../dist/gates/run.js';
import { verifyGates } from '../dist/gates/verify.js';
import { loadConfig, configIssues } from '../dist/config/load.js';
import { validateReceipt, validateConfig, gateStage } from '../dist/domain/contracts.js';

const node = (code, extra = {}) => ({ command: [process.execPath, '-e', code], ...extra });
function project(t, gates) {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { gates });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  return f;
}
/** A check whose result is driven by a file outside the repository: its command, hence the configuration, never changes. */
function switchable(t) {
  const dir = mkdtempSync(join(tmpdir(), 'apv3-stage-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'green');
  return { marker, code: `process.exit(require("fs").existsSync(${JSON.stringify(marker)}) ? 0 : 1)` };
}
const staged = (e2e) => [
  { id: 'lint', ...node('process.exit(0)') },
  { id: 'unit', stage: 'task', dependsOn: ['lint'], ...node('process.exit(0)') },
  { id: 'e2e', stage: 'full', dependsOn: ['unit'], ...node(e2e) },
];

test('--stage task runs the task checks only and lists the full ones as reserved, never as passed', async t => {
  const f = project(t, staged('process.exit(1)'));
  const r = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--json']);
  assert.equal(r.code, 0, r.stdout);
  const out = r.json();
  assert.equal(out.stage, 'task');
  assert.deepEqual(out.gates.map(g => [g.gate, g.status]), [['lint', 'passed'], ['unit', 'passed']]);
  assert.deepEqual(out.reserved, ['e2e']);
  const files = readdirSync(out.receiptsDirectory).sort();
  assert.deepEqual(files, ['lint.json', 'summary.json', 'unit.json']);
  for (const file of ['lint.json', 'unit.json']) {
    const receipt = validateReceipt(JSON.parse(readFileSync(join(out.receiptsDirectory, file), 'utf8')));
    assert.equal(receipt.stage, 'task'); assert.equal(receipt.dirty, false); assert.equal(receipt.candidateSha, git(f.repo, 'rev-parse', 'HEAD'));
  }
  const summary = JSON.parse(readFileSync(join(out.receiptsDirectory, 'summary.json'), 'utf8'));
  assert.equal(summary.stage, 'task'); assert.deepEqual(summary.reserved, ['e2e']); assert.deepEqual(summary.selected, ['lint', 'unit']);
  const human = await apv(f.repo, ['gates', 'run', '--stage', 'task']);
  assert.match(human.stdout, /^Contrôles de tâche \(--stage task\) à /);
  assert.match(human.stdout, /e2e\s+réservé à la suite complète\s+-\s+-/);
  assert.match(human.stdout, /Tous les contrôles de tâche passent\. 1 contrôle\(s\) réservé à la suite complète, non exécuté\(s\)/);
  // Full, explicit or by default, runs everything: the failing browser check is caught there.
  for (const args of [['--stage', 'full'], []]) {
    const full = await apv(f.repo, ['gates', 'run', ...args, '--json']);
    assert.equal(full.code, 1);
    assert.equal(full.json().stage, 'full'); assert.deepEqual(full.json().reserved, []);
    assert.deepEqual(full.json().gates.map(g => [g.gate, g.status]), [['lint', 'passed'], ['unit', 'passed'], ['e2e', 'failed']]);
  }
});

test('--stage task with --only a full check runs its task dependencies only; nothing to run is said; library selection', async t => {
  const f = project(t, staged('process.exit(0)'));
  const r = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--only', 'e2e']);
  assert.equal(r.code, 0, r.stdout);
  // Its task dependencies still run; the full check itself is reserved.
  assert.match(r.stdout, /lint\s+réussi/); assert.match(r.stdout, /e2e\s+réservé à la suite complète/);
  write(f.repo, '.apv/config.json', { gates: [{ id: 'browser', stage: 'full', ...node('process.exit(0)') }] });
  const none = await apv(f.repo, ['gates', 'run', '--stage', 'task']);
  assert.equal(none.code, 0); assert.match(none.stdout, /Aucun contrôle de tâche à exécuter\./);
  const gates = loadConfig(f.repo).config.gates;
  assert.deepEqual(stageGates(gates, 'task'), { run: [], targeted: [], reserved: gates });
  assert.deepEqual(stageGates(gates, 'full'), { run: gates, targeted: [], reserved: [] });
  assert.equal(gateStage({}), 'task'); assert.equal(gateStage({ stage: 'full' }), 'full');
});

test('a configuration without stages keeps its meaning: every check runs in both stages, parsed and hashed as before', async t => {
  const gates = [{ id: 'a', ...node('process.exit(0)') }, { id: 'b', dependsOn: ['a'], ...node('process.exit(0)') }];
  const f = project(t, gates);
  const config = loadConfig(f.repo).config;
  assert.ok(config.gates.every(g => !('stage' in g)));
  for (const stage of ['task', 'full']) {
    const r = await runGates({ repo: f.repo, config, stage });
    assert.equal(r.ok, true); assert.deepEqual(r.selected, ['a', 'b']); assert.deepEqual(r.reserved, []);
  }
  const task = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--json']);
  assert.deepEqual(task.json().gates.map(g => g.gate), ['a', 'b']);
  // The V2 contract accepts the field and leaves it absent when it is not written.
  const legacy = fixtureConfig();
  assert.ok(validateConfig(legacy).gates.every(g => !('stage' in g)));
  assert.equal(validateConfig({ ...legacy, gates: legacy.gates.map(g => ({ ...g, stage: 'full' })) }).gates[0].stage, 'full');
  assert.match(gatesConfigHash(config), /^[a-f0-9]{64}$/);
});

test('stage values and dependencies are checked; options are tied to their subcommand', async t => {
  const bad = configIssues({ gates: [{ id: 'e2e', stage: 'full', command: ['true'] }, { id: 'unit', command: ['true'], dependsOn: ['e2e'] }] });
  assert.deepEqual(bad.issues.map(i => i.message), ['Gate unit (stage task) depends on e2e, reserved for the full suite (stage full)']);
  assert.equal(configIssues({ gates: [{ id: 'unit', command: ['true'] }, { id: 'e2e', stage: 'full', command: ['true'], dependsOn: ['unit'] }] }).issues.length, 0);
  assert.match(configIssues({ gates: [{ id: 'x', stage: 'nightly', command: ['true'] }] }).issues[0].message, /stage: expected task\|full/);
  const f = project(t, staged('process.exit(0)'));
  const cases = [
    [['gates', 'run', '--stage', 'nightly'], /--stage attend task ou full/],
    [['gates', 'run', '--commit', 'HEAD'], /--commit est une option de gates verify/],
    [['gates', 'verify'], /gates verify attend --commit/],
    [['gates', 'verify', '--commit', 'HEAD', '--only', 'lint'], /option de gates run seulement : --only/],
    [['gates', 'verify', '--commit', 'HEAD', '--keep-going', '--skip-proven'], /option de gates run seulement : --keep-going, --skip-proven/],
    [['gates', 'verify', '--commit', 'HEAD', '--base', 'HEAD'], /--base va avec --stage task/],
    [['gates', 'run', '--stage', 'task', '--skip-proven'], /--skip-proven va avec la suite complète entière/],
    [['gates', 'run', '--only', 'lint', '--skip-proven'], /--skip-proven va avec la suite complète entière/],
  ];
  for (const [args, message] of cases) {
    const r = await apv(f.repo, args);
    assert.equal(r.code, 2, args.join(' ')); assert.match(r.stderr, message);
  }
  const unknown = await apv(f.repo, ['gates', 'verify', '--commit', 'deadbeef']);
  assert.equal(unknown.code, 1);
});

test('verify: missing, failed, another commit, dirty tree, then complete', async t => {
  const green = switchable(t);
  const f = project(t, staged(green.code));
  const head = git(f.repo, 'rev-parse', 'HEAD');
  const verify = async (...args) => apv(f.repo, ['gates', 'verify', '--commit', head, ...args, '--json']);

  // Nothing has run: everything is missing.
  let v = await verify();
  assert.equal(v.code, 1); assert.equal(v.json().commit, head); assert.equal(v.json().stage, 'full');
  assert.deepEqual(v.json().missing, ['lint', 'unit', 'e2e']);
  assert.ok(v.json().gates.every(g => g.state === 'missing'));

  // A task run proves the task checks, never the reserved one.
  await apv(f.repo, ['gates', 'run', '--stage', 'task']);
  v = await verify();
  assert.equal(v.code, 1); assert.deepEqual(v.json().missing, ['e2e']);
  assert.deepEqual(Object.fromEntries(v.json().gates.map(g => [g.gateId, g.state])), { lint: 'passed', unit: 'passed', e2e: 'missing' });
  assert.equal((await verify('--stage', 'task')).code, 0);

  // A failing full run: the check is failed, with its status.
  assert.equal((await apv(f.repo, ['gates', 'run', '--stage', 'full'])).code, 1);
  v = await verify();
  assert.equal(v.code, 1);
  const e2e = v.json().gates.find(g => g.gateId === 'e2e');
  assert.equal(e2e.state, 'failed'); assert.equal(e2e.status, 'failed'); assert.match(e2e.runId, /^\d{8}T\d{6}Z-/);
  const human = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD']);
  assert.match(human.stdout, /^Vérification \(suite complète\) au commit /);
  assert.match(human.stdout, /e2e\s+échec \(échec\)/);
  assert.match(human.stdout, /Preuve incomplète\. Manque : e2e \(échec\)\. Relancer : apv gates run --stage full/);

  // Fixed (same commit, same configuration): complete.
  writeFileSync(green.marker, '');
  assert.equal((await apv(f.repo, ['gates', 'run', '--stage', 'full'])).code, 0);
  v = await verify();
  assert.equal(v.code, 0, JSON.stringify(v.json()));
  assert.deepEqual(v.json().missing, []);
  const ok = await apv(f.repo, ['gates', 'verify', '--commit', head.slice(0, 10)]);
  assert.equal(ok.code, 0); assert.match(ok.stdout, /Preuve complète : 3 contrôle\(s\) réussi\(s\) sur ce commit, arbre propre\./);

  // A later failure overrides the earlier success.
  rmSync(green.marker);
  await apv(f.repo, ['gates', 'run', '--only', 'e2e']);
  assert.equal((await verify()).code, 1);
  writeFileSync(green.marker, '');

  // Another commit has no proof, whatever the previous one had; a dirty run proves nothing.
  write(f.repo, 'docs/next.md', 'next\n'); git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'next');
  write(f.repo, 'scratch.txt', 'uncommitted\n');
  const dirty = await apv(f.repo, ['gates', 'run', '--json']);
  assert.equal(dirty.code, 0); assert.equal(dirty.json().dirty, true);
  v = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--json']);
  assert.equal(v.code, 1);
  assert.ok(v.json().gates.every(g => g.state === 'dirty'), JSON.stringify(v.json().gates));
  assert.match((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD'])).stdout, /lint\s+arbre modifié/);
  rmSync(join(f.repo, 'scratch.txt'));
  assert.equal((await apv(f.repo, ['gates', 'run'])).code, 0);
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD'])).code, 0);
});

test('verify ignores receipts of another configuration and unreadable files; older receipts fall back to their summary', async t => {
  const f = project(t, [{ id: 'unit', ...node('process.exit(0)') }]);
  const head = git(f.repo, 'rev-parse', 'HEAD');
  const run = await runGates({ repo: f.repo, config: loadConfig(f.repo).config });
  // Receipts written before the stage and tree fields existed: the run summary gives the tree state.
  const file = join(run.directory, 'unit.json');
  const receipt = JSON.parse(readFileSync(file, 'utf8')); delete receipt.stage; delete receipt.dirty;
  writeFileSync(file, JSON.stringify(receipt));
  assert.equal((await verifyGates({ repo: f.repo, config: loadConfig(f.repo).config, commit: head })).ok, true);
  const summaryFile = join(run.directory, 'summary.json');
  const summary = JSON.parse(readFileSync(summaryFile, 'utf8')); delete summary.dirty;
  writeFileSync(summaryFile, JSON.stringify(summary));
  const unknown = await verifyGates({ repo: f.repo, config: loadConfig(f.repo).config, commit: head });
  assert.equal(unknown.ok, false); assert.equal(unknown.gates[0].state, 'dirty');
  // Another configuration of the checks (here passed through --config): its receipts do not count.
  write(f.repo, 'other.json', { gates: [{ id: 'unit', ...node('process.exit(0)'), timeoutMs: 5000 }] });
  writeFileSync(join(run.directory, 'broken.json'), '{');
  const other = await apv(f.repo, ['gates', 'verify', '--commit', head, '--config', 'other.json', '--json']);
  assert.equal(other.code, 1);
  assert.equal(other.json().gates[0].state, 'missing'); assert.equal(other.json().gates[0].otherConfig, 1);
  assert.equal(other.json().unreadable.length, 1);
  const human = await apv(f.repo, ['gates', 'verify', '--commit', head, '--config', 'other.json']);
  assert.match(human.stdout, /configuration des contrôles différente\) : unit/);
  assert.match(human.stdout, /Reçus illisibles ignorés : \.apv\/receipts\/.*broken\.json/);
  // Nothing configured, or nothing of the stage asked: refused rather than vacuously proven.
  write(f.repo, 'empty.json', { gates: [] });
  assert.match((await apv(f.repo, ['gates', 'verify', '--commit', head, '--config', 'empty.json'])).stderr, /NO_GATES/);
  write(f.repo, 'full-only.json', { gates: [{ id: 'e2e', stage: 'full', ...node('process.exit(0)') }] });
  assert.match((await apv(f.repo, ['gates', 'verify', '--commit', head, '--config', 'full-only.json', '--stage', 'task'])).stderr, /No check of stage task/);
  assert.ok(existsSync(join(f.repo, '.apv/receipts/.gitignore')));
});
