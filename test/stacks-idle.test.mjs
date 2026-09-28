import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { LockStore } from '../dist/lock/store.js';
import { configIssues } from '../dist/config/load.js';

/** Idle test stacks (docs/APV3-SPEC.md, section 18.4): stopped only on a continuous series of free observations. */

const hasFlock = spawnSync('flock', ['--version']).status === 0;
const node = code => [process.execPath, '-e', code];
const marker = (file, text) => node(`require("fs").appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(`${text}\n`)})`);
const freePort = () => new Promise(done => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });
const minutes = n => n * 60_000;

async function project(t, { ports = [] } = {}) {
  const f = fixture(t);
  const log = join(f.root, 'actions.log');
  const lock1 = join(f.root, 'pilot', 's1.lock');
  mkdirSync(join(f.root, 'pilot'));
  writeFileSync(lock1, '');
  const config = {
    gates: [{ id: 'e2e', stage: 'full', command: node('0'), lock: { file: lock1 } }],
    stacks: [
      { id: '1', lockFile: lock1, dockerProject: 'proj', ...(ports.length ? { ports } : {}), stop: marker(log, 'stop 1'), start: marker(log, 'start 1') },
      { id: '2', resource: 'pile-2', dockerProject: 'proj-2', stop: marker(log, 'stop 2') },
    ],
  };
  write(f.repo, '.apv/config.json', config);
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  const common = realpathSync(resolve(f.repo, git(f.repo, 'rev-parse', '--git-common-dir')));
  const lockDir = join(f.root, 'locks');
  const env = { APV_LOCK_DIR: lockDir, APV_LOCK_POLL_MS: '20' };
  const record = id => JSON.parse(readFileSync(join(common, 'apv', 'stacks', `${id}.json`), 'utf8'));
  /** Primes the record of a stack as if earlier passes had observed it. */
  const prime = (id, fields) => {
    mkdirSync(join(common, 'apv', 'stacks'), { recursive: true });
    const base = { version: 1, id, lastObservedAt: null, lastUsedAt: null, freeSince: null, stoppedAt: null, startedAt: null };
    const at = ms => ms === null ? null : new Date(Date.now() - ms).toISOString();
    writeFileSync(join(common, 'apv', 'stacks', `${id}.json`), JSON.stringify({ ...base, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, at(v)])) }));
  };
  const actions = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  const run = (...args) => apv(f.repo, ['stacks', ...args], env);
  return { ...f, config, common, lock1, lockDir, env, record, prime, actions, run, log };
}
const decision = (r, id) => r.json().decisions.find(d => d.id === id);

test('configuration: stacks are validated (a lock, unique ids, lock files and projects)', () => {
  const issues = raw => configIssues(raw).issues.map(i => i.message).join('\n');
  assert.equal(issues({ stacks: [{ id: '1', lockFile: '/a.lock' }, { id: '2', resource: 'e2e-2' }] }), '');
  assert.match(issues({ stacks: [{ id: '1' }] }), /stacks\.1: declare its lock/);
  assert.match(issues({ stacks: [{ id: '1', lockFile: '/a.lock' }, { id: '1', lockFile: '/b.lock' }] }), /duplicate id 1/);
  assert.match(issues({ stacks: [{ id: '1', lockFile: '/a.lock' }, { id: '2', lockFile: '/a.lock' }] }), /duplicate lockFile/);
  assert.match(issues({ stacks: [{ id: '1', lockFile: '/a.lock', idleAfterMs: 5 }] }), /idleAfterMs/);
  assert.match(issues({ stacks: [{ id: 'x y', lockFile: '/a.lock' }] }), /id/);
  assert.deepEqual(configIssues({}).issues, []);
});

test('a single pass never stops a stack; a continuous free series past the delay stops it, once, journaled', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = await project(t);
  const first = await p.run('idle-stop', '--json');
  assert.equal(first.code, 0, first.stderr);
  assert.match(decision(first, '1').reason, /libre depuis 0 s d'observations suivies \(seuil 30 min\)/);
  assert.deepEqual(p.actions(), []);
  // Earlier passes, 20 s apart at most, saw it free for 31 minutes.
  p.prime('1', { lastObservedAt: 20_000, freeSince: minutes(31) });
  const second = await p.run('idle-stop', '--stack', '1', '--json');
  assert.equal(second.code, 0, second.stderr);
  assert.equal(decision(second, '1').action, 'stopped');
  assert.deepEqual(p.actions(), ['stop 1']);
  assert.ok(p.record('1').stoppedAt);
  const events = readFileSync(join(p.common, 'apv', 'stacks', 'events.log'), 'utf8');
  assert.match(events, /"event":"stopped","stack":"1"/);
  // Already stopped, no use since: never stopped twice.
  const third = await p.run('idle-stop', '--stack', '1', '--json');
  assert.match(decision(third, '1').reason, /déjà arrêtée/);
  assert.deepEqual(p.actions(), ['stop 1']);
  // Restarted: the stack may be stopped again after a new idle series.
  const started = await p.run('start', '1');
  assert.equal(started.code, 0, started.stdout + started.stderr);
  assert.deepEqual(p.actions(), ['stop 1', 'start 1']);
  assert.ok(p.record('1').startedAt >= p.record('1').stoppedAt);
});

test('observations further apart than 2 minutes restart the series; a known use moves its start', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = await project(t);
  p.prime('1', { lastObservedAt: minutes(5), freeSince: minutes(60) });
  const gap = await p.run('idle-stop', '--stack', '1', '--json');
  assert.equal(decision(gap, '1').action, 'kept');
  assert.match(decision(gap, '1').reason, /libre depuis 0 s/);
  p.prime('1', { lastObservedAt: 10_000, freeSince: minutes(40), lastUsedAt: minutes(5) });
  const used = await p.run('idle-stop', '--stack', '1', '--json');
  assert.match(decision(used, '1').reason, /libre depuis 5 min/);
  assert.deepEqual(p.actions(), []);
  // A lease event of the stack's resource is a known use too.
  const store = new LockStore(p.lockDir);
  const held = await store.tryAcquire('pile-2', { pid: process.pid, host: hostname(), label: 'test' }, 60);
  await store.release('pile-2', { token: held.record.token });
  p.prime('2', { lastObservedAt: 10_000, freeSince: minutes(40) });
  const lease = await p.run('idle-stop', '--stack', '2', '--json');
  assert.equal(decision(lease, '2').action, 'kept');
  assert.match(decision(lease, '2').reason, /libre depuis \d+ s/);
});

test('a stack is busy while its lock is held, a full suite runs, or its ports listen: never stopped', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const port = await freePort();
  const p = await project(t, { ports: [port] });
  // Its flock held by another process.
  // Its own process group: flock and the sleep that inherits the locked descriptor are killed together.
  const holder = spawn('flock', [p.lock1, 'sleep', '10'], { stdio: 'ignore', detached: true });
  const killHolder = () => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* gone */ } };
  t.after(killHolder);
  await sleep(300);
  p.prime('1', { lastObservedAt: 10_000, freeSince: minutes(40) });
  const locked = await p.run('idle-stop', '--stack', '1', '--json');
  assert.match(decision(locked, '1').reason, /occupée : verrou .*s1\.lock tenu/);
  assert.equal(p.record('1').freeSince, null);
  killHolder();
  await new Promise(done => holder.once('exit', done));
  await sleep(100);
  // The lease of stack 2 held.
  const store = new LockStore(p.lockDir);
  const lease = await store.tryAcquire('pile-2', { pid: process.pid, host: hostname(), label: 'test' }, 60);
  p.prime('2', { lastObservedAt: 10_000, freeSince: minutes(40) });
  assert.match(decision(await p.run('idle-stop', '--stack', '2', '--json'), '2').reason, /bail pile-2 tenu/);
  await store.release('pile-2', { token: lease.record.token });
  // A full suite running (the queue of the full suites held).
  const queue = new LockStore(join(p.common, 'apv', 'locks'));
  const suite = await queue.tryAcquire('full-suite', { pid: process.pid, host: hostname(), label: 'suite' }, 60);
  p.prime('1', { lastObservedAt: 10_000, freeSince: minutes(40) });
  assert.match(decision(await p.run('idle-stop', '--stack', '1', '--json'), '1').reason, /suite complète en cours/);
  await queue.release('full-suite', { token: suite.record.token });
  // A server listening on its ports.
  const server = createServer();
  await new Promise(done => server.listen(port, '127.0.0.1', done));
  p.prime('1', { lastObservedAt: 10_000, freeSince: minutes(40) });
  assert.match(decision(await p.run('idle-stop', '--stack', '1', '--json'), '1').reason, new RegExp(`port\\(s\\) à l'écoute : ${port}`));
  await new Promise(done => server.close(done));
  assert.deepEqual(p.actions(), []);
  // Free again, the dry run says what it would do and does nothing.
  p.prime('1', { lastObservedAt: 10_000, freeSince: minutes(40) });
  assert.equal(decision(await p.run('idle-stop', '--stack', '1', '--dry-run', '--json'), '1').action, 'would-stop');
  assert.deepEqual(p.actions(), []);
});

test('a check of apv gates run under the lock of a stack notes its use', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = await project(t);
  const r = await apv(p.repo, ['gates', 'run', '--json'], p.env);
  assert.equal(r.code, 0, r.stderr);
  const used = Date.parse(p.record('1').lastUsedAt);
  assert.ok(Date.now() - used < 60_000, 'use noted');
  assert.equal(p.record('1').freeSince, null);
});

test('--watch passes again until the stack is stopped; status shows the stacks', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = await project(t);
  p.prime('1', { lastObservedAt: 1000, freeSince: 59_000 });
  const r = await p.run('idle-stop', '--stack', '1', '--after', '1m', '--watch', '--interval', '0.3', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.json().passes >= 2, 'more than one pass');
  assert.equal(decision(r, '1').action, 'stopped');
  assert.deepEqual(p.actions(), ['stop 1']);
  const status = await p.run('status', '--json');
  assert.deepEqual(status.json().stacks.map(s => s.id), ['1', '2']);
  assert.ok(status.json().stacks[0].stoppedAt);
  const human = await p.run('status');
  assert.match(human.stdout, /pile 1 : arrêt .* ; redémarrage apv stacks start 1/);
  assert.match(human.stdout, /pile 2 : arrêt .* ; redémarrage non déclaré/);
  const unknown = await p.run('idle-stop', '--stack', '9');
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Pile inconnue : 9/);
});
