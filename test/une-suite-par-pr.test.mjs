import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apv } from './cli-helpers.mjs';
import { configIssues } from '../dist/config/load.js';
import { pathsIn } from '../dist/release/unstable.js';

/**
 * docs/UNE-SUITE-PAR-PR.md: a pull request merges on its task checks, targeted tests and reviews; the only full suite runs once,
 * in `apv release auto`, on the head of main. The release repeats every test modified since production (no credit from a branch);
 * an old unstable test unrelated to the change no longer blocks production.
 */

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim();
const put = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };
const node = code => [process.execPath, '-e', code];
const ALLOW = { APV_ALLOW_MERGE: '1' };
const RELEASE = { branch: 'production', from: 'main' };
/** Appends `line` (and the arguments of the command) to `log` each time the command really runs. */
const logged = (log, line, extra = '') => node(`require("fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(line)} + process.argv.slice(1).filter(a => !a.startsWith("times=")).map(a => " " + a).join("") + "\\n");${extra}`);

/**
 * An origin and a clone, main and production at the same commit; `unit` (full) logs each run and repeats the changed test
 * files `tests/**` (each repetition logged too). `files`: committed at the base.
 */
function project(t, { gates = null, extra = {}, files = {}, release = RELEASE } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apv4-une-suite-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, 'runs.log');
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(root, 'repo');
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'switch', '-q', '-c', 'main');
  const unit = { id: 'unit', stage: 'full', command: logged(log, 'unit'),
    repeatChanged: { paths: ['tests/**'], command: [...logged(log, 'repeat'), 'times={{repeat}}'], times: 2, reference: 'origin/main' } };
  put(repo, '.apv/config.json', { name: 'essai', gates: gates ?? [{ id: 'lint', stage: 'task', command: node('0') }, unit], ...extra, release });
  put(repo, '.gitignore', '.apv/receipts/\n.apv/state/\n');
  put(repo, 'README.md', 'projet\n');
  for (const [path, text] of Object.entries(files)) put(repo, path, text);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'push', '-q', 'origin', 'main:production');
  const commit = (path, text, message = path) => { put(repo, path, text); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', message); return git(repo, 'rev-parse', 'HEAD'); };
  const branch = name => git(repo, 'switch', '-q', '-c', name, 'origin/main');
  /** Merges `name` into main with a merge commit (the tree of the branch when it contains main), then pushes main. */
  const merge = name => { git(repo, 'switch', '-q', 'main'); git(repo, 'merge', '-q', '--no-ff', '-m', `fusion de ${name}`, name); git(repo, 'push', '-q', 'origin', 'main'); return git(repo, 'rev-parse', 'HEAD'); };
  const ran = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  const remote = ref => git(origin, 'rev-parse', ref);
  const journal = () => readFileSync(join(repo, '.apv', 'state', 'stack.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.event === 'release');
  return { root, repo, origin, log, commit, branch, merge, ran, remote, journal };
}

test('two pull requests merged: one suite at the release, which repeats every test modified since production', async t => {
  const p = project(t);
  p.branch('feat1'); p.commit('tests/a.test.js', 'test a\n');
  p.branch('feat2'); p.commit('tests/b.test.js', 'test b\n');
  p.merge('feat1');
  const merged = p.merge('feat2');
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const runs = p.ran();
  assert.equal(runs[0], 'unit', 'one suite');
  assert.equal(runs.length, 2, runs.join(' | '));
  assert.match(runs[1], /^repeat tests\/a\.test\.js.*tests\/b\.test\.js$|^repeat tests\/b\.test\.js.*tests\/a\.test\.js$/, 'both changed tests repeated at the release');
  assert.doesNotMatch(r.stderr, /crédit de répétition/);
  assert.equal(p.remote('production'), merged);
  assert.equal(p.journal().pop().published, true);
});

test('a pull request needs no branch suite: its task checks are enough for the rules, the release runs the only full suite', async t => {
  const p = project(t);
  p.branch('feat'); p.commit('src/a.js', 'a\n');
  const before = p.ran().length;
  const task = await apv(p.repo, ['gates', 'run', '--stage', 'task', '--base', 'origin/main']);
  assert.equal(task.code, 0, task.stdout + task.stderr);
  assert.equal(p.ran().length, before, 'the full check did not run');
  p.merge('feat');
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(p.ran().slice(before), ['unit']);
  assert.equal(p.remote('production'), p.remote('main'));
});

test('options removed in alpha.6: gates run --fresh-copy is an incorrect call, normalizeEnv in a stack says to delete the key', async t => {
  const p = project(t);
  const r = await apv(p.repo, ['gates', 'run', '--stage', 'full', '--fresh-copy', '--base', 'origin/main']);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.deepEqual(p.ran(), [], 'nothing run');
  const messages = value => configIssues(value).issues.map(i => i.message).join('\n');
  assert.match(messages({ gates: [{ id: 'unit', stage: 'full', command: ['npm', 'test'] }], stacks: [{ id: '1', lockFile: '/tmp/x.lock', fingerprint: ['true'], normalizeEnv: ['E2E_STACK'] }] }),
    /normalizeEnv retiré en alpha\.6.*supprimer la clé/);
});

test('audit of the dependencies required only when they change (docs, part 5): same task check at the task stage and at the release, nothing otherwise', async t => {
  const alog = join(mkdtempSync(join(tmpdir(), 'apv4-une-suite-audit-')), 'audit.log');
  t.after(() => rmSync(dirname(alog), { recursive: true, force: true }));
  // The command of docs/UNE-SUITE-PAR-PR.md, 5, with `git diff <base>...HEAD`: it audits (here, logs) only when a manifest or lock file changed.
  const code = `const { execFileSync } = require("child_process"); const changed = execFileSync("git", ["diff", "--name-only", process.argv[1] + "...HEAD"], { encoding: "utf8" }).split("\\n");`
    + ` if (changed.some(f => /(^|\\/)(package\\.json|package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock)$/.test(f))) require("fs").appendFileSync(${JSON.stringify(alog)}, "audit\\n");`;
  const audit = { id: 'audit-dependances', stage: 'task', command: [...node(code), '{{baseSha}}'], covers: ['security'], reuse: false };
  const p = project(t, { gates: [audit, { id: 'unit', stage: 'full', command: node('0') }] });
  const audited = () => existsSync(alog) ? readFileSync(alog, 'utf8').trim().split('\n').length : 0;
  p.branch('code'); p.commit('src/a.js', 'a\n');
  assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'task', '--base', 'origin/main'])).code, 0);
  assert.equal(audited(), 0, 'code only: no audit at the task stage');
  p.merge('code');
  assert.equal((await apv(p.repo, ['release', 'auto'], ALLOW)).code, 0);
  assert.equal(audited(), 0, 'code only: no audit at the release');
  p.branch('deps'); p.commit('package.json', '{}\n');
  assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'task', '--base', 'origin/main'])).code, 0);
  assert.equal(audited(), 1, 'a manifest changed: audited at the task stage');
  p.merge('deps');
  assert.equal((await apv(p.repo, ['release', 'auto'], ALLOW)).code, 0);
  assert.equal(audited(), 2, 'and again at the release, from production');
  assert.equal(p.remote('production'), p.remote('main'));
});

/** A browser check that fails at its first pass naming `failing`, passes at the relaunch; `affectedList` prints `listed`. */
function flakyGate(dir, failing, { listed = 'tests/other.spec.ts', affectedList = true } = {}) {
  const marker = join(dir, `first-${Math.random().toString(16).slice(2)}`);
  const first = `const fs=require("fs"); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, ""); console.log("  1) [chromium] › ${failing}:3:5 › carte"); process.exit(1); }`;
  return { id: 'browser', stage: 'full', command: node(first), retryFailed: { command: node('0'), testPattern: '^\\s*\\d+\\) (\\[[^\\]]+\\] › .+?)\\s*$' },
    ...(affectedList ? { affectedList: [...node(`console.log("Listing tests:\\n  [chromium] › ${listed}:1:1 › x\\nTotal: 1 test in 1 file")`), '{{baseSha}}'] } : {}) };
}

test('AC-3: an old test, unrelated to the diff, that fails 1 time out of 2 passes: published, the finding written in the journal and the follow-up', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'apv4-une-suite-flaky-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = project(t, { gates: [flakyGate(dir, 'tests/old.spec.ts')], files: { 'tests/old.spec.ts': 'old\n', 'src/x.js': 'x\n' } });
  const sha = p.commit('src/x.js', 'x2\n'); git(p.repo, 'push', '-q', 'origin', 'main');
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(p.remote('production'), sha);
  assert.match(r.stdout, /Constat : test instable sans rapport avec le changement depuis [0-9a-f]{12} : \[chromium\] › tests\/old\.spec\.ts:3:5 › carte \(browser\) échoue 1 fois sur 2 passages/);
  const entry = p.journal().pop();
  assert.deepEqual(entry.unstable.map(u => [u.gate, u.files, u.failed, u.passes, u.blocking]), [['browser', ['tests/old.spec.ts'], 1, 2, null]]);
  const followUp = readFileSync(join(p.repo, '.apv', 'state', 'suivi-constats.md'), 'utf8');
  assert.match(followUp, /## Tests instables à la mise en ligne\n- \d{4}-\d\d-\d\d, mise en ligne de [0-9a-f]{12}, test instable sans rapport avec le changement : .*tests\/old\.spec\.ts.*échoue 1 fois sur 2 passages/);
});

test('AC-3, refusals: a test the change concerns (affectedList), a check without affectedList at production, a name without its file: refused as today', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'apv4-une-suite-flaky-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { 'tests/old.spec.ts': 'old\n', 'src/x.js': 'x\n' };
  const cases = [
    [flakyGate(dir, 'tests/old.spec.ts', { listed: 'tests/old.spec.ts' }), /tests\/old\.spec\.ts:3:5 › carte : concerné par le changement depuis la production \(affectedList/],
    [flakyGate(dir, 'tests/old.spec.ts', { affectedList: false }), /browser ne déclare pas affectedList à la production/],
    [flakyGate(dir, 'tests/absent.spec.ts'), /fichier du test introuvable dans son nom/]];
  for (const [gate, why] of cases) {
    const p = project(t, { gates: [gate], files });
    const before = p.remote('production');
    p.commit('src/x.js', 'x2\n'); git(p.repo, 'push', '-q', 'origin', 'main');
    const r = await apv(p.repo, ['release', 'auto'], ALLOW);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /réussi\(s\) seulement après relance .*browser \(règle instable\)/);
    assert.match(r.stdout, why);
    assert.equal(p.remote('production'), before);
    assert.equal(existsSync(join(p.repo, '.apv', 'state', 'suivi-constats.md')), false, 'no finding: it blocks');
  }
  // affectedList added by the change itself (absent at production): never read from the change.
  const p = project(t, { gates: [flakyGate(dir, 'tests/old.spec.ts', { affectedList: false })], files });
  put(p.repo, '.apv/config.json', { name: 'essai', gates: [flakyGate(dir, 'tests/old.spec.ts')], release: RELEASE });
  p.commit('src/x.js', 'x2\n'); git(p.repo, 'push', '-q', 'origin', 'main');
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /ne déclare pas affectedList à la production/);
});

test('AC-4: a test modified by the pull request that is unstable blocks: relaunched in the suite, or failing in the repetition (1 time out of 5)', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'apv4-une-suite-flaky-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = project(t, { gates: [flakyGate(dir, 'tests/old.spec.ts')], files: { 'tests/old.spec.ts': 'old\n' } });
  const before = p.remote('production');
  p.commit('tests/old.spec.ts', 'old, modifié\n'); git(p.repo, 'push', '-q', 'origin', 'main');
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /tests\/old\.spec\.ts:3:5 › carte : fichier ajouté ou modifié depuis la production \(tests\/old\.spec\.ts\)/);
  assert.equal(p.remote('production'), before);

  // The repetition of the modified test fails once out of its five passes: red, never published.
  const count = join(dir, 'count');
  const fifth = `const fs = require("fs"); const n = (fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)}, "utf8")) : 0) + 1; fs.writeFileSync(${JSON.stringify(count)}, String(n)); if (n % 5 === 0) { console.log("  1) [chromium] › tests/new.spec.ts:1:1 › nouveau"); process.exit(1); }`;
  const q = project(t, { gates: [{ id: 'browser', stage: 'full', command: node('0'), repeatChanged: { paths: ['tests/**'], times: 5, reference: 'origin/main',
    command: [...node(`for (let i = 0; i < 5; i++) { ${fifth.replace('process.exit(1);', 'process.exitCode = 1;')} }`), 'times={{repeat}}'] } }] });
  const was = q.remote('production');
  q.commit('tests/new.spec.ts', 'nouveau\n'); git(q.repo, 'push', '-q', 'origin', 'main');
  const red = await apv(q.repo, ['release', 'auto'], ALLOW);
  assert.equal(red.code, 1, red.stdout + red.stderr);
  assert.match(red.stdout, /Suite complète rouge à .*browser \(failed\)/);
  assert.equal(q.remote('production'), was);
});

test('AC-5: a migration added and not confirmed stops the release before any suite', async t => {
  const p = project(t, { release: { ...RELEASE, migrations: ['supabase/migrations/*.sql'] } });
  p.branch('feat'); p.commit('supabase/migrations/20261020120000_ajout.sql', 'select 1;\n');
  p.merge('feat');
  const before = p.ran().length;
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^En attente : .*20261020120000/);
  assert.equal(p.ran().length, before);
  assert.notEqual(p.remote('production'), p.remote('main'));
  assert.equal((await apv(p.repo, ['release'], ALLOW)).code, 1);
});

test('configuration: affectedList needs retryFailed and {{baseSha}}', () => {
  const messages = value => configIssues(value).issues.map(i => i.message).join('\n');
  const gate = { id: 'unit', stage: 'full', command: ['npm', 'test'] };
  assert.match(messages({ gates: [{ ...gate, affectedList: ['npx', 'playwright', 'test', '--list', '--only-changed', '{{baseSha}}'] }] }), /affectedList .*declare retryFailed too/);
  assert.match(messages({ gates: [{ ...gate, retryFailed: { command: ['npm', 'test'] }, affectedList: ['npx', 'playwright', 'test', '--list', '--only-changed={{baseSha}}'] }] }), /placeholder as a whole argument/);
  assert.equal(messages({ gates: [{ ...gate, retryFailed: { command: ['npm', 'test'] }, affectedList: ['npx', 'playwright', 'test', '--list', '--only-changed', '{{baseSha}}'] }] }), '');
});

test('pathsIn: a path of the commit as written, the only file a runner path ends, never a suffix several files end (all of them for the list)', () => {
  const tracked = ['tests/e2e/a.spec.ts', 'tests/unit/a.spec.ts', 'tests/e2e/b.spec.ts', 'src/x.ts'];
  assert.deepEqual(pathsIn('[chromium] › tests/e2e/b.spec.ts:3:5 › carte', tracked), ['tests/e2e/b.spec.ts']);
  assert.deepEqual(pathsIn('[chromium] › e2e/b.spec.ts:3:5 › carte', tracked), ['tests/e2e/b.spec.ts']);
  assert.deepEqual(pathsIn('[chromium] › a.spec.ts:3:5 › carte', tracked), [], 'two files end with a.spec.ts');
  assert.deepEqual(pathsIn('a.spec.ts', tracked, true), ['tests/e2e/a.spec.ts', 'tests/unit/a.spec.ts']);
  assert.deepEqual(pathsIn('› carte sans fichier', tracked), []);
});
