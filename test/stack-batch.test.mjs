import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apv } from './cli-helpers.mjs';
import { evaluateCommand, REASONS } from '../hooks/scripts/bash-guard.mjs';
import { MERGE_REFUSED } from '../dist/stack/github.js';

/**
 * Batch merge (docs/APV3-SPEC.md, section 18.5): one integration branch for several independent pull requests, one
 * full suite on its head, bisection of a failure, then the merges checked by content against the proven batch.
 */

const fakeGh = fileURLToPath(new URL('./support/fake-gh.mjs', import.meta.url));
chmodSync(fakeGh, 0o755);
const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim();

/**
 * An origin (bare) and a clone, a check of stage full that fails when a file BAD exists, and pull requests on main:
 * #11 changes a.txt, #12 adds b.txt, #13 adds BAD (fails the suite), #14 changes a.txt otherwise (conflicts with #11).
 */
function batchProject(t, behavior = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apv3-batch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const repo = join(root, 'repo');
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'switch', '-q', '-c', 'main');
  mkdirSync(join(repo, '.apv'));
  writeFileSync(join(repo, '.apv', 'config.json'), JSON.stringify({ gates: [{ id: 'suite', stage: 'full',
    command: [process.execPath, '-e', 'process.exit(require("fs").existsSync("BAD") ? 1 : 0)'] }] }));
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'push', '-q', 'origin', 'main');
  const prs = {};
  const branch = (n, name, file, text) => {
    git(repo, 'switch', '-q', '-c', name, 'main');
    writeFileSync(join(repo, file), text);
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', name); git(repo, 'push', '-q', 'origin', name);
    const sha = git(repo, 'rev-parse', 'HEAD');
    git(origin, 'update-ref', `refs/pull/${n}/head`, sha);
    prs[n] = { number: n, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: name, headRefOid: sha, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  };
  branch(11, 'pr-a', 'a.txt', 'a changé par 11\n');
  branch(12, 'pr-b', 'b.txt', 'b\n');
  branch(13, 'pr-bad', 'BAD', 'casse la suite\n');
  branch(14, 'pr-conflit', 'a.txt', 'a changé par 14\n');
  git(repo, 'switch', '-q', 'main');
  const file = join(root, 'gh.json');
  writeFileSync(file, JSON.stringify({ prs, behavior, calls: [], origin }));
  const env = { ...identity, APV_GH: fakeGh, FAKE_GH_STATE: file, APV_STACK_POLL_MS: '5', APV_STACK_POLL_ATTEMPTS: '3', APV_ALLOW_MERGE: '',
    APV_LOCK_DIR: join(root, 'locks'), APV_LOCK_POLL_MS: '20' };
  return {
    root, origin, repo, env,
    run: (args, extra = {}) => apv(repo, ['stack', 'batch', ...args], { ...env, ...extra }),
    main: () => git(origin, 'rev-parse', 'refs/heads/main'),
    tree: ref => git(origin, 'rev-parse', `${ref}^{tree}`),
    merges: () => JSON.parse(readFileSync(file, 'utf8')).calls.filter(c => c[1] === 'merge').map(c => Number(c[2])),
    log: () => existsSync(join(repo, '.apv/state/stack.log')) ? readFileSync(join(repo, '.apv/state/stack.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [],
  };
}
const allow = { APV_ALLOW_MERGE: '1' };

test('batch: one full suite proves two pull requests together; without --merge nothing is merged', async t => {
  const p = batchProject(t);
  const before = p.main();
  const r = await p.run(['11', '12', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const report = r.json();
  assert.deepEqual(report.proven.members.map(m => m.number), [11, 12]);
  assert.equal(report.lots.length, 1, 'one suite');
  assert.match(report.lots[0].proof.summary, /1\/1 contrôle\(s\) réussi\(s\) ; apv gates verify à 0/);
  assert.match(report.proven.name, /^apv\/lot-\d{8}-\d{6}$/);
  assert.deepEqual(p.merges(), []);
  assert.equal(p.main(), before);
  assert.ok(!existsSync(report.proven.dir), 'the worktree of the batch is removed');
  assert.equal(git(p.repo, 'rev-parse', report.proven.name), report.proven.head, 'its branch stays');
  // Merges, never a rebase: two merge commits on the base of the target.
  assert.equal(git(p.repo, 'rev-list', '--merges', '--count', `${report.base}..${report.proven.head}`), '2');
  const human = await p.run(['11', '12']);
  assert.match(human.stdout, /Lot apv\/lot-\S+ : #11, #12, tête [0-9a-f]{12} : PROUVÉ/);
  assert.match(human.stdout, /APV_ALLOW_MERGE=1 apv stack batch <mêmes PR> --merge/);
});

test('batch --merge needs APV_ALLOW_MERGE=1, in the tool and in the Bash hook', async t => {
  const p = batchProject(t);
  const r = await p.run(['11', '12', '--merge']);
  assert.equal(r.code, 2);
  assert.equal(r.stderr.trim(), MERGE_REFUSED);
  assert.deepEqual(evaluateCommand('apv stack batch 11 12 --merge', {}), { decision: 'deny', reason: REASONS.merge });
  assert.deepEqual(evaluateCommand('node /x/dist/cli.js stack batch 11 12 --bisect --merge', {}), { decision: 'deny', reason: REASONS.merge });
  assert.equal(evaluateCommand('APV_ALLOW_MERGE=1 apv stack batch 11 12 --merge', {}).decision, 'allow');
  assert.equal(evaluateCommand('apv stack batch 11 12 --bisect', {}).decision, 'allow');
});

test('batch --merge merges in order, tolerates the gap of each head, and ends on the proven tree', async t => {
  const p = batchProject(t);
  const r = await p.run(['11', '12', '--merge', '--json'], allow);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const report = r.json();
  assert.deepEqual(report.merged, [11, 12]);
  assert.deepEqual(p.merges(), [11, 12]);
  assert.equal(report.finalTree.identical, true);
  assert.equal(p.tree(p.main()), git(p.repo, 'rev-parse', `${report.proven.head}^{tree}`));
  assert.deepEqual(p.log().map(e => [e.event, e.pr, e.sameContent]), [['batch-merge', 11, true], ['batch-merge', 12, true]]);
});

test('a failed batch is not merged; --bisect isolates the faulty pull request, proves the rest and merges it', async t => {
  const p = batchProject(t);
  const failed = await p.run(['11', '13', '12', '--merge', '--json'], allow);
  assert.equal(failed.code, 1);
  assert.match(failed.json().stopped.reasons.join('\n'), /lot non prouvé \(--bisect isole les PR fautives\)/);
  assert.deepEqual(p.merges(), []);
  const r = await p.run(['11', '13', '12', '--bisect', '--merge', '--json'], allow);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const report = r.json();
  assert.deepEqual(report.culprits, [13]);
  assert.equal(report.interaction, false);
  assert.deepEqual(report.proven.members.map(m => m.number), [11, 12]);
  assert.match(report.proven.name, /-final$/);
  assert.deepEqual(report.merged, [11, 12]);
  assert.deepEqual(p.merges(), [11, 12]);
  assert.ok(report.lots.every(l => l.removed), 'every batch worktree removed');
});

test('a pull request in conflict with the previous ones stays out of the batch', async t => {
  const p = batchProject(t);
  const r = await p.run(['11', '14', '12', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const lot = r.json().proven;
  assert.deepEqual(lot.members.map(m => m.number), [11, 12]);
  assert.deepEqual(lot.excluded.map(x => x.pr), [14]);
  assert.match(lot.excluded[0].reason, /conflit avec les PR précédentes du lot/);
});

test('the merge stops when the target changed outside the batch, or when a merge lands another content', async t => {
  const moved = batchProject(t, { pushOnView: { 12: 2 } });
  const r = await moved.run(['11', '12', '--merge', '--json'], allow);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.deepEqual(r.json().merged, [11]);
  assert.equal(r.json().stopped.pr, 12);
  assert.match(r.json().stopped.reasons[0], /n'a plus le contenu du lot avant la PR #12 : elle a changé hors du lot/);
  assert.deepEqual(moved.merges(), [11]);
  const altered = batchProject(t, { alterAfterMerge: [11] });
  const s = await altered.run(['11', '12', '--merge', '--json'], allow);
  assert.equal(s.code, 1);
  assert.deepEqual(s.json().merged, [11]);
  assert.match(s.json().stopped.reasons[0], /après la fusion de la PR #11, le contenu de main .* diffère de celui du lot prouvé/);
  assert.deepEqual(altered.merges(), [11], 'nothing else merged');
  assert.equal(altered.log().at(-1).event, 'batch-stop');
});

test('batch refuses an incoherent batch before building anything', async t => {
  const p = batchProject(t);
  const state = JSON.parse(readFileSync(p.env.FAKE_GH_STATE, 'utf8'));
  state.prs[12].baseRefName = 'pr-a';
  state.prs[11].statusCheckRollup = [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }];
  writeFileSync(p.env.FAKE_GH_STATE, JSON.stringify(state));
  const r = await p.run(['11', '12', '--json']);
  assert.equal(r.code, 1);
  const reasons = r.json().stopped.reasons.join('\n');
  assert.match(reasons, /PR #12 vise pr-a au lieu de main/);
  assert.match(reasons, /PR #11 : contrôle\(s\) en échec : ci/);
  assert.deepEqual(r.json().lots, []);
  const usage = await p.run(['11', '--method', 'squash']);
  assert.equal(usage.code, 2);
});
