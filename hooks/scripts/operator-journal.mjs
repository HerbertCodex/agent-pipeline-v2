#!/usr/bin/env node
// UserPromptSubmit hook: keeps what the operator types himself in the session, in the Git common directory of the project
// (`<git common dir>/apv/operator/messages.jsonl`, never versioned, never sent anywhere). It is the trace an agent cannot
// write: each line is signed with the anchor key kept outside the repository (`~/.apv-ancrage/cle-ancrage`, 0400), and the
// tool ignores an unsigned or altered line (docs/REGLES.md, « Ancrage »). Only what the rules need is kept: the hash of each
// sentence, the first words of the sentences that validate, the waiver lines, secrets masked; purged after
// `rules.journalDays` (90 days by default).
// Only prompts of the interactive composer are kept (`source` "user" or "tty"), never those of a subagent (`agent_id`),
// of a non-interactive session (`claude -p`, the Agent SDK: "sdk", "argument", "stdin", "api", "file"), of a resume, of
// the system or of a wakeup. Claude Code 2.1.280 sends no `source`: the origin is then read from the processes above the
// hook (`sessionOrigin`): the session must be a top-level Claude Code (no other Claude Code above it, so never a session
// started by an agent) that is not in print mode (`-p`, `--print`). Anything else keeps nothing: its date and reason go to
// `refused.json`, which `apv status` shows. Never blocks the prompt, never prints.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
export function operatorEntry(input, origin = null) {
  if (!input || typeof input !== 'object') return null;
  if (input.hook_event_name !== undefined && input.hook_event_name !== 'UserPromptSubmit') return null;
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return null;
  if (input.agent_id) return { refuse: 'message d\'un sous-agent' };
  if (input.source === undefined || input.source === null || input.source === '') {
    // No source (Claude Code 2.1.280): the processes above the hook say whether the operator's own session received it.
    const seen = origin ?? { interactive: false, reason: 'origine de la session non lue' };
    if (!seen.interactive) return { refuse: `champ source absent et ${seen.reason} : rien ne montre que l'opérateur a tapé ce message` };
    return { keep: { text: input.prompt.slice(0, MAX_MESSAGE), session: String(input.session_id ?? '').slice(0, 100) } };
  }
  if (!OPERATOR_SOURCES.includes(input.source)) return { refuse: `source ${String(input.source).slice(0, 40)} : pas un message tapé par l'opérateur` };
  return { keep: { text: input.prompt.slice(0, MAX_MESSAGE), session: String(input.session_id ?? '').slice(0, 100) } };
}

/** Whether the arguments of a process are a Claude Code session (native binary, install, or the npm package run by node). */
export function isClaudeProcess(args) {
  const first = args[0] ?? '';
  if (['claude', 'claude-code'].includes(basename(first))) return true;
  if (/\.local\/+share\/+claude\/+versions\/|native-binary\/+claude$/.test(first)) return true;
  return ['node', 'nodejs', 'bun'].includes(basename(first)) && args.slice(1, 3).some(a => /@anthropic-ai\/+claude-code\//.test(a));
}

/** One process of Linux: its parent and its arguments, from /proc; null when unreadable. */
export function procProcess(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    return { ppid: Number.isInteger(ppid) ? ppid : 0, args };
  } catch {
    // Elsewhere (macOS): ps, its arguments split on spaces.
    const r = spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout ?? '');
    return m ? { ppid: Number(m[1]), args: m[2].trim().split(/\s+/) } : null;
  }
}

/**
 * Who received the prompt, read from the processes above the hook (`read` gives `{ ppid, args }` of a pid): the first
 * Claude Code session met is the one the hook serves. It counts as the operator's own interactive session when it is not
 * in print mode (`-p`, `--print`) and no other Claude Code runs above it (a session an agent started from its own: the
 * Bash guard refuses nested sessions, this is the second lock). A guard rail, not a proof against a determined agent
 * (docs/REGLES.md, « Limites »).
 */
export function sessionOrigin(read = procProcess, start = process.ppid) {
  let pid = start;
  let session = null;
  for (let depth = 0; depth < 64 && pid > 1; depth += 1) {
    const proc = read(pid);
    if (!proc) break;
    if (isClaudeProcess(proc.args)) {
      if (session) return { interactive: false, reason: `session Claude Code lancée depuis une autre session (pid ${pid})` };
      session = { pid, args: proc.args };
      if (proc.args.some(a => a === '-p' || a === '--print' || /^-[a-zA-Z]*p[a-zA-Z]*$/.test(a) && !a.startsWith('--'))) {
        return { interactive: false, reason: 'session Claude Code non interactive (-p, --print)' };
      }
    }
    if (!proc.ppid || proc.ppid === pid) break;
    pid = proc.ppid;
  }
  return session ? { interactive: true, reason: `session Claude Code de premier niveau (pid ${session.pid})` }
    : { interactive: false, reason: 'aucune session Claude Code parmi les processus parents du crochet' };
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
  const decision = operatorEntry(input, input && !input.source ? sessionOrigin() : null);
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
