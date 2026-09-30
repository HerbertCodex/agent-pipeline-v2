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
  assert.match(text.stderr, /Contrôles obligatoires de la base maintenus avec leur définition de base \(base [0-9a-f]{12}, origin\/main\) : unit \(retiré par le candidat\), lint \(modifié par le candidat\), style \(rendu facultatif par le candidat\)\. Le candidat peut seulement ajouter ou durcir/);
});

test('the candidate can add checks or harden them; a kept check brings its dependencies; without reference nothing is read', async t => {
  const base = [gate('build', 'process.exit(0)'), gate('unit', 'process.exit(0)', { mandatory: true, dependsOn: ['build'] }), gate('opt', 'process.exit(0)')];
  const f = project(t, base);
  f.candidate([gate('opt', 'process.exit(0)', { mandatory: true }), gate('new', 'process.exit(0)', { mandatory: true })]);
  const out = (await apv(f.repo, ['gates', 'run', '--json'])).json();
  assert.deepEqual(out.baseGates.differences, [{ id: 'unit', kind: 'removed' }, { id: 'build', kind: 'dependency' }]);
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
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--against', 'lonely'])).code, 1, 'no merge base: the candidate checks only, another configuration');
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
  assert.match((await apv(f.repo, ['help', 'gates'])).stdout, /Contrôles obligatoires de la base/);
});

test('enforceBaseGates keeps the base definitions and never the candidate loosening', () => {
  const base = apvConfigSchema.parse({ gates: [gate('a', '0', { mandatory: true, stage: 'full' }), gate('b', '0')] });
  const candidate = apvConfigSchema.parse({ gates: [gate('a', '0', { mandatory: true, stage: 'task' }), gate('c', '0')] });
  const { config, differences } = enforceBaseGates(candidate, base);
  assert.deepEqual(differences, [{ id: 'a', kind: 'changed' }]);
  assert.equal(config.gates.find(g => g.id === 'a').stage, 'full');
  assert.deepEqual(config.gates.map(g => g.id), ['a', 'c']);
});
