#!/usr/bin/env node
// PostToolUse hook for Bash: seals a review record right after `apv review record` ran, when the agent that ran it is
// the reviewer agent of the domain (`apv:qa-securite` for securite...), under its own name. The seal is an HMAC of the
// record with the anchor key, kept outside the repository (`~/.apv-ancrage/cle-ancrage`, 0400): `apv rules check` counts
// only sealed records, so a record written by anyone else (the implementer, the lead, a script) proves nothing.
// Never blocks, never prints.
import { spawnSync } from 'node:child_process';
import { isMainModule, readHookInput } from './lib.mjs';
import { reviewRecordCall, reviewRecordProblem } from './bash-guard.mjs';

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

async function main() {
  process.env.APV_ENTRY = 'hook';
  const input = await readHookInput();
  const request = sealRequest(input);
  if (!request) return 0;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  if (r.status !== 0 || !r.stdout.trim()) return 0;
  const operator = await import(OPERATOR_MODULE.href);
  const reviews = await import(REVIEWS_MODULE.href);
  const keyFile = typeof process.env.APV_ANCHOR_KEY_FILE === 'string' && process.env.APV_ANCHOR_KEY_FILE ? process.env.APV_ANCHOR_KEY_FILE : operator.anchorKeyFile();
  const common = r.stdout.trim();
  let key;
  try { key = operator.ensureAnchorKey(common, keyFile); } catch (error) { operator.recordRefusal(common, `relecture non scellée : ${error?.message ?? error}`); return 0; }
  reviews.sealReview(common, request.id, request.domain, request.agent, key);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`APV review-seal : ${error?.message ?? error}\n`);
    process.exitCode = 0;
  });
}
