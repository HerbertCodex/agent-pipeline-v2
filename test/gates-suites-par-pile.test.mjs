import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { runGates, suitePorts } from '../dist/gates/run.js';
import { queuePlaces } from '../dist/gates/suite.js';
import { loadConfig, configIssues } from '../dist/config/load.js';
import { LockStore } from '../dist/lock/store.js';
import { flockFree, judgeStack, probe, resolveStacks, stackContainers, underStackLock } from '../dist/stacks/idle.js';

/**
 * Full suites side by side, one per stack (docs/SHIFT-LEFT.md, sections 13 and 22, phase 0 bis, first part): a suite
 * checks the locks and ports of the stacks it uses only, holds their places in the queue (`suite.queue.slots`), prepares
 * its own copy (`batch.setup`), and reads a stack again after a check was interrupted under its lock.
 */

const hasFlock = spawnSync('flock', ['--version']).status === 0;
const noProc = !existsSync('/proc/net/tcp') && 'no /proc';
const node = code => [process.execPath, '-e', code];
const owner = label => ({ pid: process.pid, host: hostname(), label });

async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}

/**
 * Two stacks (lock files, a variable each, their ports in suite.ports), one check of a stack that records where it ran
 * and holds `holdMs`; `queue` merged into suite.queue, `gates` added after it.
 */
async function project(t, { queue = {}, holdMs = 50, gates = [], ports = true, serve = false } = {}) {
  const f = fixture(t);
  const out = join(f.root, 'out');
  const started = join(f.root, 'started');
  const lock1 = join(f.root, 's1.lock'); const lock2 = join(f.root, 's2.lock');
  writeFileSync(lock1, ''); writeFileSync(lock2, '');
  const p1 = await freePort(); const p2 = await freePort();
  // `serve`: the check also listens on p0, a port of suite.ports that is no stack's (a server of the suite).
  const p0 = serve ? await freePort() : null;
  const e2e = { id: 'e2e', stage: 'full', timeoutMs: 60_000, passEnv: ['STACK', 'LOCK_FILE'], lock: { file: lock1, fileEnv: 'LOCK_FILE' },
    command: node(`const fs = require("fs"); fs.mkdirSync(${JSON.stringify(out)}, { recursive: true }); fs.mkdirSync(${JSON.stringify(started)}, { recursive: true }); const start = Date.now();
${p0 ? `require("net").createServer().listen(${p0}, "127.0.0.1"); process.on("SIGTERM", () => process.exit(143));` : ''}
fs.writeFileSync(${JSON.stringify(started)} + "/" + (process.env.STACK ?? "x") + "-" + start, "");
setTimeout(() => { fs.writeFileSync(${JSON.stringify(out)} + "/e2e-" + (process.env.STACK ?? "x") + "-" + start + ".json", JSON.stringify({ stack: process.env.STACK ?? null, cwd: process.cwd(), start, end: Date.now() })); process.exit(0); }, ${holdMs});`) };
  write(f.repo, '.apv/config.json', {
    gates: [e2e, ...gates],
    stacks: [{ id: '1', lockFile: lock1, env: { STACK: '1' }, ports: [p1] }, { id: '2', lockFile: lock2, env: { STACK: '2' }, ports: [p2] }],
    suite: { queue: { waitMs: 300, ...queue }, ports: [...(ports ? [p1, p2] : []), ...(p0 ? [p0] : [])] },
  });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  const common = realpathSync(resolve(f.repo, git(f.repo, 'rev-parse', '--git-common-dir')));
  const env = { APV_LOCK_DIR: join(f.root, 'locks'), APV_LOCK_POLL_MS: '20' };
  const ran = () => {
    try { return spawnSync('ls', [out], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).map(n => JSON.parse(readFileSync(join(out, n), 'utf8'))); }
    catch { return []; }
  };
  const run = (args, cwd = f.repo, extra = {}) => apv(cwd, ['gates', 'run', ...args, '--json'], env, extra);
  /** Resolves once a check has started (its marker written), `count` of them in all. */
  const hasStarted = async (count = 1) => { while ((existsSync(started) ? readdirSync(started).length : 0) < count) await sleep(20); };
  return { ...f, out, started, hasStarted, lock1, lock2, p0, p1, p2, common, env, ran, run, locks: join(common, 'apv', 'locks') };
}

/** Holds the flock of `file` from another process (its own group, killed at the end of the test), once it is held. */
async function holdFlock(t, file) {
  const holder = spawn('flock', [file, 'sleep', '60'], { stdio: 'ignore', detached: true });
  const kill = () => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* gone */ } };
  t.after(kill);
  while (flockFree(file) !== false) await sleep(20);
  return async () => { kill(); await new Promise(done => holder.exitCode !== null || holder.signalCode !== null ? done() : holder.once('exit', done)); };
}

/** Takes the lease `resource` of the queue folder `dir`; released at the end of the test, or by the returned function. */
async function holdPlace(t, dir, resource) {
  const store = new LockStore(dir);
  const held = await store.tryAcquire(resource, owner('test'), 60);
  assert.ok(held.ok, `place ${resource} taken by the test`);
  let done = false;
  const release = async () => { if (done) return; done = true; await store.release(resource, { token: held.record.token }); };
  // The folder of the fixture may be removed first: nothing left to release then.
  t.after(() => release().catch(() => {}));
  return release;
}

test('GATE_BUSY: --stacks 2 is no longer refused for a lock of stack 1; --stacks 1 and a suite that locks stack 1 still are', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = await project(t, { ports: false });
  const release = await holdFlock(t, p.lock1);
  const two = await p.run(['--stacks', '2']);
  assert.equal(two.code, 0, two.stdout + two.stderr);
  assert.deepEqual(two.json().stacksUsed, ['2']);
  assert.deepEqual(p.ran().map(r => r.stack), ['2']);
  const one = await p.run(['--stacks', '1']);
  assert.equal(one.code, 1);
  assert.match(one.stderr, /GATE_BUSY.*pile 1 : son verrou \(.*s1\.lock\) est tenu/);
  // Without --stacks the check locks stack 1 (its lock): refused, as before.
  const plain = await p.run([]);
  assert.equal(plain.code, 1);
  assert.match(plain.stderr, /pile 1 : son verrou/);
  await release();
  // Stack 2 held now: a suite whose checks lock stack 1 only is not concerned.
  await holdFlock(t, p.lock2);
  const again = await p.run([]);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(again.json().stacksUsed, ['1']);
  assert.doesNotMatch(again.stderr, /pile 2/);
});

test('GATE_BUSY: a check whose lock is no declared stack makes the suite check every stack, as before', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const f0 = fixture(t);
  const other = join(f0.root, 'other.lock');
  writeFileSync(other, '');
  const p = await project(t, { ports: false, gates: [{ id: 'other', stage: 'full', command: node('0'), lock: { file: other } }] });
  await holdFlock(t, p.lock2);
  const r = await p.run([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /other : verrou qui n'est celui d'aucune pile déclarée ; la suite vérifie et tient toutes les piles \(1, 2\)/);
  assert.match(r.stderr, /pile 2 : son verrou/);
  assert.deepEqual(p.ran(), [], 'nothing ran');
});

test('GATE_BUSY: only the ports of the stacks used are checked; a port of the stack used held refuses', { skip: noProc }, async t => {
  const p = await project(t);
  // The port of stack 1 held by this process (the session: never stopped, never waited for).
  const server = createServer();
  await new Promise(done => server.listen(p.p1, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const two = await p.run(['--stacks', '2']);
  assert.equal(two.code, 0, two.stdout + two.stderr);
  assert.deepEqual(two.json().ports.ports, [p.p2]);
  const one = await p.run(['--stacks', '1']);
  assert.equal(one.code, 1);
  assert.match(one.stderr, new RegExp(`GATE_BUSY.*port ${p.p1} tenu par le pid ${process.pid}`));
});

test('suite.queue.slots per-stack: a suite holds the place of its stacks only; the place of a stack held makes a suite on it wait, then refuse', async t => {
  const p = await project(t, { queue: { slots: 'per-stack' }, ports: false });
  const release = await holdPlace(t, p.locks, 'full-suite-stack-1');
  // The whole queue held too (a suite with slots 1 holds it): a suite on stack 2 does not need it.
  await holdPlace(t, p.locks, 'full-suite');
  const two = await p.run(['--stacks', '2']);
  assert.equal(two.code, 0, two.stdout + two.stderr);
  assert.deepEqual(two.json().queue.places, ['full-suite-stack-2']);
  assert.equal(two.json().queue.slots, 'per-stack');
  assert.ok(two.json().queue.waitedMs < 1000, `waited ${two.json().queue.waitedMs} ms`);
  const one = await p.run(['--stacks', '1']);
  assert.equal(one.code, 1);
  assert.match(one.stderr, /SUITE_QUEUE.*verrou « full-suite-stack-1 » non obtenu .*tenu par test.*Rien n'a été exécuté/);
  await release();
  // The places of a refused run are released: none of its places is left held.
  assert.equal(new LockStore(p.locks).read('full-suite-stack-2').exists, false);
  const after = await p.run(['--stacks', '1']);
  assert.equal(after.code, 0, after.stderr);
});

test('suite.queue.slots 1 (default): the whole queue and the place of each stack used; one suite at a time as before', async t => {
  const p = await project(t, { ports: false });
  const r = await p.run(['--stacks', '2']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json().queue.places, ['full-suite', 'full-suite-stack-2']);
  await holdPlace(t, p.locks, 'full-suite');
  const refused = await p.run(['--stacks', '2']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /SUITE_QUEUE.*« full-suite »/);
});

test('suite.queue.slots N: one of N numbered places, then those of its stacks; all taken, refused after waitMs', async t => {
  const p = await project(t, { queue: { slots: 2 }, ports: false });
  await holdPlace(t, p.locks, 'full-suite-slot-1');
  const second = await holdPlace(t, p.locks, 'full-suite-slot-2');
  const r = await p.run(['--stacks', '2']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Les 2 places de la file des suites complètes sont prises/);
  assert.match(r.stderr, /SUITE_QUEUE.*aucune des 2 places de la file libre après/);
  assert.deepEqual(p.ran(), []);
  await second();
  const ok = await p.run(['--stacks', '2']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(ok.json().queue.places, ['full-suite-slot-2', 'full-suite-stack-2']);
});

test('two suites run at the same time on two stacks (per-stack); two suites on the same stack never do', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = await project(t, { queue: { slots: 'per-stack', waitMs: 60_000 }, holdMs: 1200, ports: false });
  const copy = join(p.root, 'copy');
  git(p.repo, 'worktree', 'add', '-q', '--detach', copy, 'HEAD');
  const [a, b] = await Promise.all([p.run(['--stacks', '1']), p.run(['--stacks', '2'], copy)]);
  assert.equal(a.code, 0, a.stderr); assert.equal(b.code, 0, b.stderr);
  const [x, y] = p.ran().sort((m, n) => m.stack.localeCompare(n.stack));
  assert.deepEqual([x.stack, y.stack], ['1', '2']);
  assert.ok(x.start < y.end && y.start < x.end, `in parallel: ${JSON.stringify([x, y])}`);
  rmSync(p.out, { recursive: true, force: true });
  // Same stack, two copies: the second waits for the place of the stack, the checks never overlap.
  const [c, d] = await Promise.all([p.run(['--stacks', '1']), p.run(['--stacks', '1'], copy)]);
  assert.equal(c.code, 0, c.stderr); assert.equal(d.code, 0, d.stderr);
  assert.match(c.stderr + d.stderr, /Attente du verrou « full-suite-stack-1 »/);
  const [u, v] = p.ran().sort((m, n) => m.start - n.start);
  assert.ok(u.end <= v.start, `one after the other: ${JSON.stringify([u, v])}`);
});

test('queuePlaces, suitePorts and the configuration of slots', () => {
  assert.deepEqual(queuePlaces(1, { used: ['2'], declared: ['1', '2'] }), { whole: true, slots: 'none', stacks: ['2'] });
  assert.deepEqual(queuePlaces('per-stack', { used: ['2', '1'], declared: ['1', '2'] }), { whole: false, slots: 'none', stacks: ['1', '2'] });
  assert.deepEqual(queuePlaces('per-stack', { used: [], declared: ['1', '2'] }), { whole: true, slots: 'none', stacks: [] });
  assert.deepEqual(queuePlaces(3, { used: ['1'], declared: ['1', '2'] }), { whole: false, slots: 'one', stacks: ['1'] });
  // A lock of no declared stack: every stack, and the whole queue.
  assert.deepEqual(queuePlaces('per-stack', { used: ['1'], declared: ['1', '2'], unmapped: true }), { whole: true, slots: 'none', stacks: ['1', '2'] });
  // A measure: every place.
  assert.deepEqual(queuePlaces(2, { used: [], declared: ['2', '1'], all: true }), { whole: true, slots: 'all', stacks: ['1', '2'] });
  const declared = [{ id: '1', config: { ports: [1, 2] } }, { id: '2', config: { ports: [3, 2] } }];
  assert.deepEqual(suitePorts([1, 2, 3, 9], declared, ['1']), [1, 2, 9]);
  assert.deepEqual(suitePorts([1, 2, 3, 9], declared, ['2']), [2, 3, 9]);
  assert.deepEqual(suitePorts([1, 3], declared, ['1', '2']), [1, 3]);
  const issues = raw => configIssues(raw).issues.map(i => i.message).join('\n');
  for (const slots of [1, 4, 'per-stack']) assert.equal(issues({ suite: { queue: { slots } } }), '');
  for (const slots of [0, 'two', 1.5, 65]) assert.notEqual(issues({ suite: { queue: { slots } } }), '', String(slots));
});

test('apv stacks sees the place of a stack held by a suite: busy, and never stopped under it', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = await project(t, { queue: { slots: 'per-stack' }, ports: false });
  const config = loadConfig(p.repo).config;
  const [s1, s2] = resolveStacks(config, p.common);
  const context = { repo: p.repo, common: p.common, config, env: { ...process.env, ...p.env } };
  await holdPlace(t, p.locks, 'full-suite-stack-1');
  assert.match(probe(s1, context).join(' ; '), /suite complète en cours sur cette pile \(place full-suite-stack-1/);
  assert.deepEqual(probe(s2, context), []);
  assert.equal(await underStackLock(s1, context, node('0'), 'stop'), null);
  assert.equal((await underStackLock(s2, context, node('0'), 'stop')).ok, true);
});

/** A project whose copy has a package-lock.json, and a full check that needs node_modules/.installed. */
function lockProject(t, batch) {
  const f = fixture(t);
  const ranFile = join(f.root, 'ran');
  write(f.repo, 'package-lock.json', { name: 'x', lockfileVersion: 3, packages: {} });
  write(f.repo, '.apv/config.json', { gates: [{ id: 'unit', stage: 'full', command: node(`require("fs").writeFileSync(${JSON.stringify(ranFile)}, ""); if (!require("fs").existsSync("node_modules/.installed")) process.exit(3)`) }],
    ...(batch ? { batch } : {}) });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'lock');
  return { ...f, ranFile, run: () => apv(f.repo, ['gates', 'run', '--json']) };
}
const install = node('require("fs").mkdirSync("node_modules", { recursive: true }); require("fs").writeFileSync("node_modules/.installed", "")');

test('a full suite prepares its own copy (batch.setup) when it has a package-lock.json without node_modules', async t => {
  const p = lockProject(t, { setup: install });
  const r = await p.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json().setup.status, 'done');
  assert.equal(r.json().setup.reason, 'package-lock.json sans node_modules');
  assert.match(r.stderr, /Copie de la suite non préparée \(package-lock\.json sans node_modules\) : préparation par batch\.setup/);
  // node_modules there now: nothing to prepare.
  const again = await p.run();
  assert.equal(again.code, 0);
  assert.equal(again.json().setup, null);
});

test('a preparation that fails, or writes outside the ignored files, refuses the suite before anything runs; without batch.setup it is said', async t => {
  const failing = lockProject(t, { setup: node('console.error("npm ci: réseau absent"); process.exit(4)') });
  const r = await failing.run();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /GATE_SETUP.*Suite complète refusée, rien n'a été exécuté : préparation de la copie de la suite .* en échec \(failed, code 4\) : npm ci: réseau absent/s);
  assert.ok(!existsSync(failing.ranFile), 'nothing ran');
  const stray = lockProject(t, { setup: node('require("fs").mkdirSync("node_modules"); require("fs").writeFileSync("stray.txt", "")') });
  const s = await stray.run();
  assert.equal(s.code, 1);
  assert.match(s.stderr, /GATE_SETUP.*batch\.setup a modifié l'arbre de la copie \(fichiers non ignorés : \?\? stray\.txt\)/);
  assert.ok(!existsSync(stray.ranFile), 'nothing ran');
  const missing = lockProject(t, null);
  const m = await missing.run();
  assert.equal(m.code, 1, 'the check fails without its dependencies');
  assert.equal(m.json().setup.status, 'missing');
  assert.match(m.stderr, /ATTENTION : copie de la suite non préparée \(package-lock\.json sans node_modules\) et aucun batch\.setup déclaré/);
  // A task run is not a full suite: never prepared.
  const task = lockProject(t, { setup: install });
  const config = JSON.parse(readFileSync(join(task.repo, '.apv/config.json'), 'utf8'));
  config.gates[0].stage = 'task';
  write(task.repo, '.apv/config.json', config); git(task.repo, 'commit', '-qam', 'task');
  const tr = await apv(task.repo, ['gates', 'run', '--stage', 'task', '--json']);
  assert.equal(tr.json().setup, null);
  assert.ok(!existsSync(join(task.repo, 'node_modules')));
});

/** A project whose full check holds the lock of stack 1 (declared with a Docker project) for `holdMs`, bounded by `timeoutMs`. */
function interruptProject(t, { holdMs, timeoutMs = 60_000 }) {
  const f = fixture(t);
  const lock1 = join(f.root, 's1.lock');
  const started = join(f.root, 'started');
  writeFileSync(lock1, '');
  write(f.repo, '.apv/config.json', {
    gates: [{ id: 'reset', stage: 'full', timeoutMs, lock: { file: lock1 }, command: node(`require("fs").writeFileSync(${JSON.stringify(started)}, ""); setTimeout(() => {}, ${holdMs})`) }],
    stacks: [{ id: '1', lockFile: lock1, dockerProject: 'proj' }, { id: '2', lockFile: join(f.root, 's2.lock'), dockerProject: 'proj-2' }],
  });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  return { ...f, started };
}
/** The containers a stack shows, one answer per read (the last one repeated), and the stacks read. */
function containers(...answers) {
  const reads = [];
  return { reads, hook: async stack => { reads.push(stack.id); return answers[Math.min(reads.length - 1, answers.length - 1)]; } };
}
const db = { name: 'supabase_db_proj', state: 'running' }; const api = { name: 'supabase_kong_proj', state: 'running' };

test('a check cut by its delay under the lock of a stack: the stack is read again after the stop, a container gone is said', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = interruptProject(t, { holdMs: 10_000, timeoutMs: 400 });
  const docker = containers({ containers: [db, api] }, { containers: [api] });
  const lines = [];
  const result = await runGates({ repo: p.repo, config: loadConfig(p.repo).config, share: false, log: l => lines.push(l), hooks: { stackContainers: docker.hook } });
  assert.equal(result.receipts[0].status, 'timed_out');
  // Read before the checks (the stack used only), then after the stop.
  assert.deepEqual(docker.reads, ['1', '1']);
  assert.equal(result.interruptedStacks.length, 1);
  const [x] = result.interruptedStacks;
  assert.deepEqual([x.stack, x.gates, x.health.state, x.health.missing], ['1', ['reset'], 'degraded', ['supabase_db_proj']]);
  assert.match(lines.join('\n'), /ATTENTION : pile 1 : reset interrompu\(s\) sous son verrou .* État relu après l'arrêt : abîmée \(disparu\(s\) depuis le départ de la suite : supabase_db_proj\)\. Avant la prochaine suite sur cette pile : apv stacks status/);
  const summary = JSON.parse(readFileSync(join(result.directory, 'summary.json'), 'utf8'));
  assert.equal(summary.interruptedStacks[0].health.state, 'degraded');
});

test('a cancelled suite reads the stack again once stopped; a check that passed, or no Docker project, reads nothing more', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = interruptProject(t, { holdMs: 10_000 });
  const docker = containers({ containers: [db, api] });
  const abort = new AbortController();
  const watch = (async () => { while (!existsSync(p.started)) await sleep(20); abort.abort(); })();
  const result = await runGates({ repo: p.repo, config: loadConfig(p.repo).config, share: false, signal: abort.signal, hooks: { stackContainers: docker.hook } });
  await watch;
  assert.equal(result.receipts[0].status, 'cancelled');
  assert.deepEqual(result.interruptedStacks.map(x => [x.stack, x.health.state]), [['1', 'running']]);
  assert.match(result.interruptedStacks[0].health.detail, /tous en marche, les mêmes qu'au départ de la suite/);
  const passing = interruptProject(t, { holdMs: 10 });
  const quiet = containers({ containers: [db] });
  const ok = await runGates({ repo: passing.repo, config: loadConfig(passing.repo).config, share: false, hooks: { stackContainers: quiet.hook } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.interruptedStacks, []);
  assert.deepEqual(quiet.reads, ['1'], 'read once, before the checks');
});

test('stackContainers and judgeStack: the containers of a project, gone, stopped, none, unreadable', () => {
  const out = 'supabase_db_proj\trunning\t\tproj\nsupabase_db_proj-2\trunning\t\tproj-2\nweb\texited\tproj\t\nother\trunning\t\t\n';
  assert.deepEqual(stackContainers(out, 'proj'), [{ name: 'supabase_db_proj', state: 'running' }, { name: 'web', state: 'exited' }]);
  assert.deepEqual(stackContainers(out, 'proj-2'), [{ name: 'supabase_db_proj-2', state: 'running' }]);
  assert.equal(judgeStack({ containers: [db] }, null).state, 'running');
  assert.equal(judgeStack({ containers: [{ ...db, state: 'exited' }] }, [db]).state, 'degraded');
  assert.match(judgeStack({ containers: [{ ...db, state: 'exited' }] }, [db]).detail, /hors marche : supabase_db_proj \(exited\)/);
  assert.deepEqual([judgeStack({ containers: [] }, [db]).state, judgeStack({ containers: [] }, [db]).detail], ['absent', 'aucun conteneur (1 au départ de la suite)']);
  assert.deepEqual(judgeStack({ error: 'docker ps illisible' }, [db]), { state: 'unknown', detail: 'docker ps illisible', containers: [], missing: [] });
});

test('two suites in the same copy never run side by side (per-stack): the second waits for the place of the copy, the server of the first is never stopped as an orphan', async t => {
  const p = await project(t, { queue: { slots: 'per-stack', waitMs: 60_000 }, holdMs: 1500, ports: false, serve: true });
  const copy = join(p.root, 'copy');
  git(p.repo, 'worktree', 'add', '-q', '--detach', copy, 'HEAD');
  const first = p.run(['--stacks', '1'], copy);
  await p.hasStarted();
  const second = await p.run(['--stacks', '2'], copy);
  const a = await first;
  assert.equal(a.code, 0, a.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.doesNotMatch(second.stderr, /orphelin de cette copie arrêté/);
  assert.match(second.stderr, /Attente du verrou « full-suite-copy-[0-9a-f]{16} »/);
  assert.match(a.json().queue.places[0], /^full-suite-copy-[0-9a-f]{16}$/);
  const [u, v] = p.ran().sort((m, n) => m.start - n.start);
  assert.ok(u && v && u.end <= v.start, `one after the other: ${JSON.stringify(p.ran())}`);
});
