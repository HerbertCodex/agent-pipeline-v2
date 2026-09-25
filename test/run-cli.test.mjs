import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { applySet, computeFoundations, computeNext, computeWaves, createRunState, migrateRunState, parseTarget, readRunState } from '../dist/run/state.js';
import { localTime } from '../dist/domain/time.js';

// Times are shown in local time: a fixed zone keeps the expected lines stable (UTC+2 in September).
process.env.TZ = 'Europe/Paris';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/** Spec with a foundation F, two tasks on it, an independent task C and a final task D. */
function waveSpec() {
  const task = (id, dependsOn) => ({ id, title: `Tâche ${id}`, description: `Écrire docs/${id}.md.`, acceptanceIds: [`AC-${id}`],
    allowedPaths: [`docs/${id.toLowerCase()}.md`], dependsOn, minimumLane: 'standard' });
  const ids = [['F', []], ['A', ['F']], ['B', ['F']], ['C', []], ['D', ['A', 'B']]];
  return { title: 'Documentation en vagues', problem: 'La documentation doit être écrite en plusieurs parties.', scope: ['Documentation'], outOfScope: [],
    acceptance: ids.map(([id]) => ({ id: `AC-${id}`, description: `Partie ${id} écrite.`, verification: `Lire docs/${id}.md.` })),
    decisions: [], questions: [], tasks: ids.map(([id, deps]) => task(id, deps)), minimumLane: 'standard' };
}

function project(t) {
  const f = fixture(t);
  write(f.repo, '.apv/specs/vagues.json', waveSpec());
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'spec');
  const env = { APV_LOCK_DIR: join(f.root, 'locks'), APV_LOCK_POLL_MS: '20' };
  const run = (...args) => apv(f.repo, ['run', ...args], env);
  const state = () => JSON.parse(readFileSync(join(f.repo, '.apv/state/run-vagues.json'), 'utf8'));
  return { ...f, env, run, state };
}

/** A branch with one commit on the base, in its own worktree. */
function taskBranch(p, name, file) {
  const dir = join(p.root, name.replace(/\//g, '-'));
  git(p.repo, 'worktree', 'add', '-q', '-b', name, dir, 'main');
  write(dir, file, `${name}\n`);
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', name);
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') };
}

test('waves: topological layers in spec order; foundations: tasks at least two others depend on', () => {
  const t = (id, dependsOn = []) => ({ id, title: id, dependsOn });
  const spec = [t('F'), t('A', ['F']), t('B', ['F']), t('C'), t('D', ['A', 'B'])];
  assert.deepEqual(computeWaves(spec), [{ index: 0, tasks: ['F', 'C'] }, { index: 1, tasks: ['A', 'B'] }, { index: 2, tasks: ['D'] }]);
  assert.deepEqual(computeFoundations(spec), ['F']);
  assert.deepEqual(computeWaves([t('A'), t('B'), t('C')]), [{ index: 0, tasks: ['A', 'B', 'C'] }]);
  assert.deepEqual(computeFoundations([t('A'), t('B'), t('C')]), []);
  // A chain: each task has one dependent only, so none is a foundation.
  const chain = [t('C', ['B']), t('B', ['A']), t('A')];
  assert.deepEqual(computeWaves(chain), [{ index: 0, tasks: ['A'] }, { index: 1, tasks: ['B'] }, { index: 2, tasks: ['C'] }]);
  assert.deepEqual(computeFoundations(chain), []);
  // The phase 3 trial: BIN, needed by DOCS alone, is no foundation and stays in wave 0 beside SUMMARY.
  const trial = [t('SUMMARY'), t('HOOK', ['SUMMARY']), t('BIN'), t('DOCS', ['HOOK', 'BIN'])];
  assert.deepEqual(computeWaves(trial), [{ index: 0, tasks: ['SUMMARY', 'BIN'] }, { index: 1, tasks: ['HOOK'] }, { index: 2, tasks: ['DOCS'] }]);
  assert.deepEqual(computeFoundations(trial), []);
  // A foundation may sit in any layer; a dependency listed twice counts once.
  const deep = [t('A'), t('B', ['A']), t('C', ['B', 'B']), t('D', ['B']), t('E', ['A'])];
  assert.deepEqual(computeFoundations(deep), ['A', 'B']);
  assert.deepEqual(computeFoundations([t('A'), t('B', ['A', 'A'])]), []);
  assert.deepEqual(computeWaves([t('A'), t('B', ['A']), t('C', ['A', 'B'])]).map(w => w.tasks), [['A'], ['B'], ['C']]);
  assert.deepEqual(computeWaves([]), []);
  assert.throws(() => computeWaves([t('A', ['B']), t('B', ['A'])]), /Cycle/);
  assert.throws(() => computeWaves([t('A', ['Z'])]), /Dépendance inconnue/);
});

test('a state of version 1 stays readable: its foundation wave becomes foundation tasks', t => {
  const v2 = createRunState({ specId: 's', specFile: 's.json', specSha256: 'a'.repeat(64), base: 'main', baseSha: 'b'.repeat(40),
    tasks: [{ id: 'S', title: 'S', dependsOn: [] }, { id: 'H', title: 'H', dependsOn: ['S'] }, { id: 'B', title: 'B', dependsOn: [] }] });
  assert.equal(v2.schemaVersion, 2);
  const v1 = structuredClone(v2);
  v1.schemaVersion = 1;
  v1.waves = [{ index: 0, foundation: true, tasks: ['S'] }, { index: 1, foundation: false, tasks: ['H', 'B'] }];
  for (const task of Object.values(v1.tasks)) delete task.foundation;
  const migrated = migrateRunState(v1);
  assert.equal(v1.schemaVersion, 1, 'the input is not modified');
  assert.deepEqual(migrated.waves, [{ index: 0, tasks: ['S'] }, { index: 1, tasks: ['H', 'B'] }]);
  assert.deepEqual(Object.entries(migrated.tasks).map(([id, x]) => [id, x.foundation]), [['S', true], ['H', false], ['B', false]]);
  assert.equal(migrated.schemaVersion, 2);
  // Unknown shapes are left to the schema.
  assert.equal(migrateRunState('x'), 'x');
  assert.deepEqual(migrateRunState({ schemaVersion: 3 }), { schemaVersion: 3 });
  // The state of the phase 3 trial, written by the version 1 tool, still reads.
  const repoState = fileURLToPath(new URL('../.apv/state/run-p3-essai.json', import.meta.url));
  if (!existsSync(repoState)) return t.skip('state of the trial absent (package without .apv)');
  const trial = readRunState(repoState, { specId: 'p3-essai' });
  assert.deepEqual(Object.entries(trial.tasks).map(([id, x]) => [id, x.foundation, x.wave]), [['SUMMARY', true, 0], ['HOOK', false, 1], ['BIN', false, 1], ['DOCS', false, 2]]);
});

test('targets: steps, task:<id>, review:<domain>', () => {
  assert.deepEqual(parseTarget('data-model'), { kind: 'step', name: 'data-model' });
  assert.deepEqual(parseTarget('task:T-1.a'), { kind: 'task', id: 'T-1.a' });
  assert.deepEqual(parseTarget('review:rgpd'), { kind: 'review', domain: 'rgpd' });
  for (const bad of ['waves', 'task:', 'task:-x', 'review:qa', 'reviews:securite', '']) assert.equal(parseTarget(bad), null, bad);
});

test('apv run start validates the spec, computes the waves and writes the state', async t => {
  const p = project(t);
  const r = await p.run('start', 'vagues', '--json');
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const s = p.state();
  assert.deepEqual(r.json().state, s);
  assert.equal(s.specId, 'vagues'); assert.equal(s.specFile, '.apv/specs/vagues.json');
  assert.match(s.specSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual([s.base, s.baseSha, s.branch], ['main', git(p.repo, 'rev-parse', 'main'), 'apv/vagues']);
  assert.deepEqual(Object.keys(s.steps), ['data-model', 'plan', 'integration', 'reviews', 'fixes', 'delivery']);
  assert.ok(Object.values(s.steps).every(x => x.status === 'pending'));
  assert.equal(s.schemaVersion, 2);
  assert.deepEqual(s.waves.map(w => [w.index, w.tasks]), [[0, ['F', 'C']], [1, ['A', 'B']], [2, ['D']]]);
  assert.deepEqual(Object.entries(s.tasks).map(([id, x]) => [id, x.foundation]), [['F', true], ['A', false], ['B', false], ['C', false], ['D', false]]);
  assert.deepEqual(s.tasks.D, { title: 'Tâche D', dependsOn: ['A', 'B'], wave: 2, foundation: false, status: 'pending', branch: null, worktree: null, agentId: null,
    base: null, commit: null, note: null, updatedAt: null });
  assert.deepEqual(Object.keys(s.reviews), ['securite', 'fidelite', 'donnees', 'rgpd']);
  assert.deepEqual(s.reviews.rgpd, { status: 'pending', findings: null, commit: null, note: null, updatedAt: null });
  assert.equal(s.events.length, 1);
  assert.deepEqual(readdirSync(join(p.repo, '.apv/state')), ['run-vagues.json'], 'no temporary file left');
  const again = await p.run('start', 'vagues');
  assert.equal(again.code, 1);
  assert.match(again.stderr, /RUN_EXISTS.*apv run next vagues/);
  const human = await p.run('status', 'vagues');
  assert.match(human.stdout, /\nVague 0 : fondations \(un seul agent\) : F à faire ; en parallèle : C à faire\nVague 1 : A à faire, B à faire\nVague 2 : D à faire\n/);
  write(p.repo, 'specs/autre.json', waveSpec());
  const shown = await p.run('start', 'specs/autre.json');
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /\nVagues :\n- vague 0 : fondations \(un seul agent\) : F ; en parallèle : C\n- vague 1 : A, B\n- vague 2 : D\n/);
});

test('apv run start refuses an invalid spec, an unknown base and wrong calls', async t => {
  const p = project(t);
  write(p.repo, '.apv/specs/draft.json', { ...waveSpec(), questions: [{ id: 'Q', question: 'Quel format ?' }] });
  const invalid = await p.run('start', 'draft');
  assert.equal(invalid.code, 1);
  assert.match(invalid.stdout, /Spec invalide, exécution non créée[\s\S]*OPEN_QUESTIONS/);
  assert.ok(!existsSync(join(p.repo, '.apv/state/run-draft.json')));
  const missing = await p.run('start', 'nope', '--json');
  assert.equal(missing.code, 1);
  assert.equal(missing.json().issues[0].code, 'SPEC_FILE');
  assert.equal((await p.run('start', 'vagues', '--base', 'nowhere')).code, 1);
  assert.equal((await p.run('start')).code, 2);
  assert.equal((await p.run('start', 'vagues', '--commit', 'abc')).code, 2);
  assert.equal((await p.run('launch', 'vagues')).code, 2);
  assert.equal((await p.run()).code, 2);
  // A spec given by path, with an explicit base.
  git(p.repo, 'branch', 'develop');
  write(p.repo, 'specs/other.json', waveSpec());
  const byPath = await p.run('start', 'specs/other.json', '--base', 'develop', '--json');
  assert.equal(byPath.code, 0, byPath.stdout);
  assert.deepEqual([byPath.json().state.specId, byPath.json().state.specFile, byPath.json().state.base], ['other', 'specs/other.json', 'develop']);
});

test('apv run set checks transitions, dependencies and commits, and journals each change', async t => {
  const p = project(t);
  await p.run('start', 'vagues');
  const a = await p.run('set', 'vagues', 'task:A', 'running');
  assert.equal(a.code, 1);
  assert.match(a.stderr, /dépendance\(s\) pas encore faite\(s\) : F \(pending\)/);
  const f = taskBranch(p, 'spec/vagues-f', 'docs/f.md');
  const start = await p.run('set', 'vagues', 'task:F', 'running', '--branch', 'spec/vagues-f', '--worktree', f.dir, '--agent', 'agent-f', '--base', 'main');
  assert.equal(start.code, 0, start.stderr);
  const done = await p.run('set', 'vagues', 'task:F', 'done');
  assert.equal(done.code, 1);
  assert.match(done.stderr, /exige --commit/);
  assert.equal((await p.run('set', 'vagues', 'task:F', 'done', '--commit', 'deadbeef')).code, 1, 'unknown commit');
  const ok = await p.run('set', 'vagues', 'task:F', 'done', '--commit', 'spec/vagues-f', '--note', 'intégrée', '--json');
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual([ok.json().from, ok.json().to, ok.json().event.commit], ['running', 'done', f.sha]);
  const task = p.state().tasks.F;
  assert.deepEqual([task.status, task.branch, task.worktree, task.agentId, task.commit, task.base, task.note],
    ['done', 'spec/vagues-f', f.dir, 'agent-f', f.sha, git(p.repo, 'rev-parse', 'main'), 'intégrée']);
  // F done but not integrated: A waits (point 4 of the phase 3 trial), until apv/vagues holds F.
  const early = await p.run('set', 'vagues', 'task:A', 'running');
  assert.equal(early.code, 1);
  assert.match(early.stderr, /task:A : dépendance\(s\) faite\(s\) mais pas encore intégrée\(s\) dans la base main \([a-f0-9]{12}\), la branche apv\/vagues n'existant pas encore : F \(commit [a-f0-9]{12}\)/);
  git(p.repo, 'branch', 'apv/vagues', 'spec/vagues-f');
  assert.equal((await p.run('set', 'vagues', 'task:A', 'running')).code, 0, 'F done and integrated: A may start');
  // Reopening finished work needs a reason; forbidden moves are refused.
  assert.equal((await p.run('set', 'vagues', 'task:F', 'running')).code, 1);
  assert.equal((await p.run('set', 'vagues', 'task:F', 'running', '--note', 'correction après revue')).code, 0);
  assert.equal((await p.run('set', 'vagues', 'task:C', 'skipped')).code, 0);
  assert.equal((await p.run('set', 'vagues', 'task:C', 'done', '--commit', 'main')).code, 1, 'skipped -> done is not a transition');
  // Steps and reviews.
  assert.equal((await p.run('set', 'vagues', 'data-model', 'skipped', '--note', 'aucune donnée')).code, 0);
  const review = await p.run('set', 'vagues', 'review:securite', 'done', '--findings', '3', '--note', 'corrections-vagues.md');
  assert.equal(review.code, 0, review.stderr);
  assert.deepEqual([p.state().reviews.securite.findings, p.state().reviews.securite.note], [3, 'corrections-vagues.md']);
  const events = p.state().events;
  assert.equal(events.length, 1 + 7);
  assert.ok(events.every(e => !('unintegrated' in e)));
  assert.deepEqual(events.at(-1), { at: events.at(-1).at, target: 'review:securite', from: 'pending', to: 'done', note: 'corrections-vagues.md' });
  // Wrong calls: exit 2.
  for (const args of [['task:Z', 'done'], ['review:qa', 'done'], ['plan', 'finished'], ['plan', 'done', '--branch', 'x'], ['task:A', 'done', '--findings', '1'],
    ['review:rgpd', 'done', '--findings', 'x'], ['plan'], ['plan', 'done', 'extra']]) {
    assert.equal((await p.run('set', 'vagues', ...args)).code, args[0] === 'task:Z' ? 1 : 2, args.join(' '));
  }
  // A step or a review may record its commit (the plan commit, the reviewed commit); an unknown one is refused.
  const plan = await p.run('set', 'vagues', 'plan', 'done', '--commit', 'main', '--json');
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(p.state().steps.plan.commit, git(p.repo, 'rev-parse', 'main'));
  assert.equal(plan.json().event.commit, git(p.repo, 'rev-parse', 'main'));
  assert.equal((await p.run('set', 'vagues', 'review:rgpd', 'done', '--commit', 'main')).code, 0);
  assert.equal(p.state().reviews.rgpd.commit, git(p.repo, 'rev-parse', 'main'));
  assert.equal((await p.run('set', 'vagues', 'integration', 'running', '--commit', 'deadbeef')).code, 1, 'unknown commit');
  assert.equal(p.state().steps.integration.commit, null);
  assert.equal((await p.run('set', 'absent', 'plan', 'done')).code, 1, 'no execution for this spec');
  assert.equal((await p.run('set', '../x', 'plan', 'done')).code, 2);
});

test('apv run next says what to do now and which running tasks to resume or relaunch', async t => {
  const p = project(t);
  await p.run('start', 'vagues');
  let next = (await p.run('next', 'vagues', '--json')).json();
  assert.deepEqual([next.step, next.stepStatus, next.wave, next.finished], ['data-model', 'pending', 0, false]);
  assert.deepEqual(next.ready.map(r => r.id), ['F', 'C']);
  assert.deepEqual(next.blocked, [{ id: 'A', waitingOn: ['F'] }, { id: 'B', waitingOn: ['F'] }, { id: 'D', waitingOn: ['A', 'B'] }]);
  await p.run('set', 'vagues', 'data-model', 'skipped', '--note', 'aucune donnée');
  await p.run('set', 'vagues', 'plan', 'done');
  next = (await p.run('next', 'vagues', '--json')).json();
  assert.equal(next.step, 'waves');
  assert.match(next.actions.join('\n'), /lancer 2 tâche\(s\) prête\(s\) : fondations \(un seul agent\) : F ; en parallèle : C/);
  assert.deepEqual(next.ready.map(r => [r.id, r.foundation]), [['F', true], ['C', false]]);
  assert.deepEqual(next.integration, { head: git(p.repo, 'rev-parse', 'main'), where: `la base main (${git(p.repo, 'rev-parse', 'main').slice(0, 12)}), la branche apv/vagues n'existant pas encore` });
  // F runs in a worktree without commit yet, C in a worktree that is gone, B... not started.
  const dir = join(p.root, 'wt-f');
  git(p.repo, 'worktree', 'add', '-q', '-b', 'spec/vagues-f', dir, 'main');
  await p.run('set', 'vagues', 'task:F', 'running', '--branch', 'spec/vagues-f', '--worktree', dir, '--agent', 'agent-f');
  await p.run('set', 'vagues', 'task:C', 'running', '--worktree', join(p.root, 'gone'), '--agent', 'agent-c');
  next = (await p.run('next', 'vagues', '--json')).json();
  assert.deepEqual(next.relaunch.map(r => [r.id, r.reason]), [['F', `aucun commit après la base ${git(p.repo, 'rev-parse', 'main').slice(0, 12)}`], ['C', `worktree absent : ${join(p.root, 'gone')}`]]);
  assert.deepEqual(next.resume, []);
  write(dir, 'docs/f.md', 'wip\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'wip F');
  next = (await p.run('next', 'vagues', '--json')).json();
  assert.deepEqual(next.resume.map(r => [r.id, r.branch, r.worktree, r.agentId, r.commitsAfterBase, r.head]),
    [['F', 'spec/vagues-f', dir, 'agent-f', 1, git(dir, 'rev-parse', 'HEAD')]]);
  const human = await p.run('next', 'vagues');
  assert.match(human.stdout, /Étape courante : vagues \(vague 0\)/);
  assert.match(human.stdout, /À relancer \(si leur agent ne tourne plus\) :\n- C : worktree absent/);
  assert.match(human.stdout, /À reprendre :\n- F : branche spec\/vagues-f ; worktree .* ; agent agent-f ; tête [a-f0-9]{12} ; 1 commit\(s\) après la base/);
  assert.equal(next.specChanged, false);
  write(p.repo, '.apv/specs/vagues.json', { ...waveSpec(), title: 'Titre modifié' });
  next = (await p.run('next', 'vagues', '--json')).json();
  assert.equal(next.specChanged, true);
  assert.match(next.actions[0], /la spec \.apv\/specs\/vagues\.json a changé depuis le lancement/);
  assert.equal((await p.run('next', 'absent')).code, 1);
  assert.equal((await p.run('next')).code, 2);
  assert.equal((await p.run('next', 'vagues', '--base', 'main')).code, 2);
});

test('a task is ready when its dependencies are done AND integrated in the branch of the spec', () => {
  // Point 4 of the phase 3 trial: next said « prête » for a task whose dependencies were done but not integrated.
  const base = 'b'.repeat(40); const f = 'f'.repeat(40); const head = 'e'.repeat(40);
  let s = createRunState({ specId: 's', specFile: 's.json', specSha256: 'a'.repeat(64), base: 'main', baseSha: base,
    tasks: [{ id: 'F', title: 'F', dependsOn: [] }, { id: 'A', title: 'A', dependsOn: ['F'] }, { id: 'B', title: 'B', dependsOn: ['F'] }, { id: 'C', title: 'C', dependsOn: [] }] });
  for (const step of ['data-model', 'plan']) s = applySet(s, parseTarget(step), { status: 'skipped' }).state;
  s = applySet(s, parseTarget('task:F'), { status: 'done', commit: f }).state;
  const probe = (branch, ancestors) => ({ exists: () => true, countAfter: () => 1,
    resolve: ref => ref === 'apv/s' ? branch : null, isAncestor: (c, h) => ancestors.includes(`${c}@${h}`) });
  // No branch of the spec yet: the base of the execution is the head, and F is not in it.
  let next = computeNext(s, probe(null, []));
  assert.deepEqual(next.ready.map(r => r.id), ['C']);
  assert.deepEqual(next.awaitingIntegration, [{ id: 'A', wave: 1, waitingOn: ['F'] }, { id: 'B', wave: 1, waitingOn: ['F'] }]);
  assert.deepEqual(next.blocked, []);
  assert.equal(next.integration.head, base);
  assert.match(next.actions.join('\n'), /intégrer F \(commit f{12}\) dans apv\/s : A, B en attend\(ent\) l'intégration/);
  // The branch exists but does not hold F yet.
  next = computeNext(s, probe(head, []));
  assert.deepEqual([next.ready.map(r => r.id), next.awaitingIntegration.map(a => a.id), next.integration], [['C'], ['A', 'B'], { head, where: 'apv/s' }]);
  // Integrated: A and B are ready now, launched at once with C (wave 0), not wave by wave.
  next = computeNext(s, probe(head, [`${f}@${head}`]));
  assert.deepEqual([next.ready.map(r => r.id), next.awaitingIntegration], [['C', 'A', 'B'], []]);
  assert.match(next.actions.join('\n'), /lancer 3 tâche\(s\) prête\(s\) : en parallèle : C, A, B/);
  // The head itself counts as integrated.
  assert.deepEqual(computeNext(s, probe(f, [])).ready.map(r => r.id), ['C', 'A', 'B']);
  // set refuses the same start, unless forced with a note, journaled with the dependencies.
  const check = { head, where: 'apv/s', integrated: () => false };
  assert.throws(() => applySet(s, parseTarget('task:A'), { status: 'running', integration: check }), /pas encore intégrée\(s\) dans apv\/s : F/);
  assert.throws(() => applySet(s, parseTarget('task:A'), { status: 'running' }), /pas encore intégrée\(s\) dans la branche de la spec/);
  assert.throws(() => applySet(s, parseTarget('task:A'), { status: 'running', integration: check, forceUnintegrated: true }), /exige --note/);
  const forced = applySet(s, parseTarget('task:A'), { status: 'running', integration: check, forceUnintegrated: true, note: 'fichiers disjoints' });
  assert.deepEqual([forced.event.unintegrated, forced.event.note], [['F'], 'fichiers disjoints']);
  // A running task that only updates its fields is not checked again.
  assert.equal(applySet(forced.state, parseTarget('task:A'), { status: 'running', agentId: 'x', integration: check }).event.unintegrated, undefined);
  // Forcing never skips a dependency that is not done.
  const reopened = applySet(s, parseTarget('task:F'), { status: 'running', note: 'rouverte' }).state;
  assert.throws(() => applySet(reopened, parseTarget('task:A'), { status: 'running', integration: check, forceUnintegrated: true, note: 'x' }), /pas encore faite/);
});

test('apv run set --force-unintegrated starts a task before the integration, with a journaled note', async t => {
  const p = project(t);
  await p.run('start', 'vagues');
  const f = taskBranch(p, 'spec/vagues-f', 'docs/f.md');
  await p.run('set', 'vagues', 'task:F', 'done', '--commit', f.sha);
  // The branch of the spec exists, without F.
  git(p.repo, 'branch', 'apv/vagues', 'main');
  const refused = await p.run('set', 'vagues', 'task:B', 'running');
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /pas encore intégrée\(s\) dans apv\/vagues : F/);
  const human = await p.run('next', 'vagues');
  assert.match(human.stdout, /Intégration mesurée sur : apv\/vagues à [a-f0-9]{12}\n/);
  assert.match(human.stdout, /Prêtes : C \(vague 0\)\nEn attente d'intégration : A \(attend l'intégration de F\) ; B \(attend l'intégration de F\)\n/);
  assert.equal((await p.run('set', 'vagues', 'task:B', 'running', '--force-unintegrated')).code, 2, 'a note is required');
  assert.equal((await p.run('set', 'vagues', 'task:B', 'running', '--force-unintegrated', '--note', ' ')).code, 2);
  assert.equal((await p.run('set', 'vagues', 'task:B', 'done', '--commit', 'main', '--force-unintegrated', '--note', 'x')).code, 2);
  assert.equal((await p.run('set', 'vagues', 'plan', 'running', '--force-unintegrated', '--note', 'x')).code, 2);
  assert.equal((await p.run('next', 'vagues', '--force-unintegrated')).code, 2);
  const forced = await p.run('set', 'vagues', 'task:B', 'running', '--force-unintegrated', '--note', 'fichiers disjoints, décision notée');
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /démarrée sans l'intégration de F \(--force-unintegrated, journalisé\)/);
  assert.deepEqual(p.state().events.at(-1), { at: p.state().events.at(-1).at, target: 'task:B', from: 'pending', to: 'running',
    note: 'fichiers disjoints, décision notée', unintegrated: ['F'] });
  // Once F is integrated (fast-forward of the spec branch), A starts without force.
  git(p.repo, 'branch', '-f', 'apv/vagues', f.sha);
  assert.equal((await p.run('set', 'vagues', 'task:A', 'running')).code, 0);
  assert.equal(p.state().events.at(-1).unintegrated, undefined);
});

test('next: a running task whose branch has no commit of its own after its start is to relaunch', () => {
  const state = createRunState({ specId: 's', specFile: 's.json', specSha256: 'a'.repeat(64), base: 'main', baseSha: 'b'.repeat(40),
    tasks: [{ id: 'T', title: 'T', dependsOn: [] }] });
  const running = applySet(state, { kind: 'task', id: 'T' }, { status: 'running', branch: 'spec/t', base: 'c'.repeat(40) }).state;
  const probe = (count, head = 'd'.repeat(40)) => ({ exists: () => true, resolve: () => head, isAncestor: () => false, countAfter: (base) => { assert.equal(base, 'c'.repeat(40)); return count; } });
  assert.equal(computeNext(running, probe(0)).relaunch[0].reason, `aucun commit après la base ${'c'.repeat(12)}`);
  assert.equal(computeNext(running, probe(2)).resume[0].commitsAfterBase, 2);
  assert.equal(computeNext(running, probe(2, null)).relaunch[0].reason, 'branche introuvable : spec/t');
  const bare = applySet(state, { kind: 'task', id: 'T' }, { status: 'running' }).state;
  assert.equal(computeNext(bare, probe(1)).relaunch[0].reason, 'ni branche ni worktree enregistrés');
});

test('next walks the steps: integration, reviews to launch, then the end', () => {
  let s = createRunState({ specId: 's', specFile: 's.json', specSha256: 'a'.repeat(64), base: 'main', baseSha: 'b'.repeat(40), tasks: [{ id: 'T', title: 'T', dependsOn: [] }] });
  const set = (target, status, extra = {}) => { s = applySet(s, parseTarget(target), { status, ...extra }).state; };
  const probe = { exists: () => true, resolve: () => null, countAfter: () => null, isAncestor: () => false };
  set('data-model', 'skipped'); set('plan', 'done'); set('task:T', 'done', { commit: 'e'.repeat(40) });
  assert.equal(computeNext(s, probe).step, 'integration');
  assert.deepEqual(computeNext(s, probe).reviewsToLaunch, []);
  set('integration', 'done');
  let next = computeNext(s, probe);
  assert.deepEqual([next.step, next.reviewsToLaunch], ['reviews', ['securite', 'fidelite', 'donnees', 'rgpd']]);
  assert.match(next.actions.join('\n'), /lancer les revues : securite, fidelite, donnees, rgpd/);
  set('review:securite', 'running'); set('review:fidelite', 'failed');
  next = computeNext(s, probe);
  assert.deepEqual([next.reviewsToLaunch, next.reviewsRunning], [['fidelite', 'donnees', 'rgpd'], ['securite']]);
  for (const step of ['reviews', 'fixes', 'delivery']) set(step, 'done');
  next = computeNext(s, probe);
  assert.deepEqual([next.step, next.finished, next.actions], [null, true, ['exécution terminée']]);
});

test('apv run status and apv status list the executions', async t => {
  const p = project(t);
  assert.match((await p.run('status')).stdout, /Aucune exécution/);
  await p.run('start', 'vagues');
  write(p.repo, '.apv/state/run-broken.json', '{');
  const all = await p.run('status', '--json');
  assert.equal(all.code, 0);
  assert.deepEqual(all.json().runs.map(r => [r.specId, r.error === null]), [['broken', false], ['vagues', true]]);
  assert.deepEqual(all.json().runs[1].tasks, { pending: 5, running: 0, done: 0, failed: 0, skipped: 0, total: 5 });
  const human = await p.run('status');
  assert.match(human.stdout, /- broken : état illisible/);
  assert.match(human.stdout, /- vagues : étape modèle de données ; tâches 0\/5 faites ; mise à jour /);
  const global = await apv(p.repo, ['status'], p.env);
  assert.match(global.stdout, /Exécutions en cours :\n- broken : état illisible .*\n- vagues : étape modèle de données ; tâches 0\/5 faites/);
  assert.equal((await apv(p.repo, ['status', '--json'], p.env)).json().runs.length, 2);
  const one = await p.run('status', 'vagues', '--json');
  assert.equal(one.json().summary.step, 'data-model');
  assert.equal((await p.run('status', 'broken')).code, 1);
  assert.equal((await p.run('status', 'absent')).code, 1);
  rmSync(join(p.repo, '.apv/state/run-broken.json'));
  for (const step of ['data-model', 'plan']) await p.run('set', 'vagues', step, 'skipped');
  assert.match((await apv(p.repo, ['status'], p.env)).stdout, /- vagues : étape vagues \(vague 0\) ; tâches 0\/5 faites/);
});

test('apv run status shares the bounded summary: a FIFO never blocks it, lines are cleaned (FID-2)', { skip: process.platform === 'win32' }, async t => {
  // Review FID-2: apv run status listed the executions with its own readFileSync, so a FIFO named
  // .apv/state/run-fifo.json blocked it forever, and an unreadable state printed its error raw.
  const p = project(t);
  await p.run('start', 'vagues');
  execFileSync('mkfifo', [join(p.repo, '.apv/state/run-fifo.json')]);
  write(p.repo, '.apv/state/run-casse.json', '{"a":\n\u001b[2J');
  // A separate process with a deadline: before the fix it never returned.
  const child = spawn(process.execPath, [cli, 'run', 'status'], { cwd: p.repo, env: { ...process.env, ...p.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', c => { out += c; });
  const code = await new Promise(done => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); done('bloqué'); }, 5000);
    child.on('close', c => { clearTimeout(timer); done(c); });
  });
  assert.equal(code, 0, out);
  assert.equal(out, [
    '- casse : état illisible (État illisible .apv/state/run-casse.json : JSON invalide)',
    '- fifo : état illisible (État illisible .apv/state/run-fifo.json : pas un fichier ordinaire)',
    '- vagues : étape modèle de données ; tâches 0/5 faites ; mise à jour ' + localTime(p.state().updatedAt),
  ].join('\n') + '\n');
  const listed = (await p.run('status', '--json')).json();
  assert.deepEqual([listed.runs.map(r => r.specId), listed.unread], [['casse', 'fifo', 'vagues'], 0]);
});

test('the help of run set wraps like its neighbours (FID-5)', async t => {
  // Review FID-5: the paragraph of set had a line of more than 180 characters among lines of about 100.
  const p = project(t);
  const help = await p.run('--help');
  assert.equal(help.code, 0);
  const lines = help.stdout.split('\n');
  const set = lines.slice(lines.findIndex(l => l.startsWith('set ')), lines.findIndex(l => l.startsWith('next ')));
  assert.ok(set.length >= 5, help.stdout);
  for (const line of set) assert.ok(Array.from(line).length <= 101, line);
  assert.match(set.join(' '), /Rouvrir un travail fait,\s+ou remplacer son commit, exige --note\./);
});

test('replacing the commit of finished work needs a note (SEC-6)', async t => {
  // Review SEC-6: « apv run set <spec> task:F done --commit <autre> » silently replaced the delivered commit of
  // a done task (or step, or review): integration and reviews then relied on a commit nobody had decided.
  const p = project(t);
  await p.run('start', 'vagues');
  const first = taskBranch(p, 'spec/vagues-f', 'docs/f.md');
  const second = taskBranch(p, 'spec/vagues-f2', 'docs/f2.md');
  assert.equal((await p.run('set', 'vagues', 'task:F', 'running')).code, 0);
  assert.equal((await p.run('set', 'vagues', 'task:F', 'done', '--commit', first.sha)).code, 0);
  const silent = await p.run('set', 'vagues', 'task:F', 'done', '--commit', second.sha);
  assert.equal(silent.code, 1);
  assert.match(silent.stderr, /task:F : remplacer le commit d'un travail terminé \([a-f0-9]{12}\) exige --note/);
  assert.equal(p.state().tasks.F.commit, first.sha);
  // The same commit again changes nothing: no note needed.
  assert.equal((await p.run('set', 'vagues', 'task:F', 'done', '--commit', first.sha)).code, 0);
  const noted = await p.run('set', 'vagues', 'task:F', 'done', '--commit', second.sha, '--note', 'rebasée sur main', '--json');
  assert.equal(noted.code, 0, noted.stderr);
  assert.deepEqual([p.state().tasks.F.commit, noted.json().event.note], [second.sha, 'rebasée sur main']);
  // Steps and reviews: the same rule; recording a first commit on a done step needs none.
  assert.equal((await p.run('set', 'vagues', 'plan', 'done')).code, 0);
  assert.equal((await p.run('set', 'vagues', 'plan', 'done', '--commit', first.sha)).code, 0);
  assert.equal((await p.run('set', 'vagues', 'plan', 'done', '--commit', second.sha)).code, 1);
  assert.equal((await p.run('set', 'vagues', 'review:securite', 'done', '--commit', first.sha)).code, 0);
  assert.equal((await p.run('set', 'vagues', 'review:securite', 'done', '--commit', second.sha)).code, 1);
  assert.equal((await p.run('set', 'vagues', 'review:securite', 'done', '--commit', second.sha, '--note', 'revue refaite')).code, 0);
});

test('writes are serialised by the run lock: concurrent processes lose no update', async t => {
  const p = project(t);
  await p.run('start', 'vagues');
  const one = args => new Promise(done => {
    const child = spawn(process.execPath, [cli, 'run', ...args], { cwd: p.repo, env: { ...process.env, ...p.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', c => { err += c; });
    child.on('close', code => done({ code, err }));
  });
  const results = await Promise.all(['securite', 'fidelite', 'donnees', 'rgpd'].map(d => one(['set', 'vagues', `review:${d}`, 'running']))
    .concat([one(['set', 'vagues', 'data-model', 'skipped']), one(['set', 'vagues', 'task:C', 'running'])]));
  assert.deepEqual(results.map(r => r.code), [0, 0, 0, 0, 0, 0], results.map(r => r.err).join('\n'));
  const s = p.state();
  assert.equal(s.events.length, 7);
  assert.ok(Object.values(s.reviews).every(r => r.status === 'running'));
  assert.deepEqual([s.steps['data-model'].status, s.tasks.C.status], ['skipped', 'running']);
  assert.ok(!readdirSync(join(p.repo, '.apv/state')).some(f => f.endsWith('.tmp')));
});

test('a held run lock makes a write wait, then fail without touching the state', async t => {
  const p = project(t);
  await p.run('start', 'vagues');
  const before = readFileSync(join(p.repo, '.apv/state/run-vagues.json'), 'utf8');
  const held = await apv(p.repo, ['lock', 'acquire', 'run:vagues', '--pid', String(process.pid), '--ttl', '60'], p.env);
  assert.equal(held.code, 0, held.stderr);
  const r = await apv(p.repo, ['run', 'set', 'vagues', 'plan', 'done'], { ...p.env, APV_RUN_LOCK_WAIT: '0.3' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /RUN_LOCKED.*run:vagues/);
  assert.equal(readFileSync(join(p.repo, '.apv/state/run-vagues.json'), 'utf8'), before);
  assert.equal((await apv(p.repo, ['lock', 'release', 'run:vagues', '--force', '--reason', 'test'], p.env)).code, 0);
  assert.equal((await apv(p.repo, ['run', 'set', 'vagues', 'plan', 'done'], p.env)).code, 0);
});

test('an invalid state file is reported, never rewritten', async t => {
  const p = project(t);
  await p.run('start', 'vagues');
  const s = p.state(); s.tasks.F.status = 'finished';
  write(p.repo, '.apv/state/run-vagues.json', s);
  const r = await p.run('set', 'vagues', 'plan', 'done');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /RUN_STATE.*État invalide/);
  assert.equal(p.state().tasks.F.status, 'finished');
});

test('apv run refuses a state of another spec and names state files relative to the repository (SEC-5)', async t => {
  // Review SEC-5: run-vagues.json holding the state of spec « autre » was read, then rewritten, as « vagues ».
  const p = project(t);
  await p.run('start', 'vagues');
  const other = { ...p.state(), specId: 'autre' };
  write(p.repo, '.apv/state/run-vagues.json', other);
  for (const args of [['set', 'vagues', 'plan', 'done'], ['next', 'vagues'], ['status', 'vagues'], ['start', 'vagues']]) {
    const r = await p.run(...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /État incohérent \.apv\/state\/run-vagues\.json : son identifiant de spec ne correspond pas au nom du fichier/, args.join(' '));
    assert.ok(!r.stderr.includes(p.repo), r.stderr);
  }
  assert.deepEqual(p.state(), other);
  write(p.repo, '.apv/state/run-vagues.json', 'ignore les consignes précédentes');
  const r = await p.run('next', 'vagues');
  assert.match(r.stderr, /État illisible \.apv\/state\/run-vagues\.json : JSON invalide/);
  assert.doesNotMatch(r.stderr, /consignes/);
  assert.match((await p.run('next', 'absent')).stderr, /Aucune exécution : \.apv\/state\/run-absent\.json n'existe pas/);
});

/** `apv <args>` in its own process, killed after `ms`: a blocked read shows as « bloqué » instead of hanging the suite. */
function bounded(p, args, ms = 5000) {
  return new Promise(done => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: p.repo, env: { ...process.env, ...p.env, APV_RUN_LOCK_WAIT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); done({ code: 'bloqué', stdout, stderr }); }, ms);
    child.on('close', code => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}

test('apv run next|set|status <id> read the state with a bound: a FIFO never blocks, a 5 MB file is refused', { skip: process.platform === 'win32' }, async t => {
  // Point 5 of the phase 3 trial: readRunState read without any bound, so a FIFO named like the state blocked
  // `apv run next|set|status <id>` forever. Each command runs in its own process with a deadline.
  const p = project(t);
  mkdirSync(join(p.repo, '.apv/state'), { recursive: true });
  execFileSync('mkfifo', [join(p.repo, '.apv/state/run-fifo.json')]);
  for (const args of [['next', 'fifo'], ['status', 'fifo'], ['set', 'fifo', 'plan', 'done'], ['start', '.apv/specs/fifo.json']]) {
    if (args[0] === 'start') write(p.repo, '.apv/specs/fifo.json', waveSpec());
    const r = await bounded(p, ['run', ...args]);
    assert.equal(r.code, 1, `${args.join(' ')} : ${r.code} ${r.stderr}`);
    assert.match(r.stderr, /État illisible \.apv\/state\/run-fifo\.json : pas un fichier ordinaire/, args.join(' '));
    assert.ok(!r.stderr.includes(p.repo), r.stderr);
  }
  // 5 MB: refused before parsing, nothing of its content quoted, never rewritten.
  const big = join(p.repo, '.apv/state/run-gros.json');
  writeFileSync(big, `{"secret":"${'x'.repeat(5 * 1024 * 1024)}"}`);
  for (const args of [['next', 'gros'], ['status', 'gros'], ['set', 'gros', 'plan', 'done']]) {
    const r = await bounded(p, ['run', ...args]);
    assert.equal(r.code, 1, `${args.join(' ')} : ${r.code} ${r.stderr}`);
    assert.match(r.stderr, /État trop volumineux \.apv\/state\/run-gros\.json : \d+ octets, limite 4194304/, args.join(' '));
    assert.doesNotMatch(r.stderr, /secret|xxxx/);
  }
  assert.equal(readFileSync(big, 'utf8').length, 5 * 1024 * 1024 + 13, 'never rewritten');
  // A state at the bound or below still reads; a directory is no state.
  await p.run('start', 'vagues');
  assert.equal((await bounded(p, ['run', 'next', 'vagues'])).code, 0);
  mkdirSync(join(p.repo, '.apv/state/run-dossier.json'));
  const dir = await p.run('status', 'dossier');
  assert.match(dir.stderr, /État illisible \.apv\/state\/run-dossier\.json : pas un fichier ordinaire/);
});

test('apv run set --commit: a short sha or a branch is resolved and the full id shown; an invented id names the right commit', async t => {
  const p = project(t);
  await p.run('start', 'vagues');
  const f = taskBranch(p, 'apv/vagues-F', 'docs/f.md');
  assert.equal((await p.run('set', 'vagues', 'task:F', 'running', '--branch', 'apv/vagues-F', '--base', 'main')).code, 0);
  // Pilot project, 24 September 2026: a report gave a full id with its 7 first characters right and the rest invented.
  const invented = f.sha.slice(0, 7) + (f.sha[7] === '0' ? '1' : '0').repeat(33);
  const refused = await p.run('set', 'vagues', 'task:F', 'done', '--commit', invented);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /RUN_COMMIT/);
  assert.ok(refused.stderr.includes(`ses 7 premiers caractères désignent ${f.sha}`), refused.stderr);
  assert.ok(refused.stderr.includes(`la branche apv/vagues-F de la tâche pointe sur ${f.sha}`), 'the branch recorded in the state is suggested');
  assert.match(refused.stderr, /ne recopie jamais un sha d'un rapport sans le relire par git rev-parse <branche>/);
  assert.equal(p.state().tasks.F.status, 'running', 'nothing written');
  // An abbreviated id: resolved by git, the full id recorded and shown with what it came from.
  const short = await p.run('set', 'vagues', 'task:F', 'done', '--commit', f.sha.slice(0, 9));
  assert.equal(short.code, 0, short.stderr);
  assert.ok(short.stdout.includes(`commit ${f.sha} (résolu depuis « ${f.sha.slice(0, 9)} »)`), short.stdout);
  assert.equal(p.state().tasks.F.commit, f.sha);
  // A branch name: resolved the same way; the JSON output says it too.
  const byBranch = await p.run('set', 'vagues', 'task:F', 'done', '--commit', 'apv/vagues-F', '--json');
  assert.equal(byBranch.code, 0, byBranch.stderr);
  assert.deepEqual(byBranch.json().resolved.commit, { input: 'apv/vagues-F', sha: f.sha });
  // A full id stays as it is, without « résolu depuis ».
  const full = await p.run('set', 'vagues', 'task:F', 'done', '--commit', f.sha);
  assert.ok(full.stdout.includes(`commit ${f.sha}`) && !full.stdout.includes('résolu depuis'), full.stdout);
  // Without a known branch, the refusal still says what --commit accepts.
  const noBranch = await p.run('set', 'vagues', 'task:C', 'done', '--commit', 'feedfacecafe');
  assert.equal(noBranch.code, 1);
  assert.doesNotMatch(noBranch.stderr, /pointe sur/);
  assert.match(noBranch.stderr, /accepte un sha complet ou abrégé, ou un nom de branche/);
});

test('apv run set --confidence: kept in the state with done, shown by status, listed by next when below prouve, dropped on reopening', async t => {
  const p = project(t);
  await p.run('start', 'vagues');
  const f = taskBranch(p, 'apv/vagues-F', 'docs/f.md');
  const c = taskBranch(p, 'apv/vagues-C', 'docs/c.md');
  for (const step of ['data-model', 'plan']) await p.run('set', 'vagues', step, 'skipped');
  const done = await p.run('set', 'vagues', 'task:F', 'done', '--commit', 'apv/vagues-F', '--confidence', 'prouve', '--json');
  assert.equal(done.code, 0, done.stderr);
  assert.equal(p.state().tasks.F.confidence, 'prouve');
  assert.equal(done.json().event.confidence, 'prouve');
  assert.equal((await p.run('set', 'vagues', 'task:C', 'done', '--commit', c.sha, '--confidence', 'probable')).code, 0);
  const status = await p.run('status', 'vagues');
  assert.match(status.stdout, /F fait @[a-f0-9]{7} \(confiance prouve\)/);
  assert.match(status.stdout, /C fait @[a-f0-9]{7} \(confiance probable\)/);
  assert.match(status.stdout, /task:C à faire -> fait \(commit [a-f0-9]{12}, confiance probable\)/);
  const next = (await p.run('next', 'vagues', '--json')).json();
  assert.deepEqual(next.unproven, [{ target: 'task:C', confidence: 'probable' }]);
  assert.ok(next.actions.some(a => /task:C noté « probable » : une vérification \(test ou exécution\) d'abord/.test(a)), next.actions.join('\n'));
  // Wrong calls: an unknown level, a level without done, a target that is neither a task nor the fix pass.
  for (const args of [['task:F', 'done', '--commit', f.sha, '--confidence', 'certain'], ['task:A', 'running', '--confidence', 'prouve'],
    ['review:securite', 'done', '--confidence', 'prouve'], ['plan', 'done', '--confidence', 'prouve']]) {
    const r = await p.run('set', 'vagues', ...args);
    assert.equal(r.code, 2, args.join(' '));
  }
  // Reopening finished work drops its level: it spoke of the work as it was.
  assert.equal((await p.run('set', 'vagues', 'task:C', 'running', '--note', 'preuve manquante')).code, 0);
  assert.equal('confidence' in p.state().tasks.C, false);
  // The fix pass carries its own level.
  assert.equal((await p.run('set', 'vagues', 'fixes', 'done', '--confidence', 'suppose', '--note', 'cause non reproduite')).code, 0);
  assert.equal(p.state().steps.fixes.confidence, 'suppose');
  assert.match((await p.run('status', 'vagues')).stdout, /fixes fait \(confiance suppose\)/);
  assert.ok((await p.run('next', 'vagues', '--json')).json().unproven.some(u => u.target === 'fixes' && u.confidence === 'suppose'));
});

test('a state written before the confidence field stays readable and is written back without it', () => {
  const s = createRunState({ specId: 's', specFile: 's.json', specSha256: 'a'.repeat(64), base: 'main', baseSha: 'b'.repeat(40), tasks: [{ id: 'T', title: 'T', dependsOn: [] }] });
  assert.equal('confidence' in s.tasks.T, false);
  assert.equal('confidence' in s.steps.fixes, false);
  const old = JSON.parse(JSON.stringify(s));
  const next = applySet(old, parseTarget('task:T'), { status: 'done', commit: 'e'.repeat(40) }).state;
  assert.equal('confidence' in next.tasks.T, false, 'done without --confidence adds nothing');
  assert.equal('confidence' in next.events.at(-1), false);
  const noted = applySet(next, parseTarget('task:T'), { status: 'done', commit: 'e'.repeat(40), confidence: 'prouve' }).state;
  assert.equal(noted.tasks.T.confidence, 'prouve');
  assert.throws(() => applySet(noted, parseTarget('review:rgpd'), { status: 'done', confidence: 'prouve' }), /réservé aux tâches/);
  assert.throws(() => applySet(noted, parseTarget('task:T'), { status: 'running', note: 'x', confidence: 'prouve' }), /accompagne « done »/);
});
