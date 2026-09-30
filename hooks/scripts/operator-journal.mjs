#!/usr/bin/env node
// UserPromptSubmit hook: keeps what the operator types himself in the session, in the Git common directory of the project
// (`<git common dir>/apv/operator/messages.jsonl`, never versioned, never sent anywhere). It is the trace an agent cannot
// write: a validation or a waiver the tool reads (`apv rules check`) counts only when the operator's own words are there.
// Only prompts submitted from the interactive composer are kept (`source: "user"`), never those of a subagent
// (`agent_id`) nor of a non-interactive session (`claude -p`, the Agent SDK), which an agent can launch.
// The Bash guard refuses the commands that name this folder, and the write guard refuses Write and Edit there.
// Never blocks the prompt and never prints to stdout.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { findApvDir, isMainModule, readHookInput } from './lib.mjs';

/** Where the operator journal lives, under the Git common directory (same path as src/rules/operator.ts). */
export const OPERATOR_JOURNAL = ['apv', 'operator', 'messages.jsonl'];
/** Longest message kept, in characters. */
export const MAX_MESSAGE = 20000;

/** The journal entry of a UserPromptSubmit payload, or null when it is not the operator's own words. */
export function operatorEntry(input, now = new Date()) {
  if (!input || typeof input !== 'object') return null;
  if (input.hook_event_name !== undefined && input.hook_event_name !== 'UserPromptSubmit') return null;
  if (input.agent_id) return null;
  if (input.source !== 'user') return null;
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return null;
  const text = input.prompt.slice(0, MAX_MESSAGE);
  return { at: now.toISOString(), session: String(input.session_id ?? '').slice(0, 100), sha256: createHash('sha256').update(text).digest('hex'), text };
}

function commonDir(cwd) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

async function main() {
  const input = await readHookInput();
  const entry = operatorEntry(input);
  if (!entry) return 0;
  const apvDir = findApvDir(input);
  if (!apvDir) return 0;
  const common = commonDir(join(apvDir, '..'));
  if (!common) return 0;
  const dir = join(common, ...OPERATOR_JOURNAL.slice(0, -1));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, OPERATOR_JOURNAL.at(-1)), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`APV operator-journal : ${error?.message ?? error}\n`);
    process.exitCode = 0;
  });
}
