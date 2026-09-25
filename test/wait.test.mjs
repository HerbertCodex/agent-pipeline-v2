import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apv } from './cli-helpers.mjs';
import { FileWatch, MAX_WAIT_SECONDS, processState, waitFor } from '../dist/execution/wait.js';

const env = { APV_WAIT_POLL_MS: '20' };
const dir = t => { const d = mkdtempSync(join(tmpdir(), 'apv3-wait-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const sleeper = seconds => spawn(process.execPath, ['-e', `setTimeout(() => {}, ${seconds * 1000})`], { stdio: 'ignore' });
const exited = child => new Promise(resolve => child.once('exit', resolve));

test('apv wait --pid returns when the process ends, at once when it is already gone', async t => {
  const child = sleeper(1);
  t.after(() => child.kill('SIGKILL'));
  // Listened to before the wait: the exit may be emitted while apv wait polls.
  const ended = exited(child);
  const r = await apv(process.cwd(), ['wait', '--pid', String(child.pid), '--timeout', '10'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^Terminé : le processus ${child.pid} est terminé après \\d+ s \\(son code de sortie : dans son journal ou ses reçus\\)\\.`));
  await ended;
  const gone = await apv(process.cwd(), ['wait', '--pid', String(child.pid), '--json'], env);
  assert.equal(gone.code, 0);
  assert.deepEqual([gone.json().met, gone.json().immediate, gone.json().timeoutSeconds], [true, true, MAX_WAIT_SECONDS]);
});

test('apv wait --pid says when the delay is over, exit 1, and the process keeps running', async t => {
  const child = sleeper(30);
  t.after(() => child.kill('SIGKILL'));
  const r = await apv(process.cwd(), ['wait', '--pid', String(child.pid), '--timeout', '1'], env);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, `Délai dépassé : le processus ${child.pid} tourne encore après 1 s. Relancer apv wait pour attendre encore.\n`);
  assert.equal(processState(child.pid), 'alive');
});

test('a zombie process counts as ended: it waits only for its parent to reap it', { skip: process.platform !== 'linux' }, async t => {
  // The background `sleep 0` exits at once; its parent, replaced by `sleep 5`, never reaps it.
  const parent = spawn('sh', ['-c', 'sleep 0 & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => parent.kill('SIGKILL'));
  const pid = Number(await new Promise(resolve => parent.stdout.once('data', d => resolve(String(d).trim()))));
  const result = await waitFor({ kind: 'pid', pid }, { timeoutSeconds: 5, pollMs: 20 });
  assert.equal(result.met, true);
});

test('apv wait --file waits for the file, and with --contains for its text, reading only what was added', async t => {
  const d = dir(t);
  const file = join(d, 'summary.json');
  setTimeout(() => writeFileSync(file, '{}\n'), 100);
  const r = await apv(d, ['wait', '--file', 'summary.json', '--timeout', '10'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Terminé : .*summary\.json existe après \d+ s\.\n$/);
  const log = join(d, 'session.log');
  writeFileSync(log, 'vague 1 : lancée\nrésultat : ter');
  setTimeout(() => appendFileSync(log, 'miné\n'), 100);
  const text = await apv(d, ['wait', '--file', log, '--contains', 'résultat : terminé', '--timeout', '10', '--json'], env);
  assert.equal(text.code, 0, text.stderr);
  assert.deepEqual([text.json().condition, text.json().met, text.json().contains], ['file', true, 'résultat : terminé']);
  const missing = await apv(d, ['wait', '--file', log, '--contains', 'absent', '--timeout', '1'], env);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /^Délai dépassé : .*session\.log \(texte « absent »\) ne contient pas encore le texte après 1 s\./);
});

test('the file watch reads each byte once, finds a text across two reads and starts again after a rewrite', t => {
  const d = dir(t);
  const file = join(d, 'log');
  const watch = new FileWatch(file, 'FIN');
  assert.equal(watch.check(), false, 'no file yet');
  writeFileSync(file, 'début F');
  assert.equal(watch.check(), false);
  appendFileSync(file, 'IN');
  assert.equal(watch.check(), true, 'the text spans the two reads');
  const again = new FileWatch(file, 'nouveau');
  assert.equal(again.check(), false);
  writeFileSync(file, 'nouveau');
  assert.equal(again.check(), true, 'a shorter file is read from the start');
  assert.equal(new FileWatch(d, 'x').check(), false, 'a directory is never read');
  assert.equal(new FileWatch(d).check(), true, 'without a text, existence is enough');
});

test('apv wait refuses wrong calls: one condition, a bounded delay', async () => {
  for (const args of [[], ['--pid', '1'], ['--pid', '0'], ['--pid', 'abc'], ['--pid', String(process.pid)], ['--pid', '99999', '--file', 'x'],
    ['--pid', '99999', '--contains', 'x'], ['--file', 'x', '--contains', ''], ['--file', 'x', '--timeout', String(MAX_WAIT_SECONDS + 1)],
    ['--file', 'x', '--timeout', '0'], ['--file', 'x', '--timeout', '2m'], ['--file', 'x', 'extra']]) {
    const r = await apv(process.cwd(), ['wait', ...args], env);
    assert.equal(r.code, 2, args.join(' '));
  }
  assert.match((await apv(process.cwd(), ['wait', '--help'])).stdout, /au plus 580 s/);
});
