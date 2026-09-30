import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { enforceBaseGates } from '../dist/gates/base-gates.js';
import { apvConfigSchema } from '../dist/config/load.js';

const node = code => [process.execPath, '-e', code];
const gate = (id, code, extra = {}) => ({ id, command: node(code), readOnly: true, ...extra });

/** A project whose main declares mandatory checks, `origin/main` on it, and a candidate branch. */
function project(t, gates) {
  const f = fixture(t, { files: { '.apv/config.json': JSON.stringify({ gates }, null, 2) } });
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(f.repo, 'switch', '-q', '-c', 'feature');
  const candidate = next => { write(f.repo, '.apv/config.json', { gates: next }); git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'candidate'); };
  return { ...f, candidate };
}

test('a mandatory check removed, made optional or changed by the candidate is still required with its base definition', async t => {
  const base = [gate('unit', 'process.exit(0)', { mandatory: true }), gate('lint', 'process.exit(3)', { mandatory: true }), gate('style', 'process.exit(0)', { mandatory: true })];
  const f = project(t, base);
  // Removed, loosened by a command that always passes, made optional: the base definitions run, lint fails as at the base.
  f.candidate([gate('lint', 'process.exit(0)', { mandatory: true }), gate('style', 'process.exit(0)'), gate('extra', 'process.exit(0)')]);
  const r = await apv(f.repo, ['gates', 'run', '--keep-going', '--json']);
  assert.equal(r.code, 1, 'lint runs its base command, which fails');
  const out = r.json();
  assert.deepEqual(out.baseGates.differences.sort((a, b) => (a.id < b.id ? -1 : 1)), [{ id: 'lint', kind: 'changed' }, { id: 'style', kind: 'optional' }, { id: 'unit', kind: 'removed' }]);
  assert.equal(out.baseGates.reference, 'origin/main');
  assert.deepEqual(Object.fromEntries(out.gates.map(g => [g.gate, g.status])), { lint: 'failed', style: 'passed', extra: 'passed', unit: 'passed' });
  const text = await apv(f.repo, ['gates', 'run', '--keep-going']);
  assert.match(text.stderr, /Contrôles de la base maintenus avec leur définition de base \(base [0-9a-f]{12}, origin\/main\) : unit \(retiré par le candidat\), lint \(modifié par le candidat\), style \(rendu facultatif par le candidat\)\. Le candidat peut seulement ajouter ou durcir/);
});

test('the candidate can add checks or harden them; a kept check brings its dependencies; without reference nothing is read', async t => {
  const base = [gate('build', 'process.exit(0)'), gate('unit', 'process.exit(0)', { mandatory: true, dependsOn: ['build'] }), gate('opt', 'process.exit(0)')];
  const f = project(t, base);
  f.candidate([gate('opt', 'process.exit(0)', { mandatory: true }), gate('new', 'process.exit(0)', { mandatory: true })]);
  const out = (await apv(f.repo, ['gates', 'run', '--json'])).json();
  // Every check of the base is kept (build as well); opt made mandatory is a hardening, kept as the candidate says.
  assert.deepEqual(out.baseGates.differences, [{ id: 'build', kind: 'removed' }, { id: 'unit', kind: 'removed' }]);
  assert.equal(enforceBaseGates(apvConfigSchema.parse({ gates: [gate('unit', '0', { mandatory: true, dependsOn: ['build'] })] }), apvConfigSchema.parse({ gates: [gate('build', '0'), gate('unit', '0', { mandatory: true, dependsOn: ['build'] })] })).differences[0].kind, 'removed');
  assert.deepEqual(out.gates.map(g => g.gate).sort(), ['build', 'new', 'opt', 'unit']);
  // No remote branch: the candidate's checks as they are, and it is said (file null).
  git(f.repo, 'update-ref', '-d', 'refs/remotes/origin/main');
  const alone = (await apv(f.repo, ['gates', 'run', '--json'])).json();
  assert.deepEqual([alone.baseGates.file, alone.gates.map(g => g.gate).sort()], [null, ['new', 'opt']]);
});

test('gates verify reads the same base: a proof made with the kept checks verifies; one made without them does not', async t => {
  const f = project(t, [gate('unit', 'process.exit(0)', { mandatory: true }), gate('lint', 'process.exit(0)', { mandatory: true })]);
  f.candidate([gate('unit', 'process.exit(0)', { mandatory: true })]);
  assert.equal((await apv(f.repo, ['gates', 'run'])).code, 0);
  const verified = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--json']);
  assert.equal(verified.code, 0, verified.stdout);
  assert.deepEqual(verified.json().baseGates.differences, [{ id: 'lint', kind: 'removed' }]);
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--against', 'origin/main'])).code, 0);
  // A proof made on the candidate's checks alone (a reference that knows nothing) does not prove the kept ones.
  const lonely = git(f.repo, 'commit-tree', '-m', 'lonely', git(f.repo, 'rev-parse', 'HEAD^{tree}'));
  git(f.repo, 'update-ref', 'refs/heads/lonely', lonely);
  const lonelyRun = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--against', 'lonely']);
  assert.equal(lonelyRun.code, 1, 'no merge base: refused, never the candidate checks alone');
  assert.match(lonelyRun.stderr, /GATE_BASE.*Aucune base commune entre lonely/);
});

test('a PR of configuration alone is proven by the checks of its base, then merged: the new list applies from then on', async t => {
  const f = project(t, [gate('unit', 'process.exit(0)', { mandatory: true }), gate('slow', 'process.exit(0)', { mandatory: true })]);
  f.candidate([gate('unit', 'process.exit(0)', { mandatory: true })]);
  const pr = (await apv(f.repo, ['gates', 'run', '--json'])).json();
  assert.deepEqual([pr.ok, pr.gates.map(g => g.gate).sort()], [true, ['slow', 'unit']], 'the PR itself still runs slow');
  // Merged by the operator: main now has the new list, and the next change is judged by it.
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const after = (await apv(f.repo, ['gates', 'run', '--json'])).json();
  assert.deepEqual([after.baseGates.differences, after.gates.map(g => g.gate)], [[], ['unit']]);
});

test('--against: an unknown reference is refused with what to do, a wrong call is an incorrect call', async t => {
  const f = project(t, [gate('unit', 'process.exit(0)', { mandatory: true })]);
  const missing = await apv(f.repo, ['gates', 'run', '--against', 'origin/nowhere']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /GATE_BASE.*origin\/nowhere.*git fetch/);
  assert.equal((await apv(f.repo, ['gates', 'run', '--against', '-x'])).code, 2);
  assert.match((await apv(f.repo, ['help', 'gates'])).stdout, /Contrôles de la base : run et verify/);
});

test('enforceBaseGates keeps the base definitions and never the candidate loosening', () => {
  const base = apvConfigSchema.parse({ gates: [gate('a', '0', { mandatory: true, stage: 'full' }), gate('b', '0')] });
  const candidate = apvConfigSchema.parse({ gates: [gate('a', '0', { mandatory: true, stage: 'task' }), gate('c', '0')] });
  const { config, differences } = enforceBaseGates(candidate, base);
  assert.deepEqual(differences, [{ id: 'a', kind: 'changed' }, { id: 'b', kind: 'removed' }]);
  assert.equal(config.gates.find(g => g.id === 'a').stage, 'full');
  assert.deepEqual(config.gates.map(g => g.id), ['a', 'c', 'b']);
  // Hardening only: the same definition made mandatory is the candidate's.
  const hardened = enforceBaseGates(apvConfigSchema.parse({ gates: [gate('b', '0', { mandatory: true })] }), apvConfigSchema.parse({ gates: [gate('b', '0')] }));
  assert.deepEqual([hardened.differences, hardened.config.gates[0].mandatory], [[], true]);
});

test('every check of the base is kept, mandatory or not: test replaced by true, integration removed, a check weakened', async t => {
  const f = project(t, [gate('test', 'process.exit(4)'), gate('integration', 'process.exit(0)', { stage: 'full' }), gate('lint', 'process.exit(0)', { timeoutMs: 60000 }), gate('opt', 'process.exit(0)')]);
  f.candidate([
    { id: 'test', command: ['true'], readOnly: true },
    gate('lint', 'process.exit(0)', { timeoutMs: 600000 }),
    gate('opt', 'process.exit(0)', { mandatory: true }),
  ]);
  const r = await apv(f.repo, ['gates', 'run', '--keep-going', '--json']);
  const out = r.json();
  assert.deepEqual(out.baseGates.differences, [{ id: 'test', kind: 'changed' }, { id: 'integration', kind: 'removed' }, { id: 'lint', kind: 'changed' }]);
  assert.equal(r.code, 1, 'test runs its base command, which fails');
  assert.deepEqual(Object.fromEntries(out.gates.map(g => [g.gate, g.status])), { test: 'failed', lint: 'passed', opt: 'passed', integration: 'passed' });
  // At the task stage, integration (full) is kept and reserved for the full suite, never dropped.
  const task = (await apv(f.repo, ['gates', 'run', '--stage', 'task', '--keep-going', '--json'])).json();
  assert.ok(task.reserved.includes('integration'));
});

test('the reference of the base: full refs only, checked against the remote; moved onto a commit the remote lacks, refused', async t => {
  const f = project(t, [gate('unit', 'process.exit(0)', { mandatory: true })]);
  const remote = `${f.root}/remote.git`;
  git(f.root, 'init', '-q', '--bare', remote);
  git(f.repo, 'remote', 'add', 'origin', remote);
  git(f.repo, 'push', '-q', 'origin', 'main');
  git(f.repo, 'fetch', '-q', 'origin');
  f.candidate([gate('unit', 'process.exit(0)', { mandatory: true })]);
  const ok = (await apv(f.repo, ['gates', 'run', '--json'])).json();
  assert.deepEqual([ok.baseGates.reference, ok.baseGates.warnings], ['origin/main', []]);
  // The remote-tracking ref moved locally onto the candidate: its configuration would judge itself. Refused.
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const moved = await apv(f.repo, ['gates', 'run']);
  assert.equal(moved.code, 1);
  assert.match(moved.stderr, /GATE_BASE.*origin\/main pointe localement sur [0-9a-f]{12}, que le dépôt distant ne contient pas/);
  // Behind the remote (not fetched): a warning.
  git(f.repo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  git(f.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');
  const behind = (await apv(f.repo, ['gates', 'run', '--json'])).json();
  assert.match(behind.baseGates.warnings.join(' '), /en retard sur le dépôt distant[^\n]*git fetch origin/);
  // Remote unreadable: said, never silently trusted.
  git(f.repo, 'remote', 'set-url', 'origin', `${f.root}/nowhere.git`);
  const offline = await apv(f.repo, ['gates', 'run']);
  assert.match(offline.stderr, /Attention : base non vérifiée auprès du dépôt distant \(origin illisible/);
  // Ambiguous name (a local branch named like the remote-tracking one): refused.
  git(f.repo, 'branch', 'origin/main');
  const ambiguous = await apv(f.repo, ['gates', 'run', '--against', 'origin/main']);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /GATE_BASE.*ambiguë/);
});
