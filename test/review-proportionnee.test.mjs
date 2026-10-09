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

function project(t, extra = {}) {
  const f = fixture(t, { files: { ...FILES, ...extra } });
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
    // Second review of PR #128: strings outside a class or id context.
    ["  const id = 'ad-hoc';", "  const id = 'art-hoc';", 'C.svelte'],
    ["  db.eq('owner_id', me);", "  db.eq('editor_id', me);", 'C.svelte'],
    ['<iframe sandbox="allow-forms"></iframe>', '<iframe sandbox="allow-same-origin"></iframe>', 'C.svelte'],
    ['<a href="#top-bar">x</a>', '<a href="#top-nav">x</a>', 'C.svelte'],
    ['<div data-state="is-open">x</div>', '<div data-state="is-shut">x</div>', 'C.svelte'],
    ["  document.querySelector('ad-x');", "  document.querySelector('art-x');", 'C.svelte'],
  ]) assert.equal(one(a, b, path), null, `${path} : ${a}`);
  assert.deepEqual(one("  el.closest('.ad-x > span');", "  el.closest('.art-x > span');", 'C.svelte'), [{ from: 'ad-x', to: 'art-x', selector: false }]);
  assert.deepEqual(one('<div class="z {on ? \'ad-x\' : \'\'}">', '<div class="z {on ? \'art-x\' : \'\'}">', 'C.svelte'), [{ from: 'z', to: 'z', selector: false }, { from: 'ad-x', to: 'art-x', selector: false }]);
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

test('a package name with its version in a note is no e-mail address: the security review alone (9 October 2026)', async t => {
  const p = project(t);
  p.edit('.apv/state/resume.md', '# Reprise\n\n- `npx -y supabase@2.117.0 db push` ; voir @chemin et @securite\n');
  p.commit();
  const plan = await p.plan();
  assert.deepEqual(plan.retained, ['securite'], JSON.stringify(plan.domains));
  assert.match(plan.files[0].riskWhy, /^notes de pilotage/);
  const real = project(t);
  real.edit('.apv/state/resume.md', '# Reprise\n\n- contact : marie.durand@societe.fr\n');
  real.commit();
  assert.deepEqual((await real.plan()).retained, ['securite', 'rgpd']);
});

test('the decision ledger is its own class: the security review always, data and GDPR only on their terms (9 October 2026)', async t => {
  const ledger = text => JSON.stringify({ schemaVersion: 1, decisions: [{ id: 'D-9', subject: 'Pilotage', value: text, enforcement: 'product', status: 'confirmed', source: 'operator', sourceQuote: 'ok', rationale: 'choix', supersedes: [], clarificationQuestion: '', interpretations: [] }] }, null, 2);
  const p = project(t);
  p.edit('.apv/DECISIONS.json', `${ledger('Les relectures de sécurité restent obligatoires')}\n`);
  p.edit('.apv/DECISIONS.md', '# Décisions\n\n- D-9 : Les relectures de sécurité restent obligatoires\n');
  p.commit();
  const plan = await p.plan();
  assert.deepEqual(plan.retained, ['securite'], JSON.stringify(plan.domains));
  assert.equal(decision(plan, 'securite').basis, 'diff');
  for (const f of plan.files) {
    assert.match(f.riskWhy, /^registre des décisions/, f.path);
    assert.deepEqual(f.keeps, [], f.path);
  }
  assert.match(await p.text(), /registre des décisions/);
  // A RGPD term in the added lines of the ledger keeps the GDPR review, on the diff; the Markdown rendering says nothing more.
  const q = project(t);
  q.edit('.apv/DECISIONS.json', `${ledger('Les e-mails des lecteurs sont supprimés après un an')}\n`);
  q.edit('.apv/DECISIONS.md', '# Décisions\n\n- D-9 : Les e-mails des lecteurs sont supprimés après un an\n');
  q.commit();
  const withTerm = await q.plan();
  assert.deepEqual(withTerm.retained, ['securite', 'rgpd'], JSON.stringify(withTerm.domains));
  assert.equal(decision(withTerm, 'rgpd').basis, 'diff');
  assert.match(decision(withTerm, 'rgpd').reason, /terme RGPD/);
  // A term of data (a statement of SQL) keeps the data review.
  const s = project(t);
  s.edit('.apv/DECISIONS.json', `${ledger('La purge lance truncate sessions chaque nuit')}\n`);
  s.commit();
  assert.deepEqual((await s.plan()).retained, ['securite', 'donnees']);
  // A ledger changed beside a note keeps the same reading.
  const r = project(t);
  r.edit('.apv/DECISIONS.json', `${ledger('Un autre choix de pilotage')}\n`);
  r.edit('.apv/state/resume.md', '# Reprise\n\nÉtat court\n');
  r.commit();
  assert.deepEqual((await r.plan()).retained, ['securite']);
});

test('review of PR #129, H1: a mockup decision added or changed in the ledger keeps the fidelity review, on the diff', async t => {
  const decisionOf = (id, value, extra = {}) => ({ id, subject: `Maquette ${id}`, value, enforcement: 'product', status: 'confirmed', source: 'operator', sourceQuote: 'je valide la maquette',
    rationale: 'validée', supersedes: [], clarificationQuestion: '', interpretations: [], ...extra });
  const accueil = decisionOf('maquette-accueil-validee', `Référence : fichier docs/design/accueil.html, sha256 ${'a'.repeat(64)}. Écrans : accueil.`);
  const base = { '.apv/DECISIONS.json': `${JSON.stringify({ schemaVersion: 1, decisions: [decisionOf('D-1', 'Choix de pilotage', { subject: 'Pilotage' }), accueil] }, null, 2)}\n` };
  const withLedger = (decisions) => `${JSON.stringify({ schemaVersion: 1, decisions }, null, 2)}\n`;
  const d1 = JSON.parse(base['.apv/DECISIONS.json']).decisions[0];
  // A screen added to the screens of a validated mockup (the registry alone changes).
  const retarget = project(t, base);
  retarget.edit('.apv/DECISIONS.json', withLedger([d1, { ...accueil, value: accueil.value.replace('Écrans : accueil.', 'Écrans : accueil, carte.') }]));
  retarget.commit();
  const plan = await retarget.plan();
  assert.deepEqual(plan.retained, ['securite', 'fidelite'], JSON.stringify(plan.domains));
  assert.equal(decision(plan, 'fidelite').basis, 'diff');
  assert.match(decision(plan, 'fidelite').reason, /décision de maquette ajoutée ou modifiée au registre/);
  // Not anchored in the operator's messages: said in the plan.
  assert.match(plan.unanchored.join('\n'), /maquette-accueil-validee modifiée/);
  assert.match(await retarget.text(), /maquette non ancrée : décision maquette-accueil-validee modifiée/);
  // A mockup decision added, a decision with a perimeter changed, the status of a mockup changed, a mockup removed.
  for (const [name, decisions] of [
    ['added', [d1, accueil, decisionOf('maquette-carte-validee', `Référence : fichier docs/design/carte.html, sha256 ${'b'.repeat(64)}. Écrans : carte.`)]],
    ['scope', [{ ...d1, scope: { paths: ['src/routes/**'] } }, accueil]],
    ['status', [d1, { ...accueil, status: 'proposed' }]],
    ['removed', [d1]],
  ]) {
    const p = project(t, base);
    p.edit('.apv/DECISIONS.json', withLedger(decisions));
    p.commit();
    const got = await p.plan();
    assert.ok(got.retained.includes('fidelite'), `${name}: ${JSON.stringify(got.domains)}`);
    assert.equal(decision(got, 'fidelite').basis, 'diff', name);
  }
  // A decision that is no mockup and has no perimeter: the security review alone, nothing to anchor.
  const plain = project(t, base);
  plain.edit('.apv/DECISIONS.json', withLedger([d1, accueil, decisionOf('D-2', 'Un autre choix de pilotage', { subject: 'Pilotage 2' })]));
  plain.commit();
  const only = await plain.plan();
  assert.deepEqual(only.retained, ['securite'], JSON.stringify(only.domains));
  assert.deepEqual(only.unanchored, []);
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
