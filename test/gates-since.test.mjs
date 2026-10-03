import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';

/**
 * `apv gates run --stage task --since <commit prouvé>` (src/gates/since.ts): a round of corrections of low risk after a
 * green full proof runs the task stage from that commit; anything else is refused, and the merge still needs the full
 * suite at the exact commit.
 */
const node = (code, ...args) => [process.execPath, '-e', code, ...args];

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), 'apv3-since-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'log');
  const record = what => `require("fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(what)} + " " + (process.argv[1] ?? "") + "\\n")`;
  const f = fixture(t, { files: { '.gitignore': 'node_modules/\ndist/\n.apv/receipts/\n' } });
  write(f.repo, '.apv/config.json', { gates: [
    { id: 'unit', command: node('process.exit(0)') },
    { id: 'e2e', stage: 'full', command: node(`${record('full')}; process.exit(0)`), affected: node(`${record('affected')}; process.exit(0)`, '{{baseSha}}') },
  ] });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  return {
    ...f,
    log: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
    head: () => git(f.repo, 'rev-parse', 'HEAD').trim(),
    change: (path, text) => { write(f.repo, path, text); git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', `change ${path}`); },
    run: args => apv(f.repo, ['gates', 'run', ...args]),
  };
}

test('gates run --since: a low-risk round of corrections after a green full proof runs the task stage from that commit', async t => {
  const p = project(t);
  const full = await p.run(['--stage', 'full']);
  assert.equal(full.code, 0, full.stdout + full.stderr);
  const proven = p.head();
  p.change('docs/guide.md', 'Guide corrigé.\n');
  p.change('test/math.test.mjs', `${readFileSync(join(p.repo, 'test/math.test.mjs'), 'utf8')}// cas de plus\n`);
  const r = await p.run(['--stage', 'task', '--since', proven, '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = r.json();
  assert.equal(out.since.commit, proven);
  assert.equal(out.since.risk.level, 'faible');
  assert.equal(out.baseSha, proven);
  assert.equal(out.stage, 'task');
  assert.deepEqual(out.targeted, ['e2e']);
  // The targeted command counted from the proven commit.
  assert.equal(p.log().at(-1), `affected ${proven}`);
  const summary = JSON.parse(readFileSync(join(out.receiptsDirectory, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.since, { commit: proven, risk: 'faible', reason: out.since.risk.reason });
  const human = await p.run(['--stage', 'task', '--since', proven]);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /Preuve incrémentale depuis [0-9a-f]{12} .*risque faible/);
  assert.match(human.stdout, /La fusion exige toujours la suite complète au commit exact/);
  // The merge still needs the full suite at this exact commit: a task run proves nothing at the full stage.
  const verify = await apv(p.repo, ['gates', 'verify', '--commit', 'HEAD']);
  assert.equal(verify.code, 1, verify.stdout);
});

test('gates run --since: refused without a green full proof, on a high-risk diff, a dirty tree or HEAD itself', async t => {
  const p = project(t);
  const unproven = p.head();
  p.change('docs/guide.md', 'Un.\n');
  let r = await p.run(['--stage', 'task', '--since', unproven]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /suite complète non prouvée/);
  assert.deepEqual(p.log(), [], 'nothing ran');

  assert.equal((await p.run(['--stage', 'full'])).code, 0);
  const proven = p.head();
  r = await p.run(['--stage', 'task', '--since', proven]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /HEAD est le commit prouvé lui-même/);

  // Code changed since the proof: high risk, the full suite is required.
  p.change('src/math.mjs', 'export const add = (a, b) => a + b;\n');
  const before = p.log().length;
  r = await p.run(['--stage', 'task', '--since', proven]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /diff de risque élevé/);
  assert.match(r.stderr, /src\/math\.mjs : fichier non classé au contenu changé \(prudence\)/);
  assert.match(r.stderr, /Lancer la suite complète/);
  assert.equal(p.log().length, before, 'nothing ran');

  // A dirty tree: the uncommitted change would escape the classification.
  const q = project(t);
  assert.equal((await q.run(['--stage', 'full'])).code, 0);
  const qProven = q.head();
  q.change('docs/guide.md', 'Deux.\n');
  writeFileSync(join(q.repo, 'src/math.mjs'), 'export const add = () => 0;\n');
  r = await q.run(['--stage', 'task', '--since', qProven]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /modifications non commitées/);

  // An unrelated commit: HEAD does not descend from it.
  git(q.repo, 'checkout', '-q', '--', 'src/math.mjs');
  git(q.repo, 'switch', '-q', '-c', 'other', `${qProven}~1`);
  q.change('docs/other.md', 'Autre.\n');
  r = await q.run(['--stage', 'task', '--since', qProven]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ne descend pas de/);
});

test('gates run --since: incorrect calls', async t => {
  const p = project(t);
  for (const [args, message] of [
    [['run', '--since', 'HEAD'], /--since va avec --stage task/],
    [['run', '--stage', 'full', '--since', 'HEAD'], /--since va avec --stage task/],
    [['run', '--stage', 'task', '--since', 'HEAD', '--base', 'HEAD'], /--since remplace --base/],
    [['verify', '--commit', 'HEAD', '--since', 'HEAD'], /option de gates run seulement : --since/],
  ]) {
    const r = await apv(p.repo, ['gates', ...args]);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
  }
});
