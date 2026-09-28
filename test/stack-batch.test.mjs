import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apv } from './cli-helpers.mjs';
import { evaluateCommand, REASONS } from '../hooks/scripts/bash-guard.mjs';
import { MERGE_REFUSED, processGh } from '../dist/stack/github.js';
import { batchMerge, processGit } from '../dist/stack/batch.js';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';

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
  // #15 changes the checks: a suite that never fails (it would prove #13 with the checks it brings).
  branch(15, 'pr-config', '.apv/config.json', JSON.stringify({ gates: [{ id: 'suite', stage: 'full', command: [process.execPath, '-e', 'process.exit(0)'] }] }));
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
  // Partial: the proven rest is merged, but a pull request asked for stayed out: never a plain success.
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const report = r.json();
  assert.equal(report.status, 'partiel');
  assert.deepEqual(report.left.map(l => l.pr), [13]);
  assert.match(report.left[0].reason, /isolée par la bissection/);
  assert.equal(report.stopped, null);
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
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json().status, 'partiel');
  assert.deepEqual(r.json().left.map(l => l.pr), [14]);
  const human = await p.run(['11', '14', '12']);
  assert.equal(human.code, 1);
  assert.match(human.stdout, /Lot PARTIEL : #14 \(conflit avec les PR précédentes du lot/);
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

test('an unforeseen Git failure stops the batch with a report, never a crash', async t => {
  const p = batchProject(t);
  const taken = join(p.root, 'occupe');
  mkdirSync(taken);
  writeFileSync(join(taken, 'fichier'), 'x');
  const r = await p.run(['11', '12', '--dir', taken, '--json']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.json().stopped.reasons[0], /erreur inattendue : git worktree add/);
  assert.equal(p.log().at(-1).event, 'batch-stop');
});

test('without a Git identity the batch is refused before anything is built', async t => {
  const p = batchProject(t);
  const none = { HOME: p.root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: '', EMAIL: '' };
  const r = await p.run(['11', '12', '--json'], none);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.json().stopped.reasons[0], /lot impossible à construire : identité Git absente/);
  assert.deepEqual(r.json().lots, []);
});

test('two batches started in the same second get two branches', async t => {
  const p = batchProject(t);
  const [a, b] = [await p.run(['12', '--json']), await p.run(['12', '--json'])];
  assert.equal(a.code, 0, a.stdout + a.stderr);
  assert.equal(b.code, 0, b.stdout + b.stderr);
  assert.notEqual(a.json().proven.name, b.json().proven.name);
});

test('a batch is proven with the checks of the target: a pull request that changes them is refused', async t => {
  const p = batchProject(t);
  const r = await p.run(['13', '15', '--merge', '--json'], allow);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json().stopped.pr, 15);
  assert.match(r.json().stopped.reasons[0], /PR #15 change la configuration des contrôles par rapport à main .* prouver cette PR seule/);
  assert.deepEqual(r.json().lots, [], 'nothing built');
  assert.deepEqual(p.merges(), []);
});

test('the setup of the batch comes from the target, not from the pull requests', async t => {
  const p = batchProject(t);
  // The target declares a setup that leaves a marker next to the batch; the check fails without it.
  const marker = join(p.root, 'setup-de-la-cible');
  git(p.repo, 'switch', '-q', 'main');
  writeFileSync(join(p.repo, '.apv', 'config.json'), JSON.stringify({
    gates: [{ id: 'suite', stage: 'full', command: [process.execPath, '-e', `process.exit(require("fs").existsSync(${JSON.stringify(marker)}) && !require("fs").existsSync("BAD") ? 0 : 1)`] }],
    batch: { setup: [process.execPath, '-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`] } }));
  git(p.repo, 'commit', '-qam', 'setup'); git(p.repo, 'push', '-q', 'origin', 'main');
  const r = await p.run(['12', '--target', 'main', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(existsSync(marker), 'the setup of the target ran');
});

test('a signal between the proof and a merge stops the batch before it: interrupted, nothing merged', async t => {
  const p = batchProject(t);
  const env = { ...process.env, ...p.env };
  const controller = new AbortController();
  const gh = processGh(fakeGh, env, p.repo);
  let views = 0;
  const report = await batchMerge({
    repo: p.repo, common: realpathSync(join(p.repo, '.git')), prs: [11, 12], bisect: false, merge: true, ready: false, keep: false, remote: 'origin',
    // The operator presses Ctrl-C while PR #11 is read again, just before its merge.
    gh: async args => { const r = await gh(args); if (args[1] === 'view' && args[2] === '11' && ++views === 2) controller.abort(); return r; },
    git: processGit(env), log: () => {}, onCall: () => {}, pollMs: 5, pollAttempts: 3,
    configDrift: () => null, journal: () => null, signal: controller.signal,
    prove: async () => ({ ok: true, runId: 'x', summary: 'prouvé' }),
  });
  assert.equal(report.interrupted, true);
  assert.deepEqual(report.merged, []);
  assert.match(report.stopped.reasons[0], /lot interrompu \(signal\) avant la fusion de la PR #11 ; fusionnées : aucune/);
  assert.deepEqual(p.merges(), []);
});

test('Ctrl-C during the suite of a batch --merge: exit 130, "Lot interrompu", nothing merged', async t => {
  const p = batchProject(t);
  const started = join(p.root, 'suite-lancee');
  git(p.repo, 'switch', '-q', 'main');
  writeFileSync(join(p.repo, '.apv', 'config.json'), JSON.stringify({ gates: [{ id: 'suite', stage: 'full', timeoutMs: 60000,
    command: [process.execPath, '-e', `require("fs").writeFileSync(${JSON.stringify(started)}, ""); setTimeout(() => {}, 30000)`] }] }));
  git(p.repo, 'commit', '-qam', 'suite lente'); git(p.repo, 'push', '-q', 'origin', 'main');
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'stack', 'batch', '11', '12', '--merge', '--target', 'main'], { cwd: p.repo, env: { ...process.env, ...p.env, APV_ALLOW_MERGE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; });
  const exited = new Promise(done => child.once('exit', code => done(code)));
  const end = Date.now() + 20000;
  while (!existsSync(started) && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  assert.ok(existsSync(started), err);
  child.kill('SIGINT');
  assert.equal(await exited, 130, out + err);
  assert.match(out, /Lot interrompu \(SIGINT\) : rien d'autre ne sera fusionné\./);
  assert.match(out, /lot interrompu \(signal\) pendant la preuve du lot, avant toute fusion ; fusionnées : aucune/);
  assert.deepEqual(p.merges(), []);
});

/** Target checks with repeatChanged (maxFiles 1), and PRs #16 (one test), #17 (one other test), #18 (two tests). */
function repeatBatch(t) {
  const p = batchProject(t);
  git(p.repo, 'switch', '-q', 'main');
  writeFileSync(join(p.repo, '.apv', 'config.json'), JSON.stringify({ gates: [{ id: 'suite', stage: 'full', command: [process.execPath, '-e', '0'],
    repeatChanged: { paths: ['*.e2e.ts'], command: [process.execPath, '-e', '0', '{{repeat}}'], maxFiles: 1, reference: 'origin/main' } }] }));
  git(p.repo, 'commit', '-qam', 'repeat'); git(p.repo, 'push', '-q', 'origin', 'main');
  const state = JSON.parse(readFileSync(join(p.root, 'gh.json'), 'utf8'));
  for (const [n, files] of [[16, ['a.e2e.ts']], [17, ['b.e2e.ts']], [18, ['c.e2e.ts', 'd.e2e.ts']]]) {
    git(p.repo, 'switch', '-q', '-c', `pr-${n}`, 'main');
    for (const f of files) writeFileSync(join(p.repo, f), `test ${f}\n`);
    git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', `pr ${n}`); git(p.repo, 'push', '-q', 'origin', `pr-${n}`);
    const sha = git(p.repo, 'rev-parse', 'HEAD');
    git(p.origin, 'update-ref', `refs/pull/${n}/head`, sha);
    state.prs[n] = { ...state.prs[11], number: n, headRefName: `pr-${n}`, headRefOid: sha };
  }
  writeFileSync(join(p.root, 'gh.json'), JSON.stringify(state));
  git(p.repo, 'switch', '-q', 'main');
  return p;
}

test('batch and repeatChanged: maxFiles applies pull request by pull request, a PR over it refuses the batch before anything is built', async t => {
  const p = repeatBatch(t);
  // Two PRs of one test each: the batch repeats both (2 files, over maxFiles 1 for the sum, never for one PR).
  const ok = await p.run(['16', '17', '--json']);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  const run = ok.json().proven;
  assert.deepEqual(run.members.map(m => m.number), [16, 17]);
  const summary = JSON.parse(readFileSync(join(p.repo, '.git', 'apv', 'receipts', ok.json().lots[0].proof.runId, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.receipts[0].repeat, { status: 'passed', files: ['a.e2e.ts', 'b.e2e.ts'], times: 5, failures: [] });
  const refused = await p.run(['16', '18', '--bisect', '--json']);
  assert.equal(refused.code, 1);
  assert.equal(refused.json().stopped.pr, 18);
  assert.match(refused.json().stopped.reasons[0], /lot refusé avant toute construction \(répétition des tests modifiés, repeatChanged\) : PR #18 : suite : 2 fichier\(s\) de test ajouté\(s\) ou modifié\(s\), au-delà de repeatChanged\.maxFiles \(1\) ; ce n'est pas un échec de suite, la bissection ne s'applique pas/);
  assert.deepEqual(refused.json().lots, [], 'nothing built');
  assert.deepEqual(refused.json().culprits, []);
});

test('batch and skipWhenOnly: documentation PRs leave the scoped check not required (paths of the target), a PR that touches anything else runs it', async t => {
  const p = batchProject(t);
  git(p.repo, 'switch', '-q', 'main');
  const calls = join(p.root, 'calls.txt');
  writeFileSync(join(p.repo, '.apv', 'config.json'), JSON.stringify({ gates: [{ id: 'suite', stage: 'full',
    command: [process.execPath, '-e', `require("fs").appendFileSync(${JSON.stringify(calls)}, "x")`],
    skipWhenOnly: { paths: ['docs/**', '**/*.md'], except: ['src/**', 'static/**', 'public/**', 'content/**'], reference: 'origin/main' } }] }));
  git(p.repo, 'commit', '-qam', 'scope'); git(p.repo, 'push', '-q', 'origin', 'main');
  const state = JSON.parse(readFileSync(join(p.root, 'gh.json'), 'utf8'));
  for (const [n, file] of [[21, 'docs/a.md'], [22, 'README.md'], [23, 'c.txt']]) {
    git(p.repo, 'switch', '-q', '-c', `pr-${n}`, 'main');
    mkdirSync(join(p.repo, 'docs'), { recursive: true });
    writeFileSync(join(p.repo, file), `pr ${n}\n`);
    git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', `pr ${n}`); git(p.repo, 'push', '-q', 'origin', `pr-${n}`);
    const sha = git(p.repo, 'rev-parse', 'HEAD');
    git(p.origin, 'update-ref', `refs/pull/${n}/head`, sha);
    state.prs[n] = { ...state.prs[11], number: n, headRefName: `pr-${n}`, headRefOid: sha };
  }
  writeFileSync(join(p.root, 'gh.json'), JSON.stringify(state));
  git(p.repo, 'switch', '-q', 'main');
  const docs = await p.run(['21', '22', '--json']);
  assert.equal(docs.code, 0, docs.stdout + docs.stderr);
  assert.equal(existsSync(calls), false, 'the suite did not run');
  assert.match(docs.json().lots[0].proof.summary, /non requis par leur portée : suite ; apv gates verify à 0/);
  const summary = JSON.parse(readFileSync(join(p.repo, '.git', 'apv', 'receipts', docs.json().lots[0].proof.runId, 'summary.json'), 'utf8'));
  assert.equal(summary.receipts[0].status, 'not_required');
  assert.match(summary.receipts[0].scope.reason, /2 fichier\(s\) changé\(s\)/);
  const code = await p.run(['21', '23', '--json']);
  assert.equal(code.code, 0, code.stdout + code.stderr);
  assert.equal(readFileSync(calls, 'utf8'), 'x', 'the suite ran once');
  assert.doesNotMatch(code.json().lots[0].proof.summary, /non requis/);
});

test('batch: a suite refused before it ran is never bisected nor taken for a failure', async t => {
  const p = batchProject(t);
  const env = { ...process.env, ...p.env };
  let proofs = 0;
  const report = await batchMerge({
    repo: p.repo, common: realpathSync(join(p.repo, '.git')), prs: [11, 12], bisect: true, merge: false, ready: false, keep: false, remote: 'origin',
    gh: processGh(fakeGh, env, p.repo), git: processGit(env), log: () => {}, onCall: () => {}, pollMs: 5, pollAttempts: 3,
    configDrift: () => null, journal: () => null,
    prove: async () => { proofs += 1; return { ok: false, runId: null, summary: 'suite refusée : GATE_REPEAT', refused: 'GATE_REPEAT' }; },
  });
  assert.equal(proofs, 1, 'no bisection');
  assert.deepEqual(report.culprits, []);
  assert.equal(report.proven, null);
  assert.match(report.stopped.reasons[0], /suite du lot refusée avant de tourner \(GATE_REPEAT\) : ce n'est pas un échec de suite, la bissection ne s'applique pas/);
});
