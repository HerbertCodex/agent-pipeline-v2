#!/usr/bin/env node
// PreToolUse guard for the Write, Edit, MultiEdit and NotebookEdit tools: refuses a write into the stores of the Git
// common directory that only the tool writes, the operator journal (`apv/operator/`) and the review records
// (`apv/reviews/`) (docs/REGLES.md, « Ancrage »). A guard rail against an agent writing its own validation, not a
// sandbox: a script written elsewhere and run later escapes it.
import { ANCHOR_STORES, isMainModule, readHookInput } from './lib.mjs';

export const WRITE_REASON = 'APV : écriture refusée dans un magasin que seul l\'outil écrit (apv/operator : les mots tapés par l\'opérateur ; ' +
  'apv/reviews : les relectures enregistrées). Une validation ne s\'écrit pas à la main : l\'opérateur la tape dans la session, ' +
  'une relecture s\'enregistre par apv review record, par l\'agent relecteur du domaine.';

/** { decision: 'allow' } or { decision: 'deny', reason } for one write. */
export function evaluateWrite(input) {
  const target = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  if (typeof target !== 'string') return { decision: 'allow' };
  return ANCHOR_STORES.test(target.replace(/\\/g, '/')) ? { decision: 'deny', reason: WRITE_REASON } : { decision: 'allow' };
}

async function main() {
  const input = await readHookInput();
  const result = evaluateWrite(input);
  if (result.decision === 'allow') return 0;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } })}\n`);
  process.stderr.write(`${result.reason}\n`);
  return 2;
}

if (isMainModule(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`APV write-guard : ${error?.message ?? error}\n`);
    process.exitCode = 0;
  });
}
