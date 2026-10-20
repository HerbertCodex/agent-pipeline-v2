import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apv } from './cli-helpers.mjs';
import { operatorSays } from './support/rules.mjs';
import { DOMAIN, git, orderConfig, signer } from './support/orders.mjs';
import { configIssues } from '../dist/config/load.js';
import { operatorOrdersLine, reducedProofPrint } from '../dist/orders/config.js';
import { checkMergeRules } from '../dist/rules/check.js';

/**
 * Reduced proof for the merges on a signed order (docs/PREUVE-REDUITE.md, rules.operatorOrders.reducedProof). Phase 1:
 * the declaration (loader, section 4.1), its line in apv status (4.2) and the anchored decision of the operator that any
 * addition or widening requires (4.3, finding E1 of the security review). Each refusal was seen red before its code.
 */

const WORKFLOW = '.github/workflows/preuve-publication.yml';
const NAME = 'Preuve de publication';
const ok0 = [process.execPath, '-e', '0'];
/** The checks of the project: those the reduced job runs, those it lifts, one it neither runs nor lifts, and the checks APV requires. */
const GATES = [
  { id: 'check', stage: 'full', command: ok0 },
  { id: 'test', stage: 'full', command: ok0 },
  { id: 'integration', stage: 'full', command: ok0 },
  { id: 'browser', stage: 'full', command: ok0 },
  { id: 'reuse', stage: 'task', command: ['apv', 'reuse', 'check'], mandatory: true },
  { id: 'lint-maison', stage: 'full', command: ['node', '/opt/apv/dist/cli.js', 'structure', 'check'] },
  { id: 'a11y', stage: 'full', command: ['npm', 'run', 'check:a11y'] },
];
const PATHS = { publication: ['content/guides/{slug}.ts', 'content/catalog.ts', 'styles/{slug}.css'], article: ['docs/articles/{slug}/proposition.json'] };
const declaration = (extra = {}) => ({
  workflow: WORKFLOW, job: 'preuve-publication', name: NAME, gates: ['check', 'test'], waives: ['integration', 'browser'],
  covers: 'typecheck, tests unitaires, bout en bout des guides contre un aperçu du commit',
  paths: { publication: ['content/guides/{slug}.ts', 'content/catalog.ts'], article: ['docs/articles/{slug}/proposition.json'] },
  ...extra,
});
/** Checks that run here (node), for the projects whose rules are checked: no command of the tool, none that fails. */
const LOCAL_GATES = ['check', 'test', 'integration', 'browser', 'a11y'].map(id => ({ id, stage: 'full', command: ok0 }));
const configWith = (pem, reducedProof, { gates = GATES, required = true } = {}) => {
  const c = orderConfig(pem, { paths: PATHS, ...(reducedProof ? { reducedProof } : {}) });
  return { name: 'essai', gates, ...c, rules: { ...c.rules, ...(required ? { requiredGates: [{ id: 'a11y-requis', command: ['npm', 'run', 'check:a11y'] }] } : {}) } };
};
const localConfig = (pem, reducedProof) => configWith(pem, reducedProof, { gates: LOCAL_GATES, required: false });
const issuesOf = config => configIssues(config).issues.map(i => i.message).join('\n');

// ---------------------------------------------------------------------------------------------------------------------
// 4.1 The loader.

test('déclaration : une déclaration valide est acceptée ; sans reducedProof, rien ne change', () => {
  const s = signer();
  assert.equal(issuesOf(configWith(s.pem, declaration())), '');
  const parsed = configIssues(configWith(s.pem, declaration())).config.rules.operatorOrders.reducedProof;
  assert.deepEqual(parsed.waives, ['integration', 'browser']);
  assert.equal(configIssues(configWith(s.pem, null)).config.rules.operatorOrders.reducedProof, undefined);
});

test('déclaration : gates et waives qui se recoupent, identifiant absent des contrôles déclarés, refusés', () => {
  const s = signer();
  assert.match(issuesOf(configWith(s.pem, declaration({ waives: ['integration', 'test'] }))), /reducedProof : test à la fois dans gates et dans waives/);
  assert.match(issuesOf(configWith(s.pem, declaration({ gates: ['check', 'inconnu'] }))), /reducedProof\.gates : inconnu n'est pas un contrôle déclaré/);
  assert.match(issuesOf(configWith(s.pem, declaration({ waives: ['fantome'] }))), /reducedProof\.waives : fantome n'est pas un contrôle déclaré/);
});

test('déclaration (F1) : un contrôle exigé par APV ne se lève jamais, reconnu par son identifiant ou par sa commande', () => {
  const s = signer();
  assert.match(issuesOf(configWith(s.pem, declaration({ waives: ['integration', 'reuse'] }))), /reducedProof\.waives : reuse est un contrôle exigé par APV/);
  // Another id, the command of apv structure check through a launcher.
  assert.match(issuesOf(configWith(s.pem, declaration({ waives: ['integration', 'lint-maison'] }))), /reducedProof\.waives : lint-maison lance un contrôle exigé \(structure : apv structure check\)/);
  // The command of a check of rules.requiredGates.
  assert.match(issuesOf(configWith(s.pem, declaration({ waives: ['integration', 'a11y'] }))), /reducedProof\.waives : a11y lance un contrôle exigé \(a11y-requis : npm run check:a11y\)/);
});

test('déclaration : workflow ou nom égal à celui de rules.ciProof refusé (une preuve ne se lit jamais pour l\'autre)', () => {
  const s = signer();
  const ciProof = { workflow: '.github/workflows/preuve.yml', job: 'preuve-complete', name: 'Preuve complète', gates: ['integration'] };
  const withCi = rp => { const c = configWith(s.pem, rp); c.rules.ciProof = ciProof; return c; };
  assert.equal(issuesOf(withCi(declaration())), '');
  assert.match(issuesOf(withCi(declaration({ workflow: '.github/workflows/preuve.yml' }))), /reducedProof\.workflow : celui de rules\.ciProof/);
  assert.match(issuesOf(withCi(declaration({ name: 'Preuve complète' }))), /reducedProof\.name : celui de rules\.ciProof/);
});

test('déclaration (F3) : chemins littéraux, motifs recopiés de rules.operatorOrders.paths, aucune étape vide', () => {
  const s = signer();
  const paths = p => issuesOf(configWith(s.pem, declaration({ paths: p })));
  assert.match(paths({ publication: ['content/guides/{slug}.tsx'] }), /reducedProof\.paths\.publication : content\/guides\/\{slug\}\.tsx n'est pas un motif de rules\.operatorOrders\.paths\.publication/);
  assert.match(paths({ publication: ['content/**'] }), /reducedProof\.paths\.publication : \*, \? et \*\* refusés dans content\/\*\*/);
  assert.match(paths({ publication: ['content/*.ts'] }), /\*, \? et \*\* refusés dans content\/\*\.ts/);
  assert.match(paths({ article: ['docs/articles/?/proposition.json'] }), /\*, \? et \*\* refusés/);
  assert.match(paths({}), /reducedProof\.paths : au moins une étape/);
  assert.match(paths({ publication: [] }), /paths/);
  // Without rules.operatorOrders.paths, nothing to compare with.
  const c = configWith(s.pem, declaration());
  delete c.rules.operatorOrders.paths;
  assert.match(issuesOf(c), /reducedProof : rules\.operatorOrders\.paths absent/);
});

test('déclaration : protectedPaths qui couvre un chemin de contenu refusé', () => {
  const s = signer();
  assert.match(issuesOf(configWith(s.pem, declaration({ protectedPaths: ['content/**'] }))), /reducedProof\.protectedPaths : content\/\*\* couvre le chemin de contenu content\/guides\/\{slug\}\.ts/);
  assert.equal(issuesOf(configWith(s.pem, declaration({ protectedPaths: ['tests/e2e/guides/**'] }))), '');
});

// ---------------------------------------------------------------------------------------------------------------------
// 4.2 apv status.

test('apv status : la ligne des ordres signés dit la preuve réduite ; sans elle, la ligne d\'aujourd\'hui', () => {
  const s = signer();
  const without = configIssues(configWith(s.pem, null)).config.rules.operatorOrders;
  assert.doesNotMatch(operatorOrdersLine(without), /preuve réduite/);
  const line = operatorOrdersLine(configIssues(configWith(s.pem, declaration())).config.rules.operatorOrders);
  assert.match(line, new RegExp(`^Ordres signés \\(rules.operatorOrders\\) : domaine ${DOMAIN}`));
  assert.match(line, /preuve réduite : \.github\/workflows\/preuve-publication\.yml, job preuve-publication « Preuve de publication » ; prouvés : check, test ; levés : integration, browser ; chemins : publication content\/guides\/\{slug\}\.ts, content\/catalog\.ts ; article docs\/articles\/\{slug\}\/proposition\.json/);
});

// ---------------------------------------------------------------------------------------------------------------------
// 4.3 Addition or widening: an anchored decision of the operator (E1).

const put = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };

/** An origin and a clone: main holds `baseConfig`, the branch feat changes `.apv/config.json` to `headConfig` and the ledger to `ledger`. */
function configProject(t, { baseConfig, headConfig, ledger = null, baseFiles = {}, headFiles = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'apv3-preuve-reduite-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(root, 'repo');
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'switch', '-q', '-c', 'main');
  put(repo, '.apv/config.json', baseConfig);
  put(repo, 'README.md', 'projet\n');
  for (const [path, text] of Object.entries(baseFiles)) put(repo, path, text);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'switch', '-q', '-c', 'feat');
  put(repo, '.apv/config.json', headConfig);
  if (ledger) put(repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: ledger });
  for (const [path, text] of Object.entries(headFiles)) put(repo, path, text);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'déclaration'); git(repo, 'push', '-q', 'origin', 'feat');
  return { repo, head: git(repo, 'rev-parse', 'HEAD') };
}

/** Only the checks needed by the configuration PR: proven locally, so that the rule preuve judges the declaration alone. */
const proven = async p => { const r = await apv(p.repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/main', '--json']); assert.equal(r.code, 0, r.stdout + r.stderr); };
const preuveOf = async (p, extra = {}) => (await checkMergeRules({ repo: p.repo, commit: p.head, target: 'origin/main', remote: { strict: true }, ci: { gh: null }, ...extra })).rules.find(r => r.rule === 'preuve');
const text = r => [r.detail, ...r.problems, ...r.todo].join('\n');
const decision = (quote, extra = {}) => ({ id: 'preuve-reduite-publication', subject: 'rules.operatorOrders.reducedProof', value: 'Preuve réduite pour les fusions sur ordre',
  enforcement: 'product', status: 'confirmed', source: 'operator', sourceQuote: quote, rationale: 'Minutes de GitHub Actions', ...extra });

test('E1 : une PR qui ajoute reducedProof sans décision de l\'opérateur ancrée fait refuser preuve, avec l\'empreinte et la phrase à taper', async t => {
  const s = signer();
  const p = configProject(t, { baseConfig: localConfig(s.pem, null), headConfig: localConfig(s.pem, declaration()) });
  await proven(p);
  const preuve = await preuveOf(p);
  assert.equal(preuve.status, 'refused', text(preuve));
  const print = reducedProofPrint(configIssues(localConfig(s.pem, declaration())).config.rules.operatorOrders.reducedProof, null);
  assert.match(print, /^[0-9a-f]{12}$/);
  assert.match(text(preuve), new RegExp(`déclaration de preuve réduite élargie sans décision de l'opérateur ancrée \\(déclaration ajoutée\\) ; empreinte ${print}`));
  // M-A1: the sentence is never printed filled in (a pasted output never holds it): the template, and the fingerprint apart.
  assert.match(text(preuve), new RegExp(`« Je valide la preuve réduite <empreinte> pour les fusions sur ordre\\. », où <empreinte> vaut ${print}`));
  assert.doesNotMatch(text(preuve), new RegExp(`Je valide la preuve réduite ${print}`));
});

test('E1 : une décision écrite par l\'agent seul, ou une citation ancrée sans l\'empreinte, ne comptent pas ; une citation ancrée qui la porte, oui', async t => {
  const s = signer();
  const decl = declaration();
  const print = reducedProofPrint(configIssues(localConfig(s.pem, decl)).config.rules.operatorOrders.reducedProof, null);
  const quote = `Je valide la preuve réduite ${print} pour les fusions sur ordre.`;
  // Written in the ledger by the agent: the operator never typed it.
  const agent = configProject(t, { baseConfig: localConfig(s.pem, null), headConfig: localConfig(s.pem, decl), ledger: [decision(quote)] });
  await proven(agent);
  assert.equal((await preuveOf(agent)).status, 'refused');
  // Typed by the operator, without the fingerprint: an old sentence reused for a new declaration.
  const vague = configProject(t, { baseConfig: localConfig(s.pem, null), headConfig: localConfig(s.pem, decl), ledger: [decision('Je valide la preuve réduite pour les articles.')] });
  operatorSays(vague.repo, 'Je valide la preuve réduite pour les articles.');
  await proven(vague);
  const refusedVague = await preuveOf(vague);
  assert.equal(refusedVague.status, 'refused');
  assert.match(text(refusedVague), /sans décision de l'opérateur ancrée/);
  // Typed by the operator, with the fingerprint, and versed by the agent with that quote.
  const anchored = configProject(t, { baseConfig: localConfig(s.pem, null), headConfig: localConfig(s.pem, decl), ledger: [decision(quote)] });
  operatorSays(anchored.repo, quote);
  await proven(anchored);
  const preuve = await preuveOf(anchored);
  assert.equal(preuve.status, 'ok', text(preuve));
  assert.match(preuve.detail, new RegExp(`preuve réduite élargie \\(déclaration ajoutée\\), décision preuve-reduite-publication de l'opérateur ancrée \\(empreinte ${print}\\)`));
  // A decision of another source, or not confirmed, never counts even when anchored.
  for (const other of [{ source: 'derived' }, { status: 'proposed' }]) {
    const p = configProject(t, { baseConfig: localConfig(s.pem, null), headConfig: localConfig(s.pem, decl), ledger: [decision(quote, other)] });
    operatorSays(p.repo, quote);
    await proven(p);
    assert.equal((await preuveOf(p)).status, 'refused', JSON.stringify(other));
  }
});

test('E1 : élargir waives, paths ou gates, changer le workflow, retirer un chemin protégé exigent la décision ; rétrécir, non', async t => {
  const s = signer();
  const base = declaration({ waives: ['integration'], protectedPaths: ['tests/e2e/guides/**'] });
  const cases = [
    ['waives : + browser', declaration({ waives: ['integration', 'browser'], protectedPaths: ['tests/e2e/guides/**'] }), true],
    ['paths.publication : + styles/{slug}.css', declaration({ waives: ['integration'], protectedPaths: ['tests/e2e/guides/**'], paths: { ...declaration().paths, publication: [...declaration().paths.publication, 'styles/{slug}.css'] } }), true],
    ['gates : + a11y', declaration({ waives: ['integration'], protectedPaths: ['tests/e2e/guides/**'], gates: ['check', 'test', 'a11y'] }), true],
    ['workflow, job ou nom', declaration({ waives: ['integration'], protectedPaths: ['tests/e2e/guides/**'], workflow: '.github/workflows/autre.yml' }), true],
    ['protectedPaths : - tests/e2e/guides/**', declaration({ waives: ['integration'] }), true],
    [null, declaration({ waives: ['integration'], protectedPaths: ['tests/e2e/guides/**'], gates: ['check'] }), false],
    [null, declaration({ waives: ['integration'], protectedPaths: ['tests/e2e/guides/**', 'scripts/x.mjs'], covers: 'autre phrase' }), false],
    [null, null, false],
  ];
  for (const [why, head, refused] of cases) {
    const p = configProject(t, { baseConfig: localConfig(s.pem, base), headConfig: localConfig(s.pem, head) });
    await proven(p);
    const preuve = await preuveOf(p);
    assert.equal(preuve.status, refused ? 'refused' : 'ok', `${why ?? 'rétrécie'} : ${text(preuve)}`);
    if (why) assert.match(text(preuve), new RegExp(why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('E1 : le refus tient même quand la règle preuve est jugée sur un lot (apv stack batch saute les reçus, jamais la décision)', async t => {
  const s = signer();
  const p = configProject(t, { baseConfig: localConfig(s.pem, null), headConfig: localConfig(s.pem, declaration()) });
  const preuve = await preuveOf(p, { skip: ['preuve', 'instable'] });
  assert.equal(preuve.status, 'refused', text(preuve));
  assert.match(text(preuve), /sans décision de l'opérateur ancrée/);
  // Without any change of the declaration, the batch keeps judging preuve on itself.
  const same = configProject(t, { baseConfig: localConfig(s.pem, declaration()), headConfig: { ...localConfig(s.pem, declaration()), name: 'essai-2' } });
  assert.equal((await preuveOf(same, { skip: ['preuve', 'instable'] })).status, 'not_applicable');
});

test('F-A2 : l\'empreinte porte le blob du workflow réduit à la tête ; une PR qui ne change que ce workflow (le vider) exige une nouvelle décision', async t => {
  const s = signer();
  const decl = configIssues(localConfig(s.pem, declaration())).config.rules.operatorOrders.reducedProof;
  assert.notEqual(reducedProofPrint(decl, 'a'.repeat(40)), reducedProofPrint(decl, 'b'.repeat(40)), 'un autre workflow, une autre empreinte');
  const full = 'name: Preuve de publication\non:\n  workflow_dispatch:\njobs:\n  preuve-publication:\n    name: Preuve de publication\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
  const emptied = full.replace('npm test', 'echo ok');
  const same = { baseConfig: localConfig(s.pem, declaration()), headConfig: localConfig(s.pem, declaration()), baseFiles: { [WORKFLOW]: full } };
  const p = configProject(t, { ...same, headFiles: { [WORKFLOW]: emptied } });
  await proven(p);
  const preuve = await preuveOf(p);
  assert.equal(preuve.status, 'refused', text(preuve));
  const blob = git(p.repo, 'rev-parse', `${p.head}:${WORKFLOW}`);
  const print = reducedProofPrint(decl, blob);
  assert.match(text(preuve), new RegExp(`élargie sans décision de l'opérateur ancrée \\(workflow réduit \\.github/workflows/preuve-publication\\.yml modifié\\) ; empreinte ${print}`));
  // Anchored with that fingerprint, the change is accepted; a workflow left as it was asks for nothing.
  const quote = `Je valide la preuve réduite ${print} pour les fusions sur ordre.`;
  const anchored = configProject(t, { ...same, headFiles: { [WORKFLOW]: emptied }, ledger: [decision(quote)] });
  operatorSays(anchored.repo, quote);
  await proven(anchored);
  assert.equal((await preuveOf(anchored)).status, 'ok');
  const untouched = configProject(t, { ...same, headFiles: { 'README.md': 'autre\n' } });
  await proven(untouched);
  assert.equal((await preuveOf(untouched)).status, 'ok');
});

test('M-A1 : la citation est exactement la phrase ; un message qui colle la sortie de l\'outil (consigne, ligne du problème, les deux) ne l\'ancre pas', async t => {
  const s = signer();
  const decl = declaration();
  const print = reducedProofPrint(configIssues(localConfig(s.pem, decl)).config.rules.operatorOrders.reducedProof, null);
  const sentence = `Je valide la preuve réduite ${print} pour les fusions sur ordre.`;
  // The refusal as the tool writes it (apv rules check), to paste.
  const probe = configProject(t, { baseConfig: localConfig(s.pem, null), headConfig: localConfig(s.pem, decl) });
  await proven(probe);
  const refusal = await preuveOf(probe);
  const problem = refusal.problems[0];
  const advice = refusal.todo.slice(0, 2).map(line => `    à faire : ${line}`).join('\n');
  assert.match(problem, new RegExp(print));
  const attempt = async (typed, quote = sentence) => {
    const p = configProject(t, { baseConfig: localConfig(s.pem, null), headConfig: localConfig(s.pem, decl), ledger: [decision(quote)] });
    operatorSays(p.repo, typed);
    await proven(p);
    return (await preuveOf(p)).status;
  };
  assert.equal(await attempt(`c'est quoi ?\n${advice}`, advice.split('\n')[0].replace('    à faire : ', '')), 'refused', 'consigne collée, citée telle quelle');
  assert.equal(await attempt(`c'est quoi ?\n${problem}`, problem), 'refused', 'ligne du problème collée, citée telle quelle');
  // The exact sentence typed in the same message as the pasted output: not a validation either.
  assert.equal(await attempt(`${advice}\n${sentence}`), 'refused', 'consigne collée avec la phrase');
  assert.equal(await attempt(`${problem}\n${sentence}`), 'refused', 'ligne du problème collée avec la phrase');
  assert.equal(await attempt(`${problem}\n${advice}\n${sentence}`), 'refused', 'les deux collées avec la phrase');
  // A quote that holds the fingerprint but is not the sentence.
  assert.equal(await attempt(`Oui. ${sentence}`, `Oui. ${sentence}`), 'refused', 'citation plus longue que la phrase');
  // The sentence alone, typed by the operator: accepted.
  assert.equal(await attempt(sentence), 'ok');
});
