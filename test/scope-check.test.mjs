import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, git } from './helpers.mjs';
import { demoSpec } from './lifecycle-helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { porcelainPaths } from '../dist/commands/scope.js';
import { scopeReport, assertScope } from '../dist/policy/policy.js';

function branch(t) {
  const f = fixture(t);
  const spec = write(f.root, 'spec.json', demoSpec());
  git(f.repo, 'checkout', '-qb', 'feature');
  return { ...f, spec, commit: (path, text, message = `change ${path}`) => { write(f.repo, path, text); git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', message); } };
}

test('changes inside the task allowed paths pass', async t => {
  const f = branch(t);
  f.commit('src/math.mjs', 'export const add = (a, b) => a + b;\n');
  const r = await apv(f.repo, ['scope', 'check', '--spec', f.spec, '--task', 'MATH']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Tâche MATH : 1 fichier\(s\) modifié\(s\) entre main/);
  assert.match(r.stdout, /Dans le périmètre\./);
});

test('every out-of-scope file is listed and the exit code is 1', async t => {
  const f = branch(t);
  f.commit('src/math.mjs', 'export const add = (a, b) => a + b;\n');
  f.commit('docs/other.md', 'Other.\n');
  f.commit('README.md', '# Changed\n');
  const r = await apv(f.repo, ['scope', 'check', '--spec', f.spec, '--task', 'MATH', '--json']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json().outOfScope, ['README.md', 'docs/other.md']);
  assert.deepEqual(r.json().files, ['README.md', 'docs/other.md', 'src/math.mjs']);
  const human = await apv(f.repo, ['scope', 'check', '--spec', f.spec, '--task', 'MATH']);
  assert.match(human.stdout, /Hors périmètre \(2\) :\n- README\.md\n- docs\/other\.md/);
});

test('the base is the fork point: later work on main is not blamed on the task', async t => {
  const f = branch(t);
  f.commit('docs/math.md', 'Multiply.\n');
  git(f.repo, 'checkout', '-q', 'main');
  write(f.repo, 'README.md', '# Moved on main\n'); git(f.repo, 'commit', '-qam', 'main moves');
  git(f.repo, 'checkout', '-q', 'feature');
  const r = await apv(f.repo, ['scope', 'check', '--spec', f.spec, '--task', 'DOC', '--base', 'main', '--json']);
  assert.equal(r.code, 0, JSON.stringify(r.json()));
  assert.deepEqual(r.json().files, ['docs/math.md']);
});

test('uncommitted changes are reported, not checked', async t => {
  const f = branch(t);
  f.commit('src/math.mjs', 'export const add = (a, b) => a + b;\n');
  write(f.repo, 'secret.txt', 'draft');
  const r = await apv(f.repo, ['scope', 'check', '--spec', f.spec, '--task', 'MATH']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Attention : 1 modification\(s\) non commitée\(s\) non vérifiée\(s\) : secret\.txt/);
});

test('wrong invocations exit 2', async t => {
  const f = branch(t);
  assert.equal((await apv(f.repo, ['scope', 'check', '--spec', f.spec])).code, 2);
  assert.equal((await apv(f.repo, ['scope', 'check', '--task', 'MATH'])).code, 2);
  const unknown = await apv(f.repo, ['scope', 'check', '--spec', f.spec, '--task', 'NOPE']);
  assert.equal(unknown.code, 2); assert.match(unknown.stderr, /tâche inconnue : NOPE \(tâches : MATH, DOC\)/);
  const broken = await apv(f.repo, ['scope', 'check', '--spec', write(f.root, 'broken.json', { title: 'x' }), '--task', 'MATH']);
  assert.equal(broken.code, 2); assert.match(broken.stderr, /spec illisible/);
  git(f.repo, 'branch', '-m', 'main', 'trunk');
  const noBase = await apv(f.repo, ['scope', 'check', '--spec', f.spec, '--task', 'MATH']);
  assert.equal(noBase.code, 2); assert.match(noBase.stderr, /précisez --base/);
  assert.equal((await apv(f.repo, ['scope', 'check', '--spec', f.spec, '--task', 'MATH', '--base', 'trunk'])).code, 0);
});

test('scope report lists every violation; assertScope keeps the V2 error', () => {
  const task = { allowedPaths: ['src/page.ts'], allowedNewPaths: ['src/*'], maxNewFiles: 1 };
  const report = scopeReport({ files: ['src/page.ts', 'src/a.ts', 'src/b.ts', 'x.md', '../out'], added: ['src/a.ts', 'src/b.ts'], lines: 3, binary: false }, task);
  assert.deepEqual(report, { autoNew: ['src/a.ts', 'src/b.ts'], rejected: ['x.md', '../out'], tooManyNew: true });
  assert.throws(() => assertScope({ files: ['src/page.ts', 'src/a.ts', 'src/b.ts'], added: ['src/a.ts', 'src/b.ts'], lines: 3, binary: false }, task), /Too many/);
  assert.deepEqual(scopeReport(['src/page.ts'], { allowedPaths: ['src/**'] }), { autoNew: [], rejected: [], tooManyNew: false });
});

test('porcelain status paths skip the source of a rename', () => {
  assert.deepEqual(porcelainPaths('R  new.txt\0old.txt\0?? added.txt\0 M src/a.ts\0'), ['new.txt', 'added.txt', 'src/a.ts']);
  assert.deepEqual(porcelainPaths(''), []);
});
