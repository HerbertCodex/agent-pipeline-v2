import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { configIssues, loadConfig } from '../dist/config/load.js';
import { Git } from '../dist/execution/git.js';
import { runGates, gatesConfigHash } from '../dist/gates/run.js';
import { copyStateDigest, inputsDigest, localStateDigest } from '../dist/gates/reuse.js';
import { checkReuse, neverReused, projectScripts, readLocal, reuseContext } from '../dist/gates/reuse-proof.js';

/**
 * PR A2 of docs/ACCELERATION-LOTS.md (5.2 A2, 5.4, 5.5; AC-REUSE-INPUTS, AC-REUSE-NEVER-IGNORE, AC-REUSE-BASE, AC-REUSE-STACK):
 * a check that declares at the base the files it never reads (`reuse.ignore`) is reused when every file changed since a
 * green origin is one of them, `apv gates verify` recomputes it from Git with the globs of the base, and nothing that is an
 * input is ever ignored. With the faint findings of the delta review of A1 (ticket #149): F-D1 (local state of the copy) and
 * F-D2 (commands that read a state outside the tree). Each refusal has its accepted case next to it.
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

test('AC-REUSE-INPUTS: only a browser test and two of its images changed: integration reused (basis inputs), browser run; with a source file too, both run', async t => {
  const p = inputsProject(t);
  // The origin, like the commit reused, differs from the base by ignored files only (E1 of the relecture of A2).
  const a = p.commit({ 'docs/notes.md': 'notes 1b\n' });
  const first = await p.run(['--json']);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.deepEqual(p.ran(), ['integration', 'browser']);
  const b = p.commit({ 'tests/e2e/browser/x.e2e.ts': 'e2e 2\n', 'tests/e2e/browser/x.e2e.ts-snapshots/a.png': 'png a2', 'tests/e2e/browser/x.e2e.ts-snapshots/b.png': 'png b2' });
  const second = await p.run(['--json']);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  const result = second.json();
  assert.deepEqual(statuses(result), { integration: 'cached', browser: 'passed' });
  assert.deepEqual(p.ran(), ['integration', 'browser', 'browser'], 'integration not run again');
  assert.deepEqual(result.reused.map(r => [r.gateId, r.fromCommit, r.basis, r.changed, r.reason]),
    [['integration', a, 'inputs', 3, 'entrées identiques : 3 fichier(s) changé(s), tous ignorés par ce contrôle']]);
  const cached = p.receiptOf(result.runId, 'integration');
  const origin = p.receiptOf(first.json().runId, 'integration');
  assert.deepEqual([cached.reuse.basis, cached.reuse.fromCommit, cached.reuse.changed, cached.reusedFrom, cached.reuse.environment],
    ['inputs', a, 3, origin.id, origin.reuseIdentity]);
  assert.deepEqual(cached.reuse.files, ['tests/e2e/browser/x.e2e.ts', 'tests/e2e/browser/x.e2e.ts-snapshots/a.png', 'tests/e2e/browser/x.e2e.ts-snapshots/b.png']);
  assert.equal(cached.reuse.ignoreDigest, sha256(JSON.stringify([...SPEC_IGNORE].sort())));
  assert.match(second.stderr, new RegExp(`integration : réutilisé de ${a.slice(0, 12)} \\(exécution ${first.json().runId}, entrées identiques : 3 fichier\\(s\\) changé\\(s\\), tous ignorés par ce contrôle\\) : non relancé`));
  // verify proves it from Git with the globs of the base.
  const verified = await p.verify(b);
  assert.equal(verified.code, 0, verified.stdout);
  assert.match(verified.stdout, /entrées identiques : 3 fichier\(s\) changé\(s\)/);
  // The same commit with a source file too: integration reads it, both run.
  p.commit({ 'tests/e2e/browser/x.e2e.ts': 'e2e 3\n', 'src/lib/x.ts': 'export const x = 3;\n' });
  const third = await p.run(['--json']);
  assert.deepEqual(statuses(third.json()), { integration: 'passed', browser: 'passed' });
  assert.deepEqual(p.ran().slice(3), ['integration', 'browser']);
});

test('AC-REUSE-INPUTS: verify proves a reuse by inputs only against a target; without one (no --against, no remote), it proves nothing', async t => {
  const p = inputsProject(t);
  p.commit({ 'docs/notes.md': 'notes 1b\n' });
  assert.equal((await p.run()).code, 0);
  const b = p.commit({ 'docs/notes.md': 'notes 2\n' });
  assert.deepEqual(statuses((await p.run(['--json'])).json()), { integration: 'cached', browser: 'passed' });
  assert.equal((await p.verify(b)).code, 0);
  const alone = await p.verify(b, []);
  assert.equal(alone.code, 1);
  assert.match(alone.stdout, /integration.*aucune cible pour lire la déclaration à la base/s);
});

test('AC-REUSE-INPUTS: a forged or stale receipt cached by inputs proves nothing (digest, files, globs, an input changed); the real one does', async t => {
  const p = inputsProject(t);
  const a = p.commit({ 'docs/notes.md': 'notes 1b\n' });
  assert.equal((await p.run()).code, 0);
  const b = p.commit({ 'tests/e2e/browser/x.e2e.ts': 'e2e 2\n' });
  const second = (await p.run(['--json'])).json();
  const cached = p.receiptOf(second.runId, 'integration');
  const { config, ctx } = ctxOf(p, b, { reference: 'main' });
  const gate = config.gates[0];
  assert.ok((await checkReuse(ctx, gate, found(cached))).origin, 'the receipt written by the run');
  const tampered = async (reuse, reason) => {
    const { ctx: fresh } = ctxOf(p, b, { reference: 'main' });
    assert.match((await checkReuse(fresh, gate, found({ ...cached, reuse: { ...cached.reuse, ...reuse } }))).reason, reason);
  };
  await tampered({ inputsDigest: 'f'.repeat(64) }, /empreinte des entrées différente/);
  await tampered({ changed: 2 }, /fichiers changés déclarés différents/);
  await tampered({ files: ['docs/notes.md'] }, /fichiers changés déclarés différents/);
  await tampered({ ignoreDigest: sha256(JSON.stringify(['**'])) }, /globs ignorés du reçu différents de reuse\.ignore lu à la base/);
  // At a commit where integration reads a changed file, the same record proves nothing.
  const c = p.commit({ 'src/lib/x.ts': 'export const x = 3;\n' });
  const { ctx: atC } = ctxOf(p, c, { reference: 'main' });
  assert.match((await checkReuse(atC, gate, found({ ...cached, candidateSha: c }))).reason, /1 fichier\(s\) lu\(s\) par le contrôle changé\(s\) depuis .*src\/lib\/x\.ts/);
  // Without any target: the globs of the base cannot be read.
  const { ctx: none } = ctxOf(p, b);
  assert.match((await checkReuse(none, gate, found(cached))).reason, /aucune cible/);
  assert.equal(cached.reuse.fromCommit, a);
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

test('AC-REUSE-NEVER-IGNORE at run: **/*.md never takes content the application serves out of the inputs; documentation stays ignored', async t => {
  const p = inputsProject(t);
  p.commit({ 'docs/notes.md': 'notes 1b\n' });
  assert.equal((await p.run()).code, 0);
  p.commit({ 'docs/notes.md': 'notes 2\n', 'README.md': '# Autre\n' });
  assert.deepEqual(statuses((await p.run(['--json'])).json()), { integration: 'cached', browser: 'passed' });
  p.commit({ 'src/routes/page.md': '# Page servie modifiée\n' });
  const served = await p.run(['--json']);
  assert.deepEqual(statuses(served.json()), { integration: 'passed', browser: 'passed' }, 'src/routes/page.md is an input whatever **/*.md says');
  assert.match(served.stderr, /integration : non repris \(.*1 entrée\(s\) du contrôle changée\(s\) entre la base commune [0-9a-f]{12} et le commit [0-9a-f]{12} \(src\/routes\/page\.md\)/);
});

test('AC-REUSE-BASE: a PR that widens reuse.ignore never uses it for its own proof; the globs of the base serve', async t => {
  const p = inputsProject(t, { reuse: { ignore: ['docs/**'] } });
  // The PR widens the globs of integration (and changes the source): the run keeps the definition of the base.
  const config = JSON.parse(readFileSync(join(p.repo, '.apv/config.json'), 'utf8'));
  config.gates[0].reuse.ignore.push('tests/e2e/**');
  const a = p.commit({ '.apv/config.json': JSON.stringify(config, null, 2), 'src/lib/x.ts': 'export const x = 2;\n' });
  const first = await p.run(['--json']);
  assert.equal(first.code, 0, first.stderr);
  p.commit({ 'tests/e2e/browser/x.e2e.ts': 'e2e 2\n' });
  assert.deepEqual(statuses((await p.run(['--json'])).json()), { integration: 'passed', browser: 'passed' }, 'tests/e2e is not ignored at the base');
  p.commit({ 'docs/notes.md': 'notes 2\n' });
  // docs/** is ignored at the base, but this PR changes inputs of the check since the base (its configuration, a source): the
  // declaration of the base holds for the code of the base only (E1), so nothing is reused by inputs in this PR.
  const changedInputs = await p.run(['--json']);
  assert.deepEqual(statuses(changedInputs.json()), { integration: 'passed', browser: 'passed' });
  assert.match(changedInputs.stderr, /integration : non repris \(.*entrée\(s\) du contrôle changée\(s\) entre la base commune .*\(\.apv\/config\.json, src\/lib\/x\.ts, tests\/e2e\/browser\/x\.e2e\.ts\)/);
  // The very check through the API, with the configuration of the PR (never enforced to the base): refused.
  const pr = loadConfig(p.repo).config;
  const origin = await runGates({ repo: p.repo, config: pr, stage: 'full', base: 'main', log: () => {} });
  assert.equal(origin.ok, true);
  const c = p.commit({ 'docs/notes.md': 'notes 3\n' });
  const o = origin.receipts.find(r => r.gateId === 'integration');
  const { ctx } = ctxOf(p, c, { reference: 'main' });
  const cached = { ...o, id: randomUUID(), candidateSha: c, status: 'cached', reusedFrom: o.id, startedAt: Date.now(), durationMs: 0,
    reuse: { fromRun: o.runId, fromCommit: o.candidateSha, basis: 'inputs', inputsDigest: (await inputsDigest(new Git(), p.repo, c, { ignore: pr.gates[0].reuse.ignore, keep: [] })).digest,
      ignoreDigest: sha256(JSON.stringify([...pr.gates[0].reuse.ignore].sort())), environment: o.reuseIdentity, changed: 1, files: ['docs/notes.md'] } };
  assert.match((await checkReuse(ctx, pr.gates[0], found(cached))).reason, /définition de integration changée depuis la base .*la reprise par entrées vaut pour la définition lue à la base/);
  // A check added by the PR with its own reuse.ignore: nothing at the base.
  const added = { ...pr.gates[0], id: 'nouveau' };
  assert.match((await checkReuse(ctx, added, found({ ...cached, gateId: 'nouveau' }))).reason, /reçu d'origine d'un autre contrôle|ne déclare pas reuse\.ignore à la base/);
  const { ctx: fresh } = ctxOf(p, c, { reference: 'main' });
  const { inputsRuleOf } = await import('../dist/gates/reuse-proof.js');
  assert.match((await inputsRuleOf(fresh, added)).reason, /nouveau ne déclare pas reuse\.ignore à la base [0-9a-f]{12} \(main\) : un reuse\.ignore ajouté ou élargi par la PR ne sert jamais à sa propre preuve/);
  assert.equal(a.length, 40);
});

test('AC-REUSE-LATEST-FAIL by inputs: a failure later than the origin on the same inputs makes the check run again; a later green origin is reused', async t => {
  const p = inputsProject(t);
  p.commit({ 'docs/notes.md': 'notes 1b\n' });
  assert.equal((await p.run()).code, 0);
  p.commit({ 'docs/notes.md': 'notes 2\n' });
  writeFileSync(p.flag, '');
  const failed = await p.run(['--replay', 'integration', '--json', '--keep-going']);
  assert.deepEqual(statuses(failed.json()), { integration: 'failed', browser: 'passed' });
  rmSync(p.flag);
  p.commit({ 'docs/notes.md': 'notes 3\n' });
  const again = await p.run(['--json']);
  assert.deepEqual(statuses(again.json()), { integration: 'passed', browser: 'passed' });
  assert.match(again.stderr, /integration : non repris \(.*échec plus récent sur les mêmes entrées : .*integration\.json au commit [0-9a-f]{12} \(failed\) l'emporte/);
  p.commit({ 'docs/notes.md': 'notes 4\n' });
  assert.deepEqual(statuses((await p.run(['--json'])).json()), { integration: 'cached', browser: 'passed' }, 'the green run after the failure is a valid origin');
});

test('a symbolic link among the inputs: no reuse by inputs (its target may be ignored); the reuse at an identical tree stays', async t => {
  // The link is on the base: the PR changes ignored files only (E1), the link alone refuses.
  const p = inputsProject(t, { setup: repo => symlinkSync('../../docs/notes.md', join(repo, 'src/lib/notes.md')) });
  p.commit({ 'docs/notes.md': 'notes 1b\n' });
  assert.equal((await p.run()).code, 0);
  p.commit({ 'docs/notes.md': 'notes 2\n' });
  const linked = await p.run(['--json']);
  assert.deepEqual(statuses(linked.json()), { integration: 'passed', browser: 'passed' });
  assert.match(linked.stderr, /integration : non repris \(.*lien\(s\) symbolique\(s\) parmi les entrées \(src\/lib\/notes\.md\)/);
  git(p.repo, 'commit', '-q', '--allow-empty', '-m', 'même arbre');
  assert.deepEqual(statuses((await p.run(['--json'])).json()), { integration: 'cached', browser: 'cached' });
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
      { id: '2', lockFile: lock2, env: { MODE: modes[0], ...address(57322) }, ...(fingerprints ? { fingerprint: fingerprints[0] } : {}) },
      { id: '3', lockFile: lock3, env: { MODE: modes[1], ...address(57422) }, ...(fingerprints ? { fingerprint: fingerprints[1] } : {}) }] });
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
  // A worktree Git has registered, under an ignored folder: another copy, never part of this one.
  write(f.repo, '.gitignore', 'node_modules/\ndist/\n.svelte-kit/\n.worktrees/\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'ignore worktrees');
  const before2 = await copyStateDigest(f.repo);
  git(f.repo, 'worktree', 'add', '-q', '--detach', join(f.repo, '.worktrees', 'w'), 'HEAD');
  write(f.repo, '.worktrees/w/.svelte-kit/types.txt', 'v9\n');
  assert.equal(await copyStateDigest(f.repo), before2);
  // A folder of .worktrees that is no registered worktree, even with a .git file: part of the state.
  write(f.repo, '.worktrees/faux/.git', 'gitdir: ailleurs\n');
  assert.notEqual(await copyStateDigest(f.repo), before2);
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
  assert.match(fresh.stderr, /gen : non repris \(.*autre environnement .*fichiers générés, fichiers \.env\*\)/);
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

test('E1 (relecture sécurité de A2): a PR makes the check read a file the base declares ignored, then changes only that file: never reused by inputs, by run or by verify; a PR that changes ignored files only is', async t => {
  const f = fixture(t, { files: { 'src/check.js': 'require("./lib.js");\n', 'src/lib.js': 'console.log("ok");\n', 'docs/data.json': '{"ok":true}\n' } });
  write(f.repo, '.apv/config.json', { gates: [{ id: 'unit', command: [process.execPath, 'src/check.js'], reuse: { ignore: ['docs/**'] } }] });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'main : unit ignore docs');
  const run = async () => { const r = await apv(f.repo, ['gates', 'run', '--against', 'main', '--json']); return { r, s: statuses(r.json()) }; };
  // b1/b1r: commit C makes src/lib.js (not named by the command) read docs/data.json, and passes.
  git(f.repo, 'checkout', '-q', '-b', 'feat');
  write(f.repo, 'src/lib.js', 'const d = require("../docs/data.json"); if (!d.ok) { console.error("KO"); process.exit(1); } console.log("ok");\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'C : lit docs/data.json');
  const first = await run();
  assert.deepEqual(first.s, { unit: 'passed' });
  const origin = JSON.parse(readFileSync(join(f.repo, '.apv', 'receipts', first.r.json().runId, 'unit.json'), 'utf8'));
  // C2 changes docs/data.json only, and the check really fails there: run runs it.
  write(f.repo, 'docs/data.json', '{"ok":false}\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'C2 : seul docs/data.json change');
  const c2 = git(f.repo, 'rev-parse', 'HEAD');
  const second = await run();
  assert.deepEqual(second.s, { unit: 'failed' });
  assert.match(second.r.stderr, /unit : non repris \(.*1 entrée\(s\) du contrôle changée\(s\) entre la base commune [0-9a-f]{12} et le commit [0-9a-f]{12} \(src\/lib\.js\)/);
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--against', 'main'])).code, 1);
  // A receipt cached by inputs at C2 from C, true to Git in every other respect (digests, files, globs), proves nothing: the
  // very check verify runs refuses it.
  const config = loadConfig(f.repo).config;
  const ctx = reuseContext({ git: new Git(), repo: f.repo, commit: c2, configHash: gatesConfigHash(config), now: Date.now(), store: join(f.repo, '.git', 'apv', 'receipts'),
    local: readLocal(f.repo), reference: 'main' });
  const { inputsRuleOf } = await import('../dist/gates/reuse-proof.js');
  const { compareInputs } = await import('../dist/gates/reuse.js');
  const { rule } = await inputsRuleOf(ctx, config.gates[0]);
  const compared = await compareInputs(f.repo, origin.candidateSha, c2, rule);
  assert.equal(compared.from, compared.to, 'the inputs of C and C2 are the same under the globs of the base');
  const cached = { ...origin, id: randomUUID(), candidateSha: c2, status: 'cached', reusedFrom: origin.id, startedAt: Date.now(), durationMs: 0,
    reuse: { fromRun: origin.runId, fromCommit: origin.candidateSha, basis: 'inputs', inputsDigest: compared.to, ignoreDigest: sha256(JSON.stringify(['docs/**'])),
      environment: origin.reuseIdentity, changed: compared.changed.length, files: compared.changed } };
  assert.match((await checkReuse(ctx, config.gates[0], found(cached))).reason,
    /reprise par entrées identiques \(basis inputs\) : 1 entrée\(s\) du contrôle changée\(s\) entre la base commune [0-9a-f]{12} \(main\) et le commit [0-9a-f]{12} \(src\/lib\.js\) : reuse\.ignore lu à la base ne vaut que pour le code de la base/);
  // Accepted: a PR from main that changes ignored files only (the check of the base never reads them).
  git(f.repo, 'checkout', '-q', '-b', 'docs-seuls', 'main');
  write(f.repo, 'docs/data.json', '{"ok":"doc 1"}\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'docs 1');
  assert.deepEqual((await run()).s, { unit: 'passed' });
  write(f.repo, 'docs/data.json', '{"ok":"doc 2"}\n');
  write(f.repo, 'docs/autre.md', 'autre\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'docs 2');
  const docs = await run();
  assert.deepEqual(docs.s, { unit: 'cached' });
  assert.deepEqual(docs.r.json().reused.map(r => [r.basis, r.changed]), [['inputs', 2]]);
  const verified = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--against', 'main']);
  assert.equal(verified.code, 0, verified.stdout);
});

test('F2 (relecture sécurité de A2): git cat-file, rev-parse, diff <rev>, branch --contains and what reads objects or references are never reused; git on the tree alone is', () => {
  for (const argv of [['sh', '-c', 'git rev-parse HEAD >/dev/null'], ['sh', '-c', 'git diff --quiet HEAD~1 HEAD'], ['sh', '-c', 'git cat-file -p HEAD | grep -q Signed-off-by'],
    ['git', 'branch', '--contains', 'HEAD'], ['env', 'LC_ALL=C', 'git', 'log', '-1'], ['git', 'diff', 'main'], ['git', '-C', '.', 'diff', '--stat', 'origin/main...'],
    ['git', 'show-ref'], ['git', 'tag', '--points-at', 'HEAD'], ['git', 'ls-tree', 'HEAD~1'], ['git', 'diff-tree', '-r', 'HEAD'], ['git', 'archive', 'HEAD'],
    ['git', 'grep', '-n', 'TODO', 'HEAD~1'], ['git', 'grep', '-e', 'TODO', 'main'], ['git', 'status', '-sb'], ['git', 'status', '--branch', '--porcelain=v2'],
    ['git', 'verify-commit', 'HEAD'], ['git', 'symbolic-ref', 'HEAD'], [process.execPath, '-e', 'require("child_process").execFileSync("git", ["rev-parse", "HEAD"])'],
    ['sh', '-c', 'test "$(git cat-file -t HEAD)" = commit']]) {
    assert.match(neverReused({ command: argv }) ?? '', /git sur l'historique, les objets ou les références/, argv.join(' '));
  }
  for (const argv of [['git', 'diff', '--check'], ['git', 'diff', '--exit-code', '--', 'dist'], ['git', '--no-pager', 'diff', '--quiet'], ['git', 'grep', '-n', 'TODO'],
    ['git', 'grep', '-e', 'TODO', '--', 'src'], ['git', 'status', '--porcelain'], ['git', 'ls-files', '--others', '--exclude-standard'], ['sh', '-c', 'git diff --exit-code && npm test']]) {
    assert.equal(neverReused({ command: argv }), null, argv.join(' '));
  }
});

test('F3 (relecture sécurité de A2): with a fingerprint, only the addresses proper to a stack are normalized; any other value stays in the identity', async () => {
  const { stackAddress } = await import('../dist/gates/run.js');
  const stack = { config: { id: '2', lockFile: '/x/2.lock', ports: [54321] }, lockFile: '/x/2.lock' };
  for (const [name, value, expected] of [
    ['DB_PORT', '57322', '{{port}}'], ['PORTS', '3000', '{{port}}'], ['SUPA', '54321', '{{port}}'], ['LOCK_FILE', '/x/2.lock', '{{verrou de la pile}}'],
    ['DB_URL', 'postgresql://postgres:pw@127.0.0.1:57322/postgres?ssl=0', 'postgresql://postgres:pw@127.0.0.1:{{port}}/postgres?ssl=0'],
    ['API_URL', 'http://[::1]:54321', 'http://[::1]:{{port}}'], ['API', 'localhost:54331', 'localhost:{{port}}'],
    ['STACK', '2', '2'], ['MODE', 'ci', 'ci'], ['PROJECT', 'suivie-2', 'suivie-2'], ['DB_URL2', 'postgresql://postgres@127.0.0.1/db2', 'postgresql://postgres@127.0.0.1/db2'],
    ['FLAG', 'true', 'true'], ['N', '57322', '57322']]) {
    assert.equal(stackAddress(name, value, stack), expected, `${name}=${value}`);
  }
});
