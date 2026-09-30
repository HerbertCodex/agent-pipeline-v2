import { test } from 'node:test';
import { readFileSync } from 'node:fs';
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
  // This fixture has a remote-tracking ref but no remote to read: verify needs --offline (said, never silent).
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD'])).code, 1);
  const verified = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--offline', '--json']);
  assert.equal(verified.code, 0, verified.stdout);
  assert.deepEqual(verified.json().baseGates.differences, [{ id: 'lint', kind: 'removed' }]);
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--against', 'origin/main', '--offline'])).code, 0);
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

/** A project with a real bare remote: main pushed and fetched, and a second clone that can advance the remote. */
function withRemote(t, gates) {
  const f = project(t, gates);
  const remote = `${f.root}/remote.git`;
  git(f.root, 'init', '-q', '--bare', remote);
  git(f.repo, 'remote', 'add', 'origin', remote);
  git(f.repo, 'push', '-q', 'origin', 'main');
  git(f.repo, 'fetch', '-q', 'origin');
  const other = `${f.root}/other`;
  git(f.root, 'clone', '-q', '-b', 'main', remote, other);
  /** Another PR merged on the remote, never fetched here. */
  const advance = () => {
    write(other, 'docs/merged.md', `merged ${Date.now()}\n`);
    git(other, 'add', '-A'); git(other, 'commit', '-qm', 'another PR'); git(other, 'push', '-q', 'origin', 'HEAD:main');
    return git(other, 'rev-parse', 'HEAD');
  };
  return { ...f, remote, advance };
}

test('the remote advanced without a local fetch: its branch is fetched, then run and verify pass on the remote base', async t => {
  const f = withRemote(t, [gate('unit', 'process.exit(0)', { mandatory: true })]);
  f.candidate([gate('unit', 'process.exit(0)', { mandatory: true })]);
  const merged = f.advance();
  const run = await apv(f.repo, ['gates', 'run', '--json']);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.match(run.json().baseGates.warnings.join(' '), /origin\/main récupérée auprès du dépôt distant \([0-9a-f]{12} -> [0-9a-f]{12}\)/);
  assert.equal(git(f.repo, 'rev-parse', 'refs/remotes/origin/main'), merged, 'the remote-tracking ref is up to date');
  const verify = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD']);
  assert.equal(verify.code, 0, verify.stdout + verify.stderr);
  // Offline: not verified, said, never refused.
  git(f.repo, 'remote', 'set-url', 'origin', `${f.root}/nowhere.git`);
  const offline = await apv(f.repo, ['gates', 'run']);
  assert.equal(offline.code, 0, offline.stderr);
  assert.match(offline.stderr, /Attention : base non vérifiée auprès du dépôt distant \(origin illisible[^\n]*git fetch origin/);
  // verify refuses an unreadable remote, unless --offline says it (then a warning, and the proof is checked).
  const refused = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /GATE_BASE.*base non vérifiée auprès du dépôt distant.*--offline pour l'accepter en le disant/);
  const accepted = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--offline']);
  assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
  assert.match(accepted.stdout, /^Attention : base non vérifiée auprès du dépôt distant/);
  assert.equal((await apv(f.repo, ['gates', 'run', '--offline'])).code, 2, '--offline belongs to verify');
});

test('the automatic fetch never starts a garbage collection', () => {
  const source = readFileSync(new URL('../src/gates/base-gates.ts', import.meta.url), 'utf8');
  assert.match(source, /'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-auto-gc'/);
});

test('a reference moved back: run warns, verify refuses; moved out of the remote history: refused', async t => {
  const f = withRemote(t, [gate('unit', 'process.exit(0)', { mandatory: true })]);
  f.advance();
  git(f.repo, 'fetch', '-q', 'origin');
  f.candidate([gate('unit', 'process.exit(0)', { mandatory: true })]);
  assert.equal((await apv(f.repo, ['gates', 'run'])).code, 0);
  // Moved back onto an ancestor the remote has: behind.
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'main');
  const behind = await apv(f.repo, ['gates', 'run', '--json']);
  assert.equal(behind.code, 0);
  assert.match(behind.json().baseGates.warnings.join(' '), /origin\/main \([0-9a-f]{12}\) est en retard sur le dépôt distant[^\n]*git fetch origin/);
  const refused = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /GATE_BASE.*est en retard sur le dépôt distant.*jamais sur une base en retard/);
  // Moved onto the candidate, which the remote does not contain: refused, for run as for verify.
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const moved = await apv(f.repo, ['gates', 'run']);
  assert.equal(moved.code, 1);
  assert.match(moved.stderr, /GATE_BASE.*origin\/main pointe localement sur [0-9a-f]{12}, que le dépôt distant ne contient pas/);
  // Ambiguous name (a local branch named like the remote-tracking one): refused.
  git(f.repo, 'fetch', '-q', 'origin');
  git(f.repo, 'branch', 'origin/main');
  const ambiguous = await apv(f.repo, ['gates', 'run', '--against', 'origin/main']);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /GATE_BASE.*ambiguë/);
});

test('a local branch with a remote twin as base, or a remote without any base applied: warned', async t => {
  const f = withRemote(t, [gate('unit', 'process.exit(0)', { mandatory: true })]);
  f.candidate([gate('unit', 'process.exit(0)', { mandatory: true })]);
  const local = await apv(f.repo, ['gates', 'run', '--against', 'main']);
  assert.match(local.stderr, /main est une branche locale, qui peut différer de origin\/main : pour la base des contrôles, passer la branche distante \(--against origin\/main\)/);
  git(f.repo, 'update-ref', '-d', 'refs/remotes/origin/main');
  const none = await apv(f.repo, ['gates', 'run']);
  assert.match(none.stderr, /le dépôt a un dépôt distant \(origin\) mais aucune base n'est appliquée aux contrôles/);
});
