import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { gatesConfigHash } from '../dist/gates/run.js';
import { addedLines, fixedWaitIn, fixedWaitLines, repeatArgv, repeatFailures } from '../dist/gates/repeat.js';
import { configIssues } from '../dist/config/load.js';
import { validateReceipt } from '../dist/domain/contracts.js';

/**
 * Repetition of the changed test files (docs/APV3-SPEC.md, section 19): the files the diff against --base adds or
 * modifies, repeated after the check, under its lock; any failure is red, never hidden by retryFailed; ceilings refuse.
 */

const PW = '^\\s*\\d+\\) (\\[[^\\]]+\\] › .+?)\\s*─*$';
/**
 * A committed project with a fake runner `run.mjs`: each call appends its arguments to `calls` (outside the repository)
 * and exits as `mode` says (`pass`, `fail`, `hang`); `fail` prints two failed repetitions of one test, one of another.
 */
function project(t, gates, files = {}) {
  const f = fixture(t, { files: { 'tests/e2e/a.e2e.ts': 'test("a", async () => {});\n', 'tests/e2e/old.e2e.ts': 'await page.waitForTimeout(500);\n', ...files } });
  const calls = join(f.root, 'calls.jsonl');
  const runner = mode => `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const mode = ${JSON.stringify(mode)};
if (mode === 'hang') setTimeout(() => {}, 20000);
if (mode === 'fail') { console.log('  1) [chromium] › tests/e2e/a.e2e.ts:3:5 › bulle ─────'); console.log('  2) [chromium] › tests/e2e/a.e2e.ts:3:5 › bulle ─────');
  console.log('  3) [chromium] › tests/e2e/b.e2e.ts:1:1 › carte'); console.error('expected visible'); process.exit(1); }
`;
  write(f.repo, 'run-pass.mjs', runner('pass'));
  write(f.repo, 'run-fail.mjs', runner('fail'));
  write(f.repo, 'run-hang.mjs', runner('hang'));
  write(f.repo, '.apv/config.json', { gates });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'project');
  const base = git(f.repo, 'rev-parse', 'HEAD');
  const read = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  return { ...f, base, calls: read, reset: () => rmSync(calls, { force: true }) };
}
const script = name => [process.execPath, name];
const repeatOf = (extra = {}) => ({ paths: ['tests/e2e/**/*.e2e.ts'], command: [...script('run-pass.mjs'), 'repeat', '--repeat-each={{repeat}}', '--retries=0'], ...extra });
const receipt = (dir, gate) => validateReceipt(JSON.parse(readFileSync(join(dir, `${gate}.json`), 'utf8')));
const commit = (repo, message) => { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', message); };

test('no changed test file: the check passes, nothing is repeated, the receipt says so', async t => {
  const f = project(t, [{ id: 'browser', command: script('run-pass.mjs'), repeatChanged: repeatOf() }]);
  write(f.repo, 'src/app.mjs', 'export const x = 1;\n');
  write(f.repo, 'tests/unit/x.test.ts', 'test("x")\n');
  commit(f.repo, 'app only');
  const r = await apv(f.repo, ['gates', 'run', '--base', f.base, '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const row = r.json().gates[0];
  assert.equal(row.status, 'passed');
  assert.deepEqual(row.repeat, { status: 'none', base: f.base, files: [], times: 5, failures: [], fixedWaits: [] });
  assert.equal(f.calls().length, 1, 'only the command of the check ran');
  const human = await apv(f.repo, ['gates', 'run', '--base', f.base]);
  assert.match(human.stdout, /Tests modifiés répétés \(repeatChanged\) :\n- browser : aucun fichier de test ajouté ou modifié depuis/);
});

test('changed test files: added, modified, untracked and renamed ones repeated N times after the check; deleted and unmatched ones ignored', async t => {
  const f = project(t, [{ id: 'browser', command: script('run-pass.mjs'), repeatChanged: repeatOf({ times: 7, stressArgs: ['--workers=4'] }) }],
    { 'tests/e2e/gone.e2e.ts': 'x\n', 'tests/e2e/moved.e2e.ts': 'moved\n' });
  write(f.repo, 'tests/e2e/a.e2e.ts', 'test("a", async () => { await expect(page.getByRole("button")).toBeVisible(); });\n');
  write(f.repo, 'tests/e2e/new/b.e2e.ts', 'test("b")\n');
  write(f.repo, 'tests/e2e/helper.ts', 'export {}\n');
  git(f.repo, 'rm', '-q', 'tests/e2e/gone.e2e.ts');
  git(f.repo, 'mv', 'tests/e2e/moved.e2e.ts', 'tests/e2e/renamed.e2e.ts');
  commit(f.repo, 'tests');
  write(f.repo, 'tests/e2e/wip.e2e.ts', 'test("wip")\n');
  const r = await apv(f.repo, ['gates', 'run', '--base', f.base, '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const files = ['tests/e2e/a.e2e.ts', 'tests/e2e/new/b.e2e.ts', 'tests/e2e/renamed.e2e.ts', 'tests/e2e/wip.e2e.ts'];
  const calls = f.calls();
  assert.deepEqual(calls, [[], ['repeat', '--repeat-each=7', '--retries=0', '--workers=4', ...files]], 'the check, then the repetition of the changed files only');
  const rec = receipt(r.json().receiptsDirectory, 'browser');
  assert.equal(rec.status, 'passed');
  assert.equal(rec.repeat.status, 'passed');
  assert.deepEqual(rec.repeat.files, files);
  assert.equal(rec.repeat.times, 7);
  assert.equal(rec.repeat.base, f.base);
  assert.deepEqual(rec.repeat.command.slice(1), ['run-pass.mjs', 'repeat', '--repeat-each=7', '--retries=0', '--workers=4']);
  const summary = JSON.parse(readFileSync(join(r.json().receiptsDirectory, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.receipts[0].repeat, { status: 'passed', files, times: 7, failures: [] });
  assert.match(r.stderr, /browser : répétition des tests modifiés \(repeatChanged\), 7 fois chacun : tests\/e2e\/a\.e2e\.ts, .* ; charge : --workers=4\./);
});

test('a failed repetition turns the check red with « échoue X fois sur N »; verify refuses the commit', async t => {
  const f = project(t, [{ id: 'browser', stage: 'full', command: script('run-pass.mjs'), repeatChanged: repeatOf({ command: [...script('run-fail.mjs'), '--repeat-each={{repeat}}'], testPattern: PW }) },
    { id: 'after', stage: 'full', dependsOn: ['browser'], command: script('run-pass.mjs') }]);
  write(f.repo, 'tests/e2e/a.e2e.ts', 'changed\n');
  commit(f.repo, 'change a');
  const r = await apv(f.repo, ['gates', 'run', '--base', f.base, '--keep-going']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /browser\s+échec\s+1/);
  assert.match(r.stdout, /after\s+bloqué/);
  assert.match(r.stdout, /- browser : 1 fichier\(s\), 5 fois chacun : échec, test instable : \[chromium\] › tests\/e2e\/a\.e2e\.ts:3:5 › bulle échoue 2 fois sur 5 ; \[chromium\] › tests\/e2e\/b\.e2e\.ts:1:1 › carte échoue 1 fois sur 5/);
  assert.match(r.stdout, /Test instable : la répétition des tests modifiés \(repeatChanged : 1 fichier\(s\), 5 fois chacun\) échoue alors que la commande du contrôle avait réussi\.\n- \[chromium\] › tests\/e2e\/a\.e2e\.ts:3:5 › bulle : échoue 2 fois sur 5\n- \[chromium\] › tests\/e2e\/b\.e2e\.ts:1:1 › carte : échoue 1 fois sur 5\nFichiers répétés : tests\/e2e\/a\.e2e\.ts/);
  const dir = join(f.repo, '.apv/receipts', readdirSync(join(f.repo, '.apv/receipts')).filter(d => d !== '.gitignore').sort().at(-1));
  const rec = receipt(dir, 'browser');
  assert.equal(rec.status, 'failed'); assert.equal(rec.exitCode, 1);
  assert.deepEqual(rec.repeat.failures, [{ test: '[chromium] › tests/e2e/a.e2e.ts:3:5 › bulle', count: 2 }, { test: '[chromium] › tests/e2e/b.e2e.ts:1:1 › carte', count: 1 }]);
  assert.match(rec.repeat.output, /expected visible/);
  const v = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD']);
  assert.equal(v.code, 1, v.stdout);
  // A receipt cannot claim a success over a failed repetition.
  assert.throws(() => validateReceipt({ ...rec, status: 'passed', exitCode: 0 }), /repetition of the changed tests failed/);
  // Without a pattern: still red, at least once out of N.
  write(f.repo, '.apv/config.json', { gates: [{ id: 'browser', command: script('run-pass.mjs'), repeatChanged: repeatOf({ command: [...script('run-fail.mjs'), '{{repeat}}'] }) }] });
  commit(f.repo, 'no pattern');
  const plain = (await apv(f.repo, ['gates', 'run', '--base', f.base, '--json'])).json().gates[0];
  assert.equal(plain.status, 'failed');
  assert.match(plain.diagnostic, /nombre d'échecs par test non relevé \(repeatChanged\.testPattern absent\) : échoue au moins 1 fois sur 5/);
});

test('retryFailed never hides a failed repetition: passed after retry, then a red repetition, is red; the repetition is never relaunched', async t => {
  const f = project(t, [{ id: 'browser', command: [process.execPath, 'first.mjs'],
    retryFailed: { command: script('run-pass.mjs'), testPattern: PW },
    repeatChanged: repeatOf({ command: [...script('run-fail.mjs'), '--repeat-each={{repeat}}'] }) }]);
  // The first pass fails once (marker outside the repository), the relaunch passes.
  const markerFile = join(f.root, 'first-done');
  write(f.repo, 'first.mjs', `import { existsSync, writeFileSync } from 'node:fs';
if (!existsSync(${JSON.stringify(markerFile)})) { writeFileSync(${JSON.stringify(markerFile)}, ''); console.log('  1) [chromium] › tests/e2e/a.e2e.ts:3:5 › bulle'); process.exit(1); }
`);
  write(f.repo, 'tests/e2e/a.e2e.ts', 'changed\n');
  commit(f.repo, 'change');
  f.reset();
  const r = await apv(f.repo, ['gates', 'run', '--base', f.base, '--json']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const row = r.json().gates[0];
  assert.equal(row.status, 'failed');
  assert.deepEqual(r.json().flaky, [], 'not counted as passed after retry');
  assert.match(row.diagnostic, /^Test instable : la répétition des tests modifiés \(repeatChanged : 1 fichier\(s\), 5 fois chacun\) échoue alors que la commande du contrôle n'avait réussi qu'après la relance de ses tests en échec \(retryFailed\)\./);
  const rec = receipt(r.json().receiptsDirectory, 'browser');
  assert.equal(rec.retry.first.status, 'failed', 'the relaunch is kept in the receipt');
  assert.equal(rec.repeat.status, 'failed');
  // One relaunch (run-pass.mjs without arguments), one repetition, no relaunch of the repetition.
  assert.deepEqual(f.calls(), [[], ['--repeat-each=5', 'tests/e2e/a.e2e.ts']]);
});

test('ceilings: more changed files than maxFiles is refused before anything runs; a repetition over its duration ceiling is red', async t => {
  const f = project(t, [{ id: 'browser', stage: 'full', command: script('run-pass.mjs'), repeatChanged: repeatOf({ maxFiles: 2 }) }]);
  for (const n of [1, 2, 3]) write(f.repo, `tests/e2e/n${n}.e2e.ts`, `test("${n}")\n`);
  commit(f.repo, 'three tests');
  const r = await apv(f.repo, ['gates', 'run', '--base', f.base]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /GATE_REPEAT/);
  assert.match(r.stderr, /Répétition des tests modifiés refusée pour browser : 3 fichier\(s\) de test ajouté\(s\) ou modifié\(s\) depuis [0-9a-f]{12}, au-delà du plafond repeatChanged\.maxFiles \(2\) :\n  tests\/e2e\/n1\.e2e\.ts/);
  assert.match(r.stderr, /jamais sauté en silence/);
  assert.deepEqual(f.calls(), [], 'nothing ran, not even the check');
  assert.ok(!existsSync(join(f.repo, '.apv/receipts')) || readdirSync(join(f.repo, '.apv/receipts')).every(d => d === '.gitignore'), 'no run written');
  // Duration ceiling.
  write(f.repo, '.apv/config.json', { gates: [{ id: 'browser', command: script('run-pass.mjs'), repeatChanged: repeatOf({ command: [...script('run-hang.mjs'), '{{repeat}}'], timeoutMs: 300 }) }] });
  commit(f.repo, 'hang');
  const hang = await apv(f.repo, ['gates', 'run', '--base', f.base, '--json']);
  assert.equal(hang.code, 1);
  const row = hang.json().gates[0];
  assert.equal(row.status, 'timed_out');
  assert.equal(row.repeat.status, 'timed_out');
  assert.match(row.diagnostic, /^Refus : la répétition des tests modifiés .* a dépassé son plafond de durée \(300 ms, repeatChanged\.timeoutMs/);
});

test('without --base, or with a base HEAD does not strictly descend from, a run of a repeating check is refused; a check that fails is not repeated', async t => {
  const f = project(t, [{ id: 'browser', stage: 'full', command: script('run-pass.mjs'), repeatChanged: repeatOf() },
    { id: 'red', command: script('run-fail.mjs'), repeatChanged: repeatOf() }, { id: 'lint', command: script('run-pass.mjs') }]);
  write(f.repo, 'tests/e2e/a.e2e.ts', 'changed\n');
  commit(f.repo, 'change');
  const r = await apv(f.repo, ['gates', 'run', '--stage', 'full']);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /browser, red déclare\(nt\) repeatChanged : --base <base de la branche> est obligatoire/);
  // --skip-proven never short-cuts the refusal.
  assert.equal((await apv(f.repo, ['gates', 'run', '--stage', 'full', '--skip-proven'])).code, 2);
  assert.deepEqual(f.calls(), [], 'nothing ran');
  // A selection without a repeating check does not need a base.
  assert.equal((await apv(f.repo, ['gates', 'run', '--only', 'lint'])).code, 0);
  // A base equal to HEAD, or ahead of it, would repeat nothing: refused.
  const same = await apv(f.repo, ['gates', 'run', '--only', 'browser', '--base', 'HEAD']);
  assert.equal(same.code, 1);
  assert.match(same.stderr, /GATE_BASE[^]*HEAD n'en descend pas strictement/);
  git(f.repo, 'switch', '-q', '-c', 'ahead'); write(f.repo, 'x.txt', 'x\n'); commit(f.repo, 'ahead'); git(f.repo, 'switch', '-q', 'main');
  assert.match((await apv(f.repo, ['gates', 'run', '--only', 'browser', '--base', 'ahead'])).stderr, /HEAD n'en descend pas strictement/);
  f.reset();
  const failed = await apv(f.repo, ['gates', 'run', '--only', 'red', '--base', f.base, '--json']);
  assert.equal(failed.json().gates[0].status, 'failed');
  assert.equal(failed.json().gates[0].repeat.status, 'not_run');
  assert.equal(f.calls().length, 1, 'the red check only, no repetition');
});

test('a red repetition is never erased: verify refuses a receipt that repeated nothing, a base equal to the commit, or files left out; --skip-proven reruns', async t => {
  const f = project(t, [{ id: 'browser', stage: 'full', command: script('run-pass.mjs'), repeatChanged: repeatOf({ reference: 'main' }) }]);
  git(f.repo, 'switch', '-q', '-c', 'feature');
  write(f.repo, 'tests/e2e/a.e2e.ts', 'changed\n');
  commit(f.repo, 'test change');
  write(f.repo, 'src/other.mjs', 'export {}\n');
  commit(f.repo, 'unrelated');
  // A base too close (HEAD~1): the full run also compares to the reference, the changed test is repeated anyway.
  const r = await apv(f.repo, ['gates', 'run', '--stage', 'full', '--base', 'HEAD~1', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const rec = receipt(r.json().receiptsDirectory, 'browser');
  assert.deepEqual(rec.repeat.files, ['tests/e2e/a.e2e.ts']);
  assert.equal(rec.repeat.reference, f.base);
  assert.equal(rec.repeat.base, git(f.repo, 'rev-parse', 'HEAD~1'));
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD'])).code, 0);
  // Receipts that do not prove the repetition: rewritten by hand (local receipts carry no manifest), each refused.
  const file = join(r.json().receiptsDirectory, 'browser.json');
  const original = readFileSync(file, 'utf8');
  const head = git(f.repo, 'rev-parse', 'HEAD');
  const cases = [
    [{ ...rec.repeat, status: 'no_base', base: null }, /exécution sans --base : aucun test modifié répété/],
    [{ ...rec.repeat, status: 'none', base: head, reference: null, files: [] }, /base égale au commit/],
    [{ ...rec.repeat, status: 'none', files: [] }, /1 fichier\(s\) de test ajouté\(s\) ou modifié\(s\) non répété\(s\) \(depuis [0-9a-f]{12}\) : tests\/e2e\/a\.e2e\.ts/],
  ];
  for (const [repeat, reason] of cases) {
    writeFileSync(file, JSON.stringify({ ...rec, repeat }, null, 2));
    const v = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD']);
    assert.equal(v.code, 1, v.stdout);
    assert.match(v.stdout, /browser\s+tests modifiés non répétés/);
    assert.match(v.stdout, reason);
    assert.match(v.stdout, /Relancer : apv gates run --stage full --base <base de la branche>/);
    assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--json'])).json().gates[0].state, 'unrepeated');
  }
  // --skip-proven does not take such a receipt for a proof: the suite runs again.
  const again = await apv(f.repo, ['gates', 'run', '--stage', 'full', '--base', 'HEAD~1', '--skip-proven', '--json']);
  assert.equal(again.json().skipped, undefined);
  assert.equal(again.json().alreadyProven, false);
  writeFileSync(file, original);
});

test('the repetition finds the tree as it was just before the command: a command that writes a tracked-visible file is refused, with the entries', async t => {
  const f = project(t, [{ id: 'browser', command: [process.execPath, 'writer.mjs'], repeatChanged: repeatOf() }], {
    'writer.mjs': 'import { writeFileSync } from "node:fs";\nwriteFileSync("leftover.txt", "x");\n' });
  write(f.repo, 'tests/e2e/a.e2e.ts', 'changed\n');
  commit(f.repo, 'change');
  write(f.repo, 'notes.txt', 'uncommitted before the run\n');
  f.reset();
  const r = await apv(f.repo, ['gates', 'run', '--base', f.base, '--json']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const row = r.json().gates[0];
  assert.equal(row.status, 'failed');
  assert.match(row.diagnostic, /^Répétition des tests modifiés refusée : l'arbre de travail a changé pendant la commande du contrôle \(1 entrée\(s\) de git status : \+ \?\? leftover\.txt\)/);
  assert.deepEqual(f.calls(), [], 'the repetition did not run');
});

test('a changed test file whose path starts with - is refused: it would read as an option', async t => {
  const f = project(t, [{ id: 'browser', command: script('run-pass.mjs'), repeatChanged: repeatOf({ paths: ['**/*.e2e.ts'] }) }]);
  write(f.repo, '-x.e2e.ts', 'test\n');
  commit(f.repo, 'dash');
  const r = await apv(f.repo, ['gates', 'run', '--base', f.base]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /GATE_REPEAT[^]*le fichier -x\.e2e\.ts commence par « - »/);
  assert.deepEqual(f.calls(), []);
});

test('fixed waits in the lines a change adds: warned by default, refused with fixedWaits = refuse; comments and untouched lines ignored', async t => {
  const f = project(t, [{ id: 'browser', command: script('run-pass.mjs'), repeatChanged: repeatOf() }]);
  write(f.repo, 'tests/e2e/old.e2e.ts', 'await page.waitForTimeout(500);\nawait expect(page.getByText("ok")).toBeVisible();\n// never page.waitForTimeout(100)\n');
  write(f.repo, 'tests/e2e/new.e2e.ts', 'test("n", async () => {\n  await sleep(200);\n  await new Promise(r => setTimeout(r, 50));\n  await page.clock.fastForward(1000);\n});\n');
  commit(f.repo, 'waits');
  const r = await apv(f.repo, ['gates', 'run', '--base', f.base, '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json().gates[0].repeat.fixedWaits, [
    { file: 'tests/e2e/new.e2e.ts', line: 2, text: 'await sleep(200);' },
    { file: 'tests/e2e/new.e2e.ts', line: 3, text: 'await new Promise(r => setTimeout(r, 50));' },
  ], 'the untouched waitForTimeout of old.e2e.ts and the comment are not reported');
  assert.match(r.stderr, /browser : attente à durée fixe dans un test modifié, tests\/e2e\/new\.e2e\.ts:2 : await sleep\(200\);/);
  const human = await apv(f.repo, ['gates', 'run', '--base', f.base]);
  assert.match(human.stdout, /Attentes à durée fixe dans les tests modifiés \(2\)[^\n]*\n- browser : tests\/e2e\/new\.e2e\.ts:2 : await sleep\(200\);/);
  write(f.repo, '.apv/config.json', { gates: [{ id: 'browser', command: script('run-pass.mjs'), repeatChanged: repeatOf({ fixedWaits: 'refuse' }) }] });
  commit(f.repo, 'refuse');
  f.reset();
  const refused = await apv(f.repo, ['gates', 'run', '--base', f.base]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /GATE_REPEAT[^]*Attentes à durée fixe dans les tests modifiés de browser \(repeatChanged\.fixedWaits = refuse\) :\n  tests\/e2e\/new\.e2e\.ts:2 : await sleep\(200\);/);
  assert.deepEqual(f.calls(), []);
  write(f.repo, '.apv/config.json', { gates: [{ id: 'browser', command: script('run-pass.mjs'), repeatChanged: repeatOf({ fixedWaits: 'off' }) }] });
  commit(f.repo, 'off');
  assert.deepEqual((await apv(f.repo, ['gates', 'run', '--base', f.base, '--json'])).json().gates[0].repeat.fixedWaits, []);
});

test('the repetition runs under the lock of the check (APV_LOCK_HELD seen by the repeated command)', async t => {
  const f = project(t, [{ id: 'browser', lock: { resource: 'stack' }, command: script('run-pass.mjs'),
    repeatChanged: repeatOf({ command: [process.execPath, 'held.mjs', '{{repeat}}'] }) }], {
    'held.mjs': 'process.exit(process.env.APV_LOCK_HELD === "stack" ? 0 : 9);\n' });
  write(f.repo, 'tests/e2e/a.e2e.ts', 'changed\n');
  commit(f.repo, 'change');
  const r = await apv(f.repo, ['gates', 'run', '--base', f.base, '--json'], { APV_LOCK_DIR: join(f.root, 'locks') });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json().gates[0].repeat.status, 'passed');
});

test('configuration: repeatChanged validated, and it changes the gates hash like any other field', () => {
  const bad = (config, pattern) => { const { issues } = configIssues(config); assert.ok(issues.some(i => pattern.test(i.message)), JSON.stringify(issues)); };
  const gate = extra => ({ gates: [{ id: 'e2e', command: ['x'], repeatChanged: { paths: ['tests/**/*.e2e.ts'], command: ['y', '--repeat-each={{repeat}}'], ...extra } }] });
  bad(gate({ command: ['y', '--repeat-each=5'] }), /repeatChanged\.command must repeat the tests through \{\{repeat\}\}/);
  bad(gate({ paths: ['tests/{a,b}/*.ts'] }), /repeatChanged\.paths: Unsupported glob/);
  bad(gate({ testPattern: '(' }), /repeatChanged\.testPattern is not a valid regular expression/);
  bad(gate({ times: 1 }), /times/);
  bad(gate({ fixedWaits: 'maybe' }), /fixedWaits/);
  bad(gate({ unknown: true }), /unknown property unknown/);
  bad(gate({ stressArgs: ['--workers={{repeat}}'] }), /repeatChanged\.stressArgs cannot use \{\{repeat\}\}/);
  bad(gate({ reference: 'origin main' }), /reference/);
  const plain = configIssues({ gates: [{ id: 'e2e', command: ['x'] }] }).config;
  assert.equal(Object.hasOwn(plain.gates[0], 'repeatChanged'), false);
  const one = configIssues(gate({})).config;
  assert.deepEqual(one.gates[0].repeatChanged, { paths: ['tests/**/*.e2e.ts'], command: ['y', '--repeat-each={{repeat}}'], times: 5, maxFiles: 10, fixedWaits: 'warn' });
  const other = configIssues(gate({ times: 6 })).config;
  const hashes = new Set([plain, one, other].map(gatesConfigHash));
  assert.equal(hashes.size, 3, 'adding or changing repeatChanged changes the identity of the checks');
});

test('helpers: repetition argv, failures counted by test, added lines, fixed waits', () => {
  assert.deepEqual(repeatArgv({ command: ['npm', 'run', 'e2e', '--', '--repeat-each={{repeat}}', '{{repeat}}x'], times: 3, stressArgs: ['--workers=8'] }),
    ['npm', 'run', 'e2e', '--', '--repeat-each=3', '3x', '--workers=8']);
  assert.deepEqual(repeatFailures(undefined, 'x'), []);
  assert.deepEqual(repeatFailures('^FAIL (.+)$', '\u001b[31mFAIL a\u001b[0m\nok\nFAIL a\nFAIL b'), [{ test: 'a', count: 2 }, { test: 'b', count: 1 }]);
  assert.deepEqual(addedLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,0 +2,2 @@\n+one\n+two\n@@ -9 +11 @@\n-old\n+new\n'),
    [{ line: 2, text: 'one' }, { line: 3, text: 'two' }, { line: 11, text: 'new' }]);
  for (const yes of ['await page.waitForTimeout(100);', 'await sleep(5)', 'await new Promise(resolve => setTimeout(resolve, 10));', 'await new Promise((r) => { setTimeout(r, 1) })']) assert.ok(fixedWaitIn(yes), yes);
  for (const no of ['// page.waitForTimeout(1)', ' * sleep(1)', 'await expect(x).toBeVisible({ timeout: 10000 })', 'await page.clock.runFor(1000)', 'const asleep = true']) assert.ok(!fixedWaitIn(no), no);
  for (const yes of ['await new Promise<void>(r => setTimeout(r, 10));', 'await new Promise<void>((resolve: () => void) => setTimeout(resolve, 1));', 'await setTimeout(100);',
    'await timers.setTimeout(5)', 'await delay(300);']) assert.ok(fixedWaitIn(yes), yes);
  for (const no of ['await page.click("a", { delay: 50 })', 'const x = obj.delay(1)', 'setTimeout(() => done(), 0) // in a mock', 'await page.clock.setTimeout']) assert.ok(!fixedWaitIn(no), no);
  // A new Promise over a few lines, found on its first line; lines that are not consecutive are not joined.
  assert.deepEqual(fixedWaitLines([{ line: 4, text: '  await new Promise(resolve =>' }, { line: 5, text: '    setTimeout(resolve, 100));' }]), [{ line: 4, text: '  await new Promise(resolve =>' }]);
  assert.deepEqual(fixedWaitLines([{ line: 4, text: 'await new Promise(resolve =>' }, { line: 9, text: 'setTimeout(resolve, 100));' }]), []);
  // An added line "++i;" is "+++i;" in the diff: a line, not a header.
  assert.deepEqual(addedLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n+++i;\n+ok\n'), [{ line: 1, text: '++i;' }, { line: 2, text: 'ok' }]);
});
