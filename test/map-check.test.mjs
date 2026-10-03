import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { comparableMap } from '../dist/commands/map.js';

/**
 * `apv map --check` and the counts « Laissés de côté » (pilot project, 3 October 2026, point b7 of the pipeline review):
 * a test file added or removed changes what the map leaves out, not what it describes; the check no longer fails for it.
 */

test('apv map --check: a test file added only changes the counts « Laissés de côté », the map stays up to date; a module added makes it stale', async t => {
  const f = fixture(t);
  assert.equal((await apv(f.repo, ['map'])).code, 0);
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'carte');
  const before = readFileSync(join(f.repo, '.apv/code-map.md'), 'utf8');
  assert.match(before, /Laissés de côté : 1 test\(s\)/);
  // A second test file: the map would now say « 2 test(s) », nothing else changes.
  write(f.repo, 'test/other.test.mjs', "import { test } from 'node:test';\ntest('x', () => {});\n");
  const check = await apv(f.repo, ['map', '--check', '--json']);
  assert.equal(check.code, 0, check.stdout + check.stderr);
  assert.equal(check.json().status, 'up-to-date');
  assert.equal(check.json().skippedOnly, true);
  const human = await apv(f.repo, ['map', '--check']);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /Carte du code à jour : \.apv\/code-map\.md .* ; seuls les comptes « Laissés de côté » diffèrent, non comparés \(apv map les actualise\)\./);
  // `apv map` (without --check) still refreshes the counts.
  assert.match((await apv(f.repo, ['map'])).stdout, /Carte du code écrite/);
  assert.match(readFileSync(join(f.repo, '.apv/code-map.md'), 'utf8'), /Laissés de côté : 2 test\(s\)/);
  assert.equal((await apv(f.repo, ['map', '--check', '--json'])).json().skippedOnly, undefined, 'identical text: nothing to say');
  // The other direction: a module added (described by the map) makes it stale, as before.
  write(f.repo, 'src/other.mjs', 'export const other = 1;\n');
  const stale = await apv(f.repo, ['map', '--check', '--json']);
  assert.equal(stale.code, 1);
  assert.equal(stale.json().status, 'stale');
  assert.ok(stale.json().difference.onlyExpected.some(l => l.includes('other.mjs')), JSON.stringify(stale.json().difference));
});

test('comparableMap: only the clause « Laissés de côté » is neutralised, every other line counts', () => {
  const a = 'Routes : 2. Laissés de côté : 3 test(s), 4 fichier(s) ignoré(s), 0 module(s) sans export ni import.\n## Routes\n- a\n';
  const b = 'Routes : 2. Laissés de côté : 9 test(s), 1 fichier(s) ignoré(s), 2 module(s) sans export ni import.\n## Routes\n- a\n';
  assert.equal(comparableMap(a), comparableMap(b));
  assert.notEqual(comparableMap(a), comparableMap(b.replace('Routes : 2.', 'Routes : 3.')));
  assert.notEqual(comparableMap(a), comparableMap(a.replace('- a', '- b')));
});
