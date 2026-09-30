#!/usr/bin/env node
// PreToolUse guard for the Write, Edit, MultiEdit, NotebookEdit, Read, Grep and Glob tools: refuses to touch the stores of
// the Git common directory that only the tool and its hooks write (operator journal `apv/operator/`, review records
// `apv/reviews/`, merge traces `apv/merges/`) and the anchor key (`~/.apv-ancrage/cle-ancrage`) that signs them
// (docs/REGLES.md, « Ancrage »). A guard rail, not a sandbox: a script written elsewhere and run later escapes it.
import { isMainModule, namesAnchor, readHookInput } from './lib.mjs';

export const WRITE_REASON = 'APV : accès refusé à un magasin que seuls l\'outil et ses crochets écrivent (apv/operator : les mots tapés par l\'opérateur ; ' +
  'apv/reviews : les relectures ; apv/merges : les fusions) ou à la clé d\'ancrage qui les signe. Une validation ne s\'écrit pas à la main : l\'opérateur la tape dans la session, ' +
  'une relecture s\'enregistre par apv review record, par l\'agent relecteur du domaine ; on lit par apv review show et apv rules check.';

/** { decision: 'allow' } or { decision: 'deny', reason } for one write. */
export function evaluateWrite(input) {
  const tool = input?.tool_input ?? {};
  const targets = [tool.file_path, tool.notebook_path, tool.path, tool.pattern, tool.glob].filter(v => typeof v === 'string');
  // Grep and Glob from the home folder itself toward its hidden folders (where the key is).
  // Glob: its pattern is a path glob; Grep: its glob (its pattern is the text searched, never a path).
  const globs = (input?.tool_name === 'Grep' ? [tool.glob] : [tool.pattern]).filter(v => typeof v === 'string');
  const home = typeof tool.path === 'string' && /^(?:~|\/home\/[^/]+|\/root|\/Users\/[^/]+)\/?$/.test(tool.path.replace(/\\/g, '/'));
  if (home && globs.some(x => /(^|\/)\.[^/.]/.test(x))) return { decision: 'deny', reason: WRITE_REASON };
  return targets.some(target => namesAnchor(target.replace(/\\/g, '/'))) ? { decision: 'deny', reason: WRITE_REASON } : { decision: 'allow' };
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
