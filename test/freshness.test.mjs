import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { configIssues, loadConfig } from '../dist/config/load.js';
import { freshnessReport, freshnessSummary, repoFreshness, secretLike } from '../dist/freshness/check.js';
import { buildResumeContext, loadFreshness } from '../hooks/scripts/session-start.mjs';

process.env.TZ = 'Europe/Paris';

const NOW = new Date();
const DAY = 86_400_000;
const lines = n => Array.from({ length: n }, (_, i) => `ligne ${i + 1}`).join('\n') + '\n';
/** Sets the modification date of a file `days` days before NOW. */
function age(file, days) { const at = new Date(NOW.getTime() - days * DAY); utimesSync(file, at, at); return file; }
function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'apv-home-'));
  t.after(() => { for (const p of ['pilotage/api-token.md', '.ssh/id_rsa', '.npmrc']) { try { chmodSync(join(dir, p), 0o600); } catch { /* absent */ } } rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('a fresh state file is not reported, a stale one is, with the archive proposed', t => {
  const f = fixture(t);
  age(write(f.repo, '.apv/state/resume.md', lines(10)), 1);
  age(write(f.repo, '.apv/state/revues-188.md', lines(10)), 5);
  age(write(f.repo, '.apv/state/archive/vieux.md', lines(10)), 40);
  age(write(f.repo, '.apv/state/quota.log', lines(10)), 40);
  const report = freshnessReport(f.repo, undefined, { now: NOW, home: f.root ?? tmpdir() });
  assert.equal(report.checked, 2);
  assert.deepEqual(report.stale.map(e => [e.file, e.ageDays]), [['.apv/state/revues-188.md', 5]]);
  assert.deepEqual(report.long, []);
  assert.equal(report.archive, '.apv/state/archive');
});

test('apv status lists stale and too long files in text and JSON, and moves nothing', async t => {
  const f = fixture(t);
  write(f.repo, '.apv/state/resume.md', lines(12));
  const journal = age(write(f.repo, '.apv/state/journal-vague.md', lines(812)), 4);
  const r = await apv(f.repo, ['status', '--json']);
  assert.equal(r.code, 0);
  const s = r.json().freshness;
  assert.equal(s.maxAgeDays, 2); assert.equal(s.maxLines, 300);
  assert.deepEqual(s.stale.map(e => e.file), ['.apv/state/journal-vague.md']);
  assert.deepEqual(s.long.map(e => [e.file, e.lines, e.external]), [['.apv/state/journal-vague.md', null, false]]);
  assert.ok(!s.stale.some(e => e.file.endsWith('resume.md')));
  const text = (await apv(f.repo, ['status'])).stdout;
  assert.match(text, /Fichiers d'état périmés \(au plus 2 jour\(s\), 300 lignes ; 2 surveillé\(s\)\) :/);
  assert.match(text, /- \.apv\/state\/journal-vague\.md : modifié il y a \d+ jour\(s\) .*réécrire l'état court ou archiver dans \.apv\/state\/archive/);
  assert.match(text, /- \.apv\/state\/journal-vague\.md : plus de 300 lignes ; couper : état court \+ archive \(\.apv\/state\/archive\)/);
  // Read-only: the file is still there, unchanged.
  assert.equal(spawnSync('wc', ['-l', journal], { encoding: 'utf8' }).stdout.trim().split(' ')[0], '812');
});

test('apv status says « aucun » when every watched file is fresh and short', async t => {
  const f = fixture(t);
  write(f.repo, '.apv/state/resume.md', lines(299));
  const text = (await apv(f.repo, ['status'])).stdout;
  assert.match(text, /Fichiers d'état périmés \(au plus 2 jour\(s\), 300 lignes ; 1 surveillé\(s\)\) : aucun/);
});

test('declared paths: ~ resolved to the home folder, missing files ignored, ignore and thresholds applied', async t => {
  const f = fixture(t);
  const h = home(t);
  age(write(h, 'pilotage/lancement/REPRISE.md', lines(50)), 3);
  age(write(h, 'pilotage/lancement/notes.md', lines(50)), 9);
  age(write(f.repo, 'docs/etat/PLAN.md', lines(30)), 0);
  age(write(f.repo, 'docs/etat/ancien.md', lines(30)), 9);
  write(f.repo, '.apv/config.json', { freshness: {
    maxAgeDays: 7, maxLines: 40,
    paths: ['~/pilotage/lancement/*.md', '~/pilotage/absent/REPRISE.md', 'docs/etat/**/*.md', 'nulle-part/*.md'],
    ignore: ['docs/etat/ancien.md'], archive: '~/pilotage/archives',
  } });
  const r = await apv(f.repo, ['status', '--json'], { HOME: h });
  assert.equal(r.code, 0);
  const s = r.json().freshness;
  assert.equal(s.checked, 3);
  assert.deepEqual(s.stale.map(e => e.file), ['~/pilotage/lancement/notes.md']);
  assert.deepEqual(s.long.map(e => e.file).sort(), ['~/pilotage/lancement/REPRISE.md', '~/pilotage/lancement/notes.md']);
  assert.equal(s.archive, '~/pilotage/archives');
  const text = (await apv(f.repo, ['status'], { HOME: h })).stdout;
  assert.match(text, /~\/pilotage\/lancement\/notes\.md : plus de 40 lignes ; couper : état court \+ archive \(~\/pilotage\/archives\)/);
  // A file already in the archive folder is never reported.
  age(write(h, 'pilotage/archives/2026-09.md', lines(900)), 30);
  write(f.repo, '.apv/config.json', { freshness: { paths: ['~/pilotage/**/*.md'], archive: '~/pilotage/archives' } });
  const again = (await apv(f.repo, ['status', '--json'], { HOME: h })).json().freshness;
  assert.ok(![...again.stale, ...again.long].some(e => e.file.includes('archives')));
});

test('a secret-like file is never read: date only, no line count, even unreadable', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, t => {
  const f = fixture(t);
  const h = home(t);
  for (const name of ['.env.local', 'api-key.md', 'SECRET-notes.md', 'github-token.md', 'credentials.md']) assert.ok(secretLike(name), name);
  assert.ok(!secretLike('REPRISE.md'));
  const secret = age(write(h, 'pilotage/api-token.md', lines(900)), 5);
  chmodSync(secret, 0o000);
  age(write(h, 'pilotage/.env.production', lines(900)), 5);
  age(write(h, 'pilotage/journal.md', lines(900)), 0);
  const report = freshnessReport(f.repo, { maxAgeDays: 2, maxLines: 300, paths: ['~/pilotage/*.md', '~/pilotage/.env.production'], ignore: [] }, { now: NOW, home: h });
  const byFile = Object.fromEntries([...report.stale, ...report.long].map(e => [e.file, e]));
  assert.equal(byFile['~/pilotage/api-token.md'].lines, null);
  assert.equal(byFile['~/pilotage/api-token.md'].secret, true);
  assert.equal(byFile['~/pilotage/.env.production'].lines, null);
  assert.deepEqual(report.long.map(e => e.file), ['~/pilotage/journal.md']);
  assert.deepEqual(report.stale.map(e => e.file).sort(), ['~/pilotage/.env.production', '~/pilotage/api-token.md']);
});

test('an invalid freshness section is refused by the loader, a valid one accepted', t => {
  for (const [freshness, pattern] of [
    [{ maxAgeDays: 0 }, /maxAgeDays/],
    [{ maxLines: 'beaucoup' }, /maxLines/],
    [{ paths: ['../voisin/REPRISE.md'] }, /freshness\.paths/],
    [{ paths: ['etat/{a,b}.md'] }, /freshness\.paths/],
    [{ ignore: ['~'] }, /freshness\.ignore/],
    [{ archive: 'archives/*' }, /freshness\.archive/],
    [{ inconnu: true }, /unknown property inconnu/],
  ]) {
    const { config, issues } = configIssues({ freshness });
    assert.equal(config, undefined, JSON.stringify(freshness));
    assert.match(issues.map(i => i.message).join('\n'), pattern, JSON.stringify(freshness));
  }
  const { config, issues } = configIssues({ freshness: { paths: ['~/svelte-projects/suivie-pilotage/lancement/REPRISE.md', '/srv/etat/*.md'], archive: 'docs/archives' } });
  assert.deepEqual(issues, []);
  assert.deepEqual(config.freshness, { maxAgeDays: 2, maxLines: 300, paths: ['~/svelte-projects/suivie-pilotage/lancement/REPRISE.md', '/srv/etat/*.md'], ignore: [], archive: 'docs/archives' });
});

test('an invalid configuration leaves the default living files watched', async t => {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { freshness: { maxAgeDays: -1 } });
  assert.throws(() => loadConfig(f.repo), /maxAgeDays/);
  age(write(f.repo, '.apv/state/resume.md', lines(5)), 10);
  const report = repoFreshness(f.repo, { now: NOW });
  assert.match(report.configError, /maxAgeDays/);
  assert.deepEqual(report.stale.map(e => e.file), ['.apv/state/resume.md']);
  const r = await apv(f.repo, ['status', '--json']);
  assert.deepEqual(r.json().freshness.stale.map(e => e.file), ['.apv/state/resume.md']);
});

test('session start names the stale and long files in one line, and nothing when all is fresh', async t => {
  const root = mkdtempSync(join(tmpdir(), 'apv-hook-fresh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.apv', 'state'), { recursive: true });
  write(root, '.apv/state/resume.md', lines(5));
  const freshness = await loadFreshness();
  assert.ok(freshness, 'freshness module loaded from the compiled tool');
  const fresh = buildResumeContext(join(root, '.apv'), null, freshness, { now: new Date() });
  assert.doesNotMatch(fresh, /Fichiers d'état à rafraîchir/);
  age(write(root, '.apv/state/resume.md', lines(5)), 6);
  write(root, '.apv/state/journal-vague.md', lines(400));
  const stale = buildResumeContext(join(root, '.apv'), null, freshness, { now: NOW });
  const line = stale.split('\n').filter(l => l.startsWith("Fichiers d'état à rafraîchir"));
  assert.equal(line.length, 1);
  assert.match(line[0], /périmés \(plus de 2 j\) : \.apv\/state\/resume\.md \(6 j\)/);
  assert.match(line[0], /trop longs \(plus de 300 lignes\) : \.apv\/state\/journal-vague\.md\. Réécrire/);
  assert.match(line[0], /archiver le terminé dans \.apv\/state\/archive ; détail : apv status\./);
  // The real hook, run as Claude Code runs it, carries the same line.
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../hooks/scripts/session-start.mjs', import.meta.url))], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: root }), env: { ...process.env, CLAUDE_PROJECT_DIR: '' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /Fichiers d'état à rafraîchir : périmés \(plus de 2 j\) : \.apv\/state\/resume\.md/);
  assert.equal(freshnessSummary({ maxAgeDays: 2, maxLines: 300, archive: 'a', checked: 0, stale: [], long: [] }, String), null);
});

const UNIX = { skip: process.platform === 'win32' || process.getuid?.() === 0 };

test('secret paths judged on the name and the real target: ~/.ssh/*, ~/.npmrc and friends are never opened', UNIX, t => {
  const f = fixture(t);
  const h = home(t);
  for (const path of ['id_rsa', 'id_ed25519.pub', '.ssh/config', '/x/.gnupg/pubring.kbx', '.npmrc', '.netrc', '.pgpass', '.git-credentials',
    '.config/gh/hosts.yml', '.aws/config', 'coffre.kdbx', '.env', 'api-key.md', 'SECRET-notes.md', 'github-token.md', 'credentials.md']) assert.ok(secretLike(path), path);
  assert.ok(!secretLike('REPRISE.md'));
  // Unreadable: a single read attempt would make the line count fail; the date is still reported.
  const key = age(write(h, '.ssh/id_rsa', lines(900)), 5);
  const npmrc = age(write(h, '.npmrc', lines(900)), 5);
  chmodSync(key, 0o000); chmodSync(npmrc, 0o000);
  const report = freshnessReport(f.repo, { maxAgeDays: 2, maxLines: 300, paths: ['~/.ssh/*', '~/.npmrc'], ignore: [] }, { now: NOW, home: h });
  assert.deepEqual(report.stale.map(e => [e.file, e.secret, e.lines]).sort(), [['~/.npmrc', true, null], ['~/.ssh/id_rsa', true, null]]);
  assert.deepEqual(report.long, []);
});

test('a link that leaves the folder of its pattern is never followed (default patterns: the repository)', UNIX, t => {
  const f = fixture(t);
  const h = home(t);
  const key = age(write(h, '.ssh/id_rsa', lines(900)), 5);
  age(write(h, 'ailleurs/journal.md', lines(900)), 5);
  mkdirSync(join(f.repo, '.apv', 'state'), { recursive: true });
  symlinkSync(key, join(f.repo, '.apv', 'state', 'notes.md'));
  symlinkSync(join(h, 'ailleurs', 'journal.md'), join(f.repo, '.apv', 'state', 'journal.md'));
  mkdirSync(join(h, 'pilotage'), { recursive: true });
  symlinkSync(key, join(h, 'pilotage', 'REPRISE.md'));
  // A link that stays inside the repository is followed (once, under its own name).
  age(write(f.repo, 'docs/etat.md', lines(10)), 5);
  symlinkSync(join(f.repo, 'docs', 'etat.md'), join(f.repo, '.apv', 'state', 'etat.md'));
  const report = freshnessReport(f.repo, { maxAgeDays: 2, maxLines: 300, paths: ['~/pilotage/*.md'], ignore: [] }, { now: NOW, home: h });
  assert.deepEqual([...report.stale, ...report.long].map(e => e.file), ['.apv/state/etat.md']);
  assert.equal(report.checked, 1);
});

test('a huge sparse file is « too long » from its size, without being read, and the hook stays fast', UNIX, t => {
  const f = fixture(t);
  const huge = write(f.repo, '.apv/state/journal-gros.md', '');
  truncateSync(huge, 40 * 1024 ** 3);
  write(f.repo, '.apv/state/suivi-constats.md', lines(900));
  age(join(f.repo, '.apv/state/suivi-constats.md'), 30);
  let start = Date.now();
  const report = freshnessReport(f.repo, undefined, { now: NOW });
  assert.ok(Date.now() - start < 2000, `report in ${Date.now() - start} ms`);
  assert.deepEqual(report.long.map(e => [e.file, e.lines, e.bytes]), [['.apv/state/journal-gros.md', null, 40 * 1024 ** 3]]);
  // The grouped follow-up is excluded by default.
  assert.equal(report.checked, 1);
  // A file under the size bound stops its count after maxLines + 1 lines.
  write(f.repo, '.apv/state/plein.md', '\n'.repeat(1_000_000));
  assert.deepEqual(freshnessReport(f.repo, undefined, { now: NOW }).long.map(e => [e.file, e.lines]).sort(), [['.apv/state/journal-gros.md', null], ['.apv/state/plein.md', null]]);
  start = Date.now();
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../hooks/scripts/session-start.mjs', import.meta.url))], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: f.repo }), env: { ...process.env, CLAUDE_PROJECT_DIR: '' }, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - start < 5000, `hook in ${Date.now() - start} ms`);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /trop longs \(plus de 300 lignes\) : \.apv\/state\/journal-gros\.md, \.apv\/state\/plein\.md\./);
});

test('session start counts the files outside the repository without naming them', async t => {
  const f = fixture(t);
  const h = home(t);
  age(write(h, 'clients/dossier-jean-dupont.md', lines(5)), 9);
  age(write(f.repo, '.apv/state/resume.md', lines(5)), 9);
  write(f.repo, '.apv/config.json', { freshness: { paths: ['~/clients/*.md'] } });
  const context = buildResumeContext(join(f.repo, '.apv'), null, await loadFreshness(), { now: NOW, home: h });
  assert.match(context, /périmés \(plus de 2 j\) : \.apv\/state\/resume\.md \(9 j\), 1 fichier\(s\) hors du dépôt\./);
  assert.doesNotMatch(context, /dupont/);
  // apv status, in the operator's terminal, names it.
  assert.match((await apv(f.repo, ['status'], { HOME: h })).stdout, /~\/clients\/dossier-jean-dupont\.md : modifié il y a 9 jour/);
});
