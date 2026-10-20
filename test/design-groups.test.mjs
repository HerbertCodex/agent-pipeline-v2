import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write, decision } from './cli-helpers.mjs';
import { listMockups, loadDesignConfig, registerMockup, relocatedValue, sha256File } from '../dist/design/registry.js';

const HTML = '<!doctype html><html lang="fr"><title>Maquette</title><body>Maquette</body></html>\n';
const sha = text => createHash('sha256').update(text).digest('hex');
const GROUPS = { groups: [{ dir: 'admin', match: ['admin-*', 'console'] }], defaultGroup: 'produit' };

/** Repository with a committed V3 ledger, drafts outside docs/design and an optional `design` section. */
function project(t, design, files = {}) {
  return fixture(t, { files: {
    '.apv/DECISIONS.json': `${JSON.stringify({ schemaVersion: 1, decisions: [decision('D-1')] }, null, 2)}\n`,
    'brouillons/a.html': HTML, 'brouillons/b.html': HTML.replace('Maquette</body>', 'Autre</body>'), 'brouillons/c.html': HTML.replace('Maquette</body>', 'Troisième</body>'),
    ...(design && { '.apv/config.json': `${JSON.stringify({ name: 'demo', design }, null, 2)}\n` }),
    ...files,
  } });
}
const commit = (repo, message = 'maj') => { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', message); };
const ledger = repo => JSON.parse(readFileSync(join(repo, '.apv/DECISIONS.json'), 'utf8')).decisions;
const register = (repo, file, name, ...extra) => apv(repo, ['design', 'register', file, '--name', name, '--quote', 'je valide', ...extra]);
/** Changed paths of the working tree (renames as `old -> new`). */
const changes = repo => git(repo, 'status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean).map(l => l.replace(/^[ MADRCU?!]{1,2} /, '')).sort();

test('design.groups and design.defaultGroup: strict validation, normalized settings', async t => {
  const f = project(t, { dir: 'docs/design', groups: [{ dir: 'admin/', match: [' admin-* ', 'console'] }, { dir: 'produit/ecrans', match: ['*'] }], defaultGroup: 'divers' });
  const settings = loadDesignConfig(f.repo);
  assert.deepEqual([settings.dir, settings.groups, settings.defaultGroup],
    ['docs/design', [{ dir: 'admin', match: ['admin-*', 'console'] }, { dir: 'produit/ecrans', match: ['*'] }], 'divers']);
  const invalid = [
    [{ groups: [] }, /design\.groups est vide/],
    [{ groups: [{ dir: '../dehors', match: ['*'] }] }, /design\.groups\[0\]\.dir ne contient pas « \.\. »/],
    [{ groups: [{ dir: 'a/../b', match: ['*'] }] }, /ne contient pas « \.\. »/],
    [{ groups: [{ dir: 'mes maquettes', match: ['*'] }] }, /design\.groups\[0\]\.dir ne contient pas d'espace/],
    [{ groups: [{ dir: '/abs', match: ['*'] }] }, /sous-dossier relatif/],
    [{ groups: [{ dir: '', match: ['*'] }] }, /design\.groups\[0\]\.dir doit être un sous-dossier non vide/],
    [{ groups: [{ dir: 'a//b', match: ['*'] }] }, /design\.groups\[0\]\.dir invalide/],
    [{ groups: [{ dir: '.cache', match: ['*'] }] }, /invalide/],
    [{ groups: [{ dir: 'admin', match: [] }] }, /invalid array/],
    [{ groups: [{ dir: 'admin', match: ['  '] }] }, /design\.groups\[0\]\.match\[0\] : motif vide/],
    [{ groups: [{ dir: 'admin', match: ['admin/*'] }] }, /sans « \/ »/],
    [{ groups: [{ dir: 'admin', match: ['{a,b}'] }] }, /design\.groups\[0\]\.match\[0\] : Unsupported glob/],
    [{ groups: [{ dir: 'admin', match: ['a-*'] }, { dir: 'admin/', match: ['b-*'] }] }, /design\.groups\[1\]\.dir : deux groupes ne peuvent pas avoir le même dossier \(admin\)/],
    [{ groups: [{ dir: 'admin', match: ['*'], dossier: 'x' }] }, /unknown property dossier/],
    [{ defaultGroup: '..' }, /design\.defaultGroup ne contient pas « \.\. »/],
    [{ defaultGroup: 'a b' }, /design\.defaultGroup ne contient pas d'espace/],
    [{ groups: [{ dir: 'brouillons', match: ['*'] }] }, /design\.groups\[0\]\.dir : « brouillons » est réservé aux brouillons/],
    [{ groups: [{ dir: 'Brouillons/anciens', match: ['*'] }] }, /« brouillons » est réservé/],
    [{ defaultGroup: 'brouillons/' }, /design\.defaultGroup : « brouillons » est réservé/],
  ];
  for (const [design, pattern] of invalid) {
    write(f.repo, '.apv/config.json', { design });
    assert.throws(() => loadDesignConfig(f.repo), pattern, JSON.stringify(design));
    // The commands refuse an invalid configuration before writing anything.
    const out = await register(f.repo, 'brouillons/a.html', 'accueil');
    assert.equal(out.code, 1, JSON.stringify(design));
    assert.ok(!existsSync(join(f.repo, 'docs/design')));
  }
});

test('register files each mockup in the folder of its group; without design.groups, nothing changes', async t => {
  const f = project(t, GROUPS);
  const admin = await register(f.repo, 'brouillons/a.html', 'admin-utilisateurs', '--json');
  assert.equal(admin.code, 0, admin.stderr);
  assert.deepEqual([admin.json().target, admin.json().group, admin.json().previousFile], ['docs/design/admin/admin-utilisateurs-validee.html', 'admin', null]);
  assert.deepEqual(admin.json().attributes, { file: '.gitattributes', line: 'docs/design/**/*.html -whitespace', status: 'added' });
  assert.deepEqual(admin.json().toCommit, ['docs/design/admin/admin-utilisateurs-validee.html', '.apv/DECISIONS.json', '.apv/DECISIONS.md', '.gitattributes']);
  const d = ledger(f.repo).find(x => x.id === 'maquette-admin-utilisateurs-validee');
  assert.ok(d.value.includes(`fichier docs/design/admin/admin-utilisateurs-validee.html, sha256 ${sha(HTML)}`), d.value);
  assert.ok(!d.value.includes('Groupe :'), 'the patterns decide: nothing recorded');
  commit(f.repo);
  // Second pattern of the group, then a name no pattern matches: the default group.
  const console = await register(f.repo, 'brouillons/b.html', 'console');
  assert.equal(console.code, 0, console.stderr);
  assert.match(console.stdout, /Maquette validée enregistrée : docs\/design\/admin\/console-validee\.html\n[\s\S]*  groupe   admin\n/);
  commit(f.repo);
  const accueil = await register(f.repo, 'brouillons/c.html', 'accueil', '--json');
  assert.deepEqual([accueil.json().target, accueil.json().group, accueil.json().attributes.status], ['docs/design/produit/accueil-validee.html', 'produit', 'present']);
  commit(f.repo);
  for (const file of ['docs/design/admin/console-validee.html', 'docs/design/produit/accueil-validee.html'])
    assert.equal(git(f.repo, 'check-attr', 'whitespace', '--', file), `${file}: whitespace: unset`);
  const listed = (await apv(f.repo, ['design', 'list', '--json'])).json().mockups;
  assert.deepEqual(listed.map(m => [m.slug, m.group, m.folder, m.placed]),
    [['admin-utilisateurs', 'admin', 'docs/design/admin', true], ['console', 'admin', 'docs/design/admin', true], ['accueil', 'produit', 'docs/design/produit', true]]);
  const human = await apv(f.repo, ['design', 'list']);
  assert.match(human.stdout, /^nom\s+groupe\s+décision\s+fichier/);
  assert.match(human.stdout, /accueil\s+produit\s+maquette-accueil-validee\s+docs\/design\/produit\/accueil-validee\.html/);
  const check = await apv(f.repo, ['design', 'check', '--json']);
  assert.deepEqual([check.code, check.json().ok, check.json().misplaced, check.json().attributes.status], [0, true, [], 'present']);

  // Without groups: the root of design.dir, no group column, group null.
  const plain = project(t);
  const out = await register(plain.repo, 'brouillons/a.html', 'admin-utilisateurs', '--json');
  assert.deepEqual([out.json().target, out.json().group], ['docs/design/admin-utilisateurs-validee.html', null]);
  assert.doesNotMatch((await apv(plain.repo, ['design', 'list'])).stdout, /groupe/);
  assert.deepEqual((await apv(plain.repo, ['design', 'list', '--json'])).json().mockups.map(m => [m.group, m.folder, m.placed]), [[null, 'docs/design', true]]);
});

test('register --group: a declared group only, recorded in the decision and kept by the next registrations', async t => {
  const f = project(t, GROUPS);
  for (const [group, pattern] of [['inconnu', /DESIGN_GROUP.*groupe non déclaré « inconnu » \(groupes déclarés : admin, produit\)/], ['../admin', /DESIGN_GROUP.*« \.\. »/], ['a b', /DESIGN_GROUP.*espace/]]) {
    const out = await register(f.repo, 'brouillons/a.html', 'rapport', '--group', group);
    assert.equal(out.code, 1, group);
    assert.match(out.stderr, pattern);
  }
  assert.ok(!existsSync(join(f.repo, 'docs/design')), 'nothing copied on refusal');
  assert.equal(ledger(f.repo).length, 1, 'ledger untouched');
  assert.equal((await apv(f.repo, ['design', 'list', '--group', 'admin'])).code, 2, '--group is for register only');

  const out = await register(f.repo, 'brouillons/a.html', 'rapport', '--group', 'admin/', '--json');
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual([out.json().target, out.json().group], ['docs/design/admin/rapport-validee.html', 'admin']);
  assert.match(ledger(f.repo).find(x => x.id === 'maquette-rapport-validee').value, /Groupe : admin\./);
  commit(f.repo);
  const [mockup] = listMockups(f.repo);
  assert.deepEqual([mockup.recordedGroup, mockup.state], ['admin', 'ok']);
  // New content without --group: the recorded group is kept (the patterns would say produit).
  const again = await register(f.repo, 'brouillons/b.html', 'rapport', '--json');
  assert.deepEqual([again.json().decisionId, again.json().target, again.json().group], ['maquette-rapport-validee-v2', 'docs/design/admin/rapport-validee.html', 'admin']);
  assert.match(ledger(f.repo).find(x => x.id === 'maquette-rapport-validee-v2').value, /Groupe : admin\./);
  commit(f.repo);
  assert.deepEqual((await apv(f.repo, ['design', 'check', '--json'])).json().misplaced, []);
  assert.equal((await apv(f.repo, ['design', 'organize', '--json'])).json().moves.length, 0, 'organize follows the recorded group');
  // Same content, same group: no-op.
  assert.equal((await register(f.repo, 'brouillons/b.html', 'rapport', '--json')).json().unchanged, true);
  // Without design.groups, --group has no object.
  const plain = project(t);
  assert.match((await register(plain.repo, 'brouillons/a.html', 'rapport', '--group', 'admin')).stderr, /DESIGN_GROUP.*aucun groupe déclaré/);
});

test('a re-registration keeps the folder of the mockup; --group moves it and names the old file', async t => {
  const f = project(t);
  assert.equal((await register(f.repo, 'brouillons/a.html', 'accueil')).code, 0);
  commit(f.repo);
  assert.equal((await register(f.repo, 'brouillons/c.html', 'admin-roles')).code, 0);
  commit(f.repo);
  write(f.repo, '.apv/config.json', { name: 'demo', design: GROUPS });
  commit(f.repo, 'groupes');
  // New content after the groups appear: the file stays where it is (organize moves, register never does).
  const kept = await register(f.repo, 'brouillons/b.html', 'accueil', '--json');
  assert.deepEqual([kept.json().decisionId, kept.json().target, kept.json().group, kept.json().previousFile],
    ['maquette-accueil-validee-v2', 'docs/design/accueil-validee.html', null, null]);
  commit(f.repo);
  const check = await apv(f.repo, ['design', 'check']);
  assert.equal(check.code, 0, 'out of its group: a warning, not a failure');
  assert.match(check.stdout, /Attention : maquette\(s\) hors du dossier de leur groupe \(apv design organize les range\) :\n- docs\/design\/admin-roles-validee\.html \(maquette-admin-roles-validee\) : groupe admin, dossier docs\/design\/admin\/\n- docs\/design\/accueil-validee\.html \(maquette-accueil-validee-v2\) : groupe produit, dossier docs\/design\/produit\//);
  // --group moves the registration; the old file is left in place and named.
  const moved = await register(f.repo, 'brouillons/b.html', 'accueil', '--group', 'produit');
  assert.equal(moved.code, 0, moved.stderr);
  assert.match(moved.stdout, /docs\/design\/produit\/accueil-validee\.html[\s\S]*L'ancien fichier docs\/design\/accueil-validee\.html reste en place : retirez-le \(git rm -- docs\/design\/accueil-validee\.html\)/);
  assert.ok(existsSync(join(f.repo, 'docs/design/accueil-validee.html')));
  commit(f.repo);
  // Patterns changed afterwards: a file already in a declared group stays in it on re-registration.
  write(f.repo, '.apv/config.json', { name: 'demo', design: { groups: [{ dir: 'admin', match: ['gestion-*'] }], defaultGroup: 'produit' } });
  commit(f.repo, 'motifs');
  assert.equal((await register(f.repo, 'brouillons/a.html', 'console', '--group', 'admin')).code, 0);
  commit(f.repo);
  const v2 = await register(f.repo, 'brouillons/c.html', 'console', '--json');
  assert.deepEqual([v2.json().target, v2.json().group], ['docs/design/admin/console-validee.html', 'admin']);
});

test('.gitattributes: the root-only line is accepted without groups, replaced in place when groups exist', async t => {
  const SPACED = '<!doctype html>\n<html lang="fr">  \n<body>Admin</body></html>\n';
  const old = '* text=auto\n# Maquettes validées : espaces gardés\ndocs/design/*.html -whitespace\n*.png binary\n';
  const f = project(t, undefined, { '.gitattributes': old, 'brouillons/espaces.html': SPACED });
  assert.equal((await register(f.repo, 'brouillons/a.html', 'accueil', '--json')).json().attributes.status, 'present');
  commit(f.repo);
  assert.equal((await apv(f.repo, ['design', 'check', '--json'])).json().attributes.status, 'present');
  write(f.repo, '.apv/config.json', { name: 'demo', design: GROUPS });
  commit(f.repo, 'groupes');
  const before = await apv(f.repo, ['design', 'check', '--json']);
  assert.deepEqual([before.code, before.json().attributes.status, before.json().attributes.previous], [0, 'missing', 'docs/design/*.html -whitespace']);
  assert.match((await apv(f.repo, ['design', 'check'])).stdout, /ne contient pas « docs\/design\/\*\*\/\*\.html -whitespace » \(la ligne « docs\/design\/\*\.html -whitespace » ne couvre pas les sous-dossiers des groupes\)/);
  const out = await register(f.repo, 'brouillons/espaces.html', 'admin-roles');
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /\.gitattributes : ligne « docs\/design\/\*\.html -whitespace » remplacée par « docs\/design\/\*\*\/\*\.html -whitespace » \(elle ne couvrait pas les sous-dossiers des groupes\)/);
  assert.match(out.stdout, /git add -- docs\/design\/admin\/admin-roles-validee\.html \.apv\/DECISIONS\.json \.apv\/DECISIONS\.md \.gitattributes/);
  assert.equal(readFileSync(join(f.repo, '.gitattributes'), 'utf8'), old.replace('docs/design/*.html', 'docs/design/**/*.html'), 'replaced at its place, comment and other lines kept');
  for (const file of ['docs/design/admin/admin-roles-validee.html', 'docs/design/accueil-validee.html'])
    assert.equal(git(f.repo, 'check-attr', 'whitespace', '--', file), `${file}: whitespace: unset`);
  commit(f.repo);
  git(f.repo, 'diff', '--check', 'HEAD~1', 'HEAD');
  assert.equal((await apv(f.repo, ['design', 'check', '--json'])).json().attributes.status, 'present');
  // A mockup with trailing spaces in a group, and only the root-only line: git diff --check would fail.
  writeFileSync(join(f.repo, '.gitattributes'), old);
  const broken = await apv(f.repo, ['design', 'check', '--json']);
  assert.deepEqual([broken.code, broken.json().attributes.blocking, broken.json().attributes.whitespace], [1, true, ['docs/design/admin/admin-roles-validee.html']]);
});

/** Two committed mockups at the root, a note citing one of them, then groups declared. */
async function grouped(t) {
  const f = project(t, undefined, { 'docs/notes.md': 'Référence : docs/design/admin-roles-validee.html\n' });
  assert.equal((await register(f.repo, 'brouillons/a.html', 'admin-roles')).code, 0);
  commit(f.repo, 'maquette');
  assert.equal((await register(f.repo, 'brouillons/b.html', 'accueil')).code, 0);
  commit(f.repo, 'maquettes');
  write(f.repo, '.apv/config.json', { name: 'demo', design: GROUPS });
  commit(f.repo, 'groupes');
  return f;
}

test('organize --dry-run shows the plan and the files citing an old path, without touching anything', async t => {
  const f = await grouped(t);
  const dry = await apv(f.repo, ['design', 'organize', '--dry-run', '--json']);
  assert.equal(dry.code, 0, dry.stderr);
  const plan = dry.json();
  assert.deepEqual([plan.ok, plan.dryRun, plan.applied, plan.blocked], [true, true, false, []]);
  assert.deepEqual(plan.moves.map(m => [m.decisionId, m.from, m.to, m.group, m.tracked]), [
    ['maquette-admin-roles-validee', 'docs/design/admin-roles-validee.html', 'docs/design/admin/admin-roles-validee.html', 'admin', true],
    ['maquette-accueil-validee', 'docs/design/accueil-validee.html', 'docs/design/produit/accueil-validee.html', 'produit', true],
  ]);
  assert.deepEqual(plan.references, [{ path: 'docs/design/admin-roles-validee.html', files: ['docs/notes.md'] }]);
  assert.deepEqual(changes(f.repo), [], 'nothing touched');
  const human = await apv(f.repo, ['design', 'organize', '--dry-run']);
  assert.match(human.stdout, /Plan \(--dry-run, rien n'a été touché\) :\n- docs\/design\/admin-roles-validee\.html -> docs\/design\/admin\/admin-roles-validee\.html \(maquette-admin-roles-validee, groupe admin\)/);
  assert.match(human.stdout, /Fichiers qui citent encore un ancien chemin[^\n]*\n- docs\/design\/admin-roles-validee\.html :\n    docs\/notes\.md/);
  assert.deepEqual(changes(f.repo), []);
  // list marks them, check warns without failing.
  assert.match((await apv(f.repo, ['design', 'list'])).stdout, /admin-roles\s+admin \(à ranger\)/);
  const check = await apv(f.repo, ['design', 'check', '--json']);
  assert.deepEqual([check.code, check.json().misplaced.map(m => m.file)], [0, ['docs/design/admin-roles-validee.html', 'docs/design/accueil-validee.html']]);
  assert.equal((await apv(f.repo, ['design', 'organize', '--dry-run', 'x'])).code, 2);
  assert.equal((await apv(f.repo, ['design', 'list', '--dry-run'])).code, 2);
});

test('organize moves by git mv, rewrites the path in the same decision (no new version), keeps the sha256 and changes no other file', async t => {
  const f = await grouped(t);
  const before = ledger(f.repo);
  const shas = listMockups(f.repo).map(m => m.sha256);
  const out = await apv(f.repo, ['design', 'organize']);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /Maquettes rangées \(empreinte inchangée, chemin réécrit dans leur décision, sans nouvelle version\) :/);
  assert.match(out.stdout, /docs\/design\/admin-roles-validee\.html :\n    docs\/notes\.md/);
  // Only the moves and the ledger: the note citing the old path is listed, not changed.
  assert.deepEqual(changes(f.repo), ['.apv/DECISIONS.json', '.apv/DECISIONS.md',
    'docs/design/accueil-validee.html -> docs/design/produit/accueil-validee.html', 'docs/design/admin-roles-validee.html -> docs/design/admin/admin-roles-validee.html']);
  assert.equal(readFileSync(join(f.repo, 'docs/notes.md'), 'utf8'), 'Référence : docs/design/admin-roles-validee.html\n');
  const after = ledger(f.repo);
  assert.deepEqual(after.map(d => d.id), before.map(d => d.id), 'same decisions, no -v2');
  for (const [i, d] of after.entries()) {
    const old = before[i];
    assert.deepEqual({ ...d, value: '' }, { ...old, value: '' }, 'only the value changes');
    if (d.id === 'D-1') assert.equal(d.value, old.value);
  }
  assert.ok(after[1].value.includes(`fichier docs/design/admin/admin-roles-validee.html, sha256 ${shas[0]}`), after[1].value);
  assert.equal(after[1].value, before[1].value.replace('docs/design/admin-roles-validee.html', 'docs/design/admin/admin-roles-validee.html'));
  assert.ok(readFileSync(join(f.repo, '.apv/DECISIONS.md'), 'utf8').includes('docs/design/produit/accueil-validee.html'));
  assert.deepEqual(listMockups(f.repo).map(m => [m.file, m.sha256, m.state]), [
    ['docs/design/admin/admin-roles-validee.html', shas[0], 'ok'], ['docs/design/produit/accueil-validee.html', shas[1], 'ok']]);
  assert.equal(sha256File(join(f.repo, 'docs/design/admin/admin-roles-validee.html')), shas[0]);
  assert.equal((await apv(f.repo, ['ledger', 'validate'])).code, 0);
  // The printed commands work as given.
  const add = /git add -- ([^\n]+)/.exec(out.stdout)[1].split(' ');
  const paths = /git commit -m "[^"]+" -- ([^\n]+)/.exec(out.stdout)[1].split(' ');
  git(f.repo, 'add', '--', ...add); git(f.repo, 'commit', '-qm', 'rangement', '--', ...paths);
  assert.deepEqual(changes(f.repo), []);
  const check = await apv(f.repo, ['design', 'check', '--json']);
  assert.deepEqual([check.code, check.json().misplaced, check.json().attributes.status], [0, [], 'present']);
  assert.match((await apv(f.repo, ['design', 'organize'])).stdout, /Rien à faire/);
});

test('organize moves an untracked mockup with a plain move', async t => {
  const f = project(t, GROUPS);
  assert.equal((await registerMockup(f.repo, { file: 'brouillons/a.html', slug: 'accueil', quote: 'je valide', group: 'admin' })).target, 'docs/design/admin/accueil-validee.html');
  // Only the ledger is committed; the mockup stays untracked. Then the recorded group is no longer declared.
  git(f.repo, 'add', '.apv'); git(f.repo, 'commit', '-qm', 'registre');
  write(f.repo, '.apv/config.json', { name: 'demo', design: { defaultGroup: 'produit' } });
  const out = await apv(f.repo, ['design', 'organize', '--json']);
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(out.json().moves.map(m => [m.from, m.to, m.tracked]), [['docs/design/admin/accueil-validee.html', 'docs/design/produit/accueil-validee.html', false]]);
  assert.deepEqual(out.json().toAdd, ['docs/design/produit/accueil-validee.html', '.apv/DECISIONS.json', '.apv/DECISIONS.md']);
  assert.ok(!existsSync(join(f.repo, 'docs/design/admin/accueil-validee.html')));
  assert.equal(sha256File(join(f.repo, 'docs/design/produit/accueil-validee.html')), sha(HTML));
  assert.equal(listMockups(f.repo)[0].state, 'ok');
});

test('organize refuses, all or nothing, an existing target, a changed or missing mockup and an uncommitted ledger', async t => {
  const f = await grouped(t);
  const pristine = () => assert.deepEqual(changes(f.repo).filter(p => !p.startsWith('docs/design/produit/')), [], 'nothing moved, ledger untouched');
  write(f.repo, 'docs/design/produit/accueil-validee.html', '<p>autre</p>\n');
  const exists = await apv(f.repo, ['design', 'organize', '--json']);
  assert.equal(exists.code, 1);
  assert.deepEqual(exists.json().blocked.map(b => [b.decisionId, b.reason]), [['maquette-accueil-validee', 'la cible docs/design/produit/accueil-validee.html existe déjà']]);
  assert.equal(exists.json().applied, false);
  pristine();
  assert.ok(existsSync(join(f.repo, 'docs/design/admin-roles-validee.html')), 'the other move is not done either');
  const human = await apv(f.repo, ['design', 'organize']);
  assert.equal(human.code, 1);
  assert.match(human.stdout, /Rangement impossible, rien n'a été déplacé :\n- docs\/design\/accueil-validee\.html -> docs\/design\/produit\/accueil-validee\.html \(maquette-accueil-validee\) : la cible docs\/design\/produit\/accueil-validee\.html existe déjà/);
  assert.equal((await apv(f.repo, ['design', 'organize', '--dry-run'])).code, 1, 'the dry run says it would fail');
  git(f.repo, 'clean', '-qfd', '--', 'docs/design/produit');

  writeFileSync(join(f.repo, 'docs/design/admin-roles-validee.html'), '<p>retouchée</p>\n');
  const drift = await apv(f.repo, ['design', 'organize', '--json']);
  assert.equal(drift.code, 1);
  assert.match(drift.json().blocked[0].reason, /fichier modifié depuis la validation/);
  git(f.repo, 'rm', '-q', '-f', '--', 'docs/design/admin-roles-validee.html');
  assert.equal((await apv(f.repo, ['design', 'organize', '--json'])).json().blocked[0].reason, 'fichier absent');
  git(f.repo, 'reset', '-q', '--hard');

  writeFileSync(join(f.repo, '.apv/DECISIONS.md'), 'retouche\n');
  const dirty = await apv(f.repo, ['design', 'organize']);
  assert.equal(dirty.code, 1);
  assert.match(dirty.stderr, /LEDGER_DIRTY/);
  assert.ok(existsSync(join(f.repo, 'docs/design/admin-roles-validee.html')) && existsSync(join(f.repo, 'docs/design/accueil-validee.html')), 'nothing moved');
  assert.equal(readFileSync(join(f.repo, '.apv/DECISIONS.json'), 'utf8'), git(f.repo, 'show', 'HEAD:.apv/DECISIONS.json') + '\n');
});

test('apv help lists organize and --group', async () => {
  assert.match((await apv(process.cwd(), ['help'])).stdout, /apv design register\|list\|check\|organize/);
  const own = await apv(process.cwd(), ['help', 'design']);
  assert.match(own.stdout, /apv design organize \[--dry-run\]/);
  assert.match(own.stdout, /--group <dossier>/);
});

// Review of PR #101: symbolic links, files out of the mockup folder, structured mentions, rollback, ledger cases.

test('register refuses to write through a symbolic link (group folder, design.dir, target) and a linked source', async t => {
  const f = project(t, GROUPS);
  const outside = join(f.root, 'dehors');
  mkdirSync(outside);
  mkdirSync(join(f.repo, 'docs/design'), { recursive: true });
  symlinkSync(outside, join(f.repo, 'docs/design/admin'));
  const group = await register(f.repo, 'brouillons/a.html', 'admin-roles');
  assert.equal(group.code, 1);
  assert.match(group.stderr, /DESIGN_LINK.*docs\/design\/admin\/admin-roles-validee\.html passe par un lien symbolique \(docs\/design\/admin\)/);
  assert.deepEqual(readdirSync(outside), [], 'nothing written outside the repository');
  assert.equal(ledger(f.repo).length, 1, 'ledger untouched');
  // design.dir itself a link.
  rmSync(join(f.repo, 'docs/design'), { recursive: true });
  symlinkSync(outside, join(f.repo, 'docs/design'));
  assert.match((await register(f.repo, 'brouillons/a.html', 'accueil')).stderr, /DESIGN_LINK.*\(docs\/design\)/);
  assert.deepEqual(readdirSync(outside), []);
  rmSync(join(f.repo, 'docs/design'));
  // The target file itself a link (to a file outside).
  writeFileSync(join(outside, 'cible.html'), 'dehors\n');
  mkdirSync(join(f.repo, 'docs/design/produit'), { recursive: true });
  symlinkSync(join(outside, 'cible.html'), join(f.repo, 'docs/design/produit/accueil-validee.html'));
  assert.match((await register(f.repo, 'brouillons/a.html', 'accueil')).stderr, /DESIGN_LINK.*\(docs\/design\/produit\/accueil-validee\.html\)/);
  assert.equal(readFileSync(join(outside, 'cible.html'), 'utf8'), 'dehors\n');
  // A linked source.
  symlinkSync(join(f.repo, 'brouillons/a.html'), join(f.repo, 'brouillons/lien.html'));
  assert.match((await register(f.repo, 'brouillons/lien.html', 'console')).stderr, /DESIGN_LINK.*brouillons\/lien\.html est un lien symbolique/);
  assert.equal(ledger(f.repo).length, 1);
});

test('a registered file reached through a link is read by its real path: outside the repository, it is absent', async t => {
  const f = project(t);
  assert.equal((await register(f.repo, 'brouillons/a.html', 'accueil')).code, 0);
  commit(f.repo);
  writeFileSync(join(f.root, 'copie.html'), HTML);
  rmSync(join(f.repo, 'docs/design/accueil-validee.html'));
  symlinkSync(join(f.root, 'copie.html'), join(f.repo, 'docs/design/accueil-validee.html'));
  assert.equal(listMockups(f.repo)[0].state, 'missing', 'same content, but outside the repository');
  assert.equal((await apv(f.repo, ['design', 'check'])).code, 1);
});

test('organize moves no file through a link, out of design.dir or that is not HTML', async t => {
  const f = await grouped(t);
  const outside = join(f.root, 'dehors');
  mkdirSync(outside);
  symlinkSync(outside, join(f.repo, 'docs/design/admin'));
  const target = await apv(f.repo, ['design', 'organize', '--json']);
  assert.equal(target.code, 1);
  assert.deepEqual(target.json().blocked.map(b => [b.decisionId, b.reason]),
    [['maquette-admin-roles-validee', 'la cible passe par un lien symbolique (docs/design/admin) : refusé, elle pourrait sortir du dépôt']]);
  assert.deepEqual(readdirSync(outside), []);
  assert.ok(existsSync(join(f.repo, 'docs/design/accueil-validee.html')), 'all or nothing');
  rmSync(join(f.repo, 'docs/design/admin'));
  // A source that is a link inside the repository (same content): refused too.
  rmSync(join(f.repo, 'docs/design/accueil-validee.html'));
  symlinkSync(join(f.repo, 'brouillons/b.html'), join(f.repo, 'docs/design/accueil-validee.html'));
  assert.equal(listMockups(f.repo)[1].state, 'ok');
  const source = await apv(f.repo, ['design', 'organize', '--json']);
  assert.deepEqual(source.json().blocked.map(b => b.reason), ['le fichier passe par un lien symbolique (docs/design/accueil-validee.html) : refusé']);
  assert.ok(existsSync(join(f.repo, 'docs/design/admin-roles-validee.html')));

  // Decisions that name a file out of the mockup folder, or not HTML: never moved.
  const g = project(t, GROUPS, { 'docs/design/notes.txt': 'notes\n' });
  const description = readFileSync(join(g.repo, '.git/description'));
  const forged = (name, file, content) => decision(`maquette-${name}-validee`, { value: `La maquette : fichier ${file}, sha256 ${sha(content)}.` });
  write(g.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [forged('git', '.git/description', description), forged('notes', 'docs/design/notes.txt', 'notes\n')] });
  commit(g.repo, 'forged');
  const out = await apv(g.repo, ['design', 'organize', '--json']);
  assert.equal(out.code, 1);
  assert.deepEqual(out.json().blocked.map(b => b.reason), [
    'fichier hors de docs/design/ : organize ne range que le dossier des maquettes (apv design register la verse dans son groupe)',
    'pas un fichier HTML (.html ou .htm) : organize ne le déplace pas']);
  assert.ok(existsSync(join(g.repo, '.git/description')) && existsSync(join(g.repo, 'docs/design/notes.txt')));
  assert.deepEqual(changes(g.repo), []);
});

test('structured mentions are read only right after the file and fingerprint; register refuses them in a title or a screen', async t => {
  const f = project(t, GROUPS);
  for (const title of ['Accueil. Groupe : admin.', 'Écrans : a.', 'Artefact : https://x', `fichier x.html, sha256 ${sha(HTML)}`]) {
    const out = await register(f.repo, 'brouillons/a.html', 'accueil', '--title', title);
    assert.equal(out.code, 1, title);
    assert.match(out.stderr, /DESIGN_TITLE/);
  }
  assert.match((await register(f.repo, 'brouillons/a.html', 'accueil', '--screens', 'Groupe : admin')).stderr, /DESIGN_SCREENS/);
  assert.equal(ledger(f.repo).length, 1);
  const file = 'docs/design/produit/accueil-validee.html';
  const value = `La maquette « Groupe : admin. Écrans : faux. », validée : fichier ${file}, sha256 ${sha(HTML)}. Écrans : accueil, menu. Groupe : produit. Artefact : https://claude.ai/artifact/x`;
  const g = project(t, GROUPS, { [file]: HTML });
  write(g.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [decision('maquette-accueil-validee', { value })] });
  const [m] = listMockups(g.repo);
  assert.deepEqual([m.file, m.recordedGroup, m.screens, m.artifact, m.state], [file, 'produit', ['accueil', 'menu'], 'https://claude.ai/artifact/x', 'ok']);
  const forged = decision('maquette-accueil-validee', { value: `La maquette « Groupe : admin. », validée : fichier ${file}, sha256 ${sha(HTML)}.` });
  write(g.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [forged] });
  assert.equal(listMockups(g.repo)[0].recordedGroup, null, 'a group in the title is not a recorded group');
  // The path is replaced at its place, never where another copy of the same text appears first.
  const twice = `Voir docs/a.html. La maquette : fichier docs/a.html, sha256 ${sha(HTML)}.`;
  assert.equal(relocatedValue(twice, 'docs/a.html', 'docs/b/a.html'), `Voir docs/a.html. La maquette : fichier docs/b/a.html, sha256 ${sha(HTML)}.`);
});

test('organize puts back the moves, the folders it created and the ledger when it fails on the way', async t => {
  const f = await grouped(t);
  const before = readFileSync(join(f.repo, '.apv/DECISIONS.json'), 'utf8');
  const beforeMd = readFileSync(join(f.repo, '.apv/DECISIONS.md'), 'utf8');
  // A file where the folder of the second group should be: the first move is done, the second fails.
  writeFileSync(join(f.repo, 'docs/design/produit'), 'occupé\n');
  const out = await apv(f.repo, ['design', 'organize']);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /DESIGN_ORGANIZE.*Rangement interrompu \(.*\) : tous les déplacements ont été annulés ; registre remis comme avant\./);
  assert.ok(existsSync(join(f.repo, 'docs/design/admin-roles-validee.html')) && existsSync(join(f.repo, 'docs/design/accueil-validee.html')));
  assert.ok(!existsSync(join(f.repo, 'docs/design/admin')), 'the folder it created is removed');
  assert.equal(readFileSync(join(f.repo, '.apv/DECISIONS.json'), 'utf8'), before);
  assert.equal(readFileSync(join(f.repo, '.apv/DECISIONS.md'), 'utf8'), beforeMd);
  assert.deepEqual(changes(f.repo), ['docs/design/produit']);
  assert.deepEqual(git(f.repo, 'diff', '--cached', '--name-only'), '', 'nothing left staged');
});

test('organize: a legacy decision is listed, never moved; an old path cited elsewhere in the ledger is reported', async t => {
  const f = await grouped(t);
  const legacy = decision('maquette-appli-validee', { value: 'La maquette validée, versée dans docs/design/appli.html, est la référence.' });
  const citing = decision('D-2', { value: 'Les écrans admin suivent docs/design/admin-roles-validee.html.' });
  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [...ledger(f.repo), legacy, citing] });
  commit(f.repo, 'registre');
  const out = await apv(f.repo, ['design', 'organize', '--json']);
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(out.json().legacy, ['maquette-appli-validee']);
  assert.deepEqual(out.json().references, [{ path: 'docs/design/admin-roles-validee.html', files: ['docs/notes.md', '.apv/DECISIONS.json', '.apv/DECISIONS.md'] }]);
  const after = ledger(f.repo);
  assert.equal(after.find(d => d.id === 'D-2').value, citing.value, 'another decision is never rewritten');
  assert.equal(after.find(d => d.id === 'maquette-appli-validee').value, legacy.value);
  assert.match((await apv(f.repo, ['design', 'organize'])).stdout, /Non rangeable \(décision sans fichier ni empreinte\) : maquette-appli-validee/);
});

test('organize rewrites a V2 ledger at its place (.agent-pipeline/)', async t => {
  const f = fixture(t, { files: { '.agent-pipeline/DECISIONS.json': `${JSON.stringify({ schemaVersion: 1, decisions: [decision('D-1')] })}\n`, 'brouillons/a.html': HTML } });
  assert.equal((await register(f.repo, 'brouillons/a.html', 'admin-roles')).code, 0);
  commit(f.repo, 'maquette');
  write(f.repo, '.apv/config.json', { name: 'demo', design: GROUPS });
  commit(f.repo, 'groupes');
  const out = await apv(f.repo, ['design', 'organize', '--json']);
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual([out.json().ledgerFile, out.json().ledgerMarkdown], ['.agent-pipeline/DECISIONS.json', '.agent-pipeline/DECISIONS.md']);
  assert.ok(!existsSync(join(f.repo, '.apv/DECISIONS.json')));
  const v2 = JSON.parse(readFileSync(join(f.repo, '.agent-pipeline/DECISIONS.json'), 'utf8')).decisions;
  assert.ok(v2.find(d => d.id === 'maquette-admin-roles-validee').value.includes('fichier docs/design/admin/admin-roles-validee.html, sha256'));
  assert.match(readFileSync(join(f.repo, '.agent-pipeline/DECISIONS.md'), 'utf8'), /docs\/design\/admin\/admin-roles-validee\.html/);
  assert.equal(listMockups(f.repo)[0].state, 'ok');
});
