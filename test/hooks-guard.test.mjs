import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateCommand, isStackMerge, REASONS, tokenize } from '../hooks/scripts/bash-guard.mjs';

const script = fileURLToPath(new URL('../hooks/scripts/bash-guard.mjs', import.meta.url));
const hooksFile = fileURLToPath(new URL('../hooks/hooks.json', import.meta.url));

function runHook(payload, env = {}) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const cleanEnv = { ...process.env, APV_ALLOW_MERGE: '', APV_ALLOW_DEPLOY: '', ...env };
  return spawnSync(process.execPath, [script], { input, env: cleanEnv, encoding: 'utf8' });
}
const bash = command => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: '/tmp' });
const decision = (command, env) => evaluateCommand(command, env).decision;

test('force-push is blocked in every usual spelling', () => {
  for (const command of [
    'git push --force',
    'git push -f origin main',
    'git push -uf origin feature',
    'git push --force-with-lease origin main',
    'git push --force-with-lease=main:abc123 origin main',
    'git push --force-if-includes origin main',
    'git push origin +main',
    'git push origin +HEAD:spec/2',
    'git -C ../wt push --force',
    'npm test && git push -f',
    'cd repo; git push --force origin x',
    '/usr/bin/git push --force',
    'echo $(git push --force)',
  ]) assert.deepEqual(evaluateCommand(command, {}), { decision: 'deny', reason: REASONS.forcePush }, command);
});

test('ordinary pushes and text that merely mentions a force-push are allowed', () => {
  for (const command of [
    'git push',
    'git push -u origin spec/3-t2',
    'git push origin main',
    'git commit -m "docs: interdire git push --force"',
    "git commit -m 'git push -f est interdit'",
    'cat > notes.md <<EOF\ngit push --force\nEOF\ngit add notes.md',
    "cat <<-'FIN'\n\tgit push -f\n\tFIN",
    'echo "git push --force" # rappel',
    'git log --format=%s | grep force',
  ]) assert.equal(decision(command, {}), 'allow', command);
});

test('pull request merges are blocked unless explicitly authorised', () => {
  for (const command of ['gh pr merge 5 --squash', 'gh pr merge', 'gh -R o/r pr merge 3', 'gh api -X PUT repos/o/r/pulls/3/merge']) {
    assert.deepEqual(evaluateCommand(command, {}), { decision: 'deny', reason: REASONS.merge }, command);
  }
  assert.equal(decision('APV_ALLOW_MERGE=1 gh pr merge 5 --merge', {}), 'allow');
  assert.equal(decision('env APV_ALLOW_MERGE=1 gh pr merge 5 --merge', {}), 'allow');
  assert.equal(decision('gh pr merge 5 --merge', { APV_ALLOW_MERGE: '1' }), 'allow');
  assert.equal(decision('APV_ALLOW_MERGE=0 gh pr merge 5', {}), 'deny');
  assert.equal(decision('APV_ALLOW_DEPLOY=1 gh pr merge 5', {}), 'deny');
  // The authorisation applies to its own command only.
  assert.equal(decision('APV_ALLOW_MERGE=1 true; gh pr merge 5', {}), 'deny');
});

test('apv stack merge needs the same explicit authorisation as gh pr merge', () => {
  for (const command of [
    'apv stack merge 11 12 13',
    'apv stack merge 11 --method squash --ready',
    'apv stack --method squash merge 11',
    '/usr/local/bin/apv stack merge 3',
    'npx apv stack merge 4',
    'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" stack merge 5',
    'node dist/cli.js stack merge 6 --json',
    'cd projet && apv stack merge 7',
    'APV_ALLOW_MERGE=0 apv stack merge 8',
    'APV_ALLOW_MERGE=1 true; apv stack merge 9',
  ]) assert.deepEqual(evaluateCommand(command, {}), { decision: 'deny', reason: REASONS.merge }, command);
  for (const command of [
    'APV_ALLOW_MERGE=1 apv stack merge 11 12 13',
    'env APV_ALLOW_MERGE=1 node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" stack merge 11 12',
    'apv stack plan 11 12 13',
    'node dist/cli.js stack plan 11 --json',
    'apv stack --help',
    'echo apv stack merge 11',
    'git commit -m "apv stack merge 11"',
    'apv run next merge',
  ]) assert.equal(decision(command, {}), 'allow', command);
  assert.equal(decision('apv stack merge 11', { APV_ALLOW_MERGE: '1' }), 'allow');
  // It writes to GitHub: its output must stay visible, even when authorised.
  assert.deepEqual(evaluateCommand('APV_ALLOW_MERGE=1 apv stack merge 11 > /dev/null', {}), { decision: 'deny', reason: REASONS.hiddenOutput });
  assert.equal(isStackMerge(['apv', 'stack', 'merge']), true);
  assert.equal(isStackMerge(['apv', 'merge', 'stack']), false);
  assert.equal(isStackMerge([]), false);
});

test('production deploys are blocked unless explicitly authorised', () => {
  for (const command of ['vercel deploy --prod', 'vercel --prod', 'npx vercel --prod --yes', 'vercel deploy --target production',
    'vercel deploy --target=production', 'vercel promote https://x.vercel.app', 'vercel rollback']) {
    assert.deepEqual(evaluateCommand(command, {}), { decision: 'deny', reason: REASONS.deploy }, command);
  }
  assert.equal(decision('vercel deploy', {}), 'allow');
  assert.equal(decision('vercel env ls', {}), 'allow');
  assert.equal(decision('APV_ALLOW_DEPLOY=1 vercel deploy --prod', {}), 'allow');
  assert.equal(decision('vercel deploy --prod', { APV_ALLOW_DEPLOY: '1' }), 'allow');
});

test('GitHub writes with hidden output are blocked, even when authorised (incident 30)', () => {
  for (const command of [
    'gh pr edit 3 --base main >/dev/null 2>&1',
    'gh pr edit 3 --base main > /dev/null',
    'gh pr create --fill 2>/dev/null',
    'gh pr edit 3 --base main &>/dev/null',
    'gh pr comment 3 --body ok >& /dev/null',
    'gh pr edit 3 --base main | cat > /dev/null',
    'gh pr edit 3 --base main | tee /dev/null',
    'for p in 3 4 5; do gh pr edit $p --base main >/dev/null 2>&1; done',
    '{ gh pr edit 3 --base main; } >/dev/null 2>&1',
    'APV_ALLOW_MERGE=1 gh pr merge 3 --merge >/dev/null 2>&1',
    'gh api -X PATCH repos/o/r/pulls/3 -f base=main >/dev/null',
  ]) assert.deepEqual(evaluateCommand(command, {}), { decision: 'deny', reason: REASONS.hiddenOutput }, command);
});

test('reads, visible writes and quoted redirections are allowed', () => {
  for (const command of [
    'gh pr view 3 --json baseRefName >/dev/null',
    'gh pr list 2>/dev/null',
    'gh api repos/o/r/pulls/3 > /dev/null',
    'gh pr edit 3 --base main',
    'gh pr create --title "Spec 2" --body "Rediriger vers >/dev/null est interdit"',
    "gh pr create --title t --body \"$(cat <<'EOF'\nL'état : git push --force reste interdit.\n>/dev/null\nEOF\n)\"",
    'git status >/dev/null 2>&1',
    '',
    '   ',
  ]) assert.equal(decision(command, {}), 'allow', command);
});

test('tokenize removes quotes, splits operators and blanks heredoc bodies', () => {
  const { segments, shadow } = tokenize('A=1 gh pr edit "3" --title \'x y\' && cat <<EOF\n>/dev/null\nEOF\necho fin');
  assert.deepEqual(segments, [['A=1', 'gh', 'pr', 'edit', '3', '--title', 'x y'], ['cat'], ['echo', 'fin']]);
  assert.ok(!shadow.includes('/dev/null'));
});

test('the hook script denies with the documented PreToolUse output and exit code 2', () => {
  const result = runHook(bash('git push --force origin main'));
  assert.equal(result.status, 2);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output, {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASONS.forcePush },
  });
  assert.match(result.stderr, /force-push interdit/);
});

test('the hook script allows silently, and honours the environment authorisation', () => {
  for (const payload of [bash('npm test'), bash('gh pr view 3'), { tool_name: 'Edit', tool_input: { file_path: 'x' } }, 'pas du JSON', '']) {
    const result = runHook(payload);
    assert.equal(result.status, 0, JSON.stringify(payload));
    assert.equal(result.stdout, '');
  }
  assert.equal(runHook(bash('gh pr merge 3 --merge')).status, 2);
  const allowed = runHook(bash('gh pr merge 3 --merge'), { APV_ALLOW_MERGE: '1' });
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, '');
});

test('hooks.json registers the four hooks in exec form with the plugin root placeholder', () => {
  const config = JSON.parse(readFileSync(hooksFile, 'utf8'));
  assert.deepEqual(Object.keys(config.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
  assert.equal(config.hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(config.hooks.PostToolUse[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit');
  for (const [event, groups] of Object.entries(config.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.equal(hook.type, 'command', event);
        assert.equal(hook.command, 'node', event);
        assert.match(hook.args[0], /^\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/scripts\/[a-z-]+\.mjs$/, event);
        const scriptPath = fileURLToPath(new URL(`../${hook.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', '')}`, import.meta.url));
        assert.ok(readFileSync(scriptPath, 'utf8').length > 0, scriptPath);
      }
    }
  }
});
