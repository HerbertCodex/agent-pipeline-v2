import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';

const spec = {
  title: 'Livraison', problem: 'La documentation doit être écrite.', scope: ['Documentation'], outOfScope: [],
  acceptance: [{ id: 'AC-1', description: 'Partie écrite.', verification: 'Lire docs/a.md.' }], decisions: [], questions: [],
  tasks: [{ id: 'A', title: 'Tâche A', description: 'Écrire docs/a.md.', acceptanceIds: ['AC-1'], allowedPaths: ['docs/a.md'], dependsOn: [], minimumLane: 'standard' }],
  minimumLane: 'standard',
};

function project(t) {
  const f = fixture(t);
  write(f.repo, '.apv/specs/livraison.json', spec);
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'spec');
  const env = { APV_LOCK_DIR: join(f.root, 'locks'), APV_LOCK_POLL_MS: '20', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'commit.gpgsign', GIT_CONFIG_VALUE_1: 'false' };
  const run = (...args) => apv(f.repo, ['run', ...args], env);
  return { ...f, run };
}

const committed = (repo, ref = 'HEAD') => git(repo, 'show', '--name-only', '--format=%s', ref).split('\n').filter(Boolean);
const trailer = (repo, ref = 'HEAD') => git(repo, 'log', '-1', '--format=%(trailers:key=Generated-by,valueonly)', ref).trim();

test('delivery running commits the state of the execution, and only it, on the branch of the execution', async t => {
  const p = project(t);
  git(p.repo, 'switch', '-q', '-c', 'apv/livraison');
  assert.equal((await p.run('start', 'livraison')).code, 0);
  write(p.repo, '.apv/state/resume.md', '# Reprise\n');
  // Another file staged by the lead stays staged, never committed with the state.
  write(p.repo, 'docs/other.md', 'staged\n');
  git(p.repo, 'add', 'docs/other.md');
  const before = git(p.repo, 'rev-parse', 'HEAD');
  const r = await p.run('set', 'livraison', 'delivery', 'running');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /état commité sur apv\/livraison : [0-9a-f]{12} \(\.apv\/state\/resume\.md, \.apv\/state\/run-livraison\.json\)/);
  assert.match(r.stdout, /la suite complète de livraison tourne sur cette tête/);
  assert.equal(git(p.repo, 'rev-parse', 'HEAD~1'), before);
  assert.deepEqual(committed(p.repo), ['chore(apv) : état de l\'exécution livraison (livraison)', '.apv/state/resume.md', '.apv/state/run-livraison.json']);
  assert.equal(trailer(p.repo), 'apv run set');
  assert.equal(git(p.repo, 'status', '--porcelain', '--', '.apv/state'), '');
  assert.equal(git(p.repo, 'diff', '--cached', '--name-only'), 'docs/other.md');
  // Nothing new: nothing committed.
  const again = await p.run('save', 'livraison');
  assert.equal(again.code, 0);
  assert.match(again.stdout, /état déjà commité, rien à faire/);
  // A later transition, then a save point: one more commit of the state only.
  const done = await p.run('set', 'livraison', 'delivery', 'done', '--note', 'PR #1');
  assert.equal(done.code, 0, done.stdout + done.stderr);
  const saved = await p.run('save', 'livraison', '--json');
  assert.equal(saved.code, 0, saved.stdout + saved.stderr);
  assert.deepEqual(saved.json().stateCommit.files, ['.apv/state/run-livraison.json']);
  assert.equal(committed(p.repo)[0], 'chore(apv) : état de l\'exécution livraison (sauvegarde)');
});

test('the state is not committed with --no-commit-state, nor on another branch, nor on a detached head', async t => {
  const p = project(t);
  git(p.repo, 'switch', '-q', '-c', 'apv/livraison');
  await p.run('start', 'livraison');
  const head = git(p.repo, 'rev-parse', 'HEAD');
  const skipped = await p.run('set', 'livraison', 'delivery', 'running', '--no-commit-state');
  assert.equal(skipped.code, 0);
  assert.doesNotMatch(skipped.stdout, /état/);
  assert.equal(git(p.repo, 'rev-parse', 'HEAD'), head);
  git(p.repo, 'switch', '-q', '-c', 'autre');
  const other = await p.run('set', 'livraison', 'delivery', 'running', '--note', 'relance');
  assert.equal(other.code, 0, 'the transition is recorded');
  assert.match(other.stdout, /ATTENTION : état non commité : le checkout .* est sur autre, pas sur la branche de l'exécution apv\/livraison/);
  assert.equal(git(p.repo, 'rev-parse', 'HEAD'), head);
  const refused = await p.run('save', 'livraison');
  assert.equal(refused.code, 1);
  git(p.repo, 'switch', '-q', '--detach');
  assert.match((await p.run('save', 'livraison')).stdout, /tête détachée/);
  // A branch of the execution with a suffix (apv/<id>-…) is the execution's.
  git(p.repo, 'switch', '-q', '-c', 'apv/livraison-livraison');
  const suffixed = await p.run('save', 'livraison');
  assert.equal(suffixed.code, 0, suffixed.stdout);
  assert.match(suffixed.stdout, /état commité sur apv\/livraison-livraison/);
});

test('without a Git identity the state is not committed, with a clear message', async t => {
  const p = project(t);
  git(p.repo, 'switch', '-q', '-c', 'apv/livraison');
  await p.run('start', 'livraison');
  const head = git(p.repo, 'rev-parse', 'HEAD');
  const none = { HOME: p.root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: '', EMAIL: '' };
  const r = await apv(p.repo, ['run', 'save', 'livraison'], { APV_LOCK_DIR: join(p.root, 'locks'), ...none });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /état non commité : identité Git absente : git config user\.name/);
  assert.equal(git(p.repo, 'rev-parse', 'HEAD'), head);
});

test('the state commit never runs the hooks of the project', async t => {
  const p = project(t);
  git(p.repo, 'switch', '-q', '-c', 'apv/livraison');
  await p.run('start', 'livraison');
  write(p.repo, '.git/hooks-projet/pre-commit', '#!/bin/sh\nexit 1\n');
  chmodSync(join(p.repo, '.git/hooks-projet/pre-commit'), 0o755);
  git(p.repo, 'config', 'core.hooksPath', '.git/hooks-projet');
  const r = await apv(p.repo, ['run', 'save', 'livraison'], { APV_LOCK_DIR: join(p.root, 'locks'), GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /état commité sur apv\/livraison/);
});
