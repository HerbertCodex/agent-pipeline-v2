import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { run } from '../dist/commands/lock.js';
import { LockStore, parseDuration, sanitizeResource, defaultLockDir, isPidAlive, parseRecord } from '../dist/lock/store.js';

const LOCK_MODULE = new URL('../dist/commands/lock.js', import.meta.url).href;
const RUNNER = 'const m = await import(process.argv[1]); process.exitCode = await m.run(process.argv.slice(2), { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), cwd: process.cwd(), env: process.env });';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'apv-lock-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Runs `apv lock ...` in a real child process. */
function cli(dir, args, env = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', RUNNER, LOCK_MODULE, ...args], {
    env: { ...process.env, APV_LOCK_DIR: dir, APV_LOCK_POLL_MS: '30', APV_LOCK_HELD: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, done };
}

function captureIO(env = {}) {
  const out = { stdout: '', stderr: '' };
  const io = { stdout: (s) => { out.stdout += s; }, stderr: (s) => { out.stderr += s; }, cwd: process.cwd(), env: { APV_LOCK_POLL_MS: '30', ...env } };
  return { io, out };
}

const nodeCmd = (code) => ['--', process.execPath, '-e', code];

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error('condition not reached in time');
}

function writeRecord(dir, resource, overrides = {}) {
  const now = Date.now();
  const record = {
    version: 1, resource, token: 'deadbeef', purpose: 'test',
    owner: { pid: process.pid, host: hostname(), label: 'ancien' },
    acquiredAt: new Date(now - 60_000).toISOString(),
    heartbeatAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString(),
    ttlSeconds: 900,
    ...overrides,
  };
  writeFileSync(join(dir, `${sanitizeResource(resource)}.lock`), JSON.stringify(record));
  return record;
}

const events = (dir) => existsSync(join(dir, 'events.log'))
  ? readFileSync(join(dir, 'events.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  : [];

test('parseDuration accepts seconds and units, rejects garbage', () => {
  assert.equal(parseDuration('900', '--ttl'), 900);
  assert.equal(parseDuration('15m', '--ttl'), 900);
  assert.equal(parseDuration('2h', '--ttl'), 7200);
  assert.equal(parseDuration('1.5s', '--ttl'), 1.5);
  assert.throws(() => parseDuration('dix', '--ttl'), /durée invalide pour --ttl/);
  assert.throws(() => parseDuration('-5', '--wait'), /durée invalide/);
});

test('sanitizeResource keeps safe names and neutralizes paths', () => {
  assert.equal(sanitizeResource('supabase-db'), 'supabase-db');
  assert.equal(sanitizeResource('../etc/passwd'), '___etc_passwd');
  assert.equal(sanitizeResource(' port:5433 '), 'port_5433');
  assert.throws(() => sanitizeResource('   '), /vide/);
  assert.equal(sanitizeResource('x'.repeat(300)).length, 120);
});

test('defaultLockDir honours APV_LOCK_DIR then XDG_STATE_HOME then HOME', () => {
  assert.equal(defaultLockDir({ APV_LOCK_DIR: '/a' }), '/a');
  assert.equal(defaultLockDir({ XDG_STATE_HOME: '/s' }), '/s/apv/locks');
  assert.equal(defaultLockDir({ HOME: '/h' }), '/h/.local/state/apv/locks');
});

test('isPidAlive and parseRecord edge cases', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(0), true, 'unknown pid is never treated as dead');
  assert.equal(parseRecord('{'), null);
  assert.equal(parseRecord(JSON.stringify({ resource: 'x', token: 't', owner: { pid: 1, host: 'h', label: 'l' }, acquiredAt: 'nope', expiresAt: 'nope', heartbeatAt: 'nope' })), null);
});

test('two concurrent run calls on the same resource are serialized (real processes)', async (t) => {
  const dir = tempDir(t);
  const log = join(dir, 'trace.txt');
  const body = (id) => `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'start ${id}\\n');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},'end ${id}\\n')},300)`;
  const a = cli(dir, ['run', 'db', '--ttl', '30', '--wait', '20', ...nodeCmd(body('a'))]);
  const b = cli(dir, ['run', 'db', '--ttl', '30', '--wait', '20', ...nodeCmd(body('b'))]);
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.code, 0, ra.stderr);
  assert.equal(rb.code, 0, rb.stderr);
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^start (a|b)$/);
  const first = lines[0].split(' ')[1];
  assert.deepEqual(lines.slice(0, 2), [`start ${first}`, `end ${first}`], `overlap detected: ${lines.join(', ')}`);
  assert.equal(existsSync(join(dir, 'db.lock')), false, 'lock released after both runs');
  const waited = ra.stderr + rb.stderr;
  assert.match(waited, /Attente du verrou « db » : tenu par .*position 1 sur 1/);
});

test('run returns the command exit code and releases the lock even on failure', async (t) => {
  const dir = tempDir(t);
  const r = await cli(dir, ['run', 'db', ...nodeCmd('process.exit(7)')]).done;
  assert.equal(r.code, 7);
  assert.equal(existsSync(join(dir, 'db.lock')), false);
  const missing = await cli(dir, ['run', 'db', '--', '/definitely/missing/apv-binary']).done;
  assert.equal(missing.code, 127);
  assert.match(missing.stderr, /Impossible de lancer/);
  assert.equal(existsSync(join(dir, 'db.lock')), false);
});

test('run exports APV_LOCK_HELD and keeps the lease alive while the command runs', async (t) => {
  const dir = tempDir(t);
  const out = join(dir, 'env.txt');
  const r = cli(dir, ['run', 'e2e', '--ttl', '1', ...nodeCmd(`require('fs').writeFileSync(${JSON.stringify(out)}, process.env.APV_LOCK_HELD);setTimeout(()=>{},1600)`)], { APV_LOCK_HELD: 'other' });
  await waitFor(() => existsSync(join(dir, 'e2e.lock')) && existsSync(out));
  const first = JSON.parse(readFileSync(join(dir, 'e2e.lock'), 'utf8'));
  await sleep(1200);
  const later = JSON.parse(readFileSync(join(dir, 'e2e.lock'), 'utf8'));
  assert.equal(later.token, first.token);
  assert.ok(Date.parse(later.heartbeatAt) > Date.parse(first.heartbeatAt), 'heartbeat renewed');
  assert.ok(Date.parse(later.expiresAt) > Date.now(), 'lease never expires while the command runs');
  const res = await r.done;
  assert.equal(res.code, 0, res.stderr);
  assert.equal(readFileSync(out, 'utf8'), 'other,e2e');
});

test('an expired lock is taken over and the takeover is logged', async (t) => {
  const dir = tempDir(t);
  writeRecord(dir, 'db', { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const r = await cli(dir, ['run', 'db', '--wait', '0', ...nodeCmd('process.exit(0)')]).done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /repris \(expired\) à ancien/);
  const takeover = events(dir).find((e) => e.event === 'takeover');
  assert.equal(takeover.reason, 'expired');
  assert.equal(takeover.previous.owner.label, 'ancien');
});

test('a lock whose owner process died on this host is taken over', async (t) => {
  const dir = tempDir(t);
  const dead = spawn(process.execPath, ['-e', '0']);
  const pid = dead.pid;
  await new Promise((resolve) => dead.on('exit', resolve));
  writeRecord(dir, 'db', { owner: { pid, host: hostname(), label: 'mort' } });
  const r = await cli(dir, ['run', 'db', '--wait', '0', ...nodeCmd('process.exit(0)')]).done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /repris \(owner_dead\)/);
  assert.equal(events(dir).find((e) => e.event === 'takeover').reason, 'owner_dead');
});

test('a live lock, or one owned on another host, is not taken over before expiry', async (t) => {
  const dir = tempDir(t);
  writeRecord(dir, 'db', { owner: { pid: 999999, host: 'autre-machine', label: 'distant' } });
  const r = await cli(dir, ['acquire', 'db', '--wait', '0.2', '--label', 'moi']).done;
  assert.equal(r.code, 75);
  assert.match(r.stderr, /non obtenu après 0.2 s : tenu par distant \(pid 999999 sur autre-machine/);
  writeRecord(dir, 'db2', {});
  const r2 = await cli(dir, ['acquire', 'db2', '--wait', '0']).done;
  assert.equal(r2.code, 75, 'owner alive (this test process): no takeover');
});

test('re-entrant run does not deadlock on a resource already held by a parent', async (t) => {
  const dir = tempDir(t);
  const inner = [process.execPath, '--input-type=module', '-e', RUNNER, LOCK_MODULE, 'run', 'db', '--wait', '1', '--', process.execPath, '-e', 'console.log("inner:" + process.env.APV_LOCK_HELD)'];
  const r = await cli(dir, ['run', 'db', '--wait', '5', '--', ...inner]).done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /inner:db/);
  assert.match(r.stderr, /déjà tenu par un processus parent/);
});

test('APV_LOCK_HELD naming a lock that is no longer held acquires it normally', async (t) => {
  const dir = tempDir(t);
  const { io, out } = captureIO({ APV_LOCK_DIR: dir, APV_LOCK_HELD: 'db' });
  const code = await run(['run', 'db', '--wait', '0', '--', process.execPath, '-e', '0'], io);
  assert.equal(code, 0);
  assert.match(out.stderr, /n'est plus tenu : il est repris normalement/);
});

test('release by a non-owner is refused; force requires a reason and is logged', async (t) => {
  const dir = tempDir(t);
  const acquired = await cli(dir, ['acquire', 'db', '--ttl', '60', '--label', 'agent-a', '--purpose', 'db:reset']).done;
  assert.equal(acquired.code, 0, acquired.stderr);
  const token = /Jeton : ([0-9a-f]+)/.exec(acquired.stdout)[1];

  const refused = await cli(dir, ['release', 'db']).done;
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Refusé : le verrou « db » appartient à agent-a/);
  const wrong = await cli(dir, ['release', 'db', '--token', 'nope']).done;
  assert.equal(wrong.code, 1);
  assert.ok(existsSync(join(dir, 'db.lock')));

  const noReason = await cli(dir, ['release', 'db', '--force']).done;
  assert.equal(noReason.code, 2);
  assert.match(noReason.stderr, /--force exige --reason/);

  const byToken = await cli(dir, ['release', 'db', '--token', token]).done;
  assert.equal(byToken.code, 0, byToken.stderr);
  assert.equal(existsSync(join(dir, 'db.lock')), false);

  await cli(dir, ['acquire', 'db', '--label', 'agent-b']).done;
  const forced = await cli(dir, ['release', 'db', '--force', '--reason', 'agent planté']).done;
  assert.equal(forced.code, 0, forced.stderr);
  const log = events(dir).find((e) => e.event === 'force_release');
  assert.equal(log.reason, 'agent planté');
  assert.equal(log.previous.owner.label, 'agent-b');

  const again = await cli(dir, ['release', 'db']).done;
  assert.equal(again.code, 0);
  assert.match(again.stdout, /personne ne le tient/);
});

test('release accepts APV_LOCK_TOKEN from the environment', async (t) => {
  const dir = tempDir(t);
  const acquired = await cli(dir, ['acquire', 'db', '--json']).done;
  const record = JSON.parse(acquired.stdout);
  assert.equal(record.owner.pid, null, 'acquire without --pid is lease only');
  const r = await cli(dir, ['release', 'db'], { APV_LOCK_TOKEN: record.token }).done;
  assert.equal(r.code, 0, r.stderr);
});

test('SIGTERM on run stops the command, releases the lock and exits 143', async (t) => {
  const dir = tempDir(t);
  const marker = join(dir, 'child.pid');
  const r = cli(dir, ['run', 'db', ...nodeCmd(`require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));setInterval(()=>{},1000)`)]);
  await waitFor(() => existsSync(marker) && existsSync(join(dir, 'db.lock')));
  const childPid = Number(readFileSync(marker, 'utf8'));
  r.child.kill('SIGTERM');
  const res = await r.done;
  assert.equal(res.code, 143, res.stderr);
  assert.equal(existsSync(join(dir, 'db.lock')), false, 'lock released on SIGTERM');
  await waitFor(() => !isPidAlive(childPid));
});

test('SIGINT while waiting leaves the queue and does not take the lock', async (t) => {
  const dir = tempDir(t);
  writeRecord(dir, 'db', {});
  const r = cli(dir, ['run', 'db', ...nodeCmd('0')]);
  await waitFor(() => existsSync(join(dir, 'db.queue')) && readdirSync(join(dir, 'db.queue')).length === 1);
  r.child.kill('SIGINT');
  const res = await r.done;
  assert.equal(res.code, 130);
  assert.equal(readdirSync(join(dir, 'db.queue')).length, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'db.lock'), 'utf8')).token, 'deadbeef');
});

test('waiters are served in FIFO order and see their queue position', async (t) => {
  const dir = tempDir(t);
  const log = join(dir, 'order.txt');
  const append = (id, ms = 0) => nodeCmd(`const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'${id}\\n');setTimeout(()=>{},${ms})`);
  const holder = cli(dir, ['run', 'db', ...append('holder', 700)]);
  await waitFor(() => existsSync(join(dir, 'db.lock')));
  const queue = join(dir, 'db.queue');
  const first = cli(dir, ['run', 'db', '--label', 'premier', ...append('first')]);
  await waitFor(() => existsSync(queue) && readdirSync(queue).length === 1);
  const second = cli(dir, ['run', 'db', '--label', 'second', ...append('second')]);
  await waitFor(() => readdirSync(queue).length === 2);
  const status = captureIO({ APV_LOCK_DIR: dir });
  assert.equal(await run(['status', 'db'], status.io), 0);
  assert.match(status.out.stdout, /db : tenu/);
  assert.match(status.out.stdout, /file 1 : premier/);
  assert.match(status.out.stdout, /file 2 : second/);
  const results = await Promise.all([holder.done, first.done, second.done]);
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['holder', 'first', 'second']);
  assert.match(results[2].stderr, /position 2 sur 2/);
});

test('stale waiter tickets (dead pid or no heartbeat) are pruned and logged', (t) => {
  const dir = tempDir(t);
  const store = new LockStore(dir, { pollMs: 30, waiterStaleMs: 200 });
  const queue = store.queueDir('db');
  mkdirSync(queue, { recursive: true });
  writeFileSync(join(queue, '00000000000000001-1-aaaaaa.json'), JSON.stringify({ owner: { pid: 999999, host: store.host, label: 'mort' }, enqueuedAt: 'x' }));
  writeFileSync(join(queue, '00000000000000002-1-bbbbbb.json'), '{not json');
  const mine = store.enqueue('db', { pid: process.pid, host: store.host, label: 'vivant' });
  const live = store.waiters('db');
  assert.deepEqual(live.map((w) => w.owner.label), ['vivant']);
  assert.equal(readdirSync(queue).length, 1);
  assert.deepEqual(events(dir).filter((e) => e.event === 'stale_waiter_removed').map((e) => e.reason).sort(), ['corrupt', 'owner_dead']);
  store.dequeue(mine);
});

test('store: renew and release refuse a foreign token; unreadable fresh lock is not stale', async (t) => {
  const dir = tempDir(t);
  const store = new LockStore(dir, { pollMs: 30, initGraceMs: 200 });
  const owner = { pid: process.pid, host: store.host, label: 'moi' };
  const got = await store.tryAcquire('db', owner, 60);
  assert.equal(got.ok, true);
  assert.equal(await store.renew('db', 'autre', 60), false);
  assert.equal(await store.renew('db', got.record.token, 60), true);
  assert.equal((await store.release('db', { token: 'autre' })).status, 'refused');
  assert.equal((await store.release('db', { callerPids: [process.pid] })).status, 'released');
  writeFileSync(store.lockPath('db'), '');
  assert.equal(store.staleness(store.read('db')), null, 'lock being written is respected');
  await sleep(250);
  assert.equal(store.staleness(store.read('db')), 'corrupt');
  const retaken = await store.tryAcquire('db', owner, 60);
  assert.equal(retaken.ok, true);
  assert.equal(retaken.takeover.reason, 'corrupt');
});

test('status lists holders as text and JSON, including stale ones', async (t) => {
  const dir = tempDir(t);
  writeRecord(dir, 'ports', { expiresAt: new Date(Date.now() - 5000).toISOString(), purpose: 'playwright' });
  const text = captureIO({ APV_LOCK_DIR: dir });
  assert.equal(await run(['status'], text.io), 0);
  assert.match(text.out.stdout, /ports : périmé \(expired\), sera repris/);
  assert.match(text.out.stdout, /objet : playwright/);
  assert.match(text.out.stdout, /expire dans dépassé de 5 s/);
  const json = captureIO({ APV_LOCK_DIR: dir });
  assert.equal(await run(['status', '--json'], json.io), 0);
  const parsed = JSON.parse(json.out.stdout);
  assert.equal(parsed.locks[0].stale, 'expired');
  assert.equal(parsed.locks[0].record.owner.label, 'ancien');
  const empty = captureIO({ APV_LOCK_DIR: dir });
  assert.equal(await run(['status', 'rien'], empty.io), 0);
  assert.match(empty.out.stdout, /libre, file vide/);
});

test('usage errors exit 2 with help; --dir overrides the environment', async (t) => {
  const dir = tempDir(t);
  const cases = [['run', 'db', 'echo'], ['run', '--', 'echo'], ['bogus'], ['acquire'], ['acquire', 'db', '--ttl', 'x'], ['acquire', 'db', '--pid', '-3'], ['status', 'a', 'b'], ['acquire', 'db', '--unknown']];
  for (const args of cases) {
    const { io, out } = captureIO({ APV_LOCK_DIR: dir });
    assert.equal(await run(args, io), 2, args.join(' '));
    assert.match(out.stderr, /apv lock : /);
  }
  const help = captureIO({});
  assert.equal(await run(['run', '--help'], help.io), 0);
  assert.match(help.out.stdout, /verrous à bail/);
  const other = join(dir, 'ailleurs');
  const { io } = captureIO({ APV_LOCK_DIR: dir });
  assert.equal(await run(['acquire', 'db', '--dir', other], io), 0);
  assert.ok(existsSync(join(other, 'db.lock')));
  assert.equal(existsSync(join(dir, 'db.lock')), false);
});
