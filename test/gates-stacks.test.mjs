import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';

/** A full suite spread over two declared test stacks (docs/APV3-SPEC.md, section 18.6). */

const hasFlock = spawnSync('flock', ['--version']).status === 0;

/**
 * Two stacks (lock files, variables, an env file for the second), two checks of a stack that record where and with
 * what they ran and take `holdMs` each, a task check, and a setup that installs into an ignored folder.
 */
function project(t, { setup = null, holdMs = 1500 } = {}) {
  const f = fixture(t);
  const out = join(f.root, 'out');
  const lock1 = join(f.root, 'stack1.lock'); const lock2 = join(f.root, 'stack2.lock');
  writeFileSync(join(f.root, 'stack2.env'), '# pile 2\nexport STACK_URL="http://127.0.0.1:57521"\nIGNORED=1\n');
  const record = name => [process.execPath, '-e', `const fs = require("fs"); fs.mkdirSync(${JSON.stringify(out)}, { recursive: true });
const start = Date.now();
setTimeout(() => { fs.writeFileSync(${JSON.stringify(out)} + "/${name}.json", JSON.stringify({ cwd: process.cwd(), stack: process.env.STACK ?? null, url: process.env.STACK_URL ?? null,
  lockFile: process.env.LOCK_FILE ?? null, ignored: process.env.IGNORED ?? null, installed: fs.existsSync("node_modules/.installed"), start, end: Date.now() })); }, ${holdMs});`];
  const stackGate = name => ({ id: name, stage: 'full', command: record(name), timeoutMs: 60_000, passEnv: ['STACK', 'STACK_URL', 'LOCK_FILE', 'IGNORED'],
    resources: ['project-checks'], lock: { file: lock1, fileEnv: 'LOCK_FILE' } });
  write(f.repo, '.apv/config.json', {
    gates: [{ id: 'unit', command: [process.execPath, '-e', '0'], resources: ['project-checks'] }, stackGate('integration'), stackGate('browser')],
    stacks: [
      { id: '1', lockFile: lock1, env: { STACK: '1', STACK_URL: 'http://127.0.0.1:55321' } },
      { id: '2', lockFile: lock2, env: { STACK: '2' }, envFile: join(f.root, 'stack2.env') },
    ],
    batch: { setup: setup ?? [process.execPath, '-e', 'require("fs").mkdirSync("node_modules", { recursive: true }); require("fs").writeFileSync("node_modules/.installed", "")'] },
  });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  const common = realpathSync(resolve(f.repo, git(f.repo, 'rev-parse', '--git-common-dir')));
  const env = { APV_LOCK_DIR: join(f.root, 'locks'), APV_LOCK_POLL_MS: '20' };
  const ran = name => JSON.parse(readFileSync(join(out, `${name}.json`), 'utf8'));
  return { ...f, out, lock1, lock2, common, env, ran, run: (...args) => apv(f.repo, ['gates', 'run', ...args], env) };
}

test('--stacks 1,2: the checks of a stack are dealt to the stacks, in parallel, each with its variables, lock and copy', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = project(t);
  const r = await p.run('--stacks', '1,2', '--json');
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const result = r.json();
  assert.deepEqual(result.spread.map(a => [a.gate, a.stack, a.workspace === realpathSync(p.repo)]), [['integration', '1', true], ['browser', '2', false]]);
  const integration = p.ran('integration'); const browser = p.ran('browser');
  assert.equal(integration.cwd, realpathSync(p.repo));
  assert.deepEqual([integration.stack, integration.url, integration.lockFile], ['1', 'http://127.0.0.1:55321', p.lock1]);
  assert.match(browser.cwd, new RegExp(`${p.common.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/apv/copies/[^/]+-2$`));
  assert.deepEqual([browser.stack, browser.url, browser.lockFile, browser.ignored, browser.installed], ['2', 'http://127.0.0.1:57521', p.lock2, '1', true]);
  // Both ran at the same time, although they share the resource project-checks: each copy has its own scheduler.
  assert.ok(browser.start < integration.end && integration.start < browser.end, 'in parallel');
  const receipts = Object.fromEntries(result.gates.map(g => [g.gate, g]));
  assert.equal(receipts.integration.status, 'passed');
  const stored = JSON.parse(readFileSync(join(result.receiptsDirectory, 'browser.json'), 'utf8'));
  assert.equal(stored.stack, '2');
  assert.ok(stored.lockWaitMs !== undefined, 'under a lock');
  assert.ok(!existsSync(browser.cwd), 'the copy is removed at the end');
  assert.deepEqual(readdirSync(join(p.common, 'apv', 'copies')), []);
  // The receipts prove the suite at this commit, whatever the copy each check ran in.
  const verify = await apv(p.repo, ['gates', 'verify', '--commit', 'HEAD', '--json'], p.env);
  assert.equal(verify.code, 0, verify.stdout);
  // The use of each stack is noted for apv stacks idle-stop.
  for (const id of ['1', '2']) assert.ok(JSON.parse(readFileSync(join(p.common, 'apv', 'stacks', `${id}.json`), 'utf8')).lastUsedAt);
});

test('without --stacks the checks share one copy and run one after the other', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = project(t, { holdMs: 300 });
  const r = await p.run('--json');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().spread, null);
  const integration = p.ran('integration'); const browser = p.ran('browser');
  assert.equal(browser.cwd, realpathSync(p.repo));
  assert.ok(integration.end <= browser.start || browser.end <= integration.start, 'one after the other');
});

test('a copy that cannot be prepared: its checks are not run and say why; wrong calls are refused', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = project(t, { setup: [process.execPath, '-e', 'process.exit(4)'], holdMs: 100 });
  const r = await p.run('--stacks', '1,2', '--keep-going', '--json');
  assert.equal(r.code, 1);
  const browser = r.json().gates.find(g => g.gate === 'browser');
  assert.equal(browser.status, 'spawn_error');
  assert.match(browser.diagnostic, /Copie de la pile 2 non préparée : batch\.setup en échec \(failed, code 4\)/);
  assert.equal(r.json().gates.find(g => g.gate === 'integration').status, 'passed');
  assert.equal((await p.run('--stacks', '1')).code, 2);
  assert.equal((await p.run('--stacks', '1,1')).code, 2);
  assert.equal((await p.run('--stage', 'task', '--stacks', '1,2')).code, 2);
  const unknown = await p.run('--stacks', '1,9');
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /--stacks : pile inconnue 9/);
});

test('--stacks refuses a check that does not receive the variables selecting its stack; the other keys of an env file are only listed', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = project(t, { holdMs: 50 });
  const config = JSON.parse(readFileSync(join(p.repo, '.apv/config.json'), 'utf8'));
  config.gates[2].passEnv = ['STACK_URL', 'LOCK_FILE'];
  writeFileSync(join(p.repo, '.apv/config.json'), JSON.stringify(config));
  git(p.repo, 'commit', '-qam', 'passEnv sans STACK');
  const r = await p.run('--stacks', '1,2');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--stacks : le contrôle browser ne reçoit pas STACK, variable\(s\) qui désignent la pile 2 \(stacks\.2\.env\)/);
  assert.ok(!existsSync(join(p.out, 'integration.json')), 'nothing ran');
  config.gates[2].passEnv = ['STACK', 'STACK_URL', 'LOCK_FILE'];
  writeFileSync(join(p.repo, '.apv/config.json'), JSON.stringify(config));
  git(p.repo, 'commit', '-qam', 'passEnv avec STACK');
  const ok = await p.run('--stacks', '1,2', '--json');
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(ok.json().spread.find(a => a.gate === 'browser').notPassed, ['IGNORED']);
  assert.match(ok.stderr, /Note : browser ne reçoit pas IGNORED du fichier d'environnement de la pile 2/);
});

test('a suite warns when a stack it locks was stopped by apv stacks idle-stop and not restarted', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const p = project(t, { holdMs: 50 });
  const dir = join(p.common, 'apv', 'stacks');
  mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(join(dir, '1.json'), JSON.stringify({ version: 1, id: '1', lastObservedAt: at, lastUsedAt: at, freeSince: null, stoppedAt: at, startedAt: null, upAt: null }));
  const r = await p.run('--json');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json().stoppedStacks.map(x => [x.stack, x.gates]), [['1', ['integration', 'browser']]]);
  assert.match(r.stderr, /ATTENTION : la pile 1 a été arrêtée par apv stacks idle-stop le .* Redémarrer d'abord : apv stacks start 1\./);
  // The checks passed under its lock: the stack answered, the warning is gone.
  const again = await p.run('--json');
  assert.deepEqual(again.json().stoppedStacks, []);
});
