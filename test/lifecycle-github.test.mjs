import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishSpec, syncSpec, githubRepository } from '../dist/lifecycle/github.js';
import { fixture, approved, oneTask, git, passingQa } from './lifecycle-helpers.mjs';
const noQa = { workflow: { qaLanes: [], maxQaRepairs: 0, maxActiveMs: 60000 } };
async function ready(t) { const f = fixture(t, noQa); let doc = await approved(f, oneTask()); doc = await f.life.run(doc.id); doc = await f.life.review(doc.id, doc.data.currentSha, 'Test Reviewer', 'Inspected the complete candidate and fixtures.'); const options = { repository: 'example/demo', remote: 'origin', branch: 'feature/test-pipeline', base: git(f.repo, 'symbolic-ref', '--short', 'HEAD'), confirmPush: true, confirmPr: true }; return { ...f, doc, options }; }
function fake(f) {
    const calls = [];
    const state = { pushed: false, created: false, prState: 'OPEN', sha: f.doc.data.currentSha, base: f.doc.data.baseSha, url: 'https://github.com/example/demo/pull/17', remote: 'https://github.com/example/demo.git', countCreates: 0, failAfterCreate: false, ambiguous: false };
    const pr = () => ({ number: 17, url: state.url, state: state.prState, headRefOid: state.sha, headRefName: f.options.branch, baseRefName: f.options.base, isCrossRepository: false, mergedAt: state.prState === 'MERGED' ? '2026-09-12T16:00:00Z' : null, mergeCommit: state.prState === 'MERGED' ? { oid: 'f'.repeat(40) } : null });
    const transport = async (r) => {
        calls.push(r);
        const a = r.command;
        if (a[0] === 'git' && a[1] === 'remote')
            return state.remote + '\n';
        if (a[0] === 'gh' && a[2] === 'list')
            return JSON.stringify(state.created ? (state.ambiguous ? [pr(), pr()] : [pr()]) : []);
        if (a[0] === 'git' && a[1] === 'ls-remote') {
            let rows = [];
            if (a.includes('refs/heads/' + f.options.base))
                rows.push(state.base + '\trefs/heads/' + f.options.base);
            if (a.includes('refs/heads/' + f.options.branch) && state.pushed)
                rows.push(state.sha + '\trefs/heads/' + f.options.branch);
            return rows.join('\n') + '\n';
        }
        if (a[0] === 'git' && a.includes('push')) {
            state.pushed = true;
            return 'ok\n';
        }
        if (a[0] === 'gh' && a[2] === 'create') {
            state.created = true;
            state.countCreates++;
            if (state.failAfterCreate)
                throw new Error('Simulated connection loss after server created PR');
            return state.url + '\n';
        }
        if (a[0] === 'gh' && a[2] === 'view')
            return JSON.stringify(pr());
        throw new Error('Unexpected fake command: ' + a.join(' '));
    };
    return { calls, state, transport };
}
for (const url of ['https://github.com/example/demo.git', 'git@github.com:example/demo.git', 'ssh://git@github.com/example/demo.git', 'https://github.com/example/demo'])
    test('GitHub remote parser accepts ' + url, () => assert.equal(githubRepository(url), 'example/demo'));
for (const url of ['https://user:password@github.com/example/demo.git', 'https://evil.test/example/demo', 'file:///tmp/repo', 'ext::bad', 'https://github.com/../demo', 'https://github.com/example/demo?other=1'])
    test('GitHub remote parser rejects ' + url, () => assert.throws(() => githubRepository(url)));
test('publish requires separate push and PR consent before transport', async (t) => { const f = await ready(t); const fakeGh = fake(f); await assert.rejects(publishSpec(f.life, f.doc.id, { ...f.options, confirmPush: false }, fakeGh.transport), /consent/); assert.equal(fakeGh.calls.length, 0); });
test('publish creates exact-head draft PR and never invokes a merge or force push', async (t) => { const f = await ready(t); const g = fake(f); const head = git(f.repo, 'rev-parse', 'HEAD'); const d = await publishSpec(f.life, f.doc.id, f.options, g.transport); assert.equal(d.data.publication.state, 'pr_open'); assert.equal(g.state.countCreates, 1); assert.ok(g.calls.find(c => c.command.includes('create')).command.includes('--draft')); assert.ok(!g.calls.some(c => c.command.includes('merge') || c.command.includes('--force') || c.command.includes('--force-with-lease'))); assert.equal(git(f.repo, 'rev-parse', 'HEAD'), head); });
test('retry after unknown create outcome reconciles existing PR instead of duplicating', async (t) => { const f = await ready(t); const g = fake(f); g.state.failAfterCreate = true; await assert.rejects(publishSpec(f.life, f.doc.id, f.options, g.transport), /connection loss/); assert.equal(f.life.get(f.doc.id).data.publication.state, 'pushed'); g.state.failAfterCreate = false; const d = await publishSpec(f.life, f.doc.id, f.options, g.transport); assert.equal(g.state.countCreates, 1); assert.equal(d.data.publication.url, g.state.url); });
test('remote repository mismatch prevents push', async (t) => { const f = await ready(t); const g = fake(f); g.state.remote = 'https://github.com/other/repo.git'; await assert.rejects(publishSpec(f.life, f.doc.id, f.options, g.transport), /authorized/); assert.equal(g.state.pushed, false); });
test('moving remote base prevents publishing unintegrated candidate', async (t) => { const f = await ready(t); const g = fake(f); g.state.base = 'd'.repeat(40); await assert.rejects(publishSpec(f.life, f.doc.id, f.options, g.transport), /Remote base/); assert.equal(g.state.pushed, false); });
test('existing remote branch with different head is not overwritten', async (t) => { const f = await ready(t); const g = fake(f); g.state.pushed = true; g.state.sha = 'd'.repeat(40); await assert.rejects(publishSpec(f.life, f.doc.id, f.options, g.transport), /never force/); assert.ok(!g.calls.some(c => c.command.includes('push'))); });
test('publication intent cannot be silently retargeted', async (t) => { const f = await ready(t); const g = fake(f); await publishSpec(f.life, f.doc.id, f.options, g.transport); await assert.rejects(publishSpec(f.life, f.doc.id, { ...f.options, branch: 'feature/other' }, g.transport), /different parameters/); });
test('sync refuses changed PR head instead of closing a spec', async (t) => { const f = await ready(t); const g = fake(f); await publishSpec(f.life, f.doc.id, f.options, g.transport); g.state.prState = 'MERGED'; g.state.sha = 'e'.repeat(40); await assert.rejects(syncSpec(f.life, f.doc.id, undefined, g.transport), /head\/base/); assert.notEqual(f.life.get(f.doc.id).data.status, 'closed'); });
test('sync closes only on observed merged exact-head PR', async (t) => { const f = await ready(t); const g = fake(f); await publishSpec(f.life, f.doc.id, f.options, g.transport); let d = await syncSpec(f.life, f.doc.id, undefined, g.transport); assert.notEqual(d.data.status, 'closed'); g.state.prState = 'MERGED'; d = await syncSpec(f.life, f.doc.id, undefined, g.transport); assert.equal(d.data.status, 'closed'); assert.equal(d.data.publication.mergeSha, 'f'.repeat(40)); });
test('closed-unmerged PR blocks rather than marks delivered', async (t) => { const f = await ready(t); const g = fake(f); await publishSpec(f.life, f.doc.id, f.options, g.transport); g.state.prState = 'CLOSED'; const d = await syncSpec(f.life, f.doc.id, undefined, g.transport); assert.equal(d.data.status, 'blocked'); assert.equal(d.data.error.code, 'PR_CLOSED'); });

// Observed on a real project: the operator wanted to read the candidate in a PR before approving it, and
// publish refused because it required the approval first; the branch had to be pushed by hand.
async function awaitingReview(t) { const f = fixture(t, noQa); let doc = await approved(f, oneTask()); doc = await f.life.run(doc.id); const options = { repository: 'example/demo', remote: 'origin', branch: 'feature/read-me', base: git(f.repo, 'symbolic-ref', '--short', 'HEAD'), confirmPush: true, confirmPr: true }; return { ...f, doc, options }; }
test('a draft PR can be opened for reading before approval, and its merge does not close an unreviewed spec', async (t) => {
  const f = await awaitingReview(t);
  assert.equal(f.doc.data.status, 'awaiting_review');
  const g = fake(f);
  await assert.rejects(publishSpec(f.life, f.doc.id, f.options, g.transport), /Only ready runs/, 'delivery publication still requires the review');
  let d = await publishSpec(f.life, f.doc.id, { ...f.options, forReview: true }, g.transport);
  assert.equal(d.data.publication.purpose, 'review');
  assert.equal(d.data.publication.state, 'pr_open');
  const create = g.calls.find(c => c.command[0] === 'gh' && c.command[2] === 'create');
  assert.ok(create.command.includes('--draft'));
  assert.match(create.input, /BEFORE operator approval/);

  g.state.prState = 'MERGED';
  d = await syncSpec(f.life, f.doc.id, undefined, g.transport);
  assert.equal(d.data.status, 'blocked', 'a merge observed before the review does not close the spec');
  assert.equal(d.data.error.code, 'MERGED_BEFORE_REVIEW');
  assert.match(f.life.summary(d).nextAction, /spec review .* --approve/);

  d = await f.life.review(d.id, d.data.currentSha, 'Test Reviewer', 'Read the candidate in the draft PR, then approved it.');
  d = await syncSpec(f.life, f.doc.id, undefined, g.transport);
  assert.equal(d.data.status, 'closed');
  assert.ok(!g.calls.some(c => c.command.includes('merge') || c.command.includes('--force')), 'the controller never merges nor force-pushes');
});

test('a merged candidate whose review requests changes is told what actually blocks it', async (t) => {
    const f = fixture(t, { workflow: { maxActiveMs: 180000 } });
    // The whole demonstration spec: the scripted reviewer passes it, which is what publishing needs.
    let doc = await approved(f);
    doc = await f.life.run(doc.id);
    assert.equal(doc.data.qa.report.verdict, 'pass');
    f.doc = doc;
    f.options = { repository: 'example/demo', remote: 'origin', branch: 'feature/test-pipeline',
        base: git(f.repo, 'symbolic-ref', '--short', 'HEAD'), confirmPush: true, confirmPr: true };
    const g = fake(f);
    await publishSpec(f.life, doc.id, { ...f.options, forReview: true }, g.transport);
    g.state.prState = 'MERGED';
    doc = await syncSpec(f.life, doc.id, undefined, g.transport);
    assert.equal(doc.data.error.code, 'MERGED_BEFORE_REVIEW');

    // A later quality review on the same candidate requests changes: the review the spec is being
    // asked to record can no longer be recorded, and saying "apv2 spec review" alone sends the
    // operator around a loop. Observed on a real project after a revalidation.
    await f.life.importQa(doc.id, { ...passingQa(doc), verdict: 'changes_requested',
        summary: 'Fixture review requesting a correction after the merge.',
        findings: [{ id: 'F-LATE', severity: 'major', resolution: 'required', path: 'src/math.mjs',
            description: 'Fixture finding raised after the pull request was merged.' }] });
    doc = await syncSpec(f.life, doc.id, undefined, g.transport);
    assert.equal(doc.data.error.code, 'MERGED_BEFORE_REVIEW');
    const advice = f.life.summary(doc).nextAction;
    assert.match(advice, /quality review requests changes/);
    assert.match(advice, /spec qa-repair|follow-up spec/);
});
