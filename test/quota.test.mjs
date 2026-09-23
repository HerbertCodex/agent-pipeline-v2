import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseUsage, classifyQuota, reading, readQuota, lastQuotaReading, appendQuotaLog, QUOTA_TIMEOUT_MS } from '../dist/quota/usage.js';
import { runQuota } from '../dist/commands/quota.js';

const SESSION = 'Current session: 21% used · resets Sep 23, 2:30am (Europe/Paris)';
const WEEK = 'Current week (all models): 7% used · resets Sep 25, 7pm (Europe/Paris)';
const SAMPLE = `Usage\n\n${SESSION}\n${WEEK}\nCurrent week (Opus): 12% used · resets Sep 25, 7pm (Europe/Paris)\n`;

function temp(t) { const dir = mkdtempSync(join(tmpdir(), 'apv3-quota-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function capture(cwd, env = {}) {
  const out = []; const err = [];
  return { io: { stdout: s => out.push(s), stderr: s => err.push(s), cwd, env: { ...process.env, ...env } }, out: () => out.join(''), err: () => err.join('') };
}

test('parses the real session and weekly lines', () => {
  assert.deepEqual(parseUsage(SESSION), { session: { percent: 21, resets: 'Sep 23, 2:30am (Europe/Paris)' }, week: null });
  assert.deepEqual(parseUsage(WEEK), { session: null, week: { percent: 7, resets: 'Sep 25, 7pm (Europe/Paris)' } });
  // Per-model weekly lines are not the all-models window.
  assert.equal(parseUsage(SAMPLE).week.percent, 7);
});

test('ANSI sequences, wrapped layouts and decimals are tolerated', () => {
  const coloured = `\u001b[1mCurrent session:\u001b[0m \u001b[33m85.5%\u001b[0m used · resets Sep 23, 2:30am (Europe/Paris)`;
  assert.deepEqual(parseUsage(coloured).session, { percent: 85.5, resets: 'Sep 23, 2:30am (Europe/Paris)' });
  assert.deepEqual(parseUsage('Current week (all models):\n  40% used\n  resets Sep 25, 7pm').week, { percent: 40, resets: 'Sep 25, 7pm' });
  assert.deepEqual(parseUsage('Current session: 3% used').session, { percent: 3, resets: null });
  assert.deepEqual(parseUsage('Not logged in'), { session: null, week: null });
});

test('the level follows the 70 / 85 / 95 thresholds on the highest window', () => {
  assert.deepEqual([0, 69.9, 70, 84, 85, 94, 95, 100].map(classifyQuota), ['ok', 'ok', 'slow_down', 'slow_down', 'finish_only', 'finish_only', 'save_now', 'save_now']);
  assert.equal(classifyQuota(null), 'unknown');
  const r = reading(`Current session: 30% used\nCurrent week (all models): 88% used`, new Date('2026-09-23T10:00:00Z'));
  assert.deepEqual(r, { at: '2026-09-23T10:00:00.000Z', session: { percent: 30, resets: null }, week: { percent: 88, resets: null }, percent: 88, level: 'finish_only' });
  assert.equal(reading('').level, 'unknown');
});

test('readQuota calls claude -p "/usage" with no setting sources and a 150 s timeout', async () => {
  const calls = [];
  const { reading: r } = await readQuota(async (argv, timeoutMs) => { calls.push({ argv, timeoutMs }); return { status: 'passed', stdout: SAMPLE, stderr: '' }; });
  assert.deepEqual(calls, [{ argv: ['claude', '-p', '/usage', '--setting-sources', ''], timeoutMs: QUOTA_TIMEOUT_MS }]);
  assert.equal(QUOTA_TIMEOUT_MS, 150000);
  assert.equal(r.level, 'ok'); assert.equal(r.percent, 21);
});

test('apv quota prints, classifies and appends to .apv/state/quota.log', async t => {
  const dir = temp(t);
  const runner = async () => ({ status: 'passed', stdout: `Current session: 96% used · resets Sep 23, 2:30am (Europe/Paris)\n${WEEK}`, stderr: '' });
  const human = capture(dir);
  assert.equal(await runQuota([], human.io, runner), 0);
  assert.match(human.out(), /Session \(5 h\) : 96 % utilisés, remise à zéro Sep 23, 2:30am \(Europe\/Paris\)/);
  assert.match(human.out(), /Semaine \(tous modèles\) : 7 % utilisés/);
  assert.match(human.out(), /Niveau : save_now \(sauvegarder maintenant/);
  const json = capture(dir);
  assert.equal(await runQuota(['--json'], json.io, runner), 0);
  const value = JSON.parse(json.out());
  assert.equal(value.level, 'save_now'); assert.equal(value.logged, join(realpathSync(dir), '.apv/state/quota.log'));
  const lines = readFileSync(join(dir, '.apv/state/quota.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).session.percent, 96);
  const quiet = capture(dir);
  assert.equal(await runQuota(['--no-log', '--json'], quiet.io, runner), 0);
  assert.equal(JSON.parse(quiet.out()).logged, null);
  assert.equal(readFileSync(join(dir, '.apv/state/quota.log'), 'utf8').trim().split('\n').length, 2);
  // The writer of the journal keeps it out of commits.
  assert.match(readFileSync(join(dir, '.apv/.gitignore'), 'utf8'), /^state\/\*\.log$/m);
});

test('apv quota --no-log writes nothing under .apv', async t => {
  const dir = temp(t);
  const c = capture(dir);
  assert.equal(await runQuota(['--no-log'], c.io, async () => ({ status: 'passed', stdout: `${SESSION}\n${WEEK}`, stderr: '' })), 0);
  assert.throws(() => readFileSync(join(dir, '.apv/.gitignore'), 'utf8'), /ENOENT/);
});

test('an unreadable reading exits 1 and shows what the command said', async t => {
  const dir = temp(t);
  const c = capture(dir);
  assert.equal(await runQuota(['--json'], c.io, async () => ({ status: 'failed', stdout: '', stderr: 'Invalid API key' })), 1);
  const value = JSON.parse(c.out());
  assert.equal(value.level, 'unknown'); assert.match(value.command.output, /Invalid API key/);
  assert.equal(lastQuotaReading(join(dir, '.apv/state/quota.log')).level, 'unknown');
  const bad = capture(dir);
  assert.equal(await runQuota(['extra'], bad.io, async () => ({ status: 'passed', stdout: '', stderr: '' })), 2);
});

test('the journal keeps the last well-formed reading', t => {
  const dir = temp(t); const file = join(dir, 'q.log');
  assert.equal(lastQuotaReading(file), null);
  appendQuotaLog(file, reading(SAMPLE, new Date('2026-09-23T08:00:00Z')));
  writeFileSync(file, readFileSync(file, 'utf8') + '{"torn":\n');
  assert.equal(lastQuotaReading(file).at, '2026-09-23T08:00:00.000Z');
});

test('the apv binary honours APV_CLAUDE_BIN, so no real claude is ever called in tests', t => {
  const dir = temp(t);
  const fake = join(dir, 'fake-claude');
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "-p" ] && [ "$2" = "/usage" ] && [ "$3" = "--setting-sources" ] && [ "$4" = "" ]; then\n  echo '${SESSION}'\n  echo '${WEEK}'\nelse\n  echo "unexpected arguments: $*" >&2; exit 3\nfi\n`);
  chmodSync(fake, 0o755);
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const r = spawnSync(process.execPath, [cli, 'quota', '--json', '--repo', dir], { encoding: 'utf8', env: { ...process.env, APV_CLAUDE_BIN: fake } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const value = JSON.parse(r.stdout);
  assert.deepEqual([value.session.percent, value.week.percent, value.level], [21, 7, 'ok']);
});
