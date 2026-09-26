import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write, decision } from './cli-helpers.mjs';
import { listMockups, loadDesignConfig, matchesScreen, registerMockup, sha256File } from '../dist/design/registry.js';

const HTML = '<!doctype html><html lang="fr"><title>Tableau</title><body>Tableau de bord</body></html>\n';
const sha = text => createHash('sha256').update(text).digest('hex');

/** Repository with a committed V3 ledger and a draft mockup outside docs/design. */
function project(t, ledger = [decision('D-1')], files = {}) {
  const f = fixture(t, { files: { '.apv/DECISIONS.json': `${JSON.stringify({ schemaVersion: 1, decisions: ledger }, null, 2)}\n`, 'brouillons/tableau-v3.html': HTML, ...files } });
  return f;
}

test('register copies the mockup, records a hashed operator decision and prints what to commit', async t => {
  const f = project(t);
  const out = await apv(f.repo, ['design', 'register', 'brouillons/tableau-v3.html', '--name', 'tableau-de-bord', '--title', 'Tableau de bord',
    '--screens', 'tableau de bord,première visite', '--quote', 'je valide le tableau de bord', '--artifact', 'https://claude.ai/artifact/abc']);
  assert.equal(out.code, 0, out.stderr);
  const target = join(f.repo, 'docs/design/tableau-de-bord-validee.html');
  assert.equal(readFileSync(target, 'utf8'), HTML);
  assert.match(out.stdout, new RegExp(sha(HTML)));
  assert.match(out.stdout, /git add -- docs\/design\/tableau-de-bord-validee\.html \.apv\/DECISIONS\.json \.apv\/DECISIONS\.md/);
  assert.match(out.stdout, /rien n'a été commité/);
  const ledger = JSON.parse(readFileSync(join(f.repo, '.apv/DECISIONS.json'), 'utf8'));
  const d = ledger.decisions.find(x => x.id === 'maquette-tableau-de-bord-validee');
  assert.deepEqual([d.status, d.source, d.enforcement, d.sourceQuote], ['confirmed', 'operator', 'product', 'je valide le tableau de bord']);
  assert.ok(d.value.includes(`fichier docs/design/tableau-de-bord-validee.html, sha256 ${sha(HTML)}`), d.value);
  assert.ok(!/[–—]/.test(d.value + d.subject + d.rationale), 'no em or en dash in generated texts');
  assert.ok(existsSync(join(f.repo, '.apv/DECISIONS.md')));
  assert.equal(git(f.repo, 'log', '--oneline').split('\n').length, 1, 'nothing committed');
  assert.equal((await apv(f.repo, ['ledger', 'validate'])).code, 0);

  const listed = (await apv(f.repo, ['design', 'list', '--json'])).json().mockups;
  assert.equal(listed.length, 1);
  assert.deepEqual([listed[0].slug, listed[0].state, listed[0].sha256, listed[0].artifact], ['tableau-de-bord', 'ok', sha(HTML), 'https://claude.ai/artifact/abc']);
  assert.deepEqual(listed[0].screens, ['tableau de bord', 'première visite']);
  const human = await apv(f.repo, ['design', 'list']);
  assert.match(human.stdout, /tableau-de-bord\s+maquette-tableau-de-bord-validee\s+docs\/design\/tableau-de-bord-validee\.html/);
  assert.equal((await apv(f.repo, ['design', 'list', '--screen', 'Premiere visite', '--json'])).json().mockups.length, 1);
  assert.equal((await apv(f.repo, ['design', 'list', '--screen', 'agenda', '--json'])).json().mockups.length, 0);
  assert.match((await apv(f.repo, ['design', 'list', '--screen', 'agenda'])).stdout, /Aucune maquette validée pour l'écran/);
  assert.equal((await apv(f.repo, ['design', 'check'])).code, 0);
});

test('register refuses without the operator quote, with a qualified approval, or with a bad name or file', async t => {
  const f = project(t);
  const base = ['design', 'register', 'brouillons/tableau-v3.html', '--name', 'tableau'];
  for (const args of [base, [...base, '--quote', '   ']]) {
    const out = await apv(f.repo, args);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /--quote manquant/);
  }
  await assert.rejects(registerMockup(f.repo, { file: 'brouillons/tableau-v3.html', slug: 'tableau', quote: ' ' }), /n'invente jamais une approbation/);
  const partial = await apv(f.repo, [...base, '--quote', 'je valide sauf la couleur du bouton']);
  assert.equal(partial.code, 1);
  assert.match(partial.stderr, /DESIGN_QUOTE.*avec réserve/);
  for (const [name, pattern] of [['Tableau', /minuscules/], ['../x', /minuscules/], ['accueil-validee', /« validee » est ajouté/], ['a'.repeat(51), /trop long/]])
    assert.match((await apv(f.repo, ['design', 'register', 'brouillons/tableau-v3.html', '--name', name, '--quote', 'je valide'])).stderr, pattern, name);
  assert.match((await apv(f.repo, ['design', 'register', 'absent.html', '--name', 'x', '--quote', 'je valide'])).stderr, /introuvable/);
  write(f.repo, 'notes.txt', 'texte');
  assert.match((await apv(f.repo, ['design', 'register', 'notes.txt', '--name', 'x', '--quote', 'je valide'])).stderr, /fichier HTML/);
  assert.match((await apv(f.repo, ['design', 'register', 'brouillons/tableau-v3.html', '--quote', 'je valide'])).stderr, /--name manquant/);
  assert.match((await apv(f.repo, ['design', 'register', 'brouillons/tableau-v3.html', '--name', 'x', '--quote', 'je valide', '--artifact', 'javascript:alert(1)'])).stderr, /Adresse d'artefact invalide/);
  assert.equal((await apv(f.repo, ['design', 'bogus'])).code, 2);
  assert.equal((await apv(f.repo, ['design'])).code, 2);
  assert.ok(!existsSync(join(f.repo, 'docs/design')), 'nothing copied on refusal');
  assert.equal(JSON.parse(readFileSync(join(f.repo, '.apv/DECISIONS.json'), 'utf8')).decisions.length, 1, 'ledger untouched');
});

test('register refuses an uncommitted ledger and leaves no copied file behind', async t => {
  const f = project(t);
  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-1'), decision('D-2')] });
  const out = await apv(f.repo, ['design', 'register', 'brouillons/tableau-v3.html', '--name', 'tableau', '--quote', 'je valide']);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /LEDGER_DIRTY/);
  assert.ok(!existsSync(join(f.repo, 'docs/design/tableau-validee.html')));
});

test('check and list flag a validated mockup changed or removed without re-registration', async t => {
  const f = project(t);
  await registerMockup(f.repo, { file: 'brouillons/tableau-v3.html', slug: 'tableau', quote: 'je valide' });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'design');
  const target = join(f.repo, 'docs/design/tableau-validee.html');
  writeFileSync(target, HTML.replace('Tableau de bord', 'Tableau de bord modifié'));
  const check = await apv(f.repo, ['design', 'check']);
  assert.equal(check.code, 1);
  assert.match(check.stdout, new RegExp(`docs/design/tableau-validee\\.html \\(maquette-tableau-validee\\) : sha256 ${sha(readFileSync(target))} au lieu de ${sha(HTML)}`));
  assert.equal((await apv(f.repo, ['design', 'check', '--json'])).json().broken[0].state, 'drift');
  const list = await apv(f.repo, ['design', 'list']);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /MODIFIÉE/);
  assert.match(list.stdout, /Attention : 1 maquette/);
  git(f.repo, 'rm', '-q', '-f', 'docs/design/tableau-validee.html');
  assert.equal(listMockups(f.repo)[0].state, 'missing');
  assert.match((await apv(f.repo, ['design', 'check'])).stdout, /fichier absent/);
});

test('a re-registration supersedes the active decision; the same content is a no-op', async t => {
  const f = project(t);
  const first = await registerMockup(f.repo, { file: 'brouillons/tableau-v3.html', slug: 'tableau', quote: 'je valide', now: new Date('2026-09-22T10:00:00Z') });
  assert.equal(first.decisionId, 'maquette-tableau-validee');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'design');
  const again = await apv(f.repo, ['design', 'register', 'docs/design/tableau-validee.html', '--name', 'tableau', '--quote', 'je valide encore']);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /Déjà enregistrée/);
  write(f.repo, 'brouillons/tableau-v4.html', HTML.replace('Tableau', 'Tableau v4'));
  const second = await apv(f.repo, ['design', 'register', 'brouillons/tableau-v4.html', '--name', 'tableau', '--quote', 'c\'est bon, on garde', '--json']);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual([second.json().decisionId, second.json().supersedes], ['maquette-tableau-validee-v2', ['maquette-tableau-validee']]);
  const ids = JSON.parse(readFileSync(join(f.repo, '.apv/DECISIONS.json'), 'utf8')).decisions.map(d => d.id);
  assert.deepEqual(ids, ['D-1', 'maquette-tableau-validee-v2']);
  const [mockup] = listMockups(f.repo);
  assert.deepEqual([mockup.slug, mockup.version, mockup.state, mockup.sha256], ['tableau', 2, 'ok', sha256File(join(f.repo, 'brouillons/tableau-v4.html'))]);
});

test('design.dir, a V2 ledger and a legacy decision without hash', async t => {
  const legacy = decision('maquette-appli-validee', { value: 'La maquette validée, versée dans docs/design/appli-maquette-validee.html, est la référence.', sourceQuote: 'je valide les maquettes' });
  const f = fixture(t, { files: { '.agent-pipeline/DECISIONS.json': `${JSON.stringify({ schemaVersion: 1, decisions: [legacy] })}\n`, 'v.html': HTML,
    '.apv/config.json': JSON.stringify({ design: { dir: 'maquettes/validees/' } }) } });
  assert.equal(loadDesignConfig(f.repo).dir, 'maquettes/validees');
  const check = await apv(f.repo, ['design', 'check']);
  assert.equal(check.code, 0);
  assert.match(check.stdout, /Non vérifiable.*maquette-appli-validee/);
  assert.equal((await apv(f.repo, ['design', 'list', '--json'])).json().mockups[0].state, 'legacy');
  const out = await apv(f.repo, ['design', 'register', 'v.html', '--name', 'appli', '--quote', 'je valide les maquettes', '--json']);
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual([out.json().target, out.json().ledgerFile, out.json().decisionId, out.json().supersedes],
    ['maquettes/validees/appli-validee.html', '.agent-pipeline/DECISIONS.json', 'maquette-appli-validee-v2', ['maquette-appli-validee']]);
  assert.ok(existsSync(join(f.repo, 'maquettes/validees/appli-validee.html')));
  for (const [dir, pattern] of [['../dehors', /dossier relatif/], ['/tmp', /dossier relatif/], ['', /non vide/], ['a b', /espace/]]) {
    write(f.repo, '.apv/config.json', { design: { dir } });
    assert.throws(() => loadDesignConfig(f.repo), pattern, dir);
  }
  write(f.repo, '.apv/config.json', { design: { dossier: 'x' } });
  assert.throws(() => loadDesignConfig(f.repo), /unknown property dossier/);
  write(f.repo, '.apv/config.json', '{');
  assert.throws(() => loadDesignConfig(f.repo), /Invalid JSON/);
});

test('screen matching ignores case, accents and separators', () => {
  const m = { slug: 'fiche', screens: ['Première visite', 'tableau de bord'] };
  assert.ok(matchesScreen(m, 'fiche'));
  assert.ok(matchesScreen(m, 'premiere-visite'));
  assert.ok(matchesScreen(m, 'Tableau_de_bord'));
  assert.ok(!matchesScreen(m, 'agenda'));
});

test('apv help lists the design command', async () => {
  const help = await apv(process.cwd(), ['help']);
  assert.match(help.stdout, /apv design register\|list\|check/);
  const own = await apv(process.cwd(), ['help', 'design']);
  assert.equal(own.code, 0);
  assert.match(own.stdout, /--quote/);
});

test('register keeps validated mockups out of git diff --check: .gitattributes line added once, to commit', async t => {
  const SPACED = '<!doctype html>\n<html lang="fr">  \n<body>Accueil\t\n</body></html>\n';
  const f = project(t, [decision('D-1')], { 'brouillons/accueil.html': SPACED, '.gitattributes': '*.png binary' });
  const out = await apv(f.repo, ['design', 'register', 'brouillons/accueil.html', '--name', 'accueil', '--quote', 'je valide l\'accueil', '--json']);
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(out.json().attributes, { file: '.gitattributes', line: 'docs/design/*.html -whitespace', status: 'added' });
  assert.deepEqual(out.json().toCommit, ['docs/design/accueil-validee.html', '.apv/DECISIONS.json', '.apv/DECISIONS.md', '.gitattributes']);
  const attributes = readFileSync(join(f.repo, '.gitattributes'), 'utf8');
  assert.match(attributes, /^\*\.png binary\n# Maquettes validées[^\n]*\ndocs\/design\/\*\.html -whitespace\n$/);
  assert.ok(!/[–—]/.test(attributes));
  assert.equal(git(f.repo, 'check-attr', 'whitespace', '--', 'docs/design/accueil-validee.html'), 'docs/design/accueil-validee.html: whitespace: unset');
  // What the projects' diff-check gate runs: the mockup with its trailing spaces passes.
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'maquette');
  git(f.repo, 'diff', '--check', 'HEAD~1', 'HEAD');
  assert.equal((await apv(f.repo, ['design', 'check'])).code, 0);
  // Present: never added twice, nothing more to commit.
  const again = await apv(f.repo, ['design', 'register', 'brouillons/accueil.html', '--name', 'accueil', '--quote', 'je valide l\'accueil', '--json']);
  assert.deepEqual([again.json().unchanged, again.json().attributes.status, again.json().toCommit], [true, 'present', []]);
  assert.equal(readFileSync(join(f.repo, '.gitattributes'), 'utf8'), attributes);
});

test('register adds the line for a project registered before it, with a custom design.dir; human output names it', async t => {
  const f = project(t, [decision('D-1')], { '.apv/config.json': '{ "name": "demo", "design": { "dir": "maquettes/validees" } }\n' });
  const out = await apv(f.repo, ['design', 'register', 'brouillons/tableau-v3.html', '--name', 'tableau', '--quote', 'je valide']);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /\.gitattributes : ligne « maquettes\/validees\/\*\.html -whitespace » ajoutée/);
  assert.match(out.stdout, /git add -- maquettes\/validees\/tableau-validee\.html \.apv\/DECISIONS\.json \.apv\/DECISIONS\.md \.gitattributes/);
  // Removed afterwards (the pilot's situation before its manual fix): the same registration puts it back.
  writeFileSync(join(f.repo, '.gitattributes'), '');
  const unchanged = await apv(f.repo, ['design', 'register', 'brouillons/tableau-v3.html', '--name', 'tableau', '--quote', 'je valide']);
  assert.match(unchanged.stdout, /Déjà enregistrée[\s\S]*ligne « maquettes\/validees\/\*\.html -whitespace » ajoutée[\s\S]*À commiter : git add -- \.gitattributes/);
});

test('design check reports a missing .gitattributes line, and fails when a validated mockup has trailing whitespace', async t => {
  const f = project(t, [decision('D-1')], { 'brouillons/propre.html': HTML, 'brouillons/espaces.html': '<p>fin</p>  \n' });
  assert.equal((await apv(f.repo, ['design', 'register', 'brouillons/propre.html', '--name', 'propre', '--quote', 'je valide'])).code, 0);
  writeFileSync(join(f.repo, '.gitattributes'), '');
  const clean = await apv(f.repo, ['design', 'check']);
  assert.equal(clean.code, 0, 'no trailing whitespace: reported only');
  assert.match(clean.stdout, /Attention : \.gitattributes ne contient pas « docs\/design\/\*\.html -whitespace »/);
  assert.equal((await apv(f.repo, ['design', 'check', '--json'])).json().attributes.status, 'missing');
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'propre');
  assert.equal((await apv(f.repo, ['design', 'register', 'brouillons/espaces.html', '--name', 'espaces', '--quote', 'je valide'])).code, 0);
  writeFileSync(join(f.repo, '.gitattributes'), '');
  const broken = await apv(f.repo, ['design', 'check', '--json']);
  assert.equal(broken.code, 1);
  assert.deepEqual([broken.json().attributes.whitespace, broken.json().attributes.blocking], [['docs/design/espaces-validee.html'], true]);
  assert.match((await apv(f.repo, ['design', 'check'])).stdout, /Erreur : [^\n]*espaces-validee\.html porte\(nt\) des espaces de fin de ligne : git diff --check échoue/);
  // A project without mockups nor folder: nothing to say.
  const bare = project(t);
  const none = await apv(bare.repo, ['design', 'check', '--json']);
  assert.deepEqual([none.code, none.json().attributes.status], [0, 'not-applicable']);
});

test('register --scope gives the mockup decision a perimeter, kept by a re-registration without --scope', async t => {
  const f = project(t);
  const out = await apv(f.repo, ['design', 'register', 'brouillons/tableau-v3.html', '--name', 'accueil', '--quote', 'je valide', '--scope', 'src/routes/(accueil)/**, src/lib/accueil/**']);
  assert.equal(out.code, 0, out.stderr);
  const scopeOf = id => JSON.parse(readFileSync(join(f.repo, '.apv/DECISIONS.json'), 'utf8')).decisions.find(d => d.id === id)?.scope;
  assert.deepEqual(scopeOf('maquette-accueil-validee'), { paths: ['src/routes/(accueil)/**', 'src/lib/accueil/**'] });
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'maquette');
  writeFileSync(join(f.repo, 'brouillons/tableau-v3.html'), HTML.replace('Tableau de bord', 'Accueil'));
  assert.equal((await apv(f.repo, ['design', 'register', 'brouillons/tableau-v3.html', '--name', 'accueil', '--quote', 'je valide'])).code, 0);
  assert.deepEqual(scopeOf('maquette-accueil-validee-v2'), { paths: ['src/routes/(accueil)/**', 'src/lib/accueil/**'] });
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'v2');
  // Same file, new scope: a new registration (the scope is part of the decision).
  const rescoped = await apv(f.repo, ['design', 'register', 'brouillons/tableau-v3.html', '--name', 'accueil', '--quote', 'je valide', '--scope', 'src/routes/**', '--json']);
  assert.deepEqual([rescoped.json().unchanged, rescoped.json().decisionId], [false, 'maquette-accueil-validee-v3']);
  assert.deepEqual(scopeOf('maquette-accueil-validee-v3'), { paths: ['src/routes/**'] });
  assert.equal((await apv(f.repo, ['design', 'list', '--scope', 'x'])).code, 2);
});
