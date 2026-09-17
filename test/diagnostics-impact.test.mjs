import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers.mjs';
import { failureExcerpt, MAX_DIAGNOSTIC_CHARS } from '../dist/engine/diagnostic.js';
import { referenceTokens, buildInventory, testsReferencing } from '../dist/knowledge/inventory.js';
import { inspectRepository } from '../dist/knowledge/repository.js';

test('failed gate diagnostics keep the failures, not only the tail of passing output', () => {
  const passing = Array.from({ length: 400 }, (_, i) => `   ✓ suite > passing test number ${i} with a rather long descriptive name 3ms`);
  const output = [
    ' RUN  v3.2.7 /workspace',
    ...passing.slice(0, 150),
    '   × accounts > stores SQL payloads literally without altering tables 59ms',
    '     → expected [ { id: 1, …(5) } ] to deeply equal [ { id: 1, …(3) } ]',
    ...passing.slice(150, 300),
    ' FAIL  src/routes/page.server.test.ts > catalogue load > returns exactly the public keys',
    'AssertionError: expected [ \'author\', \'id\', \'price\', \'status\', \'title\' ] to deeply equal [ \'author\', \'id\', \'status\', \'title\' ]',
    ...passing.slice(300),
    ' Test Files  3 failed | 9 passed (12)',
    '      Tests  6 failed | 212 passed (218)',
  ].join('\n');
  assert.ok(output.length > MAX_DIAGNOSTIC_CHARS);
  const excerpt = failureExcerpt('failed', '', output);
  assert.ok(excerpt.length <= MAX_DIAGNOSTIC_CHARS);
  assert.match(excerpt, /stores SQL payloads literally/);
  assert.match(excerpt, /…\(5\) } \] to deeply equal/);
  assert.match(excerpt, /FAIL  src\/routes\/page\.server\.test\.ts/);
  assert.match(excerpt, /6 failed \| 212 passed/);
  assert.equal(failureExcerpt('failed', 'boom', 'short'), 'failed\nboom\nshort');
});

test('reference tokens follow import-like path fragments without naming a stack', () => {
  assert.deepEqual(referenceTokens('src/lib/server/db/index.ts'), ['server/db', 'server.db', 'db/index']);
  assert.deepEqual(referenceTokens('app/models/__init__.py'), ['app/models', 'app.models']);
  assert.deepEqual(referenceTokens('pkg/store/**'), ['pkg/store', 'pkg.store']);
  assert.deepEqual(referenceTokens('README.md'), []);
});

test('tests referencing a task scope are listed, and those outside it are flagged', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apv2-impact-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...a) => { const r = spawnSync('git', a, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  run('init', '-q'); run('config', 'user.email', 't@e.x'); run('config', 'user.name', 'T');
  const files = {
    'src/server/db/index.ts': 'export function openDb() {}\n',
    'src/server/db/db.test.ts': "import { openDb } from './index';\n",
    'src/routes/catalogue.test.ts': "import { openDb } from '../server/db';\n",
    'src/server/auth/auth.test.ts': "import { openDb } from '../db/index';\n",
    'src/other/unrelated.test.ts': "export const x = 1;\n",
  };
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); }
  run('add', '-A'); run('commit', '-qm', 'init');
  const inventory = await buildInventory(root, 'HEAD');
  const found = await testsReferencing(root, inventory, ['src/server/db/index.ts']);
  // db.test.ts reaches the file through the relative specifier './index'.
  assert.deepEqual(found.map(x => x.path), ['src/routes/catalogue.test.ts', 'src/server/auth/auth.test.ts', 'src/server/db/db.test.ts']);
  const ri = await inspectRepository(root, inventory.sha, 'db', { inventory, focusPaths: ['src/server/db/index.ts', 'src/routes/catalogue.test.ts'] });
  assert.deepEqual(ri.referencingTests.map(x => [x.path, x.outsideScope]), [['src/routes/catalogue.test.ts', false], ['src/server/auth/auth.test.ts', true], ['src/server/db/db.test.ts', true]]);
});

// Observed on a real increment: a test importing the changed module as '../db' was not detected (no
// distinctive token), and it also contained a literal control character, so Git classified it as binary.
test('tests reaching a changed file through a relative specifier are found, even when Git calls them binary', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apv2-impact-rel-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...a) => { const r = spawnSync('git', a, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  run('init', '-q'); run('config', 'user.email', 't@e.x'); run('config', 'user.name', 'T');
  const files = {
    'src/lib/server/db/index.ts': 'export function openDatabase() {}\n',
    'src/lib/server/auth/auth.test.ts': "import { openDatabase } from '../db';\nconst nul = '\u0000';\n",
    'src/lib/server/auth/other.test.ts': "import { x } from '../dbx';\n",
    'src/lib/server/store.test.py': "from . import helpers\nopen('./db/index.ts')\n",
  };
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); }
  run('add', '-A'); run('commit', '-qm', 'init');
  assert.match(run('diff', '--numstat', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'HEAD', '--', 'src/lib/server/auth/auth.test.ts'), /^-\t-\t/, 'the fixture is binary for Git');
  const inventory = await buildInventory(root, 'HEAD');
  const found = await testsReferencing(root, inventory, ['src/lib/server/db/index.ts']);
  assert.deepEqual(found.map(x => x.path), ['src/lib/server/auth/auth.test.ts', 'src/lib/server/store.test.py'], "'../dbx' is a different module and is not matched");
  assert.deepEqual(found[0].tokens, ['../db'], 'found through the relative specifier, in a file Git calls binary');
  assert.ok(found[1].tokens.includes('./db/index.ts'), 'the same resolution works for any language quoting a relative path');
});

// Observed on a real run: a provider exited non-zero with an empty stderr and its explanation on stdout.
// The controller reported `Agent failed: ` — no exit code, no output, nothing to act on.
test('a failing provider is reported with its exit code and its own output', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apv2-agent-diag-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worker = join(root, 'refusing-worker.mjs');
  writeFileSync(worker, `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_budget', is_error: true, result: 'Budget limit of $5.00 reached before completion.' }) + '\\n');\nprocess.exit(1);\n`);
  const f = fixture(t, { config: { agent: { type: 'command', command: [process.execPath, worker] } } });
  const finished = await f.start();
  // The attempt stays salvageable: the provider may have written files before its budget ran out.
  assert.equal(finished.state, 'interrupted');
  assert.equal(finished.resumeFrom, 'implementing');
  assert.equal(finished.candidateSha, null, 'nothing is adopted without an explicit decision');
  assert.match(finished.error.message, /exit 1/, 'the exit code is reported');
  assert.match(finished.error.message, /error_max_budget|Budget limit/, 'the provider explanation reaches the operator');
});
