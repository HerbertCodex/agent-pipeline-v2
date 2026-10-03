import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { isProse, textOnly } from '../dist/review/risk.js';

/**
 * Risk level of `apv review plan` (src/review/risk.ts): a diff of tests, test tooling, documentation and interface
 * texts is of low risk and keeps the security review (plus fidelity when the interface changes); anything else is of
 * high risk and keeps the plan as it was. Both directions are tested: what must be low, and what must stay high.
 */
const FILES = {
  'src/lib/messages.ts': "export const messages = {\n  title: 'Bienvenue sur le site',\n  role: 'admin',\n  help: 'https://example.org/aide',\n};\n",
  'src/lib/server/mail.ts': "export const subject = 'Votre compte est prêt';\n",
  'src/lib/auth/labels.ts': "export const denied = 'Accès refusé pour ce compte';\n",
  'src/lib/components/Card.svelte': '<script lang="ts">\n  let { value }: { value: number } = $props();\n</script>\n\n<p class="card">\n  Montant total du mois\n</p>\n<a href="/aide">Aide en ligne</a>\n',
  'supabase/migrations/20260101000000_init.sql': 'create table public.items (id uuid primary key);\n',
  'tests/e2e/auth.spec.ts': "import { test } from '@playwright/test';\ntest('x', async () => {});\n",
  'playwright.config.ts': 'export default { retries: 0 };\n',
  'docs/guide.md': '# Guide\n',
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

test('review risk: tests, test tooling, documentation and an interface text are of low risk: security, plus fidelity', async t => {
  const p = project(t);
  p.edit('tests/e2e/auth.spec.ts', "import { test } from '@playwright/test';\ntest('y', async () => {});\n");
  p.edit('playwright.config.ts', 'export default { retries: 0, workers: 2 };\n');
  p.edit('tests/fixtures/users.json', '[]\n');
  p.edit('docs/guide.md', '# Guide\n\nPlus de détails.\n');
  p.commit();
  let plan = await p.plan();
  assert.equal(plan.risk.level, 'faible', JSON.stringify(plan.risk));
  assert.deepEqual(plan.retained, ['securite']);
  assert.match(plan.risk.reason, /tests ou documentation/);
  assert.match(plan.risk.reason, /outillage de test/);
  // The test of the authentication is a test: a sensitive path does not make it high.
  assert.equal(plan.files.find(f => f.path === 'tests/e2e/auth.spec.ts').risk, 'faible');
  // An interface text without new markup: fidelity joins, the level stays low.
  p.replace('src/lib/components/Card.svelte', 'Montant total du mois', 'Montant total de la semaine');
  p.commit();
  plan = await p.plan();
  assert.equal(plan.risk.level, 'faible', JSON.stringify(plan.risk));
  assert.deepEqual(plan.retained, ['securite', 'fidelite']);
  assert.match(plan.risk.reason, /texte d'interface sans balisage nouveau/);
  assert.match(await p.text(), /^Risque : faible : seulement /m);
});

test('review risk: an unclassified messages module whose prose changes keeps fidelity only', async t => {
  const p = project(t);
  p.replace('src/lib/messages.ts', 'Bienvenue sur le site', 'Bienvenue sur votre espace');
  p.commit();
  const plan = await p.plan();
  assert.equal(plan.risk.level, 'faible', JSON.stringify(plan.risk));
  assert.deepEqual(plan.retained, ['securite', 'fidelite']);
  assert.equal(plan.counts.texts, 1);
  assert.equal(plan.counts.unclassified, 0);
  assert.match(plan.domains.find(d => d.domain === 'fidelite').reason, /textes seuls d'un fichier non classé/);
  assert.match(plan.skipped.find(s => s.domain === 'donnees').reason, /1 fichier non classé aux seuls textes changés/);
});

test('review risk: what is not prose, or not a plain text, stays of high risk with every domain (refusals)', async t => {
  const cases = [
    ['a one-word value the code may act on', p => p.replace('src/lib/messages.ts', "role: 'admin'", "role: 'owner'"), /fichier non classé au contenu changé \(prudence\)/],
    ['an address', p => p.replace('src/lib/messages.ts', 'https://example.org/aide', 'https://evil.example/aide'), /prudence/],
    ['code', p => p.replace('src/lib/messages.ts', "  title: 'Bienvenue sur le site',", "  title: String(process.env.TITLE),"), /prudence/],
    ['a new key computed', p => p.replace('src/lib/messages.ts', '};', "  more: build('x'),\n};"), /prudence/],
    ['prose in server code', p => p.replace('src/lib/server/mail.ts', 'Votre compte est prêt', 'Votre compte est enfin prêt'), /code serveur ou la configuration/],
  ];
  for (const [name, change, why] of cases) {
    const p = project(t);
    change(p);
    p.commit();
    const plan = await p.plan();
    assert.equal(plan.risk.level, 'eleve', name);
    assert.deepEqual(plan.retained, ['securite', 'fidelite', 'donnees', 'rgpd'], name);
    assert.match(plan.risk.reason, why, name);
  }
  // A sensitive path (authentication): high, even for prose, and the unclassified prudence stays.
  const s = project(t);
  s.replace('src/lib/auth/labels.ts', 'Accès refusé pour ce compte', 'Accès refusé pour cet utilisateur');
  s.commit();
  const plan = await s.plan();
  assert.equal(plan.risk.level, 'eleve');
  assert.match(plan.risk.reason, /chemin sensible/);
  assert.deepEqual(plan.retained, ['securite', 'fidelite', 'donnees', 'rgpd']);
});

test('review risk: interface markup, attributes, personal terms and migrations are of high risk', async t => {
  const cases = [
    ['new markup', p => p.replace('src/lib/components/Card.svelte', '</p>\n', '</p>\n<form action="/x"><button>Envoyer</button></form>\n'), ['securite', 'fidelite'], /interface au balisage ou au code changé/],
    ['an attribute value', p => p.replace('src/lib/components/Card.svelte', 'href="/aide"', 'href="/autre"'), ['securite', 'fidelite'], /interface au balisage/],
    ['a personal term in a text', p => p.replace('src/lib/components/Card.svelte', 'Montant total du mois', 'Votre adresse e-mail'), ['securite', 'fidelite', 'rgpd'], /terme RGPD/],
    ['a migration', p => p.edit('supabase/migrations/20260102000000_more.sql', 'alter table public.items add column note text;\n'), ['securite', 'donnees', 'rgpd'], /migration ou schéma/],
    ['a moved file', p => { p.edit('src/lib/components/money/Card.svelte', readFileSync(join(p.repo, 'src/lib/components/Card.svelte'), 'utf8')); git(p.repo, 'rm', '-q', 'src/lib/components/Card.svelte'); }, ['securite'], /fichier déplacé ou renommé/],
  ];
  for (const [name, change, domains, why] of cases) {
    const p = project(t);
    change(p);
    p.commit();
    const plan = await p.plan();
    assert.equal(plan.risk.level, 'eleve', name);
    assert.deepEqual(plan.retained, domains, name);
    assert.match(plan.risk.reason, why, name);
    assert.ok(plan.risk.files.length >= 1, name);
  }
});

test('review risk: --force and review.always stay above the level; the project classifies its own files', async t => {
  const p = project(t, { review: { always: ['rgpd'] } });
  p.edit('docs/guide.md', '# Guide\n\nAutre.\n');
  p.commit();
  let plan = await p.plan('--force', 'donnees');
  assert.equal(plan.risk.level, 'faible');
  assert.deepEqual(plan.retained, ['securite', 'donnees', 'rgpd']);
  // A file the defaults do not describe, declared by the project as test tooling: low, no domain.
  const q = project(t, { review: { paths: { tooling: ['scripts/test-*.mjs'] } } });
  q.edit('scripts/test-seed.mjs', 'export const n = 1;\n');
  q.commit();
  plan = await q.plan();
  assert.equal(plan.risk.level, 'faible', JSON.stringify(plan.risk));
  assert.deepEqual(plan.retained, ['securite']);
  // Without that declaration, the same file keeps the prudence.
  const r = project(t);
  r.edit('scripts/test-seed.mjs', 'export const n = 1;\n');
  r.commit();
  plan = await r.plan();
  assert.equal(plan.risk.level, 'eleve');
  assert.deepEqual(plan.retained, ['securite', 'fidelite', 'donnees', 'rgpd']);
});

test('review risk: textOnly and isProse, unit', () => {
  const patch = (removed, added) => ({ binary: false, removed, added });
  assert.equal(textOnly(patch(["  a: 'Bonjour à tous',"], ["  a: 'Bonsoir à tous',"]), 'x.ts'), true);
  assert.equal(textOnly(patch([], ["  b: 'Une nouvelle phrase',"]), 'x.ts'), true);
  assert.equal(textOnly(patch(['  // ancien commentaire'], ['  // nouveau commentaire']), 'x.ts'), true);
  assert.equal(textOnly(patch(["if (role === 'admin') {"], ["if (role === 'owner') {"]), 'x.ts'), false);
  assert.equal(textOnly(patch(["const t = 'Bonjour à tous';"], ["const t = 'Bonsoir à tous';"]), 'x.ts'), true);
  // A prose string the code compares or passes on is part of the structure.
  assert.equal(textOnly(patch(["if (status === 'en attente de validation') {"], ["if (status === 'validation en attente') {"]), 'x.ts'), false);
  assert.equal(textOnly(patch(["notify('Votre compte est prêt');"], ["notify('Votre compte est ouvert');"]), 'x.ts'), false);
  assert.equal(textOnly(patch(['<img alt="Logo du site" src="/a.png" />'], ['<img alt="Logo de la marque" src="/a.png" />']), 'x.svelte'), false);
  assert.equal(textOnly(patch(['<img alt="Logo du site" />'], ['<img alt="Logo de la marque" />']), 'x.svelte'), true);
  assert.equal(textOnly(patch(['<a href="/aide">Aide</a>'], ['<a href="/autre">Aide</a>']), 'x.svelte'), false);
  assert.equal(textOnly(patch(['  Ancien texte'], ["  Nouveau texte de l'écran"]), 'x.svelte'), true);
  assert.equal(textOnly(patch(['<p>Ancien texte</p>'], ['<p>Nouveau texte</p>']), 'x.svelte'), true);
  assert.equal(textOnly(patch(['<p>Ancien</p>'], ['<p onclick={go}>Ancien</p>']), 'x.svelte'), false);
  assert.equal(textOnly(patch(['  Texte'], ['  {@html texte}']), 'x.svelte'), false);
  assert.equal(textOnly(patch(['  Texte'], ['  const x = fetch(url);']), 'x.svelte'), false);
  assert.equal(textOnly(patch([], []), 'x.ts'), false);
  assert.equal(textOnly({ binary: true, removed: [], added: [] }, 'x.ts'), false);
  assert.equal(isProse('Bienvenue sur le site'), true);
  for (const word of ['admin', 'https://x.org a', '/api/users x', 'a=b c', '<b>gras</b> x', '${x} y']) assert.equal(isProse(word), false, word);
});
