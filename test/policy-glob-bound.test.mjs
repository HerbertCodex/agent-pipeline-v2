import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { matches } from '../dist/policy/policy.js';
import { MAX_WHEN_LENGTH, MAX_WHEN_WILDCARDS, configIssues } from '../dist/config/load.js';

/**
 * Addition of 17 October to docs/ACCELERATION-LOTS.md (security review of #140): `matches` compiled each glob into a
 * regular expression whose backtracking a pattern chosen by a PR (`early.when`, read from the candidate as well) could
 * blow up: six `**a` before `**b` against a path of 100 « a » took 85 s. It now reads the path once, without backtracking.
 */

/** The former implementation, kept here as the reference of the language (never on a trap pattern). */
function reference(path, pattern) {
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { regex += '(?:.*/)?'; i++; }
      else regex += '.*';
    } else if (c === '*') regex += '[^/]*';
    else if (c === '?') regex += '[^/]';
    else regex += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${regex}$`).test(path);
}
const outcome = (f) => { try { return f(); } catch (error) { return `throws ${error.code ?? error.message}`; } };

test('same language as the former regular expression on every pattern and path (property, 20 000 cases)', () => {
  // Short patterns and paths over an alphabet that exercises every token, the literal brackets and parentheses, the dot,
  // and the line terminators the former « . » did not cross.
  const patternChar = fc.constantFrom('a', 'b', '/', '*', '*', '?', '.', '[', ')', '-');
  const pathChar = fc.constantFrom('a', 'b', '/', '.', '[', ')', '-', '\n', ' ', 'é');
  const pattern = fc.array(patternChar, { minLength: 1, maxLength: 9 }).map(a => a.join(''));
  const path = fc.array(pathChar, { minLength: 0, maxLength: 10 }).map(a => a.join(''));
  fc.assert(fc.property(pattern, path, (p, s) => {
    const expected = outcome(() => { matches('probe', p); return reference(s, p); });
    return outcome(() => matches(s, p)) === expected;
  }), { numRuns: 20000 });
  // The usual globs of configurations, on usual paths.
  const cases = [
    ['src/**', 'src/a/b.ts', true], ['src/**', 'src', false], ['**/*.md', 'README.md', true], ['**/*.md', 'docs/a/b.md', true],
    ['docs/**/x.md', 'docs/x.md', true], ['docs/**/x.md', 'docs/a/b/x.md', true], ['docs/**/x.md', 'docsx.md', false],
    ['*.json', 'a/b.json', false], ['src/routes/[slug]/+page.svelte', 'src/routes/[slug]/+page.svelte', true],
    ['src/(app)/*', 'src/(app)/x', true], ['a?c', 'abc', true], ['a?c', 'a/c', false], ['**/.env*', 'x/.env.local', true],
    ['tests/e2e/**/*-snapshots/**', 'tests/e2e/a/b-snapshots/c.png', true], ['a**b', 'a/x/b', true], ['**', '', true],
  ];
  for (const [p, s, want] of cases) assert.equal(matches(s, p), want, `${p} ~ ${s}`);
});

test('a trap pattern is matched in bounded time (the former expression took minutes)', () => {
  const traps = [
    [Array(12).fill('**a').join('') + '**b', 'a'.repeat(4000)],
    [Array(40).fill('*a').join('') + '*b', 'a'.repeat(4000)],
    [Array(20).fill('**/a').join('') + '/b', Array(400).fill('a').join('/')],
    [Array(100).fill('**').join('a') + 'b', 'a'.repeat(4000)],
  ];
  const started = performance.now();
  for (const [pattern, path] of traps) {
    assert.ok(pattern.length <= 500, 'a pattern the configuration accepts (500 characters at most)');
    assert.equal(matches(path, pattern), false);
    assert.equal(matches(path.slice(0, -1) + 'b', pattern), true);
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `bounded: ${Math.round(elapsed)} ms`);
});

test('invalid globs stay refused, every time (the compiled cache never skips the validation)', () => {
  for (const bad of ['{a,b}', '!src/**', '/abs', 'a/../b', 'a//b', 'a\\b']) {
    assert.throws(() => matches('x', bad), /Unsupported glob/);
    assert.throws(() => matches('x', bad), /Unsupported glob/);
  }
  assert.equal(matches('src/a.ts', 'src/*.ts'), true);
  assert.equal(matches('src/a.ts', 'src/*.ts'), true);
});

test('a trap `when` chosen by a PR no longer stalls the task stage', async t => {
  const trap = Array(8).fill('**a').join('') + '**b';
  const gates = [
    { id: 'build', command: [process.execPath, '-e', 'process.exit(0)'] },
    { id: 'integration', stage: 'full', command: [process.execPath, '-e', 'process.exit(0)'],
      early: [{ id: 'budget-js', when: [trap], command: [process.execPath, '-e', 'process.exit(0)'] }] },
  ];
  assert.deepEqual(configIssues({ gates }).issues, []);
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { gates });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  write(f.repo, 'a'.repeat(200), 'x\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'fichier au nom piège');
  const started = performance.now();
  const r = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--base', 'HEAD~1', '--json']);
  const elapsed = performance.now() - started;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json().early.map(e => [e.id, e.required]), [['budget-js', false]]);
  assert.ok(elapsed < 30_000, `the task stage ends: ${Math.round(elapsed)} ms`);
});

test('the loader bounds each `when` pattern: 200 characters and 16 wildcards (* or **) at most, refused beyond', () => {
  const config = when => ({ gates: [
    { id: 'build', command: [process.execPath, '-e', 'process.exit(0)'] },
    { id: 'integration', stage: 'full', command: [process.execPath, '-e', 'process.exit(0)'], early: [{ id: 'budget-js', when, command: [process.execPath, '-e', 'process.exit(0)'] }] },
  ] });
  const sixteen = Array(16).fill('**a').join('');
  const longest = 'src/' + 'x'.repeat(196);
  assert.equal(MAX_WHEN_WILDCARDS, 16); assert.equal(MAX_WHEN_LENGTH, 200);
  assert.deepEqual(configIssues(config([sixteen, longest, 'src/**', '**/*.svelte'])).issues, []);
  const seventeen = configIssues(config(['src/**', sixteen + '*'])).issues;
  assert.equal(seventeen.length, 1);
  assert.match(seventeen[0].message, /early check budget-js: when: .* 49 characters and 17 wildcards \(\* or \*\*\); at most 200 characters and 16 wildcards per pattern/);
  const tooLong = configIssues(config([longest + 'x'])).issues;
  assert.equal(tooLong.length, 1);
  assert.match(tooLong[0].message, /201 characters and 0 wildcards/);
  // `***` is two wildcards (`**` then `*`), as the matcher reads it.
  assert.deepEqual(configIssues(config([Array(8).fill('***').join('/') + '/x'])).issues, []);
  assert.match(configIssues(config([Array(9).fill('***').join('/') + '/x'])).issues[0].message, /18 wildcards/);
});
