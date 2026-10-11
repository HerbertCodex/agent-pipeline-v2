#!/usr/bin/env node
// PreToolUse guard for the Write, Edit, MultiEdit, NotebookEdit, Read, Grep and Glob tools: refuses to touch the stores of
// the Git common directory that only the tool and its hooks write (operator journal `apv/operator/`, review records
// `apv/reviews/`, merge traces `apv/merges/`) and the anchor key (`~/.apv-ancrage/cle-ancrage`) that signs them
// (docs/REGLES.md, « Ancrage »). A guard rail, not a sandbox: a script written elsewhere and run later escapes it.
import { readFileSync } from 'node:fs';
import { environmentFile, isMainModule, namesAnchor, profileMaySetApv, readHookInput, settingsSetApv } from './lib.mjs';

export const WRITE_REASON = 'APV : accès refusé à un magasin que seuls l\'outil et ses crochets écrivent (apv/operator : les mots tapés par l\'opérateur ; ' +
  'apv/reviews : les relectures ; apv/merges : les fusions) ou à la clé d\'ancrage qui les signe. Une validation ne s\'écrit pas à la main : l\'opérateur la tape dans la session, ' +
  'une relecture s\'enregistre par apv review record, par l\'agent relecteur du domaine ; on lit par apv review show et apv rules check.';

export const ENVIRONMENT_REASON = 'APV : écriture refusée : elle met une variable APV_ (ou un nom construit, un texte exécuté sans être lu) dans les réglages ' +
  'de Claude Code (bloc env de .claude/settings*.json) ou dans un profil du shell. Ces fichiers fixent l\'environnement de la session et de ses crochets ' +
  'au prochain lancement : une variable APV_ y lèverait un garde-fou (fusion, déploiement) sans commande. L\'opérateur l\'écrit lui-même, dans son terminal.';

/** The content of `file` once the edits of an Edit or MultiEdit are applied in order (the file read as it is now). */
function editedContent(file, edits) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { text = ''; }
  for (const e of edits) {
    if (typeof e?.old_string !== 'string' || typeof e?.new_string !== 'string') continue;
    text = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string);
  }
  return text;
}

/**
 * Whether a Write, Edit or MultiEdit puts an APV variable in a file that sets the environment of the session: the
 * settings of Claude Code judged on their content once written, a shell profile on the text it adds.
 */
export function environmentWriteProblem(input) {
  const tool = input?.tool_input ?? {};
  const file = typeof tool.file_path === 'string' ? tool.file_path : null;
  const kind = file ? environmentFile(file) : null;
  if (!kind) return false;
  const edits = input?.tool_name === 'MultiEdit' ? (Array.isArray(tool.edits) ? tool.edits : []) : input?.tool_name === 'Edit' ? [tool] : null;
  if (kind === 'settings') {
    const final = edits ? editedContent(file, edits) : typeof tool.content === 'string' ? tool.content : '';
    return settingsSetApv(final);
  }
  let before = '';
  try { before = readFileSync(file, 'utf8'); } catch { before = ''; }
  const added = edits ? edits.map(e => (typeof e?.new_string === 'string' ? e.new_string : '')).join('\n')
    : (typeof tool.content === 'string' ? tool.content : '').split('\n').filter(line => !before.split('\n').includes(line)).join('\n');
  return profileMaySetApv(added);
}

/** { decision: 'allow' } or { decision: 'deny', reason } for one write. */
export function evaluateWrite(input) {
  const tool = input?.tool_input ?? {};
  if (['Write', 'Edit', 'MultiEdit'].includes(input?.tool_name) && environmentWriteProblem(input)) return { decision: 'deny', reason: ENVIRONMENT_REASON };
  // Paths only: the pattern of Grep is the text searched (a search for « apv/reviews » in src is not a read of the store);
  // the pattern of Glob is a path glob.
  const targets = [tool.file_path, tool.notebook_path, tool.path, input?.tool_name === 'Grep' ? undefined : tool.pattern, tool.glob].filter(v => typeof v === 'string');
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
