#!/usr/bin/env node
// PostToolUse hook on file writes (APV3 spec, section 11): reminds an implementer of the allowed
// paths of its task when it writes outside them. A reminder only, never a block: the strict check
// is `apv scope check` at the end of the task, and a minimal out-of-scope change stays possible
// when it is reported. Silent when no task marker exists, so the lead's own writes are untouched.
//
// Task marker: `.apv/state/task.json` in the implementer's worktree (ignored by Git), either
//   { "spec": ".apv/specs/<id>.json", "task": "<task id>" }   (paths read from the spec), or
//   { "task": "<task id>", "allowedPaths": [...], "allowedNewPaths": [...] }.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneLine, readHookInput } from './lib.mjs';

export const TASK_MARKER = join('.apv', 'state', 'task.json');
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_LISTED = 20;

/** Same glob semantics as `apv scope check` (dist/policy/policy.js); null when the build is absent. */
async function loadMatcher() {
  try {
    const policy = await import(new URL('../../dist/policy/policy.js', import.meta.url).href);
    return typeof policy.matches === 'function' ? policy.matches : null;
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return existsSync(file) && statSync(file).isFile() ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  } catch {
    return null;
  }
}

/** Absolute path of the file a write tool touched, or null. */
export function writtenFile(input) {
  if (!input || !WRITE_TOOLS.has(input.tool_name)) return null;
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const path = toolInput.file_path ?? toolInput.notebook_path;
  if (typeof path !== 'string' || !path) return null;
  return isAbsolute(path) ? path : resolve(typeof input.cwd === 'string' ? input.cwd : process.cwd(), path);
}

/**
 * The task root: the first of the payload's cwd (the implementer's worktree) and CLAUDE_PROJECT_DIR
 * that holds a task marker and contains the written file.
 */
export function findTaskRoot(input, file, env = process.env) {
  const candidates = [input?.cwd, env.CLAUDE_PROJECT_DIR].filter(v => typeof v === 'string' && v.length > 0);
  for (const root of candidates) {
    const rel = relative(root, file);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    if (existsSync(join(root, TASK_MARKER))) return root;
  }
  return null;
}

/** Reads the marker and resolves the task's scope; returns { task, spec, allowedPaths, allowedNewPaths } or { error }. */
export function loadTaskScope(root) {
  const marker = readJson(join(root, TASK_MARKER));
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return { error: `${TASK_MARKER} illisible (JSON attendu)` };
  const taskId = typeof marker.task === 'string' ? marker.task : null;
  const strings = v => Array.isArray(v) && v.every(x => typeof x === 'string') ? v : null;
  if (strings(marker.allowedPaths)) {
    return { task: taskId, spec: null, allowedPaths: marker.allowedPaths, allowedNewPaths: strings(marker.allowedNewPaths) ?? [] };
  }
  if (typeof marker.spec !== 'string' || !taskId) return { error: `${TASK_MARKER} doit donner « spec » et « task », ou « allowedPaths »` };
  const doc = readJson(resolve(root, marker.spec));
  if (!doc) return { error: `spec ${marker.spec} introuvable ou illisible` };
  const spec = doc.spec && typeof doc.spec === 'object' && !Object.hasOwn(doc, 'title') ? doc.spec : doc;
  const task = Array.isArray(spec.tasks) ? spec.tasks.find(t => t && t.id === taskId) : undefined;
  if (!task || !strings(task.allowedPaths)) return { error: `tâche ${taskId} absente de ${marker.spec}` };
  return { task: taskId, spec: marker.spec, allowedPaths: task.allowedPaths, allowedNewPaths: strings(task.allowedNewPaths) ?? [] };
}

/** True when `rel` matches one of the patterns; an unsupported pattern never matches. */
function inside(rel, patterns, matches) {
  return patterns.some(pattern => {
    try { return matches(rel, pattern); } catch { return false; }
  });
}

/** The reminder for one write, or null when the write is inside the task scope. */
export function scopeReminder(rel, scope, matches) {
  if (scope.error) return `[APV] Rappel de périmètre impossible : ${scope.error}. Vérifie le marqueur de tâche ; « apv scope check » reste obligatoire avant de rendre la main.`;
  if (inside(rel, scope.allowedPaths, matches)) return null;
  const envelope = inside(rel, scope.allowedNewPaths, matches);
  const list = paths => paths.slice(0, MAX_LISTED).join(', ') + (paths.length > MAX_LISTED ? `, … (${paths.length - MAX_LISTED} de plus)` : '');
  const check = scope.spec ? `apv scope check --spec ${scope.spec} --task ${scope.task}` : 'apv scope check';
  return [
    `[APV] ${oneLine(rel, 200)} est hors des chemins autorisés de la tâche ${scope.task ?? '?'}` +
      (envelope ? ' (dans une enveloppe allowedNewPaths : accepté seulement pour un nouveau fichier de support, dans la limite maxNewFiles).' : '.'),
    `Chemins autorisés : ${list(scope.allowedPaths)}.` + (scope.allowedNewPaths.length ? ` Nouveaux fichiers : ${list(scope.allowedNewPaths)}.` : ''),
    `Si ce changement est indispensable, garde-le minimal (ajout plutôt que réécriture) et signale-le dans ton rapport ; sinon annule-le. Lance « ${check} » avant de rendre la main.`,
  ].join('\n');
}

async function main() {
  const input = await readHookInput();
  const file = writtenFile(input);
  if (!file) return 0;
  const root = findTaskRoot(input, file);
  if (!root) return 0;
  const matches = await loadMatcher();
  if (!matches) return 0;
  const rel = relative(root, file).split(sep).join('/');
  if (rel === TASK_MARKER.split(sep).join('/')) return 0;
  const reminder = scopeReminder(rel, loadTaskScope(root), matches);
  if (!reminder) return 0;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reminder } })}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`APV scope-reminder : ${error?.message ?? error}\n`);
    process.exitCode = 0;
  });
}
