import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apv } from './cli-helpers.mjs';
import { git } from './helpers.mjs';
import { applySet, createRunState, parseTarget, writeRunState } from '../dist/run/state.js';
import { criticalPath, deliveredPullRequest, duration, gapPercent, measureRun, median, runBaseline, taskTimings } from '../dist/metrics/run.js';
import { lotCommits, measurePr, parsePrData, parseStackLog, prBaseline } from '../dist/metrics/pr.js';

process.env.TZ = 'Europe/Paris';

const at = minutes => new Date(Date.parse('2026-10-04T00:00:00.000Z') + minutes * 60_000);
const integration = { head: 'c'.repeat(40), where: 'apv/demo', integrated: () => true };
const set = (s, target, status, minutes, extra = {}) => applySet(s, parseTarget(target), { status, now: at(minutes), integration, ...extra }).state;
const sha = n => String(n).repeat(40).slice(0, 40);

/** A spec of 4 tasks: F (foundation), A and B on F, C on A and B; created at minute 0. */
function demoState(specId = 'demo', base = sha(9)) {
  const tasks = [{ id: 'F', title: 'Fondation', dependsOn: [] }, { id: 'A', title: 'A', dependsOn: ['F'] }, { id: 'B', title: 'B', dependsOn: ['F'] },
    { id: 'C', title: 'C', dependsOn: ['A', 'B'] }];
  return createRunState({ specId, specFile: `.apv/specs/${specId}.json`, specSha256: 'a'.repeat(64), base: 'main', baseSha: base, tasks, now: at(0) });
}

/** The demo delivered: model 10 min, plan 20, F 30 min, A 10 and B 40 in parallel, C 20, reviews, one fix pass, delivery. */
function delivered(specId = 'demo', base = sha(9), commit = sha(1), note = 'PR #42 https://github.com/o/r/pull/42') {
  let s = demoState(specId, base);
  s = set(s, 'data-model', 'running', 1); s = set(s, 'data-model', 'done', 10);
  s = set(s, 'plan', 'running', 10); s = set(s, 'plan', 'done', 30);
  s = set(s, 'task:F', 'running', 31); s = set(s, 'task:F', 'done', 61, { commit });
  s = set(s, 'task:A', 'running', 62); s = set(s, 'task:B', 'running', 62);
  s = set(s, 'task:A', 'done', 72, { commit }); s = set(s, 'task:B', 'done', 102, { commit });
  s = set(s, 'task:C', 'running', 110); s = set(s, 'task:C', 'done', 130, { commit });
  s = set(s, 'integration', 'running', 61); s = set(s, 'integration', 'done', 140, { commit });
  for (const d of ['securite', 'fidelite', 'donnees']) s = set(s, `review:${d}`, 'running', 141);
  s = set(s, 'review:rgpd', 'skipped', 141, { note: 'aucune donnée personnelle' });
  for (const d of ['securite', 'fidelite', 'donnees']) s = set(s, `review:${d}`, 'done', 170, { findings: 1 });
  s = set(s, 'reviews', 'done', 171);
  s = set(s, 'fixes', 'running', 172); s = set(s, 'fixes', 'done', 200, { commit });
  s = set(s, 'delivery', 'running', 201); s = set(s, 'delivery', 'done', 240, { note });
  return s;
}

test('metrics: phases are chained milestone to milestone and add up to the end-to-end time', () => {
  const m = measureRun({ state: delivered(), source: 'x', pr: { number: 42, url: null, createdAt: null, mergedAt: at(300).toISOString(), source: 't' } });
  assert.deepEqual(m.phases.map(p => [p.phase, p.ms / 60_000, p.status]), [
    ['data-model', 10, 'done'], ['plan', 20, 'done'], ['code', 100, 'done'], ['integration', 10, 'done'], ['reviews', 31, 'done'],
    ['fixes', 29, 'done'], ['delivery', 40, 'done'], ['merge-wait', 60, 'done']]);
  assert.equal(m.totalMs, 300 * 60_000);
  assert.equal(m.phases.reduce((t, p) => t + p.ms, 0), m.totalMs);
  assert.equal(m.end.kind, 'merge');
  assert.equal(m.finished, true);
  assert.equal(m.fixPasses, 1);
  assert.deepEqual(m.reviews.map(r => [r.domain, r.status, r.launches]), [['securite', 'done', 1], ['fidelite', 'done', 1], ['donnees', 'done', 1], ['rgpd', 'skipped', 0]]);
  assert.equal(m.contestations, null, 'not measured before phase 5');
});

test('metrics: without a merge the end is the delivery, and an unfinished step leaves the next phases unmeasured', () => {
  const m = measureRun({ state: delivered(), source: 'x' });
  assert.equal(m.end.kind, 'delivery');
  assert.equal(m.finished, false);
  assert.equal(m.phases.at(-1).status, 'running');
  let s = demoState();
  s = set(s, 'data-model', 'running', 1); s = set(s, 'data-model', 'done', 10); s = set(s, 'plan', 'running', 10);
  const open = measureRun({ state: s, source: 'x' });
  assert.deepEqual(open.phases.map(p => p.status), ['done', 'running', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
  assert.equal(open.phases[1].ms, null);
  assert.equal(open.end.kind, 'last-event');
});

test('metrics: the critical path is the longest chain by measured duration; a shorter parallel task adds nothing', () => {
  const cp = criticalPath(taskTimings(delivered()));
  assert.deepEqual(cp.chain, ['F', 'B', 'C'], 'B (40 min) gates C, not A (10 min)');
  assert.equal(cp.workMs, 90 * 60_000);
  assert.equal(cp.spanMs, 99 * 60_000);
  assert.equal(cp.waitMs, 9 * 60_000);
  assert.equal(cp.complete, true);
  let s = demoState();
  s = set(s, 'task:F', 'running', 1); s = set(s, 'task:F', 'done', 11, { commit: sha(1) }); s = set(s, 'task:A', 'running', 12);
  const partial = criticalPath(taskTimings(s));
  assert.deepEqual(partial.chain, ['F']);
  assert.equal(partial.complete, false, 'a running task: the chain is not final');
});

test('metrics: a relaunched task counts its departures and is measured from its first start', () => {
  let s = demoState();
  s = set(s, 'task:F', 'running', 0); s = set(s, 'task:F', 'failed', 5, { note: 'agent arrêté' }); s = set(s, 'task:F', 'running', 10);
  s = set(s, 'task:F', 'done', 30, { commit: sha(1) });
  const f = taskTimings(s).find(t => t.id === 'F');
  assert.equal(f.starts, 2);
  assert.equal(f.ms, 30 * 60_000);
});

test('metrics: the delivered pull request comes from an address or « PR #n », never from an issue number', () => {
  assert.equal(deliveredPullRequest(delivered()), 42);
  assert.equal(deliveredPullRequest(delivered('demo', sha(9), sha(1), 'livrée, PR #7')), 7);
  assert.equal(deliveredPullRequest(delivered('demo', sha(9), sha(1), 'besoin #90 couvert')), null);
});

test('metrics: the base is the median of the last three merged executions created before the one compared', () => {
  const run = (specId, created, total, finished = true) => ({ specId, createdAt: at(created).toISOString(), totalMs: total, finished, criticalPath: { workMs: total / 2, spanMs: total } });
  const all = [run('a', 0, 100), run('b', 10, 400), run('c', 20, 200), run('d', 30, 300), run('ouverte', 35, 1, false), run('cible', 40, 250), run('apres', 50, 9)];
  const base = runBaseline(all, all.find(m => m.specId === 'cible'));
  assert.deepEqual(base.specs, ['d', 'c', 'b'], 'unmerged, later and the target itself are left out');
  assert.equal(base.totalMs, 300);
  assert.equal(gapPercent(250, base.totalMs), -17);
  assert.equal(gapPercent(250, null), null);
  assert.equal(median([1, 2, 3, 10]), 3);
  assert.equal(median([]), null);
  assert.equal(duration(65 * 60_000), '1 h 05 min');
  assert.equal(duration(36_000), '36 s');
  assert.equal(duration(null), '?');
});

const prData = (extra = {}) => ({ number: 5, title: 'Réglage', url: 'u', state: 'MERGED', headRefName: 'chore/x', baseRefName: 'main', createdAt: at(0).toISOString(),
  mergedAt: at(120).toISOString(), additions: 1, deletions: 1, changedFiles: 1, commits: [{ oid: sha(1), committedDate: at(-30).toISOString() }], ...extra });

test('metrics: a pull request is ready at the latest of its opening and its last commit; order wait and merge split the rest', () => {
  const stack = parseStackLog([
    JSON.stringify({ at: at(90).toISOString(), event: 'batch-stop', prs: [5, 6], pr: 6, target: 'main' }),
    'pas du JSON',
    JSON.stringify({ at: at(110).toISOString(), event: 'batch-merge', lot: 'apv/lot-1', pr: 5, lotCommit: sha(2) }),
    JSON.stringify({ at: at(500).toISOString(), event: 'batch-stop', prs: [5], pr: 5 }),
  ].join('\n'));
  assert.equal(stack.length, 3, 'an unreadable line is left out');
  const m = measurePr({ pr: prData(), spec: null, stack, reviews: [{ commit: sha(1), domain: 'securite', at: at(60).toISOString(), sealed: true }],
    suites: [{ runId: 'r', candidateSha: sha(2), stage: 'full', full: true, ok: true, startedAt: at(95).toISOString(), endedAt: at(105).toISOString() }] });
  assert.equal(m.readyAt, at(0).toISOString());
  assert.equal(m.readyToMergeMs, 120 * 60_000);
  assert.equal(m.firstMergeAttemptAt, at(90).toISOString());
  assert.equal(m.orderWaitMs, 90 * 60_000);
  assert.equal(m.mergeMs, 30 * 60_000);
  assert.equal(m.batchStops, 1, 'a stop after the merge says nothing of this pull request');
  assert.equal(m.kind, 'minime');
  assert.deepEqual(m.suites, { full: 1, fullMs: 10 * 60_000, fullFailed: 0, task: 0 });
  const late = measurePr({ pr: prData({ commits: [{ oid: sha(1), committedDate: at(100).toISOString() }] }), spec: 'demo', stack, reviews: null, suites: null });
  assert.equal(late.readyAt, at(100).toISOString(), 'a commit after the opening makes it ready later');
  assert.equal(late.orderWaitMs, 0);
  assert.equal(late.kind, 'spec');
  assert.equal(late.suites, null);
});

test('metrics: the suite of a lot counts for every pull request the lot merged', () => {
  const stack = parseStackLog([
    JSON.stringify({ at: at(1).toISOString(), event: 'batch-merge', lot: 'apv/lot-1', pr: 5, lotCommit: sha(2) }),
    JSON.stringify({ at: at(2).toISOString(), event: 'batch-merge', lot: 'apv/lot-1', pr: 6, lotCommit: sha(3) }),
    JSON.stringify({ at: at(3).toISOString(), event: 'batch-merge', lot: 'apv/lot-2', pr: 7, lotCommit: sha(4) }),
  ].join('\n'));
  assert.deepEqual(lotCommits(stack, 5).sort(), [sha(2), sha(3)]);
  assert.deepEqual(lotCommits(stack, 7), [sha(4)]);
  assert.deepEqual(lotCommits(stack, 8), []);
});

test('metrics: the base of pull requests is the median of the last five merged minimal ones', () => {
  const p = (number, merged, ready, kind = 'minime') => ({ number, kind, mergedAt: merged === null ? null : at(merged).toISOString(), readyToMergeMs: ready, openToMergeMs: ready, orderWaitMs: 0, mergeMs: ready });
  const base = prBaseline([p(1, 1, 10), p(2, 2, 20), p(3, 3, 30), p(4, 4, 40), p(5, 5, 50), p(6, 6, 60), p(7, 7, 1, 'spec'), p(8, null, 1)]);
  assert.deepEqual(base.prs, [6, 5, 4, 3, 2]);
  assert.equal(base.readyToMergeMs, 40);
  assert.equal(parsePrData('{"number": 1}'), null, 'no opening date: not a pull request');
  assert.equal(parsePrData('pas du JSON'), null);
  assert.equal(parsePrData(JSON.stringify(prData({ commits: [{ oid: 'x', committedDate: '' }] }))).commits.length, 0, 'a commit without a full id is left out');
});

/** Repository with a committed (older) state of `demo` and a newer copy in the worktree of the project lead. */
function pilot(t) {
  const root = mkdtempSync(join(tmpdir(), 'apv3-metrics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Démo\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-q', '-c', 'apv/demo');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'tâche');
  const commit = git(repo, 'rev-parse', 'HEAD');
  writeRunState(join(repo, '.apv/state/run-demo.json'), demoState('demo', base));
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'état créé');
  git(repo, 'switch', '-q', 'main');
  const lead = join(root, 'run-demo');
  git(repo, 'worktree', 'add', '-q', lead, 'apv/demo');
  writeRunState(join(lead, '.apv/state/run-demo.json'), delivered('demo', base, commit));
  return { root, repo, lead, base, commit };
}

const snapshot = dir => {
  const out = [];
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.push(`${p}:${statSync(p).mtimeMs}:${statSync(p).size}`); } };
  walk(dir);
  return out.sort();
};

test('metrics: apv metrics run reads the newest copy of a state among the worktrees and the history, and writes nothing', async t => {
  const p = pilot(t);
  const before = snapshot(p.root);
  const r = await apv(p.repo, ['metrics', 'run', 'demo', '--offline']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Exécution demo \(état : \.\.\/run-demo\/\.apv\/state\/run-demo\.json/);
  assert.match(r.stdout, /De bout en bout : 4 h 00 min, de la création de l'exécution \(2026-10-04 02:00 UTC\+2\) jusqu'à la livraison \(fusion inconnue\)/);
  assert.match(r.stdout, /Chemin critique de la phase de code : F -> B -> C, 1 h 30 min de travail ; phase de code 1 h 39 min, dont 9 min/);
  assert.match(r.stdout, /Suites complètes : 0 .* contrôles de tâche : 0 ; suites d'impact : pas encore livrées/);
  assert.match(r.stdout, /Passes de corrections : 1/);
  assert.match(r.stdout, /Base de comparaison : aucune autre exécution fusionnée/);
  const j = await apv(p.repo, ['metrics', 'run', 'demo', '--offline', '--json']);
  assert.equal(j.json().run.phases.length, 8);
  assert.equal(j.json().run.tasks.length, 4);
  const list = await apv(p.repo, ['metrics', 'run', '--offline']);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /^Exécution +Créée +Bout en bout/);
  assert.match(list.stdout, /demo +2026-10-04 02:00 UTC\+2 +4 h 00 min +livraison/);
  assert.deepEqual(snapshot(p.root), before, 'read only: no file written or touched');
  assert.equal(git(p.repo, 'status', '--porcelain'), '');
});

test('metrics: the committed state counts when no worktree holds a copy', async t => {
  const p = pilot(t);
  git(p.repo, 'worktree', 'remove', '--force', p.lead);
  const r = await apv(p.repo, ['metrics', 'run', 'demo', '--offline', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.json().run.source, /^[0-9a-f]{12}:\.apv\/state\/run-demo\.json$/);
  assert.equal(r.json().run.end.kind, 'last-event');
});

test('metrics: an unknown execution or a wrong call is refused', async t => {
  const p = pilot(t);
  const missing = await apv(p.repo, ['metrics', 'run', 'absente', '--offline']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /METRICS_RUN_MISSING/);
  for (const args of [['metrics'], ['metrics', 'tout'], ['metrics', 'run', '../x'], ['metrics', 'run', 'a', 'b'], ['metrics', 'run', '--since', '2026-10-01'],
    ['metrics', 'prs', 'abc'], ['metrics', 'prs', '--offline'], ['metrics', 'prs', '3', '--since', '2026-10-01'], ['metrics', 'prs', '--since', 'hier']]) {
    const r = await apv(p.repo, args);
    assert.equal(r.code, 2, `${args.join(' ')} : ${r.stdout}${r.stderr}`);
  }
  const help = await apv(p.repo, ['help', 'metrics']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /apv metrics run \[<id>\]/);
});

/** A `gh` that answers `pr view <n>` from a table, `pr list --head` with the PR of the branch, and fails on anything else. */
function fakeGh(root, prs) {
  const file = join(root, 'gh.mjs');
  writeFileSync(file, `#!/usr/bin/env node
const prs = ${JSON.stringify(prs)};
const [a, b, c] = process.argv.slice(2);
if (a === 'pr' && b === 'view' && prs[c]) { process.stdout.write(JSON.stringify(prs[c])); process.exit(0); }
if (a === 'pr' && b === 'list') {
  const head = process.argv[process.argv.indexOf('--head') + 1];
  const list = Object.values(prs).filter(p => process.argv.includes('--head') ? p.headRefName === head : p.mergedAt);
  process.stdout.write(JSON.stringify(list.map(p => ({ number: p.number, mergedAt: p.mergedAt, createdAt: p.createdAt })))); process.exit(0);
}
process.stderr.write('introuvable'); process.exit(1);
`);
  chmodSync(file, 0o755);
  return file;
}

test('metrics: with gh, the execution ends at the merge of its pull request and apv metrics prs measures it', async t => {
  const p = pilot(t);
  const gh = fakeGh(p.root, {
    42: { ...prData({ number: 42, headRefName: 'apv/demo', createdAt: at(240).toISOString(), mergedAt: at(300).toISOString(), commits: [{ oid: p.commit, committedDate: at(100).toISOString() }] }) },
    43: { ...prData({ number: 43, createdAt: at(10).toISOString(), mergedAt: at(40).toISOString() }) },
  });
  const r = await apv(p.repo, ['metrics', 'run', 'demo'], { APV_GH: gh });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /De bout en bout : 5 h 00 min, .* jusqu'à la fusion .* PR #42 fusionnée/);
  const prs = await apv(p.repo, ['metrics', 'prs', '42', '#43'], { APV_GH: gh });
  assert.equal(prs.code, 0, prs.stderr);
  assert.match(prs.stdout, /#42 +spec demo /);
  assert.match(prs.stdout, /#43 +minime /);
  assert.match(prs.stdout, /Base \(médiane des 1 dernières PR minimes fusionnées : #43\) : prête à fusionnée 30 min/);
  assert.match(prs.stdout, /voie sans code 30 min au plus/);
  const missing = await apv(p.repo, ['metrics', 'prs', '44'], { APV_GH: gh });
  assert.equal(missing.code, 1, 'an unreadable pull request fails the measure');
  assert.match(missing.stderr, /gh pr view 44/);
});

test('metrics: apv status shows the last three measures', async t => {
  const p = pilot(t);
  const r = await apv(p.repo, ['status'], { APV_GH: join(p.root, 'pas-de-gh') });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Mesure \(apv metrics run\) : demo 4 h 00 min jusqu'à la livraison, chemin critique 1 h 30 min$/m);
  const j = await apv(p.repo, ['status', '--json'], { APV_GH: join(p.root, 'pas-de-gh') });
  assert.equal(j.json().metrics[0].specId, 'demo');
});
