import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { loadConfig } from '../dist/config/load.js';
import { Git } from '../dist/execution/git.js';
import { verifyGates } from '../dist/gates/verify.js';
import { runGates, gatesConfigHash } from '../dist/gates/run.js';
import { inputsDigest, localStateDigest } from '../dist/gates/reuse.js';
import { checkReuse, neverReused, readLocal, reuseContext, runsNetworkAudit } from '../dist/gates/reuse-proof.js';
import { pruneStore, publishRun, readSharedRun, syncRun } from '../dist/gates/store.js';

/**
 * Relecture sécurité de la PR A1 (reprise à arbre identique) : M1 (un échec ciblé ou tôt plus récent bloque la reprise),
 * M2 (l'état local ignoré par Git entre dans l'identité, le lot prépare sa copie avant toute reprise), M3 (un audit qui lit
 * le réseau n'est jamais repris), F1 (même arbre de merge-base pour {{baseSha}}), F2 (chaque reçu publié dès son écriture).
 * Chaque refus a son cas accepté à côté.
 */

const sha256 = text => createHash('sha256').update(text).digest('hex');
const statuses = json => Object.fromEntries(json.gates.map(g => [g.gate, g.status]));
const node = code => [process.execPath, '-e', code];
/** A command that fails when `flag` exists (outside the repository). */
const failsOn = flag => node(`process.exit(require("fs").existsSync(${JSON.stringify(flag)}) ? 1 : 0)`);

function project(t, config, files = {}) {
  const f = fixture(t, { files: { '.gitignore': 'node_modules/\ndist/\n.env*\n', ...files } });
  write(f.repo, '.apv/config.json', config);
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  const store = join(f.repo, '.git', 'apv', 'receipts');
  return { ...f, store, head: (repo = f.repo) => git(repo, 'rev-parse', 'HEAD'),
    run: (args = [], cwd = f.repo) => apv(cwd, ['gates', 'run', ...args]),
    same: (repo = f.repo) => { git(repo, 'commit', '-q', '--allow-empty', '-m', 'même arbre'); return git(repo, 'rev-parse', 'HEAD'); } };
}

/** A receipt cached at `head` that cites `origin` (read from the run `runId` of the worktree), as `apv gates run` writes one. */
async function cachedOf(p, runId, gate, head, extra = {}) {
  const o = JSON.parse(readFileSync(join(p.repo, '.apv', 'receipts', runId, `${gate}.json`), 'utf8'));
  return { receipt: { ...o, id: randomUUID(), candidateSha: head, status: 'cached', reusedFrom: o.id, startedAt: Date.now(), targeted: undefined,
    reuse: { fromRun: runId, fromCommit: o.candidateSha, basis: 'tree', inputsDigest: (await inputsDigest(new Git(), p.repo, head)).digest, ignoreDigest: sha256('[]'),
      environment: o.environmentHash, changed: 0, files: [] } }, dirty: false, baseSha: null, source: 'local', ...extra };
}
const contextOf = (p, head) => {
  const config = loadConfig(p.repo).config;
  return { config, ctx: reuseContext({ git: new Git(), repo: p.repo, commit: head, configHash: gatesConfigHash(config), now: Date.now(), store: p.store, local: readLocal(p.repo) }) };
};

test('M1: a later targeted failure (affected) on the same tree blocks the reuse, in run and in verify, at the same commit too; a targeted pass does not', async t => {
  const flag = join(fixture(t).root, 'rouge');
  const p = project(t, { gates: [{ id: 'integration', stage: 'full', command: failsOn(flag), affected: [...failsOn(flag), '{{baseSha}}'] }] });
  const base = p.head();
  write(p.repo, 'src/b.txt', 'b\n'); git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'c1');
  assert.equal((await p.run(['--stage', 'full', '--json'])).code, 0);
  // Accepted: a later targeted pass on the same tree leaves the green origin reusable.
  p.same();
  assert.equal((await p.run(['--stage', 'task', '--base', base, '--json'])).code, 0);
  const c2 = p.same();
  const reused = await p.run(['--stage', 'full', '--json']);
  assert.deepEqual(statuses(reused.json()), { integration: 'cached' });
  assert.equal((await verifyGates({ repo: p.repo, config: loadConfig(p.repo).config, commit: c2 })).ok, true);
  // At the same commit, a targeted failure written after the receipt cached: verify refuses it.
  writeFileSync(flag, '');
  const red = await p.run(['--stage', 'task', '--base', base, '--json']);
  assert.deepEqual(statuses(red.json()), { integration: 'failed' });
  const verified = await verifyGates({ repo: p.repo, config: loadConfig(p.repo).config, commit: c2 });
  assert.equal(verified.ok, false);
  assert.equal(verified.gates[0].state, 'reuse');
  assert.match(verified.gates[0].reuse.reason, /échec plus récent sur le même arbre : \S+\/integration\.json \(failed, ciblé\) l'emporte/);
  assert.equal((await apv(p.repo, ['gates', 'verify', '--commit', c2])).code, 1);
  // At a new commit of the same tree: run executes the check instead of reusing it (att2).
  p.same();
  const c3 = await p.run(['--stage', 'full', '--json']);
  assert.deepEqual(statuses(c3.json()), { integration: 'failed' });
  assert.match(c3.stderr, /integration : non repris \(échec plus récent sur le même arbre : \S+\/integration\.json \(failed, ciblé\) l'emporte\) : exécuté\./);
});

test('M1: a later failure of an early check (early.gate) on the same tree blocks the reuse of its full check; its pass does not', async t => {
  const flag = join(fixture(t).root, 'rouge');
  const p = project(t, { gates: [{ id: 'browser', stage: 'full', command: node('0'), early: [{ id: 'browser-size', command: failsOn(flag) }] }] });
  const base = p.head();
  write(p.repo, 'src/b.txt', 'b\n'); git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'c1');
  assert.equal((await p.run(['--stage', 'full', '--json'])).code, 0);
  p.same();
  assert.equal((await p.run(['--stage', 'task', '--base', base, '--json'])).code, 0, 'early check green');
  p.same();
  assert.deepEqual(statuses((await p.run(['--stage', 'full', '--json'])).json()), { browser: 'cached' });
  writeFileSync(flag, '');
  p.same();
  const early = await p.run(['--stage', 'task', '--base', base, '--json']);
  assert.deepEqual(statuses(early.json()), { 'browser-size': 'failed' });
  p.same();
  const full = await p.run(['--stage', 'full', '--json']);
  assert.deepEqual(statuses(full.json()), { browser: 'passed' }, 'run again: the early failure wins over the older green origin');
  assert.match(full.stderr, /browser : non repris \(échec plus récent sur le même arbre : \S+\/browser-size\.json \(failed, contrôle tôt browser-size\) l'emporte\)/);
});

test('M2: a .env* file at the root that changed, the tree unchanged, is another environment: run again; the same content is reused; its value is never written', async t => {
  const p = project(t, { gates: [{ id: 'env-check', command: node('process.exit(require("fs").readFileSync(".env.local", "utf8").startsWith("OK\\n") ? 0 : 1)') }] });
  writeFileSync(join(p.repo, '.env.local'), 'OK\nSECRET_TOKEN=s3cr3t-valeur-locale\n');
  const first = await p.run(['--json']);
  assert.equal(first.code, 0, first.stderr);
  // Accepted: same tree, same .env.local.
  p.same();
  assert.deepEqual(statuses((await p.run(['--json'])).json()), { 'env-check': 'cached' });
  // Refused: same tree, another .env.local (att1).
  writeFileSync(join(p.repo, '.env.local'), 'BAD\nSECRET_TOKEN=s3cr3t-valeur-locale\n');
  const head = p.same();
  const changed = await p.run(['--json']);
  assert.deepEqual(statuses(changed.json()), { 'env-check': 'failed' });
  assert.match(changed.stderr, /env-check : non repris \(.*autre environnement .*état local ignoré par Git : node_modules, fichiers générés, fichiers \.env\*\)/);
  assert.equal((await apv(p.repo, ['gates', 'verify', '--commit', head])).code, 1);
  // A new .env file appears: another environment too.
  writeFileSync(join(p.repo, '.env.local'), 'OK\nSECRET_TOKEN=s3cr3t-valeur-locale\n');
  p.same();
  assert.deepEqual(statuses((await p.run(['--json'])).json()), { 'env-check': 'passed' }, 'the green origin was written with OK, after a failure: runs again');
  writeFileSync(join(p.repo, '.env.test'), 'X=1\n');
  p.same();
  assert.deepEqual(statuses((await p.run(['--json'])).json()), { 'env-check': 'passed' });
  // The value of the file is never written, in a receipt, a summary or the store.
  const seen = [];
  const walk = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, e.name); if (e.isDirectory()) walk(path); else seen.push(readFileSync(path, 'utf8')); } };
  walk(join(p.repo, '.apv', 'receipts')); walk(p.store);
  assert.ok(seen.length > 4);
  assert.ok(seen.every(text => !text.includes('s3cr3t') && !text.includes('SECRET_TOKEN')));
  assert.ok(![first.stdout, first.stderr, changed.stdout, changed.stderr].some(text => text.includes('s3cr3t')));
});

test('M2: the local state digest follows node_modules and the record of its install, never their path alone', async t => {
  const f = fixture(t);
  const before = localStateDigest(f.repo);
  assert.equal(localStateDigest(f.repo), before, 'stable');
  mkdirSync(join(f.repo, 'node_modules'));
  const folder = localStateDigest(f.repo);
  assert.notEqual(folder, before, 'node_modules present or not');
  writeFileSync(join(f.repo, 'node_modules', '.package-lock.json'), '{"v":1}');
  const v1 = localStateDigest(f.repo);
  writeFileSync(join(f.repo, 'node_modules', '.package-lock.json'), '{"v":2}');
  assert.notEqual(localStateDigest(f.repo), v1);
  writeFileSync(join(f.repo, 'node_modules', '.package-lock.json'), '{"v":1}');
  assert.equal(localStateDigest(f.repo), v1, 'content, not date');
  writeFileSync(join(f.repo, 'node_modules', '.modules.yaml'), 'pnpm');
  assert.notEqual(localStateDigest(f.repo), v1, 'pnpm record');
  assert.match(localStateDigest(f.repo), /^[a-f0-9]{64}$/);
});

/** att5: an origin with stale dependencies (node_modules installed before package-lock.json moved on), then fresh copies. */
function staleProject(t) {
  const log = join(fixture(t).root, 'integration.log');
  const setup = node('const fs = require("fs"); fs.mkdirSync("node_modules", { recursive: true }); fs.writeFileSync("node_modules/.package-lock.json", fs.readFileSync("package-lock.json"))');
  const p = project(t, {
    gates: [{ id: 'integration', stage: 'full', command: node(`require("fs").appendFileSync(${JSON.stringify(log)}, process.cwd() + "\\n");
process.exit(require("fs").readFileSync("node_modules/.package-lock.json", "utf8").includes("1.0.0") ? 0 : 1)`) }],
    batch: { setup },
  }, { 'package-lock.json': '{"dep":"2.0.0"}\n' });
  const ran = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  const worktree = (name, stale) => {
    const dir = join(p.root, name);
    git(p.repo, 'worktree', 'add', '-q', '--detach', dir, 'HEAD');
    if (stale) { mkdirSync(join(dir, 'node_modules')); writeFileSync(join(dir, 'node_modules', '.package-lock.json'), '{"dep":"1.0.0"}\n'); }
    return dir;
  };
  return { ...p, ran, worktree, setup };
}

test('M2 (att5): a fresh copy never reuses an origin that ran with stale dependencies; it runs, batch.setup prepares it, the check fails', async t => {
  const p = staleProject(t);
  const x = p.worktree('x', true);
  const origin = await p.run(['--stage', 'full', '--json'], x);
  assert.deepEqual(statuses(origin.json()), { integration: 'passed' }, 'green with stale dependencies');
  p.same();
  // Accepted: a copy with the very same local state reuses it.
  const z = p.worktree('z', true);
  assert.deepEqual(statuses((await p.run(['--stage', 'full', '--json'], z)).json()), { integration: 'cached' });
  // Refused: a fresh copy (no node_modules) is another local state: it runs, batch.setup prepares it, the check fails.
  const y = p.worktree('y', false);
  const fresh = await p.run(['--stage', 'full', '--json'], y);
  assert.deepEqual(statuses(fresh.json()), { integration: 'failed' });
  assert.match(fresh.stderr, /Copie de la suite non préparée \(package-lock\.json sans node_modules\) : préparation par batch\.setup/);
  assert.equal((await apv(y, ['gates', 'verify', '--commit', 'HEAD'])).code, 1);
});

test('M2: the copy of a batch is prepared by batch.setup before any reuse, then compared by its local state: stale origin run again, prepared origin reused', async t => {
  const p = staleProject(t);
  const x = p.worktree('x', true);
  assert.equal((await p.run(['--stage', 'full', '--json'], x)).code, 0);
  const lines = [];
  const config = loadConfig(p.repo).config;
  // A fresh copy of a batch: prepared first (node_modules from package-lock.json, 2.0.0), so the stale origin is not its state.
  const y = p.worktree('y', false);
  const batch = await runGates({ repo: y, config, stage: 'full', batchSetup: true, log: line => lines.push(line) });
  assert.equal(batch.receipts[0].status, 'failed', 'run, not reused');
  assert.equal(batch.setup?.status, 'done');
  assert.ok(lines.findIndex(l => /préparation par batch\.setup/.test(l)) < lines.findIndex(l => /integration : non repris/.test(l)), lines.join('\n'));
  assert.equal(p.ran().length, 2);
  // Accepted: two prepared copies of the same tree have the same local state; the second reuses the first (prepared too).
  write(p.repo, '.apv/config.json', { gates: [{ id: 'integration', stage: 'full', command: node('0') }], batch: { setup: p.setup } });
  git(p.repo, 'commit', '-qam', 'contrôle vert');
  const configured = loadConfig(p.repo).config;
  const a = p.worktree('a', false);
  assert.equal((await runGates({ repo: a, config: configured, stage: 'full', batchSetup: true })).receipts[0].status, 'passed');
  const b = p.worktree('b', false);
  git(b, 'commit', '-q', '--allow-empty', '-m', 'même arbre');
  const second = await runGates({ repo: b, config: configured, stage: 'full', batchSetup: true });
  assert.equal(second.receipts[0].status, 'cached');
  assert.equal(second.setup?.status, 'done', 'prepared even though every check is reused');
});

test('M3: a command that runs npm audit or an equivalent that reads the network is never reused, directly or through a script of package.json', async t => {
  const scripts = { 'audit:ci': 'npm audit --audit-level=high', test: 'vitest run', check: 'npm run types && npm run scan', types: 'tsc', scan: 'apv dast run --base main',
    lint: 'eslint . && pnpm outdated', web: 'apv web audit --preview', loop: 'npm run loop2', loop2: 'npm run loop' };
  for (const argv of [['npm', 'audit'], ['pnpm', 'audit', '--prod'], ['yarn', 'audit'], ['yarn', 'npm', 'audit'], ['bun', 'audit'], ['npm', 'outdated'],
    ['npx', 'audit-ci', '--high'], ['/usr/bin/npm', '--prefix', '.', 'audit'], ['npx', 'osv-scanner', '.'], ['snyk', 'test']]) {
    assert.ok(runsNetworkAudit(argv), argv.join(' '));
    assert.match(neverReused({ command: argv }), /audit des dépendances qui lit le réseau/, argv.join(' '));
  }
  assert.match(neverReused({ command: ['npm', 'run', 'audit:ci'] }, scripts), /audit des dépendances qui lit le réseau .*par le script npm « audit:ci »/);
  assert.match(neverReused({ command: ['npm', 'run', 'check'] }, scripts), /apv dast .*par le script npm « scan »/);
  assert.match(neverReused({ command: ['pnpm', 'lint'] }, scripts), /audit des dépendances/);
  assert.match(neverReused({ command: ['yarn', 'run', 'web'] }, scripts), /apv web audit/);
  assert.match(neverReused({ command: ['sh', '-c', 'npm ci && npm audit'] }), /audit des dépendances/);
  assert.match(neverReused({ command: node('require("child_process").execFileSync("git", ["log", "-1", "--format=%B"])') }), /git sur l'historique/);
  assert.match(neverReused({ command: ['git', 'describe', '--tags'] }), /git sur l'historique/);
  // Accepted: what reads the tree only.
  for (const [argv, extra] of [[['npm', 'run', 'audit:ci'], {}], [['npm', 'test'], scripts], [['npm', 'run', 'loop'], scripts], [['npx', 'vitest', 'run', 'tests/git-log.test.ts'], {}],
    [['npm', 'run', 'types'], scripts], [node('0'), {}], [['git', 'diff', '--check'], {}], [['apv', 'tests', 'check', '--base', '{{baseSha}}'], {}]]) {
    assert.equal(neverReused({ command: argv }, extra), null, argv.join(' '));
  }
  // Through apv gates run and verify: the script of the commit judged makes it never reused.
  const p = project(t, { gates: [{ id: 'security-audit-ci', command: ['npm', 'run', 'audit:ci'] }, { id: 'lint', command: ['npm', 'run', 'lint'] }] },
    { 'package.json': JSON.stringify({ name: 'x', private: true, scripts: { 'audit:ci': 'node -e "process.exit(0)" || npm audit', lint: 'node -e "process.exit(0)"' } }) });
  const first = await p.run(['--json']);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const runId = first.json().runId;
  const head = p.same();
  const second = await p.run(['--json']);
  assert.deepEqual(statuses(second.json()), { 'security-audit-ci': 'passed', lint: 'cached' });
  assert.match(second.stderr, /security-audit-ci : jamais repris : il lance un audit des dépendances qui lit le réseau \(npm audit ou équivalent\) \(par le script npm « audit:ci »\)/);
  const { config, ctx } = contextOf(p, head);
  assert.match((await checkReuse(ctx, config.gates[0], await cachedOf(p, runId, 'security-audit-ci', head))).reason, /contrôle jamais repris \(il lance un audit/);
  assert.ok((await checkReuse(ctx, config.gates[1], await cachedOf(p, runId, 'lint', head))).origin, 'lint stays reusable');
});

test('F1: a command that reads {{baseSha}} is reused only when the merge base with the base has the same tree; same base, other fork: run again', async t => {
  const p = project(t, { gates: [{ id: 'pr-size', command: [...node('0'), '{{baseSha}}'] }] });
  const a0 = p.head();
  write(p.repo, 'b.txt', 'b\n'); git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'main avance');
  const b = p.head();
  write(p.repo, 'x.txt', 'x\n'); git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'c1');
  const tree = git(p.repo, 'rev-parse', 'HEAD^{tree}');
  const first = await p.run(['--base', b, '--json']);
  assert.equal(first.code, 0, first.stderr);
  const runId = first.json().runId;
  // Accepted: the same tree, the same base, the same fork (a child of B).
  const c3 = git(p.repo, 'commit-tree', tree, '-p', b, '-m', 'c3');
  git(p.repo, 'reset', '-q', '--hard', c3);
  assert.deepEqual(statuses((await p.run(['--base', b, '--json'])).json()), { 'pr-size': 'cached' });
  assert.equal((await verifyGates({ repo: p.repo, config: loadConfig(p.repo).config, commit: c3 })).ok, true);
  // Refused: the same tree and base, but a child of A0: the merge base with B is A0, another tree (att3).
  const c2 = git(p.repo, 'commit-tree', tree, '-p', a0, '-m', 'c2');
  git(p.repo, 'reset', '-q', '--hard', c2);
  const other = await p.run(['--base', b, '--json']);
  assert.deepEqual(statuses(other.json()), { 'pr-size': 'passed' });
  assert.match(other.stderr, /pr-size : non repris \(commande qui lit la base de son exécution \(\{\{baseSha\}\}\) : la base commune \(merge-base\) de [a-f0-9]{12} avec ce commit n'a pas l'arbre de celle avec l'origine/);
  const { config, ctx } = contextOf(p, c2);
  const forged = await cachedOf(p, runId, 'pr-size', c2, { baseSha: b });
  assert.match((await checkReuse(ctx, config.gates[0], forged)).reason, /la base commune \(merge-base\)/);
});

test('F2: each receipt is in the shared store as soon as it is written: a failure in progress in one copy blocks the reuse in another (att4)', async t => {
  const root = fixture(t).root;
  const flag = join(root, 'rouge'); const release = join(root, 'libre');
  const p = project(t, { gates: [
    { id: 'g1', command: failsOn(flag) },
    { id: 'g2', command: node(`const fs = require("fs"); const end = Date.now() + 60000; const cell = new Int32Array(new SharedArrayBuffer(4));
while (fs.existsSync(${JSON.stringify(flag)}) && !fs.existsSync(${JSON.stringify(release)}) && Date.now() < end) Atomics.wait(cell, 0, 0, 100);`) }] });
  assert.equal((await p.run(['--json'])).code, 0);
  const c2 = p.same();
  const y = join(p.root, 'y');
  git(p.repo, 'worktree', 'add', '-q', '--detach', y, c2);
  git(p.repo, 'checkout', '-q', '--detach', 'HEAD~1');
  writeFileSync(flag, '');
  // X replays everything: g1 fails at once, g2 waits for the release.
  const x = p.run(['--replay', 'all', '--keep-going', '--json']);
  const published = () => {
    if (!existsSync(p.store)) return false;
    for (const run of readdirSync(p.store)) {
      const shared = readSharedRun(join(p.store, run));
      if (shared.intact && shared.files.has('g1.json') && JSON.parse(shared.files.get('g1.json').toString()).status === 'failed') return true;
    }
    return false;
  };
  for (let i = 0; i < 300 && !published(); i += 1) await sleep(100);
  assert.ok(published(), 'the failure of g1 is in the store while X still runs');
  const during = await p.run(['--keep-going', '--json'], y);
  assert.deepEqual(statuses(during.json()), { g1: 'failed', g2: 'cached' });
  assert.match(during.stderr, /g1 : non repris \(échec plus récent sur le même arbre/);
  assert.equal((await apv(y, ['gates', 'verify', '--commit', c2])).code, 1);
  writeFileSync(release, '');
  assert.equal((await x).code, 1);
});

test('F2: syncRun keeps the copy of a run intact after each receipt, replaces the summary, and the retention removes a temporary file left behind', async t => {
  const f = fixture(t);
  const local = join(f.root, 'local', '20991231T000000Z-0badf00d');
  const store = join(f.root, 'store');
  mkdirSync(local, { recursive: true });
  const sha = 'a'.repeat(40);
  writeFileSync(join(local, 'summary.json'), '{"inProgress":true}');
  const target = syncRun(store, local, '20991231T000000Z-0badf00d', sha, f.repo);
  assert.equal(readSharedRun(target).intact, true);
  assert.deepEqual([...readSharedRun(target).files.keys()], ['summary.json']);
  writeFileSync(join(local, 'g1.json'), '{"status":"failed"}');
  syncRun(store, local, '20991231T000000Z-0badf00d', sha, f.repo);
  assert.deepEqual([...readSharedRun(target).files.keys()].sort(), ['g1.json', 'summary.json']);
  writeFileSync(join(local, 'summary.json'), '{"ok":false}');
  syncRun(store, local, '20991231T000000Z-0badf00d', sha, f.repo);
  const run = readSharedRun(target);
  assert.equal(run.intact, true);
  assert.equal(run.files.get('summary.json').toString(), '{"ok":false}');
  // publishRun still leaves a run already published as it is.
  assert.equal(publishRun(store, local, '20991231T000000Z-0badf00d', sha, f.repo), target);
  // A temporary file left by an interrupted write: the run is not intact (refused, never half read) until the retention removes it.
  const left = join(target, '.tmp-0000-g2.json');
  writeFileSync(left, '{}');
  assert.equal(readSharedRun(target).intact, false);
  utimesSync(left, new Date(Date.now() - 2 * 3_600_000), new Date(Date.now() - 2 * 3_600_000));
  const pruned = pruneStore(store, { keepDays: 100_000, keepRuns: 10 });
  assert.equal(pruned.temporary, 1);
  assert.equal(readSharedRun(target).intact, true);
});
