import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { evaluateCommand } from '../hooks/scripts/bash-guard.mjs';
import { EMPTY_CONTEXT, HARNESS_REASONS, commandWords, processAncestors, readStacks } from '../hooks/scripts/harness-guard.mjs';

const script = fileURLToPath(new URL('../hooks/scripts/bash-guard.mjs', import.meta.url));

function runHook(command, cwd, env = {}, launcher = []) {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
  const [bin, ...args] = launcher.length ? [...launcher, process.execPath, script] : [process.execPath, script];
  const r = spawnSync(bin, args, { input, cwd, env: { ...process.env, APV_ALLOW_MERGE: '', APV_ALLOW_DEPLOY: '', APV_LOCK_HELD: '', CLAUDE_PROJECT_DIR: '', ...env }, encoding: 'utf8' });
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return { status: r.status, decision: out?.hookSpecificOutput?.permissionDecision ?? 'allow', reason: out?.hookSpecificOutput?.permissionDecisionReason ?? '', stderr: r.stderr };
}

const tmp = (t, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const session = [{ pid: 4242, pgid: 4200, comm: 'claude' }, { pid: 4100, pgid: 4000, comm: 'code' }, { pid: 900, pgid: 900, comm: 'bash' }];
const withAncestors = { ...EMPTY_CONTEXT, ancestors: () => session };

test('commandWords skips assignments and wrappers (sudo, env, timeout, xargs, nohup)', () => {
  assert.deepEqual(commandWords(['A=1', 'sudo', '-u', 'root', 'kill', '1']).words, ['kill', '1']);
  assert.deepEqual(commandWords(['env', '-i', 'B=2', 'timeout', '5', 'npm', 'ci']).words, ['npm', 'ci']);
  assert.deepEqual(commandWords(['xargs', '-r', '-n', '1', 'kill', '-9']).words, ['kill', '-9']);
  assert.deepEqual(commandWords(['E2E_STACK=2', 'node', 'x.mjs']).assignments, ['E2E_STACK=2']);
  assert.equal(commandWords(['A=1']), null);
});

test('killall and pkill -f are refused in every spelling, with apv procs stop as the way', () => {
  for (const command of ['killall node', 'killall -9 vite', '/usr/bin/killall vite', 'pkill -f vite', 'pkill -9 -f "vite preview"', 'pkill -fx node',
    'pkill --full playwright', 'sudo pkill -f x', 'npm test; pkill -f "gates run"', 'bash -c "pkill -f vite"']) {
    const r = evaluateCommand(command, {}, EMPTY_CONTEXT);
    assert.equal(r.decision, 'deny', command);
    assert.equal(r.reason, HARNESS_REASONS.killall, command);
  }
  assert.match(HARNESS_REASONS.killall, /apv procs stop --port <p>/);
  // Text that mentions them is data.
  for (const command of ['echo "pkill -f x"', 'git commit -m "no more killall"', 'grep -rn "pkill -f" docs']) {
    assert.equal(evaluateCommand(command, {}, EMPTY_CONTEXT).decision, 'allow', command);
  }
});

test('kill of the session, of one of its parents or of their process group is refused; other pids are allowed', () => {
  for (const command of ['kill 4242', 'kill -9 4100', 'kill -TERM 900', 'kill -s KILL 4242', 'kill -- -4200', 'kill -9 -4000', 'sudo kill 4242',
    'echo x | xargs kill 4100', 'kill $PPID', 'kill -9 ${PPID}', 'kill 0', 'kill -9 -1', 'pkill claude', 'pkill -9 cod',
    'kill $(ps -o ppid= -p $$)', 'kill $(pgrep -f "vite preview")', 'pgrep -f vite | xargs kill', 'sh -c "kill 4242"']) {
    const r = evaluateCommand(command, {}, withAncestors);
    assert.equal(r.decision, 'deny', command);
    assert.match(r.reason, /apv procs/, command);
  }
  for (const command of ['kill 12345', 'kill -9 12345 23456', 'kill %1', 'kill -l', 'pkill vite', 'pkill -u me vite', 'kill -- -12345', 'pgrep -f vite', 'ps -o pid,ppid,cmd']) {
    assert.equal(evaluateCommand(command, {}, withAncestors).decision, 'allow', command);
  }
});

test('the real hook reads its ancestors in /proc: a kill of the process that launched it is refused', { skip: process.platform !== 'linux' }, t => {
  const dir = tmp(t, 'apv3-harness-kill-');
  const ancestors = processAncestors();
  assert.ok(ancestors.length > 0 && ancestors[0].pid === process.ppid);
  const r = runHook(`kill ${process.pid}`, dir);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, new RegExp(`le pid ${process.pid}`));
  assert.equal(runHook('kill 999999999', dir).decision, 'allow');
});

test('an install through a symlinked node_modules is refused; a real node_modules and other commands are allowed', t => {
  const root = tmp(t, 'apv3-harness-install-');
  const shared = join(root, 'main');
  const linked = join(root, 'wt');
  const plain = join(root, 'plain');
  for (const dir of [shared, linked, plain]) { mkdirSync(join(dir, 'sub'), { recursive: true }); writeFileSync(join(dir, 'package.json'), '{}\n'); }
  mkdirSync(join(shared, 'node_modules'));
  mkdirSync(join(plain, 'node_modules'));
  symlinkSync(join(shared, 'node_modules'), join(linked, 'node_modules'));
  const ctx = { ...EMPTY_CONTEXT, cwd: linked, home: root };
  for (const command of ['npm ci', 'npm install', 'npm i -D left-pad', 'npm --silent ci', 'pnpm install', 'pnpm add x', 'yarn', 'yarn install --frozen-lockfile',
    'bun install', 'cd sub && npm ci', 'NODE_ENV=test npm ci']) {
    const r = evaluateCommand(command, {}, ctx);
    assert.equal(r.decision, 'deny', command);
    assert.match(r.reason, new RegExp(`node_modules est un lien symbolique vers ${join(shared, 'node_modules').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`), command);
    assert.match(r.reason, /unlink /, command);
  }
  const other = { ...EMPTY_CONTEXT, cwd: plain, home: root };
  for (const [command, context] of [['npm ci', other], ['npm test', ctx], ['npm run build', ctx], ['npx vite build', ctx], [`cd ${plain} && npm ci`, ctx], ['pnpm run lint', ctx]]) {
    assert.equal(evaluateCommand(command, {}, context).decision, 'allow', command);
  }
  // The target directory given by an option or a cd, from anywhere.
  for (const command of [`npm ci --prefix ${linked}`, `npm ci --prefix=${linked}`, `pnpm -C ${linked} install`, `yarn --cwd ${linked} install`, `cd ${linked} && npm ci`, `cd ${join(linked, 'sub')}; npm install`]) {
    assert.equal(evaluateCommand(command, {}, other).decision, 'deny', command);
  }
  // The real hook takes the directory from the payload.
  const r = runHook('npm ci', linked);
  assert.equal(r.status, 2);
  assert.equal(r.decision, 'deny');
  assert.equal(runHook('npm ci', plain).decision, 'allow');
});

/** A repository that declares two test stacks, their lock files next to it. */
function stackRepo(t, stacks) {
  const root = tmp(t, 'apv3-harness-stack-');
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.apv'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const lock1 = join(root, 'pilot', '.e2e.lock');
  const lock2 = join(root, 'pilot', '.e2e-2.lock');
  mkdirSync(join(root, 'pilot'));
  writeFileSync(lock1, ''); writeFileSync(lock2, '');
  const declared = stacks ?? [
    { id: '1', lockFile: '../../pilot/.e2e.lock', dockerProject: 'proj', lockCommand: ['node', 'scripts/e2e/lock.mjs'], env: { E2E_STACK: '1' } },
    { id: '2', lockFile: lock2, dockerProject: 'proj-2', resource: 'e2e-2' },
  ];
  writeFileSync(join(repo, '.apv', 'config.json'), JSON.stringify({ stacks: declared }));
  mkdirSync(join(repo, 'supabase'));
  writeFileSync(join(repo, 'supabase', 'config.toml'), 'project_id = "proj"\n');
  mkdirSync(join(root, 'stack2', 'supabase'), { recursive: true });
  writeFileSync(join(root, 'stack2', 'supabase', 'config.toml'), '# pile 2\nproject_id = "proj-2"\n');
  return { root, repo, lock1, lock2 };
}

test('stacks: lock files resolve against the Git common directory; invalid entries are skipped', t => {
  const { repo, lock1, lock2 } = stackRepo(t, [
    { id: '1', lockFile: '../../pilot/.e2e.lock', dockerProject: 'proj' }, { id: '2', lockFile: '/abs/.e2e-2.lock' }, { id: 'bad id' }, { id: '3' }, 'x',
  ]);
  const stacks = readStacks(repo, join(repo, '.git'));
  assert.deepEqual(stacks.map(s => [s.id, s.lockFile]), [['1', lock1], ['2', '/abs/.e2e-2.lock']]);
  assert.ok(lock2);
});

test('docker or supabase on a declared stack without its lock is refused, with the command to use', t => {
  const { repo, root, lock1, lock2 } = stackRepo(t);
  for (const command of ['docker restart supabase_auth_proj', 'docker stop supabase_db_proj supabase_kong_proj', 'docker exec supabase_db_proj psql -c "select 1"',
    'docker compose -p proj down', 'docker container restart supabase_db_proj', 'docker rm -f supabase_db_proj', 'docker stop $(docker ps -q)',
    'docker system prune -f', 'npx supabase db reset', 'npx -y supabase@2.117.0 stop', 'supabase start', `supabase db reset --workdir ${join(root, 'stack2')}`,
    'SUPABASE_PROJECT_ID=proj-2 npx supabase migration up', 'bash -lc "docker restart supabase_auth_proj"', `flock ${lock2} docker restart supabase_auth_proj`,
    'E2E_STACK=2 node scripts/e2e/lock.mjs docker restart supabase_auth_proj']) {
    const r = runHook(command, repo);
    assert.equal(r.status, 2, `${command}\n${r.stderr}`);
    assert.equal(r.decision, 'deny', command);
    assert.match(r.reason, /sans tenir son verrou/, command);
    assert.match(r.reason, /flock -w 1800 /, command);
  }
  for (const command of ['docker ps', 'docker ps -a --filter label=com.supabase.cli.project=proj', 'docker logs -f supabase_auth_proj', 'docker inspect supabase_db_proj',
    'docker compose -p proj ps', 'docker restart unrelated_container', 'npx supabase status', 'npx supabase migration new x', 'supabase db push --linked',
    `flock ${lock1} docker restart supabase_auth_proj`, `flock -w 1800 ${lock1} docker restart supabase_auth_proj supabase_db_proj`, `flock ../pilot/.e2e.lock docker restart supabase_db_proj`,
    `flock ${lock1} bash -c "docker restart supabase_db_proj"`, `flock ${lock1} -c "npx supabase db reset"`, 'E2E_STACK=1 node scripts/e2e/lock.mjs docker restart supabase_auth_proj',
    `apv lock run e2e-2 -- docker restart supabase_db_proj-2`, `flock ${lock2} npx supabase db reset --workdir ${join(root, 'stack2')}`,
    'docker restart supabase_db_proj-3']) {
    const r = runHook(command, repo);
    assert.equal(r.decision, 'allow', `${command}\n${r.reason}`);
  }
  // A lease already held by the caller (APV_LOCK_HELD, set by apv lock run) covers the stack of that resource.
  assert.equal(runHook('docker restart supabase_db_proj-2', repo, { APV_LOCK_HELD: 'e2e-2' }).decision, 'allow');
  assert.equal(runHook('docker restart supabase_db_proj-2', repo, { APV_LOCK_HELD: 'e2e' }).decision, 'deny');
});

test('a flock held by an ancestor of the hook covers its stack (proved in /proc/locks)', { skip: process.platform !== 'linux' || spawnSync('flock', ['--version']).status !== 0 }, t => {
  const { repo, lock1 } = stackRepo(t);
  assert.equal(runHook('docker restart supabase_db_proj', repo, {}, ['flock', lock1]).decision, 'allow');
  assert.equal(runHook('docker restart supabase_db_proj', repo).decision, 'deny');
});

test('without declared stacks, docker and supabase commands are never blocked', t => {
  const { repo } = stackRepo(t, []);
  for (const command of ['docker restart supabase_auth_proj', 'npx supabase db reset', 'docker system prune -f']) {
    assert.equal(runHook(command, repo).decision, 'allow', command);
  }
});
