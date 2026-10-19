import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apv } from './cli-helpers.mjs';
import { evaluateCommand, REASONS } from '../hooks/scripts/bash-guard.mjs';
import { hookContext } from '../hooks/scripts/harness-guard.mjs';
import { LockStore } from '../dist/lock/store.js';
import { releaseTarget, stackRules } from '../dist/commands/stack.js';
import { journalEntry, operatorJournalPath, sentences, waiverFor } from '../dist/rules/operator.js';
import { TEST_KEY, commonDirOf, operatorSays } from './support/rules.mjs';

/** Release decoupled from the merge: the task proof at the merge (light mode), the full suite at `apv release`. */

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim();
const put = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };
const node = code => [process.execPath, '-e', code];
const ALLOW = { APV_ALLOW_MERGE: '1' };
const RELEASE = { branch: 'production', from: 'main' };
const rule = (report, id) => report.rules.find(r => r.rule === id);

/** An origin and a clone with main (and production at the same commit when `release`), checked out on main. */
function project(t, { release = RELEASE, extra = {}, gates = [{ id: 'lint', stage: 'task', command: node('0') }, { id: 'unit', stage: 'full', command: node('0') }] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apv4-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(root, 'repo');
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'switch', '-q', '-c', 'main');
  put(repo, '.apv/config.json', { name: 'essai', gates, ...extra, ...(release ? { release } : {}) });
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
      assert.equal(r.json().release.taskProof, true);
      assert.match(preuve.title, /^preuve de tâche au commit exact/);
      const text = await apv(p.repo, ['rules', 'check', '--commit', head, '--target', 'origin/main', '--offline']);
      assert.match(text.stdout, /Preuve de tâche suffit : la suite complète est exigée à la mise en ligne/);
    } else {
      assert.equal(preuve.status, 'refused');
      assert.match(preuve.problems[0], /unit \(missing\)/);
    }
  }
});

test('rules check, light mode with release: without any check of stage task at the base, the full suite is asked as before', async t => {
  const p = project(t, { gates: [{ id: 'unit', stage: 'full', command: node('0') }] });
  git(p.repo, 'switch', '-q', '-c', 'feat');
  const head = p.commit('notes.txt', 'x\n');
  const before = (await apv(p.repo, ['rules', 'check', '--commit', head, '--target', 'origin/main', '--offline', '--json'])).json();
  assert.equal(rule(before, 'preuve').status, 'refused');
  assert.match(rule(before, 'preuve').problems[0], /unit \(missing\)/);
  assert.deepEqual(before.release, { branch: 'production', from: 'main', taskProof: false });
  const text = await apv(p.repo, ['rules', 'check', '--commit', head, '--target', 'origin/main', '--offline']);
  assert.match(text.stdout, /Suite complète exigée avant fusion malgré release : la base ne déclare aucun contrôle de stage task/);
  assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/main'])).code, 0);
  const after = (await apv(p.repo, ['rules', 'check', '--commit', head, '--target', 'origin/main', '--offline', '--json'])).json();
  assert.equal(rule(after, 'preuve').status, 'ok');
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
  const r = await apv(p.repo, ['release'], ALLOW);
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
  const done = await apv(p.repo, ['release', '--json'], ALLOW);
  assert.equal(done.code, 0, done.stdout + done.stderr);
  assert.equal(done.json().published, true);
  assert.equal(p.remote('production'), sha);
  const log = readFileSync(join(p.repo, '.apv/state/stack.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(log.map(l => [l.event, l.commit, l.published]), [['release', sha, true]]);
  const again = await apv(p.repo, ['release'], ALLOW);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /déjà à .* rien à publier/);
});

test('apv release auto: nothing to publish, proven head published, red suite never published', async t => {
  const p = project(t, { gates: [{ id: 'unit', stage: 'full', command: node('process.exit(require("fs").existsSync("rouge.txt") ? 1 : 0)') }] });
  const idle = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(idle.code, 0, idle.stdout + idle.stderr);
  assert.match(idle.stdout, /Rien à publier/);

  const proven = p.commit('a.txt', 'a\n');
  git(p.repo, 'push', '-q', 'origin', 'main');
  assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/production'])).code, 0);
  const published = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(published.code, 0, published.stdout + published.stderr);
  assert.equal(p.remote('production'), proven);

  // Not proven yet: the suite runs in a detached copy (green here), then the head is published.
  const fresh = p.commit('b.txt', 'b\n');
  git(p.repo, 'push', '-q', 'origin', 'main');
  const ran = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  assert.equal(p.remote('production'), fresh);
  assert.equal(existsSync(join(git(p.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'apv', 'release', fresh.slice(0, 12))), false, 'copy removed');

  // A check that fails: the suite runs red, nothing is published, and the next pass does not run it again.
  p.commit('rouge.txt', 'rouge\n'); git(p.repo, 'push', '-q', 'origin', 'main');
  const red = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(red.code, 1, red.stdout + red.stderr);
  assert.match(red.stdout, /rouge ou instable .*unit \(failed\).*rien n'est publié/);
  assert.equal(p.remote('production'), fresh);
  const next = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(next.code, 0);
  assert.match(next.stdout, /Suite rouge à .*exécution .*nouveau commit sur main/);
});

test('apv release auto: a green receipt already there never suffices, the suite runs again in its copy', async t => {
  // The check passes once (the receipt of the operator's run), then fails: the cron must see it fail.
  const marker = join(mkdtempSync(join(tmpdir(), 'apv4-release-once-')), 'ran');
  t.after(() => rmSync(dirname(marker), { recursive: true, force: true }));
  const once = `const fs=require("fs"); if (fs.existsSync(${JSON.stringify(marker)})) process.exit(1); fs.writeFileSync(${JSON.stringify(marker)}, "");`;
  const p = project(t, { gates: [{ id: 'unit', stage: 'full', command: node(once) }] });
  const before = p.remote('production');
  p.commit('a.txt', 'a\n');
  git(p.repo, 'push', '-q', 'origin', 'main');
  assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/production'])).code, 0);
  assert.equal((await apv(p.repo, ['release', '--dry-run'])).code, 0, 'the receipt proves the commit for the manual release');
  const auto = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(auto.code, 1, auto.stdout + auto.stderr);
  assert.match(auto.stdout, /rouge ou instable .*unit \(failed\)/);
  assert.equal(p.remote('production'), before);
});

test('apv release: the checks of production are kept, a weakened check is never released (weaken.sh)', async t => {
  const p = project(t, { gates: [{ id: 'lint', stage: 'task', command: node('0') }, { id: 'unit', stage: 'full', command: node('process.exit(1)') }] });
  const before = p.remote('production');
  git(p.repo, 'switch', '-q', '-c', 'feat');
  put(p.repo, '.apv/config.json', { name: 'essai', gates: [{ id: 'lint', stage: 'task', command: node('0') }, { id: 'unit', stage: 'full', command: node('0') }], release: RELEASE });
  git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'weaken unit');
  git(p.repo, 'push', '-q', 'origin', 'feat:main');
  git(p.repo, 'switch', '-q', 'main'); git(p.repo, 'merge', '-q', '--ff-only', 'origin/main');
  assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'full'])).code, 0, 'the weakened suite passes');
  const dry = await apv(p.repo, ['release', '--dry-run']);
  assert.equal(dry.code, 1, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /contrôles de origin\/production compris : .*unit \(missing\)/);
  const auto = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(auto.code, 1, auto.stdout + auto.stderr);
  assert.match(auto.stdout, /unit \(failed\)/);
  assert.equal(p.remote('production'), before);
});

test('apv release: without APV_ALLOW_MERGE=1 the tool itself refuses (auto too), --dry-run stays free', async t => {
  const p = project(t);
  const before = p.remote('production');
  p.commit('a.txt', 'a\n');
  git(p.repo, 'push', '-q', 'origin', 'main');
  assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/production'])).code, 0);
  for (const args of [['release'], ['release', 'auto']]) {
    const r = await apv(p.repo, args, { APV_ALLOW_MERGE: '' });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /mise en ligne refusée sans APV_ALLOW_MERGE=1/);
  }
  assert.equal((await apv(p.repo, ['release', '--dry-run'], { APV_ALLOW_MERGE: '' })).code, 0);
  assert.equal(p.remote('production'), before);
});

test('apv stack: a pull request whose target is the production branch is refused', async t => {
  const p = project(t);
  assert.match(releaseTarget(p.repo, 'origin', 'production'), /branche de production \(release\.branch\), elle n'avance que par apv release/);
  assert.equal(releaseTarget(p.repo, 'origin', 'main'), null);
  const verdict = await stackRules(p.repo)({ number: 7, headRefOid: git(p.repo, 'rev-parse', 'HEAD') }, 'production');
  assert.match(verdict.problems[0], /^PR #7 : cible production : branche de production/);
});

test('apv release auto: the queue of the full suites held, it does not wait and publishes nothing', async t => {
  const p = project(t);
  p.commit('a.txt', 'a\n');
  git(p.repo, 'push', '-q', 'origin', 'main');
  const common = git(p.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const store = new LockStore(join(common, 'apv', 'locks'));
  const held = await store.tryAcquire('full-suite', { pid: process.pid, host: store.host, label: 'autre suite' }, 600, 'suite complète');
  assert.equal(held.ok, true);
  const busy = await apv(p.repo, ['release', 'auto'], ALLOW);
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

test('guard: a decoy repository whose configuration declares nothing opens neither production nor the branch of the session project', t => {
  const p = project(t, { release: { branch: 'en-ligne', from: 'main' } });
  const decoy = join(p.root, 'leurre');
  mkdirSync(decoy);
  git(decoy, 'init', '-q', '-b', 'main');
  put(decoy, '.apv/config.json', {});
  const fromProject = hookContext({ cwd: p.repo });
  assert.equal(evaluateCommand(`cd ${decoy} && git push ${p.origin} HEAD:production`, {}, fromProject).decision, 'deny');
  assert.equal(evaluateCommand(`cd ${decoy} && git push ${p.origin} HEAD:en-ligne`, {}, fromProject).decision, 'deny');
  const inDecoy = hookContext({ cwd: decoy }, { ...process.env, CLAUDE_PROJECT_DIR: p.repo });
  assert.equal(evaluateCommand('git push origin HEAD:en-ligne', {}, inDecoy).decision, 'deny');
  assert.equal(evaluateCommand('git push origin HEAD:production', {}, inDecoy).decision, 'deny');
  assert.equal(evaluateCommand('git push origin HEAD:feat', {}, inDecoy).decision, 'allow');
});

// Incident of 19 October: code calling the functions of a migration not applied in production was put online (503).
const MIGRATING = { ...RELEASE, migrations: ['supabase/migrations/*.sql'] };
const MIGRATION = 'supabase/migrations/20261019120000_ajout.sql';

/** A project whose main holds `files` pushed past production, its full suite proven; `marker`: written by the full suite. */
async function migrating(t, files, marker = null) {
  const unit = marker ? node(`require("fs").writeFileSync(${JSON.stringify(marker)}, "")`) : node('0');
  const p = project(t, { release: MIGRATING, gates: [{ id: 'lint', stage: 'task', command: node('0') }, { id: 'unit', stage: 'full', command: unit }] });
  for (const [path, text] of Object.entries(files)) p.commit(path, text);
  git(p.repo, 'push', '-q', 'origin', 'main');
  if (!marker) assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/production'])).code, 0);
  return p;
}

test('apv release, migrations: none added, the release goes on and says so in --json', async t => {
  const p = await migrating(t, { 'a.txt': 'a\n', 'supabase/seed.sql': 'select 1;\n' });
  const done = await apv(p.repo, ['release', '--json'], ALLOW);
  assert.equal(done.code, 0, done.stdout + done.stderr);
  assert.deepEqual(done.json().migrations, { pending: [], toType: [], confirmed: [], modified: [], links: [] });
  assert.equal(p.remote('production'), p.remote('main'));
});

test('apv release, migrations: an added one waits for the operator (manual 1, auto 0 without running the suite)', async t => {
  const marker = join(mkdtempSync(join(tmpdir(), 'apv4-release-suite-')), 'ran');
  t.after(() => rmSync(dirname(marker), { recursive: true, force: true }));
  const p = await migrating(t, { [MIGRATION]: 'create function f() returns int as $$ select 1 $$ language sql;\n', 'app.js': 'f()\n' }, marker);
  const before = p.remote('production');
  const dry = await apv(p.repo, ['release', '--dry-run', '--json']);
  assert.equal(dry.code, 1);
  assert.deepEqual(dry.json().migrations, { pending: [MIGRATION], toType: ['migration 20261019120000 appliquée'], confirmed: [], modified: [], links: [] });
  const manual = await apv(p.repo, ['release'], ALLOW);
  assert.equal(manual.code, 1, manual.stdout + manual.stderr);
  assert.match(manual.stdout, /refusée : migration\(s\) supabase\/migrations\/20261019120000_ajout\.sql à appliquer en production puis taper .*« migration 20261019120000 appliquée »/);
  const auto = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(auto.code, 0, auto.stdout + auto.stderr);
  assert.match(auto.stdout, /^En attente : migration\(s\) .*20261019120000_ajout\.sql à appliquer en production puis taper .*« migration 20261019120000 appliquée » ; rien n'est publié ni lancé/);
  assert.equal(existsSync(marker), false, 'the full suite is not run for nothing');
  assert.equal(p.remote('production'), before);
});

test('apv release, migrations: the confirmation typed by the operator (case and spaces ignored) releases; another version does not', async t => {
  const p = await migrating(t, { [MIGRATION]: 'select 1;\n' });
  const before = p.remote('production');
  operatorSays(p.repo, 'Bien reçu.\nmigration 20261019120001 appliquée');
  const other = await apv(p.repo, ['release'], ALLOW);
  assert.equal(other.code, 1, other.stdout);
  assert.match(other.stdout, /migration 20261019120000 appliquée/);
  assert.equal(p.remote('production'), before);
  operatorSays(p.repo, 'C\'est fait.\n  Migration   20261019120000_AJOUT.sql  APPLIQUÉE.');
  const dry = await apv(p.repo, ['release', '--dry-run']);
  assert.equal(dry.code, 0, dry.stdout);
  assert.match(dry.stdout, /Migration\(s\) confirmée\(s\) appliquée\(s\) par l'opérateur : supabase\/migrations\/20261019120000_ajout\.sql/);
  const done = await apv(p.repo, ['release', '--json'], ALLOW);
  assert.equal(done.code, 0, done.stdout + done.stderr);
  assert.deepEqual(done.json().migrations.confirmed, [MIGRATION]);
  assert.equal(p.remote('production'), p.remote('main'));
});

test('apv release, migrations: the version alone confirms, and auto then runs the suite and releases', async t => {
  const p = await migrating(t, { [MIGRATION]: 'select 1;\n' });
  operatorSays(p.repo, 'migration 20261019120000 appliquée');
  const auto = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(auto.code, 0, auto.stdout + auto.stderr);
  assert.equal(p.remote('production'), p.remote('main'));
});

test('apv release, migrations: one already published and then changed is refused (manual and auto)', async t => {
  const p = await migrating(t, { [MIGRATION]: 'select 1;\n' });
  operatorSays(p.repo, 'migration 20261019120000 appliquée');
  assert.equal((await apv(p.repo, ['release'], ALLOW)).code, 0);
  const published = p.remote('production');
  p.commit(MIGRATION, 'select 2;\n');
  git(p.repo, 'push', '-q', 'origin', 'main');
  assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/production'])).code, 0);
  for (const args of [['release'], ['release', 'auto']]) {
    const r = await apv(p.repo, args, ALLOW);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /migration\(s\) déjà publiée\(s\) modifiée\(s\).*20261019120000_ajout\.sql \(une migration publiée ne change pas/);
  }
  assert.equal(p.remote('production'), published);
});

test('apv release, migrations: a confirmation an agent writes (unsigned journal line, other key, commit, pasted refusal) is never accepted', async t => {
  const p = await migrating(t, { [MIGRATION]: 'select 1;\n' });
  const journal = operatorJournalPath(commonDirOf(p.repo));
  const forged = journalEntry('migration 20261019120000 appliquée', { at: new Date().toISOString(), session: 'agent' }, Buffer.alloc(32, 7));
  mkdirSync(dirname(journal), { recursive: true });
  writeFileSync(journal, `${JSON.stringify(forged)}\n${JSON.stringify({ ...forged, sig: '00'.repeat(32) })}\n`);
  p.commit('NOTES.md', 'migration 20261019120000 appliquée\n');
  git(p.repo, 'commit', '-q', '--allow-empty', '-m', 'migration 20261019120000 appliquée');
  git(p.repo, 'push', '-q', 'origin', 'main');
  assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/production'])).code, 0);
  // The refusal of the tool pasted back by the operator is no confirmation either (the sentence is never alone there).
  const refusal = (await apv(p.repo, ['release'], ALLOW)).stdout;
  operatorSays(p.repo, refusal);
  const r = await apv(p.repo, ['release', '--json'], ALLOW);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.deepEqual(r.json().migrations.pending, [MIGRATION]);
  assert.notEqual(p.remote('production'), p.remote('main'));
});

// Security review of 7fe8210: patterns of production kept, questions and quotes, `./`, shared versions, symbolic links.

test('apv release, migrations: a commit that empties or changes the patterns of production removes none (review 7fe8210, high)', async t => {
  for (const migrations of [undefined, [], ['db/*.sql']]) {
    const p = await migrating(t, {});
    const before = p.remote('production');
    put(p.repo, MIGRATION, 'select 1;\n');
    put(p.repo, '.apv/config.json', { name: 'essai', gates: [{ id: 'lint', stage: 'task', command: node('0') }, { id: 'unit', stage: 'full', command: node('0') }], release: { ...RELEASE, ...(migrations ? { migrations } : {}) } });
    git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'migration et motifs vidés'); git(p.repo, 'push', '-q', 'origin', 'main');
    assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/production'])).code, 0);
    const dry = await apv(p.repo, ['release', '--dry-run', '--json']);
    assert.equal(dry.code, 1, dry.stdout + dry.stderr);
    assert.deepEqual(dry.json().migrations.pending, [MIGRATION], JSON.stringify(migrations));
    const auto = await apv(p.repo, ['release', 'auto'], ALLOW);
    assert.equal(auto.code, 0, auto.stdout + auto.stderr);
    assert.match(auto.stdout, /^En attente : /);
    assert.equal(p.remote('production'), before);
  }
});

test('apv release, migrations: a question or a quote never confirms, the bare sentence does (review 7fe8210, medium)', async t => {
  const p = await migrating(t, { [MIGRATION]: 'select 1;\n' });
  for (const said of ['Migration 20261019120000 appliquée ? Non, pas encore, je le fais demain.', 'migration 20261019120000 appliquée?',
    'L\'agent me demande de taper :\n« migration 20261019120000 appliquée »\nmais je n\'ai rien fait.', '"migration 20261019120000 appliquée"', '\'migration 20261019120000 appliquée\'.']) {
    operatorSays(p.repo, said);
    const r = await apv(p.repo, ['release', '--dry-run', '--json']);
    assert.equal(r.code, 1, said);
    assert.deepEqual(r.json().migrations.pending, [MIGRATION], said);
  }
  operatorSays(p.repo, 'C\'est fait : migration 20261019120000 appliquée');
  assert.equal((await apv(p.repo, ['release', '--dry-run'])).code, 1, 'inside a longer sentence: no confirmation');
  operatorSays(p.repo, 'C\'est fait.\nmigration 20261019120000 appliquée');
  assert.equal((await apv(p.repo, ['release', '--dry-run'])).code, 0);
});

test('operator journal: a waiver typed as a question or quoted never waives; its normal form still does (review 7fe8210, medium)', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const said = text => readBack(journalEntry(`Voilà.\n${text}`, { at: new Date().toISOString(), session: 'test' }, TEST_KEY));
  const readBack = entry => [{ at: entry.at, session: entry.session, sentences: entry.sentences, preview: entry.preview, waivers: entry.waivers }];
  assert.ok(waiverFor(said(`dérogation preuve ${sha.slice(0, 12)} : flux GitHub du test, sans objet ici`), 'preuve', sha));
  for (const text of [`dérogation preuve ${sha.slice(0, 12)} : flux GitHub du test, sans objet ici ?`, `« dérogation preuve ${sha.slice(0, 12)} : flux GitHub du test, sans objet ici »`,
    `"dérogation preuve ${sha.slice(0, 12)} : flux GitHub du test, sans objet ici"`]) {
    assert.equal(waiverFor(said(text), 'preuve', sha), null, text);
  }
  assert.deepEqual(sentences('On valide ? Oui, on valide.'), ['oui, on valide']);
  assert.deepEqual(sentences('« Je valide la maquette »'), []);
});

test('apv release, migrations: a pattern written with ./ matches the same files (review 7fe8210, low)', async t => {
  const p = project(t, { release: { ...RELEASE, migrations: ['./supabase/migrations/*.sql'] } });
  p.commit(MIGRATION, 'select 1;\n');
  git(p.repo, 'push', '-q', 'origin', 'main');
  const dry = await apv(p.repo, ['release', '--dry-run', '--json']);
  assert.equal(dry.code, 1, dry.stdout + dry.stderr);
  assert.deepEqual(dry.json().migrations.pending, [MIGRATION]);
});

test('apv release, migrations: a version shared by two migrations confirms neither, their full name does (review 7fe8210)', async t => {
  const [a, b] = ['supabase/migrations/0002_a.sql', 'supabase/migrations/0002_b.sql'];
  const p = await migrating(t, { [a]: 'select 1;\n', [b]: 'select 2;\n' });
  operatorSays(p.repo, 'migration 0002 appliquée');
  const r = await apv(p.repo, ['release', '--dry-run', '--json']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json().migrations.pending, [a, b]);
  assert.deepEqual(r.json().migrations.toType, ['migration 0002_a appliquée', 'migration 0002_b appliquée']);
  operatorSays(p.repo, 'migration 0002_a.sql appliquée');
  const one = (await apv(p.repo, ['release', '--dry-run', '--json'])).json().migrations;
  assert.deepEqual([one.confirmed, one.pending], [[a], [b]]);
});

test('apv release, migrations: a migration that is a symbolic link is refused (review 7fe8210)', async t => {
  const p = await migrating(t, {});
  put(p.repo, 'sql/f.sql', 'select 1;\n');
  mkdirSync(join(p.repo, 'supabase/migrations'), { recursive: true });
  symlinkSync('../../sql/f.sql', join(p.repo, MIGRATION));
  git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'lien'); git(p.repo, 'push', '-q', 'origin', 'main');
  operatorSays(p.repo, 'migration 20261019120000 appliquée');
  const r = await apv(p.repo, ['release', '--dry-run', '--json']);
  assert.equal(r.code, 1, r.stdout);
  assert.deepEqual(r.json().migrations.links, [MIGRATION]);
  assert.match(r.json().lines[0], /refusée : migration\(s\) en lien symbolique : supabase\/migrations\/20261019120000_ajout\.sql \(le contenu de sa cible change/);
});

/** A stack declared with a lock file and an env file; the check of the stack fails unless STACK_URL reaches it. */
function stackProject(t, { envLine = 'STACK_URL=http://127.0.0.1:55321\n', second = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'apv4-release-stacks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock1 = join(dir, 'stack1.lock'); const lock2 = join(dir, 'stack2.lock');
  writeFileSync(join(dir, 'stack1.env'), envLine); writeFileSync(join(dir, 'stack2.env'), envLine.replace('55321', '55322'));
  const check = 'if (!process.env.STACK_URL) { console.error("Error: Variable STACK_URL absente"); process.exit(1); } require("fs").writeFileSync(process.env.SEEN, process.env.STACK_URL + " " + process.env.LOCK_FILE);';
  const stacks = [{ id: '1', lockFile: lock1, envFile: join(dir, 'stack1.env') }, ...(second ? [{ id: '2', lockFile: lock2, envFile: join(dir, 'stack2.env') }] : [])];
  const p = project(t, { extra: { stacks }, gates: [{ id: 'integration', stage: 'full', command: node(check), passEnv: ['STACK_URL', 'SEEN'], lock: { file: lock1, fileEnv: 'LOCK_FILE' } }] });
  p.commit('a.txt', 'a\n'); git(p.repo, 'push', '-q', 'origin', 'main');
  return { ...p, dir, lock1, lock2, seen: join(dir, 'seen'), env: { ...ALLOW, SEEN: join(dir, 'seen') } };
}
const hasFlock = spawnSync('flock', ['--version']).status === 0;
/** Holds a flock on `file` until the returned function is called. */
async function hold(file) {
  const child = spawn('flock', [file, 'sleep', '60'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 400));
  return () => child.kill();
}

test('apv release auto, stacks declared: the suite receives the first free stack and publishes', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = stackProject(t);
  const r = await apv(p.repo, ['release', 'auto'], p.env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(readFileSync(p.seen, 'utf8'), /^http:\/\/127\.0\.0\.1:55321 /);
  assert.equal(p.remote('production'), p.remote('main'));
});

test('apv release auto, stacks declared: every lock held, later and nothing run; the second stack is taken when only the first is held', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = stackProject(t, { second: true });
  const free1 = await hold(p.lock1); const free2 = await hold(p.lock2);
  try {
    const busy = await apv(p.repo, ['release', 'auto'], p.env);
    assert.equal(busy.code, 0, busy.stdout + busy.stderr);
    assert.match(busy.stdout, /Piles occupées .*plus tard/);
    assert.equal(existsSync(p.seen), false, 'nothing ran');
    assert.notEqual(p.remote('production'), p.remote('main'));
  } finally { free2(); }
  try {
    const one = await apv(p.repo, ['release', 'auto', '--stacks', '1'], p.env);
    assert.equal(one.code, 0, one.stdout + one.stderr); assert.match(one.stdout, /occupée/, 'forced on a held stack: the suite itself says busy');
    assert.notEqual(p.remote('production'), p.remote('main'));
  } finally { free1(); }
});

test('apv release auto --stacks forces the stack; an unknown one is a usage error', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = stackProject(t, { second: true });
  const r = await apv(p.repo, ['release', 'auto', '--stacks', '2'], p.env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(readFileSync(p.seen, 'utf8'), /^http:\/\/127\.0\.0\.1:55322 /, 'the variables of stack 2, not of the first free one');
  p.commit('b.txt', 'b\n'); git(p.repo, 'push', '-q', 'origin', 'main');
  const bad = await apv(p.repo, ['release', 'auto', '--stacks', '9'], p.env);
  assert.equal(bad.code, 2, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /pile inconnue 9/);
});

test('apv release auto: a failure of the infrastructure is said so, exit 1, nothing published', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = stackProject(t, { envLine: '# aucune variable\n' });
  const r = await apv(p.repo, ['release', 'auto'], p.env);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /panne d'infrastructure : integration : variable d'environnement absente.*rien n'est publié/);
  assert.notEqual(p.remote('production'), p.remote('main'));
});

test('apv release auto, without stacks: a red check stays a red suite, not an infrastructure failure', async t => {
  const p = project(t, { gates: [{ id: 'unit', stage: 'full', command: node('console.error("expected 1 received 2"); process.exit(1)') }] });
  p.commit('a.txt', 'a\n'); git(p.repo, 'push', '-q', 'origin', 'main');
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /rouge ou instable/);
  assert.doesNotMatch(r.stdout, /panne d'infrastructure/);
});

test('apv release auto: a red suite at the same commit is not run again (0); infrastructure retries after 30 minutes only', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = stackProject(t, { envLine: '# aucune variable\n' });
  const file = join(commonDirOf(p.repo), 'apv', 'release', 'last-auto.json');
  const first = await apv(p.repo, ['release', 'auto'], p.env);
  assert.equal(first.code, 1, first.stdout + first.stderr);
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(rec.kind, 'infrastructure');
  const soon = await apv(p.repo, ['release', 'auto'], p.env);
  assert.equal(soon.code, 0, soon.stdout + soon.stderr);
  assert.match(soon.stdout, /Panne d'infrastructure .*nouvel essai après 30 min/);
  // Past 30 minutes, the stack repaired: the pass runs again and publishes.
  writeFileSync(file, JSON.stringify({ ...rec, at: Date.now() - 31 * 60_000 }));
  writeFileSync(join(p.dir, 'stack1.env'), 'STACK_URL=http://127.0.0.1:55321\n');
  const later = await apv(p.repo, ['release', 'auto'], p.env);
  assert.equal(later.code, 0, later.stdout + later.stderr);
  assert.equal(p.remote('production'), p.remote('main'));
});

test('apv release auto: --force-retry runs a suite that was red at the same commit', async t => {
  const marker = join(mkdtempSync(join(tmpdir(), 'apv4-release-retry-')), 'ok');
  t.after(() => rmSync(dirname(marker), { recursive: true, force: true }));
  const p = project(t, { gates: [{ id: 'unit', stage: 'full', command: node(`process.exit(require("fs").existsSync(${JSON.stringify(marker)}) ? 0 : 1)`) }] });
  p.commit('a.txt', 'a\n'); git(p.repo, 'push', '-q', 'origin', 'main');
  assert.equal((await apv(p.repo, ['release', 'auto'], ALLOW)).code, 1);
  writeFileSync(marker, '');
  const waiting = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(waiting.code, 0);
  assert.match(waiting.stdout, /Suite rouge à/);
  assert.notEqual(p.remote('production'), p.remote('main'));
  const forced = await apv(p.repo, ['release', 'auto', '--force-retry'], ALLOW);
  assert.equal(forced.code, 0, forced.stdout + forced.stderr);
  assert.equal(p.remote('production'), p.remote('main'));
});
