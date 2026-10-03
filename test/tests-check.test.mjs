import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { configIssues } from '../dist/config/load.js';

/**
 * `apv tests check` (src/testcheck/check.ts): deterministic checks of the test files a change adds or modifies. A fixed
 * wait `waitForTimeout` blocks by default; the other waits, a delay on the real clock and an address shared between
 * browser tests warn; what existed before the change is never reported; the project can tune or disable each rule.
 */
const FILES = {
  'tests/e2e/login.spec.ts': "import { test } from '@playwright/test';\ntest('login', async ({ page }) => {\n  await page.fill('#email', 'demo@example.org');\n  await page.waitForTimeout(500);\n});\n",
  'src/lib/debounce.test.ts': "import { test } from 'vitest';\ntest('x', () => {});\n",
};

function project(t, config) {
  const f = fixture(t, { files: FILES });
  if (config !== undefined) { write(f.repo, '.apv/config.json', config); git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config'); }
  git(f.repo, 'switch', '-q', '-c', 'work');
  return { ...f, check: async (...extra) => apv(f.repo, ['tests', 'check', '--base', 'main', ...extra]) };
}

test('tests check: a waitForTimeout added to a browser test blocks; the other findings warn', async t => {
  const p = project(t);
  write(p.repo, 'tests/e2e/profile.spec.ts', [
    "import { test } from '@playwright/test';",
    "test('profile', async ({ page }) => {",
    "  await page.fill('#email', 'demo@example.org');",
    '  await page.waitForTimeout(1000);',
    '  await new Promise(r => setTimeout(r, 200));',
    '  // await page.waitForTimeout(10) in a comment is not a wait',
    '});', ''].join('\n'));
  write(p.repo, 'src/lib/debounce.test.ts', [
    "import { test, expect } from 'vitest';",
    "test('waits 100 ms', async () => {",
    '  const start = Date.now();',
    '  await new Promise(r => setTimeout(r, 100));',
    '  expect(Date.now() - start).toBeGreaterThanOrEqual(100);',
    '});', ''].join('\n'));
  const r = await p.check('--json');
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const report = r.json();
  assert.deepEqual(report.files, { e2e: ['tests/e2e/profile.spec.ts'], unit: ['src/lib/debounce.test.ts'] });
  const by = rule => report.findings.filter(f => f.rule === rule);
  assert.deepEqual(by('waitForTimeout').map(f => [f.file, f.line, f.severity]), [['tests/e2e/profile.spec.ts', 4, 'error']]);
  assert.deepEqual(by('fixedWait').map(f => [f.line, f.severity]), [[5, 'warning']]);
  assert.deepEqual(by('realClock').map(f => [f.file, f.severity]), [['src/lib/debounce.test.ts', 'warning']]);
  assert.deepEqual(by('sharedData').map(f => [f.line, f.severity]), [[3, 'warning']]);
  assert.match(by('sharedData')[0].message, /tests\/e2e\/login\.spec\.ts/);
  const text = await p.check();
  assert.equal(text.code, 1);
  assert.match(text.stdout, /\[bloquant\] tests\/e2e\/profile\.spec\.ts:4 : await page\.waitForTimeout\(1000\);/);
  assert.match(text.stdout, /Résultat : ÉCHEC, 1 constat\(s\) bloquant\(s\)/);
});

test('tests check: what existed before the change, fake timers and observable waits pass', async t => {
  const p = project(t);
  // The existing waitForTimeout of login.spec.ts is not part of the change: a new line elsewhere in the file is.
  write(p.repo, 'tests/e2e/login.spec.ts', `${FILES['tests/e2e/login.spec.ts']}test('more', async ({ page }) => {\n  await page.getByRole('button').click();\n  await expect(page.getByText('Bienvenue')).toBeVisible();\n});\n`);
  write(p.repo, 'src/lib/debounce.test.ts', [
    "import { test, expect, vi } from 'vitest';",
    'vi.useFakeTimers();',
    "test('waits 100 ms', () => {",
    '  const start = Date.now();',
    '  setTimeout(() => {}, 100);',
    '  vi.advanceTimersByTime(100);',
    '  expect(Date.now() - start).toBe(100);',
    '});', ''].join('\n'));
  git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'tests');
  const r = await p.check('--json');
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json().findings, []);
  assert.match((await p.check()).stdout, /Résultat : aucun constat bloquant\./);
});

test('tests check: the project sets each severity, or disables the check', async t => {
  const content = "import { test } from '@playwright/test';\ntest('x', async ({ page }) => {\n  await page.waitForTimeout(100);\n  await sleep(10);\n});\n";
  const warn = project(t, { testsCheck: { severity: { waitForTimeout: 'warning', fixedWait: 'error' } } });
  write(warn.repo, 'tests/e2e/x.spec.ts', content);
  let r = await warn.check('--json');
  assert.equal(r.code, 1);
  assert.deepEqual(r.json().findings.map(f => [f.rule, f.severity]), [['waitForTimeout', 'warning'], ['fixedWait', 'error']]);
  const off = project(t, { testsCheck: { severity: { waitForTimeout: 'off', fixedWait: 'off' } } });
  write(off.repo, 'tests/e2e/x.spec.ts', content);
  r = await off.check('--json');
  assert.equal(r.code, 0);
  assert.deepEqual(r.json().findings, []);
  const disabled = project(t, { testsCheck: { enabled: false } });
  write(disabled.repo, 'tests/e2e/x.spec.ts', content);
  r = await disabled.check();
  assert.equal(r.code, 0);
  assert.match(r.stdout, /contrôle désactivé par le projet/);
});

test('tests check: incorrect calls and configuration', async t => {
  const p = project(t);
  let r = await apv(p.repo, ['tests', 'check']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--base <ref>.*obligatoire/);
  r = await apv(p.repo, ['tests', 'check', '--base', 'nulle-part']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /référence introuvable/);
  r = await apv(p.repo, ['tests', 'verify']);
  assert.equal(r.code, 2);
  assert.ok(configIssues({ gates: [], testsCheck: { severity: { waitForTimeout: 'loud' } } }).issues.length > 0);
  assert.ok(configIssues({ gates: [], testsCheck: { e2e: ['{a,b}/**'] } }).issues.length > 0);
  assert.deepEqual(configIssues({ gates: [], testsCheck: { enabled: true, e2e: ['e2e/**'], severity: { realClock: 'error' } } }).issues, []);
});
