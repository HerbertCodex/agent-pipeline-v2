import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apv } from './cli-helpers.mjs';
import { ALL_CAPTURES, TEST_KEY, commonDirOf, operatorSays, png, seedReview, waive } from './support/rules.mjs';
import { waiverFor, anchoredQuote, journalEntry } from '../dist/rules/operator.js';
import { isScreen } from '../dist/rules/screens.js';
import { runsCommand } from '../dist/rules/required.js';
import { nearTimeout, busyReasons } from '../dist/gates/run.js';
import { sealReview } from '../dist/rules/reviews.js';
import { lockDevice } from '../hooks/scripts/harness-guard.mjs';

/**
 * The rules checked before any merge (docs/REGLES.md): each one refuses what it protects against and accepts the same
 * change once the correction is there; a waiver counts only in words the operator typed himself.
 */

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim();
const node = code => [process.execPath, '-e', code];
const put = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };

/**
 * An origin and a clone: main holds `base` (files, with .apv/config.json), the branch feat adds `change`. The head of
 * feat is checked out. `gates` defaults to one check of stage full that passes.
 */
function project(t, { base = {}, change = {}, gates = [{ id: 'unit', stage: 'full', command: node('0') }], config = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apv3-rules-'));
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
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'change', '--allow-empty'); git(repo, 'push', '-q', 'origin', 'feat');
  const head = git(repo, 'rev-parse', 'HEAD');
  return {
    root, repo, head,
    check: async () => { const r = await apv(repo, ['rules', 'check', '--commit', head, '--target', 'origin/main', '--json']); return { ...r, report: r.json() }; },
    prove: async () => {
      const r = await apv(repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/main', '--json']);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      return r.json();
    },
  };
}
const rule = (report, id) => report.rules.find(r => r.rule === id);
const spawnSyncOk = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;

test('preuve: refused without the full suite at the exact commit, accepted once proven', async t => {
  const p = project(t, { change: { 'notes.txt': 'x\n' } });
  const before = await p.check();
  assert.equal(before.code, 1);
  assert.equal(rule(before.report, 'preuve').status, 'refused');
  assert.match(rule(before.report, 'preuve').problems[0], /unit \(missing\)/);
  assert.match(rule(before.report, 'preuve').todo.join('\n'), /apv gates run --stage full --base origin\/main/);
  await p.prove();
  const after = await p.check();
  assert.equal(rule(after.report, 'preuve').status, 'ok');
  assert.equal(rule(after.report, 'instable').status, 'ok');
});

test('instable: a check passed only after the relaunch of its tests refuses the merge; a first pass green is accepted', async t => {
  const marker = join(mkdtempSync(join(tmpdir(), 'apv3-rules-flaky-')), 'first');
  t.after(() => rmSync(dirname(marker), { recursive: true, force: true }));
  const first = `const fs=require("fs"); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, ""); console.log("  1) [chromium] › a.spec.ts:3:5 › carte"); process.exit(1); }`;
  const p = project(t, { change: { 'notes.txt': 'x\n' }, gates: [{ id: 'browser', stage: 'full', command: node(first),
    retryFailed: { command: node('0'), testPattern: '^\\s*\\d+\\) (\\[[^\\]]+\\] › .+?)\\s*$' } }] });
  await p.prove();
  const flaky = await p.check();
  assert.equal(rule(flaky.report, 'preuve').status, 'ok', 'the proof itself holds');
  assert.equal(rule(flaky.report, 'instable').status, 'refused');
  assert.match(rule(flaky.report, 'instable').problems[0], /réussi\(s\) seulement après relance : browser/);
  assert.match(rule(flaky.report, 'instable').todo[0], /bug possible du produit/);
  // The same commit proven again, green at the first pass (the marker exists): the latest receipt decides.
  await p.prove();
  assert.equal(rule((await p.check()).report, 'instable').status, 'ok');
});

test('relecture: every domain of the plan recorded at this commit by its reviewer, without critical nor high finding', async t => {
  const p = project(t, { change: { 'src/server/api.ts': 'export const x = 1;\n' } });
  const none = await p.check();
  const r0 = rule(none.report, 'relecture');
  assert.equal(r0.status, 'refused');
  assert.match(r0.problems.join('\n'), /securite : aucune relecture enregistrée/);
  assert.match(r0.todo.join('\n'), /apv:qa-securite sur une copie détachée/);
  const retained = none.report.rules.find(r => r.rule === 'relecture').detail.replace(/^.*: /, '').split(', ');
  // A high finding refuses; a record under another agent's name proves nothing.
  for (const d of retained) seedReview(p.repo, p.head, d, { high: d === 'securite' ? 1 : 0, captures: d === 'fidelite' ? ALL_CAPTURES : [] });
  assert.match(rule((await p.check()).report, 'relecture').problems.join('\n'), /securite : 0 constat\(s\) critique\(s\) et 1 haut\(s\)/);
  seedReview(p.repo, p.head, 'securite', { reviewer: 'apv:implementer', at: '2026-09-30T11:00:00.000Z' });
  assert.match(rule((await p.check()).report, 'relecture').problems.join('\n'), /securite : relecture inutilisable \(relecteur apv:implementer/);
  seedReview(p.repo, p.head, 'securite', { at: '2026-09-30T12:00:00.000Z' });
  const ok = await p.check();
  assert.equal(rule(ok.report, 'relecture').status, 'ok', JSON.stringify(rule(ok.report, 'relecture')));
  // A record for another commit never counts.
  git(p.repo, 'commit', '-q', '--allow-empty', '-m', 'suite');
  const next = git(p.repo, 'rev-parse', 'HEAD');
  const moved = await apv(p.repo, ['rules', 'check', '--commit', next, '--target', 'origin/main', '--json']);
  assert.equal(rule(moved.json(), 'relecture').status, 'refused');
});

test('captures: a screen added or changed needs the four captures of the fidelity review; a server change needs none', async t => {
  const p = project(t, { change: { 'src/routes/carte/+page.svelte': '<div class="carte">x</div>\n' } });
  const r0 = rule((await p.check()).report, 'captures');
  assert.equal(r0.status, 'refused');
  assert.match(r0.detail, /1 écran\(s\) ajouté\(s\) ou modifié\(s\) \(src\/routes\/carte\/\+page\.svelte\)/);
  assert.match(r0.problems[0], /desktop:light, desktop:dark, phone:light, phone:dark/);
  seedReview(p.repo, p.head, 'fidelite', { captures: [['desktop', 'light'], ['phone', 'light']] });
  assert.match(rule((await p.check()).report, 'captures').problems[0], /absente\(s\) de la relecture fidelite .*: desktop:dark, phone:dark/);
  seedReview(p.repo, p.head, 'fidelite', { captures: ALL_CAPTURES, at: '2026-09-30T12:00:00.000Z' });
  assert.equal(rule((await p.check()).report, 'captures').status, 'ok');
  // A capture file changed after the record: the record proves nothing.
  const dir = join(commonDirOf(p.repo), 'apv', 'reviews', p.head, 'fidelite');
  const latest = JSON.parse(readFileSync(join(dir, readdirSync(dir).filter(n => n.endsWith('.json')).sort().at(-1)), 'utf8'));
  writeFileSync(join(dir, latest.captures[0].file), png(99));
  assert.equal(rule((await p.check()).report, 'captures').status, 'refused');
  const server = project(t, { change: { 'scripts/job.sh': 'echo ok\n' } });
  const s = await server.check();
  assert.equal(rule(s.report, 'captures').status, 'not_applicable');
});

test('captures: a command-line tool without any screen has nothing to capture, even when the plan retains fidelite', async t => {
  // The case of a CLI (agent-pipeline-v2 #110): unclassified source files keep every domain, fidelite included, but no
  // screen is added nor changed (the rule maquette says so too): captures are not applicable, with the reason.
  const cli = { 'package.json': { name: 'outil', bin: { outil: 'dist/cli.js' } } };
  const p = project(t, { base: cli, change: { 'src/commands/tests.ts': 'export const run = () => 0;\n', 'src/cli.ts': 'export {};\n' } });
  const report = (await p.check()).report;
  assert.match(rule(report, 'relecture').detail, /fidelite/, 'the plan retains fidelite for unclassified files');
  const captures = rule(report, 'captures');
  assert.equal(captures.status, 'not_applicable', JSON.stringify(captures));
  assert.match(captures.detail, /aucun écran ajouté ni modifié/);
  assert.equal(rule(report, 'maquette').status, 'not_applicable');
  // A component outside the routes is not a screen either: no capture asked, the fidelity review stays required.
  const component = project(t, { change: { 'src/lib/components/Carte.svelte': '<div class="carte">x</div>\n' } });
  const c = (await component.check()).report;
  assert.equal(rule(c, 'captures').status, 'not_applicable');
  assert.match(rule(c, 'relecture').detail, /fidelite/);
});

test('controles: a web project declares reuse, code-map and structure, mandatory; a project that lacks one is refused', async t => {
  const web = { 'package.json': { name: 'x', dependencies: { svelte: '5.0.0' } } };
  const gates = [{ id: 'unit', stage: 'full', command: node('0') },
    { id: 'reuse', command: ['apv', 'reuse', 'check', '--base', '{{baseSha}}'], mandatory: true },
    { id: 'code-map', stage: 'full', command: ['apv', 'map', '--check'], mandatory: true }];
  const lacking = project(t, { base: web, gates, change: { 'notes.txt': 'x\n' } });
  const r = rule((await lacking.check()).report, 'controles');
  assert.equal(r.status, 'refused');
  assert.match(r.problems.join('\n'), /structure \(apv structure check\) absent de \.apv\/config\.json/);
  assert.match(r.todo[0], /"mandatory": true/);
  const optional = project(t, { base: web, gates: [...gates, { id: 'structure', command: ['apv', 'structure', 'check'] }], change: { 'notes.txt': 'x\n' } });
  assert.match(rule((await optional.check()).report, 'controles').problems.join('\n'), /structure .*déclaré sans "mandatory": true/);
  // The pull request that adds the check proves itself with it: accepted.
  const adding = project(t, { base: web, gates, change: { '.apv/config.json': { name: 'essai', gates: [...gates, { id: 'structure', command: ['node', '/p/dist/cli.js', 'structure', 'check'], mandatory: true }] } } });
  assert.equal(rule((await adding.check()).report, 'controles').status, 'ok');
  // Not a web project: nothing required, unless rules.requiredGates says so.
  const cli = project(t, { change: { 'notes.txt': 'x\n' } });
  assert.equal(rule((await cli.check()).report, 'controles').status, 'not_applicable');
  const custom = project(t, { config: { rules: { requiredGates: [{ id: 'a11y', command: ['npm', 'run', 'check:a11y'] }] } }, change: { 'notes.txt': 'x\n' } });
  assert.match(rule((await custom.check()).report, 'controles').problems.join('\n'), /a11y \(npm run check:a11y\) absent/);
});

test('maquette: a new or changed screen is covered by a mockup validated by the operator, at the base or in his own words', async t => {
  const quote = 'Je valide la maquette des articles, on part là-dessus';
  const mockup = (id, extra) => ({ id, subject: 'Maquette', value: 'fichier docs/design/articles-validee.html, sha256 ' + 'a'.repeat(64), enforcement: 'product',
    status: 'confirmed', source: 'operator', sourceQuote: quote, rationale: 'Validée.', supersedes: [], clarificationQuestion: '', interpretations: [], ...extra });
  const page = { 'src/routes/articles/+page.svelte': '<h1>Articles</h1>\n', 'src/routes/articles/+page.server.ts': 'export const load = () => ({});\n' };
  const bare = project(t, { change: page });
  const r0 = rule((await bare.check()).report, 'maquette');
  assert.equal(r0.status, 'refused');
  assert.deepEqual(r0.problems, ['src/routes/articles/+page.svelte : aucune maquette validée ne le couvre (portée ou écrans de la décision)']);
  // The mockup comes with the pull request: its quote must be among the operator's messages (an agent can write the ledger).
  const ledger = { schemaVersion: 1, decisions: [mockup('maquette-articles-validee', { scope: { paths: ['src/routes/articles/**'] } })] };
  const brought = project(t, { change: { ...page, '.apv/DECISIONS.json': ledger } });
  const r1 = rule((await brought.check()).report, 'maquette');
  assert.equal(r1.status, 'refused');
  assert.match(r1.problems[0], /maquette\(s\) maquette-articles-validee de la PR, dont la validation n'est pas dans les messages de l'opérateur/);
  operatorSays(brought.repo, `Super. ${quote} !`);
  const r2 = rule((await brought.check()).report, 'maquette');
  assert.equal(r2.status, 'ok');
  assert.match(r2.detail, /validée dans la session/);
  // Already on the target: covered, by its scope or by the screens it names.
  const merged = project(t, { base: { '.apv/DECISIONS.json': { schemaVersion: 1, decisions: [mockup('maquette-articles-validee', { value: 'fichier x.html, sha256 ' + 'a'.repeat(64) + '. Écrans : articles.' })] } }, change: page });
  assert.equal(rule((await merged.check()).report, 'maquette').status, 'ok');
  // No screen changed: nothing to cover.
  assert.equal(rule((await project(t, { change: { 'src/lib/util.ts': 'export {};\n' } }).check()).report, 'maquette').status, 'not_applicable');
});

test('waiver: only the operator lifts a refusal, in his own words, for this commit and this rule, with a reason', async t => {
  const p = project(t, { change: { 'notes.txt': 'x\n' } });
  await p.prove();
  const refused = await p.check();
  assert.equal(refused.code, 1);
  assert.match(rule(refused.report, 'relecture').todo.at(-1), new RegExp(`dérogation relecture ${p.head.slice(0, 12)} : <ta raison>`));
  // Another commit, another rule, no reason: nothing lifted.
  operatorSays(p.repo, `dérogation relecture ${'0'.repeat(12)} : correctif urgent en production`);
  operatorSays(p.repo, `dérogation captures ${p.head.slice(0, 12)} : correctif urgent en production`);
  operatorSays(p.repo, `dérogation relecture ${p.head.slice(0, 12)}`);
  assert.equal((await p.check()).code, 1);
  // The ledger an agent can write is not the operator's word.
  operatorSays(p.repo, `Dérogation relecture ${p.head.slice(0, 12)} : correctif urgent validé au téléphone`);
  const waived = await p.check();
  assert.equal(waived.code, 0, JSON.stringify(waived.report.rules, null, 1));
  assert.equal(rule(waived.report, 'relecture').status, 'waived');
  assert.match(rule(waived.report, 'relecture').waiver.reason, /correctif urgent validé au téléphone/);
  const human = await apv(p.repo, ['rules', 'check', '--commit', p.head, '--target', 'origin/main']);
  assert.match(human.stdout, /relecture \(.*\) : DÉROGATION/);
  assert.match(human.stdout, /Règles respectées\./);
});

test('operator journal: quotes and waivers are compared without typography, never a short quote', () => {
  const said = text => journalEntry(text, { at: 't', session: 's' }, TEST_KEY);
  const messages = [said('Je valide la maquette\u00a0: on part là-dessus'), said('ok')];
  assert.ok(anchoredQuote(messages, 'je valide la maquette : on part là-dessus'));
  assert.equal(anchoredQuote(messages, 'ok'), null, 'too short to anchor anything');
  assert.equal(anchoredQuote(messages, 'Je valide la maquette : on part ailleurs'), null);
  const sha = 'abcdef0123456789'.repeat(3).slice(0, 40);
  assert.equal(waiverFor([said(`derogation maquette ${sha.slice(0, 11)} : trop court comme préfixe`)], 'maquette', sha), null);
  assert.ok(waiverFor([said(`Bonjour\ndérogation maquette pour ${sha} : écran déjà validé à l'oral`)], 'maquette', sha));
});

test('screens: pages, layouts and error pages of the known routers; never server code', () => {
  for (const f of ['src/routes/+page.svelte', 'src/routes/(app)/liste/+layout.svelte', 'src/routes/x/+error.svelte', 'app/page.tsx', 'src/app/compte/layout.tsx', 'pages/index.vue', 'src/pages/blog/[slug].astro', 'app/routes/_index.tsx']) {
    assert.ok(isScreen(f), f);
  }
  for (const f of ['src/routes/+page.server.ts', 'src/routes/api/+server.ts', 'src/routes/+page.ts', 'pages/api/users.ts', 'app/api/route.ts', 'src/lib/Carte.svelte']) {
    assert.ok(!isScreen(f), f);
  }
  assert.ok(isScreen('src/views/Accueil.vue', [/^src\/views\//]), 'rules.screens');
});

test('required checks are recognised by their command, wrapped or not', () => {
  assert.ok(runsCommand(['apv', 'structure', 'check'], ['apv', 'structure', 'check']));
  assert.ok(runsCommand(['node', '/x/dist/cli.js', 'reuse', 'check', '--base', '{{baseSha}}'], ['apv', 'reuse', 'check']));
  assert.ok(runsCommand(['npm', 'run', 'check:a11y'], ['npm', 'run', 'check:a11y']));
  assert.ok(!runsCommand(['echo', 'apv', 'structure', 'check'], ['apv', 'structure', 'check']), 'the words must be the command');
  assert.ok(!runsCommand(['apv', 'map'], ['apv', 'map', '--check']));
});

test('near timeout: a receipt at 85 % of its timeout or more says so, each pass of a relaunch compared alone', () => {
  assert.equal(nearTimeout({ status: 'passed', durationMs: 552_000 }, 600_000)?.percent, 92);
  assert.equal(nearTimeout({ status: 'passed', durationMs: 500_000 }, 600_000), null);
  assert.equal(nearTimeout({ status: 'timed_out', durationMs: 600_100 }, 600_000)?.percent, 100);
  assert.equal(nearTimeout({ status: 'passed_after_retry', durationMs: 900_000, retry: { first: { durationMs: 450_000 } } }, 600_000), null);
  assert.equal(nearTimeout({ status: 'not_required', durationMs: 0 }, 1), null);
});

test('near timeout: the run and verify warn, the receipt records it (durations injected, no real waiting)', async t => {
  const { runGates } = await import('../dist/gates/run.js');
  const { loadConfig } = await import('../dist/config/load.js');
  const p = project(t, { change: { 'notes.txt': 'x\n' }, gates: [{ id: 'lent', stage: 'full', timeoutMs: 100_000, command: node('0') }, { id: 'vif', stage: 'full', timeoutMs: 100_000, command: node('0') }] });
  const logs = [];
  const result = await runGates({ repo: p.repo, config: loadConfig(p.repo).config, stage: 'full', log: l => logs.push(l),
    hooks: { durationOf: (gate, measured) => gate === 'lent' ? 92_000 : measured } });
  assert.equal(result.ok, true);
  const receipts = Object.fromEntries(result.receipts.map(r => [r.gateId, r]));
  assert.deepEqual(receipts.lent.nearTimeout, { timeoutMs: 100_000, percent: 92 });
  assert.equal(receipts.vif.nearTimeout, undefined);
  assert.ok(logs.some(l => /ATTENTION : lent a pris 92 % de son délai \(100 s\)/.test(l)), logs.join('\n'));
  const verify = await apv(p.repo, ['gates', 'verify', '--commit', 'HEAD', '--against', 'origin/main']);
  assert.match(verify.stdout, /ATTENTION, délai presque atteint : lent 92 % de 100 s/);
  const json = await apv(p.repo, ['gates', 'verify', '--commit', 'HEAD', '--against', 'origin/main', '--json']);
  assert.deepEqual(json.json().nearTimeout, [{ gateId: 'lent', timeoutMs: 100_000, percent: 92 }]);
});

test('busy stacks: a port held by another process or a stack whose lock is held refuse the full suite', () => {
  const ports = { ports: [4173], stopped: [], left: [{ pid: 42, ports: [4173], command: 'npx playwright test', worktree: '/w/agent', reason: 'other-copy' }], unsupported: null };
  const stacks = [{ id: '1', lockFile: '/l/e2e.lock', config: {}, resource: null, envFile: null }, { id: '2', lockFile: '/l/e2e-2.lock', config: {}, resource: null, envFile: null }];
  const reasons = busyReasons(ports, stacks, file => file !== '/l/e2e.lock');
  assert.deepEqual(reasons, ['port 4173 tenu par le pid 42 (une autre copie du dépôt : /w/agent) : npx playwright test', 'pile 1 : son verrou (/l/e2e.lock) est tenu']);
  assert.deepEqual(busyReasons(null, stacks, () => true), []);
});

test('apv review record: the reviewer records at the exact commit, from a clean copy, with a report citing it and real captures', async t => {
  const p = project(t, { change: { 'src/routes/carte/+page.svelte': '<div>x</div>\n' } });
  const report = join(p.root, 'rapport.md');
  writeFileSync(report, `# Relecture fidélité du commit ${p.head}\n${'Constat : rien à signaler sur cet écran. '.repeat(10)}\n`);
  const shots = ALL_CAPTURES.map(([v, th], k) => { const f = join(p.root, `${v}-${th}.png`); writeFileSync(f, png(k + 10)); return `${v}:${th}:${f}`; });
  const args = ['review', 'record', '--commit', p.head, '--domain', 'fidelite', '--reviewer', 'apv:qa-fidelite', '--report', report, '--critical', '0', '--high', '0', '--medium', '1', '--low', '2'];
  const wrongAgent = await apv(p.repo, [...args.slice(0, 6), '--reviewer', 'apv:implementer', ...args.slice(8)]);
  assert.equal(wrongAgent.code, 1);
  assert.match(wrongAgent.stderr, /la relecture fidelite s'enregistre par l'agent qa-fidelite/);
  git(p.repo, 'switch', '-q', 'main');
  const elsewhere = await apv(p.repo, args);
  assert.equal(elsewhere.code, 1);
  assert.match(elsewhere.stderr, /copie détachée au commit exact/);
  git(p.repo, 'switch', '-q', '--detach', p.head);
  const sameImage = await apv(p.repo, [...args, '--capture', shots[0], '--capture', shots[0].replace('desktop:light', 'phone:dark')]);
  assert.match(sameImage.stderr, /la même image sert pour desktop:light et phone:dark/);
  writeFileSync(join(p.root, 'faux.png'), 'pas une image');
  assert.match((await apv(p.repo, [...args, '--capture', `phone:dark:${join(p.root, 'faux.png')}`])).stderr, /ni PNG, ni JPEG, ni WebP/);
  writeFileSync(join(p.root, 'court.md'), 'ok');
  assert.match((await apv(p.repo, [...args.slice(0, 8), '--report', join(p.root, 'court.md'), ...args.slice(10)])).stderr, /rapport trop court/);
  const ok = await apv(p.repo, [...args, ...shots.flatMap(s => ['--capture', s])]);
  assert.equal(ok.code, 0, ok.stderr);
  const id = /Enregistrement (\S+)/.exec(ok.stdout)[1];
  // Not sealed yet: the PostToolUse hook seals it when the reviewer agent ran the command.
  assert.match(rule((await p.check()).report, 'relecture').problems.join('\n'), /fidelite : relecture inutilisable \(relecture non scellée/);
  assert.equal(sealReview(commonDirOf(p.repo), id, 'fidelite', 'apv:qa-fidelite', TEST_KEY).problem, null);
  assert.match(ok.stdout, /Relecture fidelite enregistrée à [0-9a-f]{12} par apv:qa-fidelite .* captures desktop:light, desktop:dark, phone:light, phone:dark/);
  const shown = await apv(p.repo, ['review', 'show', '--commit', p.head]);
  assert.match(shown.stdout, /fidelite : apv:qa-fidelite, .*, critique 0, haut 0, moyen 1, bas 2, 4 capture\(s\)/);
  assert.equal(rule((await p.check()).report, 'captures').status, 'ok');
});

test('apv stack merge stops on the rules before any merge; apv stack plan lists them', async t => {
  const p = project(t, { change: { 'notes.txt': 'x\n' } });
  const { fileURLToPath } = await import('node:url');
  const fakeGh = fileURLToPath(new URL('./support/fake-gh.mjs', import.meta.url));
  const state = join(p.root, 'gh.json');
  writeFileSync(state, JSON.stringify({ prs: { 21: { number: 21, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'feat', headRefOid: p.head,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [] } }, behavior: {}, calls: [] }));
  const env = { APV_GH: fakeGh, FAKE_GH_STATE: state, APV_STACK_POLL_MS: '5', APV_STACK_POLL_ATTEMPTS: '3' };
  const plan = await apv(p.repo, ['stack', 'plan', '21'], env);
  assert.equal(plan.code, 1);
  assert.match(plan.stdout, /ANOMALIE : PR #21 : règles avant fusion refusées à [0-9a-f]{12}/);
  assert.match(plan.stdout, /preuve \(suite complète prouvée au commit exact\) : REFUSÉ/);
  const merge = await apv(p.repo, ['stack', 'merge', '21'], { ...env, APV_ALLOW_MERGE: '1' });
  assert.equal(merge.code, 1);
  const calls = JSON.parse(readFileSync(state, 'utf8')).calls.map(c => c.slice(0, 2).join(' '));
  assert.ok(!calls.includes('pr merge'), 'nothing merged');
  // Proven, reviewed: merged.
  await p.prove();
  seedReview(p.repo, p.head, 'securite');
  for (const d of ['fidelite', 'donnees', 'rgpd']) seedReview(p.repo, p.head, d, { captures: d === 'fidelite' ? ALL_CAPTURES : [] });
  const merged = await apv(p.repo, ['stack', 'merge', '21'], { ...env, APV_ALLOW_MERGE: '1' });
  assert.equal(merged.code, 0, merged.stdout + merged.stderr);
  assert.match(merged.stdout, /Règles avant la fusion de la PR #21 : respectées/);
  assert.match(merged.stdout, /Rapport de fusion :\nProtection de branche : [^\n]*\nAudit des fusions sur origin\/main/, 'said once, at the head of the report');
  const { readMergeTraces } = await import('../dist/rules/merges.js');
  assert.deepEqual(readMergeTraces(commonDirOf(p.repo)).map(m => [m.pr, m.head]), [[21, p.head]], 'a signed trace for apv audit merges');
  void waive;
});

test('audit merges: a commit no signed trace of apv stack merge accounts for is named; a traced merge or squash is not', async t => {
  const { writeMergeTrace, auditMerges } = await import('../dist/rules/merges.js');
  const p = project(t, { change: { 'notes.txt': 'x\n' } });
  const common = commonDirOf(p.repo);
  // Merged by the tool (merge commit, second parent = the head): traced.
  git(p.repo, 'switch', '-q', 'main');
  git(p.repo, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #1', p.head);
  const merged = git(p.repo, 'rev-parse', 'HEAD');
  writeMergeTrace(common, { pr: 1, head: p.head, target: 'main', method: 'merge', mergeCommit: null, at: new Date(Date.now() - 60_000).toISOString() }, TEST_KEY);
  // Pushed directly: nothing accounts for it.
  put(p.repo, 'direct.txt', 'x\n'); git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'poussée directe');
  const direct = git(p.repo, 'rev-parse', 'HEAD');
  // Squashed by the tool: its trace names the merge commit.
  put(p.repo, 'squash.txt', 'x\n'); git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'Squash (#2)');
  const squash = git(p.repo, 'rev-parse', 'HEAD');
  writeMergeTrace(common, { pr: 2, head: 'f'.repeat(40), target: 'main', method: 'squash', mergeCommit: squash, at: new Date().toISOString() }, TEST_KEY);
  // A forged trace (not signed with the key) accounts for nothing.
  const forged = join(common, 'apv', 'merges', 'forged.json');
  writeFileSync(forged, JSON.stringify({ v: 1, pr: 3, head: 'e'.repeat(40), target: 'main', method: 'merge', mergeCommit: direct, at: new Date().toISOString(), sig: '0'.repeat(64) }));
  git(p.repo, 'push', '-q', 'origin', 'main');
  const audit = auditMerges(p.repo, common, 'origin/main', { since: new Date(Date.now() - 3_600_000).toISOString() });
  // The base commit of the fixture was pushed directly too: named as well.
  assert.deepEqual(audit.unaccounted.map(c => c.subject), ['poussée directe', 'base'], JSON.stringify(audit));
  assert.equal(audit.unaccounted[0].sha, direct);
  assert.equal(audit.traces, 2);
  assert.ok(!audit.unaccounted.some(c => c.sha === merged || c.sha === squash));
  const cli = await apv(p.repo, ['audit', 'merges', '--since', new Date(Date.now() - 3_600_000).toISOString().slice(0, 10)]);
  assert.equal(cli.code, 1);
  assert.match(cli.stdout, new RegExp(`ATTENTION : 2 commit\\(s\\) arrivé\\(s\\) sans apv stack merge[^]*${direct.slice(0, 12)} .* commit : poussée directe`));
  const status = await apv(p.repo, ['status']);
  assert.match(status.stdout, /Audit des fusions sur origin\/main/);
  assert.match(status.stdout, /Protection de branche : dépôt distant origin hors de github\.com : protection de branche non vérifiée\./);
  assert.match(status.stdout, /Journal de l'opérateur : aucun message de l'opérateur reçu/);
  // 7. A key created this week: apv status reminds to back it up.
  const { ensureAnchorKey } = await import('../dist/rules/operator.js');
  ensureAnchorKey(common);
  assert.match((await apv(p.repo, ['status'])).stdout, /Clé d'ancrage créée le \d{4}-\d\d-\d\d : l'opérateur la sauvegarde hors de cette machine/);
  assert.equal((await apv(p.repo, ['audit', 'merges', '--since', 'hier'])).code, 2);
});

test('branch protection: available and set, weak, absent with the steps, or unavailable on the free plan, said once and never a refusal', async t => {
  const { branchProtection } = await import('../dist/rules/protection.js');
  const p = project(t, { change: { 'notes.txt': 'x\n' } });
  git(p.repo, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
  const gh = answers => async args => {
    const path = args[1];
    const [status, body] = answers.find(([re]) => re.test(path))?.slice(1) ?? [1, 'gh: Not Found (HTTP 404)'];
    return { args, status, stdout: status === 0 ? body : '', stderr: status === 0 ? '' : body, error: null };
  };
  const repo = [/^repos\/o\/r$/, 0, JSON.stringify({ default_branch: 'main', private: true })];
  const upgrade = 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)';
  const free = await branchProtection(p.repo, gh([repo, [/protection$/, 1, upgrade], [/rules\/branches/, 0, '[]']]));
  assert.equal(free.state, 'unavailable');
  assert.match(free.message, /dépôt privé en plan gratuit\) : les garde-fous du plugin et l'audit des fusions \(apv audit merges\) en tiennent lieu/);
  const absent = await branchProtection(p.repo, gh([repo, [/protection$/, 1, 'gh: Branch not protected (HTTP 404)'], [/rules\/branches/, 0, '[]']]));
  assert.equal(absent.state, 'absent');
  assert.match(absent.message, /main non protégée sur GitHub : réglage de l'opérateur sur GitHub : Settings > Rules > Rulesets .* PR obligatoire avant fusion, force-push bloqué/);
  const ruleset = await branchProtection(p.repo, gh([repo, [/protection$/, 1, 'gh: Branch not protected (HTTP 404)'], [/rules\/branches/, 0, JSON.stringify([{ type: 'pull_request' }, { type: 'non_fast_forward' }, { type: 'deletion' }])]]));
  assert.equal(ruleset.state, 'ok');
  const weak = await branchProtection(p.repo, gh([repo, [/protection$/, 0, JSON.stringify({ required_pull_request_reviews: {}, allow_force_pushes: { enabled: false }, enforce_admins: { enabled: false } })], [/rules\/branches/, 0, '[]']]));
  assert.deepEqual([weak.state, weak.missing], ['weak', ['règles appliquées aux administrateurs']]);
  git(p.repo, 'remote', 'set-url', 'origin', join(p.root, 'origin.git'));
});

test('stack merge never takes --offline; the busy refusal names the preview server and how to stop it', async t => {
  const merge = await apv(tmpdir(), ['stack', 'merge', '12', '--offline'], { APV_ALLOW_MERGE: '1' });
  assert.equal(merge.code, 2);
  assert.match(merge.stderr, /offline/);
  const ports = { ports: [4173], stopped: [], left: [{ pid: 7, ports: [4173], command: 'node build', worktree: '/r', reason: 'main-checkout' }], unsupported: null };
  assert.match(busyReasons(ports, [], () => true, [4173])[0], /c'est le serveur de l'aperçu vivant : apv preview stop/);
  assert.doesNotMatch(busyReasons(ports, [], () => true, [5000])[0], /aperçu/);
});

test('review 99, MOYEN 8: the migrations are those the base declares (and the commit), never the working tree', async t => {
  // The base declares its migrations under docs/changes (a neutral place otherwise); the change adds one there and moves
  // db.migrations away in its commit, then once more in the working tree: the data review is still asked.
  const p = project(t, { config: { db: { migrations: ['docs/changes/*.md'] } }, change: { 'docs/changes/001.md': 'alter table x;\n' } });
  const config = JSON.parse(readFileSync(join(p.repo, '.apv/config.json'), 'utf8'));
  writeFileSync(join(p.repo, '.apv/config.json'), JSON.stringify({ ...config, db: { migrations: ['ailleurs/*.sql'] } }));
  const r = await p.check();
  const relecture = rule(r.report, 'relecture');
  assert.match(relecture.detail, /relectures demandées par le diff : .*donnees/, JSON.stringify(relecture));
  const { loadDbConfigAtCommit } = await import('../dist/db/config.js');
  assert.deepEqual(loadDbConfigAtCommit(p.repo, p.head).config.migrations, ['docs/changes/*.md']);
  assert.deepEqual(loadDbConfigAtCommit(p.repo, 'HEAD~1').config.migrations, ['docs/changes/*.md']);
});

test('review 99, MOYEN 10: a rebase merge is accounted for whole by its trace (every commit it landed)', async t => {
  const { writeMergeTrace, auditMerges } = await import('../dist/rules/merges.js');
  const p = project(t, { change: { 'notes.txt': 'x\n' } });
  const common = commonDirOf(p.repo);
  git(p.repo, 'switch', '-q', 'main');
  const since = new Date(Date.now() - 60_000).toISOString();
  // Three commits rebased onto main by GitHub; the trace names the last one and their number.
  for (const n of [1, 2, 3]) { put(p.repo, `r${n}.txt`, `${n}\n`); git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', `rebasé ${n}`); }
  const last = git(p.repo, 'rev-parse', 'HEAD');
  writeMergeTrace(common, { pr: 7, head: 'a'.repeat(40), target: 'main', method: 'rebase', mergeCommit: last, commits: 3, at: new Date().toISOString() }, TEST_KEY);
  // One more pushed directly after: still named.
  put(p.repo, 'direct.txt', 'x\n'); git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'poussée directe');
  git(p.repo, 'push', '-q', 'origin', 'main');
  const audit = auditMerges(p.repo, common, 'origin/main', { since: new Date(Date.parse(since) - 3_600_000).toISOString() });
  assert.deepEqual(audit.unaccounted.map(c => c.subject), ['poussée directe', 'base'], JSON.stringify(audit.unaccounted));
  // A trace without its number accounts for its last commit only, as before.
  const bare = project(t, { change: { 'notes.txt': 'x\n' } });
  git(bare.repo, 'switch', '-q', 'main');
  for (const n of [1, 2]) { put(bare.repo, `r${n}.txt`, `${n}\n`); git(bare.repo, 'add', '-A'); git(bare.repo, 'commit', '-qm', `rebasé ${n}`); }
  writeMergeTrace(commonDirOf(bare.repo), { pr: 8, head: 'b'.repeat(40), target: 'main', method: 'rebase', mergeCommit: git(bare.repo, 'rev-parse', 'HEAD'), at: new Date().toISOString() }, TEST_KEY);
  git(bare.repo, 'push', '-q', 'origin', 'main');
  assert.deepEqual(auditMerges(bare.repo, commonDirOf(bare.repo), 'origin/main', { since: new Date(Date.now() - 3_600_000).toISOString() }).unaccounted.map(c => c.subject), ['rebasé 1', 'base']);
});

test('review 99, MOYEN 9: in a stack, plan reads the rules of each PR on its own change (against the PR below it)', async t => {
  const { planStack, processGh } = await import('../dist/stack/github.js');
  const { fileURLToPath } = await import('node:url');
  const root = mkdtempSync(join(tmpdir(), 'apv3-stack-rules-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fakeGh = fileURLToPath(new URL('./support/fake-gh.mjs', import.meta.url));
  const pr = (number, base, head) => ({ number, state: 'OPEN', isDraft: false, baseRefName: base, headRefName: head, headRefOid: String(number).repeat(40).slice(0, 40),
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [] });
  const state = join(root, 'gh.json');
  writeFileSync(state, JSON.stringify({ prs: { 11: pr(11, 'main', 'spec/1'), 12: pr(12, 'spec/1', 'spec/2'), 13: pr(13, 'spec/2', 'spec/3') }, behavior: {}, calls: [] }));
  const seen = [];
  const plan = await planStack([11, 12, 13], { gh: processGh(fakeGh, { ...process.env, FAKE_GH_STATE: state }, root), onCall: () => {}, ready: false, pollMs: 1, pollAttempts: 1,
    rules: async (p, base) => { seen.push([p.number, base]); return { problems: [], notes: [] }; } });
  assert.equal(plan.ok, true, JSON.stringify(plan.prs.map(p => p.anomalies)));
  assert.deepEqual(seen, [[11, 'main'], [12, 'spec/1'], [13, 'spec/2']]);
});

test('review 99, BAS 15: a suite launched under the lock of its stack holds it: not busy, its checks run under it', { skip: spawnSyncOk('flock', ['--version']) ? false : 'flock(1) missing' }, async t => {
  const { flockHeldByAncestor } = await import('../dist/stacks/idle.js');
  // Pure: the lock held by an ancestor of this process is ours; held by another process, it is not.
  const root = mkdtempSync(join(tmpdir(), 'apv3-own-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockFile = join(root, 'e2e.lock'); writeFileSync(lockFile, '');
  const { statSync } = await import('node:fs');
  const ino = statSync(lockFile).ino;
  const locks = join(root, 'locks'); writeFileSync(locks, `1: FLOCK  ADVISORY  WRITE 4242 ${lockDevice(statSync(lockFile, { bigint: true }).dev)}:${ino} 0 EOF\n`);
  assert.equal(flockHeldByAncestor(lockFile, new Set([4242]), locks), true);
  assert.equal(flockHeldByAncestor(lockFile, new Set([7]), locks), false);
  assert.equal(flockHeldByAncestor(lockFile, new Set([1]), join(root, 'absent')), false);
  const stacks = [{ id: '1', lockFile: '/l/e2e.lock', config: {}, resource: null, envFile: null }];
  assert.deepEqual(busyReasons(null, stacks, () => false, [], file => file === '/l/e2e.lock'), [], 'held by us');
  assert.equal(busyReasons(null, stacks, () => false, [], () => false).length, 1, 'held by another');
  // Real: flock <lock> apv gates run --stage full, with a check of that stack: the suite runs, the check under the lock.
  const p = project(t, { gates: [{ id: 'e2e', stage: 'full', command: node('0'), lock: { file: lockFile } }], config: { stacks: [{ id: '1', lockFile }] } });
  const cli = fileURLToPath(new URL('./support/cli-with-key.mjs', import.meta.url));
  const { TEST_KEY_FILE } = await import('./support/rules.mjs');
  const r = spawnSync('flock', ['-w', '5', lockFile, process.execPath, cli, TEST_KEY_FILE, 'gates', 'run', '--stage', 'full', '--json'], { cwd: p.repo, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, APV_LOCK_POLL_MS: '20', APV_LOCK_DIR: join(root, 'verrous') } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /déjà tenu par un processus parent de cette suite/);
  assert.equal(JSON.parse(r.stdout).gates[0].status, 'passed');
  // The companion lock is made in the lock folder the suite was given, never under the HOME or /tmp of the machine.
  assert.equal(readdirSync(join(root, 'verrous', 'under')).length, 1);
});

test('review of #105, F1: a lock of an ancestor is the same inode on the same device, or a file that ancestor holds open', async t => {
  const { flockHeldByAncestor } = await import('../dist/stacks/idle.js');
  const { openSync, closeSync, statSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'apv3-lock-dev-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockFile = join(root, 'e2e.lock'); writeFileSync(lockFile, '');
  const ino = statSync(lockFile).ino;
  const locks = join(root, 'locks');
  // Same inode on another device, a process that does not hold the file: another file.
  writeFileSync(locks, `1: FLOCK  ADVISORY  WRITE 4242 fe:7f:${ino} 0 EOF\n`);
  assert.equal(flockHeldByAncestor(lockFile, new Set([4242]), locks), false);
  // Another device printed (btrfs), but the ancestor holds the file open: the same lock.
  const fd = openSync(lockFile, 'r');
  t.after(() => closeSync(fd));
  writeFileSync(locks, `1: FLOCK  ADVISORY  WRITE ${process.pid} fe:7f:${ino} 0 EOF\n`);
  assert.equal(flockHeldByAncestor(lockFile, new Set([process.pid]), locks), true);
});

test('review of #105, M1: under the lock of an ancestor, the checks that share it still run one at a time', { skip: spawnSyncOk('flock', ['--version']) ? false : 'flock(1) missing' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'apv3-held-queue-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockFile = join(root, 'e2e.lock'); writeFileSync(lockFile, '');
  const log = join(root, 'log');
  const body = id => node(`const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'${id} start '+Date.now()+'\\n');` +
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,700);fs.appendFileSync(${JSON.stringify(log)},'${id} end '+Date.now()+'\\n');`);
  const p = project(t, { gates: [{ id: 'integration', stage: 'full', command: body('integration'), lock: { file: lockFile }, readOnly: true },
    { id: 'browser', stage: 'full', command: body('browser'), lock: { file: lockFile }, readOnly: true }], config: { stacks: [{ id: '1', lockFile }] } });
  const cli = fileURLToPath(new URL('./support/cli-with-key.mjs', import.meta.url));
  const { TEST_KEY_FILE } = await import('./support/rules.mjs');
  const r = spawnSync('flock', ['-w', '5', lockFile, process.execPath, cli, TEST_KEY_FILE, 'gates', 'run', '--stage', 'full', '--json'], { cwd: p.repo, encoding: 'utf8', timeout: 60_000, env: { ...process.env, APV_LOCK_DIR: join(root, 'verrous') } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).gates.map(g => g.status), ['passed', 'passed']);
  const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => l.split(' '));
  const span = id => ['start', 'end'].map(k => Number(lines.find(l => l[0] === id && l[1] === k)[2]));
  const [a, b] = [span('integration'), span('browser')];
  assert.ok(a[1] <= b[0] || b[1] <= a[0], `overlap: ${JSON.stringify({ a, b })}`);
});

test('review of 440d57d, N3 and N4: the companion lock lives in the lock folder of the account, one per real lock file', async t => {
  const { companionLock } = await import('../dist/gates/run.js');
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'apv3-companion-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockFile = join(root, 'e2e.lock'); writeFileSync(lockFile, '');
  symlinkSync(lockFile, join(root, 'lien.lock'));
  const env = { APV_LOCK_DIR: join(root, 'verrous') };
  const companion = companionLock(lockFile, env);
  assert.equal(dirname(companion), join(root, 'verrous', 'under'), 'writable even when the folder of the lock is not');
  assert.equal(companionLock(join(root, 'lien.lock'), env), companion, 'two paths to the same file share one companion');
  assert.notEqual(companionLock(join(root, 'autre.lock'), env), companion);
  // A fallback folder made by someone else, or open to others (a shared /tmp), is never used.
  const { chmodSync } = await import('node:fs');
  const tmp = join(root, 'tmp'); mkdirSync(tmp); const open = join(tmp, `apv-under-${process.getuid()}`); mkdirSync(open); chmodSync(open, 0o777);
  writeFileSync(join(root, 'pas-un-dossier'), '');
  const saved = process.env.TMPDIR; process.env.TMPDIR = tmp;
  try { assert.equal(companionLock(lockFile, { APV_LOCK_DIR: join(root, 'pas-un-dossier') }), `${lockFile}.under`); } finally { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; }
});

test('review of 440d57d, N5: hooks creating the anchor key at the same instant all get the same key', async t => {
  const root = mkdtempSync(join(tmpdir(), 'apv3-key-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const operator = fileURLToPath(new URL('../dist/rules/operator.js', import.meta.url));
  const { spawn } = await import('node:child_process');
  for (let round = 0; round < 5; round += 1) {
    const common = join(root, `commun-${round}`); mkdirSync(common);
    const keyFile = join(root, `cle-${round}`, 'cle-ancrage');
    const script = `import(${JSON.stringify(operator)}).then(m => { try { process.stdout.write(m.ensureAnchorKey(${JSON.stringify(common)}, ${JSON.stringify(keyFile)}).toString('hex')); } catch (e) { process.stdout.write('ERREUR ' + e.message); } })`;
    const outputs = await Promise.all(Array.from({ length: 8 }, () => new Promise(done => {
      const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = ''; child.stdout.on('data', d => { out += d; }); child.on('close', () => done(out));
    })));
    assert.equal(new Set(outputs).size, 1, JSON.stringify(outputs));
    assert.match(outputs[0], /^[0-9a-f]{64}$/);
  }
});

test('review of #105, D1 and D2: under the lock of an ancestor, the turn is bounded by lock.waitMs and shared across processes', { skip: spawnSyncOk('flock', ['--version']) ? false : 'flock(1) missing' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'apv3-held-under-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockFile = join(root, 'e2e.lock'); writeFileSync(lockFile, '');
  const log = join(root, 'log');
  const body = id => node(`const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'${id} start '+Date.now()+'\\n');` +
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200);fs.appendFileSync(${JSON.stringify(log)},'${id} end '+Date.now()+'\\n');`);
  const cli = fileURLToPath(new URL('./support/cli-with-key.mjs', import.meta.url));
  const { TEST_KEY_FILE } = await import('./support/rules.mjs');
  // D1: two checks, a turn of 300 ms at most: the one left waiting is refused without running, as under its own flock
  // (and the suite stops the other, as after any failure).
  const p = project(t, { gates: [{ id: 'a', stage: 'full', command: body('a'), lock: { file: lockFile, waitMs: 300 }, readOnly: true },
    { id: 'b', stage: 'full', command: body('b'), lock: { file: lockFile, waitMs: 300 }, readOnly: true }], config: { stacks: [{ id: '1', lockFile }] } });
  const r = spawnSync('flock', ['-w', '5', lockFile, process.execPath, cli, TEST_KEY_FILE, 'gates', 'run', '--stage', 'full', '--json'], { cwd: p.repo, encoding: 'utf8', timeout: 60_000, env: { ...process.env, APV_LOCK_DIR: join(root, 'verrous') } });
  const refused = JSON.parse(r.stdout).gates.filter(g => g.status === 'timed_out');
  assert.equal(refused.length, 1, r.stdout);
  assert.match(refused[0].diagnostic ?? JSON.stringify(refused[0]), /non obtenu/);
  assert.equal(existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(l => l.startsWith(`${refused[0].id} start`)).length : 0, 0, 'never launched');
  // D2: two suites of two projects under the same parent flock take turns.
  rmSync(log, { force: true });
  const q1 = project(t, { gates: [{ id: 'x', stage: 'full', command: body('x'), lock: { file: lockFile }, readOnly: true }], config: { stacks: [{ id: '1', lockFile }] } });
  const q2 = project(t, { gates: [{ id: 'y', stage: 'full', command: body('y'), lock: { file: lockFile }, readOnly: true }], config: { stacks: [{ id: '1', lockFile }] } });
  const run = (repo) => `(cd ${JSON.stringify(repo)} && ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} ${JSON.stringify(TEST_KEY_FILE)} gates run --stage full --json > /dev/null)`;
  const both = spawnSync('flock', ['-w', '5', lockFile, 'sh', '-c', `${run(q1.repo)} & ${run(q2.repo)} & wait`], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, APV_LOCK_DIR: join(root, 'verrous') } });
  assert.equal(both.status, 0, both.stderr);
  const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => l.split(' '));
  const span = id => ['start', 'end'].map(k => Number(lines.find(l => l[0] === id && l[1] === k)[2]));
  const [x, y] = [span('x'), span('y')];
  assert.ok(x[1] <= y[0] || y[1] <= x[0], `overlap: ${JSON.stringify({ x, y })}`);
});

test('review 99, BAS 16: the rule maquette reads the screens of a mockup with the parser of the registry, never in its title', async () => {
  const { mockupsOf, covers } = await import('../dist/rules/screens.js');
  const sha = 'a'.repeat(64);
  const decision = value => ({ id: 'maquette-accueil-validee', subject: 'Maquette validée : accueil', value, enforcement: 'product', status: 'confirmed', source: 'operator', sourceQuote: 'je valide' });
  // Hand-written: « Écrans : admin. » in the title, before the file and fingerprint: not a screen of the mockup.
  const forged = mockupsOf([decision(`La maquette « Accueil Écrans : admin. », validée : fichier docs/design/accueil.html, sha256 ${sha}.`)]);
  assert.deepEqual(forged[0].screens, []);
  assert.equal(covers(forged[0], 'src/routes/admin/+page.svelte'), false);
  const registered = mockupsOf([decision(`La maquette « Accueil », validée : fichier docs/design/accueil.html, sha256 ${sha}. Écrans : admin, réglages.`)]);
  assert.deepEqual(registered[0].screens, ['admin', 'réglages']);
  assert.equal(covers(registered[0], 'src/routes/admin/+page.svelte'), true);
  // An old decision, without file nor fingerprint, keeps the reading of its time (CHANGELOG): « Écrans : » anywhere in it.
  assert.deepEqual(mockupsOf([decision('Maquette validée. Écrans : admin.')])[0].screens, ['admin']);
  // Not the operator's, or not confirmed: no mockup.
  assert.deepEqual(mockupsOf([{ ...decision(`fichier x.html, sha256 ${sha}.`), source: 'agent' }, { ...decision(`fichier x.html, sha256 ${sha}.`), status: 'proposed' }]), []);
});
