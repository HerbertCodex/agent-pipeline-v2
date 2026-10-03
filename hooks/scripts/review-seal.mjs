#!/usr/bin/env node
// PostToolUse hook for Bash: seals a review record right after `apv review record` ran, when the agent that ran it is
// the reviewer agent of the domain (`apv:qa-securite` for securite...), under its own name. The seal is an HMAC of the
// record with the anchor key, kept outside the repository (`~/.apv-ancrage/cle-ancrage`, 0400): `apv rules check` counts
// only sealed records, so a record written by anyone else (the implementer, the lead, a script) proves nothing.
// Never blocks, never prints.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMainModule, readHookInput } from './lib.mjs';
import { apvArguments, reviewRecordCall, reviewRecordProblem, tokenize } from './bash-guard.mjs';
import { cdTarget } from './harness-guard.mjs';

const OPERATOR_MODULE = new URL('../../dist/rules/operator.js', import.meta.url);
const REVIEWS_MODULE = new URL('../../dist/rules/reviews.js', import.meta.url);

/** The record id printed by `apv review record` (text or JSON output), or null. */
export function recordId(response) {
  const text = typeof response === 'string' ? response : [response?.stdout, response?.output, response?.content].filter(v => typeof v === 'string').join('\n');
  return /Enregistrement (\d{8}T\d{6}Z-[0-9a-f]{8})\b/.exec(text)?.[1] ?? /"id":\s*"(\d{8}T\d{6}Z-[0-9a-f]{8})"/.exec(text)?.[1] ?? null;
}

/** What to seal for a PostToolUse payload: `{ id, domain, agent }`, or null. */
export function sealRequest(input) {
  if (!input || input.tool_name !== 'Bash') return null;
  const call = reviewRecordCall(input.tool_input?.command);
  if (!call || !call.domain || typeof input.agent_type !== 'string' || !input.agent_type) return null;
  if (reviewRecordProblem(call.words, input.agent_type) !== null) return null;
  const id = recordId(input.tool_response);
  return id ? { id, domain: call.domain, agent: input.agent_type } : null;
}

/**
 * The directories where `apv review record` may have written, most likely first: the one the literal `cd` of the command
 * lead to, with its `--repo` (which the tool reads from its own directory), then the directory of the session.
 */
export function recordDirectories(command, cwd, home = null) {
  const out = [];
  let dir = cwd;
  for (const words of tokenize(String(command ?? '')).segments) {
    const moved = cdTarget(words, dir, home);
    if (moved !== undefined) { dir = moved; continue; }
    const args = apvArguments(words);
    // The record itself, never an earlier call of the tool on the line (`apv status && cd b && apv review record`).
    if (!args || args.filter(a => !a.startsWith('-'))[0] !== 'review' || !args.includes('record')) continue;
    const flag = args.indexOf('--repo');
    const repo = args.find(a => a.startsWith('--repo='))?.slice('--repo='.length) ?? (flag === -1 ? undefined : args[flag + 1]);
    if (dir !== null) out.push(repo && !/[$`]/.test(repo) ? resolve(dir, repo) : dir);
    break;
  }
  return [...new Set([...out, cwd])];
}

async function main() {
  process.env.APV_ENTRY = 'hook';
  const input = await readHookInput();
  const request = sealRequest(input);
  if (!request) return 0;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const operator = await import(OPERATOR_MODULE.href);
  const reviews = await import(REVIEWS_MODULE.href);
  const keyFile = typeof process.env.APV_ANCHOR_KEY_FILE === 'string' && process.env.APV_ANCHOR_KEY_FILE ? process.env.APV_ANCHOR_KEY_FILE : operator.anchorKeyFile();
  // Sealed in the repository where the record was written: the session may sit in another one (a reviewer launched from
  // the session of an application, on a copy of the tool).
  for (const dir of recordDirectories(input.tool_input?.command, cwd, process.env.HOME ?? null)) {
    const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    if (r.status !== 0 || !r.stdout.trim()) continue;
    const common = r.stdout.trim();
    if (!reviews.recordExists(common, request.id, request.domain)) continue;
    let key;
    try { key = operator.ensureAnchorKey(common, keyFile); } catch (error) { operator.recordRefusal(common, `relecture non scellée : ${error?.message ?? error}`); return 0; }
    const sealed = reviews.sealReview(common, request.id, request.domain, request.agent, key);
    // A sealed review lifts an earlier note of a review this hook could not seal (here, and in the session's project).
    if (sealed?.file) {
      operator.clearSealRefusal(common);
      const s = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      if (s.status === 0 && s.stdout.trim() && s.stdout.trim() !== common) operator.clearSealRefusal(s.stdout.trim());
    }
    return 0;
  }
  // Written where this hook cannot follow (`cd "$X" && apv review record`): said by apv status of the session's project,
  // never by creating the stores of a repository that has none.
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  const common = r.status === 0 ? r.stdout.trim() : '';
  if (common && existsSync(join(common, 'apv'))) operator.recordRefusal(common, `relecture ${request.id} non scellée : enregistrée dans un dépôt que le crochet ne retrouve pas (lance apv review record depuis la copie relue, par un cd en clair ou --repo)`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`APV review-seal : ${error?.message ?? error}\n`);
    process.exitCode = 0;
  });
}
