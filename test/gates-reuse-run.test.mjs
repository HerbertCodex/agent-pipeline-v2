import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixture, git, receipt as sampleReceipt } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { loadConfig } from '../dist/config/load.js';
import { Git } from '../dist/execution/git.js';
import { verifyGates } from '../dist/gates/verify.js';
import { inputsDigest } from '../dist/gates/reuse.js';
import { checkReuse, neverReused, readLocal, reuseContext, runsDast } from '../dist/gates/reuse-proof.js';
import { gatesConfigHash, runGates } from '../dist/gates/run.js';
import { schedule, success } from '../dist/engine/scheduler.js';
import { targetedQaContext } from '../dist/lifecycle/pathways.js';

/**
 * PR A1 of docs/ACCELERATION-LOTS.md (5.2 A1, A3, A4; AC-REUSE-TREE, AC-REUSE-LATEST-FAIL, AC-REUSE-REPLAY): `apv gates run`
 * reuses a green receipt of an identical tree instead of running the check, writes a receipt `cached` that `apv gates verify`
 * accepts, and never writes one that verify would refuse.
 */

const sha256 = text => createHash('sha256').update(text).digest('hex');
const HOUR = 3_600_000;
const hasFlock = spawnSync('flock', ['--version']).status === 0;

/** A check that appends its name to `log` (outside the repository) each time it really runs, then exits with `code`. */
const logged = (log, name, extra = '') => [process.execPath, '-e',
  `require("fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${name}\n`)}); ${extra}`];

/** A project whose checks note each execution: lint and unit (task), integration (full). */
function project(t, { gates = null, extra = [] } = {}) {
  const f = fixture(t);
  const log = join(f.root, 'runs.log');
  const config = { gates: gates ?? [
    { id: 'lint', command: logged(log, 'lint') },
    { id: 'unit', command: logged(log, 'unit', `process.exit(require("fs").existsSync(${JSON.stringify(join(f.root, 'fail-unit'))}) ? 1 : 0)`) },
    { id: 'integration', stage: 'full', command: logged(log, 'integration') },
    ...extra] };
  write(f.repo, '.apv/config.json', config);
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  const ran = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  const local = join(f.repo, '.apv', 'receipts');
  const store = join(f.repo, '.git', 'apv', 'receipts');
  return { ...f, log, ran, local, store, head: () => git(f.repo, 'rev-parse', 'HEAD'),
    run: (args = [], env = {}) => apv(f.repo, ['gates', 'run', ...args], env),
    // A new commit with the same tree: what a new lot head over the same pull requests and the same target is.
    same: () => { git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'même arbre'); return git(f.repo, 'rev-parse', 'HEAD'); },
    receiptOf: (runId, gate, root = local) => JSON.parse(readFileSync(join(root, runId, `${gate}.json`), 'utf8')) };
}
const statuses = json => Object.fromEntries(json.gates.map(g => [g.gate, g.status]));

test('AC-REUSE-TREE: a commit with the same tree reuses every green check, runs nothing, and apv gates verify proves it', async t => {
  const p = project(t);
  const first = await p.run(['--json']);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const from = p.head();
  const origin = first.json().runId;
  assert.deepEqual(first.json().reused, []);
  assert.deepEqual(p.ran(), ['lint', 'unit', 'integration']);
  const head = p.same();
  const second = await p.run(['--json']);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  const result = second.json();
  assert.deepEqual(statuses(result), { lint: 'cached', unit: 'cached', integration: 'cached' });
  assert.deepEqual(p.ran(), ['lint', 'unit', 'integration'], 'nothing ran again');
  assert.deepEqual(result.reused.map(r => [r.gateId, r.fromCommit, r.fromRun, r.basis, r.reason]),
    ['lint', 'unit', 'integration'].map(g => [g, from, origin, 'tree', 'arbre identique']));
  assert.equal(result.suite, false, 'no full suite ran: no queue, no stack, no port');
  for (const gate of ['lint', 'unit', 'integration']) {
    const cached = p.receiptOf(result.runId, gate);
    const o = p.receiptOf(origin, gate);
    assert.equal(cached.candidateSha, head);
    assert.equal(cached.reusedFrom, o.id);
    assert.deepEqual([cached.reuse.basis, cached.reuse.fromCommit, cached.reuse.fromRun, cached.reuse.changed, cached.reuse.environment], ['tree', from, origin, 0, o.environmentHash]);
    assert.deepEqual([cached.stdoutHash, cached.stderrHash, cached.exitCode, cached.dirty], [o.stdoutHash, o.stderrHash, 0, false]);
  }
  assert.match(second.stderr, new RegExp(`lint : réutilisé de ${from.slice(0, 12)} \\(exécution ${origin}, arbre identique\\) : non relancé`));
  // The reuse proves the commit through verify, from the worktree and from the command.
  const verified = await verifyGates({ repo: p.repo, config: loadConfig(p.repo).config, commit: head });
  assert.equal(verified.ok, true, JSON.stringify(verified.gates));
  assert.deepEqual(verified.reused, ['lint', 'unit', 'integration']);
  const text = await apv(p.repo, ['gates', 'verify', '--commit', head]);
  assert.equal(text.code, 0, text.stdout);
  assert.match(text.stdout, new RegExp(`integration\\s+réutilisé de ${from.slice(0, 12)} \\(arbre identique\\)`));
  // The human output: « réutilisé » in the table, the origin of each, the count in the verdict.
  const human = await p.run();
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /lint\s+réutilisé\s+0/);
  assert.match(human.stdout, /Réutilisés \(3\), non relancés : reçu vert d'un arbre identique/);
  assert.match(human.stdout, new RegExp(`- unit : réutilisé de ${from.slice(0, 12)} \\(exécution ${origin}\\) : arbre identique`));
  assert.match(human.stdout, /Tous les contrôles passent\. Dont 3 réutilisé\(s\) d'un arbre identique, non relancé\(s\) : lint, unit, integration\./);
  assert.doesNotMatch(human.stdout, /--- lint \(réutilisé\) ---/, 'no diagnostic block for a reuse');
});

test('AC-REUSE-TREE: no chain, the origin is always a receipt that ran; another tree runs everything', async t => {
  const p = project(t);
  const origin = (await p.run(['--json'])).json().runId;
  p.same();
  assert.equal((await p.run(['--json'])).json().reused.length, 3);
  p.same();
  const third = (await p.run(['--json'])).json();
  assert.deepEqual([...new Set(third.reused.map(r => r.fromRun))], [origin], 'reused from the run that executed, never from a receipt cached');
  writeFileSync(join(p.repo, 'README.md'), '# Autre arbre\n');
  git(p.repo, 'commit', '-qam', 'autre arbre');
  const other = (await p.run(['--json'])).json();
  assert.deepEqual(statuses(other), { lint: 'passed', unit: 'passed', integration: 'passed' });
  assert.deepEqual(other.reused, []);
});

test('AC-REUSE-TREE: the origin is read from the shared store by another worktree of the repository at the same tree', async t => {
  const p = project(t);
  const origin = (await p.run(['--json'])).json().runId;
  const head = p.same();
  const copy = join(p.root, 'copie');
  git(p.repo, 'worktree', 'add', '-q', '--detach', copy, head);
  const r = await apv(copy, ['gates', 'run', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(statuses(r.json()), { lint: 'cached', unit: 'cached', integration: 'cached' });
  assert.ok(!existsSync(join(copy, '.apv', 'receipts', origin)), 'the origin is not in this worktree');
  assert.equal((await apv(copy, ['gates', 'verify', '--commit', head])).code, 0);
  // From the first worktree too, once the run of the copy is in the store only.
  rmSync(copy, { recursive: true, force: true });
  git(p.repo, 'worktree', 'prune');
  assert.equal((await verifyGates({ repo: p.repo, config: loadConfig(p.repo).config, commit: head })).ok, true);
});

test('AC-REUSE-LATEST-FAIL: a failure on the same tree later than the green origin makes the check run again', async t => {
  const p = project(t);
  await p.run(['--json']);
  p.same();
  // The same tree fails later (a cause outside the repository), run on demand.
  writeFileSync(join(p.root, 'fail-unit'), '');
  const failed = await p.run(['--replay', 'unit', '--keep-going', '--json']);
  assert.equal(failed.code, 1);
  assert.equal(statuses(failed.json()).unit, 'failed');
  rmSync(join(p.root, 'fail-unit'));
  // The older green origin is not reused: the later failure wins; the check runs and passes.
  const again = await p.run(['--json']);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.equal(statuses(again.json()).unit, 'passed');
  assert.match(again.stderr, /unit : non repris \(échec plus récent sur le même arbre : \S+\/unit\.json \(failed\) l'emporte\) : exécuté\./);
  assert.equal(statuses(again.json()).lint, 'cached', 'the other checks are still reused');
  // A green run after the failure is a new origin: reused from it.
  const last = (await p.run(['--json'])).json();
  assert.equal(statuses(last).unit, 'cached');
  assert.equal(last.reused.find(r => r.gateId === 'unit').fromRun, again.json().runId);
});

test('AC-REUSE-REPLAY: --replay runs the checks named, or all, even when a reuse was possible; wrong calls are refused', async t => {
  const p = project(t);
  await p.run(['--json']);
  const head = p.same();
  const one = await p.run(['--replay', 'unit', '--json']);
  assert.equal(one.code, 0, one.stderr);
  assert.deepEqual(statuses(one.json()), { lint: 'cached', unit: 'passed', integration: 'cached' });
  assert.deepEqual(one.json().replay, ['unit']);
  assert.match(one.stderr, /unit : rejoué sur demande \(--replay\), même si une reprise était possible\./);
  const all = await p.run(['--replay', 'all', '--json']);
  assert.deepEqual(statuses(all.json()), { lint: 'passed', unit: 'passed', integration: 'passed' });
  assert.equal(all.json().replay, 'all');
  const human = await p.run(['--replay', 'lint']);
  assert.match(human.stdout, /Rejeu demandé \(--replay\) : lint, exécuté\(s\) même si une reprise était possible\./);
  assert.equal((await verifyGates({ repo: p.repo, config: loadConfig(p.repo).config, commit: head })).ok, true);
  for (const [args, message] of [[['--replay', 'nope'], /--replay : contrôle inconnu nope/], [['--replay', 'all,unit'], /--replay all rejoue tout/],
    [['--replay', ''], /--replay attend des contrôles/], [['--replay', 'unit', '--skip-proven'], /--replay et --skip-proven s'excluent/]]) {
    const r = await p.run(args);
    assert.equal(r.code, 2, `${args.join(' ')} : ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, message);
  }
  assert.match((await apv(p.repo, ['gates', 'verify', '--commit', head, '--replay', 'unit'])).stderr, /option de gates run seulement : --replay/);
});

test('A3: reuse: false, and a command that runs apv web audit or apv dast, are never reused; the loader refuses reuse: true', async t => {
  const f0 = fixture(t);
  const log = join(f0.root, 'runs.log');
  const p = project(t, { gates: [
    { id: 'lint', command: logged(log, 'lint') },
    { id: 'advisories', command: logged(log, 'advisories'), reuse: false },
    { id: 'web', command: [...logged(log, 'web'), 'web', 'audit'] },
    { id: 'scan', command: [...logged(log, 'scan'), 'dast', 'run'] }] });
  await p.run(['--json']);
  p.same();
  const r = await p.run(['--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(statuses(r.json()), { lint: 'cached', advisories: 'passed', web: 'passed', scan: 'passed' });
  assert.match(r.stderr, /advisories : jamais repris : reuse: false, le projet le déclare toujours rejoué : exécuté\./);
  assert.match(r.stderr, /web : jamais repris : il lance apv web audit/);
  assert.match(r.stderr, /scan : jamais repris : il lance apv dast/);
  assert.equal(neverReused({ command: ['apv', 'dast'] }) !== null, true);
  assert.equal(runsDast(['node', 'scripts/dast.mjs']), false);
  assert.equal(neverReused({ command: ['npm', 'test'] }), null);
  const bad = fixture(t);
  write(bad.repo, '.apv/config.json', { gates: [{ id: 'lint', command: ['true'], reuse: true }] });
  const refused = await apv(bad.repo, ['gates', 'run']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stdout + refused.stderr, /Gate lint: reuse accepts false \(never reused, always run\) or \{ ignore, maxAgeMs \}/);
});

test('A3: verify refuses a receipt cached of a check that is never reused, even with a valid origin (the converse of A1)', async t => {
  const p = project(t, { gates: [{ id: 'advisories', command: [process.execPath, '-e', '0'], reuse: false }, { id: 'web', command: [process.execPath, '-e', '0', 'web', 'audit'] }] });
  const runId = (await p.run(['--json'])).json().runId;
  const from = p.head();
  const head = p.same();
  const config = loadConfig(p.repo).config;
  const ctx = reuseContext({ git: new Git(), repo: p.repo, commit: head, configHash: gatesConfigHash(config), now: Date.now(), store: p.store, local: readLocal(p.repo) });
  for (const gate of config.gates) {
    const o = p.receiptOf(runId, gate.id);
    const cached = { ...o, id: randomUUID(), candidateSha: head, status: 'cached', reusedFrom: o.id, startedAt: Date.now(),
      reuse: { fromRun: runId, fromCommit: from, basis: 'tree', inputsDigest: (await inputsDigest(new Git(), p.repo, head)).digest, ignoreDigest: sha256('[]'), environment: o.environmentHash, changed: 0, files: [] } };
    const checked = await checkReuse(ctx, gate, { receipt: cached, dirty: false, baseSha: null, source: 'local' });
    assert.match(checked.reason, /contrôle jamais repris/, gate.id);
    // Accepted for a check that may be reused: the same receipt, the gate without the field.
    const plain = await checkReuse(ctx, { id: gate.id, command: [process.execPath, '-e', '0'] }, { receipt: cached, dirty: false, baseSha: null, source: 'local' });
    assert.ok(plain.origin, gate.id);
  }
});

test('a command that reads {{baseSha}} is reused only from the same base; one that reads {{candidateSha}} never (run and verify)', async t => {
  const p = project(t, { gates: [{ id: 'diff', command: [process.execPath, '-e', '0', '{{baseSha}}'] }, { id: 'commit', command: [process.execPath, '-e', '0', '{{candidateSha}}'] }] });
  const base = p.head();
  git(p.repo, 'commit', '-q', '--allow-empty', '-m', 'deuxième');
  const other = p.head();
  writeFileSync(join(p.repo, 'README.md'), '# Changé\n');
  git(p.repo, 'commit', '-qam', 'changement');
  const first = await p.run(['--base', base, '--json']);
  assert.equal(first.code, 0, first.stderr);
  const head = p.same();
  // Accepted: same tree, same base.
  const same = await p.run(['--base', base, '--json']);
  assert.deepEqual(statuses(same.json()), { diff: 'cached', commit: 'passed' });
  assert.match(same.stderr, /commit : jamais repris : sa commande lit le commit lui-même \(\{\{candidateSha\}\}\)/);
  assert.equal((await verifyGates({ repo: p.repo, config: loadConfig(p.repo).config, commit: head })).ok, true);
  // Refused: another base, its result may differ.
  const moved = await p.run(['--base', other, '--json']);
  assert.equal(statuses(moved.json()).diff, 'passed');
  assert.match(moved.stderr, /diff : non repris \(reçu\(s\) réussi\(s\) sur un arbre identique, mais depuis une autre base/);
  // verify refuses a receipt cached whose run had another base than its origin's.
  const config = loadConfig(p.repo).config;
  const local = readLocal(p.repo);
  const cached = local.found.find(f => f.receipt.gateId === 'diff' && f.receipt.status === 'cached');
  const ctx = reuseContext({ git: new Git(), repo: p.repo, commit: head, configHash: gatesConfigHash(config), now: Date.now(), store: p.store, local });
  assert.ok((await checkReuse(ctx, config.gates[0], cached)).origin);
  assert.match((await checkReuse(ctx, config.gates[0], { ...cached, baseSha: other })).reason, /commande qui lit la base de son exécution \(\{\{baseSha\}\}\)/);
});

/** Rewrites an origin receipt of the worktree (read as is, like any local receipt). */
function rewrite(p, runId, gate, change) {
  const file = join(p.local, runId, `${gate}.json`);
  writeFileSync(file, JSON.stringify(change(JSON.parse(readFileSync(file, 'utf8')))));
}

test('never written when verify would refuse it: origin passed after retry, dirty, targeted, of another configuration, too old (A3)', async t => {
  const retry = { command: ['true'], first: { status: 'failed', exitCode: 1, durationMs: 1, stdoutHash: '', stderrHash: '', diagnostic: '' }, output: '', tests: [] };
  const cases = [
    ['passed_after_retry', o => ({ ...o, status: 'passed_after_retry', retry }), /aucun reçu réussi au premier passage/],
    ['dirty', o => ({ ...o, dirty: true }), /aucun reçu réussi au premier passage/],
    ['targeted', o => ({ ...o, targeted: true }), /aucun reçu réussi au premier passage/],
    ['other configuration', o => ({ ...o, configHash: 'f'.repeat(64) }), /aucun reçu réussi au premier passage/],
    ['too old for the margin', o => ({ ...o, startedAt: Date.now() - 21 * HOUR }), /non repris \(reçu\(s\) réussi\(s\) sur un arbre identique, mais de plus de 20 h/],
  ];
  for (const [label, change, said] of cases) {
    const p = project(t);
    const runId = (await p.run(['--json'])).json().runId;
    rewrite(p, runId, 'unit', change);
    p.same();
    const r = await p.run(['--json']);
    assert.equal(r.code, 0, label);
    assert.deepEqual(statuses(r.json()), { lint: 'cached', unit: 'passed', integration: 'cached' }, label);
    if (label === 'too old for the margin') assert.match(r.stderr, said, label);
  }
  // Accepted just under the margin: 19 h, and verify accepts it.
  const p = project(t);
  const runId = (await p.run(['--json'])).json().runId;
  rewrite(p, runId, 'unit', o => ({ ...o, startedAt: Date.now() - 19 * HOUR }));
  const head = p.same();
  assert.equal(statuses((await p.run(['--json'])).json()).unit, 'cached');
  assert.equal((await verifyGates({ repo: p.repo, config: loadConfig(p.repo).config, commit: head })).ok, true);
});

test('never written on a dirty tree, nor in another environment of the check (its variables)', async t => {
  const f = fixture(t);
  const p = project(t, { gates: [{ id: 'lint', command: [process.execPath, '-e', '0'], passEnv: ['MODE'] }] });
  void f;
  await p.run(['--json'], { MODE: 'a' });
  p.same();
  const other = await p.run(['--json'], { MODE: 'b' });
  assert.equal(statuses(other.json()).lint, 'passed');
  assert.match(other.stderr, /lint : non repris \(reçu\(s\) réussi\(s\) sur un arbre identique, mais dans un autre environnement/);
  assert.equal(statuses((await p.run(['--json'], { MODE: 'a' })).json()).lint, 'cached');
  writeFileSync(join(p.repo, 'brouillon.txt'), 'non suivi\n');
  const dirty = await p.run(['--json'], { MODE: 'a' });
  assert.equal(dirty.json().dirty, true);
  assert.equal(statuses(dirty.json()).lint, 'passed', 'a dirty tree never reuses');
});

test('a dependency of a check that runs runs too; a reused check waits for its dependencies', async t => {
  const f = fixture(t);
  const log = join(f.root, 'runs.log');
  const p = project(t, { gates: [{ id: 'build', command: logged(log, 'build') }, { id: 'e2e', stage: 'full', dependsOn: ['build'], command: logged(log, 'e2e') }] });
  await p.run(['--json']);
  p.same();
  const r = await p.run(['--replay', 'e2e', '--json']);
  assert.deepEqual(statuses(r.json()), { build: 'passed', e2e: 'passed' });
  assert.match(r.stderr, /build : exécuté quand même : e2e, qui en dépend, est exécuté et lit ce que build produit\./);
  assert.deepEqual(statuses((await p.run(['--json'])).json()), { build: 'cached', e2e: 'cached' });
});

/** A run of the shared store written by hand: its summary, its receipts, a manifest that names `named` with true digests. */
function storeRun(p, named, receipts) {
  const two = n => String(Math.floor(Math.random() * n)).padStart(2, '0');
  const runId = `20261018T12${two(60)}${two(60)}Z-${randomUUID().slice(0, 8)}`;
  const dir = join(p.store, runId);
  mkdirSync(dir, { recursive: true });
  const files = { 'summary.json': JSON.stringify({ runId, candidateSha: named, baseSha: null, dirty: false, stage: 'full', ok: false }) };
  for (const r of receipts) files[`${r.gateId}.json`] = JSON.stringify({ ...r, runId });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, runId, candidateSha: named, worktree: p.repo, copiedAt: new Date().toISOString(),
    files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)])) }));
  return runId;
}

test('decision 1: a run of the store whose manifest names another commit than its receipts blocks the reuse when one of them is of this tree', async t => {
  const p = project(t);
  const base = git(p.repo, 'rev-parse', 'HEAD~1');
  const runId = (await p.run(['--json'])).json().runId;
  const head = p.same();
  const second = await p.run(['--json']);
  assert.deepEqual(Object.values(statuses(second.json())), ['cached', 'cached', 'cached']);
  const config = loadConfig(p.repo).config;
  assert.equal((await verifyGates({ repo: p.repo, config, commit: head })).ok, true);
  // Accepted: a disagreement between two other trees cannot hide a failure of this one.
  const o = p.receiptOf(runId, 'unit');
  const elsewhere = storeRun(p, base, [{ ...o, id: randomUUID(), candidateSha: git(p.repo, 'rev-parse', 'HEAD~2'), status: 'failed', exitCode: 1, startedAt: Date.now() }]);
  assert.equal((await verifyGates({ repo: p.repo, config, commit: head })).ok, true);
  rmSync(join(p.store, elsewhere), { recursive: true });
  // Refused: a later failure of this tree hidden behind a manifest that names the base (another tree).
  const hidden = storeRun(p, base, [{ ...o, id: randomUUID(), candidateSha: head, status: 'failed', exitCode: 1, startedAt: Date.now() }]);
  const verified = await verifyGates({ repo: p.repo, config, commit: head });
  assert.equal(verified.ok, false);
  const unit = verified.gates.find(g => g.gateId === 'unit');
  assert.equal(unit.state, 'reuse');
  assert.match(unit.reuse.reason, new RegExp(`exécution ${hidden} du magasin partagé : son manifeste nomme le commit ${base.slice(0, 12)}, un de ses reçus le commit ${head.slice(0, 12)}`));
  // And `apv gates run` does not reuse while it is there: everything runs, with the reason.
  const third = await p.run(['--json']);
  assert.deepEqual(statuses(third.json()), { lint: 'passed', unit: 'passed', integration: 'passed' });
  assert.match(third.stderr, new RegExp(`unit : non repris \\(exécution ${hidden} du magasin partagé : son manifeste nomme le commit`));
  // The cost of the scan of the store is measured and reported: only the runs absent from the worktree are read there.
  assert.deepEqual([third.json().reuseScan.runs, third.json().reuseScan.files], [1, 1], JSON.stringify(third.json().reuseScan));
  assert.ok(Number.isInteger(third.json().reuseScan.ms));
});

test('a reuse that no longer checks out at the end of the run (a later failure written meanwhile) is said, and the run is not ok', async t => {
  const f = fixture(t);
  const spec = join(f.root, 'poison.json');
  // `poison` runs (replayed) and, while it runs, writes into the store a later failure of `lint` on the same tree.
  const poison = [process.execPath, '-e', `const fs = require("fs"), c = require("crypto");
const s = JSON.parse(fs.readFileSync(${JSON.stringify(spec)}, "utf8"));
const runId = "20991231T000000Z-0badf00d"; const dir = s.store + "/" + runId; fs.mkdirSync(dir, { recursive: true });
const o = JSON.parse(fs.readFileSync(s.origin, "utf8"));
const files = { "summary.json": JSON.stringify({ runId, candidateSha: s.head, baseSha: null, dirty: false, stage: "full", ok: false }),
  "lint.json": JSON.stringify({ ...o, id: c.randomUUID(), runId, candidateSha: s.head, status: "failed", exitCode: 1, startedAt: Date.now() }) };
for (const [n, t] of Object.entries(files)) fs.writeFileSync(dir + "/" + n, t);
fs.writeFileSync(dir + "/manifest.json", JSON.stringify({ version: 1, runId, candidateSha: s.head, worktree: "x", copiedAt: new Date().toISOString(),
  files: Object.fromEntries(Object.entries(files).map(([n, t]) => [n, c.createHash("sha256").update(t).digest("hex")])) }));`];
  const p = project(t, { gates: [{ id: 'lint', command: [process.execPath, '-e', '0'] }, { id: 'poison', command: poison }] });
  const runId = (await p.run(['--json'])).json().runId;
  const head = p.same();
  writeFileSync(spec, JSON.stringify({ store: p.store, origin: join(p.local, runId, 'lint.json'), head }));
  const r = await p.run(['--replay', 'poison', '--json']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const result = r.json();
  assert.deepEqual(statuses(result), { lint: 'cached', poison: 'passed' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.reuseStale.map(s => s.gateId), ['lint']);
  assert.match(result.reuseStale[0].reason, /échec plus récent sur le même arbre : 20991231T000000Z-0badf00d\/lint\.json \(failed\)/);
  assert.match(r.stderr, /ATTENTION : lint : reprise devenue invérifiable pendant l'exécution .* relancer avec --replay lint\./);
  // verify refuses it as well.
  assert.equal((await verifyGates({ repo: p.repo, config: loadConfig(p.repo).config, commit: head })).ok, false);
});

/** Two declared stacks; integration and browser are checks of a stack that record where they ran (gates-stacks.test.mjs). */
function stacksProject(t) {
  const f = fixture(t);
  const out = join(f.root, 'out');
  const lock1 = join(f.root, 'stack1.lock'); const lock2 = join(f.root, 'stack2.lock');
  const record = name => [process.execPath, '-e', `const fs = require("fs"); fs.mkdirSync(${JSON.stringify(out)}, { recursive: true });
fs.appendFileSync(${JSON.stringify(out)} + "/${name}.log", JSON.stringify({ cwd: process.cwd(), stack: process.env.STACK ?? null }) + "\\n");`];
  const stackGate = name => ({ id: name, stage: 'full', command: record(name), passEnv: ['STACK', 'LOCK_FILE'], lock: { file: lock1, fileEnv: 'LOCK_FILE' } });
  const setupLog = join(f.root, 'setup.log');
  write(f.repo, '.apv/config.json', {
    gates: [{ id: 'unit', command: [process.execPath, '-e', '0'] }, stackGate('integration'), stackGate('browser')],
    stacks: [{ id: '1', lockFile: lock1, env: { STACK: '1' } }, { id: '2', lockFile: lock2, env: { STACK: '2' } }],
    batch: { setup: [process.execPath, '-e', `require("fs").appendFileSync(${JSON.stringify(setupLog)}, process.cwd() + "\\n")`] },
  });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  const runs = name => existsSync(join(out, `${name}.log`)) ? readFileSync(join(out, `${name}.log`), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  const setups = () => existsSync(setupLog) ? readFileSync(setupLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  const env = { APV_LOCK_DIR: join(f.root, 'locks'), APV_LOCK_POLL_MS: '20' };
  const common = realpathSync(resolve(f.repo, git(f.repo, 'rev-parse', '--git-common-dir')));
  return { ...f, runs, setups, common, env, run: (...args) => apv(f.repo, ['gates', 'run', ...args], env), same: () => { git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'même arbre'); return git(f.repo, 'rev-parse', 'HEAD'); } };
}

test('A4 (lot): --stacks with every check reused prepares no copy of a stack; a check replayed runs on the first stack, in the copy of the batch', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = stacksProject(t);
  const config = loadConfig(p.repo).config;
  // apv stack batch: its copy is a linked worktree, prepared by batch.setup before any reuse, its stack copies by the same.
  const dir = join(p.root, 'lot');
  git(p.repo, 'worktree', 'add', '-q', '--detach', dir, 'HEAD');
  const lot = (extra = {}) => runGates({ repo: dir, config, stage: 'full', batchSetup: true, stacks: ['1', '2'], env: { ...process.env, ...p.env }, log: () => {}, ...extra });
  const first = await lot();
  assert.equal(first.ok, true);
  assert.deepEqual(first.spread.map(a => [a.gate, a.stack]), [['integration', '1'], ['browser', '2']]);
  assert.equal(p.setups().length, 2, 'the copy of the batch, then the copy of stack 2');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'même arbre');
  const head = git(dir, 'rev-parse', 'HEAD');
  const again = await lot();
  assert.equal(again.ok, true);
  assert.deepEqual(Object.fromEntries(again.receipts.map(r => [r.gateId, r.status])), { unit: 'cached', integration: 'cached', browser: 'cached' });
  assert.deepEqual(again.spread, [], 'no check dealt to a stack');
  assert.equal(p.setups().length, 3, 'only the copy of the batch prepared, before the reuses; no copy of a stack');
  assert.equal(p.runs('browser').length, 1);
  assert.equal(again.receipts.find(r => r.gateId === 'browser').stack, '2', 'the stack of the environment reused');
  assert.equal((await apv(dir, ['gates', 'verify', '--commit', head])).code, 0);
  assert.deepEqual(readdirSync(join(p.common, 'apv', 'copies')), []);
  // Only browser runs: dealt to the first stack, in the copy of the batch; the copy of stack 2 is never made nor prepared.
  const replayed = await lot({ replay: ['browser'] });
  assert.equal(replayed.ok, true);
  assert.deepEqual(replayed.spread.map(a => [a.gate, a.stack, realpathSync(a.workspace) === realpathSync(dir)]), [['browser', '1', true]]);
  assert.equal(p.setups().length, 4);
  assert.equal(p.runs('browser').at(-1).stack, '1');
});

test('relecture sécurité de A1 (M2) : hors lot, --stacks à plusieurs piles ne reprend jamais un contrôle de pile que la répartition peut envoyer dans une autre copie ; à une seule pile, il tourne ici et reste repris', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = stacksProject(t);
  // Origin in the main copy: --stacks 1, every check of a stack runs here.
  const first = await p.run('--stacks', '1', '--json');
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.deepEqual(first.json().spread.map(a => [a.gate, a.stack, a.workspace === realpathSync(p.repo)]), [['integration', '1', true], ['browser', '1', true]]);
  p.same();
  // Refused: --stacks 1,2 outside a batch; the local state of the copy of stack 2 is not measured before the decision.
  const spread = await p.run('--stacks', '1,2', '--json');
  assert.equal(spread.code, 0, spread.stdout + spread.stderr);
  assert.deepEqual(statuses(spread.json()), { unit: 'cached', integration: 'passed', browser: 'passed' });
  for (const gate of ['integration', 'browser']) assert.match(spread.stderr, new RegExp(`${gate} : non repris : copie de pile hors lot \\(--stacks 1,2 peut le répartir dans la copie d'une autre pile`));
  assert.deepEqual(spread.json().spread.map(a => [a.gate, a.stack]), [['integration', '1'], ['browser', '2']]);
  assert.equal(p.runs('browser').at(-1).stack, '2');
  // Accepted: --stacks 1 alone, every check of a stack runs in this copy, whose local state is the one measured.
  const head = p.same();
  const single = await p.run('--stacks', '1', '--json');
  assert.equal(single.code, 0, single.stdout + single.stderr);
  assert.deepEqual(statuses(single.json()), { unit: 'cached', integration: 'cached', browser: 'cached' });
  assert.doesNotMatch(single.stderr, /copie de pile hors lot/);
  assert.equal((await apv(p.repo, ['gates', 'verify', '--commit', head])).code, 0);
});

test('the inputs digest hashes the raw bytes of the paths: f\\xff and f\\xfe differ (relecture du delta A0, faible 1)', async t => {
  const f = fixture(t);
  const g = new Git();
  const name = byte => Buffer.concat([Buffer.from(join(f.repo, 'f')), Buffer.from([byte])]);
  writeFileSync(name(0xff), 'même contenu\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'f ff');
  const ff = git(f.repo, 'rev-parse', 'HEAD');
  rmSync(name(0xff));
  writeFileSync(name(0xfe), 'même contenu\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'f fe');
  const fe = git(f.repo, 'rev-parse', 'HEAD');
  assert.notEqual(git(f.repo, 'rev-parse', `${ff}^{tree}`), git(f.repo, 'rev-parse', `${fe}^{tree}`));
  // Decoded as UTF-8, both names would be « f » followed by U+FFFD: the former digest could not tell them apart.
  assert.equal(Buffer.from([0x66, 0xff]).toString('utf8'), Buffer.from([0x66, 0xfe]).toString('utf8'));
  assert.notEqual((await inputsDigest(g, f.repo, ff)).digest, (await inputsDigest(g, f.repo, fe)).digest);
  // Accepted: two commits of the same tree share the digest.
  git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'même arbre');
  assert.equal((await inputsDigest(g, f.repo, 'HEAD')).digest, (await inputsDigest(g, f.repo, fe)).digest);
});

test('point 4: a receipt cached is never a success by itself (scheduler), and QA keeps its diagnostic', async () => {
  const gate = (id, dependsOn = []) => ({ id, command: ['true'], dependsOn, resources: [], readOnly: false, timeoutMs: 1000, passEnv: [] });
  const cached = sampleReceipt('a', 'cached', { reusedFrom: randomUUID(), diagnostic: 'Réutilisé de 0123456789ab' });
  assert.equal(success(cached), false);
  assert.equal(success(sampleReceipt('a', 'passed')), true);
  const blocked = (g, reason) => sampleReceipt(g.id, 'blocked', { diagnostic: reason, exitCode: null });
  const run = succeeded => schedule([gate('a'), gate('b', ['a'])], { concurrency: 1, failFast: false, signal: new AbortController().signal,
    execute: async g => g.id === 'a' ? cached : sampleReceipt('b', 'passed'), blocked, ...(succeeded ? { succeeded } : {}) });
  // Refused by default: the dependency reused without verification blocks its dependent.
  assert.equal((await run(null)).find(r => r.gateId === 'b').status, 'blocked');
  // Accepted when the caller checked the reuse (runGates: the receipts it wrote after checkReuse).
  assert.equal((await run(r => success(r) || r.id === cached.id)).find(r => r.gateId === 'b').status, 'passed');
  const context = targetedQaContext({ spec: { problem: 'p', questions: [], tasks: [], acceptance: [] }, receipts: [cached, sampleReceipt('c', 'passed', { diagnostic: 'log' })] });
  assert.equal(context.receipts[0].diagnostic, 'Réutilisé de 0123456789ab', 'a reuse is never shown as an execution');
  assert.equal(context.receipts[1].diagnostic, '', 'the log of an executed success is still omitted');
});
