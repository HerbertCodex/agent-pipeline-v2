import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { apv } from './cli-helpers.mjs';
import { RULES, waive } from './support/rules.mjs';
import { ARTICLE, IDENTITY, NONCE, PUBLICATION, comment, fakeGh, fakeProduction, git, orderConfig, orderObjects, orderRepo, pullRequests, signer } from './support/orders.mjs';
import { orderLines, orderRules } from '../dist/commands/stack-order.js';
import { mergeOnOrder } from '../dist/orders/merge.js';
import { successReport } from '../dist/orders/verify-command.js';
import { processGit } from '../dist/stack/batch.js';
import { auditLines, auditMerges, readOrderProofs } from '../dist/rules/merges.js';

/**
 * Reduced proof, phase 3 (docs/PREUVE-REDUITE.md, 5.3, 5.8, F6): the verification command of the project says what it
 * regenerated, mergeOnOrder builds the context of the lane at each try, the report and the trace say which proof was
 * taken, and apv audit merges reads the check runs of a merge on order that has no local trace.
 */

const RP_WORKFLOW = '.github/workflows/preuve-publication.yml';
const RP_NAME = 'Preuve de publication';
const blobOf = c => c.repeat(40);

test('E2 et M4 : la dernière ligne de la commande du projet en cas de succès donne regenerated et shape ; sinon rien', () => {
  const ok = successReport(`trace\n${JSON.stringify({ ok: true, regenerated: [{ path: 'a.ts', blob: blobOf('a') }, { path: 'b.ts', blob: blobOf('b') }], shape: 'literal' })}\n`);
  assert.deepEqual(ok, { regenerated: [{ path: 'a.ts', blob: blobOf('a') }, { path: 'b.ts', blob: blobOf('b') }], shape: 'literal' });
  assert.deepEqual(successReport('{"ok":true}\n'), { regenerated: null, shape: null }, 'sans liste : régénération non observable');
  assert.deepEqual(successReport('pas du json\n'), { regenerated: null, shape: null });
  assert.equal(successReport(JSON.stringify({ ok: true, regenerated: [{ path: 'a.ts', blob: 'pas un blob' }] })).regenerated, null, 'blob illisible : liste refusée entière');
  assert.equal(successReport(JSON.stringify({ ok: true, regenerated: [{ path: 7, blob: blobOf('a') }] })).regenerated, null);
  assert.equal(successReport(JSON.stringify({ ok: true, regenerated: [{ path: '../x', blob: blobOf('a') }] })).regenerated, null, 'chemin hors du dépôt');
  assert.equal(successReport(JSON.stringify({ ok: true, regenerated: Array.from({ length: 201 }, (_, k) => ({ path: `f${k}.ts`, blob: blobOf('a') })) })).regenerated, null, 'plus de 200 entrées');
  assert.equal(successReport(JSON.stringify({ ok: true, regenerated: [], shape: 7 })).shape, null);
  assert.equal(successReport(JSON.stringify({ ok: false, regenerated: [{ path: 'a.ts', blob: blobOf('a') }], shape: 'literal' })).regenerated, null, 'une ligne qui ne dit pas ok ne compte pas');
});

/** The verification command of the project, at the base: as the support one, plus what it regenerated and the shape it checked. */
const VERIFY_REDUCED = `import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [, , trusted, base, head, step] = process.argv;
const input = JSON.parse(readFileSync(0, 'utf8'));
const answer = (ok, extra) => { console.log(JSON.stringify({ ok, ...extra })); process.exit(ok ? 0 : 1); };
if (step === 'article') answer(head === input.order.articleSha, { code: 'head_moved' });
const served = execFileSync('git', ['show', head + ':served.txt'], { encoding: 'utf8' }).trim();
if (served !== input.order.content) answer(false, { code: 'content' });
const blob = execFileSync('git', ['rev-parse', head + ':served.txt'], { encoding: 'utf8' }).trim();
answer(true, { regenerated: [{ path: 'served.txt', blob }], shape: 'literal' });
`;
const rpWorkflow = `name: ${RP_NAME}\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  preuve-publication:\n    name: ${RP_NAME}\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`;

/** A project whose base declares the reduced proof: check proven by the reduced job, integration lifted. */
function reducedConfig(pem, extraPublication = []) {
  const config = orderConfig(pem, {
    paths: { publication: ['served.txt', ...extraPublication], article: ['docs/articles/{slug}/proposition.json'] },
    verify: { publication: [process.execPath, 'scripts/verify-reduced.mjs', '{{trusted}}', '{{base}}', '{{head}}', '{{step}}'], timeoutMs: 60_000 },
    reducedProof: { workflow: RP_WORKFLOW, job: 'preuve-publication', name: RP_NAME, gates: ['check'], waives: ['integration'], covers: 'tests unitaires et rendu du guide',
      paths: { publication: ['served.txt'], article: ['docs/articles/{slug}/proposition.json'] } },
  });
  return { name: 'essai', gates: ['check', 'integration'].map(id => ({ id, stage: 'full', command: [process.execPath, '-e', '0'] })), ...config };
}

/** The API of GitHub for acme/site: a green check run « Preuve de publication » of GitHub Actions at each commit of `shas`, launched by workflow_dispatch. */
function reducedApi(shas) {
  const calls = [];
  const reply = (args, body, status = 0) => ({ args, status, stdout: JSON.stringify(body), stderr: status ? 'HTTP 404' : '', error: null });
  const gh = async args => {
    calls.push(args);
    const path = args.at(-1);
    let m;
    if ((m = /^repos\/acme\/site\/commits\/([0-9a-f]{40})\/check-runs\?/.exec(path))) {
      const k = shas.indexOf(m[1]);
      const named = new URL(`https://x/${path}`).searchParams.get('check_name') === RP_NAME;
      const runs = k >= 0 && named ? [{ id: 701 + k, name: RP_NAME, head_sha: m[1], status: 'completed', conclusion: 'success', app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 88 + k } }] : [];
      return reply(args, { total_count: runs.length, check_runs: runs });
    }
    if ((m = /^repos\/acme\/site\/actions\/runs\?check_suite_id=(\d+)$/.exec(path))) {
      const k = Number(m[1]) - 88;
      return reply(args, { total_count: 1, workflow_runs: [{ id: 9101 + k, head_sha: shas[k], event: 'workflow_dispatch', workflow_id: 55, run_attempt: 1, status: 'completed', conclusion: 'success' }] });
    }
    if (/^repos\/acme\/site\/actions\/workflows\/55$/.test(path)) return reply(args, { id: 55, path: RP_WORKFLOW });
    if ((m = /^repos\/acme\/site\/actions\/runs\/(\d+)\/jobs\?/.exec(path))) {
      const k = Number(m[1]) - 9101;
      return reply(args, { total_count: 1, jobs: [{ id: 701 + k, name: RP_NAME, head_sha: shas[k], status: 'completed', conclusion: 'success' }] });
    }
    return reply(args, {}, 1);
  };
  return { gh, calls };
}

/** A merge on order of a project with the reduced proof: the real rules of the tool, every rule but preuve and instable waived by the operator. */
function reducedScenario(t, { extraPublication = [], publicationExtra = null } = {}) {
  const s = signer();
  const repo = orderRepo(t, s.pem, { config: reducedConfig(s.pem, extraPublication), baseFiles: { [RP_WORKFLOW]: rpWorkflow, 'scripts/verify-reduced.mjs': VERIFY_REDUCED } });
  if (publicationExtra) {
    git(repo.dir, 'switch', '-q', 'publication/x');
    for (const [path, text] of Object.entries(publicationExtra)) { mkdirSync(dirname(join(repo.dir, path)), { recursive: true }); writeFileSync(join(repo.dir, path), text); }
    git(repo.dir, 'add', '-A'); git(repo.dir, 'commit', '-qm', 'publication, un fichier de plus'); git(repo.dir, 'push', '-q', 'origin', 'publication/x');
    repo.publication = git(repo.dir, 'rev-parse', 'HEAD');
    git(repo.dir, 'switch', '-q', 'main');
  }
  const objects = orderObjects(s, repo.article);
  const github = fakeGh({ prs: pullRequests(repo), comments: { [ARTICLE]: [comment(objects.decisionSigned), comment(objects.orderSigned)] } });
  const production = fakeProduction(s, objects.order);
  for (const head of [repo.publication, repo.article]) waive(repo.dir, head, RULES.filter(r => r !== 'preuve' && r !== 'instable'));
  const api = reducedApi([repo.publication, repo.article]);
  const traced = [];
  const run = (extra = {}) => mergeOnOrder({
    repo: repo.dir, remote: 'origin', publicationPr: PUBLICATION, articlePr: ARTICLE, nonce: NONCE,
    gh: github.gh, git: processGit({ ...process.env, ...IDENTITY }), env: { ...process.env, ...IDENTITY }, fetch: production.fetch,
    rules: orderRules(repo.dir, { gh: api.gh, repository: 'acme/site' }), onMerged: merge => { traced.push(merge); return null; }, ...extra,
  });
  return { repo, api, run, traced };
}

test('AC-USER-1 : publication et article fusionnés par la voie réduite, proof « reduced » dans le rapport et la trace', async t => {
  const sc = reducedScenario(t);
  const report = await sc.run();
  assert.equal(report.status, 'merged', report.reason);
  assert.deepEqual(report.merged.map(m => [m.step, m.proof.mode, m.proof.checkRun, m.proof.run, m.proof.name]),
    [['publication', 'reduced', 701, 9101, RP_NAME], ['article', 'reduced', 702, 9102, RP_NAME]]);
  assert.deepEqual(sc.traced.map(m => m.proof?.mode), ['reduced', 'reduced'], 'la trace signée dit la preuve');
  const lines = orderLines(report, NONCE).join('\n');
  assert.match(lines, /étape publication : PR #21 fusionnée .* ; preuve réduite : check run « Preuve de publication » 701 \(exécution 9101\)/);
  assert.match(lines, /étape article : PR #20 fusionnée .* ; preuve réduite : check run « Preuve de publication » 702/);
});

test('AC-USER-2 : un fichier permis par l\'ordre mais hors de la liste réduite : refus rules avant toute fusion, fichier nommé, suite complète exigée', async t => {
  const sc = reducedScenario(t, { extraPublication: ['styles/{slug}.css'], publicationExtra: { 'styles/x.css': 'body { color: red; }\n' } });
  const before = git(sc.repo.origin, 'rev-parse', 'refs/heads/main');
  const report = await sc.run();
  assert.equal(report.status, 'refused');
  assert.equal(report.code, 'rules', report.reason);
  assert.match(report.reason, /voie réduite non retenue : hors de rules\.operatorOrders\.reducedProof\.paths\.publication : styles\/x\.css/);
  assert.match(report.reason, /integration \(missing\)/, 'la suite complète est exigée');
  assert.deepEqual(report.merged, []);
  assert.equal(git(sc.repo.origin, 'rev-parse', 'refs/heads/main'), before);
});

test('5.1 : mergeOnOrder construit le contexte à chaque étape, après la vérification du projet, lié à H, M et T', async t => {
  const sc = reducedScenario(t);
  const seen = [];
  const report = await sc.run({ rules: async (head, base, lane) => { seen.push({ head, base, lane }); return []; } });
  assert.equal(report.status, 'merged', report.reason);
  const [publication, article] = seen;
  assert.equal(publication.lane.step, 'publication');
  assert.equal(publication.lane.nonce, NONCE);
  assert.equal(publication.lane.head, sc.repo.publication);
  assert.equal(publication.lane.target, publication.base);
  assert.equal(publication.lane.trusted, sc.repo.base);
  assert.equal(publication.lane.slug, 'x');
  assert.equal(publication.lane.declaration.name, RP_NAME);
  assert.equal(publication.lane.sameConfigAsTrusted, true);
  assert.deepEqual(publication.lane.verified, { head: sc.repo.publication, base: publication.base,
    regenerated: [{ path: 'served.txt', blob: git(sc.repo.dir, 'rev-parse', `${sc.repo.publication}:served.txt`) }], shape: 'literal' });
  assert.equal(article.lane.step, 'article');
  assert.equal(article.lane.head, sc.repo.article);
  assert.equal(article.lane.target, report.merged[0].mergeCommit, 'M de l\'étape article : la fusion de publication');
  assert.equal(article.lane.trusted, sc.repo.base, 'T reste la base de confiance du lancement');
  assert.equal(article.lane.verified.base, article.base);
  // A plain list of problems (the rules of a test) gives a full proof in the report.
  assert.deepEqual(report.merged.map(m => m.proof.mode), ['full', 'full']);
});

test('F6 : apv audit merges relit le check run à la tête fusionnée d\'une fusion sur ordre sans trace locale, sans jamais la compter tracée', async t => {
  const sc = reducedScenario(t);
  const report = await sc.run({ onMerged: undefined });
  assert.equal(report.status, 'merged', report.reason);
  git(sc.repo.dir, 'fetch', '-q', 'origin');
  const common = git(sc.repo.dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const audit = auditMerges(sc.repo.dir, common, 'origin/main', { since: new Date(Date.now() - 3_600_000).toISOString() });
  const read = await readOrderProofs(sc.repo.dir, audit, sc.api.gh, 'acme/site');
  const orders = read.unaccounted.filter(u => u.order);
  assert.equal(orders.length, 2, 'toujours signalées');
  const lines = auditLines(read).join('\n');
  assert.match(lines, /pied Apv-Order non vérifié/);
  assert.match(lines, /preuve lue sur GitHub à la tête fusionnée [0-9a-f]{12} : « Preuve de publication » : check run 702 success \(github-actions\)/);
  assert.match(lines, /check run 701 success/);
  // Offline, or the API unreadable: said, nothing invented.
  const offline = auditLines(await readOrderProofs(sc.repo.dir, audit, null, 'acme/site')).join('\n');
  assert.match(offline, /preuves CI non relues \(hors réseau\)/);
  // From the command line, a remote outside github.com: said, never a network call.
  const cli = await apv(sc.repo.dir, ['audit', 'merges', '--target', 'origin/main', '--since', new Date(Date.now() - 3_600_000).toISOString().slice(0, 10)]);
  assert.match(cli.stdout, /preuves CI non relues \(dépôt distant hors de github\.com\)/);
});
