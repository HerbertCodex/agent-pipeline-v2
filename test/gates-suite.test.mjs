import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { runGates, failedTests, statusLines } from '../dist/gates/run.js';
import { loadConfig, configIssues } from '../dist/config/load.js';
import { validateReceipt } from '../dist/domain/contracts.js';
import { LockStore } from '../dist/lock/store.js';

/**
 * Full suites (docs/APV3-SPEC.md, section 17): queue of the full suites, locks of the checks whose timeout starts
 * once they are held, load threshold, single relaunch of the failed tests, clean tree, orphans of the same copy.
 */

const node = code => [process.execPath, '-e', code];
/** A committed project whose configuration is `config` (gates of stage full unless said otherwise). */
function project(t, config) {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', config);
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  return f;
}
const common = repo => realpathSync(resolve(repo, git(repo, 'rev-parse', '--git-common-dir')));
const receipt = (dir, gate) => validateReceipt(JSON.parse(readFileSync(join(dir, `${gate}.json`), 'utf8')));
const owner = label => ({ pid: process.pid, host: hostname(), label });
/** Holds the lease `resource` of `dir` for `ms`, then releases it; resolves to the release time. */
async function holdLease(dir, resource, ms) {
  const store = new LockStore(dir);
  const held = await store.tryAcquire(resource, owner('test'), 60);
  assert.ok(held.ok, 'lease taken by the test');
  return new Promise(done => setTimeout(async () => { const at = Date.now(); await store.release(resource, { token: held.record.token }); done(at); }, ms));
}

test('the queue of the full suites: the first check starts only once the lock is free, and its timeout after that', async t => {
  const f = project(t, { gates: [{ id: 'e2e', stage: 'full', timeoutMs: 1000, command: node(`require("fs").writeFileSync(${JSON.stringify(join(f0(t), 'started'))}, String(Date.now())); setTimeout(() => {}, 100)`) }] });
  const locks = join(common(f.repo), 'apv', 'locks');
  const released = holdLease(locks, 'full-suite', 2500);
  const r = await apv(f.repo, ['gates', 'run', '--json'], { APV_LOCK_POLL_MS: '20' });
  const releasedAt = await released;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const json = r.json();
  assert.equal(json.suite, true);
  assert.match(r.stderr, /Attente du verrou « full-suite » : tenu par test/);
  assert.ok(json.queue.waitedMs >= 1100, `waited ${json.queue.waitedMs} ms`);
  assert.equal(json.queue.lockFile, join(locks, 'full-suite.lock'));
  // The check started after the release, and its 1 s timeout did not count the time spent in the queue.
  assert.ok(Number(readFileSync(join(f0(t), 'started'), 'utf8')) >= releasedAt, 'started after the release');
  assert.equal(json.gates[0].status, 'passed');
  // The lock is released at the end: a second suite starts at once.
  const again = (await apv(f.repo, ['gates', 'run', '--json'])).json();
  assert.ok(again.queue.waitedMs < 1000, `second run waited ${again.queue.waitedMs} ms`);
  // A task run never enters the queue; a queue disabled by the configuration neither.
  const task = project(t, { gates: [{ id: 'lint', command: node('0') }] });
  assert.equal((await apv(task.repo, ['gates', 'run', '--json'])).json().queue, null);
});
const scratch = new WeakMap();
/** A scratch directory of the test, outside every repository. */
function f0(t) { if (!scratch.has(t)) scratch.set(t, fixture(t).root); return scratch.get(t); }

test('the queue refuses after waitMs, nothing runs; a disabled queue is not taken', async t => {
  const f = project(t, { gates: [{ id: 'e2e', stage: 'full', command: node(`require("fs").writeFileSync(${JSON.stringify(join(f0(t), 'ran'))}, "")`) }],
    suite: { queue: { lockFile: 'apv/queue/suites.lock', waitMs: 300 } } });
  const locks = join(common(f.repo), 'apv', 'queue');
  const released = holdLease(locks, 'suites', 1500);
  const r = await apv(f.repo, ['gates', 'run'], { APV_LOCK_POLL_MS: '20' });
  await released;
  assert.equal(r.code, 1);
  assert.match(r.stderr, /SUITE_QUEUE.*suites\.lock.*non obtenu après .* tenu par test.*Rien n'a été exécuté/);
  assert.ok(!existsSync(join(f0(t), 'ran')));
  write(f.repo, '.apv/config.json', { gates: [{ id: 'e2e', stage: 'full', command: node('0') }], suite: { queue: { enabled: false } } });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'no queue');
  const held = holdLease(locks, 'suites', 800);
  const free = await apv(f.repo, ['gates', 'run', '--json']);
  await held;
  assert.equal(free.code, 0); assert.equal(free.json().queue, null);
});

test('a check with a lease lock waits for it before its timeout starts; the command sees APV_LOCK_HELD', async t => {
  const dir = join(f0(t), 'locks');
  const f = project(t, { gates: [{ id: 'integration', stage: 'full', timeoutMs: 1000, lock: { resource: 'stack' }, passEnv: [],
    command: node('process.exit(process.env.APV_LOCK_HELD === "stack" ? 0 : 7)') }] });
  const released = holdLease(dir, 'stack', 2500);
  const r = await apv(f.repo, ['gates', 'run', '--json'], { APV_LOCK_DIR: dir, APV_LOCK_POLL_MS: '20' });
  await released;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const rec = receipt(r.json().receiptsDirectory, 'integration');
  assert.equal(rec.status, 'passed');
  assert.ok(rec.lockWaitMs >= 1100, `lockWaitMs ${rec.lockWaitMs} (longer than the 1 s timeout)`);
  assert.ok(rec.durationMs < 1000, 'the wait is not counted in the duration of the command');
  assert.match(r.stderr, /Attente du verrou « stack »/);
  // Lock not obtained within waitMs: a receipt that fails, the command never launched.
  write(f.repo, '.apv/config.json', { gates: [{ id: 'integration', stage: 'full', lock: { resource: 'stack', waitMs: 200 }, command: node(`require("fs").writeFileSync(${JSON.stringify(join(f0(t), 'ran'))}, "")`) }] });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'short wait');
  const held = holdLease(dir, 'stack', 1200);
  const refused = await apv(f.repo, ['gates', 'run', '--json'], { APV_LOCK_DIR: dir, APV_LOCK_POLL_MS: '20' });
  await held;
  assert.equal(refused.code, 1);
  assert.equal(refused.json().gates[0].status, 'timed_out');
  assert.match(refused.json().gates[0].diagnostic, /Verrou du contrôle non obtenu : verrou « stack » non obtenu après/);
  assert.ok(!existsSync(join(f0(t), 'ran')));
  // Already held by the caller (apv lock run stack -- apv gates run): not taken again.
  write(f.repo, '.apv/config.json', { gates: [{ id: 'integration', stage: 'full', timeoutMs: 1000, lock: { resource: 'stack', waitMs: 100 }, command: node('0') }] });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'held');
  const nested = holdLease(dir, 'stack', 600);
  const inside = await apv(f.repo, ['gates', 'run', '--json'], { APV_LOCK_DIR: dir, APV_LOCK_HELD: 'stack' });
  await nested;
  assert.equal(inside.code, 0, inside.stderr);
});

const hasFlock = spawnSync('flock', ['--version']).status === 0 && existsSync('/proc/locks');
test('a check with a flock lock: the timeout starts once held, and the command has an ancestor holding the flock', { skip: !hasFlock && 'flock(1) or /proc/locks missing' }, async t => {
  const file = join(f0(t), 'stack.lock');
  // The command proves the lock as a project script would: an ancestor holds a FLOCK on the inode of the file.
  const proof = `const fs=require("fs");const ino=fs.statSync(${JSON.stringify(file)}).ino;const holders=new Set();
for (const l of fs.readFileSync("/proc/locks","utf8").split("\\n")) { const f=l.trim().split(/\\s+/); if (f[1]==="FLOCK"&&f[3]==="WRITE"&&Number(f[5].split(":")[2])===ino) holders.add(Number(f[4])); }
let pid=process.ppid; let held=false; while (pid>1) { if (holders.has(pid)) { held=true; break; } pid=Number(fs.readFileSync("/proc/"+pid+"/stat","utf8").split(") ")[1].split(" ")[1]); }
process.exit(held?0:9);`;
  const f = project(t, { gates: [{ id: 'integration', stage: 'full', timeoutMs: 1000, lock: { file, fileEnv: 'STACK_LOCK' }, command: node(proof) }] });
  const holder = spawn('flock', [file, 'sleep', '3'], { stdio: 'ignore' });
  await sleep(200);
  const r = await apv(f.repo, ['gates', 'run', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const rec = receipt(r.json().receiptsDirectory, 'integration');
  assert.equal(rec.status, 'passed', rec.diagnostic);
  assert.ok(rec.lockWaitMs >= 1100, `lockWaitMs ${rec.lockWaitMs} (longer than the 1 s timeout)`);
  holder.kill();
  // The variable named by fileEnv, when passed, replaces the path; lock not obtained in time: timed_out, never run.
  const other = join(f0(t), 'other.lock');
  write(f.repo, '.apv/config.json', { gates: [{ id: 'integration', stage: 'full', passEnv: ['STACK_LOCK'], lock: { file, fileEnv: 'STACK_LOCK', waitMs: 200 }, command: node('0') }] });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'env lock');
  const busy = spawn('flock', [other, 'sleep', '2'], { stdio: 'ignore' });
  await sleep(200);
  const refused = await apv(f.repo, ['gates', 'run', '--json'], { STACK_LOCK: other });
  busy.kill();
  assert.equal(refused.code, 1);
  assert.equal(refused.json().gates[0].status, 'timed_out');
  assert.match(refused.json().gates[0].diagnostic, /Verrou flock .*other\.lock non obtenu/);
});

test('load threshold: the suite waits, lock held, until the 1-minute load drops under maxLoad, then starts; at most loadWaitMs', async t => {
  const f = project(t, { gates: [{ id: 'e2e', stage: 'full', command: node('0') }], suite: { queue: { maxLoad: 4, loadWaitMs: 60000 } } });
  const readings = [9.5, 8, 6, 3.2];
  const lines = [];
  const config = loadConfig(f.repo).config;
  const result = await runGates({ repo: f.repo, config, share: false, log: l => lines.push(l),
    hooks: { loadAverage: () => readings.length > 1 ? readings.shift() : readings[0], loadPollMs: 20 } });
  assert.equal(result.ok, true);
  assert.deepEqual({ ...result.queue.load, waitedMs: undefined }, { max: 4, atStart: 3.2, waitedMs: undefined, exceeded: false });
  assert.ok(result.queue.load.waitedMs >= 40);
  assert.match(lines.join('\n'), /Charge moyenne sur 1 min à 9\.50, seuil 4 : démarrage différé/);
  const summary = JSON.parse(readFileSync(join(result.directory, 'summary.json'), 'utf8'));
  assert.equal(summary.queue.load.atStart, 3.2);
  // Never below: after loadWaitMs the suite starts anyway, noted.
  write(f.repo, '.apv/config.json', { gates: [{ id: 'e2e', stage: 'full', command: node('0') }], suite: { queue: { maxLoad: 4, loadWaitMs: 100 } } });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'short load wait');
  const late = [];
  const anyway = await runGates({ repo: f.repo, config: loadConfig(f.repo).config, share: false, log: l => late.push(l), hooks: { loadAverage: () => 12, loadPollMs: 20 } });
  assert.equal(anyway.ok, true);
  assert.equal(anyway.queue.load.exceeded, true);
  assert.match(late.join('\n'), /encore à 12\.00 \(seuil 4\) après .* : la suite démarre quand même/);
});

test('retryFailed: a failed check relaunches its failed tests once; passed after retry counts as passed, shown as unstable', async t => {
  const dir = f0(t);
  const marker = join(dir, 'first-done');
  const relaunches = join(dir, 'relaunches');
  const first = `const fs=require("fs"); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, "");
console.log("  1) [chromium] › tests/a.spec.ts:3:5 › bulle ─────"); console.log("  2) [chromium] › tests/b.spec.ts:9:1 › carte"); console.error("expected visible"); process.exit(1); }`;
  const retry = `require("fs").appendFileSync(${JSON.stringify(relaunches)}, "x"); console.log("2 passed"); process.exit(0)`;
  const f = project(t, { gates: [
    { id: 'unit', command: node('0') },
    { id: 'browser', stage: 'full', dependsOn: ['unit'], command: node(first), retryFailed: { command: node(retry), testPattern: '^\\s*\\d+\\) (\\[[^\\]]+\\] › .+?)\\s*─*$' } },
    { id: 'after', stage: 'full', dependsOn: ['browser'], command: node('0') },
  ] });
  const r = await apv(f.repo, ['gates', 'run']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /browser\s+réussi après relance\s+0/);
  assert.match(r.stdout, /after\s+réussi/, 'dependants run');
  assert.match(r.stdout, /Instables \(1\) : réussis seulement après la relance unique[^]*- browser : \[chromium\] › tests\/a\.spec\.ts:3:5 › bulle ; \[chromium\] › tests\/b\.spec\.ts:9:1 › carte/);
  assert.match(r.stderr, /browser : échec \(code 1\) ; relance unique des tests en échec/);
  assert.equal(readFileSync(relaunches, 'utf8'), 'x');
  const runDir = join(f.repo, '.apv/receipts', readdirSync(join(f.repo, '.apv/receipts')).find(d => d !== '.gitignore'));
  const rec = receipt(runDir, 'browser');
  assert.equal(rec.status, 'passed_after_retry'); assert.equal(rec.exitCode, 0);
  assert.deepEqual(rec.retry.tests, ['[chromium] › tests/a.spec.ts:3:5 › bulle', '[chromium] › tests/b.spec.ts:9:1 › carte']);
  assert.equal(rec.retry.first.status, 'failed'); assert.equal(rec.retry.first.exitCode, 1);
  assert.match(rec.retry.first.diagnostic, /expected visible/);
  assert.match(rec.retry.output, /2 passed/);
  assert.match(rec.diagnostic, /^Réussi après relance \(retryFailed\) : première passe en échec \(code 1\) ; tests relancés : /);
  // verify: proven, the unstable check shown apart.
  const head = git(f.repo, 'rev-parse', 'HEAD');
  const v = await apv(f.repo, ['gates', 'verify', '--commit', head]);
  assert.equal(v.code, 0, v.stdout);
  assert.match(v.stdout, /browser\s+réussi après relance \(instable\)/);
  assert.match(v.stdout, /Instables \(réussis seulement après la relance de leurs tests en échec, même commit\) : browser/);
  assert.match(v.stdout, /Preuve complète : 3 contrôle\(s\) réussi\(s\) sur ce commit, arbre propre, dont 1 instable\(s\)\./);
  const vj = (await apv(f.repo, ['gates', 'verify', '--commit', head, '--json'])).json();
  assert.equal(vj.ok, true); assert.deepEqual(vj.flaky, ['browser']);
  assert.equal(vj.gates.find(g => g.gateId === 'browser').status, 'passed_after_retry');
});

test('retryFailed: a relaunch that fails is a normal failure, never a second relaunch; timeouts and a changed tree are not relaunched', async t => {
  const dir = f0(t);
  const relaunches = join(dir, 'relaunches');
  const f = project(t, { gates: [{ id: 'browser', stage: 'full', command: node('console.log("  1) t1"); process.exit(1)'),
    retryFailed: { command: node(`require("fs").appendFileSync(${JSON.stringify(relaunches)}, "x"); console.error("still red"); process.exit(2)`), testPattern: '^\\s*\\d+\\) (.+)$' } }] });
  const r = await apv(f.repo, ['gates', 'run', '--json']);
  assert.equal(r.code, 1);
  const row = r.json().gates[0];
  assert.equal(row.status, 'failed'); assert.equal(row.exitCode, 2);
  assert.match(row.diagnostic, /^Relance \(retryFailed\) en échec aussi :[^]*still red/);
  assert.deepEqual(row.retriedTests, ['t1']);
  assert.equal(readFileSync(relaunches, 'utf8'), 'x', 'exactly one relaunch');
  assert.deepEqual(r.json().flaky, []);
  assert.equal(receipt(r.json().receiptsDirectory, 'browser').retry.first.exitCode, 1);
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD'])).code, 1);
  // A timeout is not relaunched; a first pass that changes the tree is not relaunched either.
  write(f.repo, '.apv/config.json', { gates: [
    { id: 'hang', stage: 'full', timeoutMs: 300, command: node('setTimeout(() => {}, 20000)'), retryFailed: { command: node(`require("fs").appendFileSync(${JSON.stringify(relaunches)}, "y")`) } },
  ] });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'hang');
  const hang = await apv(f.repo, ['gates', 'run', '--json']);
  assert.equal(hang.json().gates[0].status, 'timed_out');
  write(f.repo, '.apv/config.json', { gates: [
    { id: 'writer', stage: 'full', command: node('require("fs").writeFileSync("leftover.txt", "x"); process.exit(1)'), retryFailed: { command: node(`require("fs").appendFileSync(${JSON.stringify(relaunches)}, "z")`) } },
  ] });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'writer');
  const writer = await apv(f.repo, ['gates', 'run', '--json']);
  assert.equal(writer.json().gates[0].status, 'failed');
  assert.match(writer.json().gates[0].diagnostic, /^Relance refusée : l'arbre de travail a changé pendant la première passe/);
  assert.equal(readFileSync(relaunches, 'utf8'), 'x', 'no relaunch after a timeout or a changed tree');
  // Without retryFailed: unchanged behaviour.
  assert.throws(() => validateReceipt({ ...receipt(r.json().receiptsDirectory, 'browser'), status: 'passed_after_retry', exitCode: 0, retry: undefined }), /first pass/);
});

test('a full suite refuses a dirty tree and lists the files; --allow-dirty runs it with non-proving receipts; a task run is not concerned', async t => {
  const f = project(t, { gates: [{ id: 'lint', command: node('0') }, { id: 'e2e', stage: 'full', command: node('0') }] });
  write(f.repo, 'README.md', 'changed\n');
  write(f.repo, 'notes/new.txt', 'untracked\n');
  write(f.repo, 'dist/ignored.js', 'ignored by .gitignore\n');
  const r = await apv(f.repo, ['gates', 'run']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /\[GATE_DIRTY\] : Suite complète refusée : l'arbre de travail a des modifications non commitées \(2 fichier\(s\)\)/);
  assert.match(r.stderr, / M README\.md/); assert.match(r.stderr, /\?\? notes\/new\.txt/); assert.doesNotMatch(r.stderr, /dist\/ignored/);
  assert.ok(!existsSync(join(f.repo, '.apv/receipts')), 'nothing ran');
  const allowed = await apv(f.repo, ['gates', 'run', '--allow-dirty', '--json']);
  assert.equal(allowed.code, 0); assert.equal(allowed.json().dirty, true);
  assert.equal(receipt(allowed.json().receiptsDirectory, 'e2e').dirty, true);
  const v = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--json']);
  assert.equal(v.code, 1); assert.ok(v.json().gates.every(g => g.state === 'dirty'));
  assert.equal((await apv(f.repo, ['gates', 'run', '--stage', 'task'])).code, 0, 'task stage unchanged');
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--allow-dirty'])).code, 2, '--allow-dirty belongs to gates run');
  assert.deepEqual(statusLines(' M a b\0R  new\0old\0?? c\0'), [' M a b', 'R  new', '?? c']);
});

/** A free TCP port of the machine. */
const freePort = () => new Promise(done => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });
/** A server listening on `port`, started with `cwd` as working directory, resolved once it listens. */
function server(t, cwd, port) {
  const child = spawn(process.execPath, ['-e', `require("net").createServer().listen(${port}, "127.0.0.1", () => console.log("up"))`], { cwd, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } });
  const exited = new Promise(done => child.once('exit', () => done(true)));
  return new Promise(done => child.stdout.once('data', () => done({ child, exited })));
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('ports of the suite: orphans of the same copy are stopped, never those of another copy or of the main checkout', { skip: !existsSync('/proc/net/tcp') && 'no /proc' }, async t => {
  const [own, other, main] = [await freePort(), await freePort(), await freePort()];
  const f = project(t, { gates: [{ id: 'e2e', stage: 'full', command: node('0') }], suite: { ports: [own, other, main] } });
  const copy = join(f.root, 'copy'); const sibling = join(f.root, 'sibling');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'copy', copy, 'HEAD');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'sibling', sibling, 'HEAD');
  const orphan = await server(t, copy, own);
  const theirs = await server(t, sibling, other);
  const operator = await server(t, f.repo, main);
  const r = await apv(copy, ['gates', 'run', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const ports = r.json().ports;
  assert.deepEqual(ports.stopped.map(p => [p.pid, p.ports]), [[orphan.child.pid, [own]]]);
  assert.match(ports.stopped[0].outcome, /terminated|killed/);
  assert.deepEqual(ports.left.map(p => [p.pid, p.reason]).sort((a, b) => a[0] - b[0]),
    [[theirs.child.pid, 'other-copy'], [operator.child.pid, 'main-checkout']].sort((a, b) => a[0] - b[0]));
  assert.equal(await orphan.exited, true);
  assert.ok(alive(theirs.child.pid) && alive(operator.child.pid), 'another copy and the main checkout untouched');
  assert.match(r.stderr, new RegExp(`Port ${own} : orphelin de cette copie arrêté \\(pid ${orphan.child.pid}`));
  const human = await apv(copy, ['gates', 'run']);
  assert.match(human.stdout, /Ports de la suite tenus par d'autres processus, non arrêtés : .*other-copy/);
  // From the main checkout, nothing of its own is ever stopped.
  const fromMain = await apv(f.repo, ['gates', 'run', '--json']);
  assert.ok(fromMain.json().ports.left.some(p => p.pid === operator.child.pid && p.reason === 'main-checkout'));
  assert.ok(alive(operator.child.pid));
});

test('configuration: suite and the new gate fields are validated; absent, the gates hash is unchanged', () => {
  const bad = (config, pattern) => { const { issues } = configIssues(config); assert.ok(issues.some(i => pattern.test(i.message)), JSON.stringify(issues)); };
  bad({ suite: { ports: [4173, 4173] } }, /suite\.ports: duplicate port/);
  bad({ suite: { queue: { lockFile: 'apv/locks/queue' } } }, /lockFile/);
  bad({ suite: { queue: { maxLoad: 0 } } }, /maxLoad/);
  bad({ gates: [{ id: 'e2e', command: ['x'], retryFailed: { command: ['y'], testPattern: '(' } }] }, /retryFailed\.testPattern is not a valid regular expression/);
  bad({ gates: [{ id: 'e2e', command: ['x'], lock: { resource: 'a', file: 'b' } }] }, /lock/);
  const { config } = configIssues({ gates: [{ id: 'e2e', command: ['x'] }] });
  assert.deepEqual(Object.keys(config.gates[0]).filter(k => ['lock', 'retryFailed'].includes(k)), []);
  assert.deepEqual(failedTests(undefined, 'x'), []);
  assert.deepEqual(failedTests('^FAIL (.+)$', '\u001b[31mFAIL a.test.ts\u001b[0m\nok\nFAIL a.test.ts\nFAIL b'), ['a.test.ts', 'b']);
});
