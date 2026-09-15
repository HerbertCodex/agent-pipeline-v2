import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, environment, PIPE_GRACE_MS } from '../dist/execution/process.js';

// Regression: a command whose descendant leaves the process group (for example a detached daemon)
// while inheriting stdout/stderr kept the pipes open, so runProcess never resolved, even past its
// timeout. On a CI runner this surfaced as a cancelled lifecycle session and a killed test run.
test('runProcess resolves when a detached descendant keeps the stdio pipes open', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apv2-escape-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'escape.mjs');
  writeFileSync(script, `import { spawn } from 'node:child_process';
const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'inherit' });
process.stdout.write('done\\n'); process.stderr.write('grandchild ' + g.pid + '\\n'); g.unref(); process.exit(0);`);
  const started = Date.now();
  const result = await runProcess({ command: [process.execPath, script], cwd: root, env: environment(['PATH']), timeoutMs: 3000 });
  const pid = Number(/grandchild (\d+)/.exec(result.stderr)?.[1]);
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });
  assert.equal(result.status, 'passed');
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /done/);
  assert.ok(Date.now() - started < PIPE_GRACE_MS + 5000, `resolved after ${Date.now() - started} ms`);
});

test('a normal command still resolves immediately without waiting for the pipe grace period', async () => {
  const started = Date.now();
  const result = await runProcess({ command: [process.execPath, '-e', 'console.log("ok")'], cwd: tmpdir(), env: environment(['PATH']), timeoutMs: 10000 });
  assert.equal(result.status, 'passed');
  assert.equal(result.stdout.trim(), 'ok');
  assert.ok(Date.now() - started < PIPE_GRACE_MS, 'no artificial delay for well-behaved commands');
});
