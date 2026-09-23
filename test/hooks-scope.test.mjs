import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTaskRoot, loadTaskScope, scopeReminder, writtenFile } from '../hooks/scripts/scope-reminder.mjs';
import { matches } from '../dist/policy/policy.js';

const script = fileURLToPath(new URL('../hooks/scripts/scope-reminder.mjs', import.meta.url));

function worktree(t, marker, spec) {
  const root = mkdtempSync(join(tmpdir(), 'apv-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.apv', 'state'), { recursive: true });
  if (spec !== undefined) {
    mkdirSync(join(root, '.apv', 'specs'), { recursive: true });
    writeFileSync(join(root, '.apv', 'specs', '6.json'), typeof spec === 'string' ? spec : JSON.stringify(spec));
  }
  if (marker !== undefined) writeFileSync(join(root, '.apv', 'state', 'task.json'), typeof marker === 'string' ? marker : JSON.stringify(marker));
  return root;
}
const spec = { title: 'Import', tasks: [
  { id: 'T1', allowedPaths: ['src/lib/import/**', 'src/routes/import/+page.svelte'], allowedNewPaths: ['src/lib/import/fixtures/**'] },
  { id: 'T2', allowedPaths: ['docs/**'] },
] };
function hook(payload, env = {}) {
  return spawnSync(process.execPath, [script], { input: JSON.stringify(payload), env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...env }, encoding: 'utf8' });
}
const write = (root, path, tool = 'Write') => ({ hook_event_name: 'PostToolUse', tool_name: tool, cwd: root, tool_input: { file_path: join(root, path), content: 'x' }, tool_response: { success: true } });

test('a write outside the allowed paths gets a reminder with the paths and the scope check command', t => {
  const root = worktree(t, { spec: '.apv/specs/6.json', task: 'T1' }, spec);
  const result = hook(write(root, 'src/lib/auth/session.ts', 'Edit'));
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  const text = output.hookSpecificOutput.additionalContext;
  assert.match(text, /src\/lib\/auth\/session\.ts est hors des chemins autorisés de la tâche T1\./);
  assert.match(text, /Chemins autorisés : src\/lib\/import\/\*\*, src\/routes\/import\/\+page\.svelte\. Nouveaux fichiers : src\/lib\/import\/fixtures\/\*\*/);
  assert.match(text, /apv scope check --spec \.apv\/specs\/6\.json --task T1/);
  assert.equal(output.decision, undefined, 'a reminder, never a block');
});

test('a write inside the allowed paths, or with no task marker, is silent', t => {
  const root = worktree(t, { spec: '.apv/specs/6.json', task: 'T1' }, spec);
  for (const path of ['src/lib/import/csv.ts', 'src/routes/import/+page.svelte']) {
    const result = hook(write(root, path));
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
  }
  // The marker itself is written by the implementer when it starts.
  assert.equal(hook(write(root, '.apv/state/task.json')).stdout, '');
  const lead = worktree(t, undefined, spec);
  assert.equal(hook(write(lead, 'anything/at/all.ts')).stdout, '');
  // Other tools and malformed payloads are ignored.
  assert.equal(hook({ tool_name: 'Bash', cwd: root, tool_input: { command: 'touch x' } }).stdout, '');
  const bad = spawnSync(process.execPath, [script], { input: 'pas du JSON', encoding: 'utf8' });
  assert.equal(bad.status, 0); assert.equal(bad.stdout, '');
});

test('an inline marker, a new-file envelope and a notebook are understood', t => {
  const root = worktree(t, { task: 'T9', allowedPaths: ['app/**'], allowedNewPaths: ['tests/fixtures/**'] });
  const envelope = hook(write(root, 'tests/fixtures/a.json'));
  assert.match(JSON.parse(envelope.stdout).hookSpecificOutput.additionalContext, /tâche T9 \(dans une enveloppe allowedNewPaths/);
  assert.match(JSON.parse(envelope.stdout).hookSpecificOutput.additionalContext, /« apv scope check »/);
  const notebook = { tool_name: 'NotebookEdit', cwd: root, tool_input: { notebook_path: 'notes/a.ipynb' } };
  assert.match(JSON.parse(hook(notebook).stdout).hookSpecificOutput.additionalContext, /notes\/a\.ipynb est hors/);
  assert.equal(hook(write(root, 'app/x.ts', 'MultiEdit')).stdout, '');
});

test('a broken marker says so instead of staying silent', t => {
  for (const [marker, specValue, error] of [
    ['pas du json', undefined, /illisible/],
    [{ task: 'T1' }, undefined, /doit donner « spec » et « task »/],
    [{ spec: '.apv/specs/absent.json', task: 'T1' }, undefined, /introuvable ou illisible/],
    [{ spec: '.apv/specs/6.json', task: 'T7' }, spec, /tâche T7 absente/],
    [{ spec: '.apv/specs/6.json', task: 'T1' }, '{', /introuvable ou illisible/],
  ]) {
    const root = worktree(t, marker, specValue);
    const result = hook(write(root, 'src/x.ts'));
    assert.equal(result.status, 0);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, error);
  }
});

test('the task root is the worktree that holds the marker and contains the file', t => {
  const root = worktree(t, { task: 'T1', allowedPaths: ['a/**'] });
  const project = worktree(t, undefined);
  assert.equal(findTaskRoot({ cwd: root }, join(root, 'b.ts'), {}), root);
  assert.equal(findTaskRoot({ cwd: project }, join(root, 'b.ts'), { CLAUDE_PROJECT_DIR: root }), root);
  assert.equal(findTaskRoot({ cwd: root }, '/elsewhere/b.ts', {}), null, 'a file outside the worktree is not judged');
  assert.equal(findTaskRoot({ cwd: project }, join(project, 'b.ts'), {}), null);
  assert.equal(findTaskRoot(null, join(root, 'b.ts'), {}), null);
  assert.equal(writtenFile({ tool_name: 'Write', cwd: root, tool_input: { file_path: 'rel/x.ts' } }), join(root, 'rel/x.ts'));
  assert.equal(writtenFile({ tool_name: 'Write', tool_input: {} }), null);
  assert.equal(writtenFile({ tool_name: 'Read', tool_input: { file_path: '/x' } }), null);
  assert.equal(writtenFile(null), null);
});

test('scopeReminder uses the glob rules of apv scope check and bounds long lists', t => {
  const wrapped = worktree(t, { spec: '.apv/specs/6.json', task: 'T2' }, { request: 'Importer.', spec });
  const scope = loadTaskScope(wrapped);
  assert.deepEqual(scope, { task: 'T2', spec: '.apv/specs/6.json', allowedPaths: ['docs/**'], allowedNewPaths: [] });
  assert.equal(scopeReminder('docs/a/b.md', scope, matches), null);
  assert.match(scopeReminder('README.md', scope, matches), /hors des chemins autorisés de la tâche T2\./);
  // An unsupported pattern never matches and never throws.
  assert.match(scopeReminder('src/a.ts', { task: 'T', spec: null, allowedPaths: ['src/{a,b}.ts'], allowedNewPaths: [] }, matches), /hors/);
  const many = Array.from({ length: 30 }, (_, i) => `dir${i}/**`);
  assert.match(scopeReminder('x.ts', { task: 'T', spec: null, allowedPaths: many, allowedNewPaths: [] }, matches), /\(10 de plus\)/);
});
