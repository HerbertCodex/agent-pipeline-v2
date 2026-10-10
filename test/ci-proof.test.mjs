import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apv } from './cli-helpers.mjs';
import './support/rules.mjs';
import { checkMergeRules } from '../dist/rules/check.js';
import { loadConfig } from '../dist/config/load.js';

/**
 * Proof by the CI (rules.ciProof, issue #130): the check run « Preuve complète » of the GitHub Actions application, at the
 * exact commit, of the workflow the base declares, unchanged by the change with every file that produces the proof, read
 * through the API of the check runs (simulated here by an injected runner: never a network call in a test). Each refusal
 * below was seen red before the code that makes it pass.
 */

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim();
const node = code => [process.execPath, '-e', code];
const put = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };

const WORKFLOW = '.github/workflows/preuve.yml';
const NAME = 'Preuve complète';
const workflowText = (extra = '') => `name: ${NAME}\non:\n  pull_request:\n    types: [ready_for_review, synchronize]\n${extra}permissions:\n  contents: read\njobs:\n  preuve-complete:\n    name: ${NAME}\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run test:integration\n`;
const CI_PROOF = { workflow: WORKFLOW, job: 'preuve-complete', name: NAME, gates: ['integration', 'browser'], artifact: 'apv-recus' };
// Two checks of the full suite the CI covers; nothing proven on this machine unless a test proves it.
const GATES = [{ id: 'integration', stage: 'full', command: node('0') }, { id: 'browser', stage: 'full', command: node('0') }];
const BASE_FILES = {
  [WORKFLOW]: workflowText(),
  'package.json': { name: 'site', private: true, scripts: { 'test:integration': 'node scripts/e2e/lock.mjs npm run e2e:integration', 'e2e:integration': 'playwright test', build: 'vite build' } },
  'scripts/e2e/ci-stack.mjs': 'process.exit(0);\n',
};

/** An origin and a clone: main holds the base (with rules.ciProof unless `ciProof` is null), the branch feat adds `change`. */
function project(t, { change = {}, gates = GATES, ciProof = CI_PROOF, headConfig = null, base = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apv3-ci-proof-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(root, 'repo');
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'switch', '-q', '-c', 'main');
  put(repo, '.apv/config.json', { name: 'essai', gates, ...(ciProof ? { rules: { ciProof } } : {}) });
  put(repo, 'README.md', 'projet\n');
  for (const [path, value] of Object.entries({ ...BASE_FILES, ...base })) put(repo, path, value);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'switch', '-q', '-c', 'feat');
  for (const [path, value] of Object.entries(change)) put(repo, path, value);
  if (headConfig) put(repo, '.apv/config.json', headConfig);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'change', '--allow-empty'); git(repo, 'push', '-q', 'origin', 'feat');
  const head = git(repo, 'rev-parse', 'HEAD');
  return { repo, head };
}

/**
 * The GitHub API as `gh api` answers it, for the repository acme/site: by default, one check run « Preuve complète » of
 * GitHub Actions at `sha`, concluded in success, job 501 of run 9001 of the workflow preuve.yml (id 33), event pull_request.
 * `edit` changes the scenario; every call is recorded.
 */
function github(sha, edit = s => s) {
  const scenario = edit({
    checkRuns: [{ id: 501, name: NAME, head_sha: sha, status: 'completed', conclusion: 'success', started_at: '2026-10-09T10:00:00Z',
      app: { slug: 'github-actions', owner: { login: 'github' } }, check_suite: { id: 77 }, html_url: 'https://github.com/acme/site/runs/501' }],
    runs: { 77: { id: 9001, head_sha: sha, event: 'pull_request', path: WORKFLOW, workflow_id: 33, run_attempt: 1, check_suite_id: 77, status: 'completed', conclusion: 'success' } },
    workflows: { 33: { id: 33, path: WORKFLOW }, 44: { id: 44, path: '.github/workflows/ci.yml' } },
    jobs: { 9001: [{ id: 501, run_id: 9001, name: NAME, head_sha: sha, status: 'completed', conclusion: 'success', check_run_url: 'https://api.github.com/repos/acme/site/check-runs/501' }] },
    statuses: [],
    fail: null,
  });
  const calls = [];
  const reply = (status, body, stderr = '') => ({ status, stdout: typeof body === 'string' ? body : JSON.stringify(body), stderr, error: null });
  const gh = async args => {
    calls.push(args);
    const path = args.at(-1);
    if (scenario.fail) return { ...reply(1, '', scenario.fail), args };
    let m;
    if ((m = /^repos\/acme\/site\/commits\/([0-9a-f]{40})\/check-runs\?/.exec(path))) {
      const runs = scenario.checkRuns.filter(c => new URL(`https://x/${path}`).searchParams.get('check_name') === c.name);
      return { ...reply(0, { total_count: runs.length, check_runs: runs }), args };
    }
    if ((m = /^repos\/acme\/site\/commits\/([0-9a-f]{40})\/statuses/.exec(path))) return { ...reply(0, scenario.statuses), args };
    if ((m = /^repos\/acme\/site\/actions\/runs\?check_suite_id=(\d+)$/.exec(path))) {
      const run = scenario.runs[m[1]];
      return { ...reply(0, { total_count: run ? 1 : 0, workflow_runs: run ? [run] : [] }), args };
    }
    if ((m = /^repos\/acme\/site\/actions\/workflows\/(\d+)$/.exec(path))) {
      const w = scenario.workflows[m[1]];
      return w ? { ...reply(0, w), args } : { ...reply(1, '', 'HTTP 404: Not Found'), args };
    }
    if ((m = /^repos\/acme\/site\/actions\/runs\/(\d+)\/jobs\?/.exec(path))) {
      const jobs = scenario.jobs[m[1]] ?? [];
      return { ...reply(0, { total_count: jobs.length, jobs }), args };
    }
    return { ...reply(1, '', `HTTP 404: Not Found (${path})`), args };
  };
  return { gh, calls };
}

const check = (p, ci) => checkMergeRules({ repo: p.repo, commit: p.head, target: 'origin/main', remote: { strict: true }, ci });
const rule = (report, id) => report.rules.find(r => r.rule === id);
const text = r => [r.detail, ...r.problems, ...r.todo].join('\n');

test('ciProof: the check run of GitHub Actions at the exact commit proves the checks it covers; the local proof is never asked', async t => {
  const p = project(t, { change: { 'src/app.ts': 'export const x = 1;\n' } });
  const api = github(p.head);
  const report = await check(p, { gh: api.gh, repository: 'acme/site' });
  const preuve = rule(report, 'preuve');
  assert.equal(preuve.status, 'ok', text(preuve));
  assert.match(preuve.detail, /par la CI/);
  assert.match(preuve.detail, /check run « Preuve complète » 501/);
  assert.match(preuve.detail, /\.github\/workflows\/preuve\.yml/);
  assert.match(preuve.detail, /apv-recus : mesure seulement/);
  assert.equal(rule(report, 'instable').status, 'ok');
  assert.equal(report.ci.state, 'accepted');
  assert.deepEqual(report.ci.gates, ['integration', 'browser']);
  // Read through the check runs, never the statuses a token can post, never the artifact.
  assert.ok(api.calls.some(a => /\/check-runs\?/.test(a.at(-1))));
  assert.ok(!api.calls.some(a => /statuses|\/status$|artifacts/.test(a.at(-1))), JSON.stringify(api.calls));
});

test('ciProof: complete local receipts stay the proof, first: the API is never called', async t => {
  const p = project(t, { change: { 'src/app.ts': 'export const x = 1;\n' } });
  const run = await apv(p.repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/main', '--json']);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const api = github(p.head, s => ({ ...s, fail: 'HTTP 503' }));
  const report = await check(p, { gh: api.gh, repository: 'acme/site' });
  assert.equal(rule(report, 'preuve').status, 'ok');
  assert.match(rule(report, 'preuve').detail, /2 contrôle\(s\) prouvé\(s\)/);
  assert.equal(api.calls.length, 0);
  assert.equal(report.ci, null);
});

test('ciProof: a commit status posted by a token is no proof (only the check runs of GitHub Actions are read)', async t => {
  const p = project(t);
  const api = github(p.head, s => ({ ...s, checkRuns: [], statuses: [{ context: NAME, state: 'success', creator: { login: 'operateur' } }] }));
  const preuve = rule(await check(p, { gh: api.gh, repository: 'acme/site' }), 'preuve');
  assert.equal(preuve.status, 'refused');
  assert.match(text(preuve), /aucun check run « Preuve complète » de GitHub Actions au commit/);
  assert.match(text(preuve), /integration \(missing\), browser \(missing\)/);
});

test('ciProof: a check run of another commit is refused, even returned for this one', async t => {
  const p = project(t);
  const other = 'b'.repeat(40);
  const api = github(p.head, s => ({ ...s, checkRuns: s.checkRuns.map(c => ({ ...c, head_sha: other })) }));
  const preuve = rule(await check(p, { gh: api.gh, repository: 'acme/site' }), 'preuve');
  assert.equal(preuve.status, 'refused');
  assert.match(text(preuve), /check run 501 ignoré : commit bbbbbbbbbbbb/);
  // The run of the check suite tested another commit than the check run says.
  const moved = github(p.head, s => ({ ...s, runs: { 77: { ...s.runs[77], head_sha: other } } }));
  const r2 = rule(await check(p, { gh: moved.gh, repository: 'acme/site' }), 'preuve');
  assert.equal(r2.status, 'refused');
  assert.match(text(r2), /exécution 9001 d'un autre commit \(bbbbbbbbbbbb\)/);
});

test('ciProof: a check run of another application is refused', async t => {
  const p = project(t);
  const api = github(p.head, s => ({ ...s, checkRuns: s.checkRuns.map(c => ({ ...c, app: { slug: 'ci-forge', owner: { login: 'acme' } } })) }));
  const preuve = rule(await check(p, { gh: api.gh, repository: 'acme/site' }), 'preuve');
  assert.equal(preuve.status, 'refused');
  assert.match(text(preuve), /check run 501 ignoré : application ci-forge, pas github-actions/);
});

test('ciProof: a check run concluded otherwise than success is refused, and a later failure overrides an earlier success', async t => {
  const p = project(t);
  const failed = github(p.head, s => ({ ...s, checkRuns: s.checkRuns.map(c => ({ ...c, conclusion: 'failure' })) }));
  const r1 = rule(await check(p, { gh: failed.gh, repository: 'acme/site' }), 'preuve');
  assert.equal(r1.status, 'refused');
  assert.match(text(r1), /conclusion failure/);
  const later = github(p.head, s => ({
    ...s,
    checkRuns: [...s.checkRuns, { ...s.checkRuns[0], id: 502, conclusion: 'failure', started_at: '2026-10-09T11:00:00Z', check_suite: { id: 78 } }],
    runs: { ...s.runs, 78: { ...s.runs[77], id: 9002, check_suite_id: 78, conclusion: 'failure' } },
    jobs: { ...s.jobs, 9002: [{ ...s.jobs[9001][0], id: 502, run_id: 9002, conclusion: 'failure' }] },
  }));
  const r2 = rule(await check(p, { gh: later.gh, repository: 'acme/site' }), 'preuve');
  assert.equal(r2.status, 'refused');
  assert.match(text(r2), /check run 502 .*conclusion failure/);
  const running = github(p.head, s => ({ ...s, checkRuns: s.checkRuns.map(c => ({ ...c, status: 'in_progress', conclusion: null })) }));
  assert.match(text(rule(await check(p, { gh: running.gh, repository: 'acme/site' }), 'preuve')), /en cours \(in_progress\)/);
});

test('ciProof: the run of another workflow, or a check run outside the jobs of the run, is refused', async t => {
  const p = project(t);
  // A job named « Preuve complète » added to ci.yml by the change.
  const other = github(p.head, s => ({ ...s, runs: { 77: { ...s.runs[77], workflow_id: 44, path: '.github/workflows/ci.yml' } } }));
  const r1 = rule(await check(p, { gh: other.gh, repository: 'acme/site' }), 'preuve');
  assert.equal(r1.status, 'refused');
  assert.match(text(r1), /check run 501 ignoré : workflow \.github\/workflows\/ci\.yml, pas \.github\/workflows\/preuve\.yml/);
  // A check run created through the API with the token of a job (same application, same suite), not a job of the run.
  const forged = github(p.head, s => ({ ...s, jobs: { 9001: [{ ...s.jobs[9001][0], id: 600, check_run_url: 'https://api.github.com/repos/acme/site/check-runs/600' }] } }));
  const r2 = rule(await check(p, { gh: forged.gh, repository: 'acme/site' }), 'preuve');
  assert.equal(r2.status, 'refused');
  assert.match(text(r2), /check run 501 absent des jobs de l'exécution 9001/);
});

test('ciProof: a manual launch counts only when the workflow takes no input (inputs.pr would test another commit)', async t => {
  const withInputs = project(t, { base: { [WORKFLOW]: workflowText("  workflow_dispatch:\n    inputs:\n      pr:\n        type: string\n") } });
  const dispatch = s => ({ ...s, runs: { 77: { ...s.runs[77], event: 'workflow_dispatch' } } });
  const r1 = rule(await check(withInputs, { gh: github(withInputs.head, dispatch).gh, repository: 'acme/site' }), 'preuve');
  assert.equal(r1.status, 'refused');
  assert.match(text(r1), /workflow_dispatch : le workflow déclare des entrées \(inputs\)/);
  const without = project(t, { base: { [WORKFLOW]: workflowText('  workflow_dispatch:\n') } });
  assert.equal(rule(await check(without, { gh: github(without.head, dispatch).gh, repository: 'acme/site' }), 'preuve').status, 'ok');
  // Any other event (pull_request_target, schedule...) is refused.
  const target = github(without.head, s => ({ ...s, runs: { 77: { ...s.runs[77], event: 'pull_request_target' } } }));
  assert.match(text(rule(await check(without, { gh: target.gh, repository: 'acme/site' }), 'preuve')), /évènement pull_request_target refusé/);
});

test('ciProof: the workflow changed by the change takes it out of the CI lane: local proof required, the file named, the API never called', async t => {
  const p = project(t, { change: { [WORKFLOW]: workflowText().replace('npm run test:integration', 'true') } });
  const api = github(p.head);
  const report = await check(p, { gh: api.gh, repository: 'acme/site' });
  const preuve = rule(report, 'preuve');
  assert.equal(preuve.status, 'refused');
  assert.equal(report.ci.state, 'out_of_lane');
  assert.match(text(preuve), /hors de la voie CI .*preuve locale exigée/);
  assert.match(text(preuve), /fichier protégé modifié depuis la base : \.github\/workflows\/preuve\.yml/);
  assert.equal(api.calls.length, 0);
});

test('ciProof: a protected file of the proof changed (script test:* replaced by true, scripts/e2e, playwright.config) takes the change out of the CI lane', async t => {
  const cases = [
    [{ 'package.json': { ...BASE_FILES['package.json'], scripts: { ...BASE_FILES['package.json'].scripts, 'test:integration': 'true' } } }, /package\.json : script\(s\) modifié\(s\) : test:integration/],
    // A script the test scripts call, or an npm lifecycle script, counts as much.
    [{ 'package.json': { ...BASE_FILES['package.json'], scripts: { ...BASE_FILES['package.json'].scripts, 'e2e:integration': 'true' } } }, /package\.json : script\(s\) modifié\(s\) : e2e:integration/],
    [{ 'package.json': { ...BASE_FILES['package.json'], scripts: { ...BASE_FILES['package.json'].scripts, postinstall: 'node x.js' } } }, /package\.json : script\(s\) modifié\(s\) : postinstall/],
    [{ 'scripts/e2e/ci-stack.mjs': 'process.exitCode = 0;\n' }, /fichier protégé modifié depuis la base : scripts\/e2e\/ci-stack\.mjs/],
    [{ 'playwright.config.ts': 'export default {};\n' }, /fichier protégé modifié depuis la base : playwright\.config\.ts/],
    [{ '.npmrc': 'script-shell=/bin/true\n' }, /fichier protégé modifié depuis la base : \.npmrc/],
    [{ 'tests/support/runner.mjs': 'export {};\n' }, /fichier protégé modifié depuis la base : tests\/support\/runner\.mjs/],
  ];
  for (const [change, expected] of cases) {
    const p = project(t, { change, ciProof: { ...CI_PROOF, protectedPaths: ['tests/support/**'] } });
    const api = github(p.head);
    const report = await check(p, { gh: api.gh, repository: 'acme/site' });
    assert.equal(rule(report, 'preuve').status, 'refused', JSON.stringify(change));
    assert.equal(report.ci.state, 'out_of_lane');
    assert.match(text(rule(report, 'preuve')), expected);
    assert.equal(api.calls.length, 0);
  }
  // package.json changed outside its scripts (a dependency): still in the lane.
  const deps = project(t, { change: { 'package.json': { ...BASE_FILES['package.json'], dependencies: { zod: '3.0.0' } } } });
  assert.equal(rule(await check(deps, { gh: github(deps.head).gh, repository: 'acme/site' }), 'preuve').status, 'ok');
});

test('ciProof: read at the base, never in the change: a declaration the change adds is ignored, and said', async t => {
  const p = project(t, { ciProof: null, headConfig: { name: 'essai', gates: GATES, rules: { ciProof: CI_PROOF } } });
  const api = github(p.head);
  const report = await check(p, { gh: api.gh, repository: 'acme/site' });
  const preuve = rule(report, 'preuve');
  assert.equal(preuve.status, 'refused');
  assert.match(text(preuve), /rules\.ciProof déclarée par la PR, ignorée : seule la base commune compte/);
  assert.equal(api.calls.length, 0);
  // A change that narrows the protected paths of the base, or points to another workflow, changes nothing.
  const narrowed = project(t, {
    change: { 'scripts/e2e/ci-stack.mjs': 'process.exitCode = 0;\n' },
    headConfig: { name: 'essai', gates: GATES, rules: { ciProof: { ...CI_PROOF, workflow: '.github/workflows/autre.yml' } } },
  });
  const r2 = await check(narrowed, { gh: github(narrowed.head).gh, repository: 'acme/site' });
  assert.equal(r2.ci.state, 'out_of_lane');
});

test('ciProof: API down or offline, the rule falls back on the local proof, never an acceptance by default', async t => {
  const p = project(t);
  const down = github(p.head, s => ({ ...s, fail: 'HTTP 503: Service Unavailable' }));
  const report = await check(p, { gh: down.gh, repository: 'acme/site' });
  const preuve = rule(report, 'preuve');
  assert.equal(preuve.status, 'refused');
  assert.equal(report.ci.state, 'unavailable');
  assert.match(text(preuve), /preuve CI non vérifiable : API GitHub indisponible \(HTTP 503: Service Unavailable\) ; preuve locale exigée/);
  const offline = await check(p, { gh: null, repository: 'acme/site' });
  assert.equal(rule(offline, 'preuve').status, 'refused');
  assert.match(text(rule(offline, 'preuve')), /preuve CI non vérifiable : hors réseau/);
  const elsewhere = await check(p, { gh: github(p.head).gh, repository: null });
  assert.match(text(rule(elsewhere, 'preuve')), /preuve CI non vérifiable : dépôt distant origin hors de github\.com/);
  // A body that is not the JSON GitHub sends: unavailable, never read as a success.
  const garbled = { gh: async args => ({ args, status: 0, stdout: '<html>', stderr: '', error: null }), repository: 'acme/site' };
  assert.equal((await check(p, garbled)).ci.state, 'unavailable');
});

test('ciProof: only the checks it declares, without a clean local receipt: a local failure and an uncovered check still refuse', async t => {
  const gates = [...GATES, { id: 'lint', stage: 'full', command: node('0') }];
  const p = project(t, { gates });
  const r1 = rule(await check(p, { gh: github(p.head).gh, repository: 'acme/site' }), 'preuve');
  assert.equal(r1.status, 'refused');
  assert.match(text(r1), /contrôle\(s\) non prouvé\(s\) à .*: lint \(missing\)/);
  assert.match(text(r1), /prouvé\(s\) par la CI : integration, browser/);
  // A local receipt in failure at this commit is never hidden by the CI.
  const failing = project(t, { gates: [{ id: 'integration', stage: 'full', command: node('process.exit(3)') }, GATES[1]] });
  await apv(failing.repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/main', '--json']);
  const r2 = rule(await check(failing, { gh: github(failing.head).gh, repository: 'acme/site' }), 'preuve');
  assert.equal(r2.status, 'refused');
  assert.match(text(r2), /integration \(failed\)/);
});

test('ciProof: test files the change adds under repeatChanged are not repeated by the CI: that check needs its local proof', async t => {
  const repeat = { paths: ['tests/e2e/**/*.e2e.ts'], command: [...node('0'), '--repeat-each={{repeat}}'], reference: 'origin/main' };
  const gates = [GATES[0], { ...GATES[1], repeatChanged: repeat }];
  const p = project(t, { gates, change: { 'tests/e2e/carte.e2e.ts': 'test("carte", () => {});\n' } });
  const r = rule(await check(p, { gh: github(p.head).gh, repository: 'acme/site' }), 'preuve');
  assert.equal(r.status, 'refused');
  assert.match(text(r), /browser : 1 fichier\(s\) de test à répéter \(repeatChanged\), que la CI ne répète pas : tests\/e2e\/carte\.e2e\.ts/);
  assert.match(text(r), /browser \(missing\)/);
  assert.doesNotMatch(text(r), /integration \(missing\)/);
});

test('ciProof: a job passed only once relaunched (run_attempt above 1) refuses the rule instable', async t => {
  const p = project(t);
  const api = github(p.head, s => ({ ...s, runs: { 77: { ...s.runs[77], run_attempt: 2 } } }));
  const report = await check(p, { gh: api.gh, repository: 'acme/site' });
  assert.equal(rule(report, 'preuve').status, 'ok');
  const instable = rule(report, 'instable');
  assert.equal(instable.status, 'refused');
  assert.match(instable.problems[0], /integration, browser \(job de la CI relancé : tentative 2 de l'exécution 9001\)/);
});

test('ciProof: the configuration key is validated by the loader and shown by apv status', async t => {
  const p = project(t, { ciProof: { ...CI_PROOF, protectedPaths: ['tests/support/**'] } });
  const status = await apv(p.repo, ['status']);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Preuve CI \(rules\.ciProof\) : \.github\/workflows\/preuve\.yml, job preuve-complete, check run « Preuve complète », contrôles integration, browser/);
  assert.match(status.stdout, /tests\/support\/\*\*/);
  const json = (await apv(p.repo, ['status', '--json'])).json();
  assert.equal(json.ciProof.settings.workflow, WORKFLOW);
  assert.ok(json.ciProof.settings.protectedPaths.includes('scripts/e2e/**'));
  const none = project(t, { ciProof: null });
  assert.match((await apv(none.repo, ['status'])).stdout, /Preuve CI \(rules\.ciProof\) : non déclarée \(preuve locale seule\)/);
  // Unknown key, a workflow outside .github/workflows, a path out of the repository: refused by the loader.
  for (const bad of [{ ...CI_PROOF, extra: 1 }, { ...CI_PROOF, workflow: 'preuve.yml' }, { ...CI_PROOF, protectedPaths: ['../x'] }]) {
    put(none.repo, '.apv/config.json', { name: 'essai', gates: GATES, rules: { ciProof: bad } });
    assert.throws(() => loadConfig(none.repo), /ciProof/);
  }
});
