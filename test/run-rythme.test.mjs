import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { applyPause, applyResume, applySet, computeNext, createRunState, describeEvent, parseTarget, summarize, summaryLine } from '../dist/run/state.js';
import { localTime, parseUntil } from '../dist/domain/time.js';
import { configIssues, fullSuiteMode } from '../dist/config/load.js';

// Times are shown in local time: a fixed zone keeps the expected lines stable (UTC+2 in September).
process.env.TZ = 'Europe/Paris';

test('localTime shows a UTC date in the local zone with its offset; the files keep UTC', () => {
  assert.equal(localTime('2026-09-24T16:22:05.000Z'), '2026-09-24 18:22 UTC+2');
  assert.equal(localTime('2026-12-24T16:22:05.000Z'), '2026-12-24 17:22 UTC+1');
  assert.equal(localTime('2026-09-24T16:22:05.000Z', { style: 'time' }), '18:22');
  assert.equal(localTime('2026-09-24T22:30:00.000Z'), '2026-09-25 00:30 UTC+2');
  assert.equal(localTime('2026-09-24T16:22:05.000Z', { timeZone: 'UTC' }), '2026-09-24 16:22 UTC');
  assert.equal(localTime('2026-09-24T16:22:05.000Z', { timeZone: 'Asia/Kolkata' }), '2026-09-24 21:52 UTC+5:30');
  assert.equal(localTime('2026-09-24T16:22:05.000Z', { timeZone: 'America/New_York' }), '2026-09-24 12:22 UTC-4');
  assert.equal(localTime(Date.parse('2026-09-24T16:22:05.000Z')), '2026-09-24 18:22 UTC+2');
  // Not a date: shown as it is, never guessed.
  assert.equal(localTime('bientôt'), 'bientôt');
});

test('parseUntil: HH:MM is the next local occurrence, an ISO date needs its zone', () => {
  const now = new Date('2026-09-24T16:00:00.000Z'); // 18:00 in Paris
  assert.equal(parseUntil('20:30', now).toISOString(), '2026-09-24T18:30:00.000Z');
  assert.equal(parseUntil('9:05', now).toISOString(), '2026-09-25T07:05:00.000Z', 'passed today: tomorrow');
  assert.equal(parseUntil('18:00', now).toISOString(), '2026-09-25T16:00:00.000Z', 'now is not in the future');
  assert.equal(parseUntil('2026-09-24T20:30+02:00', now).toISOString(), '2026-09-24T18:30:00.000Z');
  assert.equal(parseUntil('2026-09-24T18:30:00Z', now).toISOString(), '2026-09-24T18:30:00.000Z');
  for (const bad of ['24:00', '7h', '2026-09-24T18:30', 'demain', '']) assert.equal(parseUntil(bad, now), null, bad);
});

test('run.fullSuite: final by default, each-integration on request, anything else refused', () => {
  assert.equal(fullSuiteMode(configIssues({}).config), 'final');
  assert.equal(fullSuiteMode(configIssues({ run: {} }).config), 'final');
  assert.equal(fullSuiteMode(configIssues({ run: { fullSuite: 'each-integration' } }).config), 'each-integration');
  assert.equal(configIssues({ run: {} }).ignored.length, 0, 'run is a read section');
  assert.match(configIssues({ run: { fullSuite: 'never' } }).issues[0].message, /fullSuite: expected final\|each-integration/);
  assert.match(configIssues({ run: { fullSuite: 'final', skip: true } }).issues[0].message, /unknown property skip/);
});

const probe = (head = null) => ({ exists: () => true, resolve: () => head, countAfter: () => null, isAncestor: () => true });
function spec(tasks = [{ id: 'A', title: 'A', dependsOn: [] }, { id: 'B', title: 'B', dependsOn: ['A'] }]) {
  return createRunState({ specId: 's', specFile: 's.json', specSha256: 'a'.repeat(64), base: 'main', baseSha: 'b'.repeat(40), tasks,
    now: new Date('2026-09-24T08:00:00.000Z') });
}

test('next: the verification level of each step follows run.fullSuite; targeted tests start at the last full suite', () => {
  let s = spec();
  const set = (target, status, extra = {}) => { s = applySet(s, parseTarget(target), { status, now: new Date('2026-09-24T09:00:00.000Z'), ...extra }).state; };
  set('data-model', 'skipped'); set('plan', 'done');
  set('task:A', 'done', { commit: 'c'.repeat(40) });
  // A is done, B waits for its integration: an intermediate integration, at the task level in `final`.
  let next = computeNext(s, { ...probe('d'.repeat(40)), isAncestor: () => false });
  assert.deepEqual([next.step, next.suite.mode, next.suite.level, next.suite.targetBase], ['waves', 'final', 'task', 'b'.repeat(40)]);
  assert.match(next.suite.targetBaseWhere, /base de l'exécution .* aucune suite complète depuis/);
  assert.match(next.actions.join('\n'), /intégration intermédiaire \(il reste des tâches\), niveau tâche : apv gates run --stage task --base b{12} .* apv gates verify --commit <tête> --stage task --base b{12} à 0 ; la suite complète vient à la dernière intégration/);
  const each = computeNext(s, { ...probe('d'.repeat(40)), isAncestor: () => false }, { fullSuite: 'each-integration' });
  assert.deepEqual([each.suite.level, each.suite.targetBase], ['full', 'd'.repeat(40)]);
  assert.match(each.actions.join('\n'), /intégration \(run\.fullSuite = each-integration\), suite complète : apv gates run --stage full/);

  // Every task done: the last integration takes the full suite, whatever the mode.
  set('task:B', 'running', { integration: { head: 'c'.repeat(40), where: 'apv/s', integrated: () => true } }); set('task:B', 'done', { commit: 'e'.repeat(40) });
  next = computeNext(s, probe('e'.repeat(40)));
  assert.deepEqual([next.step, next.suite.level], ['integration', 'full']);
  assert.match(next.actions.join('\n'), /dernière intégration \(toutes les tâches\), suite complète : apv gates run --stage full .* avant les revues ; garder ce worktree et ses reçus jusqu'à la livraison/);

  // After it, the targeted tests of the fixes start at the head it proved; the fixes stay at the task level.
  set('integration', 'done', { commit: 'e'.repeat(40) });
  for (const r of ['securite', 'fidelite', 'donnees', 'rgpd']) set(`review:${r}`, 'done');
  set('reviews', 'done');
  next = computeNext(s, probe('e'.repeat(40)));
  assert.deepEqual([next.step, next.suite.level, next.suite.targetBase], ['fixes', 'task', 'e'.repeat(40)]);
  assert.match(next.actions.join('\n'), /corrections, niveau tâche : apv gates run --stage task --base e{12} .* et le test qui prouve chaque correction ; la suite complète vient une fois, à la livraison/);
  assert.equal(computeNext(s, probe('e'.repeat(40)), { fullSuite: 'each-integration' }).suite.level, 'full');

  // The delivery: the full suite on the exact head, not run twice when it is already proven there.
  set('fixes', 'skipped');
  next = computeNext(s, probe('e'.repeat(40)));
  assert.deepEqual([next.step, next.suite.level], ['delivery', 'full']);
  assert.match(next.actions.join('\n'), /livraison : apv gates verify --commit <tête exacte de apv\/s> ; à 0 .* pas de nouvelle suite ; sinon apv gates run --stage full puis apv gates verify à 0 avant de pousser/);
});

test('pause and resume are written in the state and journaled; any transition ends a pause left open', () => {
  let s = spec();
  const at = (iso) => new Date(iso);
  const paused = applyPause(s, { until: at('2026-09-24T18:30:00.000Z'), note: 'session à 95 %', now: at('2026-09-24T16:00:00.000Z') });
  s = paused.state;
  assert.deepEqual(s.pause, { since: '2026-09-24T16:00:00.000Z', until: '2026-09-24T18:30:00.000Z', note: 'session à 95 %' });
  assert.deepEqual(paused.event, { at: '2026-09-24T16:00:00.000Z', target: 'pause', from: 'running', to: 'pending', until: '2026-09-24T18:30:00.000Z', note: 'session à 95 %' });
  assert.equal(describeEvent(paused.event), "2026-09-24 18:00 UTC+2 pause quota jusqu'à 2026-09-24 20:30 UTC+2 : session à 95 %");
  assert.match(summaryLine(summarize(s, 'f')), / ; en pause \(quota\) jusqu'à 2026-09-24 20:30 UTC\+2 ; mise à jour 2026-09-24 18:00 UTC\+2$/);
  assert.match(computeNext(s, probe()).actions[0], /^exécution en pause \(quota\) depuis 2026-09-24 18:00 UTC\+2 jusqu'à 2026-09-24 20:30 UTC\+2 \(session à 95 %\) : à la reprise, apv run resume s$/);
  assert.equal(computeNext(s, probe()).pause.until, '2026-09-24T18:30:00.000Z');

  // A second pause extends the first, keeping its start and its note.
  s = applyPause(s, { until: at('2026-09-24T19:00:00.000Z'), now: at('2026-09-24T18:20:00.000Z') }).state;
  assert.deepEqual(s.pause, { since: '2026-09-24T16:00:00.000Z', until: '2026-09-24T19:00:00.000Z', note: 'session à 95 %' });
  assert.throws(() => applyPause(s, { until: at('2026-09-24T10:00:00.000Z'), now: at('2026-09-24T18:20:00.000Z') }), /Fin de pause dans le passé/);

  const resumed = applyResume(s, { now: at('2026-09-24T19:01:00.000Z') });
  assert.ok(!('pause' in resumed.state), 'no pause field once resumed: the state reads as before');
  assert.equal(describeEvent(resumed.event), '2026-09-24 21:01 UTC+2 reprise : reprise');
  assert.throws(() => applyResume(resumed.state), /n'est pas en pause/);

  // A pause left open ends with the next transition, journaled before it.
  s = applyPause(resumed.state, { until: at('2026-09-24T22:00:00.000Z'), now: at('2026-09-24T20:00:00.000Z') }).state;
  s = applySet(s, parseTarget('data-model'), { status: 'skipped', now: at('2026-09-24T20:30:00.000Z') }).state;
  assert.ok(!('pause' in s));
  assert.deepEqual(s.events.slice(-2).map(e => [e.target, e.to, e.note ?? null]),
    [['pause', 'running', 'reprise (première transition après la pause : data-model)'], ['data-model', 'skipped', null]]);

  // A finished execution has nothing to pause.
  let done = spec([{ id: 'A', title: 'A', dependsOn: [] }]);
  for (const [target, status, extra] of [['data-model', 'skipped'], ['plan', 'done'], ['task:A', 'done', { commit: 'c'.repeat(40) }], ['integration', 'done'],
    ['reviews', 'done'], ['fixes', 'skipped'], ['delivery', 'done']]) done = applySet(done, parseTarget(target), { status, ...(extra ?? {}) }).state;
  assert.throws(() => applyPause(done, { until: at('2099-01-01T00:00:00.000Z') }), /est terminée/);
});

test('apv run pause, resume, status and next: the pause is visible, times are local, the rhythm comes from the configuration', async t => {
  const f = fixture(t);
  const task = (id, dependsOn) => ({ id, title: `Tâche ${id}`, description: `Écrire docs/${id}.md.`, acceptanceIds: [`AC-${id}`],
    allowedPaths: [`docs/${id.toLowerCase()}.md`], dependsOn, minimumLane: 'standard' });
  write(f.repo, '.apv/specs/rythme.json', { title: 'Rythme', problem: 'La documentation doit être écrite en deux parties.', scope: ['Documentation'], outOfScope: [],
    acceptance: ['A', 'B'].map(id => ({ id: `AC-${id}`, description: `Partie ${id} écrite.`, verification: `Lire docs/${id}.md.` })),
    decisions: [], questions: [], tasks: [task('A', []), task('B', ['A'])], minimumLane: 'standard' });
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'spec');
  const env = { APV_LOCK_DIR: join(f.root, 'locks'), APV_LOCK_POLL_MS: '20' };
  const run = (...args) => apv(f.repo, ['run', ...args], env);
  const state = () => JSON.parse(readFileSync(join(f.repo, '.apv/state/run-rythme.json'), 'utf8'));
  assert.equal((await run('start', 'rythme')).code, 0);

  // Wrong calls.
  for (const [args, message] of [[['pause', 'rythme'], /run pause attend --until/], [['pause', 'rythme', '--until', '25:00'], /--until invalide : 25:00/],
    [['resume', 'rythme', '--until', '10:00'], /--until/], [['pause', 'rythme', '--until', '10:00', '--commit', 'HEAD'], /--commit/],
    [['set', 'rythme', 'plan', 'running', '--until', '10:00'], /--until/]]) {
    const r = await run(...args);
    assert.equal(r.code, 2, args.join(' ')); assert.match(r.stderr, message);
  }
  assert.equal((await run('resume', 'rythme')).code, 1);

  const until = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const paused = await run('pause', 'rythme', '--until', until, '--note', 'semaine à 95 %');
  assert.equal(paused.code, 0, paused.stderr);
  assert.equal(paused.stdout, `rythme : ${describeEvent(state().events.at(-1))}\n`);
  assert.match(paused.stdout, /pause quota jusqu'à \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\+[12] : semaine à 95 %/);
  assert.equal(state().pause.until, until);
  assert.match(state().pause.since, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'the state keeps ISO dates in UTC');

  const detail = await run('status', 'rythme');
  assert.match(detail.stdout, /Créée \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\+[12] ; mise à jour .* \(heure locale, Europe\/Paris\)/);
  assert.match(detail.stdout, /En pause \(quota\) depuis .* jusqu'à .* : semaine à 95 %/);
  assert.match(detail.stdout, /Événements : 2 ; derniers :\n- .* run - -> en cours : exécution créée .*\n- .* pause quota jusqu'à .* : semaine à 95 %/);
  assert.match((await run('status')).stdout, /- rythme : .* ; en pause \(quota\) jusqu'à .* ; mise à jour /);
  assert.match((await apv(f.repo, ['status'], env)).stdout, /- rythme : .* en pause \(quota\) jusqu'à /);
  const next = await run('next', 'rythme');
  assert.match(next.stdout, /Suite complète \(run\.fullSuite = final\) : à la dernière intégration et à la livraison ; entre les deux, contrôles de tâche et tests ciblés ; base des tests ciblés : base de l'exécution/);
  assert.match(next.stdout, /En pause \(quota\) depuis .* jusqu'à .* : semaine à 95 %/);
  assert.match(next.stdout, /- exécution en pause \(quota\) .* à la reprise, apv run resume rythme/);
  assert.equal((await run('next', 'rythme', '--json')).json().pause.note, 'semaine à 95 %');

  const resumed = await run('resume', 'rythme', '--json');
  assert.equal(resumed.code, 0);
  assert.deepEqual([resumed.json().action, resumed.json().event.target, resumed.json().event.to], ['resume', 'pause', 'running']);
  assert.ok(!('pause' in state()));
  assert.doesNotMatch((await run('status', 'rythme')).stdout, /En pause/);

  // The rhythm is read from .apv/config.json; an invalid configuration falls back on final, said.
  write(f.repo, '.apv/config.json', { run: { fullSuite: 'each-integration' } });
  let json = (await run('next', 'rythme', '--json')).json();
  assert.equal(json.suite.mode, 'each-integration');
  assert.match((await run('next', 'rythme')).stdout, /Suite complète \(run\.fullSuite = each-integration\) : à chaque intégration, corrections comprises, et à la livraison/);
  write(f.repo, '.apv/config.json', { run: { fullSuite: 'jamais' } });
  json = (await run('next', 'rythme', '--json')).json();
  assert.equal(json.suite.mode, 'final');
  assert.match(json.actions[0], /^configuration illisible \(.*\) : rythme de la suite complète par défaut, final$/);
});
