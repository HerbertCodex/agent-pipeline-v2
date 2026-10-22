import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apv } from './cli-helpers.mjs';
import { journalEntry, operatorJournalPath } from '../dist/rules/operator.js';
import { commonDirOf, operatorSays } from './support/rules.mjs';

/**
 * docs/UNE-SUITE-PAR-PR.md, 3.1 (decision of the operator of 22 October 2026, PR #291 of the pilot project): the waiver
 * « dérogation instable <commit> : <raison> » the operator types himself, the one of the merge, holds for `apv release` and
 * `apv release auto` at the exact released commit: an unstable test that blocks (concerned by the change, changed file, name
 * without file, no affectedList) is published as a finding, his words cited. Only a test green at the relaunch: never a
 * failure the relaunch did not cure, never a repetition that failed, never a migration not confirmed; never for another
 * commit, never a line an agent writes into the journal.
 */

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim();
const put = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };
const node = code => [process.execPath, '-e', code];
const ALLOW = { APV_ALLOW_MERGE: '1' };
const RELEASE = { branch: 'production', from: 'main' };
const REASON = 'test ancien instable, la PR ne touche pas la carte';

/** An origin and a clone, main and production at the same commit, `files` committed at the base. */
function project(t, { gates, files = {}, release = RELEASE }) {
  const root = mkdtempSync(join(tmpdir(), 'apv4-derogation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(root, 'repo');
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'switch', '-q', '-c', 'main');
  put(repo, '.apv/config.json', { name: 'essai', gates, release });
  put(repo, '.gitignore', '.apv/receipts/\n.apv/state/\n');
  put(repo, 'README.md', 'projet\n');
  for (const [path, text] of Object.entries(files)) put(repo, path, text);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'push', '-q', 'origin', 'main:production');
  /** Commits `path` on main and pushes it; the new head. */
  const change = (path, text) => { put(repo, path, text); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', path); git(repo, 'push', '-q', 'origin', 'main'); return git(repo, 'rev-parse', 'HEAD'); };
  const remote = ref => git(origin, 'rev-parse', ref);
  const journal = () => readFileSync(join(repo, '.apv', 'state', 'stack.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.event === 'release');
  const followUp = () => { const f = join(repo, '.apv', 'state', 'suivi-constats.md'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
  return { repo, change, remote, journal, followUp };
}

/**
 * A browser check whose first pass fails naming `failing` (once, a marker in `dir`); the relaunch passes (`cured`) or fails
 * again. `affectedList` prints `listed`: the test the change concerns when it is `failing`.
 */
function flakyGate(dir, failing, { listed = failing, cured = true } = {}) {
  const marker = join(dir, `first-${Math.random().toString(16).slice(2)}`);
  const first = `const fs=require("fs"); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, ""); console.log("  1) [chromium] › ${failing}:3:5 › carte"); process.exit(1); }`;
  return { id: 'browser', stage: 'full', command: node(first),
    retryFailed: { command: cured ? node('0') : node('console.log("  1) [chromium] › ' + failing + ':3:5 › carte"); process.exit(1)'), testPattern: '^\\s*\\d+\\) (\\[[^\\]]+\\] › .+?)\\s*$' },
    affectedList: [...node(`console.log("Listing tests:\\n  [chromium] › ${listed}:1:1 › x\\nTotal: 1 test in 1 file")`), '{{baseSha}}'] };
}
const tmp = t => { const dir = mkdtempSync(join(tmpdir(), 'apv4-derogation-flaky-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const BLOCKED = /réussi\(s\) seulement après relance .*browser \(règle instable\) : browser : .*tests\/old\.spec\.ts:3:5 › carte : concerné par le changement/;

test('dérogation instable at the released commit: the test the change concerns is published, the waiver cited in the output, the journal and the follow-up', async t => {
  const p = project(t, { gates: [flakyGate(tmp(t), 'tests/old.spec.ts')], files: { 'tests/old.spec.ts': 'old\n', 'src/x.js': 'x\n' } });
  const before = p.remote('production');
  const sha = p.change('src/x.js', 'x2\n');
  // Without the waiver: refused, the sentence to type said with the template (never a waiver when pasted back).
  const refused = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, BLOCKED);
  assert.match(refused.stdout, new RegExp(`seul l'opérateur publie ces tests verts à la relance, en tapant lui-même dans une session Claude Code : « dérogation instable ${sha.slice(0, 12)} : <ta raison> »`));
  assert.equal(p.remote('production'), before);
  operatorSays(p.repo, refused.stdout);
  assert.equal((await apv(p.repo, ['release', 'auto'], ALLOW)).code, 1, 'the refusal pasted back waives nothing');
  assert.equal(p.remote('production'), before);

  // The operator types it: the next pass of the cron publishes the same commit, without a new commit nor a new suite.
  operatorSays(p.repo, `D'accord.\ndérogation instable ${sha.slice(0, 12)} : ${REASON}`);
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(p.remote('production'), sha);
  assert.match(r.stdout, /Mis en ligne : suite complète prouvée à [0-9a-f]{12} \(1 contrôle\(s\), 1 instable\(s\) publié\(s\) par dérogation instable de l'opérateur\)/);
  assert.match(r.stdout, new RegExp(`Dérogation : dérogation instable de l'opérateur \\(\\d{4}-\\d\\d-\\d\\dT[^)]+\\) : ${REASON} ; publié malgré : browser : .*concerné par le changement`));
  assert.match(r.stdout, /Constat : test instable publié par dérogation de l'opérateur : \[chromium\] › tests\/old\.spec\.ts:3:5 › carte \(browser\) échoue 1 fois sur 2 passages .* bloquant sans elle : concerné par le changement/);
  const entry = p.journal().pop();
  assert.equal(entry.published, true);
  assert.equal(entry.waived.rule, 'instable');
  assert.equal(entry.waived.commit, sha);
  assert.equal(entry.waived.reason, REASON);
  assert.match(entry.waived.at, /^\d{4}-\d\d-\d\dT/);
  assert.match(entry.waived.blocking.join(' '), /concerné par le changement/);
  assert.deepEqual(entry.unstable.map(u => [u.gate, u.files, u.failed, u.passes]), [['browser', ['tests/old.spec.ts'], 1, 2]]);
  assert.match(p.followUp(), new RegExp(`## Tests instables à la mise en ligne\\n- \\d{4}-\\d\\d-\\d\\d, mise en ligne de ${sha.slice(0, 12)}, test instable publié par dérogation instable de l'opérateur \\([^)]+\\) : ${REASON} : .*tests/old\\.spec\\.ts.* bloquant sans elle : concerné par le changement`));
});

test('dérogation instable, manual apv release: the full commit id holds; a name without its file is published too', async t => {
  const p = project(t, { gates: [flakyGate(tmp(t), 'tests/absent.spec.ts')], files: { 'src/x.js': 'x\n' } });
  const sha = p.change('src/x.js', 'x2\n');
  assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/production'])).code, 0);
  const refused = await apv(p.repo, ['release'], ALLOW);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /fichier du test introuvable dans son nom/);
  operatorSays(p.repo, `dérogation instable ${sha} : ${REASON}`);
  const dry = await apv(p.repo, ['release', '--dry-run', '--json']);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  assert.equal(dry.json().waived.commit, sha);
  const r = await apv(p.repo, ['release'], ALLOW);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(p.remote('production'), sha);
  assert.equal(p.journal().pop().waived.reason, REASON);
});

test('dérogation instable for another commit, or with the template of the tool: refused', async t => {
  const p = project(t, { gates: [flakyGate(tmp(t), 'tests/old.spec.ts')], files: { 'tests/old.spec.ts': 'old\n', 'src/x.js': 'x\n' } });
  const before = p.remote('production');
  const first = p.change('src/x.js', 'x2\n');
  const sha = p.change('src/x.js', 'x3\n');
  // Typed for the parent, for production, or with the template: none is the released commit's waiver.
  operatorSays(p.repo, `dérogation instable ${first.slice(0, 12)} : ${REASON}\ndérogation instable ${before.slice(0, 12)} : ${REASON}`);
  operatorSays(p.repo, `dérogation instable ${sha.slice(0, 12)} : <ta raison>`);
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, BLOCKED);
  assert.match(r.stdout, /Une dérogation tapée avec le gabarit de l'outil, ignorée/);
  assert.equal(p.remote('production'), before);
  assert.equal(p.journal().pop().waived, undefined);
  assert.equal(p.followUp(), '');
  // Another rule waived for this very commit: no waiver of instable either.
  operatorSays(p.repo, `dérogation relecture ${sha.slice(0, 12)} : ${REASON}`);
  assert.equal((await apv(p.repo, ['release', 'auto'], ALLOW)).code, 1);
  assert.equal(p.remote('production'), before);
});

test('dérogation instable an agent writes into the journal (unsigned, another key, altered): refused', async t => {
  const p = project(t, { gates: [flakyGate(tmp(t), 'tests/old.spec.ts')], files: { 'tests/old.spec.ts': 'old\n', 'src/x.js': 'x\n' } });
  const before = p.remote('production');
  const sha = p.change('src/x.js', 'x2\n');
  const text = `dérogation instable ${sha.slice(0, 12)} : ${REASON}`;
  const journal = operatorJournalPath(commonDirOf(p.repo));
  const forged = journalEntry(text, { at: new Date().toISOString(), session: 'agent' }, Buffer.alloc(32, 7));
  const { sig, ...unsigned } = forged;
  mkdirSync(dirname(journal), { recursive: true });
  writeFileSync(journal, `${JSON.stringify(forged)}\n${JSON.stringify({ ...forged, sig: '00'.repeat(32) })}\n${JSON.stringify(unsigned)}\n`);
  assert.ok(sig);
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, BLOCKED);
  assert.equal(p.remote('production'), before);
});

test('dérogation instable never lifts a failure the relaunch did not cure', async t => {
  const p = project(t, { gates: [flakyGate(tmp(t), 'tests/old.spec.ts', { cured: false })], files: { 'tests/old.spec.ts': 'old\n', 'src/x.js': 'x\n' } });
  const before = p.remote('production');
  const sha = p.change('src/x.js', 'x2\n');
  operatorSays(p.repo, `dérogation instable ${sha.slice(0, 12)} : ${REASON}`);
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Suite complète rouge à [0-9a-f]{12} : en échec : browser \(failed\)/);
  assert.equal(p.remote('production'), before);
  // Read from its receipts at the same commit: never run again, never published, manual release included.
  const again = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(again.code, 1, again.stdout + again.stderr);
  assert.match(again.stdout, /jamais relancée au même commit/);
  const manual = await apv(p.repo, ['release'], ALLOW);
  assert.equal(manual.code, 1, manual.stdout + manual.stderr);
  assert.match(manual.stdout, /suite complète non prouvée/);
  assert.equal(p.remote('production'), before);
});

test('dérogation instable never lifts a repetition that failed', async t => {
  const dir = tmp(t);
  const count = join(dir, 'count');
  const fifth = `const fs = require("fs"); const n = (fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)}, "utf8")) : 0) + 1; fs.writeFileSync(${JSON.stringify(count)}, String(n)); if (n % 5 === 0) { console.log("  1) [chromium] › tests/new.spec.ts:1:1 › nouveau"); process.exitCode = 1; }`;
  const p = project(t, { gates: [{ id: 'browser', stage: 'full', command: node('0'), repeatChanged: { paths: ['tests/**'], times: 5, reference: 'origin/main',
    command: [...node(`for (let i = 0; i < 5; i++) { ${fifth} }`), 'times={{repeat}}'] } }] });
  const before = p.remote('production');
  const sha = p.change('tests/new.spec.ts', 'nouveau\n');
  operatorSays(p.repo, `dérogation instable ${sha.slice(0, 12)} : ${REASON}`);
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Suite complète rouge à .*browser \(failed\)/);
  assert.equal(p.remote('production'), before);
});

test('dérogation instable never lifts a migration not confirmed', async t => {
  const p = project(t, { gates: [flakyGate(tmp(t), 'tests/old.spec.ts')], files: { 'tests/old.spec.ts': 'old\n' },
    release: { ...RELEASE, migrations: ['supabase/migrations/*.sql'] } });
  const before = p.remote('production');
  const sha = p.change('supabase/migrations/20261022120000_ajout.sql', 'select 1;\n');
  operatorSays(p.repo, `dérogation instable ${sha.slice(0, 12)} : ${REASON}`);
  const auto = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(auto.code, 0, auto.stdout + auto.stderr);
  assert.match(auto.stdout, /^En attente : migration\(s\) .*20261022120000_ajout\.sql/);
  const manual = await apv(p.repo, ['release'], ALLOW);
  assert.equal(manual.code, 1, manual.stdout + manual.stderr);
  assert.match(manual.stdout, /refusée : migration\(s\) supabase\/migrations\/20261022120000_ajout\.sql à appliquer en production/);
  assert.equal(p.remote('production'), before);
  // Confirmed, the release goes on: the waiver then publishes the unstable test the migration's commit concerns.
  operatorSays(p.repo, 'migration 20261022120000 appliquée');
  const done = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(done.code, 0, done.stdout + done.stderr);
  assert.equal(p.remote('production'), sha);
  assert.match(done.stdout, /Dérogation : dérogation instable de l'opérateur/);
});
