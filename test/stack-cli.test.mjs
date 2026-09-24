import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apv } from './cli-helpers.mjs';
import { REASONS } from '../hooks/scripts/bash-guard.mjs';
import { MERGE_REFUSED, anomalies, readChecks } from '../dist/stack/github.js';

const fakeGh = fileURLToPath(new URL('./support/fake-gh.mjs', import.meta.url));
chmodSync(fakeGh, 0o755);

const pr = (number, base, head, extra = {}) => ({
  number, state: 'OPEN', isDraft: false, baseRefName: base, headRefName: head, headRefOid: `${String(number).repeat(40)}`.slice(0, 40),
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...extra,
});

/** A stack of three pull requests: #11 on main, #12 on #11, #13 on #12. */
function stack(t, overrides = {}, behavior = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'apv3-stack-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prs = { 11: pr(11, 'main', 'spec/1'), 12: pr(12, 'spec/1', 'spec/2'), 13: pr(13, 'spec/2', 'spec/3') };
  for (const [n, fields] of Object.entries(overrides)) Object.assign(prs[n], fields);
  const file = join(dir, 'gh.json');
  writeFileSync(file, JSON.stringify({ prs, behavior, calls: [] }));
  const env = { APV_GH: fakeGh, FAKE_GH_STATE: file, APV_STACK_POLL_MS: '5', APV_STACK_POLL_ATTEMPTS: '3', APV_ALLOW_MERGE: '' };
  return {
    dir, env,
    run: (args, extra = {}) => apv(dir, ['stack', ...args], { ...env, ...extra }),
    state: () => JSON.parse(readFileSync(file, 'utf8')),
    writes: () => JSON.parse(readFileSync(file, 'utf8')).calls.filter(c => c[1] !== 'view').map(c => c.join(' ')),
  };
}
const allow = { APV_ALLOW_MERGE: '1' };

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
  assert.match(r.stdout, /Cible : main\n1\. PR #11 : spec\/1 -> main, MERGEABLE\/CLEAN, contrôles 1\/1 au vert : ok\n2\. PR #12 : spec\/2 -> spec\/1/);
  assert.match(r.stdout, /Pile cohérente\./);
  assert.deepEqual(s.writes(), []);
  const j = await s.run(['plan', '11', '12', '13', '--json']);
  assert.equal(j.json().ok, true);
  assert.deepEqual(j.json().prs.map(p => p.expectedBase), ['main', 'spec/1', 'spec/2']);
  assert.equal(j.json().calls.length, 3);
  assert.equal(j.json().calls[0].args.join(' '), 'pr view 11 --json number,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,url');
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
  const s = stack(t);
  const r = await s.run(['merge', '11', '12', '13'], allow);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(s.writes(), [
    `pr merge 11 --merge --match-head-commit ${'1'.repeat(40)}`,
    'api -X PATCH repos/o/r/pulls/12 -f base=main', `pr merge 12 --merge --match-head-commit ${'12'.repeat(20)}`,
    'api -X PATCH repos/o/r/pulls/13 -f base=main', `pr merge 13 --merge --match-head-commit ${'13'.repeat(20)}`,
  ]);
  const prs = s.state().prs;
  assert.deepEqual(Object.values(prs).map(p => [p.state, p.baseRefName]), [['MERGED', 'main'], ['MERGED', 'main'], ['MERGED', 'main']]);
  assert.match(r.stdout, /\$ .*fake-gh\.mjs api -X PATCH repos\/o\/r\/pulls\/12 -f base=main\n\{"number":12,"state":"open","base":\{"ref":"main"\}.*\n\(code de sortie 0\)/);
  assert.match(r.stdout, /✓ Merged pull request o\/r#13 \(spec\/3\)/);
  assert.match(r.stdout, /"baseRefName":"main"/, 'the whole view output is shown');
  assert.match(r.stdout, /fusionnées : #11, #12, #13\nPile fusionnée dans main\./);
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
  assert.deepEqual(s.writes(), [`pr merge 11 --merge --match-head-commit ${'1'.repeat(40)}`, 'api -X PATCH repos/o/r/pulls/12 -f base=main']);
  assert.deepEqual(Object.values(s.state().prs).map(p => p.state), ['MERGED', 'OPEN', 'OPEN']);
});

test('a failed retarget call stops the stack, its whole output shown, the base read again', async t => {
  const failed = stack(t, {}, { retargetFail: [12] });
  const f = await failed.run(['merge', '11', '12', '13'], allow);
  assert.equal(f.code, 1);
  assert.match(f.stdout, /\$ .*api -X PATCH repos\/o\/r\/pulls\/12 -f base=main\n\{"message":"Validation Failed".*\ngh: Validation Failed \(HTTP 422\)\n\(code de sortie 1\)/);
  assert.match(f.stdout, /ARRÊT à la PR #12 :\n- re-ciblage de la PR #12 en échec \(gh api : code 1\) ; relue, elle vise spec\/1/);
  assert.deepEqual(failed.writes(), [`pr merge 11 --merge --match-head-commit ${'1'.repeat(40)}`, 'api -X PATCH repos/o/r/pulls/12 -f base=main']);
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
  assert.deepEqual(s.writes(), [`pr merge 11 --merge --match-head-commit ${'1'.repeat(40)}`, 'api -X PATCH repos/o/r/pulls/12 -f base=main']);
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
  assert.deepEqual(refused.writes(), [`pr merge 11 --merge --match-head-commit ${'1'.repeat(40)}`]);
});

test('merge: a head that moved is refused by GitHub, drafts need --ready, mergeability is awaited', async t => {
  // The merge carries the head read just before it: a head that moved since is refused by GitHub, and the stack stops.
  const updated = stack(t, {}, { afterMerge: { 11: { 12: { headRefOid: 'f'.repeat(40) } } } });
  const r = await updated.run(['merge', '11', '12', '--method', 'squash'], allow);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(updated.writes().filter(w => w.startsWith('pr merge')), [`pr merge 11 --squash --match-head-commit ${'1'.repeat(40)}`, `pr merge 12 --squash --match-head-commit ${'f'.repeat(40)}`]);
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
  assert.deepEqual(drafts.writes(), ['pr ready 11', `pr merge 11 --merge --match-head-commit ${'1'.repeat(40)}`]);
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
