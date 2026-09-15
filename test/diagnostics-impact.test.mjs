import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
  assert.deepEqual(found.map(x => x.path), ['src/routes/catalogue.test.ts', 'src/server/auth/auth.test.ts']);
  const ri = await inspectRepository(root, inventory.sha, 'db', { inventory, focusPaths: ['src/server/db/index.ts', 'src/routes/catalogue.test.ts'] });
  assert.deepEqual(ri.referencingTests.map(x => [x.path, x.outsideScope]), [['src/routes/catalogue.test.ts', false], ['src/server/auth/auth.test.ts', true]]);
});
