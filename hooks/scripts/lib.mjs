// Shared helpers for the APV plugin hooks. Node built-ins only: hooks run
// before any dependency install and must never fail because of a package.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Reads the whole hook payload from stdin; resolves to null when it is not a JSON object. */
export async function readHookInput(stream = process.stdin) {
  let raw = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) raw += chunk;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Returns the project's `.apv` directory, or null when the project does not use APV.
 * The project root comes from CLAUDE_PROJECT_DIR (set by Claude Code for hooks), then the
 * payload's cwd. No parent directory is searched: a hook must never write outside the project.
 */
export function findApvDir(input, env = process.env) {
  const candidates = [env.CLAUDE_PROJECT_DIR, input?.cwd].filter(v => typeof v === 'string' && v.length > 0);
  for (const root of candidates) {
    const dir = join(root, '.apv');
    try {
      if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
    } catch {
      // Unreadable candidate: try the next one.
    }
  }
  return null;
}

/** Collapses whitespace and bounds a value so it fits on one journal or context line. */
export function oneLine(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Machine files of `.apv/` that are never versioned. Same list and same rule as
 * `ensureApvGitignore` of the tool (src/config/apv-files.ts); a test keeps them equal.
 */
export const APV_IGNORED = ['state/*.log', 'state/task.json', 'state/preview.json', 'receipts/'];
const IGNORE_HEADER = '# Généré par apv : fichiers machine de .apv/, jamais versionnés. Vous pouvez ajouter vos lignes.';

/** Creates `<apvDir>/.gitignore`, or appends the lines it lacks; keeps the project's own lines. */
export function ensureApvGitignore(apvDir) {
  const file = join(apvDir, '.gitignore');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const present = new Set((current ?? '').split(/\r?\n/).map(l => l.trim()));
  const missing = APV_IGNORED.filter(line => !present.has(line));
  if (current !== null && !missing.length) return false;
  mkdirSync(apvDir, { recursive: true });
  if (current === null) writeFileSync(file, `${IGNORE_HEADER}\n${missing.join('\n')}\n`);
  else writeFileSync(file, `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}${missing.join('\n')}\n`);
  return true;
}
