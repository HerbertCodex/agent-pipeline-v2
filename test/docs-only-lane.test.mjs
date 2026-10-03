import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apv } from './cli-helpers.mjs';
import { operatorSays, seedReview } from './support/rules.mjs';
import { checkMergeRules } from '../dist/rules/check.js';

/**
 * The lane without code (« voie sans code », src/rules/docs-only.ts, docs/REGLES.md). Pilot project, 4 October 2026: a
 * pull request of the decision ledger, four validated mockups registered with their fingerprint and the pipeline
 * journal was asked for a full suite and four reviews. The lane is decided by the tool from the diff: every file of a
 * closed list, the mockups at the fingerprint of their decision, every mockup decision brought anchored in the
 * operator's words. One file outside, a mockup changed without a new decision, the configuration changed: normal rules.
 */

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim();
const put = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };
const sha256 = text => createHash('sha256').update(text).digest('hex');
const node = code => [process.execPath, '-e', code];

const QUOTE = 'Je valide la maquette des articles, on part là-dessus';
const MOCKUP = 'docs/design/produit/articles-validee.html';
const HTML = '<!doctype html><title>Articles</title><h1>Articles</h1>\n';
const decision = (file, html, extra = {}) => ({ id: 'maquette-articles-validee', subject: 'Maquette validée : articles', value: `Maquette validée, fichier ${file}, sha256 ${sha256(html)}. Écrans : articles.`,
  enforcement: 'product', status: 'confirmed', source: 'operator', sourceQuote: QUOTE, rationale: 'Validée par l\'opérateur.', supersedes: [], clarificationQuestion: '', interpretations: [], ...extra });
const ledger = (...decisions) => ({ schemaVersion: 1, decisions });

/** The pull request of the pilot project, generic: ledger, validated mockup, draft, spec, journal, state, documentation. */
const LANE = {
  '.apv/DECISIONS.json': ledger(decision(MOCKUP, HTML)),
  '.apv/DECISIONS.md': '# Décisions\n\n- maquette-articles-validee\n',
  [MOCKUP]: HTML,
  'docs/design/brouillons/articles-v2.html': '<p>brouillon</p>\n',
  '.apv/specs/articles.json': { id: 'articles', title: 'Articles' },
  '.apv/journal-pipeline.md': '# Journal\n\n- une PR sans code a coûté quatre relectures\n',
  '.apv/state/design-articles.md': '# Design\n\nVersion 2 validée.\n',
  'docs/guide.md': '# Guide\n\nUne section de plus.\n',
};

function project(t, { base = {}, change = {}, executable = [], gates = [{ id: 'unit', stage: 'full', command: node('0') }], config = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apv3-lane-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(root, 'repo');
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'switch', '-q', '-c', 'main');
  put(repo, '.apv/config.json', { name: 'essai', gates, ...config });
  put(repo, 'README.md', 'projet\n');
  for (const [path, value] of Object.entries(base)) put(repo, path, value);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'switch', '-q', '-c', 'feat');
  for (const [path, value] of Object.entries(change)) put(repo, path, value);
  git(repo, 'add', '-A');
  for (const path of executable) git(repo, 'update-index', '--chmod=+x', path);
  git(repo, 'commit', '-qm', 'change', '--allow-empty'); git(repo, 'push', '-q', 'origin', 'feat');
  const head = git(repo, 'rev-parse', 'HEAD');
  return {
    repo, head,
    check: async () => { const r = await apv(repo, ['rules', 'check', '--commit', head, '--target', 'origin/main', '--json']); return { ...r, report: r.json() }; },
    text: async () => (await apv(repo, ['rules', 'check', '--commit', head, '--target', 'origin/main'])).stdout,
    plan: async (...extra) => { const r = await apv(repo, ['review', 'plan', '--base', 'origin/main', '--json', ...extra]); assert.equal(r.code, 0, r.stderr); return r.json(); },
    planText: async () => (await apv(repo, ['review', 'plan', '--base', 'origin/main'])).stdout,
    prove: async () => { const r = await apv(repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/main', '--json']); assert.equal(r.code, 0, r.stdout + r.stderr); },
  };
}
const rule = (report, id) => report.rules.find(r => r.rule === id);

test('voie sans code: ledger, validated mockup at its fingerprint, draft, spec, journal, state and docs: no review, no capture, the proof of the checks that apply', async t => {
  const p = project(t, { change: LANE });
  operatorSays(p.repo, `Parfait. ${QUOTE}.`);
  const before = await p.check();
  assert.equal(before.report.lane.eligible, true, JSON.stringify(before.report.lane));
  assert.deepEqual(before.report.lane.files.map(f => f.kind).sort(), ['decisions', 'decisions', 'docs', 'drafts', 'journal', 'mockups', 'specs', 'state']);
  assert.equal(rule(before.report, 'relecture').status, 'not_applicable');
  assert.match(rule(before.report, 'relecture').detail, /^voie sans code : 8 fichier\(s\), aucun de code/);
  assert.equal(rule(before.report, 'captures').status, 'not_applicable');
  assert.match(rule(before.report, 'captures').detail, /voie sans code/);
  // A check without skipWhenOnly applies: the full suite at the exact commit is still the proof.
  assert.equal(rule(before.report, 'preuve').status, 'refused');
  await p.prove();
  const after = await p.check();
  assert.equal(after.code, 0, JSON.stringify(after.report.rules));
  assert.equal(after.report.ok, true);
  const text = await p.text();
  assert.match(text, /Voie sans code : RETENUE : 8 fichier\(s\), aucun de code : .*Fichiers qui l'ont permise :/);
  assert.match(text, /docs\/design\/produit\/articles-validee\.html \(maquette validée\)/);
  assert.match(text, /- relecture .*: sans objet : voie sans code/);
  // The review plan says it too, and retains nothing (securite included), unless forced.
  const plan = await p.plan();
  assert.equal(plan.lane.eligible, true);
  assert.deepEqual(plan.retained, []);
  assert.match(plan.skipped.find(s => s.domain === 'securite').reason, /^voie sans code : /);
  assert.deepEqual((await p.plan('--force', 'securite')).retained, ['securite']);
  assert.match(await p.planText(), /^Voie sans code : RETENUE/m);
});

test('voie sans code: when every check of the suite is not required by its scope, there is no proof to run', async t => {
  const scoped = [{ id: 'unit', stage: 'full', command: node('process.exit(1)'),
    skipWhenOnly: { paths: ['docs/**', '**/*.md', '.apv/specs/**', '.apv/state/**', '.apv/DECISIONS.*'], except: ['src/**', 'static/**', 'public/**', 'content/**'], reference: 'origin/main' } }];
  const p = project(t, { gates: scoped, change: { 'docs/guide.md': '# Guide\n', '.apv/specs/a.json': { id: 'a' }, '.apv/journal-pipeline.md': '# Journal\n' } });
  const r = await p.check();
  assert.equal(r.report.lane.eligible, true, JSON.stringify(r.report.lane));
  assert.equal(rule(r.report, 'preuve').status, 'not_applicable', JSON.stringify(rule(r.report, 'preuve')));
  assert.match(rule(r.report, 'preuve').detail, /voie sans code : aucun contrôle ne s'applique.*: unit$/);
  assert.equal(rule(r.report, 'instable').status, 'not_applicable');
  assert.equal(r.code, 0, JSON.stringify(r.report.rules));
  // A mockup is always an input of the checks (proof-scope): in the lane, the suite applies again.
  const m = project(t, { gates: scoped, change: LANE });
  operatorSays(m.repo, QUOTE);
  const withMockup = await m.check();
  assert.equal(withMockup.report.lane.eligible, true);
  assert.equal(rule(withMockup.report, 'preuve').status, 'refused');
});

test('voie sans code: a single file of code takes the change out of the lane, with every rule as before', async t => {
  const p = project(t, { change: { ...LANE, 'src/lib/util.ts': 'export const x = 1;\n' } });
  operatorSays(p.repo, QUOTE);
  const r = await p.check();
  assert.equal(r.report.lane.eligible, false);
  assert.deepEqual(r.report.lane.blocking.map(b => b.path), ['src/lib/util.ts']);
  assert.match(r.report.lane.reason, /src\/lib\/util\.ts : hors de la liste de la voie sans code/);
  assert.equal(rule(r.report, 'relecture').status, 'refused');
  assert.match(rule(r.report, 'relecture').problems.join('\n'), /securite : aucune relecture enregistrée/);
  assert.match(await p.text(), /Voie sans code : non retenue \(1 fichier\(s\) hors de la voie, dont src\/lib\/util\.ts/);
  const plan = await p.plan();
  assert.equal(plan.lane.eligible, false);
  assert.ok(plan.retained.includes('securite'));
});

test('voie sans code: a validated mockup changed without a new decision keeps the normal rules (securite, fidelite, captures)', async t => {
  const p = project(t, { base: { '.apv/DECISIONS.json': ledger(decision(MOCKUP, HTML)), [MOCKUP]: HTML },
    change: { [MOCKUP]: '<!doctype html><title>Articles</title><h1>Autre chose</h1>\n' } });
  const r = await p.check();
  assert.equal(r.report.lane.eligible, false);
  assert.match(r.report.lane.blocking[0].why, /différente de celle de maquette-articles-validee .*maquette modifiée sans nouvelle décision/);
  assert.match(rule(r.report, 'relecture').detail, /securite, fidelite/);
  assert.equal(rule(r.report, 'captures').status, 'refused');
  // A new decision with the new fingerprint, but whose quote the operator never typed: still out of the lane.
  const changed = '<!doctype html><title>Articles</title><h1>Version 2</h1>\n';
  const q = project(t, { base: { '.apv/DECISIONS.json': ledger(decision(MOCKUP, HTML)), [MOCKUP]: HTML },
    change: { [MOCKUP]: changed, '.apv/DECISIONS.json': ledger(decision(MOCKUP, changed, { sourceQuote: 'Je valide la version deux des articles, merci' })) } });
  const unanchored = await q.check();
  assert.equal(unanchored.report.lane.eligible, false);
  assert.match(unanchored.report.lane.reason, /sa citation n'est pas dans les messages de l'opérateur/);
  // Once the operator typed it: the lane.
  operatorSays(q.repo, 'Je valide la version deux des articles, merci');
  assert.equal((await q.check()).report.lane.eligible, true);
});

test('voie sans code: a mockup decision brought by an agent alone, or a deleted mockup, never takes the lane', async t => {
  // The ledger alone: a decision merged becomes the base the rule maquette trusts.
  const p = project(t, { change: { '.apv/DECISIONS.json': ledger(decision('docs/design/x.html', 'x')) } });
  assert.match((await p.check()).report.lane.reason, /maquette-articles-validee ajoutée ou modifiée : sa citation n'est pas dans les messages/);
  const d = project(t, { base: { '.apv/DECISIONS.json': ledger(decision(MOCKUP, HTML)), [MOCKUP]: HTML } });
  git(d.repo, 'rm', '-q', MOCKUP); git(d.repo, 'commit', '-qm', 'suppression');
  const head = git(d.repo, 'rev-parse', 'HEAD');
  const r = (await apv(d.repo, ['rules', 'check', '--commit', head, '--target', 'origin/main', '--json'])).json();
  assert.equal(r.lane.eligible, false);
  assert.match(r.lane.reason, /maquette validée supprimé\(e\)/);
});

test('voie sans code: the configuration, an executable or a script in the state, a word of GDPR in a document keep the normal rules', async t => {
  for (const [change, executable, why] of [
    [{ '.apv/config.json': { name: 'essai', gates: [{ id: 'unit', stage: 'full', command: node('0') }], review: { always: [] } } }, [], /\.apv\/config\.json : configuration/],
    [{ '.apv/state/relance.md': '# x\n' }, ['.apv/state/relance.md'], /mode 100644 -> 100755|ajouté en mode 100755/],
    [{ '.apv/state/relance.sh': 'echo x\n' }, [], /script sous \.apv\/state/],
    [{ 'docs/guide.md': '# Guide\n\nLes données sont hébergées en France.\n' }, [], /docs\/guide\.md : hors de la liste/],
    [{ 'CLAUDE.md': '# Consigne\n' }, [], /CLAUDE\.md : chemin sensible ou instructions des agents/],
    [{ 'src/routes/blog/+page.md': '# Article\n' }, [], /hors de la liste/],
    [{ '.apv/brief.md': '# Brief\n' }, [], /chemin sensible ou instructions des agents/],
  ]) {
    const p = project(t, { change, executable });
    const r = await p.check();
    assert.equal(r.report.lane.eligible, false, JSON.stringify(change));
    assert.match(r.report.lane.reason, why, r.report.lane.reason);
    assert.equal(rule(r.report, 'relecture').status, 'refused', JSON.stringify(change));
  }
});

test('voie sans code: the project narrows it at the base (enabled, kinds, exclude, review.always), never the change', async t => {
  const off = project(t, { config: { rules: { docsOnly: { enabled: false } } }, change: { 'docs/guide.md': '# Guide\n' } });
  assert.match((await off.check()).report.lane.reason, /désactivée par rules\.docsOnly\.enabled/);
  const kinds = project(t, { config: { rules: { docsOnly: { kinds: ['specs'] } } }, change: { 'docs/guide.md': '# Guide\n' } });
  assert.match((await kinds.check()).report.lane.reason, /documentation : type retiré de la voie par rules\.docsOnly\.kinds/);
  const excluded = project(t, { config: { rules: { docsOnly: { exclude: ['docs/**'] } } }, change: { 'docs/guide.md': '# Guide\n' } });
  assert.match((await excluded.check()).report.lane.reason, /exclu par rules\.docsOnly\.exclude/);
  // review.always keeps its domains in the lane.
  const always = project(t, { config: { review: { always: ['securite'] } }, change: { 'docs/guide.md': '# Guide\n' } });
  const a = await always.check();
  assert.equal(a.report.lane.eligible, true);
  assert.equal(rule(a.report, 'relecture').status, 'refused');
  assert.match(rule(a.report, 'relecture').detail, /voie sans code, domaines forcés par review\.always\) : securite/);
  seedReview(always.repo, always.head, 'securite');
  assert.equal(rule((await always.check()).report, 'relecture').status, 'ok');
  // The change switching the lane on for itself: read at the base, refused.
  const self = project(t, { config: { rules: { docsOnly: { enabled: false } } }, change: { 'docs/guide.md': '# Guide\n', '.apv/config.json': { name: 'essai', gates: [{ id: 'unit', stage: 'full', command: node('0') }] } } });
  assert.equal((await self.check()).report.lane.eligible, false);
});

test('voie sans code in a batch: the rules of each pull request, proof left to the batch, hold without any review', async t => {
  const p = project(t, { change: { 'docs/guide.md': '# Guide\n', '.apv/journal-pipeline.md': '# Journal\n' } });
  const report = await checkMergeRules({ repo: p.repo, commit: p.head, target: 'origin/main', skip: ['preuve', 'instable'] });
  assert.equal(report.lane.eligible, true);
  assert.equal(report.ok, true, JSON.stringify(report.rules));
  assert.deepEqual(report.rules.map(r => [r.rule, r.status]), [['preuve', 'not_applicable'], ['instable', 'not_applicable'], ['relecture', 'not_applicable'],
    ['captures', 'not_applicable'], ['controles', 'not_applicable'], ['maquette', 'not_applicable']]);
  // The same batch with a file of code: the review is required again.
  const q = project(t, { change: { 'docs/guide.md': '# Guide\n', 'lib/x.js': 'export {};\n' } });
  const code = await checkMergeRules({ repo: q.repo, commit: q.head, target: 'origin/main', skip: ['preuve', 'instable'] });
  assert.equal(code.ok, false);
  assert.equal(code.rules.find(r => r.rule === 'relecture').status, 'refused');
});
