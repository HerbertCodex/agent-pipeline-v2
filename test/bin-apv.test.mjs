import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/apv', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const nodeDir = dirname(process.execPath);
const FAKE = 'faux outil lancé';

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A directory an attacker controls: a fake `node` and a fake `apv` executable, a fake `dist/cli.js`
 * and a fake `bin/apv`, all printing the same marker with a distinctive exit code.
 */
function hostileDir(t) {
  const dir = tempDir(t, 'apv-bin-hostile-');
  const script = `#!/bin/sh\necho "${FAKE}"\nexit 97\n`;
  for (const name of ['node', 'apv', 'bin/apv']) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), script);
    chmodSync(join(dir, name), 0o755);
  }
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'cli.js'), `console.log(${JSON.stringify(FAKE)}); process.exit(97);\n`);
  writeFileSync(join(dir, 'package.json'), '{"type": "module"}\n');
  return dir;
}

function run(command, args, { cwd, env = {} }) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(result.error, undefined, String(result.error));
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('bin/apv gives the same output and exit code as node dist/cli.js from another directory', t => {
  const elsewhere = tempDir(t, 'apv-bin-cwd-');
  const cases = [['--version'], ['help'], ['help', 'run'], ['commande-inconnue', 'un argument avec espaces']];
  for (const args of cases) {
    const expected = run(process.execPath, [cli, ...args], { cwd: elsewhere });
    // Run through its shebang, as Claude Code runs it from the plugin's bin/ directory on the PATH.
    const actual = run(bin, args, { cwd: elsewhere });
    assert.deepEqual(actual, expected, `apv ${args.join(' ')}`);
  }
  assert.equal(run(bin, ['--version'], { cwd: elsewhere }).status, 0);
  assert.match(run(bin, ['help'], { cwd: elsewhere }).stdout, /Utilisation : apv <commande>/);
  assert.equal(run(bin, ['commande-inconnue'], { cwd: elsewhere }).status, 2);
});

test('bin/apv runs the plugin dist despite a fake node and a fake dist/cli.js in the current directory and at the head of PATH', t => {
  const hostile = hostileDir(t);
  const expected = run(process.execPath, [cli, '--version'], { cwd: tmpdir() });
  const env = {
    PATH: [hostile, '.', process.env.PATH].join(delimiter),
    CLAUDE_PLUGIN_ROOT: hostile,
    APV_ROOT: hostile,
    NODE_PATH: hostile,
  };
  const actual = run(process.execPath, [bin, '--version'], { cwd: hostile, env });
  assert.deepEqual(actual, expected);
  assert.ok(!actual.stdout.includes(FAKE));
});

test('bin/apv run by its shebang ignores the current directory and the rest of PATH', t => {
  const hostile = hostileDir(t);
  // The interpreter itself is found by the system through the shebang; everything after that is the script's.
  const env = { PATH: [nodeDir, hostile, '.'].join(delimiter), CLAUDE_PLUGIN_ROOT: hostile, APV_ROOT: hostile };
  const expected = run(process.execPath, [cli, 'help'], { cwd: tmpdir() });
  const actual = run(bin, ['help'], { cwd: hostile, env });
  assert.deepEqual(actual, expected);
  assert.ok(!actual.stdout.includes(FAKE));
});

test('bin/apv reached through a symlink still runs the dist next to its real location', t => {
  const hostile = hostileDir(t);
  // The link sits beside a fake dist/cli.js: resolving from the link instead of the real file would run it.
  // --preserve-symlinks-main makes Node report the link as the script's URL, so only the script's own resolution protects it.
  rmSync(join(hostile, 'bin', 'apv'));
  symlinkSync(bin, join(hostile, 'bin', 'apv'));
  const expected = run(process.execPath, [cli, '--version'], { cwd: tmpdir() });
  const actual = run(join(hostile, 'bin', 'apv'), ['--version'], {
    cwd: hostile, env: { PATH: [nodeDir, process.env.PATH].join(delimiter), NODE_OPTIONS: '--preserve-symlinks-main' },
  });
  assert.deepEqual(actual, expected);
  assert.ok(!actual.stdout.includes(FAKE));
});
