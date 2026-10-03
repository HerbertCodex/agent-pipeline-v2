import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { heldByCopies, portsWaitMs } from '../dist/gates/run.js';
import { DEFAULT_LOCK_WAIT_MS } from '../dist/domain/contracts.js';

/**
 * GATE_BUSY and the ports of the suite (pipeline review of 3 October 2026, point b8): ports held by another copy of the
 * repository (a review that captures, a dynamic scan, another suite) are waited for, up to the lock delay of the checks,
 * each wait said; a port held by a process outside a copy (the main checkout, a tool) refuses the suite at once, as before.
 */

const node = code => [process.execPath, '-e', code];
const noProc = !existsSync('/proc/net/tcp') && 'no /proc';
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

/** A committed project with a full check under a lease of `waitMs` (the delay the ports are waited for), its test ports declared. */
function project(t, ports, waitMs) {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { gates: [{ id: 'e2e', stage: 'full', command: node('0'), lock: { resource: 'e2e', waitMs } }], suite: { ports } });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  const copy = join(f.root, 'copy'); const sibling = join(f.root, 'sibling');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'copy', copy, 'HEAD');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'sibling', sibling, 'HEAD');
  const env = { APV_LOCK_DIR: join(f.root, 'locks'), APV_LOCK_POLL_MS: '20', APV_PORTS_POLL_MS: '50' };
  return { ...f, copy, sibling, env, run: (cwd, args, onStderr) => apv(cwd, ['gates', 'run', '--json', ...args], env, { onStderr }) };
}
const noReceipt = copy => !existsSync(join(copy, '.apv/receipts')) || readdirSync(join(copy, '.apv/receipts')).every(d => d === '.gitignore');

test('ports held by another copy of the repository: the suite waits, says it, and starts once they are freed', { skip: noProc }, async t => {
  const port = await freePort();
  const p = project(t, [port], 10_000);
  const theirs = await server(t, p.sibling, port);
  // Released on an observed fact: once the suite announces its wait, the review « finishes » 300 ms later.
  let announced = null;
  const onStderr = text => {
    if (announced !== null || !text.includes('Attente de leur libération')) return;
    announced = Date.now();
    setTimeout(() => { process.kill(theirs.child.pid, 'SIGKILL'); }, 300);
  };
  const r = await p.run(p.copy, [], onStderr);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.notEqual(announced, null, 'the wait was announced');
  assert.match(r.stderr, new RegExp(`Ports de la suite tenus par une autre copie du dépôt \\(une relecture, un scan dynamique ou une autre suite\\) : port ${port} tenu par le pid ${theirs.child.pid} \\(.*sibling\\)`));
  assert.match(r.stderr, /Attente de leur libération, jusqu'à 10 s \(délai de verrou des contrôles\), relue toutes les 0 s\./);
  assert.match(r.stderr, /Ports de la suite libérés après \d+ s : la suite démarre\./);
  const wait = r.json().ports.wait;
  assert.equal(wait.outcome, 'freed');
  assert.ok(wait.ms >= 300, `waited ${wait.ms} ms`);
  assert.deepEqual(wait.holders.map(h => [h.pid, h.ports]), [[theirs.child.pid, [port]]]);
  assert.deepEqual(r.json().ports.left, []);
  assert.deepEqual(r.json().gates.map(g => [g.gate, g.status]), [['e2e', 'passed']]);
  assert.equal(await theirs.exited, true);
});

test('ports still held by another copy after the lock delay: refused, nothing run, the wait said', { skip: noProc }, async t => {
  const port = await freePort();
  const p = project(t, [port], 400);
  const theirs = await server(t, p.sibling, port);
  const r = await p.run(p.copy, []);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /Attente de leur libération, jusqu'à 0 s/);
  assert.match(r.stderr, /Ports de la suite toujours tenus après \d+ s \(délai de verrou\) : refus\./);
  assert.match(r.stderr, new RegExp(`Suite complète refusée, rien n'a été exécuté après \\d+ s d'attente des ports : port ${port} tenu par le pid ${theirs.child.pid} \\(une autre copie du dépôt`));
  assert.match(r.stderr, /apv procs stop --port <p>/);
  assert.ok(noReceipt(p.copy), 'no receipt written');
  assert.ok(alive(theirs.child.pid), 'the other copy is never stopped');
});

test('a port held by the main checkout, or by another copy beside it, refuses the suite at once: no wait', { skip: noProc }, async t => {
  const [main, other] = [await freePort(), await freePort()];
  const p = project(t, [main, other], 10_000);
  const operator = await server(t, p.repo, main);
  const started = Date.now();
  const r = await p.run(p.copy, []);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /Attente de leur libération/);
  assert.match(r.stderr, new RegExp(`Suite complète refusée, rien n'a été exécuté : port ${main} tenu par le pid ${operator.child.pid} \\(le checkout principal`));
  assert.ok(Date.now() - started < 5000, 'refused without waiting');
  // Another copy holds a port too: the main checkout's one decides, still no wait.
  const theirs = await server(t, p.sibling, other);
  const both = await p.run(p.copy, []);
  assert.equal(both.code, 1);
  assert.doesNotMatch(both.stderr, /Attente de leur libération/);
  assert.match(both.stderr, new RegExp(`port ${other} tenu par le pid ${theirs.child.pid} \\(une autre copie du dépôt`));
  assert.match(both.stderr, new RegExp(`port ${main} tenu par le pid ${operator.child.pid} \\(le checkout principal`));
  assert.ok(alive(operator.child.pid) && alive(theirs.child.pid));
});

test('heldByCopies and portsWaitMs: only copies of the repository are waited for, up to the longest lock delay of the checks', () => {
  const left = (reason, pid = 1) => ({ pid, ports: [4173], command: 'x', worktree: '/w', reason });
  const record = l => ({ ports: [4173], stopped: [], left: l, unsupported: null, wait: null });
  assert.equal(heldByCopies(null), false);
  assert.equal(heldByCopies(record([])), false, 'nothing held: nothing to wait for');
  assert.equal(heldByCopies(record([left('other-copy')])), true);
  assert.equal(heldByCopies(record([left('other-copy'), left('other-copy', 2)])), true);
  for (const reason of ['main-checkout', 'outside', 'tool', 'protected', 'unknown-cwd']) {
    assert.equal(heldByCopies(record([left(reason)])), false, reason);
    assert.equal(heldByCopies(record([left('other-copy'), left(reason, 2)])), false, `other-copy beside ${reason}`);
  }
  assert.equal(portsWaitMs([{ id: 'a', lock: { kind: 'flock', file: '/l', waitMs: 1000 } }, { id: 'b', lock: { resource: 'e2e', waitMs: 2500 } }, { id: 'c' }]), 2500);
  assert.equal(portsWaitMs([{ id: 'c' }]), DEFAULT_LOCK_WAIT_MS);
});
