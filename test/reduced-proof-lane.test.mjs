import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apv } from './cli-helpers.mjs';
import './support/rules.mjs';
import { NONCE, git, orderConfig, signer } from './support/orders.mjs';
import { checkMergeRules } from '../dist/rules/check.js';
import { workflowTextProblems } from '../dist/rules/reduced-proof.js';

/**
 * Reduced proof, phase 2 (docs/PREUVE-REDUITE.md, section 5): the rule preuve accepts the check run of the reduced job in
 * place of the full suite only in the context of a merge on order (`orderLane`, built by mergeOnOrder alone, passed
 * here as it would be), and only when every condition holds. The API of GitHub is an injected runner: never a network
 * call. Each refusal was seen red before its code.
 */

const RP_WORKFLOW = '.github/workflows/preuve-publication.yml';
const RP_NAME = 'Preuve de publication';
const CI_WORKFLOW = '.github/workflows/preuve.yml';
const CI_NAME = 'Preuve complète';
const COVERS = 'typecheck, tests unitaires, bout en bout des guides contre un aperçu du commit';
const rpWorkflow = (extra = '') => `name: ${RP_NAME}\non:\n  workflow_dispatch:\npermissions:\n  contents: read\nconcurrency:\n  group: preuve-publication-\${{ github.ref_name }}\n  cancel-in-progress: false\n${extra}jobs:\n  preuve-publication:\n    name: ${RP_NAME}\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:\n      - uses: actions/checkout@0000000000000000000000000000000000000000\n      - run: node scripts/check-links.mjs\n`;
const ciWorkflow = `name: ${CI_NAME}\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  preuve-complete:\n    name: ${CI_NAME}\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`;
/** Each check passes, unless FAIL_GATE names it (a failed local receipt). */
const gate = id => ({ id, stage: 'full', command: [process.execPath, '-e', `process.exit(process.env.FAIL_GATE === '${id}' ? 1 : 0)`], passEnv: ['FAIL_GATE'] });
const GATES = ['check', 'test', 'integration', 'browser', 'lint'].map(gate);
const PUBLICATION_PATHS = ['content/guides/{slug}.ts', 'content/catalog.ts'];
const declaration = (extra = {}) => ({ workflow: RP_WORKFLOW, job: 'preuve-publication', name: RP_NAME, gates: ['check', 'test'], waives: ['integration', 'browser'], covers: COVERS,
  paths: { publication: PUBLICATION_PATHS, article: ['docs/articles/{slug}/proposition.json'] }, protectedPaths: ['tests/guides/**'], ...extra });

const put = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };

/**
 * The project: main holds the configuration (orders, reduced proof, proof by the CI), both workflows, a script of the
 * reduced job that imports the catalog, and the catalog. publication/x regenerates the catalog and adds the guide;
 * article/x adds the proposal. `publication` and `base` change what the branches and main hold.
 */
function project(t, { decl = declaration(), workflowExtra = '', extraPaths = [], base = {}, publication = { 'content/catalog.ts': 'export const catalog = ["x"];\n', 'content/guides/x.ts': 'export const guide = { slug: "x" };\n' }, removed = [] } = {}) {
  const s = signer();
  const root = mkdtempSync(join(tmpdir(), 'apv3-voie-reduite-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(root, 'repo');
  git(root, 'clone', '-q', origin, repo);
  const config = orderConfig(s.pem, { paths: { publication: [...PUBLICATION_PATHS, 'styles/{slug}.css', ...extraPaths], article: ['docs/articles/{slug}/proposition.json'] }, ...(decl ? { reducedProof: decl } : {}) });
  config.rules.ciProof = { workflow: CI_WORKFLOW, job: 'preuve-complete', name: CI_NAME, gates: ['integration', 'browser'] };
  put(repo, '.apv/config.json', `${JSON.stringify({ name: 'essai', gates: GATES, ...config }, null, 2)}\n`);
  put(repo, RP_WORKFLOW, rpWorkflow(workflowExtra));
  put(repo, CI_WORKFLOW, ciWorkflow);
  put(repo, 'package.json', '{"name":"site","private":true}\n');
  put(repo, 'scripts/check-links.mjs', 'import { catalog } from \'../content/catalog.ts\';\nconsole.log(catalog.length);\n');
  put(repo, 'content/catalog.ts', 'export const catalog = [];\n');
  put(repo, 'README.md', 'projet\n');
  for (const [path, text] of Object.entries(base)) put(repo, path, text);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'push', '-q', 'origin', 'main');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-q', '-c', 'article/x', baseSha);
  put(repo, 'docs/articles/x/proposition.json', '{"sujet":"x"}\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'article'); git(repo, 'push', '-q', 'origin', 'article/x');
  const article = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-q', '-c', 'publication/x', baseSha);
  for (const [path, text] of Object.entries(publication)) put(repo, path, text);
  for (const path of removed) git(repo, 'rm', '-q', path);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'publication'); git(repo, 'push', '-q', 'origin', 'publication/x');
  const head = git(repo, 'rev-parse', 'HEAD');
  return { repo, base: baseSha, head, article, decl };
}

const blob = (p, sha, path) => git(p.repo, 'rev-parse', `${sha}:${path}`);
/** The paths a change adds or modifies (what a verification command regenerates). */
const changed = (p, from, to) => git(p.repo, 'diff', '--name-only', '--no-renames', '--diff-filter=AM', from, to).split('\n').filter(Boolean);

/** The context mergeOnOrder builds after the verification of the project (publication step by default). */
function lane(p, extra = {}) {
  const step = extra.step ?? 'publication';
  const head = step === 'publication' ? p.head : p.article;
  const regenerated = step === 'publication' ? changed(p, p.base, p.head).map(path => ({ path, blob: blob(p, p.head, path) })) : null;
  return { nonce: NONCE, step, trusted: p.base, target: p.base, head, slug: 'x', declaration: p.decl, ciProof: { workflow: CI_WORKFLOW, name: CI_NAME },
    sameConfigAsTrusted: true, verified: { head, base: p.base, regenerated, shape: step === 'publication' ? 'literal' : null }, ...extra };
}

/**
 * The GitHub API for acme/site: by default, one check run « Preuve de publication » of GitHub Actions at `sha`, success,
 * job 701 of run 9101 of preuve-publication.yml (workflow 55), event workflow_dispatch, launched on another branch than
 * the pull request (same commit). `edit` changes the scenario.
 */
function github(sha, edit = s => s) {
  const scenario = edit({
    checkRuns: [{ id: 701, name: RP_NAME, head_sha: sha, status: 'completed', conclusion: 'success', app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 88 }, html_url: 'https://github.com/acme/site/runs/701' }],
    runs: { 88: { id: 9101, head_sha: sha, head_branch: 'routine/essai', event: 'workflow_dispatch', workflow_id: 55, run_attempt: 1, status: 'completed', conclusion: 'success' } },
    workflows: { 55: { id: 55, path: RP_WORKFLOW }, 33: { id: 33, path: CI_WORKFLOW } },
    jobs: { 9101: [{ id: 701, name: RP_NAME, head_sha: sha, status: 'completed', conclusion: 'success' }] },
    fail: null,
  });
  const calls = [];
  const reply = (args, status, body, stderr = '') => ({ args, status, stdout: typeof body === 'string' ? body : JSON.stringify(body), stderr, error: null });
  const gh = async args => {
    calls.push(args);
    const path = args.at(-1);
    if (scenario.fail) return reply(args, 1, '', scenario.fail);
    let m;
    if ((m = /^repos\/acme\/site\/commits\/([0-9a-f]{40})\/check-runs\?/.exec(path))) {
      const name = new URL(`https://x/${path}`).searchParams.get('check_name');
      const runs = scenario.checkRuns.filter(c => c.name === name);
      return reply(args, 0, { total_count: runs.length, check_runs: runs });
    }
    if ((m = /^repos\/acme\/site\/actions\/runs\?check_suite_id=(\d+)$/.exec(path))) {
      const run = scenario.runs[m[1]];
      return reply(args, 0, { total_count: run ? 1 : 0, workflow_runs: run ? [run] : [] });
    }
    if ((m = /^repos\/acme\/site\/actions\/workflows\/(\d+)$/.exec(path))) return scenario.workflows[m[1]] ? reply(args, 0, scenario.workflows[m[1]]) : reply(args, 1, '', 'HTTP 404');
    if ((m = /^repos\/acme\/site\/actions\/runs\/(\d+)\/jobs\?/.exec(path))) return reply(args, 0, { total_count: (scenario.jobs[m[1]] ?? []).length, jobs: scenario.jobs[m[1]] ?? [] });
    return reply(args, 1, '', `HTTP 404 (${path})`);
  };
  return { gh, calls };
}

/** Proves `only` locally at the checked-out commit (FAIL_GATE: one of them fails). */
const runLocal = async (p, only, env = {}) => apv(p.repo, ['gates', 'run', '--stage', 'full', '--only', only, '--base', 'origin/main', '--json'], env);
const rules = (p, { commit = p.head, target = p.base, gh = github(commit).gh, orderLane } = {}) =>
  checkMergeRules({ repo: p.repo, commit, target, ci: { gh, repository: 'acme/site' }, ...(orderLane === null ? {} : { orderLane: orderLane ?? lane(p) }) });
const rule = (report, id) => report.rules.find(r => r.rule === id);
const text = r => [r.detail, ...r.problems, ...r.todo].join('\n');
/** The lane is not retained, the full suite stays required, and the output says why. */
const notRetained = async (p, options, reason) => {
  const report = await rules(p, options);
  const preuve = rule(report, 'preuve');
  assert.equal(preuve.status, 'refused', text(preuve));
  assert.match(text(preuve), /voie réduite non retenue/);
  assert.match(text(preuve), reason);
  // The full suite is required: the waived checks are named as missing.
  assert.match(text(preuve), /integration \((?:missing|failed)\)/);
  return report;
};

// ---------------------------------------------------------------------------------------------------------------------
// Accepted.

test('voie réduite, étape publication : check run réduit vert, contenu régénéré exécuté par le job nommé, lint prouvé en local : preuve ok (5.8)', async t => {
  const p = project(t);
  assert.equal((await runLocal(p, 'lint')).code, 0);
  const api = github(p.head);
  const report = await rules(p, { gh: api.gh });
  const preuve = rule(report, 'preuve');
  assert.equal(preuve.status, 'ok', text(preuve));
  assert.match(preuve.detail, new RegExp(`voie réduite sur ordre ${NONCE}, étape publication : 3 contrôle\\(s\\) prouvé\\(s\\) à ${p.head.slice(0, 12)} \\(1 par reçus locaux, 2 par le check run « ${RP_NAME} » 701, exécution 9101 \\(workflow_dispatch\\)\\)`));
  assert.match(preuve.detail, /levés : integration, browser/);
  assert.match(preuve.detail, new RegExp(`couvert : ${COVERS}`));
  assert.match(preuve.detail, /contenu régénéré exécuté par la preuve réduite : content\/catalog\.ts/);
  assert.equal(rule(report, 'instable').status, 'ok');
  assert.equal(report.reduced.retained, true);
  assert.deepEqual(report.reduced.waived, ['integration', 'browser']);
  // Read through the check runs of GitHub Actions, the run launched on another branch at the same commit counts.
  assert.ok(api.calls.some(a => /check_name=Preuve%20de%20publication/.test(a.at(-1))));
});

test('voie réduite, étape article : seule la proposition, check run réduit vert au commit signé', async t => {
  const p = project(t);
  git(p.repo, 'switch', '-q', 'article/x');
  assert.equal((await runLocal(p, 'lint')).code, 0);
  const report = await rules(p, { commit: p.article, gh: github(p.article).gh, orderLane: lane(p, { step: 'article' }) });
  const preuve = rule(report, 'preuve');
  assert.equal(preuve.status, 'ok', text(preuve));
  assert.match(preuve.detail, /voie réduite sur ordre .*, étape article/);
});

test('voie réduite : des reçus locaux propres passent d\'abord, mais le check run reste exigé (il prouve aussi covers)', async t => {
  const p = project(t);
  assert.equal((await runLocal(p, 'check,test,lint')).code, 0);
  const preuve = rule(await rules(p), 'preuve');
  assert.equal(preuve.status, 'ok', text(preuve));
  assert.match(preuve.detail, /3 contrôle\(s\) prouvé\(s\) .*\(3 par reçus locaux, 0 par le check run « Preuve de publication » 701/);
  await notRetained(p, { gh: github(p.head, s => ({ ...s, checkRuns: [] })).gh }, /aucun check run « Preuve de publication » de GitHub Actions/);
});

test('voie réduite : un contrôle hors de gates et de waives sans reçu local fait refuser preuve en le nommant (AC-RP-GATES)', async t => {
  const p = project(t);
  const report = await rules(p);
  const preuve = rule(report, 'preuve');
  assert.equal(preuve.status, 'refused');
  assert.equal(report.reduced.retained, true);
  assert.match(text(preuve), /contrôle\(s\) non prouvé\(s\) .*: lint \(missing\)/);
  assert.doesNotMatch(text(preuve), /integration \(missing\)/, 'les contrôles levés ne sont pas exigés');
});

// ---------------------------------------------------------------------------------------------------------------------
// Only on order (M6), bound to its commit and target (F4, M10), declaration of T (M3).

test('M6 : sans contexte de fusion sur ordre, un check run réduit vert ne prouve rien ; information « voie réduite possible sur ordre signé seulement »', async t => {
  const p = project(t);
  await runLocal(p, 'lint');
  const report = await rules(p, { orderLane: null });
  const preuve = rule(report, 'preuve');
  assert.equal(preuve.status, 'refused');
  assert.match(text(preuve), /integration \(missing\), browser \(missing\)/);
  assert.match(text(preuve), /information : voie réduite possible sur ordre signé seulement \(apv stack merge --order\)/);
  assert.equal(report.reduced, undefined);
});

test('F4 et M10 : contexte d\'un autre commit, d\'une autre cible, vérification du projet d\'un autre essai : voie non retenue', async t => {
  const p = project(t);
  await runLocal(p, 'lint');
  await notRetained(p, { orderLane: lane(p, { head: p.article }) }, /contexte de voie réduite d'un autre commit/);
  await notRetained(p, { orderLane: lane(p, { target: p.article }) }, /contexte de voie réduite d'une autre cible/);
  await notRetained(p, { orderLane: lane(p, { verified: { ...lane(p).verified, base: p.article } }) }, /vérification du projet faite pour un autre essai/);
  await notRetained(p, { orderLane: lane(p, { verified: { ...lane(p).verified, head: p.article } }) }, /vérification du projet faite pour un autre essai/);
});

test('M3 et 5.2 : déclaration absente de la base de confiance, configuration de M différente de T : voie non retenue', async t => {
  const p = project(t);
  await runLocal(p, 'lint');
  await notRetained(p, { orderLane: lane(p, { declaration: null }) }, /rules\.operatorOrders\.reducedProof non déclarée à la base de confiance/);
  await notRetained(p, { orderLane: lane(p, { sameConfigAsTrusted: false }) }, /configuration de la cible .* différente de celle de la base de confiance/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The diff (M4, F2) and the regeneration (E2, M4 of the review).

test('M4 : un fichier permis par operatorOrders.paths mais hors de reducedProof.paths fait exiger la suite complète, nommé (AC-USER-2)', async t => {
  const p = project(t, { publication: { 'content/catalog.ts': 'export const catalog = ["x"];\n', 'styles/x.css': 'body { color: red; }\n' } });
  await runLocal(p, 'lint');
  await notRetained(p, {}, /hors de rules\.operatorOrders\.reducedProof\.paths\.publication : styles\/x\.css/);
});

test('F2 : une suppression, même d\'un chemin de la liste, fait sortir de la voie', async t => {
  const p = project(t, { base: { 'content/guides/x.ts': 'export const guide = {};\n' }, publication: { 'content/catalog.ts': 'export const catalog = ["y"];\n' }, removed: ['content/guides/x.ts'] });
  await runLocal(p, 'lint');
  const orderLane = lane(p, { verified: { head: p.head, base: p.base, regenerated: [{ path: 'content/catalog.ts', blob: blob(p, p.head, 'content/catalog.ts') }], shape: 'literal' } });
  await notRetained(p, { orderLane }, /suppression, renommage ou changement de type hors de la voie réduite : content\/guides\/x\.ts/);
});

test('E2 : chaque chemin du diff doit figurer dans regenerated avec le blob de H', async t => {
  const p = project(t);
  await runLocal(p, 'lint');
  const verified = lane(p).verified;
  await notRetained(p, { orderLane: lane(p, { verified: { ...verified, regenerated: null } }) }, /la commande du projet ne dit pas les fichiers régénérés/);
  await notRetained(p, { orderLane: lane(p, { verified: { ...verified, regenerated: verified.regenerated.filter(r => r.path !== 'content/guides/x.ts') } }) }, /contenu non régénéré par la commande du projet : content\/guides\/x\.ts/);
  await notRetained(p, { orderLane: lane(p, { verified: { ...verified, regenerated: verified.regenerated.map(r => ({ ...r, blob: 'a'.repeat(40) })) } }) }, /contenu non régénéré par la commande du projet : content\/catalog\.ts \(blob/);
  await notRetained(p, { orderLane: lane(p, { verified: { ...verified, regenerated: [...verified.regenerated, verified.regenerated[0]] } }) }, /chemin en double dans regenerated/);
});

test('M4 (relecture) : sans shape « literal », la forme n\'est pas vérifiée depuis T : voie non retenue', async t => {
  const p = project(t);
  await runLocal(p, 'lint');
  await notRetained(p, { orderLane: lane(p, { verified: { ...lane(p).verified, shape: null } }) }, /forme des fichiers régénérés non vérifiée par la commande du projet/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The workflow (M2 of the threats, M1 and F5 of the review).

test('M1 (relecture) : chaque forme refusée du texte du workflow lu à T', () => {
  const ok = rpWorkflow();
  assert.deepEqual(workflowTextProblems(ok), []);
  const cases = [
    ['on:\n  workflow_dispatch:\n    inputs:\n      pr: {}\n', /inputs/],
    ['"inputs":\n', /inputs/],
    ["'inputs':\n", /inputs/],
    ['? inputs\n: {}\n', /inputs/],
    ['env:\n  PR: ${{ github.event.inputs.pr }}\n', /inputs/],
    ['env:\n  X: ${{ vars.PREUVE }}\n', /vars\./],
    ['    with:\n      ref: ${{ github.head_ref }}\n', /clé ref ou repository/],
    ['    with:\n      "repository": acme/autre\n', /clé ref ou repository/],
    ['    continue-on-error: true\n', /continue-on-error/],
    ['      - run: npm test || true\n', /\|\| true/],
    ['      - run: npm test || exit 0\n', /\|\| true/],
  ];
  for (const [extra, reason] of cases) assert.match(workflowTextProblems(`${ok}${extra}`).join('\n'), reason, extra);
  // F5: no cancellation by the concurrency group.
  assert.match(workflowTextProblems(ok.replace('cancel-in-progress: false', 'cancel-in-progress: true')).join('\n'), /cancel-in-progress: false exigé/);
  assert.match(workflowTextProblems(ok.replace('  cancel-in-progress: false\n', '')).join('\n'), /concurrency sans cancel-in-progress: false/);
  assert.match(workflowTextProblems(ok.replace('cancel-in-progress: false', 'cancel-in-progress: ${{ true }}')).join('\n'), /cancel-in-progress: false exigé/);
  assert.deepEqual(workflowTextProblems(ok.replace(/concurrency:\n.*\n.*\n/, '')), [], 'sans groupe de concurrence, rien ne s\'annule');
});

test('M1 (relecture) et F5 : un workflow de T avec inputs ou cancel-in-progress: true écarte la voie', async t => {
  for (const [extra, reason] of [['env:\n  "inputs": x\n', /inputs/], ['env:\n  ANNULE: "1"\n', null]]) {
    const p = project(t, { workflowExtra: extra });
    await runLocal(p, 'lint');
    if (reason) await notRetained(p, {}, reason);
    else assert.equal(rule(await rules(p), 'preuve').status, 'ok');
  }
});

test('M2 (menace) et AC-USER-3 : workflow réduit différent entre T et B (cible changée pendant l\'ordre) : voie non retenue', async t => {
  const p = project(t);
  // The target moves after the article forked: T and M hold another workflow than the merge base B of the article.
  git(p.repo, 'switch', '-q', 'main');
  put(p.repo, RP_WORKFLOW, rpWorkflow('env:\n  NOUVEAU: "1"\n'));
  git(p.repo, 'commit', '-qam', 'workflow changé'); git(p.repo, 'push', '-q', 'origin', 'main');
  const moved = git(p.repo, 'rev-parse', 'HEAD');
  git(p.repo, 'switch', '-q', 'article/x');
  await runLocal(p, 'lint');
  const orderLane = lane(p, { step: 'article', trusted: moved, target: moved, verified: { head: p.article, base: moved, regenerated: null, shape: null } });
  await notRetained(p, { commit: p.article, target: moved, gh: github(p.article).gh, orderLane }, /workflow réduit .* différent entre la base de confiance, la base commune et la tête/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The check run (5.4).

test('5.4 : évènement push, check run d\'une autre application, d\'un autre workflow, en échec puis vert, en cours, action_required : voie non retenue', async t => {
  const p = project(t);
  await runLocal(p, 'lint');
  const edit = fn => ({ gh: github(p.head, fn).gh });
  await notRetained(p, edit(s => ({ ...s, runs: { 88: { ...s.runs[88], event: 'push' } } })), /évènement push non admis \(admis : workflow_dispatch sans entrée\)/);
  await notRetained(p, edit(s => ({ ...s, checkRuns: s.checkRuns.map(c => ({ ...c, app: { id: 99, slug: 'github-actions' } })) })), /application github-actions \(99\)/);
  await notRetained(p, edit(s => ({ ...s, runs: { 88: { ...s.runs[88], workflow_id: 33 } } })), /workflow \.github\/workflows\/preuve\.yml, pas \.github\/workflows\/preuve-publication\.yml/);
  await notRetained(p, edit(s => ({ ...s, checkRuns: [...s.checkRuns, { ...s.checkRuns[0], id: 700, conclusion: 'failure', check_suite: { id: 87 } }],
    runs: { ...s.runs, 87: { ...s.runs[88], id: 9100, conclusion: 'failure' } } })), /check run 700 .*conclusion failure/);
  await notRetained(p, edit(s => ({ ...s, checkRuns: s.checkRuns.map(c => ({ ...c, status: 'in_progress', conclusion: null })) })), /en cours/);
  await notRetained(p, edit(s => ({ ...s, checkRuns: s.checkRuns.map(c => ({ ...c, conclusion: 'action_required' })) })), /action_required/);
  await notRetained(p, edit(s => ({ ...s, checkRuns: s.checkRuns.map(c => ({ ...c, conclusion: 'cancelled' })) })), /cancelled/);
  await notRetained(p, edit(s => ({ ...s, fail: 'HTTP 503' })), /API GitHub indisponible/);
  await notRetained(p, { gh: null }, /hors réseau/);
});

test('5.4 : un job relancé (tentative 2) fait refuser instable', async t => {
  const p = project(t);
  await runLocal(p, 'lint');
  const report = await rules(p, { gh: github(p.head, s => ({ ...s, runs: { 88: { ...s.runs[88], run_attempt: 2 } } })).gh });
  assert.equal(rule(report, 'preuve').status, 'ok');
  assert.equal(rule(report, 'instable').status, 'refused');
  assert.match(text(rule(report, 'instable')), /job de la preuve réduite relancé : tentative 2 de l'exécution 9101/);
});

test('M2 (relecture) : un rouge de rules.ciProof à H, ou un reçu local en échec d\'un contrôle levé, écarte la voie', async t => {
  const p = project(t);
  await runLocal(p, 'lint');
  const red = conclusion => github(p.head, s => ({ ...s, checkRuns: [...s.checkRuns, { id: 801, name: CI_NAME, head_sha: p.head, status: conclusion ? 'completed' : 'in_progress', conclusion,
    app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 90 } }] })).gh;
  await notRetained(p, { gh: red('failure') }, /un rouge observé n'est jamais levé par la voie réduite : check run « Preuve complète » 801 \(failure\)/);
  await notRetained(p, { gh: red('cancelled') }, /« Preuve complète » 801 \(cancelled\)/);
  await notRetained(p, { gh: red(null) }, /« Preuve complète » 801 \(in_progress\)/);
  // A green « Preuve complète » at H changes nothing.
  assert.equal(rule(await rules(p, { gh: red('success') }), 'preuve').status, 'ok');
  const failed = await runLocal(p, 'integration', { FAIL_GATE: 'integration' });
  assert.notEqual(failed.code, 0);
  await notRetained(p, {}, /reçu local en échec d'un contrôle levé : integration/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The closure (5.5, 5.6, F3).

test('F3 : un fichier ajouté qui masque une résolution d\'un import de la preuve n\'est jamais exempté', async t => {
  // The slug « catalog » and a list that allows content/{slug}.js: content/catalog.js shadows the ../content/catalog.ts of the job script.
  const decl = declaration({ paths: { publication: [...PUBLICATION_PATHS, 'content/{slug}.js'], article: ['docs/articles/{slug}/proposition.json'] } });
  const p = project(t, { decl, extraPaths: ['content/{slug}.js'], publication: { 'content/catalog.js': 'export const catalog = ["masque"];\n' } });
  await runLocal(p, 'lint');
  await notRetained(p, { orderLane: lane(p, { slug: 'catalog' }) }, /fichier ajouté qui masque une résolution d'un import de la preuve : content\/catalog\.js/);
});

test('F3 : les imports des fichiers exemptés sont recalculés à H (un paquet non déclaré importé par le contenu)', async t => {
  const p = project(t, { publication: { 'content/catalog.ts': 'import x from \'paquet-inconnu\';\nexport const catalog = [x];\n' } });
  await runLocal(p, 'lint');
  await notRetained(p, {}, /import non suivi .* à la tête : content\/catalog\.ts : paquet-inconnu/);
});

test('5.6 : un fichier que le workflow nomme (le script du job), même déclaré comme contenu et régénéré, n\'est jamais exempté', async t => {
  const decl = declaration({ paths: { publication: [...PUBLICATION_PATHS, 'scripts/{slug}.mjs'], article: ['docs/articles/{slug}/proposition.json'] } });
  const p = project(t, { decl, extraPaths: ['scripts/{slug}.mjs'], publication: { 'scripts/check-links.mjs': 'console.log("remplacé");\n' } });
  await runLocal(p, 'lint');
  await notRetained(p, { orderLane: lane(p, { slug: 'check-links' }) }, /fichier exécuté ou pouvant remplacer un fichier exécuté par la preuve, modifié depuis la base .*: scripts\/check-links\.mjs/);
});
