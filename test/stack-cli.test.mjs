import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { apv, write } from './cli-helpers.mjs';
import { waive } from './support/rules.mjs';
import { REASONS } from '../hooks/scripts/bash-guard.mjs';
import { MERGE_REFUSED, anomalies, compareArgs, parseFreshness, readChecks } from '../dist/stack/github.js';
import { cleanMergedBranches, maskRemote, remoteRepository } from '../dist/stack/branches.js';

const fakeGh = fileURLToPath(new URL('./support/fake-gh.mjs', import.meta.url));
chmodSync(fakeGh, 0o755);

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim();

/**
 * The repository of the stacks: an origin and a clone, main, spec/1 on main, spec/2 on spec/1, spec/3 on spec/2, and
 * spec/2-bis on spec/1 (a head pushed while the stack merges). Dates and identity are fixed: the heads are the same in
 * every copy. The operator waived the rules checked before a merge for each head: these tests are about GitHub.
 */
function stackRepo(dir) {
  const origin = `${dir}-origin.git`;
  git(tmpdir(), 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmpdir(), 'clone', '-q', origin, dir);
  git(dir, 'switch', '-q', '-c', 'main');
  const heads = {};
  const commit = (name, from, file) => {
    if (from) git(dir, 'switch', '-q', '-c', name, from);
    writeFileSync(join(dir, file), `${name}\n`);
    git(dir, 'add', file); git(dir, 'commit', '-qm', name); git(dir, 'push', '-q', 'origin', name);
    return git(dir, 'rev-parse', 'HEAD');
  };
  commit('main', null, 'README.md');
  heads[11] = commit('spec/1', 'main', 's1.txt');
  heads[12] = commit('spec/2', 'spec/1', 's2.txt');
  heads[13] = commit('spec/3', 'spec/2', 's3.txt');
  heads.moved = commit('spec/2-bis', 'spec/1', 's2b.txt');
  git(dir, 'switch', '-q', 'main');
  for (const head of Object.values(heads)) waive(dir, head);
  return { origin, heads };
}
const HEADS = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'apv3-stack-heads-'));
  try { return stackRepo(join(dir, 'repo')).heads; } finally { rmSync(dir, { recursive: true, force: true }); }
})();
const sha = n => HEADS[n];

const pr = (number, base, head, extra = {}) => ({
  number, state: 'OPEN', isDraft: false, baseRefName: base, headRefName: head, headRefOid: sha(number),
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...extra,
});

/** A stack of three pull requests: #11 on main, #12 on #11, #13 on #12, in a real repository (the rules read it). */
function stack(t, overrides = {}, behavior = {}, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apv3-stack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'repo');
  const { heads } = stackRepo(dir);
  assert.deepEqual(heads, HEADS, 'the same heads in every copy');
  const prs = { 11: pr(11, 'main', 'spec/1'), 12: pr(12, 'spec/1', 'spec/2'), 13: pr(13, 'spec/2', 'spec/3') };
  for (const [n, fields] of Object.entries(overrides)) Object.assign(prs[n], fields);
  const file = join(root, 'gh.json');
  writeFileSync(file, JSON.stringify({ prs, behavior, calls: [], ...extra }));
  const env = { APV_GH: fakeGh, FAKE_GH_STATE: file, APV_STACK_POLL_MS: '5', APV_STACK_POLL_ATTEMPTS: '3', APV_ALLOW_MERGE: '' };
  return {
    dir, env,
    run: (args, extra = {}) => apv(dir, ['stack', ...args], { ...env, ...extra }),
    state: () => JSON.parse(readFileSync(file, 'utf8')),
    // Calls that change something: neither the reads of a pull request nor the reads of the REST API (compare, branches, pulls).
    writes: () => JSON.parse(readFileSync(file, 'utf8')).calls.filter(c => c[1] !== 'view' && !isRead(c)).map(c => c.join(' ')),
    branches: () => JSON.parse(readFileSync(file, 'utf8')).branches ?? {},
    compares: () => JSON.parse(readFileSync(file, 'utf8')).calls.filter(isCompare).map(c => c.find(a => a.includes('/compare/')).replace(/^.*\/compare\//, '')),
  };
}
const allow = { APV_ALLOW_MERGE: '1' };
const isCompare = c => c[0] === 'api' && c.some(a => /^repos\/[^/]+\/[^/]+\/compare\//.test(a));
/** A read of the REST API: `gh api` without `-X`, or with `-X GET`. */
const isRead = c => c[0] === 'api' && (!c.includes('-X') || c[c.indexOf('-X') + 1] === 'GET');
const del = branch => `api -X DELETE repos/o/r/git/refs/heads/${branch}`;
/** GitHub's answer once the previous PR of a merge-method stack is merged: one merge commit, no file changed. */
const mergeCommitOnly = { ahead_by: 1, files: [], merges: 1 };

test('checks: runs and statuses reduce to success, pending or failure', () => {
  assert.deepEqual(readChecks([
    { __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'b', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'CheckRun', name: 'c', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'CheckRun', name: 'd', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'StatusContext', context: 'e', state: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'f', state: 'PENDING' },
    { __typename: 'StatusContext', context: 'g', state: 'ERROR' },
  ]).map(c => `${c.name}:${c.state}`), ['a:success', 'b:success', 'c:pending', 'd:failure', 'e:success', 'f:pending', 'g:failure']);
  assert.deepEqual(readChecks(null), []);
  const base = { number: 1, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'x', headRefOid: 'a', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks: [] };
  assert.deepEqual(anomalies(base, 'main', false), []);
  assert.equal(anomalies({ ...base, isDraft: true, mergeStateStatus: 'DRAFT' }, 'main', true).length, 0);
  assert.equal(anomalies({ ...base, isDraft: true, mergeStateStatus: 'DRAFT' }, 'main', false).length, 1);
  assert.equal(anomalies({ ...base, mergeStateStatus: 'BLOCKED' }, 'main', false).length, 1);
});

test('apv stack plan accepts a coherent stack and changes nothing', async t => {
  const s = stack(t);
  const r = await s.run(['plan', '11', '#12', '13']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Cible : main\n1\. PR #11 : spec\/1 -> main, MERGEABLE\/CLEAN, contrôles 1\/1 au vert, à jour de main : ok\n2\. PR #12 : spec\/2 -> spec\/1, .*, à jour de spec\/1 : ok/);
  assert.match(r.stdout, /Pile cohérente\./);
  assert.deepEqual(s.writes(), []);
  const j = await s.run(['plan', '11', '12', '13', '--json']);
  assert.equal(j.json().ok, true);
  assert.deepEqual(j.json().prs.map(p => p.expectedBase), ['main', 'spec/1', 'spec/2']);
  assert.equal(j.json().calls.length, 6, 'one read and one compare per PR');
  assert.deepEqual(j.json().prs.map(p => p.freshness.state), ['up_to_date', 'up_to_date', 'up_to_date']);
  // Each PR against its own base: the previous PR of the stack, the target for the first.
  assert.deepEqual(s.compares().slice(-3), [`${sha(11)}...main`, `${sha(12)}...spec/1`, `${sha(13)}...spec/2`]);
  assert.equal(j.json().calls[0].args.join(' '), 'pr view 11 --json number,state,isDraft,baseRefName,headRefName,headRefOid,isCrossRepository,mergeable,mergeStateStatus,statusCheckRollup,url');
});

test('apv stack plan lists every anomaly of the stack', async t => {
  const s = stack(t, {
    12: { baseRefName: 'main', statusCheckRollup: [{ __typename: 'CheckRun', name: 'e2e', status: 'COMPLETED', conclusion: 'FAILURE' }] },
    13: { isDraft: true, mergeStateStatus: 'DRAFT', mergeable: 'CONFLICTING' },
  });
  const r = await s.run(['plan', '11', '12', '13', '14']);
  assert.equal(r.code, 1);
  for (const line of [/PR #12 vise main au lieu de spec\/1/, /PR #12 : contrôle\(s\) en échec : e2e/, /PR #13 est un brouillon/, /PR #13 n'est pas fusionnable \(mergeable CONFLICTING\)/,
    /gh pr view 14 a échoué \(code 1\)/, /no pull requests found for 14/, /Pile incohérente/]) assert.match(r.stdout, line);
  const target = await s.run(['plan', '11', '--target', 'develop', '--json']);
  assert.equal(target.code, 1);
  assert.deepEqual(target.json().prs[0].anomalies, ['PR #11 vise main au lieu de develop']);
  const ready = await s.run(['plan', '13', '--target', 'spec/2', '--ready', '--json']);
  assert.deepEqual(ready.json().prs[0].anomalies, ["PR #13 n'est pas fusionnable (mergeable CONFLICTING)"]);
});

test('apv stack merge refuses without APV_ALLOW_MERGE, with the message of the hook', async t => {
  assert.equal(MERGE_REFUSED, REASONS.merge);
  const s = stack(t);
  const r = await s.run(['merge', '11', '12']);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, `${REASONS.merge}\n`);
  assert.equal(s.state().calls.length, 0, 'no gh call at all');
  assert.equal((await s.run(['merge', '11'], { APV_ALLOW_MERGE: 'yes' })).code, 2);
});

test('apv stack merge merges in order, retargets and verifies each base, and prints every gh call', async t => {
  // As on GitHub with --merge: once #11 is merged, main has one merge commit #12 lacks, which changes no file.
  const s = stack(t, {}, { afterMergeBehind: { 11: { 12: { main: mergeCommitOnly } }, 12: { 13: { main: mergeCommitOnly } } } });
  const r = await s.run(['merge', '11', '12', '13'], allow);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(s.writes(), [
    `pr merge 11 --merge --match-head-commit ${sha(11)}`,
    'api -X PATCH repos/o/r/pulls/12 -f base=main', `pr merge 12 --merge --match-head-commit ${sha(12)}`,
    'api -X PATCH repos/o/r/pulls/13 -f base=main', `pr merge 13 --merge --match-head-commit ${sha(13)}`,
    // Then the merged branches, each next PR already retargeted.
    del('spec/1'), del('spec/2'), del('spec/3'),
  ]);
  assert.deepEqual(s.branches(), { 'spec/1': null, 'spec/2': null, 'spec/3': null });
  assert.match(r.stdout, new RegExp(`Branche spec/1 \\(PR #11\\) : supprimée, tête ${sha(11).slice(0, 12)} \\(à recréer au besoin : git push origin ${sha(11)}:refs/heads/spec/1\\)\\.`));
  assert.match(r.stdout, /Réglage du dépôt o\/r : delete_branch_on_merge est faux\. .*gh api -X PATCH repos\/o\/r -F delete_branch_on_merge=true \(commande non lancée\)\./);
  const prs = s.state().prs;
  assert.deepEqual(Object.values(prs).map(p => [p.state, p.baseRefName]), [['MERGED', 'main'], ['MERGED', 'main'], ['MERGED', 'main']]);
  assert.match(r.stdout, /\$ .*fake-gh\.mjs api -X PATCH repos\/o\/r\/pulls\/12 -f base=main\n\{"number":12,"state":"open","base":\{"ref":"main"\}.*\n\(code de sortie 0\)/);
  assert.match(r.stdout, /✓ Merged pull request o\/r#13 \(spec\/3\)/);
  assert.match(r.stdout, /"baseRefName":"main"/, 'the whole view output is shown');
  assert.match(r.stdout, /fusionnées : #11, #12, #13\nPile fusionnée dans main\./);
  assert.match(r.stdout, /Base juste avant la fusion de la PR #11 : à jour de main\n/);
  assert.match(r.stdout, /Base juste avant la fusion de la PR #12 : à jour de main en contenu \(1 commit\(s\) de fusion sans changement\)/);
  // Each PR is compared with the target as it is just before its own merge, after the retarget.
  const order = s.state().calls.map(c => isCompare(c) ? `compare ${c.find(a => a.includes('/compare/')).split('/compare/')[1]}` : c.slice(0, 3).join(' '));
  const retarget12 = order.indexOf('api -X PATCH');
  assert.ok(order.indexOf(`compare ${sha(12)}...main`) > retarget12);
  assert.ok(order.indexOf(`compare ${sha(12)}...main`) < order.indexOf('pr merge 12'));
  // The base of each pull request is read again after the retarget, before its merge.
  const calls = s.state().calls.map(c => c.slice(0, 3).join(' '));
  const edit = calls.indexOf('api -X PATCH');
  assert.equal(s.state().calls[edit][3], 'repos/o/r/pulls/12');
  assert.equal(calls[edit + 1], 'pr view 12');
  assert.ok(calls.indexOf('pr merge 12') > edit + 1);
});

test('a retarget that does not take effect stops the stack, whatever its exit code (incident 30)', async t => {
  // The REST call succeeds but the base read again is still the old one: stop, nothing else merged.
  const s = stack(t, {}, { retargetIgnored: [12] });
  const r = await s.run(['merge', '11', '12', '13'], allow);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /ARRÊT à la PR #12 :\n- re-ciblage de la PR #12 non effectif : elle vise spec\/1 au lieu de main \(gh api : code 0\)/);
  assert.match(r.stdout, /Non fusionnées : #12, #13\. Rien d'autre n'a été fusionné/);
  // #12 still targets spec/1: deleting it would close #12.
  assert.match(r.stdout, /Branche spec\/1 \(PR #11\) : gardée, base de la PR #12, encore ouverte\./);
  assert.deepEqual(s.writes(), [`pr merge 11 --merge --match-head-commit ${sha(11)}`, 'api -X PATCH repos/o/r/pulls/12 -f base=main']);
  assert.deepEqual(Object.values(s.state().prs).map(p => p.state), ['MERGED', 'OPEN', 'OPEN']);
});

test('a failed retarget call stops the stack, its whole output shown, the base read again', async t => {
  const failed = stack(t, {}, { retargetFail: [12] });
  const f = await failed.run(['merge', '11', '12', '13'], allow);
  assert.equal(f.code, 1);
  assert.match(f.stdout, /\$ .*api -X PATCH repos\/o\/r\/pulls\/12 -f base=main\n\{"message":"Validation Failed".*\ngh: Validation Failed \(HTTP 422\)\n\(code de sortie 1\)/);
  assert.match(f.stdout, /ARRÊT à la PR #12 :\n- re-ciblage de la PR #12 en échec \(gh api : code 1\) ; relue, elle vise spec\/1/);
  assert.deepEqual(failed.writes(), [`pr merge 11 --merge --match-head-commit ${sha(11)}`, 'api -X PATCH repos/o/r/pulls/12 -f base=main']);
  assert.deepEqual(Object.values(failed.state().prs).map(p => p.state), ['MERGED', 'OPEN', 'OPEN']);
  const calls = failed.state().calls.map(c => c.slice(0, 3).join(' '));
  assert.equal(calls[calls.indexOf('api -X PATCH') + 1], 'pr view 12', 'the result is read again even after a failed call');
  const j = await stack(t, {}, { retargetFail: [12] }).run(['merge', '11', '12', '--json'], allow);
  assert.deepEqual([j.json().merged, j.json().stopped.pr], [[11], 12]);
  assert.match(j.stderr, /Validation Failed \(HTTP 422\)\n\(code de sortie 1\)/, 'json mode: transcript on stderr');
  assert.ok(j.json().calls.some(c => c.args[0] === 'api' && c.status === 1));
});

test('retarget: never gh pr edit, which fails on deprecated classic projects', async t => {
  // Real merge of PR #70 and #71: `gh pr edit 71 --base apv3` exited 1 with « GraphQL: Projects (classic) is being
  // deprecated … (repository.pullRequest.projectCards) ». The fake gh fails the same way: the stack must not use it.
  const s = stack(t);
  const r = await s.run(['merge', '11', '12'], allow);
  assert.equal(r.code, 0, r.stdout);
  assert.ok(!s.state().calls.some(c => c[0] === 'pr' && c[1] === 'edit'));
  // Owner, name and host come from the address of the pull request read by gh pr view.
  const enterprise = stack(t, { 12: { url: 'https://ghe.example.com/o/r/pull/12' } });
  await enterprise.run(['merge', '11', '12'], allow);
  assert.deepEqual(enterprise.writes()[1], 'api --hostname ghe.example.com -X PATCH repos/o/r/pulls/12 -f base=main');
  // An address that is not the one of this pull request stops the stack before any merge.
  for (const url of ['https://github.com/o/r/pull/99', 'https://github.com/o/r/issues/12', '', 'https://github.com/o/../pull/12']) {
    const bad = stack(t, { 12: { url } });
    const b = await bad.run(['merge', '11', '12'], allow);
    assert.equal(b.code, 1, url);
    assert.match(b.stdout, /PR #12 : adresse illisible .*re-ciblage impossible/, url);
    assert.deepEqual(bad.writes(), [], url);
  }
});

test('merge re-checks each pull request just before merging it and stops at the first anomaly', async t => {
  // #12 turns red after #11 is merged: #11 merged, #12 and #13 untouched.
  const s = stack(t, {}, { afterMerge: { 11: { 12: { statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }] } } } });
  const r = await s.run(['merge', '11', '12', '13'], allow);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /ARRÊT à la PR #12 :\n- PR #12 : contrôle\(s\) en échec : ci/);
  // #12 was retargeted onto main before the stop: the branch of #11 is no one's base any more.
  assert.deepEqual(s.writes(), [`pr merge 11 --merge --match-head-commit ${sha(11)}`, 'api -X PATCH repos/o/r/pulls/12 -f base=main', del('spec/1')]);
  // An incoherent stack is refused before any merge.
  const bad = stack(t, { 13: { baseRefName: 'main' } });
  const b = await bad.run(['merge', '11', '12', '13'], allow);
  assert.equal(b.code, 1);
  assert.match(b.stdout, /pile incohérente avant toute fusion/);
  assert.deepEqual(bad.writes(), []);
  // A refused merge (branch policy) is reported with its whole output, and nothing else is merged.
  const refused = stack(t, {}, { mergeFail: [11] });
  const m = await refused.run(['merge', '11', '12'], allow);
  assert.equal(m.code, 1);
  assert.match(m.stdout, /is not mergeable: the base branch policy prohibits the merge\.\n\(code de sortie 1\)/);
  assert.match(m.stdout, /fusion de la PR #11 non constatée : état OPEN, base main \(gh pr merge : code 1\)/);
  assert.deepEqual(refused.writes(), [`pr merge 11 --merge --match-head-commit ${sha(11)}`]);
});

test('merge: a head that moved is refused by GitHub, drafts need --ready, mergeability is awaited', async t => {
  // The merge carries the head read just before it: a head that moved since is refused by GitHub, and the stack stops.
  const updated = stack(t, {}, { afterMerge: { 11: { 12: { headRefOid: sha('moved') } } } });
  const r = await updated.run(['merge', '11', '12', '--method', 'squash'], allow);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(updated.writes().filter(w => w.startsWith('pr merge')), [`pr merge 11 --squash --match-head-commit ${sha(11)}`, `pr merge 12 --squash --match-head-commit ${sha('moved')}`]);
  const moved = stack(t, {}, { headMovesAtMerge: [12] });
  const m = await moved.run(['merge', '11', '12', '13'], allow);
  assert.equal(m.code, 1);
  assert.match(m.stdout, /Head branch was modified[\s\S]*ARRÊT à la PR #12/);
  assert.deepEqual(Object.values(moved.state().prs).map(p => p.state), ['MERGED', 'OPEN', 'OPEN']);
  const drafts = stack(t, { 11: { isDraft: true, mergeStateStatus: 'DRAFT' } });
  const refused = await drafts.run(['merge', '11'], allow);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /PR #11 est un brouillon/);
  const ready = await drafts.run(['merge', '11', '--ready'], allow);
  assert.equal(ready.code, 0, ready.stdout);
  assert.deepEqual(drafts.writes(), ['pr ready 11', `pr merge 11 --merge --match-head-commit ${sha(11)}`]);
  const slow = stack(t, {}, { unknownViews: { 11: 2 } });
  assert.equal((await slow.run(['merge', '11'], allow)).code, 0, 'UNKNOWN mergeability is polled');
  const stuck = stack(t, {}, { unknownViews: { 11: 10 } });
  const s = await stuck.run(['merge', '11'], allow);
  assert.equal(s.code, 1);
  assert.match(s.stdout, /mergeable UNKNOWN/);
});

test('wrong calls exit 2 before any gh call', async t => {
  const s = stack(t);
  for (const args of [['plan'], ['merge'], ['plan', 'x'], ['plan', '0'], ['plan', '11', '11'], ['unstack', '11'], [], ['plan', '11', '--method', 'squash'],
    ['merge', '11', '--method', 'octopus'], ['plan', '11', '--target', ' '], ['plan', '11', '--bogus']]) {
    assert.equal((await s.run(args, allow)).code, 2, args.join(' '));
  }
  assert.equal(s.state().calls.length, 0);
  assert.match((await s.run(['--help'])).stdout, /APV_ALLOW_MERGE=1 apv stack merge/);
  const missing = await s.run(['plan', '11'], { APV_GH: join(s.dir, 'no-gh') });
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /ENOENT/);
});

// Incident of 25 September 2026 (pilot project): #31 adds a test importing a module, #32 moves that module. Each
// green alone, merged one after the other: main red, because nobody checked #32 against the main that had #31.
const incident = { ahead_by: 2, files: ['src/lib/server/security-headers.test.ts'], merges: 1 };

test('freshness: an up-to-date PR is accepted, a PR behind its base is refused with the way to update it', async t => {
  const fresh = stack(t);
  const ok = await fresh.run(['merge', '11'], allow);
  assert.equal(ok.code, 0, ok.stdout);
  assert.deepEqual(fresh.writes(), [`pr merge 11 --merge --match-head-commit ${sha(11)}`]);

  const behind = stack(t, {}, { behind: { 11: { main: incident } } });
  const plan = await behind.run(['plan', '11']);
  assert.equal(plan.code, 1);
  assert.match(plan.stdout, /1\. PR #11 : .*EN RETARD sur main \(2 commit\(s\) absent\(s\) de la tête\)/);
  const m = await behind.run(['merge', '11'], allow);
  assert.equal(m.code, 1);
  assert.deepEqual(behind.writes(), [], 'nothing merged');
  for (const step of [
    /PR #11 n'est pas à jour de sa base main : 2 commit\(s\) de main absent\(s\) de la tête [0-9a-f]{12} \(1 fichier\(s\) changé\(s\) : src\/lib\/server\/security-headers\.test\.ts\)/,
    /ses contrôles n'ont donc pas porté sur le résultat de la fusion/,
    /dans la branche spec\/1, git fetch origin puis git merge origin\/main \(une fusion, jamais de rebase ni de force-push\)/,
    /apv gates run --stage task --base origin\/main, puis apv gates verify --commit <nouvelle tête> --stage task --base origin\/main à 0/,
    /git push \(sans force\) ; attendre les contrôles GitHub au vert ; relancer apv stack plan puis apv stack merge/,
    /Dérogation exceptionnelle et journalisée : --allow-behind --reason "<raison>"/,
  ]) assert.match(m.stdout, step);
  const j = await behind.run(['plan', '11', '--json']);
  assert.equal(j.json().prs[0].freshness.state, 'behind');
  assert.equal(j.json().prs[0].freshness.missing, 2);
});

test('freshness: a waiver with its reason merges a PR behind its base, journaled before the merge', async t => {
  const s = stack(t, {}, { behind: { 11: { main: incident } } });
  const log = join(s.dir, '.apv', 'state', 'stack.log');
  const plan = await s.run(['plan', '11', '--allow-behind', '--reason', 'correctif de production, main vérifiée à la main']);
  assert.equal(plan.code, 0, plan.stdout);
  assert.ok(!existsSync(log), 'plan journals nothing');
  const r = await s.run(['merge', '11', '--allow-behind', '--reason', 'correctif de production, main vérifiée à la main'], allow);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(s.writes(), [`pr merge 11 --merge --match-head-commit ${sha(11)}`]);
  assert.match(r.stdout, /DÉROGATION \(--allow-behind\) : PR #11 admise en retard de 2 commit\(s\) sur main, journalisée dans \.apv\/state\/stack\.log ; raison : correctif de production/);
  const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual({ ...lines[0], at: undefined }, { at: undefined, event: 'allow-behind', stack: [11], method: 'merge', pr: 11, head: sha(11), base: 'main', missing: 2,
    files: ['src/lib/server/security-headers.test.ts'], reason: 'correctif de production, main vérifiée à la main' });
  assert.match(readFileSync(join(s.dir, '.apv', '.gitignore'), 'utf8'), /^state\/\*\.log$/m, 'the journal is never versioned');
  const j = await stack(t, {}, { behind: { 11: { main: incident } } }).run(['merge', '11', '--allow-behind', '--reason', 'x', '--json'], allow);
  assert.deepEqual(j.json().derogations.map(d => [d.pr, d.reason]), [[11, 'x']]);

  // No journal, no merge.
  const blocked = stack(t, {}, { behind: { 11: { main: incident } } });
  writeFileSync(join(blocked.dir, '.apv'), 'not a directory');
  const b = await blocked.run(['merge', '11', '--allow-behind', '--reason', 'x'], allow);
  assert.equal(b.code, 1);
  assert.match(b.stdout, /dérogation --allow-behind non journalisée .*fusion de la PR #11 refusée/);
  assert.deepEqual(blocked.writes(), []);

  // The waiver needs its reason, and only covers a PR behind its base: an unverifiable base is still refused.
  for (const args of [['merge', '11', '--allow-behind'], ['merge', '11', '--reason', 'x'], ['merge', '11', '--allow-behind', '--reason', ' '],
    ['merge', '11', '--allow-behind', '--reason', 'r'.repeat(501)], ['plan', '11', '--allow-behind']]) {
    assert.equal((await s.run(args, allow)).code, 2, args.join(' '));
  }
  const failing = stack(t, {}, { compareFail: [11] });
  const f = await failing.run(['merge', '11', '--allow-behind', '--reason', 'x'], allow);
  assert.equal(f.code, 1);
  assert.match(f.stdout, /PR #11 : impossible de vérifier que la tête [0-9a-f]{12} contient sa base main \(gh api compare a échoué \(code 1\)\)/);
  assert.match(f.stdout, /Server Error \(HTTP 502\)/, 'the failed call is shown');
  assert.deepEqual(failing.writes(), []);
});

test('freshness in a stack: each PR against its base, and again against the target after the previous merge', async t => {
  // #12 lacks the last commits of spec/1: the plan refuses it, before any merge.
  const lagging = stack(t, {}, { behind: { 12: { 'spec/1': { ahead_by: 1, files: ['src/a.ts'] } } } });
  const p = await lagging.run(['merge', '11', '12'], allow);
  assert.equal(p.code, 1);
  assert.match(p.stdout, /PR #12 n'est pas à jour de sa base spec\/1 .*git merge origin\/spec\/1/);
  assert.deepEqual(lagging.writes(), []);

  // Coherent stack; while #11 is merged, another PR lands on main: #12, retargeted, is now behind main. Stop at #12.
  const s = stack(t, {}, { afterMergeBehind: { 11: { 12: { main: incident } } } });
  assert.equal((await s.run(['plan', '11', '12'])).code, 0);
  const r = await s.run(['merge', '11', '12'], allow);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /ARRÊT à la PR #12 :\n- PR #12 n'est pas à jour de sa base main : 2 commit\(s\) de main absent\(s\) de la tête [0-9a-f]{12}/);
  assert.match(r.stdout, /Non fusionnées : #12\./);
  assert.deepEqual(s.writes(), [`pr merge 11 --merge --match-head-commit ${sha(11)}`, 'api -X PATCH repos/o/r/pulls/12 -f base=main', del('spec/1')]);
  assert.deepEqual(Object.values(s.state().prs).slice(0, 2).map(p => p.state), ['MERGED', 'OPEN']);
  assert.deepEqual(s.compares().slice(-1), [`${sha(12)}...main`]);

  // With --squash, main gets a new commit carrying the changes of #11: #12 must be updated before its merge.
  const squash = stack(t, {}, { afterMergeBehind: { 11: { 12: { main: { ahead_by: 1, files: ['src/a.ts'], merges: 0 } } } } });
  const q = await squash.run(['merge', '11', '12', '--method', 'squash'], allow);
  assert.equal(q.code, 1);
  assert.match(q.stdout, /ARRÊT à la PR #12 :\n- PR #12 n'est pas à jour de sa base main/);
});

test('freshness: same content only on the full evidence, and the compare call reads the right refs', () => {
  const read = answer => parseFreshness(JSON.stringify(answer), 'main', 'a'.repeat(40)).state;
  assert.equal(read({ ahead_by: 0, listed: 0, merges: 0, files: [] }), 'up_to_date');
  assert.equal(read({ ahead_by: 1, listed: 1, merges: 1, files: [] }), 'same_content');
  assert.equal(read({ ahead_by: 1, listed: 1, merges: 0, files: [] }), 'behind', 'a non-merge commit is never taken as empty');
  assert.equal(read({ ahead_by: 300, listed: 250, merges: 250, files: [] }), 'behind', 'commits not all listed');
  assert.equal(read({ ahead_by: 1, listed: 1, merges: 1, files: null }), 'behind', 'files not listed');
  assert.equal(read({ ahead_by: 1, listed: 1, merges: 1, files: ['x'] }), 'behind');
  assert.equal(read({ files: [] }), 'unknown');
  assert.equal(parseFreshness('not json', 'main', 'a').state, 'unknown');
  const where = { host: 'github.com', path: 'repos/o/r/pulls/3', repo: 'repos/o/r' };
  const args = compareArgs(where, 'a'.repeat(40), 'feat/x y');
  assert.deepEqual(args.slice(0, 2), ['api', `repos/o/r/compare/${'a'.repeat(40)}...feat/x%20y`]);
  assert.equal(args[2], '--jq');
  assert.deepEqual(compareArgs({ ...where, host: 'ghe.example.com' }, 'b', 'main').slice(0, 3), ['api', '--hostname', 'ghe.example.com']);
});

// Pilot project, 1 October 2026: the merges left their branches behind (54 merged branches on a repository without
// GitHub's « delete branch after merge »). After its merges, the stack deletes them, unless a rule keeps one.

/** #11 alone (its branch spec/1 is nobody's base: #12 targets main). */
const single = (t, overrides = {}, behavior = {}, extra = {}) => stack(t, { 12: { baseRefName: 'main' }, ...overrides }, behavior, extra);
const line = (r, branch) => r.stdout.split('\n').find(l => l.includes(`ranche ${branch} (PR #`));

test('merged branches: deleted through the REST API after the merge, the absence read again, one line each', async t => {
  const s = single(t);
  const r = await s.run(['merge', '11'], allow);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(s.writes(), [`pr merge 11 --merge --match-head-commit ${sha(11)}`, del('spec/1')]);
  assert.deepEqual(s.branches(), { 'spec/1': null });
  const calls = s.state().calls.map(c => c.join(' '));
  const after = calls.slice(calls.indexOf(`pr merge 11 --merge --match-head-commit ${sha(11)}`));
  // The pull requests first, then the branch read right before its deletion, then read again.
  assert.deepEqual(after.filter(c => c.startsWith('api')), [
    'api repos/o/r --jq {default_branch, fork, delete_branch_on_merge}',
    'api -X GET repos/o/r/pulls -f state=open -f base=spec/1 -f per_page=100 --jq [.[].number]',
    'api -X GET repos/o/r/pulls -f state=open -f head=o:spec/1 -f per_page=100 --jq [.[].number]',
    'api -X GET repos/o/r/pulls -f state=all -f base=spec/1 -f per_page=1 --jq [.[].number]',
    'api repos/o/r/branches/spec/1 --jq {sha: .commit.sha, protected}',
    del('spec/1'),
    'api repos/o/r/branches/spec/1 --jq {sha: .commit.sha, protected}',
  ]);
  assert.match(r.stdout, new RegExp(`Pile fusionnée dans main\\.\\nBranche spec/1 \\(PR #11\\) : supprimée, tête ${sha(11).slice(0, 12)}`));
  const j = await single(t).run(['merge', '11', '--json'], allow);
  assert.deepEqual(j.json().cleanup.branches, [{ pr: 11, branch: 'spec/1', head: sha(11), status: 'deleted', reason: 'supprimée' }]);
  assert.deepEqual(j.json().cleanup.repositories, [{ host: 'github.com', repo: 'o/r', defaultBranch: 'main', fork: false, deleteBranchOnMerge: false, error: null }]);
  assert.match(j.stderr, /api -X DELETE repos\/o\/r\/git\/refs\/heads\/spec\/1\n\(code de sortie 0\)/, 'every call shown, on stderr in JSON mode');
});

test('merged branches: --keep-branches, a fork, an unknown origin, the default branch, a protected branch, a moved head, an open PR keep it', async t => {
  const keep = single(t);
  const k = await keep.run(['merge', '11', '--keep-branches'], allow);
  assert.equal(k.code, 0, k.stdout);
  assert.equal(line(k, 'spec/1'), 'Branche spec/1 (PR #11) : gardée, --keep-branches.');
  assert.ok(!keep.state().calls.some(c => c[0] === 'api' && !isCompare(c)), 'no call at all');
  const cases = [
    [{ 11: { isCrossRepository: true } }, {}, { branches: { 'spec/1': { sha: sha(11) } } }, 'gardée, PR venue d\'un fork : la branche appartient à un autre dépôt.'],
    [{ 11: { isCrossRepository: null } }, {}, {}, 'gardée, origine de la branche inconnue (isCrossRepository non lu) : peut-être un fork.'],
    [{}, {}, { repo: { default_branch: 'spec/1' } }, 'gardée, branche par défaut du dépôt.'],
    [{}, { protected: ['spec/1'] }, {}, 'gardée, branche protégée.'],
    // Someone pushed on the branch after the merge: its new commits are never deleted.
    [{}, {}, { branches: { 'spec/1': { sha: 'c'.repeat(40) } } }, `gardée, tête déplacée depuis la fusion (${'c'.repeat(12)} au lieu de ${sha(11).slice(0, 12)}).`],
    // Another open PR from the same branch: deleting it would close that PR.
    [{ 14: pr(14, 'release', 'spec/1') }, {}, {}, 'gardée, tête de la PR #14, encore ouverte.'],
    [{ 14: pr(14, 'spec/1', 'spec/9'), 15: pr(15, 'spec/1', 'spec/8') }, {}, {}, 'gardée, base de la PR #14, la PR #15, encore ouvertes.'],
    // A long-lived branch: it already was the base of a merged PR (in a stack, the next PR is retargeted first).
    [{ 14: pr(14, 'spec/1', 'spec/9', { state: 'MERGED' }) }, {}, {}, 'gardée, elle a déjà servi de base à la PR #14 : branche de longue durée probable.'],
    // In a fork, the branch may be the head of a PR of the parent repository, which the fork cannot list.
    [{}, {}, { repo: { fork: true } }, 'gardée, dépôt fork : la branche peut être la tête d\'une PR du dépôt parent.'],
  ];
  for (const [overrides, behavior, extra, expected] of cases) {
    const s = stack(t, { 12: { baseRefName: 'main' } }, behavior, extra);
    const state = s.state();
    for (const [n, fields] of Object.entries(overrides)) state.prs[n] = { ...state.prs[n], ...fields };
    writeFileSync(s.env.FAKE_GH_STATE, JSON.stringify(state));
    const r = await s.run(['merge', '11'], allow);
    assert.equal(r.code, 0, `${expected}\n${r.stdout}`);
    assert.equal(line(r, 'spec/1'), `Branche spec/1 (PR #11) : ${expected}`);
    assert.deepEqual(s.writes(), [`pr merge 11 --merge --match-head-commit ${sha(11)}`], expected);
  }
});

test('merged branches: stack.keepBranches of .apv/config.json names the long-lived branches; an unreadable configuration keeps all', async t => {
  const named = single(t);
  write(named.dir, '.apv/config.json', { gates: [], stack: { keepBranches: ['spec/*'] } });
  const r = await named.run(['merge', '11'], allow);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(line(r, 'spec/1'), 'Branche spec/1 (PR #11) : gardée, branche de longue durée (stack.keepBranches : spec/*).');
  assert.deepEqual(named.writes(), [`pr merge 11 --merge --match-head-commit ${sha(11)}`]);
  // Default: develop, release/*... are kept without any call.
  const develop = single(t, { 11: { headRefName: 'release/1.2' } });
  const d = await develop.run(['merge', '11'], allow);
  assert.equal(line(d, 'release/1.2'), 'Branche release/1.2 (PR #11) : gardée, branche de longue durée (stack.keepBranches : release/*).');
  const broken = single(t);
  write(broken.dir, '.apv/config.json', '{ pas du json');
  const b = await broken.run(['merge', '11'], allow);
  assert.equal(b.code, 0, b.stdout);
  assert.match(line(b, 'spec/1'), /gardée, configuration illisible, stack\.keepBranches inconnu/);
  assert.deepEqual(broken.writes(), [`pr merge 11 --merge --match-head-commit ${sha(11)}`]);
});

test('merged branches: already deleted by GitHub (delete_branch_on_merge) is noted, no deletion, no advice', async t => {
  const s = single(t, {}, {}, { repo: { delete_branch_on_merge: true } });
  const r = await s.run(['merge', '11'], allow);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(line(r, 'spec/1'), 'Branche spec/1 (PR #11) : absente (404) ; le dépôt supprime les branches fusionnées (delete_branch_on_merge).');
  assert.deepEqual(s.writes(), [`pr merge 11 --merge --match-head-commit ${sha(11)}`]);
  assert.doesNotMatch(r.stdout, /Réglage du dépôt/);
  const j = await single(t, {}, {}, { repo: { delete_branch_on_merge: true } }).run(['merge', '11', '--json'], allow);
  assert.equal(j.code, 0);
  assert.deepEqual(j.json().cleanup.branches.map(b => b.status), ['absent']);
});

test('merged branches: a failed deletion is a warning, never a failed merge', async t => {
  const cases = [
    [{ deleteFail: ['spec/1'] }, /AVERTISSEMENT : branche spec\/1 \(PR #11\) non supprimée : suppression non constatée : la branche existe encore \(gh api -X DELETE : code 1\) ; la fusion reste acquise\./],
    [{ deleteIgnored: ['spec/1'] }, /AVERTISSEMENT : branche spec\/1 \(PR #11\) non supprimée : suppression non constatée : la branche existe encore \(gh api -X DELETE : code 0\)/],
    [{ repoFail: true }, /AVERTISSEMENT : branche spec\/1 \(PR #11\) non supprimée : réglages du dépôt illisibles \(gh api repos\/o\/r : code 1\) : branche par défaut inconnue/],
    [{ branchReadFail: ['spec/1'] }, /AVERTISSEMENT : branche spec\/1 \(PR #11\) non supprimée : lecture de la branche impossible/],
    [{ pullsFail: true }, /AVERTISSEMENT : branche spec\/1 \(PR #11\) non supprimée : PR ouvertes illisibles/],
  ];
  for (const [behavior, expected] of cases) {
    const s = single(t, {}, behavior);
    const r = await s.run(['merge', '11'], allow);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /Pile fusionnée dans main\./);
    assert.match(r.stdout, expected);
    assert.equal(s.state().prs[11].state, 'MERGED');
  }
  const j = await single(t, {}, { deleteFail: ['spec/1'] }).run(['merge', '11', '--json'], allow);
  assert.equal(j.code, 0);
  assert.deepEqual(j.json().cleanup.branches.map(b => b.status), ['failed']);
  assert.match(j.stderr, /Resource not accessible by integration \(HTTP 403\)/);
});

test('merged branches: nothing merged, nothing deleted; --keep-branches only where something merges', async t => {
  const s = stack(t, { 11: { statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }] } });
  const r = await s.run(['merge', '11', '12'], allow);
  assert.equal(r.code, 1);
  assert.deepEqual(s.writes(), []);
  assert.ok(!s.state().calls.some(c => c[0] === 'api' && !isCompare(c)));
  assert.doesNotMatch(r.stdout, /Branche /);
  assert.equal((await s.run(['plan', '11', '--keep-branches'])).code, 2);
  assert.match((await s.run(['--help'])).stdout, /--keep-branches/);
});

/** A scripted gh for the cleanup alone: the repository, the branch reads in order, the pull request lists, the deletion. */
function scripted({ repo = { default_branch: 'main', fork: false, delete_branch_on_merge: false }, branch = [], pulls = {}, deletion = { status: 0, stdout: '', stderr: '', error: null } } = {}) {
  const calls = [];
  const reads = [...branch];
  const run = async args => {
    calls.push(args);
    const path = args.find(a => a.startsWith('repos/'));
    let answer;
    if (/^repos\/[^/]+\/[^/]+$/.test(path)) answer = ok(JSON.stringify(repo));
    else if (path.includes('/branches/')) answer = reads.shift() ?? missing;
    else if (path.endsWith('/pulls')) answer = pulls[`${args.find(a => a.startsWith('state='))} ${args.find(a => /^(base|head)=/.test(a)).split('=')[0]}`] ?? ok('[]');
    else if (args.includes('DELETE')) answer = deletion;
    return { args, ...answer };
  };
  return { run, calls, paths: () => calls.map(c => c.find(a => a.startsWith('repos/'))) };
}
const ok = stdout => ({ status: 0, stdout, stderr: '', error: null });
const present = (sha, fields = { protected: false }) => ok(JSON.stringify({ sha, ...fields }));
const missing = { status: 1, stdout: '', stderr: 'gh: Branch not found (HTTP 404)\n', error: null };
const merged = (branch, extra = {}) => ({ pr: 5, branch, head: 'a'.repeat(40), crossRepository: false, url: 'https://github.com/o/r/pull/5', ...extra });
const clean = async (gh, head, options = {}) => (await cleanMergedBranches([head], { run: gh.run, target: 'main', keep: null, ...options })).branches.map(b => [b.status, b.reason]);

test('branch cleanup: target and long-lived branches never deleted, without any call', async () => {
  const gh = scripted();
  assert.deepEqual(await clean(gh, merged('develop'), { target: 'develop' }), [['kept', 'branche cible']]);
  for (const name of ['develop', 'development', 'release/1.2', 'releases/x', 'staging', 'hotfix/urgent']) {
    assert.equal((await clean(gh, merged(name)))[0][0], 'kept', name);
  }
  assert.deepEqual(await clean(gh, merged('team/a/b'), { keepPatterns: ['team/**'] }), [['kept', 'branche de longue durée (stack.keepBranches : team/**)']]);
  assert.deepEqual(gh.calls, []);
  // [] names none: develop is then examined like any branch.
  const none = scripted({ branch: [present('a'.repeat(40)), missing] });
  assert.deepEqual(await clean(none, merged('develop'), { keepPatterns: [] }), [['deleted', 'supprimée']]);
});

test('branch cleanup: a fork repository keeps every branch; the default branch is kept', async () => {
  const fork = scripted({ repo: { default_branch: 'main', fork: true } });
  assert.deepEqual(await clean(fork, merged('feat/x')), [['kept', 'dépôt fork : la branche peut être la tête d\'une PR du dépôt parent']]);
  assert.equal(fork.calls.length, 1, 'only the repository read');
  const unknown = scripted({ repo: { default_branch: 'main' } });
  assert.deepEqual(await clean(unknown, merged('feat/x')), [['kept', 'dépôt fork ou non (fork non lu)']]);
  const trunk = scripted({ repo: { default_branch: 'trunk', fork: false } });
  assert.deepEqual(await clean(trunk, merged('trunk')), [['kept', 'branche par défaut du dépôt']]);
});

test('branch cleanup: pull requests read first, the branch read right before the escaped DELETE, then read again', async () => {
  const gh = scripted({ branch: [present('a'.repeat(40)), missing] });
  assert.deepEqual(await clean(gh, merged('feat/a b#c')), [['deleted', 'supprimée']]);
  assert.deepEqual(gh.paths(), ['repos/o/r', 'repos/o/r/pulls', 'repos/o/r/pulls', 'repos/o/r/pulls', 'repos/o/r/branches/feat/a%20b%23c',
    'repos/o/r/git/refs/heads/feat/a%20b%23c', 'repos/o/r/branches/feat/a%20b%23c']);
  assert.deepEqual(gh.calls[4].slice(-2), ['--jq', '{sha: .commit.sha, protected}']);
  assert.deepEqual(gh.calls[5], ['api', '-X', 'DELETE', 'repos/o/r/git/refs/heads/feat/a%20b%23c']);
  assert.ok(gh.calls[1].includes('base=feat/a b#c') && gh.calls[2].includes('head=o:feat/a b#c') && gh.calls[3].includes('state=all'), 'query values passed as fields');
});

test('branch cleanup: answers that keep the branch or warn, never a deletion on doubt', async () => {
  const head = 'a'.repeat(40);
  const cases = [
    [{ branch: [missing] }, ['absent', 'absente (404)']],
    [{ repo: { default_branch: 'main', fork: false, delete_branch_on_merge: true }, branch: [missing] }, ['absent', 'absente (404) ; le dépôt supprime les branches fusionnées (delete_branch_on_merge)']],
    // A failed DELETE, then the branch is gone: someone (GitHub) deleted it meanwhile.
    [{ branch: [present(head), missing], deletion: { status: 1, stdout: '', stderr: 'gh: Reference does not exist (HTTP 422)\n', error: null } },
      ['absent', 'absente (404) après une suppression en échec (gh api -X DELETE : code 1)']],
    [{ branch: [present(head), present(head)], deletion: { status: 1, stdout: '', stderr: 'gh: Forbidden (HTTP 403)\n', error: null } },
      ['failed', 'suppression non constatée : la branche existe encore (gh api -X DELETE : code 1)']],
    [{ branch: [present(head, {})] }, ['kept', 'protection de la branche inconnue']],
    [{ branch: [present(head, { protected: true })] }, ['kept', 'branche protégée']],
    [{ branch: [present('b'.repeat(40))] }, ['kept', `tête déplacée depuis la fusion (${'b'.repeat(12)} au lieu de ${'a'.repeat(12)})`]],
    [{ pulls: { 'state=open base': ok('{"message":"Bad credentials"}') } }, ['failed', 'PR ouvertes illisibles (réponse illisible)']],
    [{ pulls: { 'state=all base': { status: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)\n', error: null } } }, ['failed', 'PR qui la visent illisibles (gh api repos/o/r/pulls : code 1)']],
    [{ pulls: { 'state=all base': ok('[7]') } }, ['kept', 'elle a déjà servi de base à la PR #7 : branche de longue durée probable']],
    [{ branch: [{ status: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)\n', error: null }] }, ['failed', 'lecture de la branche impossible (gh api repos/o/r/branches : code 1)']],
  ];
  for (const [script, expected] of cases) {
    const gh = scripted(script);
    assert.deepEqual(await clean(gh, merged('feat/x')), [expected], expected[1]);
    if (expected[0] !== 'deleted' && !script.deletion) assert.ok(!gh.calls.some(c => c.includes('DELETE')), expected[1]);
  }
});

test('branch cleanup: GitHub Enterprise, --hostname on every call', async () => {
  const gh = scripted({ branch: [present('a'.repeat(40)), missing] });
  const cleanup = await cleanMergedBranches([merged('x', { url: 'https://ghe.example.com/o/r/pull/5' })], { run: gh.run, target: 'main', keep: null });
  assert.deepEqual(cleanup.branches.map(b => b.status), ['deleted']);
  assert.deepEqual(cleanup.repositories.map(r => r.host), ['ghe.example.com']);
  assert.equal(gh.calls.length, 7);
  for (const call of gh.calls) assert.deepEqual(call.slice(0, 3), ['api', '--hostname', 'ghe.example.com'], call.join(' '));
});

test('remote addresses of GitHub repositories', () => {
  for (const url of ['https://github.com/o/r.git', 'https://github.com/o/r', 'git@github.com:o/r.git', 'ssh://git@github.com/o/r.git', 'https://user@github.com/o/r/']) {
    assert.deepEqual(remoteRepository(url), { host: 'github.com', repo: 'repos/o/r' }, url);
  }
  assert.deepEqual(remoteRepository('git@ghe.example.com:team/app.git'), { host: 'ghe.example.com', repo: 'repos/team/app' });
  for (const url of ['/srv/git/r.git', 'file:///srv/r.git', '../origin.git', 'https://github.com/o/../x', 'https://github.com/o']) assert.equal(remoteRepository(url), null, url);
  assert.equal(maskRemote('https://x-access-token:ghp_secret@github.com/o/r.git'), 'https://***@github.com/o/r.git');
  assert.equal(maskRemote('ssh://deploy:pw@host/o/r'), 'ssh://***@host/o/r');
  assert.equal(maskRemote('user@host:o/r.git'), '***@host:o/r.git');
  assert.equal(maskRemote('/srv/git/r.git'), '/srv/git/r.git');
});

test('merge: a PR without any check once retargeted stops the stack with the way (CI only on pull requests towards the target)', async t => {
  // #12 aims at spec/1: the CI of main, started only by pull requests towards main, never ran on it.
  const s = stack(t, { 12: { statusCheckRollup: [] } }, { afterMergeBehind: { 11: { 12: { main: mergeCommitOnly } } } });
  const plan = await s.run(['plan', '11', '12']);
  assert.equal(plan.code, 0, plan.stdout + plan.stderr);
  assert.match(plan.stdout, /2\. PR #12 : .*contrôles absents.* : ok\n   NOTE : PR #12 : aucun contrôle \(sa base spec\/1 n'est pas main\) ; si la CI de main ne tourne que sur les PR vers elle/);
  const r = await s.run(['merge', '11', '12', '--json'], allow);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const report = r.json();
  assert.deepEqual(report.merged, [11]);
  assert.equal(report.stopped.pr, 12);
  assert.match(report.stopped.reasons[0], /PR #12 : aucun contrôle après son re-ciblage sur main, alors que la PR #11, qui visait main, en avait 1 : la CI de main ne se déclenche que sur les PR ouvertes vers elle .* des contrôles absents ne valent pas le vert\. Marche à suivre : dans la branche spec\/2, git fetch origin puis git merge origin\/main .* git push \(sans force\) ; puis relancer APV_ALLOW_MERGE=1 apv stack merge sur les PR restantes avec --wait-ci <minutes>/);
  assert.ok(!s.writes().some(w => w.startsWith('pr merge 12')), '#12 is not merged');
  // A stack whose first PR has no check either (no CI at all): absent checks keep their meaning, nothing changes.
  const none = stack(t, { 11: { statusCheckRollup: [] }, 12: { statusCheckRollup: [] } }, { afterMergeBehind: { 11: { 12: { main: mergeCommitOnly } } } });
  const merged = await none.run(['merge', '11', '12'], allow);
  assert.equal(merged.code, 0, merged.stdout + merged.stderr);
});

test('merge --wait-ci: pending checks are waited for; without it they stop the stack; --wait-ci is refused on plan', async t => {
  const s = stack(t, {}, { pendingViews: { 11: 2 } });
  const stopped = await s.run(['merge', '11', '--json'], allow);
  assert.equal(stopped.code, 1);
  assert.match(stopped.json().stopped.reasons.join('\n'), /PR #11 : contrôle\(s\) en cours : ci/);
  const w = stack(t, {}, { pendingViews: { 11: 4 } });
  const r = await w.run(['merge', '11', '--wait-ci', '2', '--json'], { ...allow, APV_STACK_CI_POLL_MS: '5' });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json().merged, [11]);
  assert.match(r.stderr, /PR #11 : contrôle\(s\) en cours \(ci\), attente de la CI \(--wait-ci, au plus 2 min\)\./);
  assert.equal((await w.run(['plan', '11', '--wait-ci', '1'])).code, 2);
  assert.equal((await w.run(['merge', '11', '--wait-ci', '0'], allow)).code, 2);
});
