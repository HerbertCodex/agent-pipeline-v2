import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apv } from './cli-helpers.mjs';
import { evaluateCommand, REASONS } from '../hooks/scripts/bash-guard.mjs';
import { hookContext } from '../hooks/scripts/harness-guard.mjs';
import { LockStore } from '../dist/lock/store.js';

/** Release decoupled from the merge: the task proof at the merge (light mode), the full suite at `apv release`. */

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim();
const put = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };
const node = code => [process.execPath, '-e', code];
const RELEASE = { branch: 'production', from: 'main' };
const rule = (report, id) => report.rules.find(r => r.rule === id);

/** An origin and a clone with main (and production at the same commit when `release`), checked out on main. */
function project(t, { release = RELEASE, gates = [{ id: 'lint', stage: 'task', command: node('0') }, { id: 'unit', stage: 'full', command: node('0') }] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apv4-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(root, 'repo');
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'switch', '-q', '-c', 'main');
  put(repo, '.apv/config.json', { name: 'essai', gates, ...(release ? { release } : {}) });
  put(repo, '.gitignore', '.apv/receipts/\n.apv/state/\n');
  put(repo, 'README.md', 'projet\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'push', '-q', 'origin', 'main');
  if (release) git(repo, 'push', '-q', 'origin', 'main:production');
  const commit = (path, text) => { put(repo, path, text); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', path); return git(repo, 'rev-parse', 'HEAD'); };
  const remote = ref => git(origin, 'rev-parse', ref);
  return { root, repo, origin, commit, remote };
}

test('rules check, light mode: with release the task proof suffices on main, without it the full suite is asked', async t => {
  for (const release of [RELEASE, null]) {
    const p = project(t, { release });
    git(p.repo, 'switch', '-q', '-c', 'feat');
    const head = p.commit('notes.txt', 'x\n');
    const task = await apv(p.repo, ['gates', 'run', '--stage', 'task', '--base', 'origin/main', '--json']);
    assert.equal(task.code, 0, task.stdout + task.stderr);
    const r = await apv(p.repo, ['rules', 'check', '--commit', head, '--target', 'origin/main', '--offline', '--json']);
    const preuve = rule(r.json(), 'preuve');
    if (release) {
      assert.equal(preuve.status, 'ok', JSON.stringify(preuve));
      assert.match(preuve.detail, /de tâche prouvé/);
      const text = await apv(p.repo, ['rules', 'check', '--commit', head, '--target', 'origin/main', '--offline']);
      assert.match(text.stdout, /Preuve de tâche suffit : la suite complète est exigée à la mise en ligne/);
    } else {
      assert.equal(preuve.status, 'refused');
      assert.match(preuve.problems[0], /unit \(missing\)/);
    }
  }
});

test('rules check, light mode with release: a task check passed only after a relaunch still refuses (instable)', async t => {
  const marker = join(mkdtempSync(join(tmpdir(), 'apv4-release-flaky-')), 'first');
  t.after(() => rmSync(dirname(marker), { recursive: true, force: true }));
  const first = `const fs=require("fs"); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, ""); console.log("  1) [chromium] › a.spec.ts:3:5 › carte"); process.exit(1); }`;
  const p = project(t, { gates: [{ id: 'browser', stage: 'task', command: node(first), retryFailed: { command: node('0'), testPattern: '^\\s*\\d+\\) (\\[[^\\]]+\\] › .+?)\\s*$' } }] });
  git(p.repo, 'switch', '-q', '-c', 'feat');
  const head = p.commit('notes.txt', 'x\n');
  assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'task', '--base', 'origin/main'])).code, 0);
  const report = (await apv(p.repo, ['rules', 'check', '--commit', head, '--target', 'origin/main', '--offline', '--json'])).json();
  assert.equal(rule(report, 'preuve').status, 'ok');
  assert.equal(rule(report, 'instable').status, 'refused');
});

test('apv release: refused without the section, outside main, backwards, without the full suite', async t => {
  const none = project(t, { release: null });
  const r0 = await apv(none.repo, ['release', '--dry-run']);
  assert.equal(r0.code, 1);
  assert.match(r0.stderr, /section release absente/);

  const p = project(t);
  const first = p.commit('a.txt', 'a\n');
  git(p.repo, 'push', '-q', 'origin', 'main');
  const missing = await apv(p.repo, ['release', '--dry-run']);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /suite complète non prouvée .*unit \(missing\)/);

  git(p.repo, 'switch', '-q', '-c', 'feat');
  const outside = p.commit('b.txt', 'b\n');
  const r1 = await apv(p.repo, ['release', outside, '--dry-run']);
  assert.equal(r1.code, 1);
  assert.match(r1.stdout, /n'est pas dans origin\/main/);

  git(p.repo, 'switch', '-q', 'main');
  const second = p.commit('c.txt', 'c\n');
  git(p.repo, 'push', '-q', 'origin', 'main');
  git(p.repo, 'push', '-q', 'origin', `${second}:refs/heads/production`);
  const back = await apv(p.repo, ['release', first, '--dry-run']);
  assert.equal(back.code, 1);
  assert.match(back.stdout, /n'est pas un ancêtre .*jamais de retour en arrière/);
  assert.equal(p.remote('production'), second);
});

test('apv release: refuses a flaky full suite', async t => {
  const marker = join(mkdtempSync(join(tmpdir(), 'apv4-release-flaky-')), 'first');
  t.after(() => rmSync(dirname(marker), { recursive: true, force: true }));
  const first = `const fs=require("fs"); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, ""); console.log("  1) [chromium] › a.spec.ts:3:5 › carte"); process.exit(1); }`;
  const p = project(t, { gates: [{ id: 'browser', stage: 'full', command: node(first), retryFailed: { command: node('0'), testPattern: '^\\s*\\d+\\) (\\[[^\\]]+\\] › .+?)\\s*$' } }] });
  p.commit('a.txt', 'a\n');
  git(p.repo, 'push', '-q', 'origin', 'main');
  assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/production'])).code, 0);
  const r = await apv(p.repo, ['release']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /réussi\(s\) seulement après relance .*browser/);
});

test('apv release: --dry-run pushes nothing; then a fast-forward push, read back and journaled', async t => {
  const p = project(t);
  const before = p.remote('production');
  const sha = p.commit('a.txt', 'a\n');
  git(p.repo, 'push', '-q', 'origin', 'main');
  assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/production'])).code, 0);
  const dry = await apv(p.repo, ['release', '--dry-run']);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /--dry-run : rien n'est poussé/);
  assert.equal(p.remote('production'), before);
  const done = await apv(p.repo, ['release', '--json']);
  assert.equal(done.code, 0, done.stdout + done.stderr);
  assert.equal(done.json().published, true);
  assert.equal(p.remote('production'), sha);
  const log = readFileSync(join(p.repo, '.apv/state/stack.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(log.map(l => [l.event, l.commit, l.published]), [['release', sha, true]]);
  const again = await apv(p.repo, ['release']);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /déjà à .* rien à publier/);
});

test('apv release auto: nothing to publish, proven head published, red suite never published', async t => {
  const p = project(t);
  const idle = await apv(p.repo, ['release', 'auto']);
  assert.equal(idle.code, 0, idle.stdout + idle.stderr);
  assert.match(idle.stdout, /Rien à publier/);

  const proven = p.commit('a.txt', 'a\n');
  git(p.repo, 'push', '-q', 'origin', 'main');
  assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/production'])).code, 0);
  const published = await apv(p.repo, ['release', 'auto']);
  assert.equal(published.code, 0, published.stdout + published.stderr);
  assert.equal(p.remote('production'), proven);

  // Not proven yet: the suite runs in a detached copy (green here), then the head is published.
  const fresh = p.commit('b.txt', 'b\n');
  git(p.repo, 'push', '-q', 'origin', 'main');
  const ran = await apv(p.repo, ['release', 'auto']);
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  assert.equal(p.remote('production'), fresh);
  assert.equal(existsSync(join(git(p.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'apv', 'release', fresh.slice(0, 12))), false, 'copy removed');

  // A check that fails: the suite runs red, nothing is published, and the next pass does not run it again.
  put(p.repo, '.apv/config.json', { name: 'essai', gates: [{ id: 'unit', stage: 'full', command: node('process.exit(1)') }], release: RELEASE });
  git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'rouge'); git(p.repo, 'push', '-q', 'origin', 'main');
  const red = await apv(p.repo, ['release', 'auto']);
  assert.equal(red.code, 1, red.stdout + red.stderr);
  assert.match(red.stdout, /rouge ou instable .*unit \(failed\).*rien n'est publié/);
  assert.equal(p.remote('production'), fresh);
  const next = await apv(p.repo, ['release', 'auto']);
  assert.equal(next.code, 1);
  assert.match(next.stdout, /déjà passée .*ni relancé/);
});

test('apv release auto: the queue of the full suites held, it does not wait and publishes nothing', async t => {
  const p = project(t);
  p.commit('a.txt', 'a\n');
  git(p.repo, 'push', '-q', 'origin', 'main');
  const common = git(p.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const store = new LockStore(join(common, 'apv', 'locks'));
  const held = await store.tryAcquire('full-suite', { pid: process.pid, host: store.host, label: 'autre suite' }, 600, 'suite complète');
  assert.equal(held.ok, true);
  const busy = await apv(p.repo, ['release', 'auto']);
  await store.release('full-suite', { token: held.record.token });
  assert.equal(busy.code, 0, busy.stdout + busy.stderr);
  assert.match(busy.stdout, /Machine occupée/);
  assert.notEqual(p.remote('production'), p.remote('main'));
});

test('guard: a push that writes the production branch is refused, apv release with its authorisation is not', () => {
  const deny = command => evaluateCommand(command).decision;
  assert.equal(deny('git push origin HEAD:production'), 'deny');
  assert.equal(evaluateCommand('git push origin abc123:refs/heads/production').reason, REASONS.pushToRelease('production'));
  assert.equal(deny('git push --force origin production'), 'deny');
  assert.equal(deny('git push origin +main:production'), 'deny');
  assert.equal(deny('git push origin feat/x'), 'allow');
  assert.equal(deny('APV_ALLOW_MERGE=1 apv release 0123456789ab'), 'allow');
  assert.equal(deny('apv release --dry-run'), 'allow');
  assert.equal(deny('apv release auto'), 'deny');
  assert.equal(evaluateCommand('APV_ALLOW_MERGE=1 apv release', {}, { ...hookContext({ cwd: tmpdir() }), agentId: 'a1', apvProject: () => true }).decision, 'deny');
});

test('guard: the production branch is read from the configuration; unreadable, production stays refused', t => {
  const p = project(t, { release: { branch: 'en-ligne', from: 'main' } });
  const context = hookContext({ cwd: p.repo });
  assert.equal(evaluateCommand('git push origin main:en-ligne', {}, context).decision, 'deny');
  assert.equal(evaluateCommand('git push origin main:feat', {}, context).decision, 'allow');
  put(p.repo, '.apv/config.json', '{ illisible');
  assert.equal(evaluateCommand('git push origin main:production', {}, hookContext({ cwd: p.repo })).decision, 'deny');
});
