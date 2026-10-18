import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { runGates, gatesConfigHash, earlyGates, EARLY_SLOW_MS } from '../dist/gates/run.js';
import { enforceBaseGates } from '../dist/gates/base-gates.js';
import { loadConfig, configIssues } from '../dist/config/load.js';
import { validateReceipt } from '../dist/domain/contracts.js';
import { targetedHints } from '../dist/onboard/detect.js';

// Docs/ACCELERATION-LOTS.md, part C: a full check declares fast commands (`early`) the task stage runs when the change
// touches their scope, so that what fails at the end of a full suite fails in minutes. They add a check, never remove one.

const node = (code, ...args) => [process.execPath, '-e', code, ...args];
/** Files outside the repository: which command ran, and whether the early command passes. */
function probe(t) {
  const dir = mkdtempSync(join(tmpdir(), 'apv3-early-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'log'); const red = join(dir, 'red');
  const record = (what) => `require("fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(what)} + "\\n")`;
  return {
    log: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [],
    red,
    cmd: (what) => node(`${record(what)}; process.exit(require("fs").existsSync(${JSON.stringify(red)}) ? 1 : 0)`),
    ok: (what) => node(`${record(what)}; process.exit(0)`),
  };
}
const budget = (p, extra = {}) => ({ id: 'budget-js', when: ['src/**', 'static/**', 'package.json'], dependsOn: ['build'], command: p.cmd('budget-js'), ...extra });
const gatesOf = (p, early = [budget(p)], extra = {}) => [
  { id: 'build', command: p.ok('build') },
  { id: 'integration', stage: 'full', command: p.ok('integration'), early, ...extra },
  { id: 'browser', stage: 'full', command: p.ok('browser') },
];
/** A repository whose first commit declares the checks, then a commit that changes `files`. */
function project(t, gates, files) {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { gates });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  for (const [path, text] of Object.entries(files)) write(f.repo, path, text);
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'change');
  return f;
}

test('AC-EARLY-RUN: a change under `when` runs the early check at the task stage, after its dependency, as a targeted receipt', async t => {
  const p = probe(t);
  const f = project(t, gatesOf(p), { 'src/routes/guides/x.svelte': '<p>guide</p>\n' });
  const r = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--base', 'HEAD~1', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = r.json();
  assert.deepEqual(out.gates.map(g => [g.gate, g.status]), [['build', 'passed'], ['budget-js', 'passed']]);
  assert.deepEqual(out.reserved, ['integration', 'browser']);
  assert.deepEqual(out.early.map(e => [e.id, e.gate, e.required]), [['budget-js', 'integration', true]]);
  assert.match(out.early[0].reason, /1 fichier\(s\) changé\(s\) depuis [a-f0-9]{12} répond\(ent\) à when : src\/routes\/guides\/x\.svelte/);
  // The dependency first, the full command never.
  assert.deepEqual(p.log(), ['build', 'budget-js']);
  const receipt = validateReceipt(JSON.parse(readFileSync(join(out.receiptsDirectory, 'budget-js.json'), 'utf8')));
  assert.equal(receipt.targeted, true); assert.equal(receipt.stage, 'task');
  assert.deepEqual(receipt.early, { gate: 'integration', id: 'budget-js', required: true, reason: out.early[0].reason, files: ['src/routes/guides/x.svelte'] });
  const summary = JSON.parse(readFileSync(join(out.receiptsDirectory, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.early, out.early);
  assert.equal(summary.receipts.find(x => x.gateId === 'budget-js').early, 'integration');

  const human = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--base', 'HEAD~1']);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /budget-js \(tôt : integration\)\s+réussi\s+0/);
  assert.match(human.stdout, /Contrôles tôt \(early\), jamais une preuve de leur contrôle complet : budget-js \(integration\) lancé/);

  // The full stage runs the full checks themselves, never their early commands.
  const full = await apv(f.repo, ['gates', 'run', '--stage', 'full', '--json']);
  assert.equal(full.code, 0, full.stdout);
  assert.deepEqual(full.json().gates.map(g => g.gate), ['build', 'integration', 'browser']);
  assert.deepEqual(full.json().early, []);
});

test('AC-EARLY-RUN: a change outside `when` records the early check as not required at the task stage, nothing run', async t => {
  const p = probe(t);
  const f = project(t, gatesOf(p), { 'docs/x.md': '# Doc\n' });
  const r = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--base', 'HEAD~1', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = r.json();
  assert.deepEqual(out.gates.map(g => [g.gate, g.status]), [['build', 'passed'], ['budget-js', 'not_required']]);
  assert.deepEqual(p.log(), ['build']);
  assert.equal(out.early[0].required, false);
  assert.match(out.early[0].reason, /aucun des 1 fichier\(s\) changé\(s\) depuis [a-f0-9]{12} ne répond à when/);
  const receipt = validateReceipt(JSON.parse(readFileSync(join(out.receiptsDirectory, 'budget-js.json'), 'utf8')));
  assert.equal(receipt.status, 'not_required'); assert.equal(receipt.early.required, false); assert.equal(receipt.stage, 'task');
  const human = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--base', 'HEAD~1']);
  assert.match(human.stdout, /budget-js \(tôt : integration\)\s+non requis \(hors when\)/);

  // Uncommitted and untracked files count as changed: a file under `when` not yet committed runs it.
  write(f.repo, 'static/logo.svg', '<svg/>\n');
  const dirty = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--base', 'HEAD~1', '--json']);
  assert.equal(dirty.code, 0, dirty.stdout);
  assert.equal(dirty.json().gates.find(g => g.gate === 'budget-js').status, 'passed');
});

test('AC-EARLY-RUN: without `when` it always runs; without --base, `when` is not evaluated and it runs', async t => {
  const p = probe(t);
  const always = budget(p, { id: 'captures', when: undefined, dependsOn: [] });
  delete always.when;
  const f = project(t, gatesOf(p, [budget(p), always]), { 'docs/x.md': '# Doc\n' });
  const r = await runGates({ repo: f.repo, config: loadConfig(f.repo).config, stage: 'task', base: 'HEAD~1' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.receipts.map(x => [x.gateId, x.status]), [['build', 'passed'], ['budget-js', 'not_required'], ['captures', 'passed']]);
  assert.match(r.early.find(e => e.id === 'captures').reason, /toujours \(sans when\)/);
  const noBase = await runGates({ repo: f.repo, config: loadConfig(f.repo).config, stage: 'task' });
  assert.equal(noBase.receipts.find(x => x.gateId === 'budget-js').status, 'passed');
  assert.match(noBase.early.find(e => e.id === 'budget-js').reason, /sans --base : when non évalué, lancé/);
});

test('AC-EARLY-RED: a failed early check turns the task stage red and names the full check that would fail', async t => {
  const p = probe(t);
  const f = project(t, gatesOf(p), { 'src/routes/guides/x.svelte': '<p>guide</p>\n' });
  write(join(p.red, '..'), 'red', '');
  const started = Date.now();
  const r = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--base', 'HEAD~1']);
  assert.equal(r.code, 1, r.stdout);
  assert.ok(Date.now() - started < 180_000);
  assert.match(r.stdout, /budget-js \(tôt : integration\)\s+échec\s+1/);
  assert.match(r.stdout, /Échec tôt de integration \(budget-js\) : la suite complète échouerait sur ce contrôle ; corriger avant de la lancer\./);
  assert.match(r.stdout, /Des contrôles échouent\./);
  // A failed dependency blocks the early check.
  write(f.repo, '.apv/config.json', { gates: gatesOf(p).map(g => g.id === 'build' ? { ...g, command: node('process.exit(2)') } : g) });
  const blocked = await runGates({ repo: f.repo, config: loadConfig(f.repo).config, stage: 'task', base: 'HEAD~1' });
  assert.equal(blocked.ok, false);
  const early = blocked.receipts.find(x => x.gateId === 'budget-js');
  assert.equal(early.status, 'blocked'); assert.equal(early.targeted, true); assert.equal(early.early.gate, 'integration');
});

test('an early check slower than 5 minutes is said too slow for the task stage', async t => {
  const p = probe(t);
  const f = project(t, gatesOf(p), { 'src/a.ts': 'export {};\n' });
  const lines = [];
  const r = await runGates({ repo: f.repo, config: loadConfig(f.repo).config, stage: 'task', base: 'HEAD~1', log: l => lines.push(l),
    hooks: { durationOf: (id, ms) => id === 'budget-js' ? EARLY_SLOW_MS + 1 : ms } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.slowEarly, ['budget-js']);
  assert.ok(lines.some(l => /budget-js \(contrôle tôt de integration\) : plus de 5 min, trop lent pour le stage task/.test(l)), lines.join('\n'));
});

test('AC-EARLY-NOPROOF: a green early receipt never proves its full check, at any stage of verify', async t => {
  const p = probe(t);
  const f = project(t, gatesOf(p, [budget(p)], { affected: p.ok('integration-affected') }), { 'src/a.ts': 'export {};\n' });
  const head = git(f.repo, 'rev-parse', 'HEAD');
  const run = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--base', 'HEAD~1', '--json']);
  assert.equal(run.code, 0, run.stdout);
  assert.deepEqual(run.json().gates.map(g => [g.gate, g.targeted]), [['build', false], ['integration', true], ['budget-js', true]]);
  // Stage full: the early receipt counts for nothing; integration and browser stay missing.
  const full = await apv(f.repo, ['gates', 'verify', '--commit', head, '--json']);
  assert.equal(full.code, 1);
  assert.deepEqual(full.json().missing, ['integration', 'browser']);
  assert.equal(full.json().gates.some(g => g.gateId === 'budget-js'), false);
  // Stage task: integration is proven by its affected receipt, never by the early one.
  const task = await apv(f.repo, ['gates', 'verify', '--commit', head, '--stage', 'task', '--base', 'HEAD~1', '--json']);
  assert.equal(task.code, 0, JSON.stringify(task.json()));
  assert.deepEqual(task.json().required, ['build', 'integration']);
  const integration = task.json().gates.find(g => g.gateId === 'integration');
  assert.equal(integration.proof, 'targeted');
  assert.equal(integration.receipt, run.json().gates.find(g => g.gate === 'integration').receipt);
});

test('AC-EARLY-NOPROOF: receipts of early checks are targeted task receipts, never proof, and say why they ran', () => {
  const base = { id: 'r1', runId: 'run', gateId: 'budget-js', key: 'a'.repeat(64), candidateSha: 'b'.repeat(40), configHash: 'c'.repeat(64), environmentHash: 'd'.repeat(64),
    startedAt: 1, durationMs: 1, stdoutHash: '0'.repeat(64), stderrHash: '0'.repeat(64), diagnostic: '', reusedFrom: null, stage: 'task', dirty: false, targeted: true };
  const early = { gate: 'integration', id: 'budget-js', required: true, reason: 'toujours (sans when)', files: [] };
  assert.equal(validateReceipt({ ...base, status: 'passed', exitCode: 0, early }).early.gate, 'integration');
  assert.equal(validateReceipt({ ...base, status: 'not_required', exitCode: null, early: { ...early, required: false } }).status, 'not_required');
  assert.throws(() => validateReceipt({ ...base, status: 'not_required', exitCode: null, early }), /not_required/);
  assert.throws(() => validateReceipt({ ...base, status: 'passed', exitCode: 0, early: { ...early, required: false } }), /not_required/);
  assert.throws(() => validateReceipt({ ...base, status: 'passed', exitCode: 0, targeted: undefined, early }), /early/);
  assert.throws(() => validateReceipt({ ...base, status: 'passed', exitCode: 0, stage: 'full', early }), /early/);
});

test('AC-EARLY-BASE: the base keeps its early checks and its `when`; a candidate only adds or widens them', () => {
  const cmd = ['true'];
  const parse = (gates) => { const r = configIssues({ gates }); assert.deepEqual(r.issues, []); return r.config; };
  const build = { id: 'build', command: cmd };
  const at = (early) => parse([build, { id: 'integration', stage: 'full', command: cmd, early }]);
  const base = at([{ id: 'budget-js', when: ['src/**', 'static/**'], dependsOn: ['build'], command: cmd }]);
  const early = (config) => config.gates.find(g => g.id === 'integration').early;

  // Narrowed `when`: the globs of the base are kept, the candidate's added.
  let r = enforceBaseGates(at([{ id: 'budget-js', when: ['src/lib/**'], dependsOn: ['build'], command: cmd }]), base);
  assert.deepEqual(early(r.config)[0].when, ['src/**', 'static/**', 'src/lib/**']);
  assert.deepEqual(r.differences, [{ id: 'budget-js', kind: 'early' }]);
  // `when` removed by the base or the candidate: always run.
  r = enforceBaseGates(at([{ id: 'budget-js', dependsOn: ['build'], command: cmd }]), base);
  assert.ok(!('when' in early(r.config)[0])); assert.deepEqual(r.differences, []);
  // Removed, or its command changed, by the candidate: the base definition runs.
  r = enforceBaseGates(at(undefined), base);
  assert.deepEqual(early(r.config), early(base)); assert.deepEqual(r.differences, [{ id: 'budget-js', kind: 'early' }]);
  r = enforceBaseGates(at([{ id: 'budget-js', when: ['src/**', 'static/**'], dependsOn: ['build'], command: ['false'] }]), base);
  assert.deepEqual(early(r.config), early(base));
  // Added beside the base's: kept, the full check is not « changed » (its definition otherwise unchanged).
  r = enforceBaseGates(at([...early(base), { id: 'captures', command: cmd }]), base);
  assert.deepEqual(early(r.config).map(e => e.id), ['budget-js', 'captures']); assert.deepEqual(r.differences, []);
  // A real change of the full check still keeps the whole base definition, its early checks included.
  const changed = parse([build, { id: 'integration', stage: 'full', command: ['false'], early: [{ id: 'other', command: cmd }] }]);
  r = enforceBaseGates(changed, base);
  assert.deepEqual(r.config.gates.find(g => g.id === 'integration'), base.gates.find(g => g.id === 'integration'));
  assert.deepEqual(r.differences, [{ id: 'integration', kind: 'changed' }]);
  // The task check an early check of the base depends on, removed by the candidate: kept as a dependency.
  r = enforceBaseGates(parse([{ id: 'integration', stage: 'full', command: cmd }]), base);
  assert.ok(r.config.gates.some(g => g.id === 'build'));
});

test('AC-EARLY-BASE: a pull request that narrows `when` still runs the early check on a change the base covers', async t => {
  const p = probe(t);
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { gates: gatesOf(p) });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  write(f.repo, '.apv/config.json', { gates: gatesOf(p, [budget(p, { when: ['nothing/**'] })]) });
  write(f.repo, 'src/routes/guides/x.svelte', '<p>guide</p>\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'narrow');
  const r = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--base', 'HEAD~1', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json().gates.find(g => g.gate === 'budget-js').status, 'passed');
  assert.deepEqual(r.json().baseGates.differences, [{ id: 'budget-js', kind: 'early' }]);
});

test('--only of a full check at the task stage brings its early checks and their dependencies', async t => {
  const p = probe(t);
  const f = project(t, gatesOf(p), { 'src/a.ts': 'export {};\n' });
  const r = await runGates({ repo: f.repo, config: loadConfig(f.repo).config, stage: 'task', base: 'HEAD~1', only: ['integration'] });
  assert.deepEqual(r.receipts.map(x => x.gateId), ['build', 'budget-js']);
  assert.deepEqual(r.added, ['build']);
  assert.deepEqual(r.reserved, ['integration']);
});

test('the loader: early belongs to a full check, ids are unique, it depends on task checks only, `when` is portable', () => {
  const cmd = ['true'];
  const issues = (gates) => configIssues({ gates }).issues.map(i => i.message);
  const build = { id: 'build', command: cmd };
  assert.deepEqual(issues([build, { id: 'unit', command: cmd, early: [{ id: 'e', command: cmd }] }]),
    ['Gate unit: early checks run at the task stage for a full check; declare "stage": "full"']);
  assert.deepEqual(issues([build, { id: 'integration', stage: 'full', command: cmd, early: [{ id: 'build', command: cmd }] }]),
    ['Gate integration: early check id build is already used by a check or another early check']);
  assert.deepEqual(issues([build, { id: 'a', stage: 'full', command: cmd, early: [{ id: 'e', command: cmd }] }, { id: 'b', stage: 'full', command: cmd, early: [{ id: 'e', command: cmd }] }]),
    ['Gate b: early check id e is already used by a check or another early check']);
  assert.deepEqual(issues([build, { id: 'browser', stage: 'full', command: cmd }, { id: 'integration', stage: 'full', command: cmd, early: [{ id: 'e', command: cmd, dependsOn: ['browser'] }] }]),
    ['Gate integration: early check e depends on browser, which is not a check of stage task (an early check runs at the task stage)']);
  assert.deepEqual(issues([build, { id: 'integration', stage: 'full', command: cmd, early: [{ id: 'e', command: cmd, dependsOn: ['nope'] }] }]),
    ['Gate integration: early check e depends on nope, which is not a check of stage task (an early check runs at the task stage)']);
  assert.match(issues([build, { id: 'integration', stage: 'full', command: cmd, early: [{ id: 'e', command: cmd, when: ['src/{a,b}/**'] }] }])[0], /Gate integration: early check e: when:/);
  assert.match(issues([build, { id: 'integration', stage: 'full', command: cmd, early: [] }])[0], /early/);

  // AC-MIGRATION: without early, the parsed check has no such field and hashes as before.
  const without = configIssues({ gates: [build, { id: 'integration', stage: 'full', command: cmd }] }).config;
  assert.ok(!('early' in without.gates[1]));
  const withIt = configIssues({ gates: [build, { id: 'integration', stage: 'full', command: cmd, early: [{ id: 'e', command: cmd }] }] }).config;
  assert.notEqual(gatesConfigHash(withIt), gatesConfigHash(without));
  assert.deepEqual(earlyGates(without.gates), []);
  const [synthetic] = earlyGates(withIt.gates);
  assert.equal(synthetic.gate.id, 'e'); assert.equal(synthetic.gate.stage, 'task'); assert.equal(synthetic.parent, 'integration');
  assert.equal(synthetic.gate.timeoutMs, 120000);
});

test('apv onboard points at a script of changed tests: affected, then the early checks', t => {
  const f = fixture(t, { files: { 'package.json': JSON.stringify({ scripts: { 'test:e2e': 'playwright test', 'test:e2e:changed': 'node scripts/changed.mjs' } }) } });
  assert.deepEqual(targetedHints(f.repo), ['package.json, script « test:e2e:changed » (node scripts/changed.mjs)']);
  const none = fixture(t, { files: { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) } });
  assert.deepEqual(targetedHints(none.repo), []);
});

test('apv onboard --dry-run shows the hint and the reminder of the early checks', async t => {
  const f = fixture(t, { files: { 'package.json': JSON.stringify({ scripts: { 'test:e2e': 'playwright test', 'test:e2e:changed': 'node scripts/changed.mjs' } }) } });
  const r = await apv(f.repo, ['onboard', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Tests ciblés : package\.json, script « test:e2e:changed » \(node scripts\/changed\.mjs\) : à déclarer en affected d'un contrôle de stage full/);
  assert.match(r.stdout, /déclarer aussi en early les commandes rapides qui échouent en fin de suite \(budget de taille, captures\)/);
  const json = await apv(f.repo, ['onboard', '--dry-run', '--json']);
  assert.deepEqual(json.json().targetedHints, ['package.json, script « test:e2e:changed » (node scripts/changed.mjs)']);
});
