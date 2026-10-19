import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apv } from './cli-helpers.mjs';
import { seedReview } from './support/rules.mjs';

/**
 * APV4: the risk levels of `apv review plan` and the light mode of `apv rules check` (rules.mode, default leger).
 * Level 0 and 1: no review; 2: securite; 3: securite with donnees or rgpd; fidelite only for a screen a validated mockup covers.
 */

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim();
const put = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };

const BASE = {
  '.github/workflows/ci.yml': 'name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n',
  'src/lib/util.ts': 'export const zero = 0;\n',
  'docs/guide.md': '# Guide\n',
};
const WEB = { 'src/lib/components/Card.svelte': '<p class="card">Carte</p>\n', 'src/routes/articles/+page.svelte': '<h1>Articles</h1>\n' };
const MOCKUP = { id: 'maquette-articles-validee', subject: 'Maquette validée : articles', value: 'Maquette validée, fichier docs/design/articles.html, sha256 abc. Écrans : articles.',
  enforcement: 'product', status: 'confirmed', source: 'operator', sourceQuote: 'Je valide la maquette des articles', rationale: 'Validée.', supersedes: [], clarificationQuestion: '', interpretations: [] };

/** An origin and a clone: main holds BASE and `base`, the branch feat is checked out; `commit` adds a commit to it. */
function project(t, { base = {}, mode } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apv4-niveaux-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(root, 'repo');
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'switch', '-q', '-c', 'main');
  put(repo, '.apv/config.json', { name: 'essai', gates: [{ id: 'unit', stage: 'full', command: [process.execPath, '-e', '0'] }], ...(mode ? { rules: { mode } } : {}) });
  for (const [path, value] of Object.entries({ ...BASE, ...base })) put(repo, path, value);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'switch', '-q', '-c', 'feat');
  return {
    repo,
    commit: files => { for (const [path, value] of Object.entries(files)) put(repo, path, value); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'change'); return git(repo, 'rev-parse', 'HEAD'); },
    plan: async () => { const r = await apv(repo, ['review', 'plan', '--base', 'origin/main', '--json']); assert.equal(r.code, 0, r.stderr); return r.json(); },
    check: async sha => { const r = await apv(repo, ['rules', 'check', '--commit', sha, '--target', 'origin/main', '--offline', '--json']); return r.json(); },
    prove: async () => { const r = await apv(repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/main', '--json']); assert.equal(r.code, 0, r.stdout + r.stderr); },
  };
}
const rule = (report, id) => report.rules.find(r => r.rule === id);

test('level 0: a one-line change of the CI asks for no review, and rules check accepts it once proven', async t => {
  const p = project(t);
  const sha = p.commit({ '.github/workflows/ci.yml': 'name: ci\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n' });
  const plan = await p.plan();
  assert.equal(plan.mode, 'leger');
  assert.equal(plan.level, 0);
  assert.match(plan.levelReason, /CI/);
  assert.deepEqual(plan.retained, []);
  await p.prove();
  const report = await p.check(sha);
  assert.equal(report.mode, 'leger');
  assert.equal(rule(report, 'relecture').status, 'not_applicable');
  assert.equal(report.ok, true, JSON.stringify(report.rules.filter(r => r.status === 'refused')));
  const text = await apv(p.repo, ['rules', 'check', '--commit', sha, '--target', 'origin/main', '--offline']);
  assert.match(text.stdout, /Mode léger, niveau 0 : CI \(1\)/);
  assert.match(text.stdout, /- relecture \([^)]*\) : non exigée : niveau 0/);
});

test('level 1: a component without a validated mockup, an unclassified file, a Python module: no review, no prudence', async t => {
  const p = project(t, { base: WEB });
  p.commit({ 'src/lib/components/Card.svelte': '<p class="card">Carte du jour</p>\n', 'src/lib/util.ts': 'export const one = 1;\n', 'outil/cli.py': 'print("ok")\n' });
  const plan = await p.plan();
  assert.equal(plan.level, 1);
  assert.deepEqual(plan.retained, []);
  assert.match(plan.domains.find(d => d.domain === 'securite').reason, /niveau 1 : code applicatif \(3\) ; aucune relecture d'agent/);
});

test('level 2: a server route asks for the security review alone', async t => {
  const p = project(t);
  p.commit({ 'src/routes/api/items/+server.ts': 'export const GET = () => new Response("[]");\n' });
  const plan = await p.plan();
  assert.equal(plan.level, 2);
  assert.deepEqual(plan.retained, ['securite']);
  const deps = project(t, { base: { 'package.json': { name: 'essai' } } });
  deps.commit({ 'package.json': { name: 'essai', dependencies: { zod: '4.0.0' } } });
  assert.equal((await deps.plan()).level, 2, 'a dependency added');
});

test('level 3: a migration asks for securite and donnees', async t => {
  const p = project(t);
  p.commit({ 'supabase/migrations/20261019000000_items.sql': 'create table public.items (id uuid primary key);\n' });
  const plan = await p.plan();
  assert.equal(plan.level, 3);
  assert.deepEqual(plan.retained, ['securite', 'donnees']);
});

test('fidelite: only for a screen a validated mockup covers', async t => {
  const p = project(t, { base: { ...WEB, '.apv/DECISIONS.json': { schemaVersion: 1, decisions: [MOCKUP] } } });
  p.commit({ 'src/routes/articles/+page.svelte': '<h1>Les articles</h1>\n' });
  const plan = await p.plan();
  assert.equal(plan.level, 1);
  assert.deepEqual(plan.retained, ['fidelite']);
  assert.match(plan.domains.find(d => d.domain === 'fidelite').reason, /maquette-articles-validee/);
});

test('relecture: an unsealed review counts in the light mode, never in the strict mode', async t => {
  for (const mode of ['leger', 'strict']) {
    const p = project(t, { mode });
    const sha = p.commit({ 'src/routes/api/items/+server.ts': 'export const GET = () => new Response("[]");\n' });
    seedReview(p.repo, sha, 'securite', { seal: false });
    if (mode === 'strict') for (const d of ['fidelite', 'donnees', 'rgpd']) seedReview(p.repo, sha, d);
    const relecture = rule(await p.check(sha), 'relecture');
    if (mode === 'leger') assert.equal(relecture.status, 'ok', JSON.stringify(relecture));
    else {
      assert.equal(relecture.status, 'refused');
      assert.match(relecture.problems.join('\n'), /securite : relecture inutilisable \(relecture non scellée/);
    }
  }
});

test('relecture: a security review is carried over a delta that only touches the documentation (light mode)', async t => {
  for (const mode of ['leger', 'strict']) {
    const p = project(t, { mode });
    const reviewed = p.commit({ 'src/routes/api/items/+server.ts': 'export const GET = () => new Response("[]");\n' });
    seedReview(p.repo, reviewed, 'securite');
    const head = p.commit({ 'docs/guide.md': '# Guide\n\nUne section de plus.\n' });
    if (mode === 'strict') for (const d of ['fidelite', 'donnees', 'rgpd']) seedReview(p.repo, head, d);
    const relecture = rule(await p.check(head), 'relecture');
    if (mode === 'leger') {
      assert.equal(relecture.status, 'ok', JSON.stringify(relecture));
      assert.match(relecture.domains[0].detail, /relecture securite reportée de/);
    } else assert.equal(relecture.status, 'refused', 'securite is never carried in the strict mode');
    // A delta that touches server code breaks the report.
    if (mode === 'leger') {
      const next = p.commit({ 'src/routes/api/items/+server.ts': 'export const GET = () => new Response("{}");\n' });
      assert.equal(rule(await p.check(next), 'relecture').status, 'refused');
    }
  }
});

test('relecture: an open high finding refuses the merge in both modes', async t => {
  for (const mode of ['leger', 'strict']) {
    const p = project(t, { mode });
    const sha = p.commit({ 'src/routes/api/items/+server.ts': 'export const GET = () => new Response("[]");\n' });
    for (const d of ['securite', 'fidelite', 'donnees', 'rgpd']) seedReview(p.repo, sha, d, { high: d === 'securite' ? 1 : 0 });
    const relecture = rule(await p.check(sha), 'relecture');
    assert.equal(relecture.status, 'refused', mode);
    assert.match(relecture.problems.join('\n'), /securite : 0 constat\(s\) critique\(s\) et 1 haut\(s\)/);
  }
});
