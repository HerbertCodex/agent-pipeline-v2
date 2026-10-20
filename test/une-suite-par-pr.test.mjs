import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apv } from './cli-helpers.mjs';
import { configIssues } from '../dist/config/load.js';
import { LockStore } from '../dist/lock/store.js';
import { pathsIn } from '../dist/release/unstable.js';

/**
 * docs/UNE-SUITE-PAR-PR.md (pilot project Toujours rien, 20 October 2026): one full suite per pull request, on the branch, as the
 * release runs it (`apv gates run --stage full --fresh-copy`); the release reuses it at an identical tree, credits the changed
 * tests already repeated on their branch, and an unstable test unrelated to the change no longer blocks production.
 * AC-1 to AC-6 of the request, each with the refusals that stay.
 */

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim();
const put = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };
const node = code => [process.execPath, '-e', code];
const ALLOW = { APV_ALLOW_MERGE: '1' };
const RELEASE = { branch: 'production', from: 'main' };
const hasFlock = spawnSync('flock', ['--version']).status === 0;
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
  const verifyBranch = () => apv(repo, ['gates', 'run', '--stage', 'full', '--fresh-copy', '--base', 'origin/main', '--json']);
  const journal = () => readFileSync(join(repo, '.apv', 'state', 'stack.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.event === 'release');
  return { root, repo, origin, log, commit, branch, merge, ran, remote, verifyBranch, journal };
}

test('AC-1: one pull request, its branch suite green in a fresh copy, merged alone: the release publishes without any suite and says which receipt it reused', async t => {
  const p = project(t);
  p.branch('feat');
  const head = p.commit('tests/a.test.js', 'test a\n');
  const branch = await p.verifyBranch();
  assert.equal(branch.code, 0, branch.stdout + branch.stderr);
  assert.match(branch.json().freshCopy.dir, /apv\/fresh\/[0-9a-f]{16}$/);
  assert.equal(existsSync(branch.json().freshCopy.dir), false, 'the copy is removed');
  assert.deepEqual(p.ran(), ['unit', 'repeat tests/a.test.js'], 'the suite and the repetition of the changed test, on the branch');
  // The receipts live in the shared store: the branch is proven from the worktree.
  assert.equal((await apv(p.repo, ['gates', 'verify', '--commit', head, '--against', 'origin/main'])).code, 0);
  const merged = p.merge('feat');
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(p.ran(), ['unit', 'repeat tests/a.test.js'], 'nothing run again at the release');
  assert.match(r.stdout, new RegExp(`Repris sans relancer \\(arbre identique, même environnement\\) : lint de ${head.slice(0, 12)} .* ; unit de ${head.slice(0, 12)} \\(exécution [^,]+, reçu `));
  assert.equal(p.remote('production'), merged);
  const entry = p.journal().pop();
  assert.equal(entry.published, true);
  assert.deepEqual(entry.reused.map(x => [x.gateId, x.fromCommit]), [['lint', head], ['unit', head]]);
});

test('AC-2: two pull requests merged since the last verified branch: one suite at the release, no repetition (credited from each branch)', async t => {
  const p = project(t);
  p.branch('feat1'); p.commit('tests/a.test.js', 'test a\n');
  assert.equal((await p.verifyBranch()).code, 0);
  p.branch('feat2'); p.commit('tests/b.test.js', 'test b\n');
  assert.equal((await p.verifyBranch()).code, 0);
  p.merge('feat1');
  const merged = p.merge('feat2');
  const before = p.ran().length;
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(p.ran().slice(before), ['unit'], 'one suite, the changed tests not repeated again');
  assert.match(r.stderr, /unit : 2 test\(s\) modifié\(s\) déjà répété\(s\), verts, au même contenu \(crédit de répétition\) : non répétés : tests\/a\.test\.js \(exécution .*tests\/b\.test\.js/);
  assert.equal(p.remote('production'), merged);
  // The proof of the release is not that of a branch: there, every changed test is still to be repeated.
  const verify = await apv(p.repo, ['gates', 'verify', '--commit', merged, '--against', 'origin/production', '--json']);
  assert.equal(verify.code, 1);
  assert.deepEqual(verify.json().gates.find(g => g.gateId === 'unit').repeat.missing, ['tests/a.test.js', 'tests/b.test.js']);
});

test('AC-2, refusals: a pull request merged without its branch suite is repeated at the release; a repetition once failed at the same content is never credited away', async t => {
  const p = project(t);
  p.branch('feat1'); p.commit('tests/a.test.js', 'test a\n');
  assert.equal((await p.verifyBranch()).code, 0);
  p.merge('feat1');
  // Straight to main, never verified on a branch.
  p.commit('tests/c.test.js', 'test c\n'); git(p.repo, 'push', '-q', 'origin', 'main');
  let before = p.ran().length;
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(p.ran().slice(before), ['unit', 'repeat tests/c.test.js']);

  // A branch whose repetition failed once (an unstable new test), then passed in a later run at the same content; a second
  // branch merged with it, so that the release runs (another tree): the first file is repeated again, the second credited.
  const qlog = join(p.root, 'q.log');
  const q = project(t, { gates: [{ id: 'unit', stage: 'full', command: node('0'), repeatChanged: { paths: ['tests/**'], times: 2, reference: 'origin/main',
    command: [...logged(qlog, 'repeat', 'if (require("fs").existsSync("tests/flaky.flag")) process.exit(1);'), 'times={{repeat}}'] } }] });
  q.branch('feat');
  q.commit('tests/flag.test.js', 'test\n');
  q.commit('tests/flaky.flag', 'x\n');
  assert.equal((await q.verifyBranch()).code, 1, 'the repetition fails on the branch');
  rmSync(join(q.repo, 'tests/flaky.flag')); git(q.repo, 'add', '-A'); git(q.repo, 'commit', '-qm', 'flag retiré');
  assert.equal((await q.verifyBranch()).code, 0, 'then passes, the test file unchanged');
  q.branch('feat2'); q.commit('tests/other.test.js', 'autre\n');
  assert.equal((await q.verifyBranch()).code, 0);
  q.merge('feat'); q.merge('feat2');
  rmSync(qlog);
  const run = await apv(q.repo, ['release', 'auto'], ALLOW);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.deepEqual(readFileSync(qlog, 'utf8').trim().split('\n'), ['repeat tests/flag.test.js'], 'the once unstable test repeated again, the other credited');
  assert.match(run.stderr, /unit : 1 test\(s\) modifié\(s\) déjà répété\(s\).*: non répétés : tests\/other\.test\.js/);
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

test('AC-5: a migration added and not confirmed stops the release before any suite, even with a green branch suite to reuse', async t => {
  const p = project(t, { release: { ...RELEASE, migrations: ['supabase/migrations/*.sql'] } });
  p.branch('feat'); p.commit('supabase/migrations/20261020120000_ajout.sql', 'select 1;\n');
  assert.equal((await p.verifyBranch()).code, 0);
  p.merge('feat');
  const before = p.ran().length;
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^En attente : .*20261020120000/);
  assert.equal(p.ran().length, before);
  assert.notEqual(p.remote('production'), p.remote('main'));
  assert.equal((await apv(p.repo, ['release'], ALLOW)).code, 1);
});

test('AC-6: a branch verified on stack 2, merged: reused by the release on stack 1 when both print the same fingerprint and normalizeEnv names their own variables', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  for (const normalize of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), 'apv4-une-suite-piles-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const lock1 = join(dir, 'stack1.lock'); const lock2 = join(dir, 'stack2.lock');
    // The URL of each env file carries a port no stack declares in ports (the pilot project, 20 October).
    writeFileSync(join(dir, 'stack1.env'), 'SUPABASE_URL=http://127.0.0.1:54421\n'); writeFileSync(join(dir, 'stack2.env'), 'SUPABASE_URL=http://127.0.0.1:54521\n');
    const fingerprint = node('process.stdout.write("supabase 2.117.0 postgres@sha256:aaa")');
    const stack = (id, lockFile) => ({ id, lockFile, envFile: join(dir, `stack${id}.env`), env: { E2E_STACK: id }, fingerprint, ...(normalize ? { normalizeEnv: ['E2E_STACK', 'SUPABASE_URL'] } : {}) });
    const log = join(dir, 'runs.log');
    const gate = { id: 'integration', stage: 'full', command: logged(log, 'integration'), passEnv: ['E2E_STACK', 'SUPABASE_URL', 'LOCK_FILE'], lock: { file: lock1, fileEnv: 'LOCK_FILE' } };
    const p = project(t, { gates: [gate], extra: { stacks: [stack('1', lock1), stack('2', lock2)] } });
    p.branch('feat'); p.commit('src/a.js', 'a\n');
    const branch = await apv(p.repo, ['gates', 'run', '--stage', 'full', '--fresh-copy', '--stacks', '2', '--base', 'origin/main', '--json']);
    assert.equal(branch.code, 0, branch.stdout + branch.stderr);
    assert.equal(branch.json().gates[0].status, 'passed');
    p.merge('feat');
    const r = await apv(p.repo, ['release', 'auto'], ALLOW);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const runs = readFileSync(log, 'utf8').trim().split('\n');
    if (normalize) {
      assert.deepEqual(runs, ['integration'], 'reused on stack 1 from stack 2');
      assert.match(r.stdout, /Repris sans relancer .*integration de /);
    } else {
      assert.deepEqual(runs, ['integration', 'integration'], 'without normalizeEnv, E2E_STACK and the URL keep the stacks apart');
      assert.match(r.stderr, /integration : non repris \(.*variable\(s\) E2E_STACK, SUPABASE_URL/);
    }
    assert.equal(p.remote('production'), p.remote('main'));
  }
});

test('apv gates run --fresh-copy: usage errors, a dirty tree refused before anything, a copy of the same tree in use refused', async t => {
  const p = project(t);
  p.branch('feat'); p.commit('tests/a.test.js', 'test a\n');
  for (const args of [['--stage', 'task'], ['--allow-dirty'], ['--stage', 'task', '--since', 'HEAD~1']]) {
    const r = await apv(p.repo, ['gates', 'run', '--fresh-copy', '--base', 'origin/main', ...args]);
    assert.equal(r.code, 2, `${args.join(' ')} : ${r.stderr}`);
  }
  const verify = await apv(p.repo, ['gates', 'verify', '--commit', 'HEAD', '--fresh-copy']);
  assert.equal(verify.code, 2);
  put(p.repo, 'tests/a.test.js', 'pas commité\n');
  const dirty = await apv(p.repo, ['gates', 'run', '--stage', 'full', '--fresh-copy', '--base', 'origin/main']);
  assert.equal(dirty.code, 1);
  assert.match(dirty.stderr, /modifications non commitées/);
  git(p.repo, 'checkout', '--', 'tests/a.test.js');
  const common = git(p.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const tree = git(p.repo, 'rev-parse', 'HEAD^{tree}');
  const store = new LockStore(join(common, 'apv', 'locks'));
  const held = await store.tryAcquire(`fresh-${tree.slice(0, 16)}`, { pid: process.pid, host: store.host, label: 'test' }, 600, 'test');
  assert.ok(held.ok);
  const busy = await apv(p.repo, ['gates', 'run', '--stage', 'full', '--fresh-copy', '--base', 'origin/main']);
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, /copie neuve de l'arbre [0-9a-f]{12} déjà en cours/);
  assert.deepEqual(p.ran(), [], 'nothing run');
  await store.release(`fresh-${tree.slice(0, 16)}`, { token: held.record.token });
  assert.equal((await p.verifyBranch()).code, 0);
});

test('configuration: normalizeEnv needs a fingerprint and never names a variable that changes how checks run; affectedList needs retryFailed and {{baseSha}}', () => {
  const messages = value => configIssues(value).issues.map(i => i.message).join('\n');
  const gate = { id: 'unit', stage: 'full', command: ['npm', 'test'] };
  assert.match(messages({ gates: [gate], stacks: [{ id: '1', lockFile: '/tmp/x.lock', normalizeEnv: ['E2E_STACK'] }] }), /normalizeEnv: declare fingerprint too/);
  assert.match(messages({ gates: [gate], stacks: [{ id: '1', lockFile: '/tmp/x.lock', fingerprint: ['true'], normalizeEnv: ['NODE_OPTIONS'] }] }), /NODE_OPTIONS changes how the checks run/);
  assert.equal(messages({ gates: [gate], stacks: [{ id: '1', lockFile: '/tmp/x.lock', fingerprint: ['true'], normalizeEnv: ['E2E_STACK', 'SUPABASE_URL'] }] }), '');
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
