import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { runGates, stageGates, gatesConfigHash } from '../dist/gates/run.js';
import { loadConfig, configIssues } from '../dist/config/load.js';
import { validateReceipt } from '../dist/domain/contracts.js';

const node = (code, ...args) => [process.execPath, '-e', code, ...args];
function project(t, gates) {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { gates });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  return f;
}
/** Files outside the repository: which command ran (and with which argument), and whether the targeted one passes. */
function probe(t) {
  const dir = mkdtempSync(join(tmpdir(), 'apv3-affected-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'log'); const green = join(dir, 'green');
  const record = (what) => `require("fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(what)} + " " + (process.argv[1] ?? "") + "\\n")`;
  return {
    log: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => l.trim()) : [],
    green,
    full: node(`${record('full')}; process.exit(0)`),
    affected: node(`${record('affected')}; process.exit(require("fs").existsSync(${JSON.stringify(green)}) ? 0 : 1)`, '{{baseSha}}'),
  };
}
const gatesOf = (p, extra = {}) => [
  { id: 'unit', command: node('process.exit(0)') },
  { id: 'e2e', stage: 'full', dependsOn: ['unit'], command: p.full, affected: p.affected, ...extra },
  { id: 'visual', stage: 'full', command: node('process.exit(0)') },
];

test('--stage task runs the affected command of a full check in its place, marked targeted in output and receipts', async t => {
  const p = probe(t); writeFileSync(p.green, '');
  const f = project(t, gatesOf(p));
  const base = git(f.repo, 'rev-parse', 'HEAD~1');
  const r = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--base', 'HEAD~1', '--json']);
  assert.equal(r.code, 0, r.stdout);
  const out = r.json();
  assert.deepEqual(out.gates.map(g => [g.gate, g.status, g.targeted]), [['unit', 'passed', false], ['e2e', 'passed', true]]);
  assert.deepEqual(out.targeted, ['e2e']); assert.deepEqual(out.reserved, ['visual']);
  // The targeted command ran, with the base expanded; the full command did not.
  assert.deepEqual(p.log(), [`affected ${base}`]);
  const receipt = validateReceipt(JSON.parse(readFileSync(join(out.receiptsDirectory, 'e2e.json'), 'utf8')));
  assert.equal(receipt.targeted, true); assert.equal(receipt.stage, 'task');
  const unit = validateReceipt(JSON.parse(readFileSync(join(out.receiptsDirectory, 'unit.json'), 'utf8')));
  assert.ok(!('targeted' in unit));
  const summary = JSON.parse(readFileSync(join(out.receiptsDirectory, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.targeted, ['e2e']); assert.deepEqual(summary.reserved, ['visual']);
  assert.equal(summary.receipts.find(x => x.gateId === 'e2e').targeted, true);
  assert.ok(!('targeted' in summary.receipts.find(x => x.gateId === 'unit')));

  const human = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--base', 'HEAD~1']);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /e2e \(ciblé\)\s+réussi\s+0/);
  assert.match(human.stdout, /visual\s+réservé à la suite complète/);
  assert.match(human.stdout, /Tous les contrôles de tâche passent\. 1 contrôle\(s\) ciblé\(s\) \(e2e\) : seuls les tests concernés par les changements ont tourné ; la suite complète \(apv gates run --stage full\) les exécute en entier\. 1 contrôle\(s\) réservé/);

  // The full stage, explicit or by default, runs the whole check, never the targeted one.
  for (const args of [['--stage', 'full'], []]) {
    const full = await apv(f.repo, ['gates', 'run', ...args, '--json']);
    assert.equal(full.code, 0, full.stdout);
    assert.deepEqual(full.json().targeted, []);
    assert.ok(full.json().gates.every(g => g.targeted === false));
  }
  assert.deepEqual(p.log().slice(2), ['full', 'full']);
});

test('a targeted failure is reported as targeted; a failed dependency blocks it; {{baseSha}} needs --base', async t => {
  const p = probe(t);
  const f = project(t, gatesOf(p));
  const red = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--base', 'HEAD']);
  assert.equal(red.code, 1);
  assert.match(red.stdout, /e2e \(ciblé\)\s+échec\s+1/);
  assert.match(red.stdout, /--- e2e \(ciblé\) \(échec\) ---/);
  assert.match(red.stdout, /Des contrôles échouent\./);
  const missing = await apv(f.repo, ['gates', 'run', '--stage', 'task']);
  assert.equal(missing.code, 1); assert.match(missing.stderr, /GATE_BASE.*e2e.*--base/);
  assert.deepEqual(p.log().filter(l => l.startsWith('affected')).length, 1);

  write(f.repo, '.apv/config.json', { gates: [{ id: 'unit', command: node('process.exit(4)') }, gatesOf(p)[1]] });
  const blocked = await runGates({ repo: f.repo, config: loadConfig(f.repo).config, stage: 'task', base: 'HEAD' });
  assert.equal(blocked.ok, false);
  const e2e = blocked.receipts.find(r => r.gateId === 'e2e');
  assert.equal(e2e.status, 'blocked'); assert.equal(e2e.targeted, true);
});

test('verify never counts a targeted receipt: the full suite stays required at integration and delivery', async t => {
  const p = probe(t); writeFileSync(p.green, '');
  const f = project(t, gatesOf(p));
  const head = git(f.repo, 'rev-parse', 'HEAD');
  assert.equal((await apv(f.repo, ['gates', 'run', '--stage', 'task', '--base', 'HEAD~1'])).code, 0);
  let v = await apv(f.repo, ['gates', 'verify', '--commit', head, '--json']);
  assert.equal(v.code, 1);
  assert.deepEqual(v.json().missing, ['e2e', 'visual']);
  const e2e = v.json().gates.find(g => g.gateId === 'e2e');
  assert.equal(e2e.state, 'missing'); assert.equal(e2e.targeted, 1);
  const human = await apv(f.repo, ['gates', 'verify', '--commit', head]);
  assert.match(human.stdout, /Reçus ciblés ignorés \(seule la suite complète prouve ces contrôles\) : e2e/);
  // The task stage of verify is unchanged: it requires the task checks only.
  const task = await apv(f.repo, ['gates', 'verify', '--commit', head, '--stage', 'task', '--json']);
  assert.equal(task.code, 0); assert.deepEqual(task.json().required, ['unit']);

  assert.equal((await apv(f.repo, ['gates', 'run', '--stage', 'full'])).code, 0);
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', head])).code, 0);
  // A later targeted failure neither proves nor overrides the full check.
  rmSync(p.green);
  assert.equal((await apv(f.repo, ['gates', 'run', '--stage', 'task', '--base', 'HEAD~1'])).code, 1);
  v = await apv(f.repo, ['gates', 'verify', '--commit', head, '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json()));
  assert.equal(v.json().gates.find(g => g.gateId === 'e2e').targeted, 2);
  assert.doesNotMatch((await apv(f.repo, ['gates', 'verify', '--commit', head])).stdout, /Reçus ciblés ignorés/);
});

test('affected belongs to a full check whose dependencies run at the task stage; absent, nothing changes', () => {
  const cmd = ['true'];
  const issues = (gates) => configIssues({ gates }).issues.map(i => i.message);
  assert.deepEqual(issues([{ id: 'unit', command: cmd, affected: cmd }]),
    ['Gate unit: affected is the targeted variant of a full check; declare "stage": "full"']);
  assert.deepEqual(issues([{ id: 'build', stage: 'full', command: cmd }, { id: 'e2e', stage: 'full', command: cmd, affected: cmd, dependsOn: ['build'] }]),
    ['Gate e2e (targeted at stage task) depends on build, reserved for the full suite without a targeted variant']);
  assert.deepEqual(issues([{ id: 'unit', command: cmd }, { id: 'api', stage: 'full', command: cmd, affected: cmd, dependsOn: ['unit'] },
    { id: 'e2e', stage: 'full', command: cmd, affected: cmd, dependsOn: ['api'] }]), []);
  assert.match(issues([{ id: 'e2e', stage: 'full', command: cmd, affected: [] }])[0], /affected/);
  assert.match(issues([{ id: 'e2e', stage: 'full', command: cmd, affected: 'playwright test' }])[0], /affected/);

  const without = configIssues({ gates: [{ id: 'e2e', stage: 'full', command: cmd }] }).config;
  assert.ok(!('affected' in without.gates[0]));
  const withIt = configIssues({ gates: [{ id: 'e2e', stage: 'full', command: cmd, affected: cmd }] }).config;
  assert.notEqual(gatesConfigHash(withIt), gatesConfigHash(without));

  const gates = withIt.gates;
  assert.deepEqual(stageGates(gates, 'task'), { run: [], targeted: gates, reserved: [] });
  assert.deepEqual(stageGates(gates, 'full'), { run: gates, targeted: [], reserved: [] });
});
