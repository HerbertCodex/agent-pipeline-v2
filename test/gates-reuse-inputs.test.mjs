import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { configIssues, loadConfig } from '../dist/config/load.js';
import { Git } from '../dist/execution/git.js';
import { runGates, gatesConfigHash } from '../dist/gates/run.js';
import { checkoutState, copyStateDigest, inputsDigest, localStateDigest } from '../dist/gates/reuse.js';
import { checkReuse, neverReused, projectScripts, readLocal, reuseContext } from '../dist/gates/reuse-proof.js';

/**
 * PR A2 of docs/ACCELERATION-LOTS.md (5.2 A2, 5.4, 5.5; AC-REUSE-NEVER-IGNORE, AC-REUSE-STACK), after the delta review of its
 * security review: the reuse by inputs (`reuse.ignore`) is DISABLED (decision of the project lead, 18 October, evening, bis,
 * M1): `apv gates run` never writes a receipt `basis: inputs`, `apv gates verify` refuses one, until a PR A2b proves the
 * declaration. The loader of `reuse.ignore` and `reuse.maxAgeMs` stays (validation, files never ignorable). With the faint
 * findings of the delta review of A1 (ticket #149, F-D1, F-D2) and of A2 (F1-bis, F2-bis, F3, D2, F4). Each refusal has its
 * accepted case next to it: the reuse at an identical tree (A1) and all its protections stay.
 */


const sha256 = text => createHash('sha256').update(text).digest('hex');
const HOUR = 3_600_000;
const hasFlock = spawnSync('flock', ['--version']).status === 0;
const statuses = json => Object.fromEntries(json.gates.map(g => [g.gate, g.status]));
/** A check that appends its name to `log` (outside the repository) each time it really runs; fails while `flag` exists. */
const logged = (log, name, flag = null) => [process.execPath, '-e',
  `require("fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${name}\n`)});${flag ? ` process.exit(require("fs").existsSync(${JSON.stringify(flag)}) ? 1 : 0);` : ''}`];
/** The example of the specification (5.2 A2). */
const SPEC_IGNORE = ['tests/e2e/browser/**', 'tests/e2e/**/*-snapshots/**', 'docs/**', '.apv/state/**', '**/*.md'];

/**
 * A project on `main` whose integration check ignores the browser tests, their images and the documentation, then a feature
 * branch; `run` is `apv gates run --stage full --base main` (the checks and their reuse.ignore read at the merge base).
 */
function inputsProject(t, { reuse = { ignore: SPEC_IGNORE, maxAgeMs: 172_800_000 }, files = {}, config = null, setup = null } = {}) {
  const f = fixture(t, { files: {
    'src/lib/x.ts': 'export const x = 1;\n', 'src/routes/page.md': '# Page\n', 'tests/integration/a.test.ts': 'integration 1\n',
    'tests/e2e/browser/x.e2e.ts': 'e2e 1\n', 'tests/e2e/browser/x.e2e.ts-snapshots/a.png': 'png a1', 'tests/e2e/browser/x.e2e.ts-snapshots/b.png': 'png b1',
    'docs/notes.md': 'notes 1\n', ...files } });
  const log = join(f.root, 'runs.log');
  const flag = join(f.root, 'fail-integration');
  write(f.repo, '.apv/config.json', config ?? { gates: [
    { id: 'integration', stage: 'full', command: logged(log, 'integration', flag), testPaths: ['tests/integration/**'], ...(reuse ? { reuse } : {}) },
    { id: 'browser', stage: 'full', command: logged(log, 'browser'), testPaths: ['tests/e2e/browser/**'] }] });
  if (setup) setup(f.repo);
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  git(f.repo, 'checkout', '-q', '-b', 'feature');
  const ran = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  const store = join(f.repo, '.git', 'apv', 'receipts');
  return { ...f, log, flag, ran, store, head: () => git(f.repo, 'rev-parse', 'HEAD'),
    run: (args = []) => apv(f.repo, ['gates', 'run', '--stage', 'full', '--base', 'main', ...args]),
    verify: (commit, args = ['--against', 'main']) => apv(f.repo, ['gates', 'verify', '--commit', commit, ...args]),
    commit: changes => {
      for (const [path, text] of Object.entries(changes)) { if (text === null) rmSync(join(f.repo, path)); else write(f.repo, path, text); }
      git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'changement');
      return git(f.repo, 'rev-parse', 'HEAD');
    },
    receiptOf: (runId, gate) => JSON.parse(readFileSync(join(f.repo, '.apv', 'receipts', runId, `${gate}.json`), 'utf8')) };
}
const ctxOf = (p, commit, extra = {}) => {
  const config = loadConfig(p.repo).config;
  return { config, ctx: reuseContext({ git: new Git(), repo: p.repo, commit, configHash: gatesConfigHash(config), now: Date.now(), store: p.store, local: readLocal(p.repo), ...extra }) };
};
const found = receipt => ({ receipt, dirty: false, baseSha: null, source: 'local' });

/** The reason a reuse by inputs is refused (src/gates/reuse-proof.ts, INPUTS_REUSE_DISABLED). */
const DISABLED = /reprise par entrées désactivée tant que la déclaration reuse\.ignore n'est pas prouvée/;

test('M1 (delta review of A2): only ignored files changed, the check declaring reuse.ignore runs again and says why; at an identical tree it is still reused', async t => {
  const p = inputsProject(t);
  p.commit({ 'docs/notes.md': 'notes 1b\n' });
  const first = await p.run(['--json']);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.deepEqual(p.ran(), ['integration', 'browser']);
  const b = p.commit({ 'tests/e2e/browser/x.e2e.ts': 'e2e 2\n', 'tests/e2e/browser/x.e2e.ts-snapshots/a.png': 'png a2', 'docs/notes.md': 'notes 2\n' });
  const second = await p.run(['--json']);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.deepEqual(statuses(second.json()), { integration: 'passed', browser: 'passed' });
  assert.deepEqual(p.ran(), ['integration', 'browser', 'integration', 'browser'], 'integration runs again');
  assert.deepEqual(second.json().reused, []);
  assert.match(second.stderr, new RegExp(`integration : non repris \\(aucun reçu réussi au premier passage sur un arbre identique avec cette configuration ; ${DISABLED.source}`));
  // The same tree (an empty commit): the reuse at an identical tree stays, verified as before.
  git(p.repo, 'commit', '-q', '--allow-empty', '-m', 'même arbre');
  const same = await p.run(['--json']);
  assert.deepEqual(statuses(same.json()), { integration: 'cached', browser: 'cached' });
  assert.deepEqual(same.json().reused.map(r => [r.gateId, r.fromCommit, r.basis, r.changed]), [['integration', b, 'tree', 0], ['browser', b, 'tree', 0]]);
  const verified = await p.verify('HEAD');
  assert.equal(verified.code, 0, verified.stdout);
  assert.match(verified.stdout, /arbre identique/);
});

test('M1: a receipt cached by inputs, true to Git in every other respect, proves nothing: checkReuse and apv gates verify refuse it', async t => {
  const p = inputsProject(t);
  const a = p.commit({ 'docs/notes.md': 'notes 1b\n' });
  const first = (await p.run(['--json'])).json();
  const o = p.receiptOf(first.runId, 'integration');
  const b = p.commit({ 'docs/notes.md': 'notes 2\n' });
  // The receipt A2 wrote before this decision: from a to b, one ignored file changed.
  const config = loadConfig(p.repo).config;
  const forged = { ...o, id: randomUUID(), candidateSha: b, status: 'cached', reusedFrom: o.id, startedAt: Date.now(), durationMs: 0,
    reuse: { fromRun: o.runId, fromCommit: a, basis: 'inputs', inputsDigest: (await inputsDigest(new Git(), p.repo, b)).digest,
      ignoreDigest: sha256(JSON.stringify([...SPEC_IGNORE].sort())), environment: o.reuseIdentity, changed: 1, files: ['docs/notes.md'] } };
  for (const reference of ['main', null]) {
    const { ctx } = ctxOf(p, b, { reference });
    assert.match((await checkReuse(ctx, config.gates[0], found(forged))).reason, DISABLED, `reference ${reference}`);
  }
  // Through the command: a receipt cached at an identical tree, rewritten as a reuse by inputs, is refused by verify.
  git(p.repo, 'commit', '-q', '--allow-empty', '-m', 'même arbre');
  await p.run();
  const cached = (await p.run(['--json'])).json();
  assert.deepEqual(statuses(cached), { integration: 'cached', browser: 'cached' });
  const file = join(p.repo, '.apv', 'receipts', cached.runId, 'integration.json');
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...receipt, reuse: { ...receipt.reuse, basis: 'inputs' } }));
  const refused = await p.verify('HEAD');
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, new RegExp(`integration[^\\n]*${DISABLED.source}`));
});

test('M1 (d1): the declaration of the base is already wrong (a merged PR made the check read docs/data.json): a PR that changes it alone runs the check, which fails; verify refuses', async t => {
  const f = fixture(t, { files: { 'src/check.js': 'console.log("ok");\n', 'docs/data.json': '{"ok":true}\n', 'docs/notes.md': 'n0\n' } });
  write(f.repo, '.apv/config.json', { gates: [{ id: 'unit', command: [process.execPath, 'src/check.js'], reuse: { ignore: ['docs/**'] } }] });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'M1 : unit ignore docs');
  write(f.repo, 'src/check.js', 'const d = require("../docs/data.json"); if (!d.ok) { console.error("KO"); process.exit(1); } console.log("ok");\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'M2 (PR fusionnée) : lit docs/data.json, déclaration inchangée');
  git(f.repo, 'checkout', '-q', '-b', 'feat');
  const run = async () => { const r = await apv(f.repo, ['gates', 'run', '--against', 'main', '--json']); return { r, s: statuses(r.json()) }; };
  write(f.repo, 'docs/notes.md', 'n1\n'); git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'C1 : docs/notes.md seul');
  assert.deepEqual((await run()).s, { unit: 'passed' });
  write(f.repo, 'docs/data.json', '{"ok":false}\n'); git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'C2 : docs/data.json seul');
  const second = await run();
  assert.deepEqual(second.s, { unit: 'failed' }, 'run, and really fails');
  assert.match(second.r.stderr, DISABLED);
  const verified = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--against', 'main']);
  assert.equal(verified.code, 1, verified.stdout);
});

test('M1 (b7): checks that declare reuse.ignore, origins on many commits that differ by ignored files only: nothing is reused by inputs', async t => {
  const ignore = ['docs/**', '**/*.md', 'tests/e2e/browser/**', '.apv/state/**'];
  const f = fixture(t, { files: { 'docs/n.md': '0\n', 'src/a.mjs': 'export const a = 1;\n' } });
  write(f.repo, '.apv/config.json', { gates: [0, 1, 2].map(i => ({ id: `g${i}`, command: [process.execPath, '-e', String(i)], reuse: { ignore } })) });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'main');
  git(f.repo, 'checkout', '-q', '-b', 'feat');
  for (const k of [1, 2, 3]) {
    write(f.repo, 'docs/n.md', `${k}\n`); git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', `c${k}`);
    assert.equal((await apv(f.repo, ['gates', 'run', '--against', 'main', '--replay', 'all', '--json'])).code, 0);
  }
  write(f.repo, 'docs/n.md', 'last\n'); git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'last');
  const last = await apv(f.repo, ['gates', 'run', '--against', 'main', '--json']);
  assert.deepEqual(statuses(last.json()), { g0: 'passed', g1: 'passed', g2: 'passed' });
  assert.deepEqual(last.json().reused, []);
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--against', 'main'])).code, 0, 'the receipts are executions');
});

test('F1-bis (d4): a generated folder made a registered worktree inside the copy, whose file changes: run again, verify refuses; unchanged, still reused', async t => {
  const f = fixture(t, { files: { '.gitignore': 'node_modules/\ndist/\n.svelte-kit/\n' } });
  write(f.repo, '.apv/config.json', { gates: [
    { id: 'gen', command: [process.execPath, '-e', 'process.exit(require("fs").readFileSync(".svelte-kit/types.txt", "utf8").trim() === "v1" ? 0 : 1)'] }] });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'c0');
  git(f.repo, 'worktree', 'add', '-q', '--detach', join(f.repo, '.svelte-kit'), 'HEAD');
  write(f.repo, '.svelte-kit/types.txt', 'v1\n');
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
  git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'c1');
  assert.deepEqual(statuses((await apv(f.repo, ['gates', 'run', '--json'])).json()), { gen: 'passed' });
  git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'même arbre, même état');
  assert.deepEqual(statuses((await apv(f.repo, ['gates', 'run', '--json'])).json()), { gen: 'cached' }, 'the same nested state: reused');
  write(f.repo, '.svelte-kit/types.txt', 'v2\n');
  git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'c2');
  const fresh = await apv(f.repo, ['gates', 'run', '--json']);
  assert.deepEqual(statuses(fresh.json()), { gen: 'failed' });
  assert.match(fresh.stderr, /gen : non repris \(.*autre environnement .*worktrees et sous-modules de la copie\)/);
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD'])).code, 1);
});

test('D2 (d2): a submodule checked out at another commit behind ignore = all: the tree is dirty and its HEAD is part of the state; never reused', async t => {
  const sub = fixture(t, { files: { 'v.txt': 'ok\n' } });
  const good = git(sub.repo, 'rev-parse', 'HEAD');
  write(sub.repo, 'v.txt', 'KO\n'); git(sub.repo, 'commit', '-qam', 'bad');
  const bad = git(sub.repo, 'rev-parse', 'HEAD');
  git(sub.repo, 'checkout', '-q', good);
  const f = fixture(t);
  git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.repo, 'lib');
  const lib = join(f.repo, 'lib');
  git(lib, 'checkout', '-q', good);
  git(f.repo, 'config', '-f', '.gitmodules', 'submodule.lib.ignore', 'all');
  const check = [process.execPath, '-e', 'process.exit(require("fs").readFileSync("lib/v.txt", "utf8").trim() === "ok" ? 0 : 1)'];
  write(f.repo, '.apv/config.json', { gates: [{ id: 'sub', command: check }] });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'c1');
  const before = await copyStateDigest(f.repo);
  const state = checkoutState(lib);
  assert.match(state, new RegExp(`^${good}:[0-9a-f]{64}$`));
  assert.deepEqual(statuses((await apv(f.repo, ['gates', 'run', '--json'])).json()), { sub: 'passed' });
  git(lib, 'checkout', '-q', bad);
  git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'c2');
  assert.equal(git(f.repo, 'status', '--porcelain'), '', 'git status alone says nothing (ignore = all)');
  assert.notEqual(await copyStateDigest(f.repo), before, 'the HEAD of the submodule is part of the state');
  assert.notEqual(git(f.repo, 'status', '--porcelain', '--ignore-submodules=none'), '');
  const second = await apv(f.repo, ['gates', 'run', '--json']);
  assert.notEqual(statuses(second.json()).sub, 'cached', second.stderr);
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD'])).code, 1);
  // Back to the commit the tree records, clean: the reuse at an identical tree stays.
  git(lib, 'checkout', '-q', good);
  git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'c3');
  assert.equal(await copyStateDigest(f.repo), before);
  assert.deepEqual(statuses((await apv(f.repo, ['gates', 'run', '--json'])).json()), { sub: 'cached' });
});

test('AC-REUSE-NEVER-IGNORE: the loader refuses a reuse.ignore that covers a file never ignorable; it accepts the example of the specification', () => {
  const messages = reuse => configIssues({ gates: [{ id: 'integration', stage: 'full', command: ['npm', 'test'], testPaths: ['tests/integration/**/*.test.ts'], reuse }] })
    .issues.map(i => i.message).join('\n');
  assert.equal(messages({ ignore: SPEC_IGNORE, maxAgeMs: 172_800_000 }), '');
  assert.equal(messages({ maxAgeMs: 21_600_000 }), '');
  for (const [glob, kind] of [['package-lock.json', /manifeste ou verrou des dépendances/], ['**/package-lock.json', /package-lock\.json/], ['PACKAGE-LOCK.JSON', /manifeste/],
    ['.apv/config.json', /configuration des contrôles/], ['.apv/**', /configuration des contrôles/], ['supabase/migrations/**', /migration/], ['**/*.sql', /migration/],
    ['tests/integration/**', /chemin de test du contrôle/], ['tests/**/*.test.ts', /chemin de test du contrôle/], ['**', /never ignorable/], ['scripts/**', /script/],
    ['.env*', /fichier \.env\*/], ['**/.env.local', /\.env/], ['vite.config.ts', /configuration de build/], ['**/*.config.*', /configuration de build/],
    ['.github/**', /CI/], ['**/*.json', /never ignorable/]]) {
    assert.match(messages({ ignore: [glob] }), new RegExp(`reuse\\.ignore « ${glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} » covers .*${kind.source}`), glob);
  }
  assert.match(messages(true), /reuse accepts false .* or \{ ignore, maxAgeMs \}/);
  assert.match(messages({}), /reuse \{\} says nothing/);
  assert.match(messages({ maxAgeMs: 3_600_000 }), /gates\[0\]\.reuse\.maxAgeMs/);
  assert.match(messages({ maxAgeMs: 8 * 24 * HOUR }), /gates\[0\]\.reuse\.maxAgeMs/);
  assert.match(messages({ ignore: ['docs/{a,b}/**'] }), /reuse\.ignore: Unsupported glob/);
  assert.match(messages({ ignore: [`${'*/'.repeat(17)}x`] }), /17 wildcards/);
  assert.match(messages({ ignore: [] }), /gates\[0\]\.reuse\.ignore/);
});

test('reuse.maxAgeMs is read at the base: declared at the base and now, an origin of 30 h is reused; declared by the PR alone, 24 h hold', async t => {
  const p = inputsProject(t, { reuse: { ignore: ['docs/**'] } });
  const config = JSON.parse(readFileSync(join(p.repo, '.apv/config.json'), 'utf8'));
  config.gates[0].reuse.maxAgeMs = 172_800_000;
  const head = p.commit({ '.apv/config.json': JSON.stringify(config, null, 2) });
  const loaded = loadConfig(p.repo).config;
  const run = await runGates({ repo: p.repo, config: loaded, stage: 'full', base: 'main', log: () => {} });
  const o = run.receipts.find(r => r.gateId === 'integration');
  git(p.repo, 'commit', '-q', '--allow-empty', '-m', 'même arbre');
  const same = git(p.repo, 'rev-parse', 'HEAD');
  const now = o.startedAt + 30 * HOUR;
  const cached = { ...o, id: randomUUID(), candidateSha: same, status: 'cached', reusedFrom: o.id, startedAt: now, durationMs: 0,
    reuse: { fromRun: o.runId, fromCommit: head, basis: 'tree', inputsDigest: (await inputsDigest(new Git(), p.repo, same)).digest, ignoreDigest: sha256('[]'),
      environment: o.reuseIdentity, changed: 0, files: [] } };
  const at = reference => reuseContext({ git: new Git(), repo: p.repo, commit: same, configHash: gatesConfigHash(loaded), now, store: p.store, local: readLocal(p.repo), reference });
  assert.ok((await checkReuse(at(head), loaded.gates[0], found(cached))).origin, 'maxAgeMs 48 h at the base (the head itself) and now');
  assert.match((await checkReuse(at('main'), loaded.gates[0], found(cached))).reason, /origine trop vieille \(30 h, au plus 24 h\)/);
});

test('AC-REUSE-STACK: without stacks[].fingerprint, an origin on stack 2 is not reused for stack 3; with the same fingerprint it is, with another not', { skip: !hasFlock && 'flock(1) missing' }, async t => {
  const f = fixture(t);
  const out = join(f.root, 'stacks.log');
  const lock2 = join(f.root, 'stack2.lock'); const lock3 = join(f.root, 'stack3.lock');
  const gate = { id: 'integration', stage: 'full', passEnv: ['MODE', 'DB_PORT', 'DB_URL', 'API', 'LOCK_FILE'], lock: { file: lock2, fileEnv: 'LOCK_FILE' },
    command: [process.execPath, '-e', `require("fs").appendFileSync(${JSON.stringify(out)}, process.env.MODE + ":" + process.env.DB_PORT + "\\n")`] };
  const printer = text => [process.execPath, '-e', `process.stdout.write(${text})`];
  // The addresses of each stack differ (ports, URLs, host:port, lock file); MODE says how the check runs, not where.
  const address = port => ({ DB_PORT: String(port), DB_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, API: `127.0.0.1:${port + 1}` });
  const configure = (fingerprints, modes = ['ci', 'ci']) => {
    write(f.repo, '.apv/config.json', { gates: [gate], stacks: [
      { id: '2', lockFile: lock2, ports: [57322, 57323], env: { MODE: modes[0], ...address(57322) }, ...(fingerprints ? { fingerprint: fingerprints[0] } : {}) },
      { id: '3', lockFile: lock3, ports: [57422, 57423], env: { MODE: modes[1], ...address(57422) }, ...(fingerprints ? { fingerprint: fingerprints[1] } : {}) }] });
    git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'piles');
  };
  const env = { APV_LOCK_DIR: join(f.root, 'locks'), APV_LOCK_POLL_MS: '20' };
  const run = async stack => { const r = await apv(f.repo, ['gates', 'run', '--stage', 'full', '--stacks', stack, '--json'], env); assert.equal(r.code, 0, r.stdout + r.stderr); return r; };
  const same = () => git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'même arbre');
  const ran = () => readFileSync(out, 'utf8').trim().split('\n');
  // Without a fingerprint: another stack is another environment.
  configure(null);
  await run('2'); same();
  assert.deepEqual(statuses((await run('3')).json()), { integration: 'passed' });
  assert.deepEqual(ran(), ['ci:57322', 'ci:57422']);
  same();
  assert.deepEqual(statuses((await run('3')).json()), { integration: 'cached' }, 'the same stack again: reused');
  // The same fingerprint on both stacks (the same images, the same CLI): reused from stack 2 for stack 3.
  configure([printer('"supabase 2.117.0 postgres@sha256:aaa"'), printer('"supabase 2.117.0 postgres@sha256:aaa"')]);
  await run('2'); same();
  const reused = await run('3');
  assert.deepEqual(statuses(reused.json()), { integration: 'cached' });
  assert.equal(reused.json().reused[0].stack, '3', 'the stack it is reused for');
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD'])).code, 0);
  assert.equal(ran().length, 3);
  // The same fingerprint, but a variable of the stack that is not an address differs (F3 of the relecture of A2): run again.
  configure([printer('"supabase 2.117.0 postgres@sha256:aaa"'), printer('"supabase 2.117.0 postgres@sha256:aaa"')], ['ci', 'ci-lent']);
  await run('2'); same();
  assert.deepEqual(statuses((await run('3')).json()), { integration: 'passed' }, 'MODE=ci and MODE=ci-lent stay apart');
  // Another output (another image on stack 3): run again; a fingerprint that fails or prints nothing: never reused.
  configure([printer('"supabase 2.117.0 postgres@sha256:aaa"'), printer('"supabase 2.117.0 postgres@sha256:bbb"')]);
  await run('2'); same();
  assert.deepEqual(statuses((await run('3')).json()), { integration: 'passed' });
  configure([printer('""'), printer('""')]);
  await run('2'); same();
  const empty = await run('2');
  assert.deepEqual(statuses(empty.json()), { integration: 'passed' });
  assert.match(empty.stderr, /Pile 2 : empreinte \(stacks\[\]\.fingerprint\) vide : aucun contrôle de cette pile n'est repris/);
});

test('F-D1: the local state follows the .env* files at any depth (outside node_modules, .git and nested worktrees), the lock of pnpm, and a node_modules without record', async t => {
  const f = fixture(t);
  const before = localStateDigest(f.repo);
  write(f.repo, 'apps/web/.env.local', 'OK\n');
  const ok = localStateDigest(f.repo);
  assert.notEqual(ok, before, 'apps/web/.env.local (att6)');
  write(f.repo, 'apps/web/.env.local', 'BAD\n');
  assert.notEqual(localStateDigest(f.repo), ok);
  write(f.repo, 'apps/web/.env.local', 'OK\n');
  assert.equal(localStateDigest(f.repo), ok, 'content, not date');
  // A worktree Git has registered (.worktrees/x), node_modules and .git: never walked.
  git(f.repo, 'worktree', 'add', '-q', '--detach', join(f.repo, '.worktrees', 'x'), 'HEAD');
  write(f.repo, '.worktrees/x/.env', 'AUTRE=1\n');
  write(f.repo, 'apps/web/node_modules/pkg/.env', 'X=1\n');
  assert.equal(localStateDigest(f.repo), ok);
  // A folder that merely holds an entry named .git (F1 of the relecture of A2): walked like any other.
  write(f.repo, 'gen/.git', '');
  write(f.repo, 'gen/.env', 'AUTRE=1\n');
  const fake = localStateDigest(f.repo);
  assert.notEqual(fake, ok, 'gen/.env is seen whatever gen/.git says');
  write(f.repo, 'gen/.env', 'AUTRE=2\n');
  assert.notEqual(localStateDigest(f.repo), fake);
  rmSync(join(f.repo, 'gen'), { recursive: true });
  assert.equal(localStateDigest(f.repo), ok);
  // node_modules with a record of npm, then the lock of the virtual store of pnpm.
  write(f.repo, 'node_modules/.package-lock.json', '{}');
  const npm = localStateDigest(f.repo);
  write(f.repo, 'node_modules/.pnpm/lock.yaml', 'lockfileVersion: 9\n');
  assert.notEqual(localStateDigest(f.repo), npm);
  // A node_modules with no record (att8: installed by bun or by hand): never the same state twice.
  rmSync(join(f.repo, 'node_modules'), { recursive: true });
  mkdirSync(join(f.repo, 'node_modules', 'dep'), { recursive: true });
  assert.notEqual(localStateDigest(f.repo), localStateDigest(f.repo));
});

test('F-D1 (att8): the files Git ignores in a copy (a generated folder) are part of its state; the receipts of APV and node_modules are not', async t => {
  const f = fixture(t, { files: { '.gitignore': 'node_modules/\ndist/\n.svelte-kit/\n' } });
  const before = await copyStateDigest(f.repo);
  assert.equal(await copyStateDigest(f.repo), before, 'stable');
  write(f.repo, '.svelte-kit/types.txt', 'v1\n');
  const v1 = await copyStateDigest(f.repo);
  assert.notEqual(v1, before);
  write(f.repo, '.svelte-kit/types.txt', 'v2\n');
  assert.notEqual(await copyStateDigest(f.repo), v1);
  write(f.repo, '.svelte-kit/types.txt', 'v1\n');
  assert.equal(await copyStateDigest(f.repo), v1);
  write(f.repo, '.apv/receipts/.gitignore', '*\n');
  write(f.repo, '.apv/receipts/run/x.json', '{}');
  write(f.repo, 'node_modules/dep/version', '1.0.0');
  assert.equal(await copyStateDigest(f.repo), v1, 'receipts and node_modules left out (node_modules: the local state)');
  // A tracked file is never part of it: the tree is.
  write(f.repo, 'src/math.mjs', 'export const add = (a, b) => a + b;\n');
  assert.equal(await copyStateDigest(f.repo), v1);
  // An entry named .git in the ignored folder (b5d of the relecture of A2, F1): the folder stays part of the state.
  write(f.repo, '.svelte-kit/.git', '');
  const marked = await copyStateDigest(f.repo);
  write(f.repo, '.svelte-kit/types.txt', 'v2\n');
  assert.notEqual(await copyStateDigest(f.repo), marked, '.svelte-kit/types.txt is seen whatever .svelte-kit/.git says');
  write(f.repo, '.svelte-kit/types.txt', 'v1\n');
  assert.equal(await copyStateDigest(f.repo), marked);
  rmSync(join(f.repo, '.svelte-kit/.git'));
  // A worktree Git has registered inside the copy, under an ignored folder (F1-bis of the delta review of A2): never left out
  // without being measured. Its HEAD, its status and its files are part of the state; the same state twice is still equal.
  write(f.repo, '.gitignore', 'node_modules/\ndist/\n.svelte-kit/\n.worktrees/\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'ignore worktrees');
  const before2 = await copyStateDigest(f.repo);
  git(f.repo, 'worktree', 'add', '-q', '--detach', join(f.repo, '.worktrees', 'w'), 'HEAD');
  const added = await copyStateDigest(f.repo);
  assert.notEqual(added, before2, 'a new worktree inside the copy');
  assert.equal(await copyStateDigest(f.repo), added, 'stable');
  write(f.repo, '.worktrees/w/types.txt', 'v1\n');
  const v1w = await copyStateDigest(f.repo);
  assert.notEqual(v1w, added, 'an untracked file of the worktree');
  write(f.repo, '.worktrees/w/types.txt', 'v2\n');
  assert.notEqual(await copyStateDigest(f.repo), v1w, 'its content, not only its status (d4)');
  write(f.repo, '.worktrees/w/types.txt', 'v1\n');
  assert.equal(await copyStateDigest(f.repo), v1w);
  write(f.repo, '.worktrees/w/.svelte-kit/types.txt', 'v9\n');
  assert.notEqual(await copyStateDigest(f.repo), v1w, 'a file it ignores');
  rmSync(join(f.repo, '.worktrees/w/.svelte-kit'), { recursive: true });
  rmSync(join(f.repo, '.worktrees/w/types.txt'));
  assert.equal(await copyStateDigest(f.repo), added);
  // Its HEAD: another commit of the same tree is another state.
  git(join(f.repo, '.worktrees', 'w'), 'commit', '-q', '--allow-empty', '-m', 'autre HEAD');
  assert.notEqual(await copyStateDigest(f.repo), added, 'its HEAD');
  // A folder of .worktrees that is no registered worktree, even with a .git file: part of the state.
  const now = await copyStateDigest(f.repo);
  write(f.repo, '.worktrees/faux/.git', 'gitdir: ailleurs\n');
  assert.notEqual(await copyStateDigest(f.repo), now);
});

test('F-D1 (att8) through apv gates run: another generated folder, or dependencies without record, in a copy of the same tree: run again', async t => {
  const f = fixture(t, { files: { '.gitignore': 'node_modules/\ndist/\n.svelte-kit/\n' } });
  write(f.repo, '.apv/config.json', { gates: [
    { id: 'gen', command: [process.execPath, '-e', 'process.exit(require("fs").readFileSync(".svelte-kit/types.txt", "utf8").trim() === "v1" ? 0 : 1)'] }] });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  const copy = (name, types) => {
    const dir = join(f.root, name);
    git(f.repo, 'worktree', 'add', '-q', '--detach', dir, 'HEAD');
    write(dir, '.svelte-kit/types.txt', types);
    return dir;
  };
  const x = copy('x', 'v1\n');
  assert.deepEqual(statuses((await apv(x, ['gates', 'run', '--json'])).json()), { gen: 'passed' });
  git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'même arbre');
  const z = copy('z', 'v1\n');
  assert.deepEqual(statuses((await apv(z, ['gates', 'run', '--json'])).json()), { gen: 'cached' }, 'the same generated state: reused');
  git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'même arbre');
  const y = copy('y', 'v2\n');
  const fresh = await apv(y, ['gates', 'run', '--json']);
  assert.deepEqual(statuses(fresh.json()), { gen: 'failed' });
  assert.match(fresh.stderr, /gen : non repris \(.*autre environnement .*fichiers générés, fichiers \.env\*, worktrees et sous-modules de la copie\)/);
});

test('F-D2: a network audit or the history of Git behind sh -c "npm run x", --prefix, node --run, npx npm-check-updates, ncu, git --no-pager or -C is never reused', async t => {
  const scripts = { sec: 'true || npm audit --audit-level=high', 'audit:ci': 'true || npm audit', test: 'vitest run', hist: 'git --no-pager log -1', fine: 'git -C . diff --check' };
  const node = process.execPath;
  for (const argv of [['npm', '--prefix', '.', 'run', 'sec'], ['npm', '-C', 'x', 'run', 'sec'], ['pnpm', '--filter', 'web', 'run', 'sec'], ['npm', '-w', 'web', 'run', 'sec'],
    ['npm', '--loglevel', 'silent', 'run', 'sec'], ['sh', '-c', 'npm run sec'], ['bash', '-lc', 'cd . && npm run --silent audit:ci'], [node, '--run', 'sec'], [node, '--run=sec'],
    ['sh', '-c', 'true || npx npm-check-updates --errorLevel 2'], ['ncu', '-e', '2'], ['npx', 'npm-check-updates'],
    ['sh', '-c', 'git --no-pager log -1 --format=%B | grep -q . '], ['sh', '-c', 'git -C . log -1 --format=%B | grep -q .'], ['git', '-c', 'core.pager=cat', 'log'],
    ['git', '--git-dir', '.git', 'show', 'HEAD'], ['npm', 'run', 'hist'], [node, '-e', 'require("child_process").execSync("npm run sec")'],
    [node, '-e', 'require("child_process").execFileSync("git", ["--no-pager", "log", "-1"])']]) {
    assert.ok(neverReused({ command: argv }, scripts), argv.join(' '));
  }
  // Accepted: what reads the tree only, through the same forms.
  for (const argv of [['npm', '--prefix', '.', 'run', 'test'], [node, '--run', 'test'], ['sh', '-c', 'npm run test'], ['git', '-C', '.', 'diff', '--check'],
    ['git', '--no-pager', 'diff'], ['npm', 'run', 'fine'], ['pnpm', '--filter', 'web', 'test']]) {
    assert.equal(neverReused({ command: argv }, scripts), null, argv.join(' '));
  }
  // The scripts of every package.json of the commit: a workspace script that audits is found.
  const f = fixture(t, { files: { 'package.json': JSON.stringify({ name: 'root', private: true, scripts: { test: 'vitest run' } }),
    'packages/web/package.json': JSON.stringify({ name: 'web', scripts: { 'audit:deps': 'npm audit --omit=dev', test: 'vitest' } }) } });
  const read = await projectScripts(new Git(), f.repo, git(f.repo, 'rev-parse', 'HEAD'));
  assert.deepEqual(read.test, ['vitest run', 'vitest']);
  assert.match(neverReused({ command: ['pnpm', '--filter', 'web', 'run', 'audit:deps'] }, read), /audit des dépendances qui lit le réseau .*« audit:deps »/);
  assert.equal(neverReused({ command: ['pnpm', '--filter', 'web', 'test'] }, read), null);
});

test('F2 and F2-bis (relecture sécurité de A2 and of its delta): only a closed list of git subcommands on the tree is reused; an alias, -c alias.*, a revision or the history never', () => {
  const refused = [['sh', '-c', 'git rev-parse HEAD >/dev/null'], ['sh', '-c', 'git diff --quiet HEAD~1 HEAD'], ['sh', '-c', 'git cat-file -p HEAD | grep -q Signed-off-by'],
    ['git', 'branch', '--contains', 'HEAD'], ['env', 'LC_ALL=C', 'git', 'log', '-1'], ['git', 'diff', 'main'], ['git', '-C', '.', 'diff', '--stat', 'origin/main...'],
    ['git', 'show-ref'], ['git', 'tag', '--points-at', 'HEAD'], ['git', 'ls-tree', 'HEAD~1'], ['git', 'diff-tree', '-r', 'HEAD'], ['git', 'archive', 'HEAD'],
    ['git', 'grep', '-n', 'TODO', 'HEAD~1'], ['git', 'grep', '-e', 'TODO', 'main'], ['git', 'grep', '-O', 'TODO'], ['git', 'status', '-sb'], ['git', 'status', '--branch', '--porcelain=v2'],
    ['git', 'status', '--show-stash'], ['git', 'verify-commit', 'HEAD'], ['git', 'symbolic-ref', 'HEAD'], [process.execPath, '-e', 'require("child_process").execFileSync("git", ["rev-parse", "HEAD"])'],
    ['sh', '-c', 'test "$(git cat-file -t HEAD)" = commit'],
    // F2-bis (d5c, d5b): an alias, by -c or by the configuration (global or local), whatever it names.
    ['git', '-c', 'alias.h=diff', 'h', '--quiet', 'HEAD~1', 'HEAD'], ['git', '-c', 'alias.h=!git log -1 | grep -q c1', 'h'], ['git', '-c', 'ALIAS.d=diff', 'd'],
    ['git', 'h', '--quiet'], ['git', 'ci'], ['sh', '-c', 'git -c alias.st=status st'],
    // Any subcommand outside the list, a global option or a setting that points git elsewhere or runs a program.
    ['git', 'add', '-N', '.'], ['git', 'difftool', '--dir-diff'], ['git', 'config', '--get', 'user.name'], ['git', '--git-dir', '/elsewhere/.git', 'diff'],
    ['git', '--work-tree=/elsewhere', 'status'], ['git', '--exec-path=/tmp/x', 'diff'], ['git', '-C', '/elsewhere', 'diff', '--quiet'], ['git', '-C', '../voisin', 'status'],
    ['git', '-c', 'diff.external=./x.sh', 'diff'], ['git', '-c', 'core.fsmonitor=./x.sh', 'status', '--porcelain'], ['git', '--config-env=alias.h=H', 'h'],
    ['git', 'ls-files', '--with-tree=HEAD~1'], ['git', 'check-attr', '--source', 'HEAD~1', 'text', '--', 'a']];
  for (const argv of refused) assert.match(neverReused({ command: argv }) ?? '', /il lance git/, argv.join(' '));
  assert.match(neverReused({ command: ['git', '-c', 'alias.h=diff', 'h'] }), /git -c alias\.h, un alias dont la commande n'est pas celle écrite/);
  assert.match(neverReused({ command: ['git', 'h'] }), /git h, hors des sous-commandes reprenables/);
  for (const argv of [['git', 'diff', '--check'], ['git', 'diff', '--exit-code', '--', 'dist'], ['git', '--no-pager', 'diff', '--quiet'], ['git', 'grep', '-n', 'TODO'],
    ['git', 'grep', '-e', 'TODO', '--', 'src'], ['git', 'status', '--porcelain'], ['git', 'ls-files', '--others', '--exclude-standard'], ['sh', '-c', 'git diff --exit-code && npm test'],
    ['git', '-C', 'packages/web', 'diff', '--check'], ['git', '-c', 'color.ui=never', 'diff', '--check'], ['git', '-c', 'core.fsmonitor=false', 'status', '--porcelain'],
    ['git', 'diff-files', '--quiet'], ['git', 'check-ignore', '-q', 'dist'], ['git', '--version']]) {
    assert.equal(neverReused({ command: argv }), null, argv.join(' '));
  }
});

test('F3 (relecture sécurité de A2 and of its delta): with a fingerprint, only the ports the stack declares in ports and its lock file are normalized; any other value stays', async () => {
  const { stackAddress } = await import('../dist/gates/run.js');
  const stack = { config: { id: '2', lockFile: '/x/2.lock', ports: [54321, 57322] }, lockFile: '/x/2.lock' };
  for (const [name, value, expected] of [
    ['DB_PORT', '57322', '{{port}}'], ['SUPA', '54321', '{{port}}'], ['N', '57322', '{{port}}'], ['LOCK_FILE', '/x/2.lock', '{{verrou de la pile}}'],
    ['DB_URL', 'postgresql://postgres:pw@127.0.0.1:57322/postgres?ssl=0', 'postgresql://postgres:pw@127.0.0.1:{{port}}/postgres?ssl=0'],
    ['API_URL', 'http://[::1]:54321', 'http://[::1]:{{port}}'], ['API', 'localhost:54321', 'localhost:{{port}}'],
    // Not declared in ports: kept, whatever the name of the variable.
    ['DB_PORT', '57399', '57399'], ['PORTS', '3000', '3000'], ['API', 'localhost:54331', 'localhost:54331'],
    ['DB_URL', 'postgresql://postgres@127.0.0.1:5432/db', 'postgresql://postgres@127.0.0.1:5432/db'],
    ['HOST_PORT', 'postgres:15', 'postgres:15'], ['HOST_PORT', 'postgres:16', 'postgres:16'], ['IMAGE', 'node:22', 'node:22'],
    ['STACK', '2', '2'], ['MODE', 'ci', 'ci'], ['PROJECT', 'suivie-2', 'suivie-2'], ['DB_URL2', 'postgresql://postgres@127.0.0.1/db2', 'postgresql://postgres@127.0.0.1/db2'],
    ['FLAG', 'true', 'true']]) {
    assert.equal(stackAddress(name, value, stack), expected, `${name}=${value}`);
  }
  assert.equal(stackAddress('X', '57322', { config: { id: '3' }, lockFile: null }), '57322', 'a stack that declares no port normalizes none');
});
