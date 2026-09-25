import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { configIssues } from '../dist/config/load.js';

/** The scan command of the tests: writes a report into {{reportDir}} and says what it received. */
const SCAN = `
const [dir, commit, repo] = process.argv.slice(1);
require('node:fs').writeFileSync(require('node:path').join(dir, 'zap-report.html'), '<p>0 alerte</p>');
console.log('commit ' + commit + ' repo ' + repo + ' env ' + process.env.APV_DAST_COMMIT + ' secret ' + (process.env.APV_TEST_SECRET ?? 'absent'));
console.log('verrou ' + process.env.APV_LOCK_HELD);
process.exit(Number(process.env.SCAN_EXIT ?? 0));
`;

function project(t, dast, { commit = true } = {}) {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { review: { dast } });
  if (commit) { git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'config'); }
  const env = { APV_LOCK_DIR: join(f.root, 'locks'), APV_LOCK_POLL_MS: '20', APV_TEST_SECRET: 'ne-pas-transmettre' };
  const run = (args, extra = {}) => apv(f.repo, ['dast', 'run', ...args], { ...env, ...extra });
  return { ...f, env, run, head: () => git(f.repo, 'rev-parse', 'HEAD') };
}

const scan = (extra = {}) => ({ command: [process.execPath, '-e', SCAN, '{{reportDir}}', '{{commit}}', '{{repo}}'], passEnv: ['SCAN_EXIT'], ...extra });

test('apv dast run: the declared scan runs in the copy under its lease, reports and summary outside the copy', async t => {
  const p = project(t, scan({ description: 'ZAP de base' }));
  const out = join(p.root, 'rapports');
  const r = await p.run(['--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Scan dynamique du commit [a-f0-9]{40} dans .* sous le verrou « dast » ; rapports : /);
  assert.match(r.stdout, /Scan dynamique terminé à 0 \(code 0\)/);
  assert.match(r.stdout, /zap-report\.html/);
  assert.match(r.stdout, /À donner à la revue sécurité/);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.deepEqual([summary.status, summary.exitCode, summary.commit, summary.resource, summary.clean, summary.description],
    ['passed', 0, p.head(), 'dast', true, 'ZAP de base']);
  assert.deepEqual(summary.files, ['dast.log', 'zap-report.html']);
  assert.equal(summary.command[3], out, '{{reportDir}} replaced as a whole argument');
  const log = readFileSync(join(out, 'dast.log'), 'utf8');
  assert.ok(log.includes(`commit ${p.head()} repo ${p.repo} env ${p.head()}`), log);
  assert.ok(log.includes('secret absent'), 'only DEFAULT_PASS_ENV and passEnv reach the command');
  assert.ok(log.includes('verrou dast'), 'the command runs under the lease');
  // One folder per scan: a second run into it would make apv wait return at once.
  const again = await p.run(['--out', out]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /DAST_OUT.*existe déjà/);
});

test('apv dast run: a failed scan, a scan past its delay and a lease not obtained are exit 1, each with its summary', async t => {
  const failed = project(t, scan());
  const out = join(failed.root, 'échec');
  const r = await failed.run(['--out', out, '--json'], { SCAN_EXIT: '3' });
  assert.equal(r.code, 1);
  assert.deepEqual([r.json().status, r.json().exitCode, r.json().summary], ['failed', 3, `${out}/summary.json`]);

  const slow = project(t, { command: [process.execPath, '-e', 'setTimeout(() => {}, 20000)'], timeoutMs: 1000 });
  const s = await slow.run(['--out', join(slow.root, 'lent'), '--json']);
  assert.equal(s.code, 1);
  assert.equal(s.json().status, 'timed_out');

  const held = project(t, scan({ resource: 'pile-1' }));
  const lock = await apv(held.repo, ['lock', 'acquire', 'pile-1', '--pid', String(process.pid)], held.env);
  assert.equal(lock.code, 0, lock.stderr);
  const blocked = await held.run(['--out', join(held.root, 'bloqué'), '--wait', '1', '--json']);
  assert.equal(blocked.code, 1);
  assert.equal(blocked.json().status, 'lock_timeout');
  assert.match(blocked.stderr, /Verrou « pile-1 » non obtenu/);
});

test('apv dast run refuses: no scan declared, reports inside the copy, another commit; the default folder is outside the repository', async t => {
  const none = project(t, undefined);
  const r = await none.run([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /DAST_NONE.*« non vérifié : non déclaré par le projet »/);
  const p = project(t, scan());
  const inside = await p.run(['--out', join(p.repo, 'rapports')]);
  assert.equal(inside.code, 1);
  assert.match(inside.stderr, /DAST_OUT.*dans la copie scannée/);
  const base = git(p.repo, 'rev-parse', 'HEAD~1');
  const other = await p.run(['--commit', base]);
  assert.equal(other.code, 1);
  assert.match(other.stderr, /DAST_COMMIT.*pas sur/);
  const byDefault = await p.run(['--commit', 'main', '--json']);
  assert.equal(byDefault.code, 0, byDefault.stderr);
  const dir = byDefault.json().reportDir;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.ok(dir.startsWith(join(tmpdir(), 'apv-dast', `repo-${p.head().slice(0, 12)}-`)), dir);
  assert.ok(existsSync(join(dir, 'summary.json')));
  assert.equal((await apv(p.repo, ['dast', 'scan'], p.env)).code, 2);
  assert.equal((await apv(p.repo, ['dast'], p.env)).code, 2);
});

test('review.dast is validated with the configuration: placeholders are whole and known', () => {
  const ok = configIssues({ review: { dast: { command: ['sh', 'scripts/zap.sh', '{{reportDir}}', '{{commit}}'] } } });
  assert.deepEqual(ok.issues, []);
  assert.deepEqual([ok.config.review.dast.resource, ok.config.review.dast.timeoutMs, ok.config.review.dast.passEnv], ['dast', 3600000, []]);
  for (const arg of ['{{port}}', '--out={{reportDir}}']) {
    const bad = configIssues({ review: { dast: { command: ['zap', arg] } } });
    assert.match(bad.issues.map(i => i.message).join('\n'), /review\.dast\.command: unknown or partial placeholder/, arg);
  }
  assert.ok(configIssues({ review: { dast: { command: [] } } }).issues.length, 'a command is required');
  assert.ok(configIssues({ review: { dast: { command: ['zap'], extra: 1 } } }).issues.length, 'unknown property');
  assert.deepEqual(configIssues({}).issues, [], 'the section stays optional');
});
