// Shared helpers for the APV plugin hooks. Node built-ins only: hooks run
// before any dependency install and must never fail because of a package.
import { existsSync, statSync } from 'node:fs';
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
