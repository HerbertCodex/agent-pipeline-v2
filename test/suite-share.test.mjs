import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { copyPlace, enterQueue, queuePlaces } from '../dist/gates/suite.js';
import { LockStore } from '../dist/lock/store.js';

/**
 * `apv suite share` and the shared part of the queue of the full suites: loads that are not a full suite (a targeted
 * check, an e2e under `apv lock run`, a project script) wait for a suite, and a suite waits for them (slots: 1).
 */

const node = (code, ...args) => [process.execPath, '-e', code, ...args];
const owner = label => ({ pid: process.pid, host: hostname(), label });
const until = async (condition, ms = 20_000) => { const end = Date.now() + ms; while (!condition()) { if (Date.now() > end) throw new Error('condition not met'); await sleep(20); } };

function project(t, { gates = [], stacks = [], queue = {} } = {}) {
  const f = fixture(t);
  const dir = join(f.root, 'queue');
  mkdirSync(dir, { recursive: true });
  const lockFile = join(dir, 'full-suite.lock');
  write(f.repo, '.apv/config.json', { gates, ...(stacks.length ? { stacks } : {}), suite: { queue: { lockFile, waitMs: 15_000, ...queue } } });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  const env = { APV_LOCK_DIR: join(f.root, 'locks'), APV_LOCK_POLL_MS: '20' };
  const store = new LockStore(dir, { pollMs: 20 });
  /** A suite in the queue, as its copy place (taken first by every suite) or the whole queue. */
  const suiteHolds = async (t2, resource = copyPlace('full-suite', f.repo)) => {
    const held = await store.tryAcquire(resource, owner('suite de test'), 60);
    assert.ok(held.ok);
    let done = false;
    const release = async () => { if (!done) { done = true; await store.release(resource, { token: held.record.token }); } };
    t2.after(() => release().catch(() => {}));
    return release;
  };
  return { ...f, dir, lockFile, env, store, suiteHolds, settings: { enabled: true, lockFile, waitMs: 15_000, loadWaitMs: 0, slots: 1, ...queue } };
}

test('share waits for a full suite in progress, says so, then runs the command and returns its exit code', async t => {
  const p = project(t);
  const release = await p.suiteHolds(t);
  const mark = join(p.root, 'ran');
  const run = apv(p.repo, ['suite', 'share', '--', ...node(`require("fs").writeFileSync(${JSON.stringify(mark)}, ""); process.exit(7)`)], p.env);
  await sleep(400);
  assert.equal(existsSync(mark), false, 'not started while the suite holds the queue');
  await release();
  const r = await run;
  assert.equal(r.code, 7);
  assert.ok(existsSync(mark));
  assert.match(r.stderr, /Suite complète en cours \(exécution suite de test/);
});

test('share: --wait-ms exceeded while a suite holds the queue: refused, nothing runs', async t => {
  const p = project(t);
  await p.suiteHolds(t);
  const mark = join(p.root, 'ran');
  const r = await apv(p.repo, ['suite', 'share', '--wait-ms', '300', '--', ...node(`require("fs").writeFileSync(${JSON.stringify(mark)}, "")`)], p.env);
  assert.equal(r.code, 75);
  assert.equal(existsSync(mark), false);
});

test('two shares run at the same time', async t => {
  const p = project(t);
  const barrier = join(p.root, 'barrier');
  mkdirSync(barrier);
  const meet = (self, other) => node(`const fs = require("fs"); fs.writeFileSync(${JSON.stringify(join(barrier, self))}, "");
const end = Date.now() + 20000; while (!fs.existsSync(${JSON.stringify(join(barrier, other))}) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
process.exit(fs.existsSync(${JSON.stringify(join(barrier, other))}) ? 0 : 3)`);
  const [a, b] = await Promise.all([apv(p.repo, ['suite', 'share', '--', ...meet('a', 'b')], p.env), apv(p.repo, ['suite', 'share', '--', ...meet('b', 'a')], p.env)]);
  assert.deepEqual([a.code, b.code], [0, 0], 'each saw the other running');
});

test('a full suite (slots: 1) waits for a share in progress, and a new share waits behind the suite', async t => {
  const p = project(t);
  const go = join(p.root, 'go'); const started = join(p.root, 'started');
  const share = apv(p.repo, ['suite', 'share', '--', ...node(`const fs = require("fs"); fs.writeFileSync(${JSON.stringify(started)}, "");
while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)`)], p.env);
  await until(() => existsSync(started));
  const lines = [];
  let entered = false;
  const suite = enterQueue({ lockFile: p.lockFile, settings: p.settings, repo: p.repo, copy: p.repo, env: {}, log: l => lines.push(l), hooks: { lockPollMs: 20 } }).then(h => { entered = true; return h; });
  await until(() => lines.some(l => /Charges partagées en cours/.test(l)));
  assert.equal(entered, false, 'the suite does not start while the share runs');
  // A new share arrives: it waits behind the suite (which holds its places while it waits).
  const later = join(p.root, 'later');
  const second = apv(p.repo, ['suite', 'share', '--', ...node(`require("fs").writeFileSync(${JSON.stringify(later)}, "")`)], p.env);
  await sleep(300);
  assert.equal(existsSync(later), false);
  writeFileSync(go, '');
  assert.equal((await share).code, 0);
  const handle = await suite;
  assert.equal(existsSync(later), false, 'the new share still waits: the suite holds the queue');
  await handle.release();
  assert.equal((await second).code, 0);
  assert.ok(existsSync(later));
});

test('slots per-stack: the suite does not wait for a share, but a share still waits for any suite in progress', async t => {
  const p = project(t, { queue: { slots: 'per-stack' } });
  const go = join(p.root, 'go'); const started = join(p.root, 'started');
  const share = apv(p.repo, ['suite', 'share', '--', ...node(`const fs = require("fs"); fs.writeFileSync(${JSON.stringify(started)}, "");
while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)`)], p.env);
  await until(() => existsSync(started));
  const places = queuePlaces('per-stack', { used: ['1'], declared: ['1', '2'] });
  const handle = await enterQueue({ lockFile: p.lockFile, settings: p.settings, repo: p.repo, copy: p.repo, env: {}, log: () => {}, hooks: { lockPollMs: 20 }, places });
  writeFileSync(go, '');
  assert.equal((await share).code, 0);
  const mark = join(p.root, 'ran');
  const waiting = apv(p.repo, ['suite', 'share', '--', ...node(`require("fs").writeFileSync(${JSON.stringify(mark)}, "")`)], p.env);
  await sleep(300);
  assert.equal(existsSync(mark), false, 'a share waits for a suite of any slots');
  await handle.release();
  assert.equal((await waiting).code, 0);
});

test('apv gates run --stage task: a targeted check (affected) takes a shared part and waits for a suite', async t => {
  const mark = join(fixture(t).root, 'affected-ran');
  const p = project(t, { gates: [{ id: 'e2e', stage: 'full', timeoutMs: 30_000, command: node('process.exit(1)'), affected: node(`require("fs").writeFileSync(${JSON.stringify(mark)}, "")`, '{{baseSha}}') }] });
  const release = await p.suiteHolds(t);
  const lines = [];
  const run = apv(p.repo, ['gates', 'run', '--stage', 'task', '--base', 'HEAD~1'], p.env, { onStderr: s => { lines.push(s); } });
  await until(() => /Suite complète en cours/.test(lines.join('')));
  assert.equal(existsSync(mark), false);
  await release();
  const r = await run;
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.ok(existsSync(mark));
});

test('apv gates run --stage task: a check without stack lock nor targeted command does not wait for a suite', async t => {
  const p = project(t, { gates: [{ id: 'unit', command: node('process.exit(0)') }] });
  await p.suiteHolds(t);
  const r = await apv(p.repo, ['gates', 'run', '--stage', 'task'], p.env);
  assert.equal(r.code, 0, r.stderr + r.stdout);
});

test('apv lock run <resource of a stack> takes a shared part and waits for a suite; another resource does not', async t => {
  const p = project(t, { stacks: [{ id: '1', resource: 'pile-1' }] });
  const release = await p.suiteHolds(t);
  const other = await apv(p.repo, ['lock', 'run', 'autre', '--', ...node('process.exit(0)')], p.env);
  assert.equal(other.code, 0);
  const mark = join(p.root, 'ran');
  const lines = [];
  const run = apv(p.repo, ['lock', 'run', 'pile-1', '--', ...node(`require("fs").writeFileSync(${JSON.stringify(mark)}, "")`)], p.env, { onStderr: s => { lines.push(s); } });
  await until(() => /Suite complète en cours/.test(lines.join('')));
  assert.equal(existsSync(mark), false);
  await release();
  assert.equal((await run).code, 0);
  assert.ok(existsSync(mark));
});

test('inside a full suite (APV_SUITE_RUN) or another share, share does not wait', async t => {
  const p = project(t);
  await p.suiteHolds(t);
  const inSuite = await apv(p.repo, ['suite', 'share', '--', ...node('process.exit(0)')], { ...p.env, APV_SUITE_RUN: 'x' });
  assert.equal(inSuite.code, 0);
  const inShare = await apv(p.repo, ['suite', 'share', '--', ...node('process.exit(0)')], { ...p.env, APV_SUITE_SHARE: 'full-suite' });
  assert.equal(inShare.code, 0);
});

test('a share held past suite.queue.shareMaxMs is no longer waited for by a full suite, said so (review 1786b40, M2)', async t => {
  const p = project(t, { queue: { shareMaxMs: 400 } });
  const go = join(p.root, 'go'); const started = join(p.root, 'started');
  const share = apv(p.repo, ['suite', 'share', '--', ...node(`const fs = require("fs"); fs.writeFileSync(${JSON.stringify(started)}, "");
while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)`)], p.env);
  t.after(() => { try { writeFileSync(go, ''); } catch { /* already removed */ } });
  await until(() => existsSync(started));
  const lines = [];
  const begun = Date.now();
  const handle = await enterQueue({ lockFile: p.lockFile, settings: p.settings, repo: p.repo, copy: p.repo, env: {}, log: l => lines.push(l), hooks: { lockPollMs: 20 } });
  assert.ok(Date.now() - begun < 10_000, 'entered well before waitMs (15 s)');
  assert.ok(lines.some(l => /Charge partagée [\s\S]* au-delà de sa durée maximale \(400 ms, suite\.queue\.shareMaxMs\) : la suite complète ne l'attend plus/.test(l)), lines.join('\n'));
  assert.equal(existsSync(go), false, 'the share still runs: the suite no longer waits for it');
  await handle.release();
  writeFileSync(go, '');
  assert.equal((await share).code, 0);
  // Within its longest, the share is waited for (the default 2 h).
  const q = project(t);
  const go2 = join(q.root, 'go'); const started2 = join(q.root, 'started');
  const held = apv(q.repo, ['suite', 'share', '--', ...node(`const fs = require("fs"); fs.writeFileSync(${JSON.stringify(started2)}, "");
while (!fs.existsSync(${JSON.stringify(go2)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)`)], q.env);
  t.after(() => { try { writeFileSync(go2, ''); } catch { /* already removed */ } });
  await until(() => existsSync(started2));
  await assert.rejects(enterQueue({ lockFile: q.lockFile, settings: { ...q.settings, waitMs: 600 }, repo: q.repo, copy: q.repo, env: {}, log: () => {}, hooks: { lockPollMs: 20 } }),
    /charge\(s\) partagée\(s\) encore en cours/);
  writeFileSync(go2, '');
  assert.equal((await held).code, 0);
});
