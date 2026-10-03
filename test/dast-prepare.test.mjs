import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { configIssues } from '../dist/config/load.js';
import { DAST_INSTALL, DAST_INSTALL_MARKER, addressRefusal, runDast, parseEnvFile } from '../dist/review/dast.js';
import { LockStore } from '../dist/lock/store.js';

/**
 * `apv dast run` prepares its copy (src/review/dast.ts): `npm ci` when the copy has a package-lock.json and no
 * node_modules, and `review.dast.envFile` loaded into the command, refused when a value leaves the loopback.
 */
const SCAN = `
const dir = process.argv[1];
require('node:fs').writeFileSync(require('node:path').join(dir, 'scan.txt'), 'cible ' + (process.env.TARGET_URL ?? 'absente'));
`;
const scan = (extra = {}) => ({ command: [process.execPath, '-e', SCAN, '{{reportDir}}'], ...extra });

function project(t, dast, files = {}) {
  const f = fixture(t, { files });
  write(f.repo, '.apv/config.json', { review: { dast } });
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'config');
  const env = { APV_LOCK_DIR: join(f.root, 'locks'), APV_LOCK_POLL_MS: '20', HOME: f.root };
  return { ...f, env, run: args => apv(f.repo, ['dast', 'run', ...args], env) };
}

test('apv dast run: review.dast.envFile on the loopback is loaded, never its values in the summary', async t => {
  const p = project(t, scan({ envFile: '~/dast.env' }));
  writeFileSync(join(p.root, 'dast.env'), '# cible locale\nTARGET_URL=http://127.0.0.1:4173\nexport API_URL="http://localhost:54321/rest"\nSECRET_TOKEN=s3cr3t-valeur\n');
  const out = join(p.root, 'rapports');
  const r = await p.run(['--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Fichier d'environnement : .*dast\.env chargé \(3 variable\(s\)/);
  assert.match(r.stdout, /Copie préparée : rien à installer \(pas de package-lock\.json/);
  assert.equal(readFileSync(join(out, 'scan.txt'), 'utf8'), 'cible http://127.0.0.1:4173');
  const raw = readFileSync(join(out, 'summary.json'), 'utf8');
  const summary = JSON.parse(raw);
  assert.deepEqual(summary.envFile, { file: join(p.root, 'dast.env'), loaded: true, variables: 3 });
  assert.equal(summary.install.status, 'skipped');
  for (const value of ['127.0.0.1:4173', 's3cr3t-valeur', 'localhost:54321']) assert.ok(!raw.includes(value), value);
  // Without envFile: recorded as absent.
  const q = project(t, scan());
  const plain = await q.run(['--out', join(q.root, 'r'), '--json']);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(plain.json().envFile, null);
});

test('apv dast run: an envFile that names a remote address, or that is missing, is refused before anything runs', async t => {
  for (const [line, key] of [
    ['DATABASE_URL=postgresql://user:pass@db.abcdef.supabase.co:5432/postgres', 'DATABASE_URL'],
    ['TARGET_URL=https://toujours-rien.fr', 'TARGET_URL'],
    ['DB_HOST=10.0.0.5', 'DB_HOST'],
    ['API_HOST=api.example.com:443', 'API_HOST'],
  ]) {
    const p = project(t, scan({ envFile: 'dast.env' }));
    writeFileSync(join(p.repo, 'dast.env'), `LOCAL=http://localhost:3000\n${line}\n`);
    const out = join(p.root, 'rapports');
    const r = await p.run(['--out', out]);
    assert.equal(r.code, 1, line);
    assert.match(r.stderr, new RegExp(`DAST_ENV.*${key}.*hors bouclage`), line);
    assert.ok(!r.stderr.includes(line.split('=').slice(1).join('=')), 'the value is never shown');
    assert.ok(!r.stderr.includes('LOCAL'), 'only the refused keys are named');
    assert.ok(!existsSync(join(out, 'summary.json')) && !existsSync(join(out, 'scan.txt')), 'nothing ran');
  }
  // Reserved variables: the tool's own (a nested lease would be skipped), and those that change what runs.
  for (const line of ['APV_LOCK_HELD=supabase', 'NODE_OPTIONS=--require ./piege.js', 'PATH=/srv/piege/bin', 'HOME=/srv/piege', 'LD_PRELOAD=/srv/piege.so']) {
    const p = project(t, scan({ envFile: 'dast.env' }));
    writeFileSync(join(p.repo, 'dast.env'), `${line}\n`);
    const out = join(p.root, 'rapports');
    const r = await p.run(['--out', out]);
    assert.equal(r.code, 1, line);
    assert.match(r.stderr, new RegExp(`DAST_ENV.*réservée\\(s\\) ${line.split('=')[0]}`), line);
    assert.ok(!r.stderr.includes(line.split('=')[1]), 'the value is never shown');
    assert.ok(!existsSync(join(out, 'scan.txt')), 'nothing ran');
  }
  const missing = project(t, scan({ envFile: '~/absent.env' }));
  const r = await missing.run(['--out', join(missing.root, 'r')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /DAST_ENV.*introuvable/);
  assert.ok(configIssues({ review: { dast: { command: ['zap'], envFile: '' } } }).issues.length, 'an empty path is refused');
});

test('apv dast run: the copy gets its dependencies installed when it has a lockfile and no node_modules', async t => {
  const p = project(t, scan(), { 'package.json': '{"name":"x","private":true}\n', 'package-lock.json': '{"name":"x","lockfileVersion":3,"packages":{}}\n' });
  const store = new LockStore(join(p.root, 'locks'), { pollMs: 20 });
  const owner = { pid: process.pid, host: store.host, label: 'test' };
  const settings = configIssues({ review: { dast: scan() } }).config.review.dast;
  const install = [process.execPath, '-e', "require('fs').mkdirSync('node_modules/.bin', { recursive: true }); console.log('installé')"];
  const base = { repo: p.repo, commit: git(p.repo, 'rev-parse', 'HEAD').trim(), clean: true, settings, env: {}, stderr: () => {}, store, owner, waitSeconds: 5, installCommand: install };
  const first = await runDast({ ...base, reportDir: join(p.root, 'r1') });
  assert.equal(first.status, 'passed');
  assert.deepEqual([first.install.status, first.install.exitCode], ['done', 0]);
  assert.ok(existsSync(join(p.repo, 'node_modules')));
  assert.match(readFileSync(join(p.root, 'r1', 'dast.log'), 'utf8'), /installation des dépendances de la copie[\s\S]*installé/);
  // The marker of this lockfile: nothing to install again.
  assert.equal(readFileSync(join(p.repo, 'node_modules', DAST_INSTALL_MARKER), 'utf8').trim().length, 64);
  const second = await runDast({ ...base, reportDir: join(p.root, 'r2') });
  assert.deepEqual([second.install.status, second.install.reason], ['skipped', 'dépendances déjà installées par apv dast run pour ce package-lock.json']);
  // A node_modules without the marker (an interrupted installation, or one made by hand) is installed again.
  rmSync(join(p.repo, 'node_modules', DAST_INSTALL_MARKER));
  const third = await runDast({ ...base, reportDir: join(p.root, 'r3') });
  assert.equal(third.install.status, 'done');
  // A failed installation: the scan never runs, the summary says why.
  const q = project(t, scan(), { 'package-lock.json': '{}\n' });
  const failed = await runDast({ ...base, repo: q.repo, reportDir: join(q.root, 'r'), installCommand: [process.execPath, '-e', 'process.exit(3)'] });
  assert.deepEqual([failed.status, failed.exitCode, failed.install.status], ['failed', 3, 'failed']);
  assert.ok(!existsSync(join(q.root, 'r', 'scan.txt')), 'the scan did not run');
  assert.ok(existsSync(join(q.root, 'r', 'summary.json')));
  assert.ok(!existsSync(join(q.repo, 'node_modules', DAST_INSTALL_MARKER)), 'no marker after a failure');
  // An installation past its delay: timed_out, the scan never runs.
  const slow = await runDast({ ...base, repo: q.repo, reportDir: join(q.root, 'lent'), settings: { ...settings, timeoutMs: 1000 },
    installCommand: [process.execPath, '-e', 'setTimeout(() => {}, 20000)'] });
  assert.deepEqual([slow.status, slow.install.status], ['timed_out', 'timed_out']);
  assert.ok(!existsSync(join(q.root, 'lent', 'scan.txt')));
  // The default installation never runs the scripts of the packages.
  assert.ok(DAST_INSTALL.includes('--ignore-scripts'));
});

/** Every value the security review got through (PR #110), and more: each must be refused. */
const REMOTE = [
  ['DATABASE_URL', 'u:p@db.prod.example.com:5432/app'],
  ['PG', 'host=db.prod.example.com port=5432'],
  ['PG', 'host=prodserver port=5432'],
  ['DB_HOST', 'prodserver'],
  ['TARGET_HOST', '2130706433'],
  ['X', '2001:4860:4860::8888'],
  ['X', '::ffff:10.0.0.1'],
  ['X', 'localhost,db.prod.example.com'],
  ['X', 'db.prod.example.com.'],
  ['X', '//db.prod.example.com/app'],
  ['X', 'bdd.exämple.fr'],
  ['X', '{"host":"db.prod.example.com"}'],
  ['X', '{"host":"prodserver"}'],
  ['X', 'https://prod.example.com'],
  ['X', 'postgresql://user:pass@db.abcdef.supabase.co:5432/postgres'],
  ['X', '127.0.0.1.nip.io'],
  ['X', '0.0.0.0'],
  ['X', '10.0.0.5'],
  ['X', 'http://2130706433/'],
  ['X', 'api.example.com:443'],
  ['X', 'admin@exemple.fr'],
  // Second security review of PR #110: any scheme, nested, without `//`, encoded; host:port without a dot.
  ['ZAP_TARGET', 'http:db.prod.example.com'], ['X', 'http:db.prod.example.com'],
  ['ZAP_TARGET', 'http:/db.prod.example.com'], ['X', 'http:/db.prod.example.com'],
  ['ZAP_TARGET', 'http:\\\\db.prod.example.com'], ['X', 'http:\\\\db.prod.example.com'],
  ['DATABASE', 'jdbc:postgresql://db.prod.example.com/app'], ['X', 'jdbc:postgresql://db.prod.example.com/app'],
  ['ZAP_TARGET', 'https%3A%2F%2Fdb.prod.example.com'], ['X', 'https%3A%2F%2Fdb.prod.example.com'], ['X', 'https%253A%252F%252Fdb.prod.example.com'],
  ['ZAP_TARGET', 'prodserver:8080'], ['X', 'prodserver:8080'],
  ['SITE', 'prodserver'], ['API_BASE', 'prodserver'], ['DB', 'prodserver'], ['X', 'fe80::1'],
];
/** Loopback, test accounts and plain values: each must pass. */
const LOCAL = [
  ['TARGET_URL', 'http://localhost:5173'], ['API_URL', 'http://127.0.0.1:54321/rest/v1'], ['X', 'http://[::1]:8080'], ['X', 'http://app.localhost'],
  ['DATABASE_URL', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'], ['DB_HOST', 'localhost'], ['DB_PORT', '5432'], ['PG', 'host=127.0.0.1 port=5432'],
  ['X', 'plain text'], ['SUPABASE_ANON_KEY', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE'],
  ['X', '42'], ['VERSION', '1.2.3'], ['DAST_USER', 'demo@example.org'], ['DAST_USER', 'qa@site.test'], ['X', 'localhost,127.0.0.1'],
  ['X', 'localhost:5173'], ['ZAP_TARGET', 'http://127.0.0.1:4173'], ['ZAP_TARGET', 'http:localhost'], ['X', 'mode:strict'], ['X', '12:30'],
  ['API_KEY', 'abc123secret'], ['DB_PASSWORD', 'postgres'], ['DATABASE_NAME', 'app'], ['DB_USER', 'postgres'], ['X', 'texte%20encod%C3%A9'],
];

test('dast envFile: an allow-list of loopback addresses, unit (refusals and passes)', () => {
  for (const [key, value] of REMOTE) assert.ok(addressRefusal(key, value), `${key}=${value} must be refused`);
  for (const [key, value] of LOCAL) assert.equal(addressRefusal(key, value), null, `${key}=${value} must pass`);
  assert.deepEqual([...parseEnvFile('A=1\n# c\n\nexport B="deux mots"\nC=x # commentaire\n')], [['A', '1'], ['B', 'deux mots'], ['C', 'x']]);
  assert.throws(() => parseEnvFile('pas une ligne\n'), /ligne 1 illisible/);
});
