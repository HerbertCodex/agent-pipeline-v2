import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildResumeContext, lastLine } from '../hooks/scripts/session-start.mjs';
import { journalLine } from '../hooks/scripts/stop-journal.mjs';
import { findApvDir, oneLine } from '../hooks/scripts/lib.mjs';

const scriptPath = name => fileURLToPath(new URL(`../hooks/scripts/${name}`, import.meta.url));

function project(t, { apv = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apv-hooks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (apv) mkdirSync(join(root, '.apv', 'state'), { recursive: true });
  return root;
}
function run(name, payload, env = {}) {
  const cleanEnv = { ...process.env, CLAUDE_PROJECT_DIR: '', ...env };
  return spawnSync(process.execPath, [scriptPath(name)], { input: JSON.stringify(payload), env: cleanEnv, encoding: 'utf8' });
}

test('findApvDir prefers CLAUDE_PROJECT_DIR, falls back to cwd and never searches parents', t => {
  const root = project(t);
  const other = project(t, { apv: false });
  assert.equal(findApvDir({ cwd: other }, { CLAUDE_PROJECT_DIR: root }), join(root, '.apv'));
  assert.equal(findApvDir({ cwd: root }, {}), join(root, '.apv'));
  assert.equal(findApvDir({ cwd: join(root, '.apv', 'state') }, {}), null);
  assert.equal(findApvDir({ cwd: other }, {}), null);
  assert.equal(findApvDir(null, {}), null);
  writeFileSync(join(other, '.apv'), 'fichier, pas dossier');
  assert.equal(findApvDir({ cwd: other }, {}), null);
});

test('oneLine flattens and bounds text', () => {
  assert.equal(oneLine('a\n  b\tc'), 'a b c');
  assert.equal(oneLine('x'.repeat(10), 5), 'xxxx…');
  assert.equal(oneLine(undefined), '');
});

test('session start is silent without .apv', t => {
  const root = project(t, { apv: false });
  const result = run('session-start.mjs', { hook_event_name: 'SessionStart', source: 'startup', cwd: root });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('session start reports resume notes, recent state, last quota and last journal line', t => {
  const root = project(t);
  const state = join(root, '.apv', 'state');
  writeFileSync(join(state, 'resume.md'), '# Reprise\nspec/6-t2 : wip 6f5f93d à terminer\n');
  writeFileSync(join(state, 'quota.log'), '2026-09-23 10:00 session 40 %\n2026-09-23 11:00 session 52 %, semaine 30 %\n\n');
  writeFileSync(join(state, 'journal.log'), '2026-09-23T09:00:00.000Z fin-de-tour session=a taches_en_fond=0\n');
  const result = run('session-start.mjs', { hook_event_name: 'SessionStart', source: 'resume', cwd: '/nulle-part' }, { CLAUDE_PROJECT_DIR: root });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /spec\/6-t2 : wip 6f5f93d à terminer/);
  assert.match(context, /Dernier relevé de quota : 2026-09-23 11:00 session 52 %, semaine 30 %/);
  assert.match(context, /Dernière fin de tour : 2026-09-23T09:00:00.000Z/);
  assert.match(context, /resume\.md \(/);
  assert.match(context, /\/apv:resume/);
  assert.equal(typeof output.systemMessage, 'string');
});

test('session start context says when notes and quota are missing, and stays bounded', t => {
  const root = project(t);
  const context = buildResumeContext(join(root, '.apv'));
  assert.match(context, /Aucune note de reprise/);
  assert.match(context, /Aucun relevé de quota : lancer \/apv:quota/);
  writeFileSync(join(root, '.apv', 'state', 'resume.md'), Array.from({ length: 500 }, (_, k) => `ligne ${k} ${'x'.repeat(40)}`).join('\n'));
  const long = buildResumeContext(join(root, '.apv'));
  assert.ok(long.length <= 4000);
  assert.ok(!long.includes('ligne 45 '));
  assert.equal(lastLine(join(root, 'absent.log')), null);
});

test('session start tolerates a project with .apv but no state directory', t => {
  const root = project(t, { apv: false });
  mkdirSync(join(root, '.apv'));
  const result = run('session-start.mjs', { hook_event_name: 'SessionStart', cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /Aucune note de reprise/);
});

test('journalLine records time, session and running background work on one line', () => {
  const line = journalLine({
    session_id: 'abc',
    background_tasks: [
      { id: '1', type: 'subagent', status: 'running', agent_type: 'apv:implementer' },
      { id: '2', type: 'shell', status: 'completed', command: 'npm test' },
      { id: '3', type: 'shell', status: 'running', description: 'vite\npreview' },
    ],
  }, new Date('2026-09-23T12:00:00.000Z'));
  assert.equal(line, '2026-09-23T12:00:00.000Z fin-de-tour session=abc taches_en_fond=2 [apv:implementer:running, shell:running]\n');
  assert.equal(journalLine({}, new Date('2026-09-23T12:00:00.000Z')), '2026-09-23T12:00:00.000Z fin-de-tour session=? taches_en_fond=0\n');
});

test('stop hook appends to .apv/state/journal.log only when .apv exists, and never prints', t => {
  const root = project(t, { apv: false });
  let result = run('stop-journal.mjs', { hook_event_name: 'Stop', session_id: 's1', cwd: root });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.ok(!existsSync(join(root, '.apv')));

  mkdirSync(join(root, '.apv'));
  for (const id of ['s1', 's2']) {
    result = run('stop-journal.mjs', { hook_event_name: 'Stop', session_id: id, cwd: root, stop_hook_active: false });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
  const lines = readFileSync(join(root, '.apv', 'state', 'journal.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z fin-de-tour session=s1 taches_en_fond=0$/);
  assert.match(lines[1], /session=s2/);
});

test('stop hook survives malformed input', t => {
  const root = project(t);
  const result = spawnSync(process.execPath, [scriptPath('stop-journal.mjs')], {
    input: 'pas du JSON', env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(readFileSync(join(root, '.apv', 'state', 'journal.log'), 'utf8'), /session=\? taches_en_fond=0/);
});
