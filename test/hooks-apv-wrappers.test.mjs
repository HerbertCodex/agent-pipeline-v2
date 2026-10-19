import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { REASONS, apvWrapped, evaluateCommand, shellLine, tokenize } from '../hooks/scripts/bash-guard.mjs';
import { EMPTY_CONTEXT } from '../hooks/scripts/harness-guard.mjs';

/**
 * apv wrappers (review of 1786b40, C1 and H1): the command of `apv suite share … --` and `apv lock run … --` is examined
 * by every rule of the guard, as if it stood alone on the line, in the session and in a subagent.
 */

const script = fileURLToPath(new URL('../hooks/scripts/bash-guard.mjs', import.meta.url));
const session = [{ pid: 4242, pgid: 4200, comm: 'claude' }, { pid: 4100, pgid: 4000, comm: 'code' }, { pid: 900, pgid: 900, comm: 'bash' }];
const as = agentType => ({ ...EMPTY_CONTEXT, ancestors: () => session, agentType, agentId: agentType ? 'a1' : null });
const WRAPPERS = ['apv suite share --', 'apv suite share --wait-ms 5 --', 'npx apv suite share --', 'node /p/dist/cli.js suite share --',
  'timeout 60 apv suite share --', 'apv lock run e2e --', 'apv lock run e2e --wait-ms 9 --'];

function runHook(command, cwd) {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
  const r = spawnSync(process.execPath, [script], { input, cwd, env: { ...process.env, APV_ALLOW_MERGE: '', APV_ALLOW_DEPLOY: '', APV_LOCK_HELD: '', CLAUDE_PROJECT_DIR: '' }, encoding: 'utf8' });
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return { decision: out?.hookSpecificOutput?.permissionDecision ?? 'allow', reason: out?.hookSpecificOutput?.permissionDecisionReason ?? '' };
}

test('a forbidden command behind apv suite share or apv lock run is refused, in the session and in a subagent', () => {
  // Rules that hold for everyone: refused as the bare command is.
  for (const inner of ['bash -c "git push --force origin feat"', 'git push --force origin feat', 'pkill -f node', 'killall node', 'kill $PPID',
    'supabase db push --linked', 'sh -c "pkill -f vite"']) {
    assert.equal(evaluateCommand(inner, {}, as(null)).decision, 'deny', inner);
    for (const wrapper of WRAPPERS) {
      for (const agent of [null, 'apv:implementer']) {
        assert.equal(evaluateCommand(`${wrapper} ${inner}`, {}, as(agent)).decision, 'deny', `${wrapper} ${inner} (${agent})`);
      }
    }
  }
  // Rules of the subagents: the release, the merge, the review record of another role (H1: the authorisation set for the
  // wrapped command, `env APV_ALLOW_MERGE=1 …`, does not open them to a subagent either).
  for (const inner of ['apv release auto', 'env APV_ALLOW_MERGE=1 apv release auto', 'APV_ALLOW_MERGE=1 apv release 1234567', 'apv stack merge 3',
    'env APV_ALLOW_MERGE=1 apv stack merge 3', 'apv stack batch 3 4 --merge', 'apv review record --domain securite --reviewer apv:qa-securite --commit abc']) {
    for (const wrapper of WRAPPERS) {
      assert.equal(evaluateCommand(`${wrapper} ${inner}`, {}, as('apv:implementer')).decision, 'deny', `${wrapper} ${inner}`);
    }
  }
  // An authorisation set in front of the wrapper is not set for the command that releases or merges.
  for (const line of ['APV_ALLOW_MERGE=1 apv suite share -- apv release auto', 'APV_ALLOW_MERGE=1 apv lock run e2e -- apv stack merge 3']) {
    assert.equal(evaluateCommand(line, {}, as('apv:implementer')).decision, 'deny', line);
    assert.equal(evaluateCommand(line, {}, as(null)).decision, 'deny', `${line} (session)`);
  }
  // The lead's own review record behind a wrapper: refused as bare.
  assert.equal(evaluateCommand('apv suite share -- apv review record --domain securite --reviewer apv:qa-securite --commit abc', {}, as(null)).decision, 'deny');
  // Wrappers stacked beyond what the guard reads: refused, never let through.
  assert.deepEqual(evaluateCommand('apv suite share -- apv suite share -- apv lock run x -- apv suite share -- npm test', {}, as(null)),
    { decision: 'deny', reason: REASONS.wrapperDepth });
});

test('what the bare command may do stays allowed behind the wrappers', () => {
  for (const inner of ['npm run test:e2e', 'npx playwright test --project chromium', 'git commit -m "cite \'$x\' and \\"y\\" \\\\ z"', 'kill 12345']) {
    for (const wrapper of WRAPPERS) {
      for (const agent of [null, 'apv:implementer']) {
        const r = evaluateCommand(`${wrapper} ${inner}`, {}, as(agent));
        assert.equal(r.decision, 'allow', `${wrapper} ${inner} (${agent}): ${r.reason}`);
      }
    }
  }
  // The lead releases and merges with the authorisation set for that very command; the reviewer records its review.
  assert.equal(evaluateCommand('apv lock run e2e -- env APV_ALLOW_MERGE=1 apv release auto', {}, as(null)).decision, 'allow');
  assert.equal(evaluateCommand('apv suite share -- env APV_ALLOW_MERGE=1 apv stack merge 3', {}, as(null)).decision, 'allow');
  assert.equal(evaluateCommand('apv suite share -- apv review record --domain securite --reviewer apv:qa-securite --commit abc', {}, as('apv:qa-securite')).decision, 'allow');
});

test('shellLine gives back the words of the wrapped command; apvWrapped reads lock run and suite share only', () => {
  for (const line of ['git commit -m "a \\"b\\" \'$x\' c\\\\d `e`"', 'kill $PPID', "echo '`x`' \"$(id)\" plain", 'printf "%s\\n" "it\'s"']) {
    const words = tokenize(line).segments[0];
    assert.deepEqual(tokenize(shellLine(words)).segments, [words], line);
  }
  assert.deepEqual(apvWrapped(['apv', 'suite', 'share', '--wait-ms', '5', '--', 'npm', 'test']), { words: ['npm', 'test'], resource: null });
  assert.deepEqual(apvWrapped(['npx', 'apv', 'lock', 'run', 'e2e', '--', 'x']), { words: ['x'], resource: 'e2e' });
  assert.equal(apvWrapped(['apv', 'gates', 'run', '--', 'x']), null);
});

test('a declared stack behind apv suite share needs its lock; apv lock run of its resource holds it', t => {
  const root = mkdtempSync(join(tmpdir(), 'apv-wrappers-stack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.apv'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const lock1 = join(root, '.e2e.lock'); const lock2 = join(root, '.e2e-2.lock');
  writeFileSync(lock1, ''); writeFileSync(lock2, '');
  writeFileSync(join(repo, '.apv', 'config.json'), JSON.stringify({ stacks: [
    { id: '1', lockFile: lock1, dockerProject: 'proj' }, { id: '2', lockFile: lock2, dockerProject: 'proj-2', resource: 'e2e-2' },
  ] }));
  mkdirSync(join(repo, 'supabase'));
  writeFileSync(join(repo, 'supabase', 'config.toml'), 'project_id = "proj"\n');
  for (const command of ['apv suite share -- docker compose -p proj down', 'apv suite share -- docker restart supabase_db_proj-2',
    'apv lock run other -- docker restart supabase_db_proj-2', 'apv suite share -- npx supabase db reset']) {
    const r = runHook(command, repo);
    assert.equal(r.decision, 'deny', command);
    assert.match(r.reason, /sans tenir son verrou/, command);
  }
  for (const command of ['apv lock run e2e-2 -- docker restart supabase_db_proj-2', 'apv suite share -- apv lock run e2e-2 -- docker restart supabase_db_proj-2',
    'npx apv lock run e2e-2 -- docker restart supabase_db_proj-2', 'apv suite share -- docker ps', `flock ${lock1} apv suite share -- docker compose -p proj down`]) {
    const r = runHook(command, repo);
    assert.equal(r.decision, 'allow', `${command}: ${r.reason}`);
  }
});
