import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { applySet, computeNext, computeWaves, createRunState, parseTarget } from '../dist/run/state.js';

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

test('waves: foundations alone in wave 0, then topological layers, in spec order', () => {
  const t = (id, dependsOn = []) => ({ id, title: id, dependsOn });
  assert.deepEqual(computeWaves([t('F'), t('A', ['F']), t('B', ['F']), t('C'), t('D', ['A', 'B'])]),
    [{ index: 0, foundation: true, tasks: ['F'] }, { index: 1, foundation: false, tasks: ['A', 'B', 'C'] }, { index: 2, foundation: false, tasks: ['D'] }]);
  assert.deepEqual(computeWaves([t('A'), t('B'), t('C')]), [{ index: 0, foundation: false, tasks: ['A', 'B', 'C'] }]);
  assert.deepEqual(computeWaves([t('C', ['B']), t('B', ['A']), t('A')]),
    [{ index: 0, foundation: true, tasks: ['A'] }, { index: 1, foundation: false, tasks: ['B'] }, { index: 2, foundation: false, tasks: ['C'] }]);
  assert.deepEqual(computeWaves([t('A'), t('B', ['A']), t('C', ['A', 'B'])]).map(w => w.tasks), [['A'], ['B'], ['C']]);
  assert.deepEqual(computeWaves([]), []);
  assert.throws(() => computeWaves([t('A', ['B']), t('B', ['A'])]), /Cycle/);
  assert.throws(() => computeWaves([t('A', ['Z'])]), /Dépendance inconnue/);
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
  assert.deepEqual(s.waves.map(w => [w.index, w.foundation, w.tasks]), [[0, true, ['F']], [1, false, ['A', 'B', 'C']], [2, false, ['D']]]);
  assert.deepEqual(s.tasks.D, { title: 'Tâche D', dependsOn: ['A', 'B'], wave: 2, status: 'pending', branch: null, worktree: null, agentId: null,
    base: null, commit: null, note: null, updatedAt: null });
  assert.deepEqual(Object.keys(s.reviews), ['securite', 'fidelite', 'donnees', 'rgpd']);
  assert.deepEqual(s.reviews.rgpd, { status: 'pending', findings: null, note: null, updatedAt: null });
  assert.equal(s.events.length, 1);
  assert.deepEqual(readdirSync(join(p.repo, '.apv/state')), ['run-vagues.json'], 'no temporary file left');
  const again = await p.run('start', 'vagues');
  assert.equal(again.code, 1);
  assert.match(again.stderr, /RUN_EXISTS.*apv run next vagues/);
  const human = await p.run('status', 'vagues');
  assert.match(human.stdout, /Vague 0 \(fondations\) : F à faire/);
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
  assert.equal((await p.run('set', 'vagues', 'task:A', 'running')).code, 0, 'F done: A may start');
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
  assert.deepEqual(events.at(-1), { at: events.at(-1).at, target: 'review:securite', from: 'pending', to: 'done', note: 'corrections-vagues.md' });
  // Wrong calls: exit 2.
  for (const args of [['task:Z', 'done'], ['review:qa', 'done'], ['plan', 'finished'], ['plan', 'done', '--commit', 'main'], ['task:A', 'done', '--findings', '1'],
    ['review:rgpd', 'done', '--findings', 'x'], ['plan'], ['plan', 'done', 'extra']]) {
    assert.equal((await p.run('set', 'vagues', ...args)).code, args[0] === 'task:Z' ? 1 : 2, args.join(' '));
  }
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
  assert.match(next.actions.join('\n'), /lancer 1 tâche\(s\) prête\(s\) de la vague 0, fondations, un seul agent : F/);
  assert.match(next.actions.join('\n'), /prêtes mais d'une vague suivante : C \(vague 1\)/);
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

test('next: a running task whose branch has no commit of its own after its start is to relaunch', () => {
  const state = createRunState({ specId: 's', specFile: 's.json', specSha256: 'a'.repeat(64), base: 'main', baseSha: 'b'.repeat(40),
    tasks: [{ id: 'T', title: 'T', dependsOn: [] }] });
  const running = applySet(state, { kind: 'task', id: 'T' }, { status: 'running', branch: 'spec/t', base: 'c'.repeat(40) }).state;
  const probe = (count, head = 'd'.repeat(40)) => ({ exists: () => true, resolve: () => head, countAfter: (base) => { assert.equal(base, 'c'.repeat(40)); return count; } });
  assert.equal(computeNext(running, probe(0)).relaunch[0].reason, `aucun commit après la base ${'c'.repeat(12)}`);
  assert.equal(computeNext(running, probe(2)).resume[0].commitsAfterBase, 2);
  assert.equal(computeNext(running, probe(2, null)).relaunch[0].reason, 'branche introuvable : spec/t');
  const bare = applySet(state, { kind: 'task', id: 'T' }, { status: 'running' }).state;
  assert.equal(computeNext(bare, probe(1)).relaunch[0].reason, 'ni branche ni worktree enregistrés');
});

test('next walks the steps: integration, reviews to launch, then the end', () => {
  let s = createRunState({ specId: 's', specFile: 's.json', specSha256: 'a'.repeat(64), base: 'main', baseSha: 'b'.repeat(40), tasks: [{ id: 'T', title: 'T', dependsOn: [] }] });
  const set = (target, status, extra = {}) => { s = applySet(s, parseTarget(target), { status, ...extra }).state; };
  const probe = { exists: () => true, resolve: () => null, countAfter: () => null };
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
