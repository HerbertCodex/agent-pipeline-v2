import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write, decision } from './cli-helpers.mjs';
import { adBlockedNames } from '../dist/structure/adblock.js';

/**
 * Names hidden by the ad blockers (issue #124). Pilot project, 8 October 2026: an admin page whose classes were `ad-page`,
 * `ad-head`, `ad-bar`, `ad-grid` showed blank in production on the operator's computer, in two browsers: an extension
 * applied the generic filters of EasyList to these names. Invisible in the tests and in the captures of fidelity.
 */

test('adblock names: classes and ids with the prefixes of the generic filters, with their line; neighbours accepted', () => {
  const svelte = [
    '<div class="ad-grid wide">', '  <p id="sponsor">x</p>', '  <span class:ads-banner={on} class="add-on advanced adresse">y</span>',
    '  <aside class="banner-ad">z</aside>', '</div>', '<style>', '  .advert-box, #adv-top { color: red; }', '  .badge, .load-more { color: blue; }', '</style>', '',
  ].join('\n');
  assert.deepEqual(adBlockedNames(svelte, 'src/A.svelte').map(h => [h.line, h.kind, h.name]), [
    [1, 'classe', 'ad-grid'], [2, 'identifiant', 'sponsor'], [3, 'classe', 'ads-banner'], [4, 'classe', 'banner-ad'],
    [7, 'classe', 'advert-box'], [7, 'identifiant', 'adv-top'],
  ]);
  assert.deepEqual(adBlockedNames('.sponsored-list a { color: red; }\n.adresse { margin: 0; }\n', 'src/a.css').map(h => h.name), ['sponsored-list']);
  assert.deepEqual(adBlockedNames('export const C = () => <div className="ad-row">x</div>;\n', 'src/C.tsx').map(h => h.name), ['ad-row']);
  // Text of the page, a word in a script, a data attribute: never a class nor an id.
  assert.deepEqual(adBlockedNames('<p>Le sponsor ad-hoc</p>\n<script>const advert = 1;</script>\n<div data-ad-slot="1"></div>\n', 'src/B.html'), []);
});

function project(t) {
  const f = fixture(t, { files: {
    'src/lib/components/Card.svelte': '<p class="card">Carte</p>\n',
    'src/lib/components/Old.svelte': '<p class="ad-old">Ancien</p>\n',
    'docs/carte-architecture.md': '# Carte\n',
  } });
  git(f.repo, 'switch', '-q', '-c', 'work');
  return f;
}
const adblock = report => report.changes.filter(c => c.code === 'adblock');

test('apv structure check: a class of the generic ad filters added by the change is refused with its file and line', async t => {
  const f = project(t);
  write(f.repo, 'src/lib/components/Card.svelte', '<p class="card">Carte</p>\n<div class="ad-grid">x</div>\n');
  write(f.repo, 'src/lib/components/Neighbours.svelte', '<p class="add-on advanced adresse">x</p>\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'change');
  const r = await apv(f.repo, ['structure', 'check', '--base', 'main', '--json']);
  assert.equal(r.code, 1, r.stdout);
  const found = adblock(r.json());
  assert.deepEqual(found.map(c => [c.path, c.blocking]), [['src/lib/components/Card.svelte:2', true], ['src/lib/components/Old.svelte:1', false]]);
  assert.match(found[0].message, /classe « ad-grid » : masqué par les filtres anti-pub du poste de l'opérateur/);
  const text = await apv(f.repo, ['structure', 'check', '--base', 'main']);
  assert.match(text.stdout, /\[bloquant\] nom masqué par les anti-pub : src\/lib\/components\/Card\.svelte:2 : classe « ad-grid »/);
  // Renamed: accepted; the name the base already had is said without blocking.
  write(f.repo, 'src/lib/components/Card.svelte', '<p class="card">Carte</p>\n<div class="art-grid">x</div>\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'renommage');
  const ok = await apv(f.repo, ['structure', 'check', '--base', 'main', '--json']);
  assert.deepEqual(adblock(ok.json()).filter(c => c.blocking), []);
  const full = (await apv(f.repo, ['structure', 'check', '--json'])).json();
  assert.deepEqual(adblock(full).map(c => [c.path, c.blocking]), [['src/lib/components/Old.svelte:1', false]]);
});

test('apv design register refuses a mockup with a class of the generic ad filters, with its lines', async t => {
  const f = fixture(t, { files: {
    '.apv/DECISIONS.json': `${JSON.stringify({ schemaVersion: 1, decisions: [decision('D-1')] }, null, 2)}\n`,
    'brouillons/articles.html': '<!doctype html><html lang="fr"><title>Articles</title>\n<body>\n<div class="ad-grid">x</div>\n</body></html>\n',
    'brouillons/propre.html': '<!doctype html><html lang="fr"><title>Articles</title>\n<body>\n<div class="art-grid">x</div>\n</body></html>\n',
  } });
  const refused = await apv(f.repo, ['design', 'register', 'brouillons/articles.html', '--name', 'articles', '--quote', 'je valide les articles']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /DESIGN_ADBLOCK/);
  assert.match(refused.stderr, /ligne 3 : classe « ad-grid »/);
  assert.match(refused.stderr, /masqué par les filtres anti-pub du poste de l'opérateur/);
  assert.ok(!existsSync(join(f.repo, 'docs/design')), 'nothing copied');
  const ok = await apv(f.repo, ['design', 'register', 'brouillons/propre.html', '--name', 'articles', '--quote', 'je valide les articles']);
  assert.equal(ok.code, 0, ok.stderr);
});

test('the fidelity review checks the rendering with a generic ad filter injected', async () => {
  const { readFileSync } = await import('node:fs');
  const grid = readFileSync(new URL('../agents/qa-fidelite.md', import.meta.url), 'utf8');
  assert.match(grid, /rendu identique avec un filtre anti-pub générique injecté/);
});

/** The component of the security review of PR #128 (make-adblock.sh): every form an ad filter reads. */
const EVERY_FORM = [
  '<p>base</p>', '<div class="ad-grid">1</div>', '<div class="add-on adresse advanced badge">2</div>', '<div class="sponsored">3</div>',
  '<div class="ad">4</div>', '<div class="ads">5</div>', '<div class="ad_slot">6</div>', '<div class="adsbygoogle">7</div>',
  '<div class="AD-grid">8</div>', '<div class:ad-flag={on}>9</div>', "<div class={'ad-expr'}>10</div>", "<div class=\"x {on ? 'ad-tern' : ''}\">11</div>",
  '<div id="ad-bar">12</div>', '<script>', "  el.classList.add('ad-js');", "  el.className = 'ad-js2';", '</script>',
  '<div className="banner-ad">13</div>', '<div class="banner_ad">14</div>', '<div class=ad-unquoted>15</div>',
  '<style>', '  .ad-style { color: red; }', '  :global(.ad-global) { color: red; }', '  @apply ad-apply;', '</style>', '',
].join('\n');

test('review of PR #128, F4: exact names, underscores, scripts, expressions, ternaries and unquoted attributes are read', () => {
  assert.deepEqual(adBlockedNames(EVERY_FORM, 'src/lib/components/New.svelte').map(h => h.name), [
    'ad-grid', 'sponsored', 'ad', 'ads', 'ad_slot', 'adsbygoogle', 'AD-grid', 'ad-flag', 'ad-expr', 'ad-tern', 'ad-bar', 'ad-js', 'ad-js2',
    'banner-ad', 'banner_ad', 'ad-unquoted', 'ad-style', 'ad-global',
  ]);
  assert.deepEqual(adBlockedNames('.ad-css,\n.ok {\n  color: red;\n}\n[class^="ad-"] { color: blue; }\n', 'src/x.css').map(h => h.name), ['ad-css']);
});

test('review of PR #128, F4: with --base, a file the change does not touch is said, without blocking', async t => {
  const f = project(t);
  write(f.repo, 'src/lib/components/Card.svelte', '<p class="card">Carte modifiée</p>\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'change');
  const report = (await apv(f.repo, ['structure', 'check', '--base', 'main', '--json'])).json();
  assert.deepEqual(adblock(report).map(c => [c.path, c.blocking]), [['src/lib/components/Old.svelte:1', false]]);
});
