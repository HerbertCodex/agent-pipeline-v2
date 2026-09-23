import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The project directory of APV3: configuration, ledger, specs and state, versioned with the project. */
export const APV_DIR = '.apv';

/**
 * Machine files under `.apv/` that are never versioned: journals of the tool and of the hooks
 * (`state/quota.log`, `state/journal.log`, `state/preview.log`), gate receipts, the task marker of an implementer
 * worktree and the preview server record (`state/preview.json`, a pid of this machine). Resume notes (`state/resume.md`) and plans stay versioned. The Stop hook of the plugin
 * writes the same lines (hooks/scripts/lib.mjs); a test keeps both lists equal.
 */
export const APV_IGNORED = ['state/*.log', 'state/task.json', 'state/preview.json', 'receipts/'] as const;

const HEADER = '# Généré par apv : fichiers machine de .apv/, jamais versionnés. Vous pouvez ajouter vos lignes.';

/**
 * Creates `.apv/.gitignore`, or appends the ignored lines it lacks. Owned by the writers of the state
 * journals, `apv quota` and the Stop hook: whoever writes a journal makes sure it stays out of commits.
 * `apv gates run` does not call it: a gate may check that the tree is clean, and its receipts ignore
 * themselves (`receipts/.gitignore`). Lines the project added are kept. Returns true when it wrote.
 */
/** Ignored lines `.apv/.gitignore` lacks (all of them when the file is absent); reads only. */
export function apvGitignoreMissing(repo: string): string[] {
  const file = join(repo, APV_DIR, '.gitignore');
  const present = new Set((existsSync(file) ? readFileSync(file, 'utf8') : '').split(/\r?\n/).map(l => l.trim()));
  return APV_IGNORED.filter(line => !present.has(line));
}

export function ensureApvGitignore(repo: string): boolean {
  const dir = join(repo, APV_DIR);
  const file = join(dir, '.gitignore');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const missing = apvGitignoreMissing(repo);
  if (current !== null && !missing.length) return false;
  mkdirSync(dir, { recursive: true });
  if (current === null) writeFileSync(file, `${HEADER}\n${missing.join('\n')}\n`);
  else writeFileSync(file, `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}${missing.join('\n')}\n`);
  return true;
}
