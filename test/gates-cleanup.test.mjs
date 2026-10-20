import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';

/**
 * The end of a full suite (docs/APV3-SPEC.md, section 18.4): whatever its outcome, the servers it started that left
 * the process group of their check are stopped, then the orphans of its copy on `suite.ports`.
 */

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const freePort = () => new Promise(done => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await sleep(50); }
  return !alive(pid);
}
const hasProc = existsSync('/proc/self/environ') && existsSync('/proc/net/tcp');
/** The longest a test server may live, whatever happens to the test that started it. */
const SERVER_LIFETIME_MS = 5 * 60_000;

/**
 * A check that starts a server out of its process group (a detached child, as a daemonising test server does),
 * writes its pid in `pidFile` once it listens on `port`, then exits with `exit` (or waits `waitMs` first). With
 * `unmarked`, the server is started without the marker of the suite (another tool of the same copy).
 * The server never outlives its test: it exits once its pid file is gone (the fixture folder is removed when the test
 * ends, before the test's own hooks could read the pid; 141 such servers were found left running on 2026-10-03), and
 * after SERVER_LIFETIME_MS in any case.
 */
function daemonCheck(pidFile, port, { exit = 0, waitMs = 0, unmarked = false } = {}) {
  const watch = `setInterval(() => { if (!require("fs").existsSync(${JSON.stringify(pidFile)})) process.exit(0); }, 250); setTimeout(() => process.exit(0), ${SERVER_LIFETIME_MS});`;
  const server = `require("net").createServer().listen(${port}, "127.0.0.1", () => { require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${watch} })`;
  const code = `const { spawn } = require("child_process");
const env = { ...process.env }; ${unmarked ? 'delete env.APV_SUITE_RUN;' : ''}
const c = spawn(process.execPath, ["-e", ${JSON.stringify(server)}], { detached: true, stdio: "ignore", env });
c.unref();
const t = setInterval(() => { if (require("fs").existsSync(${JSON.stringify(pidFile)})) { clearInterval(t); setTimeout(() => process.exit(${exit}), ${waitMs}); } }, 20);`;
  return [process.execPath, '-e', code];
}

function project(t, config) {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', config);
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  const copy = join(f.root, 'copy');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'copy', copy, 'HEAD');
  const lockDir = join(f.root, 'locks');
  return { ...f, copy, env: { APV_LOCK_DIR: lockDir, APV_LOCK_POLL_MS: '20' } };
}
const pidOf = file => Number(readFileSync(file, 'utf8'));

test('a full suite stops, at its end, the servers its checks started out of their process group, pass or fail', { skip: !hasProc && 'no /proc' }, async t => {
  const [p1, p2] = [await freePort(), await freePort()];
  const f = project(t, { gates: [] });
  const pass = join(f.root, 'pass.pid'); const fail = join(f.root, 'fail.pid');
  write(f.copy, '.apv/config.json', { gates: [{ id: 'up', stage: 'full', command: daemonCheck(pass, p1) }, { id: 'down', stage: 'full', command: daemonCheck(fail, p2, { exit: 3 }) }] });
  git(f.copy, 'commit', '-qam', 'gates');
  t.after(() => { for (const file of [pass, fail]) if (existsSync(file)) { try { process.kill(pidOf(file), 'SIGKILL'); } catch { /* gone */ } } });
  const r = await apv(f.copy, ['gates', 'run', '--keep-going', '--json'], f.env);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const cleanup = r.json().cleanup;
  assert.deepEqual(cleanup.stopped.map(p => p.pid).sort(), [pidOf(pass), pidOf(fail)].sort());
  assert.ok(await gone(pidOf(pass)) && await gone(pidOf(fail)), 'both servers stopped');
  assert.match(r.stderr, /Fin de suite : processus lancé par la suite encore vivant, arrêté \(pid \d+/);
  const summary = JSON.parse(readFileSync(join(r.json().receiptsDirectory, 'summary.json'), 'utf8'));
  assert.equal(summary.cleanup.stopped.length, 2);
});

test('a task run is not a full suite: nothing is stopped at its end', { skip: !hasProc && 'no /proc' }, async t => {
  const port = await freePort();
  const f = project(t, { gates: [] });
  const file = join(f.root, 'task.pid');
  write(f.copy, '.apv/config.json', { gates: [{ id: 'up', command: daemonCheck(file, port) }] });
  git(f.copy, 'commit', '-qam', 'gates');
  t.after(() => { if (existsSync(file)) { try { process.kill(pidOf(file), 'SIGKILL'); } catch { /* gone */ } } });
  const r = await apv(f.copy, ['gates', 'run', '--stage', 'task', '--json'], f.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().cleanup, null);
  assert.ok(alive(pidOf(file)));
  // The server left by the task run stops once its pid file is gone, as when the fixture folder is removed: no test
  // server outlives its test (141 were found left running on 2026-10-03).
  const pid = pidOf(file);
  rmSync(file);
  assert.ok(await gone(pid), 'the server stops once its pid file is gone');
});

test('the orphans of the copy on suite.ports left during the suite are stopped at its end', { skip: !hasProc && 'no /proc' }, async t => {
  const port = await freePort();
  const f = project(t, { gates: [] });
  const file = join(f.root, 'orphan.pid');
  write(f.copy, '.apv/config.json', { gates: [{ id: 'up', stage: 'full', command: daemonCheck(file, port, { unmarked: true }) }], suite: { ports: [port] } });
  git(f.copy, 'commit', '-qam', 'gates');
  t.after(() => { if (existsSync(file)) { try { process.kill(pidOf(file), 'SIGKILL'); } catch { /* gone */ } } });
  const r = await apv(f.copy, ['gates', 'run', '--json'], f.env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json().cleanup.stopped, [], 'not marked: not a process of the suite');
  assert.deepEqual(r.json().cleanup.ports.stopped.map(p => [p.pid, p.ports]), [[pidOf(file), [port]]]);
  assert.ok(await gone(pidOf(file)));
});

test('an interrupted suite (SIGINT) cancels its checks, stops what it started, and exits 130', { skip: !hasProc && 'no /proc' }, async t => {
  const port = await freePort();
  const f = project(t, { gates: [] });
  const file = join(f.root, 'long.pid');
  write(f.copy, '.apv/config.json', { gates: [{ id: 'long', stage: 'full', command: daemonCheck(file, port, { waitMs: 60_000 }), timeoutMs: 120_000 }] });
  git(f.copy, 'commit', '-qam', 'gates');
  t.after(() => { if (existsSync(file)) { try { process.kill(pidOf(file), 'SIGKILL'); } catch { /* gone */ } } });
  const child = spawn(process.execPath, [cli, 'gates', 'run', '--json'], { cwd: f.copy, env: { ...process.env, ...f.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; });
  const exited = new Promise(done => child.once('exit', code => done(code)));
  const end = Date.now() + 15_000;
  while (!existsSync(file) && Date.now() < end) await sleep(50);
  assert.ok(existsSync(file), `the server started\n${err}`);
  child.kill('SIGINT');
  assert.equal(await exited, 130, err);
  const result = JSON.parse(out);
  assert.equal(result.interrupted, 'SIGINT');
  assert.deepEqual(result.gates.map(g => [g.gate, g.status]), [['long', 'cancelled']]);
  assert.deepEqual(result.cleanup.stopped.map(p => p.pid), [pidOf(file)]);
  assert.ok(await gone(pidOf(file)));
  assert.match(err, /Signal SIGINT reçu/);
  // The queue of the full suites was released before the exit.
  assert.ok(!existsSync(join(f.repo, '.git', 'apv', 'locks', 'full-suite.lock')), 'queue released');
  assert.ok(readdirSync(join(f.copy, '.apv/receipts')).some(d => existsSync(join(f.copy, '.apv/receipts', d, 'summary.json'))));
});
