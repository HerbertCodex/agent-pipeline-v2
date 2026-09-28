import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { gatesConfigHash, runGates } from '../dist/gates/run.js';
import { ALWAYS_REQUIRED, commandPaths, modeChange, parseRawDiff } from '../dist/gates/proof-scope.js';
import { configIssues, loadConfig } from '../dist/config/load.js';
import { validateReceipt } from '../dist/domain/contracts.js';

/**
 * Scope of the proof (skipWhenOnly, docs/APV3-SPEC.md, section 21): a change that only touches files without effect on a
 * check records it as not required instead of running it; anything else, or anything unknown, runs it. The paths are
 * read at the reference, never in the change; apv gates verify recomputes the scope from the commit.
 */

const NON_CODE = ['docs/**', '**/*.md', '.apv/DECISIONS.*', '.apv/specs/**', 'notes/**'];
const scopeOf = (extra = {}) => ({ paths: NON_CODE.filter(p => p !== 'notes/**'), except: ['src/**'], reference: 'main', ...extra });
/**
 * A project on main with a fake runner `run.mjs` (each call appends its arguments to `calls`, outside the repository):
 * `lint` (always run) and `browser` (stage full, skipWhenOnly), then a branch `feature` to change.
 */
function project(t, gates = null) {
  const f = fixture(t);
  const calls = join(f.root, 'calls.jsonl');
  write(f.repo, 'run.mjs', `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  write(f.repo, '.apv/config.json', { gates: gates ?? [
    { id: 'lint', command: [process.execPath, 'run.mjs', 'lint'] },
    { id: 'browser', stage: 'full', command: [process.execPath, 'run.mjs', 'browser'], skipWhenOnly: scopeOf() },
  ] });
  commit(f.repo, 'project');
  const main = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'switch', '-q', '-c', 'feature');
  const read = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l)[0]) : [];
  return { ...f, main, calls: read, reset: () => rmSync(calls, { force: true }) };
}
const commit = (repo, message) => { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', message); };
const receipt = (dir, gate) => validateReceipt(JSON.parse(readFileSync(join(dir, `${gate}.json`), 'utf8')));
const full = (repo, extra = []) => apv(repo, ['gates', 'run', '--stage', 'full', '--base', 'main', '--json', ...extra]);

test('documentation only: the check is not required, nothing runs, the receipt records base, reference, files and reason; verify and --skip-proven agree', async t => {
  const f = project(t);
  write(f.repo, 'docs/guide.md', 'New guide.\n');
  write(f.repo, 'README.md', '# Fixture, again\n');
  write(f.repo, '.apv/DECISIONS.json', '{"decisions":[]}\n');
  write(f.repo, '.apv/specs/idea.json', '{}\n');
  commit(f.repo, 'docs');
  const r = await full(f.repo);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(f.calls(), ['lint'], 'only the check without scope ran');
  const out = r.json();
  assert.deepEqual(out.notRequired, ['browser']);
  const row = out.gates.find(g => g.gate === 'browser');
  assert.equal(row.status, 'not_required');
  assert.equal(row.exitCode, null);
  const rec = receipt(out.receiptsDirectory, 'browser');
  assert.equal(rec.scope.required, false);
  assert.equal(rec.scope.base, f.main);
  assert.equal(rec.scope.reference, f.main);
  assert.equal(rec.scope.referenceName, 'main');
  assert.equal(rec.scope.referenceSha, f.main);
  assert.deepEqual(rec.scope.files, ['.apv/DECISIONS.json', '.apv/specs/idea.json', 'README.md', 'docs/guide.md']);
  assert.equal(rec.scope.fileCount, 4);
  assert.match(rec.scope.reason, /4 fichier\(s\) changé\(s\) depuis [0-9a-f]{12} \(--base\) et [0-9a-f]{12} \(main\), tous sans effet sur ce contrôle \(skipWhenOnly de main\)/);
  const summary = JSON.parse(readFileSync(join(out.receiptsDirectory, 'summary.json'), 'utf8'));
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.receipts.find(x => x.gateId === 'browser').scope.required, false);
  // A receipt cannot be not_required without its scope, nor claim a run.
  assert.throws(() => validateReceipt({ ...rec, scope: undefined }), /not_required exactly when/);
  assert.throws(() => validateReceipt({ ...rec, exitCode: 0 }), /runs nothing/);
  const v = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--json']);
  assert.equal(v.code, 0, v.stdout);
  assert.deepEqual(v.json().notRequired, ['browser']);
  const human = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD']);
  assert.match(human.stdout, /browser\s+non requis \(portée recalculée\)/);
  assert.match(human.stdout, /Preuve complète : 2 contrôle\(s\) prouvé\(s\) sur ce commit \(dont 1 non requis par leur portée : browser\)/);
  const skip = await full(f.repo, ['--skip-proven']);
  assert.equal(skip.json().skipped, true);
  const text = await apv(f.repo, ['gates', 'run', '--stage', 'full', '--base', 'main']);
  assert.match(text.stdout, /browser\s+non requis \(portée\)/);
  assert.match(text.stdout, /Portée de la preuve \(skipWhenOnly\) :\n- browser : NON REQUIS, non lancé : 4 fichier/);
  assert.match(text.stdout, /Tous les contrôles requis passent ; 1 non requis par leur portée \(browser\), non lancé\(s\)/);
});

test('a source file, a file taken out by except, a test or a script: the check is required and runs, with the files that require it', async t => {
  const f = project(t);
  const cases = [
    ['src/math.mjs', 'export const add = (a, b) => a + b;\n', /hors de skipWhenOnly\.paths/],
    ['src/notes.md', 'notes beside the code\n', /exclu par skipWhenOnly\.except/],
    ['tests/e2e/README.md', 'how to run\n', /toujours requis/],
    ['run.mjs', null, /toujours requis/],
    ['package.json', '{"name":"x"}\n', /toujours requis/],
    ['.github/workflows/ci.yml', 'on: push\n', /toujours requis/],
    ['supabase/migrations/1_init.sql', 'select 1;\n', /toujours requis/],
    ['svelte.config.js', 'export default {};\n', /toujours requis/],
  ];
  for (const [path, text, why] of cases) {
    git(f.repo, 'switch', '-q', '-C', `feature-${cases.findIndex(c => c[0] === path)}`, 'main');
    write(f.repo, 'docs/other.md', `doc beside ${path}\n`);
    write(f.repo, path, text ?? `${readFileSync(join(f.repo, path), 'utf8')}// changed\n`);
    commit(f.repo, path);
    f.reset();
    const r = await full(f.repo);
    assert.equal(r.code, 0, `${path}: ${r.stdout}${r.stderr}`);
    assert.ok(f.calls().includes('browser'), `${path}: the check ran`);
    const rec = receipt(r.json().receiptsDirectory, 'browser');
    assert.equal(rec.status, 'passed');
    assert.equal(rec.scope.required, true);
    assert.deepEqual(rec.scope.blocking, [path], path);
    assert.match(rec.scope.reason, why, path);
    assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD'])).code, 0, path);
  }
});

test('the configuration of the checks touched, or the list changed by the change itself: required; the paths are those of the reference', async t => {
  const f = project(t);
  // A section of .apv/config.json that is not the checks: the file is always required.
  write(f.repo, '.apv/config.json', { name: 'renamed', ...JSON.parse(readFileSync(join(f.repo, '.apv/config.json'), 'utf8')) });
  write(f.repo, 'docs/guide.md', 'x\n');
  commit(f.repo, 'config');
  let rec = receipt((await full(f.repo)).json().receiptsDirectory, 'browser');
  assert.equal(rec.status, 'passed');
  assert.deepEqual(rec.scope.blocking, ['.apv/config.json']);
  // The change widens its own list (notes/**) and touches notes/: required, whatever its list says.
  git(f.repo, 'switch', '-q', '-C', 'widen', 'main');
  const config = JSON.parse(readFileSync(join(f.repo, '.apv/config.json'), 'utf8'));
  config.gates[1].skipWhenOnly.paths.push('notes/**');
  write(f.repo, '.apv/config.json', config);
  write(f.repo, 'notes/plan.txt', 'plan\n');
  commit(f.repo, 'widen');
  f.reset();
  const widened = await full(f.repo);
  assert.equal(widened.code, 0, widened.stdout + widened.stderr);
  assert.ok(f.calls().includes('browser'));
  rec = receipt(widened.json().receiptsDirectory, 'browser');
  assert.deepEqual(rec.scope.blocking, ['.apv/config.json', 'notes/plan.txt']);
  // A configuration outside the repository (--config) that widens the list: the reference still decides.
  git(f.repo, 'switch', '-q', '-C', 'outside', 'main');
  write(f.repo, 'notes/plan.txt', 'plan\n');
  commit(f.repo, 'notes only');
  const other = write(f.root, 'other.json', config);
  f.reset();
  const r = await full(f.repo, ['--config', other]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(f.calls().includes('browser'), 'the list of the reference has no notes/**');
  rec = receipt(r.json().receiptsDirectory, 'browser');
  assert.match(rec.scope.reason, /notes\/plan\.txt : hors de skipWhenOnly\.paths/);
  // A configuration that points its reference at another branch (one that already holds the change): never dispensed.
  git(f.repo, 'switch', '-q', '-C', 'holder', 'main');
  write(f.repo, 'src/math.mjs', 'export const add = (a, b) => a + b;\n');
  const moved = JSON.parse(readFileSync(join(f.repo, '.apv/config.json'), 'utf8'));
  moved.gates[1].skipWhenOnly.reference = 'holder';
  write(f.repo, '.apv/config.json', moved);
  commit(f.repo, 'code and a reference to itself');
  git(f.repo, 'switch', '-q', '-c', 'on-holder');
  write(f.repo, 'docs/guide.md', 'docs on top\n');
  commit(f.repo, 'docs on top');
  const main2 = { ...moved, gates: [moved.gates[0], { ...moved.gates[1], skipWhenOnly: { ...moved.gates[1].skipWhenOnly, reference: 'main' } }] };
  f.reset();
  const mismatch = await runGates({ repo: f.repo, config: loadConfig(f.repo, write(f.root, 'main2.json', main2)).config, stage: 'full', base: 'HEAD~1', reference: 'holder', share: false });
  assert.match(mismatch.receipts.find(r => r.gateId === 'browser').scope.reason, /la référence du contrôle \(main\) diffère de celle que déclare holder \(holder\)/);
  // A reference that does not declare the scope: required.
  const bare = project(t, [{ id: 'browser', stage: 'full', command: [process.execPath, 'run.mjs', 'browser'] }]);
  write(bare.repo, 'docs/guide.md', 'x\n');
  commit(bare.repo, 'docs');
  const c = JSON.parse(readFileSync(join(bare.repo, '.apv/config.json'), 'utf8'));
  c.gates[0].skipWhenOnly = scopeOf();
  const cfg = write(bare.root, 'scoped.json', c);
  rec = receipt((await full(bare.repo, ['--config', cfg])).json().receiptsDirectory, 'browser');
  assert.equal(rec.status, 'passed');
  assert.match(rec.scope.reason, /la référence main ne déclare pas skipWhenOnly pour browser \(les chemins sont lus à la référence\)/);
});

test('a symbolic link or a change of mode (executable) is always required, even under the listed paths', async t => {
  const f = project(t);
  symlinkSync('../src/math.mjs', join(f.repo, 'docs/link.md'));
  commit(f.repo, 'link');
  let rec = receipt((await full(f.repo)).json().receiptsDirectory, 'browser');
  assert.equal(rec.status, 'passed');
  assert.deepEqual(rec.scope.blocking, ['docs/link.md']);
  assert.match(rec.scope.reason, /ajouté en mode 120000 \(lien symbolique, sous-module ou exécutable : toujours requis\)/);
  git(f.repo, 'switch', '-q', '-C', 'exec', 'main');
  chmodSync(join(f.repo, 'docs/guide.md'), 0o755);
  commit(f.repo, 'exec');
  rec = receipt((await full(f.repo)).json().receiptsDirectory, 'browser');
  assert.equal(rec.status, 'passed');
  assert.match(rec.scope.reason, /docs\/guide\.md : mode 100644 -> 100755/);
});

test('same rigour as repeatChanged: --base required, a base equal to HEAD refused, a reference that does not resolve refused, HEAD already in the reference required', async t => {
  const f = project(t);
  write(f.repo, 'docs/guide.md', 'x\n');
  commit(f.repo, 'docs');
  const none = await apv(f.repo, ['gates', 'run', '--stage', 'full']);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /browser déclare\(nt\) skipWhenOnly : --base <base de la branche> est obligatoire à la suite complète/);
  const same = await apv(f.repo, ['gates', 'run', '--stage', 'full', '--base', 'HEAD']);
  assert.equal(same.code, 1);
  assert.match(same.stderr + same.stdout, /HEAD n'en descend pas strictement/);
  assert.deepEqual(f.calls(), [], 'nothing ran');
  // The task stage runs the task checks only, without base: the scope is a matter of the full suite.
  assert.equal((await apv(f.repo, ['gates', 'run', '--stage', 'task'])).code, 0);
  const missing = JSON.parse(readFileSync(join(f.repo, '.apv/config.json'), 'utf8'));
  missing.gates[1].skipWhenOnly.reference = 'origin/main';
  const file = write(f.root, 'missing.json', missing);
  const r = await apv(f.repo, ['gates', 'run', '--stage', 'full', '--base', 'main', '--config', file]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /browser : référence origin\/main introuvable \(skipWhenOnly\.reference\)/);
  await assert.rejects(runGates({ repo: f.repo, config: loadConfig(f.repo, file).config, stage: 'full', base: 'main', share: false }), /introuvable \(skipWhenOnly\.reference\)/);
  // On the reference itself (HEAD already in it): nothing to compare, required.
  git(f.repo, 'switch', '-q', 'main');
  write(f.repo, 'docs/guide.md', 'on main\n');
  commit(f.repo, 'docs on main');
  f.reset();
  const onMain = await apv(f.repo, ['gates', 'run', '--stage', 'full', '--base', 'HEAD~1', '--json']);
  assert.equal(onMain.code, 0, onMain.stdout + onMain.stderr);
  assert.ok(f.calls().includes('browser'));
  assert.match(receipt(onMain.json().receiptsDirectory, 'browser').scope.reason, /le commit est déjà dans la référence main : aucun changement à comparer/);
  // A dirty tree (--allow-dirty): required.
  git(f.repo, 'switch', '-q', 'feature');
  write(f.repo, 'docs/wip.md', 'wip\n');
  const dirty = await apv(f.repo, ['gates', 'run', '--stage', 'full', '--base', 'main', '--allow-dirty', '--json']);
  assert.match(receipt(dirty.json().receiptsDirectory, 'browser').scope.reason, /arbre de travail modifié/);
});

test('verify recomputes the scope from the commit: a receipt « not required » proves nothing when the recomputation requires the check', async t => {
  const f = project(t);
  write(f.repo, 'docs/guide.md', 'x\n');
  commit(f.repo, 'docs');
  const docs = git(f.repo, 'rev-parse', 'HEAD');
  const r = await full(f.repo);
  const dir = r.json().receiptsDirectory;
  const file = join(dir, 'browser.json');
  const original = readFileSync(file, 'utf8');
  const rec = receipt(dir, 'browser');
  assert.equal(rec.status, 'not_required');
  // A base equal to the commit (rewritten by hand: local receipts carry no manifest): refused.
  writeFileSync(file, JSON.stringify({ ...rec, scope: { ...rec.scope, base: docs } }));
  let v = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--json']);
  assert.equal(v.code, 1);
  assert.equal(v.json().gates.find(x => x.gateId === 'browser').state, 'required');
  assert.match(v.json().gates.find(x => x.gateId === 'browser').scope.reason, /base égale au commit/);
  writeFileSync(file, original);
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD'])).code, 0);
  // The same receipts carried over to a commit that touches the code: the recomputation requires the check.
  write(f.repo, 'src/math.mjs', 'export const add = (a, b) => a + b;\n');
  commit(f.repo, 'code');
  const head = git(f.repo, 'rev-parse', 'HEAD');
  const forged = join(f.repo, '.apv/receipts', `${r.json().runId.slice(0, -1)}${r.json().runId.endsWith('f') ? 'e' : 'f'}`);
  mkdirSync(forged);
  writeFileSync(join(forged, 'browser.json'), JSON.stringify({ ...rec, candidateSha: head, runId: 'forged' }));
  writeFileSync(join(forged, 'lint.json'), JSON.stringify({ ...receipt(dir, 'lint'), candidateSha: head, runId: 'forged' }));
  v = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--json']);
  assert.equal(v.code, 1);
  const g = v.json().gates.find(x => x.gateId === 'browser');
  assert.equal(g.state, 'required');
  assert.deepEqual(g.scope.blocking, ['src/math.mjs']);
  const human = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD']);
  assert.match(human.stdout, /browser\s+requis \(dispense non prouvée\)/);
  assert.match(human.stdout, /- browser : REQUIS, le reçu « non requis » ne prouve rien : .*src\/math\.mjs : hors de skipWhenOnly\.paths/);
  assert.match(human.stdout, /Relancer : apv gates run --stage full --base <base de la branche>/);
  // --skip-proven does not take it for a proof: the suite runs, the check with it.
  f.reset();
  assert.notEqual((await full(f.repo, ['--skip-proven'])).json().skipped, true);
  assert.ok(f.calls().includes('browser'));
  // The paths are read at the reference: once the reference no longer declares the scope, the old receipt proves nothing.
  git(f.repo, 'switch', '-q', 'main');
  const config = JSON.parse(readFileSync(join(f.repo, '.apv/config.json'), 'utf8'));
  config.gates[1].skipWhenOnly.paths = ['.apv/specs/**'];
  write(f.repo, '.apv/config.json', config);
  commit(f.repo, 'narrower list on the target');
  git(f.repo, 'switch', '-q', 'feature');
  v = await apv(f.repo, ['gates', 'verify', '--commit', docs, '--json']);
  assert.equal(v.code, 1);
  assert.match(v.json().gates.find(x => x.gateId === 'browser').scope.reason, /docs\/guide\.md : hors de skipWhenOnly\.paths/);
});

test('a required check makes its dependencies required: a check never runs without what it depends on', async t => {
  const f = project(t, [
    { id: 'build', stage: 'full', command: [process.execPath, 'run.mjs', 'build'], skipWhenOnly: scopeOf() },
    { id: 'browser', stage: 'full', dependsOn: ['build'], command: [process.execPath, 'run.mjs', 'browser'], skipWhenOnly: scopeOf() },
    { id: 'smoke', stage: 'full', dependsOn: ['build'], command: [process.execPath, 'run.mjs', 'smoke'] },
  ]);
  write(f.repo, 'docs/guide.md', 'x\n');
  commit(f.repo, 'docs');
  const r = await full(f.repo);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(f.calls(), ['build', 'smoke']);
  assert.deepEqual(r.json().notRequired, ['browser']);
  assert.match(receipt(r.json().receiptsDirectory, 'build').scope.reason, /^dépendance de smoke, qui est requis ; /);
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD'])).code, 0);
});

test('configuration: skipWhenOnly validated (portable globs, never a glob that covers source code), and it changes the gates hash', () => {
  const base = { gates: [{ id: 'browser', command: ['x'] }] };
  const scoped = { gates: [{ id: 'browser', command: ['x'], skipWhenOnly: scopeOf() }] };
  assert.equal(configIssues(scoped).issues.length, 0);
  assert.notEqual(gatesConfigHash(configIssues(base).config), gatesConfigHash(configIssues(scoped).config));
  for (const [paths, message] of [[['**'], /covers source code \(src\/app\.ts\)/], [['**/*'], /covers source code/], [['src/**'], /covers source code/],
    [['docs/{a,b}/**'], /Unsupported glob/]]) {
    const issues = configIssues({ gates: [{ id: 'browser', command: ['x'], skipWhenOnly: { paths, reference: 'main' } }] }).issues;
    assert.ok(issues.some(i => message.test(i.message)), `${paths}: ${issues.map(i => i.message).join(' | ')}`);
  }
  assert.ok(configIssues({ gates: [{ id: 'b', command: ['x'], skipWhenOnly: { paths: ['docs/**'] } }] }).issues.length > 0, 'reference required');
});

test('helpers: raw diff, changes of mode and type, paths named by the commands, the always required list', () => {
  const raw = ':100644 100644 aaa bbb M\0docs/a.md\0:000000 120000 000 ccc A\0docs/link.md\0:100644 100755 ddd eee M\0run.sh\0:100644 000000 fff 000 D\0old.md\0';
  const files = parseRawDiff(raw);
  assert.deepEqual(files.map(f => [f.path, f.status]), [['docs/a.md', 'M'], ['docs/link.md', 'A'], ['run.sh', 'M'], ['old.md', 'D']]);
  assert.deepEqual(files.map(modeChange), [null, 'ajouté en mode 120000', 'mode 100644 -> 100755', null]);
  assert.equal(modeChange({ path: 'x', status: 'T', oldMode: '100644', newMode: '120000' }), 'type changé');
  assert.equal(modeChange({ path: 'x', status: 'D', oldMode: '100755', newMode: '000000' }), 'supprimé depuis le mode 100755');
  const paths = commandPaths({ command: ['node', './scripts/e2e.mjs', '--config=e2e/pw.config.ts', '{{baseSha}}', '/elsewhere/x', '/repo/tools/run.sh'], retryFailed: { command: ['npm', 'run', 'x'] } }, '/repo');
  for (const p of ['scripts/e2e.mjs', 'e2e/pw.config.ts', 'tools/run.sh', 'npm']) assert.ok(paths.includes(p), p);
  assert.ok(!paths.some(p => p.includes('{{') || p.startsWith('/') || p.startsWith('-')));
  for (const p of ['.apv/config.json', 'package.json', 'package-lock.json', '.github/**', 'scripts/**', 'tests/**', '**/migrations/**', '**/*.config.*']) assert.ok(ALWAYS_REQUIRED.includes(p) || ALWAYS_REQUIRED.some(g => g.endsWith(p)), p);
});

test('library: a run with the reference passed (apv stack batch) compares to it', async t => {
  const f = project(t);
  write(f.repo, 'docs/guide.md', 'x\n');
  commit(f.repo, 'docs');
  const run = await runGates({ repo: f.repo, config: loadConfig(f.repo).config, stage: 'full', base: f.main, reference: f.main, share: false });
  assert.equal(run.ok, true);
  assert.deepEqual(run.notRequired, ['browser']);
  assert.equal(run.receipts.find(r => r.gateId === 'browser').scope.referenceName, f.main);
  assert.ok(readdirSync(join(f.repo, '.apv/receipts')).length > 0);
});
