import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv } from './cli-helpers.mjs';
import { renamedNames, selectorPart } from '../dist/review/rename.js';

/**
 * Reviews in proportion to the risk (issue #126). Pilot project, 8 October 2026: three pull requests without any product
 * risk cost about 250 k tokens of reviews without a single finding: a lockfile alone (#212), notes of the pipeline under
 * `.apv/` (#211), a strict rename of CSS classes (#216). The security review stays in every plan.
 */
const COMPONENT = [
  '<section class="ad-page">',
  '  <header class="ad-head">Propositions</header>',
  '  <div class="ad-grid" id="ad-bar"><slot /></div>',
  '</section>',
  '',
  '<style>',
  '  .ad-page { display: grid; }',
  '  .ad-grid,',
  '  .ad-head {',
  '    gap: 1rem;',
  '  }',
  '</style>',
  '',
].join('\n');
const FILES = {
  'src/lib/components/admin/Proposals.svelte': COMPONENT,
  'src/lib/styles/admin.css': '#ad-bar { position: sticky; }\n.ad-head:hover { color: #333; }\n',
  'tests/e2e/admin.spec.ts': "import { test, expect } from '@playwright/test';\ntest('liste', async ({ page }) => {\n  await page.locator('.ad-grid').click();\n  await expect(page.locator('#ad-bar')).toBeVisible();\n});\n",
  'src/lib/components/Card.svelte': '<p class="card">Carte</p>\n\n<style>\n  .card { color: red; }\n</style>\n',
  'src/lib/format.ts': "export const money = (n: number): string => `${n} €`;\n",
  'package.json': '{ "name": "essai", "devDependencies": { "vitest": "1.0.0" } }\n',
  'package-lock.json': '{ "name": "essai", "lockfileVersion": 3, "packages": {} }\n',
  '.apv/journal-pipeline.md': '# Journal\n',
  '.apv/specs/articles.json': '{ "id": "articles" }\n',
  '.apv/state/resume.md': '# Reprise\n',
};

function project(t) {
  const f = fixture(t, { files: FILES });
  git(f.repo, 'switch', '-q', '-c', 'work');
  const file = p => join(f.repo, p);
  return {
    ...f,
    edit: (path, text) => { mkdirSync(dirname(file(path)), { recursive: true }); writeFileSync(file(path), text); },
    read: path => readFileSync(file(path), 'utf8'),
    commit: () => { git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'change'); },
    plan: async () => {
      const r = await apv(f.repo, ['review', 'plan', '--base', 'main', '--head', 'work', '--json']);
      assert.equal(r.code, 0, r.stderr);
      return r.json();
    },
    text: async () => (await apv(f.repo, ['review', 'plan', '--base', 'main', '--head', 'work'])).stdout,
  };
}
const decision = (plan, domain) => plan.domains.find(d => d.domain === domain);
/** The rename of the pilot project: `ad-*` to `art-*`, in the component, its style sheet and its end-to-end test. */
const renameAll = p => {
  for (const path of ['src/lib/components/admin/Proposals.svelte', 'src/lib/styles/admin.css', 'tests/e2e/admin.spec.ts']) p.edit(path, p.read(path).replaceAll('ad-', 'art-'));
};

test('pure rename: classes and ids renamed in a component, a style sheet and an e2e test skip fidelity, with the reason', async t => {
  const p = project(t);
  renameAll(p);
  p.commit();
  const plan = await p.plan();
  assert.deepEqual(plan.retained, ['securite']);
  assert.match(decision(plan, 'fidelite').reason, /^renommage pur : diff normalisé vide/);
  assert.deepEqual(plan.files.map(f => [f.path, f.change]), [
    ['src/lib/components/admin/Proposals.svelte', 'names'], ['src/lib/styles/admin.css', 'names'], ['tests/e2e/admin.spec.ts', 'names']]);
  assert.equal(plan.counts.names, 3);
  assert.match(await p.text(), /fidelite : renommage pur : diff normalisé vide/);
});

test('pure rename: a text, a structure or a style changed in the same diff keeps fidelity', async t => {
  for (const [name, extra] of [
    ['text', p => p.edit('src/lib/components/admin/Proposals.svelte', p.read('src/lib/components/admin/Proposals.svelte').replace('Propositions', 'Articles'))],
    ['structure', p => p.edit('src/lib/components/admin/Proposals.svelte', p.read('src/lib/components/admin/Proposals.svelte').replace('<slot />', '<span><slot /></span>'))],
    ['declaration', p => p.edit('src/lib/styles/admin.css', p.read('src/lib/styles/admin.css').replace('#333', '#334'))],
    ['other component', p => p.edit('src/lib/components/Card.svelte', p.read('src/lib/components/Card.svelte').replace('Carte', 'Fiche'))],
  ]) {
    const p = project(t);
    renameAll(p);
    extra(p);
    p.commit();
    const plan = await p.plan();
    assert.ok(plan.retained.includes('fidelite'), `${name} : ${JSON.stringify(plan.domains)}`);
    assert.doesNotMatch(decision(plan, 'fidelite').reason, /renommage pur/, name);
  }
});

test('pure rename: never a rename that changes what a screen shows', async t => {
  for (const [name, change] of [
    // The markup renamed, the style sheet left with the old name: the element loses its style.
    ['old name left', p => p.edit('src/lib/components/admin/Proposals.svelte', p.read('src/lib/components/admin/Proposals.svelte').replaceAll('ad-', 'art-'))],
    // Renamed to a class the base already styles.
    ['existing name', p => { for (const path of ['src/lib/components/admin/Proposals.svelte', 'src/lib/styles/admin.css', 'tests/e2e/admin.spec.ts']) p.edit(path, p.read(path).replaceAll('ad-head', 'card')); }],
    // Two old names merged into one.
    ['merge', p => { for (const path of ['src/lib/components/admin/Proposals.svelte', 'src/lib/styles/admin.css', 'tests/e2e/admin.spec.ts']) p.edit(path, p.read(path).replaceAll('ad-', 'art-').replaceAll('art-head', 'art-grid')); }],
    // A word of the text only, without any style definition renamed.
    ['visible word', p => p.edit('src/lib/components/admin/Proposals.svelte', p.read('src/lib/components/admin/Proposals.svelte').replace('<header class="ad-head">Propositions', '<header class="ad-head">Brouillons'))],
  ]) {
    const p = project(t);
    change(p);
    p.commit();
    const plan = await p.plan();
    assert.ok(plan.retained.includes('fidelite'), `${name} : ${JSON.stringify(plan.files)}`);
    assert.ok(plan.files.every(f => f.change !== 'names'), name);
  }
});

test('pure rename, unit: a declaration, a script or a text is never a name', () => {
  const one = (a, b, path) => renamedNames({ removed: [a], added: [b] }, path);
  assert.deepEqual(one('.ad-x:hover, #ad-y { color: red; }', '.art-x:hover, #art-y { color: red; }', 'a.css'),
    [{ from: 'ad-x', to: 'art-x', selector: true }, { from: 'ad-y', to: 'art-y', selector: true }]);
  assert.deepEqual(one("  el.classList.add('ad-x');", "  el.classList.add('art-x');", 'C.svelte'), [{ from: 'ad-x', to: 'art-x', selector: false }]);
  for (const [a, b, path] of [
    ['.a { color: #fff; }', '.a { color: #eee; }', 'a.css'],
    ['  color: #fff;', '  color: #eee;', 'a.css'],
    ['  src: url(a.woff2),', '  src: url(a.woff),', 'a.css'],
    ['  if (event.key) {', '  if (event.code) {', 'C.svelte'],
    ['  promise.then(() => {', '  promise.catch(() => {', 'C.svelte'],
    ["  const label = 'Bonjour';", "  const label = 'Salut';", 'C.svelte'],
    ['<p>carte</p>', '<p>fiche</p>', 'C.svelte'],
    ['<p class="a">x</p>', '<p class="a">x</p>  ', 'C.svelte'],
  ]) assert.equal(one(a, b, path), null, `${path} : ${a}`);
  assert.equal(selectorPart('  .then(() => {', false), null);
  assert.equal(selectorPart('  div.card {', false), null, 'a component starts its selectors with a class, an id or :global(');
  assert.equal(selectorPart('  div.card {', true), '  div.card ');
});

test('data attributes and Markdown notes under .apv are no words of data or GDPR; the same words in code still are', async t => {
  const p = project(t);
  p.edit('src/lib/components/Card.svelte', p.read('src/lib/components/Card.svelte').replace('<p class="card">', '<p class="card" data-tab="liste" data-phone="0">'));
  p.edit('.apv/state/notes.md', '# Notes\n\n- phone et e-mail retirés du formulaire\n- supprimer les doublons\n');
  p.commit();
  let plan = await p.plan();
  assert.deepEqual(plan.retained, ['securite', 'fidelite'], JSON.stringify(plan.domains));
  // The same words in a test written in TypeScript keep their domains.
  const q = project(t);
  q.edit('tests/e2e/admin.spec.ts', `${q.read('tests/e2e/admin.spec.ts')}// phone et e-mail retirés du formulaire\n// supprimer les doublons\n`);
  q.commit();
  plan = await q.plan();
  assert.ok(plan.retained.includes('rgpd'), JSON.stringify(plan.domains));
  assert.match(decision(plan, 'rgpd').reason, /terme RGPD « (?:phone|e-mail|supprim) »/);
});

test('notes of the pipeline (.apv/state, journal, specs) are never configuration: the security review alone', async t => {
  const p = project(t);
  p.edit('.apv/state/run-articles.json', '{ "id": "articles", "note": "set phone and e-mail", "status": "merged" }\n');
  p.edit('.apv/state/resume.md', '# Reprise\n\nLes données de test sont supprimées.\n');
  p.edit('.apv/journal-pipeline.md', '# Journal\n\n- update du set de données\n');
  // A spec added (a spec of the base modified keeps the classification of alpha.20: test/review-relecture-128.test.mjs).
  p.edit('.apv/specs/comptes.json', '{ "id": "comptes", "title": "Supprimer un compte" }\n');
  p.commit();
  const plan = await p.plan();
  assert.deepEqual(plan.retained, ['securite'], JSON.stringify(plan.domains));
  for (const f of plan.files) {
    assert.match(f.riskWhy, /^notes de pilotage/, f.path);
    assert.deepEqual(f.keeps, [], f.path);
  }
  for (const d of plan.skipped) assert.doesNotMatch(d.reason, /configuration/, d.domain);
  assert.match(await p.text(), /notes de pilotage/);
});

test('the lane without code stays first when it applies: no domain at all', async t => {
  const p = project(t);
  p.edit('.apv/journal-pipeline.md', '# Journal\n\n- une PR sans code\n');
  p.edit('.apv/specs/autre.json', '{ "id": "autre" }\n');
  p.commit();
  const plan = await p.plan();
  assert.deepEqual(plan.retained, []);
  assert.match(decision(plan, 'securite').reason, /^voie sans code/);
});

test('a lockfile alone is a lock of dependencies: the security review alone, with the audit of the dependencies', async t => {
  const p = project(t);
  p.edit('package-lock.json', '{ "name": "essai", "lockfileVersion": 3, "packages": { "node_modules/knip": { "version": "5.0.0" } } }\n');
  p.commit();
  let plan = await p.plan();
  assert.deepEqual(plan.retained, ['securite'], JSON.stringify(plan.domains));
  assert.match(decision(plan, 'securite').reason, /verrou de dépendances/);
  assert.match(plan.files[0].riskWhy, /^verrou de dépendances/);
  // With its package.json: a configuration, every domain kept as before.
  const q = project(t);
  q.edit('package-lock.json', '{ "name": "essai", "lockfileVersion": 3, "packages": { "node_modules/knip": { "version": "5.0.0" } } }\n');
  q.edit('package.json', '{ "name": "essai", "devDependencies": { "vitest": "1.0.0", "knip": "5.0.0" } }\n');
  q.commit();
  plan = await q.plan();
  assert.deepEqual(plan.retained, ['securite', 'fidelite', 'donnees', 'rgpd']);
});

test('each retained domain says whether the diff requires it or prudence keeps it', async t => {
  const p = project(t);
  p.edit('src/lib/components/Card.svelte', p.read('src/lib/components/Card.svelte').replace('Carte', 'Fiche'));
  p.edit('tests/e2e/admin.spec.ts', `${p.read('tests/e2e/admin.spec.ts')}// le champ phone reste vide\n`);
  p.commit();
  let plan = await p.plan();
  assert.deepEqual(plan.retained, ['securite', 'fidelite', 'rgpd']);
  assert.deepEqual(plan.domains.map(d => [d.domain, d.basis]), [['securite', 'diff'], ['fidelite', 'diff'], ['donnees', null], ['rgpd', 'prudence']]);
  assert.match(decision(plan, 'rgpd').reason, /terme RGPD « phone » isolé \(une seule ligne changée : par prudence\)/);
  const text = await p.text();
  assert.match(text, /fidelite \(exigée par le diff\) : /);
  assert.match(text, /rgpd \(par prudence\) : /);
  // An unclassified file: every domain by prudence; two lines of personal words: required by the diff.
  const q = project(t);
  q.edit('src/lib/format.ts', `${q.read('src/lib/format.ts')}export const two = 2;\n`);
  q.edit('tests/e2e/admin.spec.ts', `${q.read('tests/e2e/admin.spec.ts')}// le champ phone reste vide\n// le champ e-mail aussi\n`);
  q.commit();
  plan = await q.plan();
  assert.deepEqual(plan.domains.map(d => [d.domain, d.basis]), [['securite', 'diff'], ['fidelite', 'prudence'], ['donnees', 'prudence'], ['rgpd', 'diff']]);
});

test('quota at the level finish only: the plan says first that the reviews by prudence wait for the operator', async t => {
  const p = project(t);
  p.edit('src/lib/format.ts', `${p.read('src/lib/format.ts')}export const two = 2;\n`);
  p.commit();
  const log = (level, percent) => `${JSON.stringify({ at: '2026-10-08T14:02:00.000Z', session: { percent: 20, resets: null }, week: { percent, resets: null }, percent, level, binding: 'week' })}\n`;
  p.edit('.apv/state/quota.log', log('ok', 40));
  assert.doesNotMatch(await p.text(), /Quota au niveau/);
  p.edit('.apv/state/quota.log', log('ok', 40) + log('finish_only', 87));
  const text = await p.text();
  assert.match(text.split('\n')[0], /^Quota au niveau finir seulement : les relectures par prudence attendent l'accord de l'opérateur/);
  const plan = await p.plan();
  assert.equal(plan.quota.level, 'finish_only');
  assert.match(plan.quota.notice, /^Quota au niveau finir seulement/);
  assert.ok(!/[–—]/.test(text), 'no en or em dash');
});
