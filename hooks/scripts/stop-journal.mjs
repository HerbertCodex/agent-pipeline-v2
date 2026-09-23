#!/usr/bin/env node
// Stop hook: appends one timestamped line to `.apv/state/journal.log` so that a resume knows
// when the lead last finished a turn and which background work was still running
// (APV3 spec, section 11). Never blocks the stop and never prints to stdout.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureApvGitignore, findApvDir, isMainModule, oneLine, readHookInput } from './lib.mjs';

/** Formats the journal line for a Stop payload. */
export function journalLine(input, now = new Date()) {
  const tasks = Array.isArray(input?.background_tasks) ? input.background_tasks : [];
  const running = tasks.filter(t => t && t.status !== 'completed' && t.status !== 'failed' && t.status !== 'killed');
  const described = running.slice(0, 10).map(t => {
    const label = t.agent_type ?? t.name ?? t.type ?? 'tâche';
    return `${oneLine(label, 60)}:${oneLine(t.status ?? '?', 20)}`;
  });
  const parts = [
    now.toISOString(),
    'fin-de-tour',
    `session=${oneLine(input?.session_id ?? '?', 80)}`,
    `taches_en_fond=${running.length}`,
  ];
  if (described.length) parts.push(`[${described.join(', ')}]`);
  return `${parts.join(' ')}\n`;
}

async function main() {
  const input = await readHookInput();
  const apvDir = findApvDir(input);
  if (!apvDir) return 0;
  const stateDir = join(apvDir, 'state');
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, 'journal.log'), journalLine(input ?? {}), 'utf8');
  ensureApvGitignore(apvDir);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`APV stop-journal : ${error?.message ?? error}\n`);
    process.exitCode = 0;
  });
}
