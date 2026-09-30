#!/usr/bin/env node
// UserPromptSubmit hook: keeps what the operator types himself in the session, in the Git common directory of the project
// (`<git common dir>/apv/operator/messages.jsonl`, never versioned, never sent anywhere). It is the trace an agent cannot
// write: each line is signed with the anchor key kept outside the repository (`~/.apv-ancrage/cle-ancrage`, 0400), and the
// tool ignores an unsigned or altered line (docs/REGLES.md, « Ancrage »). Only what the rules need is kept: the hash of each
// sentence, the first words of the sentences that validate, the waiver lines, secrets masked; purged after
// `rules.journalDays` (90 days by default).
// Only prompts of the interactive composer are kept (`source` "user" or "tty"), never those of a subagent (`agent_id`),
// of a non-interactive session (`claude -p`, the Agent SDK: "sdk", "argument", "stdin", "api", "file"), of a resume, of
// the system or of a wakeup. A payload without `source` keeps nothing (a `claude -p` launched by an agent could not be
// told apart): its date and reason go to `refused.json`, which `apv status` shows. Never blocks the prompt, never prints.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findApvDir, isMainModule, readHookInput } from './lib.mjs';

const OPERATOR_MODULE = new URL('../../dist/rules/operator.js', import.meta.url);
/** Sources of the operator's own typing. */
export const OPERATOR_SOURCES = ['user', 'tty'];
/** Longest message read, in characters. */
export const MAX_MESSAGE = 20000;

/**
 * What to do with a UserPromptSubmit payload: `{ keep: { text, session } }` for the operator's own words,
 * `{ refuse: <reason> }` otherwise (null when the payload is not a prompt at all).
 */
export function operatorEntry(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.hook_event_name !== undefined && input.hook_event_name !== 'UserPromptSubmit') return null;
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return null;
  if (input.agent_id) return { refuse: 'message d\'un sous-agent' };
  if (input.source === undefined || input.source === null || input.source === '') {
    return { refuse: 'champ source absent du crochet UserPromptSubmit : cette version de Claude Code ne dit pas qui a écrit le message' };
  }
  if (!OPERATOR_SOURCES.includes(input.source)) return { refuse: `source ${String(input.source).slice(0, 40)} : pas un message tapé par l'opérateur` };
  return { keep: { text: input.prompt.slice(0, MAX_MESSAGE), session: String(input.session_id ?? '').slice(0, 100) } };
}

/** The key file: `APV_ANCHOR_KEY_FILE` (set for the hook by its launcher, tests only), else the account's configuration folder. */
export function hookKeyFile(operator, env = process.env) {
  return typeof env.APV_ANCHOR_KEY_FILE === 'string' && env.APV_ANCHOR_KEY_FILE ? env.APV_ANCHOR_KEY_FILE : operator.anchorKeyFile();
}

function commonDir(cwd) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function journalDays(apvDir, fallback) {
  try {
    const days = JSON.parse(readFileSync(join(apvDir, 'config.json'), 'utf8'))?.rules?.journalDays;
    return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : fallback;
  } catch { return fallback; }
}

async function main() {
  process.env.APV_ENTRY = 'hook';
  const input = await readHookInput();
  const decision = operatorEntry(input);
  if (!decision) return 0;
  const apvDir = findApvDir(input);
  if (!apvDir) return 0;
  const common = commonDir(join(apvDir, '..'));
  if (!common) return 0;
  const operator = await import(OPERATOR_MODULE.href);
  if (decision.refuse) { operator.recordRefusal(common, decision.refuse); return 0; }
  let key;
  try { key = operator.ensureAnchorKey(common, hookKeyFile(operator)); }
  catch (error) { operator.recordRefusal(common, error?.message ?? String(error)); return 0; }
  const entry = operator.journalEntry(decision.keep.text, { at: new Date().toISOString(), session: decision.keep.session }, key);
  if (entry) operator.appendJournal(common, entry, journalDays(apvDir, operator.DEFAULT_JOURNAL_DAYS));
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`APV operator-journal : ${error?.message ?? error}\n`);
    process.exitCode = 0;
  });
}
