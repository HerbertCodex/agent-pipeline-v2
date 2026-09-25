import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { branchSpecIds, listWorktrees, locateRunState, mainCheckout } from '../dist/run/rhythm.js';
import { describeEvent } from '../dist/run/state.js';
import { validateReceipt } from '../dist/domain/contracts.js';

process.env.TZ = 'Europe/Paris';

test('branchSpecIds: apv/<id> and apv/<id>-<suffixe>, the longest id first; nothing for another branch', () => {
  assert.deepEqual(branchSpecIds('apv/relances'), ['relances']);
  assert.deepEqual(branchSpecIds('apv/concurrence-corrections-fix-interface'),
    ['concurrence-corrections-fix-interface', 'concurrence-corrections-fix', 'concurrence-corrections', 'concurrence']);
  assert.deepEqual(branchSpecIds('apv/a-integration-2'), ['a-integration-2', 'a-integration', 'a']);
  for (const other of ['main', 'feature/apv/x', 'apv/', 'apv/-x', 'apv/x/y']) assert.deepEqual(branchSpecIds(other), [], other);
});

/**
 * A project with a task check and a full check whose command records each run outside the repository, a spec of
 * two tasks (B depends on A) started with `apv run start`, and a worktree for the integration branch. With
 * `lead`, the execution runs from its own worktree on `apv/rythme` (executions side by side), not from the main
 * checkout, which stays on main without the state.
 */
async function project(t, { lead = false } = {}) {
  const f = fixture(t);
  const log = join(f.root, 'full.log');
  const record = what => [process.execPath, '-e', `require("fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(what)} + "\\n")`];
  write(f.repo, '.apv/config.json', { gates: [{ id: 'unit', command: record('unit') }, { id: 'e2e', stage: 'full', dependsOn: ['unit'], command: record('e2e') }] });
  const task = (id, dependsOn) => ({ id, title: `Tâche ${id}`, description: `Écrire docs/${id}.md.`, acceptanceIds: [`AC-${id}`],
    allowedPaths: [`docs/${id.toLowerCase()}.md`], dependsOn, minimumLane: 'standard' });
  write(f.repo, '.apv/specs/rythme.json', { title: 'Rythme', problem: 'La documentation doit être écrite en deux parties.', scope: ['Documentation'], outOfScope: [],
    acceptance: ['A', 'B'].map(id => ({ id: `AC-${id}`, description: `Partie ${id} écrite.`, verification: `Lire docs/${id}.md.` })),
    decisions: [], questions: [], tasks: [task('A', []), task('B', ['A'])], minimumLane: 'standard' });
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'spec et contrôles');
  const env = { APV_LOCK_DIR: join(f.root, 'locks'), APV_LOCK_POLL_MS: '20' };
  const checkout = lead ? join(f.root, 'lead') : f.repo;
  if (lead) git(f.repo, 'worktree', 'add', '-q', '-b', 'apv/rythme', checkout, 'HEAD');
  const run = async (...args) => { const r = await apv(checkout, ['run', ...args], env); assert.equal(r.code, 0, r.stderr); return r; };
  await run('start', 'rythme', ...(lead ? ['--base', 'main'] : []));
  await run('set', 'rythme', 'data-model', 'skipped', '--note', 'pas de base');
  await run('set', 'rythme', 'plan', 'done');
  const worktree = join(f.root, 'integration');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'apv/rythme-integration-1', worktree, 'HEAD');
  const state = () => JSON.parse(readFileSync(join(checkout, '.apv/state/run-rythme.json'), 'utf8'));
  const ran = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  const gates = (cwd, ...args) => apv(cwd, ['gates', 'run', ...args], env);
  return { ...f, env, run, checkout, worktree, state, ran, gates };
}

test('an intermediate integration refuses the full suite: exit 1, the expected level and the command to run instead', async t => {
  const p = await project(t);
  assert.equal(mainCheckout(p.worktree), realpathSync(p.repo), 'the state is read in the main checkout, not in the worktree');
  const baseSha = p.state().baseSha.slice(0, 12);
  for (const args of [['--stage', 'full'], [], ['--stage', 'full', '--json']]) {
    const r = await p.gates(p.worktree, ...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /Erreur \[GATE_RHYTHM\] : Suite complète refusée : l'exécution rythme \(exécution trouvée par la branche apv\/rythme-integration-1 ; --run <spec-id> pour en nommer une autre\)/);
    assert.match(r.stderr, /run\.fullSuite = final, et le niveau attendu à cette étape est « contrôles de tâche et ciblés » \(apv run next rythme\)/);
    assert.match(r.stderr, new RegExp(`À lancer à la place : apv gates run --stage task --base ${baseSha}, puis apv gates verify --commit <tête> --stage task --base ${baseSha} à 0\\.`));
    assert.match(r.stderr, /Dérogation motivée seulement : --reason "<raison>"/);
  }
  assert.deepEqual(p.ran(), [], 'nothing ran');
  assert.ok(!existsSync(join(p.worktree, '.apv/receipts')), 'no receipt written');
  // The same answer as apv run next.
  const next = (await p.run('next', 'rythme', '--json')).json();
  assert.equal(next.suite.level, 'task');
  // The task stage goes on, and so does a full run that selects no check of stage full.
  assert.equal((await p.gates(p.worktree, '--stage', 'task')).code, 0);
  assert.equal((await p.gates(p.worktree, '--stage', 'full', '--only', 'unit')).code, 0);
  assert.deepEqual(p.ran(), ['unit', 'unit']);
  // --run names the execution explicitly, from any branch (here the main checkout, on main).
  const named = await p.gates(p.repo, '--stage', 'full', '--run', 'rythme');
  assert.equal(named.code, 1);
  assert.match(named.stderr, /Suite complète refusée : l'exécution rythme en est à l'étape vagues \(vague 0, intégration intermédiaire\)/);
  assert.equal(p.state().events.length, 3, 'a refusal writes nothing in the state');
});

test('--reason lets the full suite run: event in the state of the execution, reason in every receipt and the summary', async t => {
  const p = await project(t);
  const before = p.state().events.length;
  const r = await p.gates(p.worktree, '--stage', 'full', '--reason', 'reproduire un test instable vu en revue', '--json');
  assert.equal(r.code, 0, r.stderr);
  const out = r.json();
  assert.deepEqual(out.rhythm, { run: 'rythme', source: 'branch', checkout: realpathSync(p.repo), step: 'waves', level: 'task', override: { run: 'rythme', reason: 'reproduire un test instable vu en revue' } });
  assert.deepEqual(p.ran(), ['unit', 'e2e']);
  const events = p.state().events;
  assert.equal(events.length, before + 1);
  const event = events.at(-1);
  assert.deepEqual([event.target, event.from, event.to, event.note, event.commit],
    ['gates:full', null, 'running', 'reproduire un test instable vu en revue', git(p.worktree, 'rev-parse', 'HEAD')]);
  assert.match(describeEvent(event), /suite complète lancée hors rythme \(niveau attendu : contrôles de tâche et ciblés\) \(commit [a-f0-9]{12}\) : reproduire un test instable vu en revue$/);
  for (const file of readdirSync(out.receiptsDirectory).filter(x => x !== 'summary.json')) {
    const receipt = validateReceipt(JSON.parse(readFileSync(join(out.receiptsDirectory, file), 'utf8')));
    assert.deepEqual(receipt.override, { run: 'rythme', reason: 'reproduire un test instable vu en revue' }, file);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(out.receiptsDirectory, 'summary.json'), 'utf8')).override, { run: 'rythme', reason: 'reproduire un test instable vu en revue' });
  // The receipts of an override still prove the full suite at this commit.
  assert.equal((await apv(p.worktree, ['gates', 'verify', '--commit', 'HEAD'], p.env)).code, 0);
  // Human output says the override; apv run status shows the event.
  const human = await p.gates(p.worktree, '--reason', 'deuxième passage');
  assert.equal(human.code, 0);
  assert.match(human.stdout, /^Dérogation au rythme de l'exécution rythme \(vagues \(vague 0, intégration intermédiaire\), niveau attendu : contrôles de tâche et ciblés\), journalisée dans son état : deuxième passage$/m);
  assert.match((await p.run('status', 'rythme')).stdout, /- .* suite complète lancée hors rythme .* : deuxième passage/);

  // Wrong calls: an empty or too long reason, a reason on the task stage, an invalid id, options of gates run on verify.
  for (const args of [['--reason', '  '], ['--reason', 'x'.repeat(501)], ['--stage', 'task', '--reason', 'r'], ['--run', '../x'],
    ['--run', 'bad id']]) {
    const bad = await p.gates(p.worktree, ...args);
    assert.equal(bad.code, 2, args.join(' '));
  }
  assert.equal((await apv(p.worktree, ['gates', 'verify', '--commit', 'HEAD', '--reason', 'r'], p.env)).code, 2);
  // --run on an execution that does not exist: refused, never taken for « outside any execution ».
  const missing = await p.gates(p.worktree, '--run', 'absente');
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /\[RUN_MISSING\] : Aucune exécution absente : .apv\/state\/run-absente.json n.existe dans aucun worktree du dépôt/);
});

test('outside an execution nothing changes: other branch, unknown spec, detached head; a pointless --reason is said', async t => {
  const p = await project(t);
  // The main checkout on main: not an execution branch.
  assert.equal((await p.gates(p.repo, '--stage', 'full')).code, 0);
  // A branch named like an execution without its state.
  const other = join(p.root, 'other');
  git(p.repo, 'worktree', 'add', '-q', '-b', 'apv/autre-T1', other, 'HEAD');
  const unknown = await p.gates(other, '--stage', 'full', '--json');
  assert.equal(unknown.code, 0, unknown.stderr);
  assert.equal(unknown.json().rhythm, null);
  // A detached head (the delivery worktree).
  const detached = join(p.root, 'detached');
  git(p.repo, 'worktree', 'add', '-q', '--detach', detached, 'HEAD');
  assert.equal((await p.gates(detached)).code, 0);
  const pointless = await p.gates(other, '--reason', 'inutile');
  assert.equal(pointless.code, 0);
  assert.match(pointless.stdout, /^Note : --reason sans effet, aucune exécution trouvée pour cette branche/m);
  assert.deepEqual(p.ran(), ['unit', 'e2e', 'unit', 'e2e', 'unit', 'e2e', 'unit', 'e2e']);
  assert.equal(p.state().events.length, 3);
});

test('the last integration, the delivery and each-integration expect the full suite: it runs without --reason', async t => {
  const p = await project(t);
  // each-integration: the full suite at every integration, read from the configuration of the main checkout.
  write(p.repo, '.apv/config.json', { ...JSON.parse(readFileSync(join(p.repo, '.apv/config.json'), 'utf8')), run: { fullSuite: 'each-integration' } });
  const each = await p.gates(p.worktree, '--stage', 'full', '--json');
  assert.equal(each.code, 0, each.stderr);
  assert.deepEqual([each.json().rhythm.level, each.json().rhythm.override], ['full', null]);
  git(p.repo, 'checkout', '-q', '--', '.apv/config.json');

  // Every task done: the last integration, level full.
  const a = git(p.repo, 'rev-parse', 'HEAD');
  await p.run('set', 'rythme', 'task:A', 'running');
  await p.run('set', 'rythme', 'task:A', 'done', '--commit', a);
  await p.run('set', 'rythme', 'task:B', 'running');
  await p.run('set', 'rythme', 'task:B', 'done', '--commit', a);
  const last = await p.gates(p.worktree, '--stage', 'full', '--json');
  assert.equal(last.code, 0, last.stderr);
  assert.deepEqual([last.json().rhythm.step, last.json().rhythm.level], ['integration', 'full']);
  const pointless = await p.gates(p.worktree, '--reason', 'inutile ici');
  assert.equal(pointless.code, 0);
  assert.match(pointless.stdout, /^Note : --reason sans effet, l'exécution rythme \(intégration\) n'attend pas le seul niveau tâche à cette étape\.$/m);

  // The fixes of final are at the task level again; the delivery takes the full suite.
  for (const [target, status] of [['integration', 'done'], ['reviews', 'done'], ['fixes', 'running']]) await p.run('set', 'rythme', target, status, ...(target === 'integration' ? ['--commit', a] : []));
  assert.equal((await p.gates(p.worktree, '--stage', 'full')).code, 1, 'fixes: task level');
  await p.run('set', 'rythme', 'fixes', 'done');
  await p.run('set', 'rythme', 'delivery', 'running');
  const delivery = await p.gates(p.worktree, '--stage', 'full', '--json');
  assert.equal(delivery.code, 0, delivery.stderr);
  assert.deepEqual([delivery.json().rhythm.step, delivery.json().rhythm.level], ['delivery', 'full']);
});

test('an execution run from its own worktree: its state is found there, with and without --run; apv run finds it from another checkout', async t => {
  const p = await project(t, { lead: true });
  const lead = realpathSync(p.checkout);
  assert.ok(!existsSync(join(p.repo, '.apv/state/run-rythme.json')), 'the main checkout has no state');
  const listed = listWorktrees(p.worktree);
  assert.deepEqual(listed[0], { path: realpathSync(p.repo), branch: 'main', main: true });
  assert.deepEqual(listed.slice(1).map(w => [w.branch, w.main]).sort(), [['apv/rythme', false], ['apv/rythme-integration-1', false]]);
  assert.equal(locateRunState(p.worktree, 'rythme').path, lead);
  // Without --run: found by the branch of the integration worktree, state read in the worktree of the execution.
  const byBranch = await p.gates(p.worktree, '--stage', 'full');
  assert.equal(byBranch.code, 1);
  assert.match(byBranch.stderr, /\[GATE_RHYTHM\] : Suite complète refusée : l'exécution rythme \(exécution trouvée par la branche apv\/rythme-integration-1/);
  // With --run, from the main checkout on main: the same refusal, never RUN_MISSING.
  const named = await p.gates(p.repo, '--stage', 'full', '--run', 'rythme');
  assert.equal(named.code, 1, named.stderr);
  assert.match(named.stderr, /\[GATE_RHYTHM\] : Suite complète refusée : l'exécution rythme en est à l'étape vagues/);
  assert.deepEqual(p.ran(), [], 'nothing ran');
  // --reason writes in the state of the worktree of the execution.
  const before = p.state().events.length;
  const forced = await p.gates(p.worktree, '--stage', 'full', '--reason', 'raison', '--json');
  assert.equal(forced.code, 0, forced.stderr);
  assert.deepEqual([forced.json().rhythm.checkout, forced.json().rhythm.level], [lead, 'task']);
  assert.equal(p.state().events.length, before + 1);
  assert.ok(!existsSync(join(p.repo, '.apv/state/run-rythme.json')) && !existsSync(join(p.worktree, '.apv/state/run-rythme.json')), 'no state written elsewhere');
  // apv run from a checkout without the state: the state of the execution, said on stderr.
  const next = await apv(p.repo, ['run', 'next', 'rythme', '--json'], p.env);
  assert.equal(next.code, 0, next.stderr);
  assert.equal(next.json().suite.level, 'task');
  assert.match(next.stderr, new RegExp(`^Note : état de l'exécution rythme lu dans le worktree ${lead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(apv/rythme\\)`));
  const set = await apv(p.worktree, ['run', 'set', 'rythme', 'task:A', 'running'], p.env);
  assert.equal(set.code, 0, set.stderr);
  assert.equal(p.state().tasks.A.status, 'running', 'written in the state of the execution');
  // A checkout that has the state keeps it (unchanged usage): no note.
  const own = await apv(p.checkout, ['run', 'status', 'rythme'], p.env);
  assert.equal(own.code, 0);
  assert.equal(own.stderr, '');
});

test('several copies of a state: the worktree on apv/<id>, else the main checkout, else refused with every location', async t => {
  const p = await project(t, { lead: true });
  const lead = realpathSync(p.checkout);
  const saved = join(p.root, 'run-rythme.json');
  copyFileSync(join(lead, '.apv/state/run-rythme.json'), saved);
  const copy = dir => { mkdirSync(join(dir, '.apv/state'), { recursive: true }); copyFileSync(saved, join(dir, '.apv/state/run-rythme.json')); };
  // Stale copies in the main checkout and in the integration worktree: the worktree on apv/rythme wins.
  copy(p.repo); copy(p.worktree);
  assert.equal(locateRunState(p.worktree, 'rythme').path, lead);
  const r = await p.gates(p.worktree, '--stage', 'full', '--reason', 'raison', '--json');
  assert.equal(r.json().rhythm.checkout, lead);
  // No copy on apv/rythme: the main checkout.
  rmSync(join(lead, '.apv/state/run-rythme.json'));
  assert.equal(locateRunState(p.worktree, 'rythme').path, realpathSync(p.repo));
  assert.equal((await p.gates(p.worktree, '--stage', 'full', '--reason', 'raison', '--json')).json().rhythm.checkout, realpathSync(p.repo));
  // Neither: refused, the locations listed, with and without --run.
  rmSync(join(p.repo, '.apv/state/run-rythme.json'));
  const other = join(p.root, 'other');
  git(p.repo, 'worktree', 'add', '-q', '-b', 'apv/rythme-T1', other, 'HEAD');
  copy(other);
  assert.throws(() => locateRunState(p.repo, 'rythme'), /RUN_AMBIGUOUS|plusieurs états/);
  for (const args of [['--stage', 'full'], ['--stage', 'full', '--run', 'rythme']]) {
    const ambiguous = await p.gates(p.worktree, ...args);
    assert.equal(ambiguous.code, 1, args.join(' '));
    assert.match(ambiguous.stderr, /\[RUN_AMBIGUOUS\] : Exécution rythme : plusieurs états .apv\/state\/run-rythme.json/);
    assert.ok(ambiguous.stderr.includes(`${realpathSync(p.worktree)} (apv/rythme-integration-1)`) && ambiguous.stderr.includes(`${realpathSync(other)} (apv/rythme-T1)`), ambiguous.stderr);
  }
  assert.deepEqual(p.ran(), ['unit', 'e2e', 'unit', 'e2e']);
  // apv run from a checkout that has a copy uses its own (unchanged usage).
  assert.equal((await apv(other, ['run', 'status', 'rythme'], p.env)).code, 0);
});

test('no state anywhere: outside any execution, unchanged', async t => {
  const p = await project(t);
  assert.equal(locateRunState(p.worktree, 'absente'), null);
  const other = join(p.root, 'other');
  git(p.repo, 'worktree', 'add', '-q', '-b', 'apv/absente-integration-1', other, 'HEAD');
  const r = await p.gates(other, '--stage', 'full', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().rhythm, null);
  const next = await apv(other, ['run', 'next', 'absente'], p.env);
  assert.equal(next.code, 1);
  assert.match(next.stderr, /RUN_MISSING/);
});
