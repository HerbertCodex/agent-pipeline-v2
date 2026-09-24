import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { PipelineError } from '../domain/errors.js';
import type { GitProbe } from './state.js';

/** Read-only Git call; null when Git refuses (unknown ref, not a repository). */
export function gitRead(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
  } catch { return null; }
}

/** Root of the working tree that contains `path`; refuses outside a Git repository (exit 1). */
export function gitRoot(path: string): string {
  const dir = resolve(path);
  const root = existsSync(dir) ? gitRead(dir, ['rev-parse', '--show-toplevel']) : null;
  if (!root) throw new PipelineError('NOT_A_REPOSITORY', `Pas un dépôt Git : ${dir}`);
  return realpathSync(root);
}

/** Full commit id of a commit-ish, or null when it does not name a commit here. */
export function resolveCommit(repo: string, ref: string): string | null {
  if (!ref || ref.startsWith('-')) return null;
  const sha = gitRead(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  return sha && /^[a-f0-9]{40,64}$/.test(sha) ? sha : null;
}

export function gitProbe(repo: string): GitProbe {
  return {
    exists: path => existsSync(path),
    resolve: (ref, worktree) => worktree ? (existsSync(worktree) ? resolveCommit(worktree, ref) : null) : resolveCommit(repo, ref),
    isAncestor: (commit, head) => /^[a-f0-9]{7,64}$/.test(commit) && /^[a-f0-9]{7,64}$/.test(head) &&
      gitRead(repo, ['merge-base', '--is-ancestor', commit, head]) !== null,
    countAfter: (base, head, worktree) => {
      const out = gitRead(worktree && existsSync(worktree) ? worktree : repo, ['rev-list', '--count', `${base}..${head}`]);
      return out !== null && /^\d+$/.test(out) ? Number(out) : null;
    },
  };
}
