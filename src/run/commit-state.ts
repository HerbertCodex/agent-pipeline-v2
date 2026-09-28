import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gitRead } from './git-probe.js';

/**
 * Commit of the state of an execution (docs/APV3-SPEC.md, section 18.3): `.apv/state/run-<id>.json` and
 * `.apv/state/resume.md`, and nothing else, even when other files are staged. At the delivery, it leaves the tree
 * clean for the full suite (pilot project, 27 September 2026: a green suite proved nothing because of an untracked
 * state file). Only on the branch of the execution (`apv/<id>` or `apv/<id>-…`): elsewhere, nothing is committed.
 */
export interface StateCommit {
  /** The commit made, or null when nothing was committed. */
  sha: string | null;
  /** Files committed (paths relative to the checkout). */
  files: string[];
  /** Why nothing was committed, or how the commit went, in one sentence. */
  note: string;
  /** True when the commit was refused (Git error, wrong branch): the tree may still be dirty. */
  refused: boolean;
}

/** The files of the state of an execution, relative to the root of its checkout. */
export const stateFiles = (specId: string): string[] => [`.apv/state/run-${specId}.json`, '.apv/state/resume.md'];

/** The refusal when Git has no identity for a commit here (user.name and user.email, or GIT_AUTHOR_* and GIT_COMMITTER_*). */
export const IDENTITY_HINT = 'identité Git absente : git config user.name "Votre Nom" && git config user.email "vous@exemple.fr" (--global pour tous les dépôts), ou GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME et GIT_COMMITTER_EMAIL dans l\'environnement';

/** Whether Git has an identity for a commit in `cwd`, never guessed from the host (`user.useConfigOnly`). */
export function hasGitIdentity(cwd: string, env: NodeJS.ProcessEnv): boolean {
  const run = (kind: string): boolean => spawnSync('git', ['-c', 'user.useConfigOnly=true', 'var', kind], { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, stdio: 'ignore', timeout: 30_000 }).status === 0;
  return run('GIT_AUTHOR_IDENT') && run('GIT_COMMITTER_IDENT');
}

export function commitRunState(checkout: string, specId: string, branch: string, label: string, env: NodeJS.ProcessEnv = process.env): StateCommit {
  const current = gitRead(checkout, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (!current) return { sha: null, files: [], refused: true, note: 'état non commité : tête détachée (commiter .apv/state/ à la main sur la branche de l\'exécution)' };
  if (current !== branch && !current.startsWith(`${branch}-`)) {
    return { sha: null, files: [], refused: true, note: `état non commité : le checkout ${checkout} est sur ${current}, pas sur la branche de l'exécution ${branch}` };
  }
  const candidates = stateFiles(specId).filter(f => existsSync(join(checkout, f)) || gitRead(checkout, ['ls-files', '--error-unmatch', '--', f]) !== null);
  if (!candidates.length) return { sha: null, files: [], refused: false, note: 'aucun fichier d\'état à commiter' };
  const git = (args: string[]): { ok: boolean; stdout: string; out: string } => {
    const r = spawnSync('git', args, { cwd: checkout, encoding: 'utf8', timeout: 120_000, env: { ...env, GIT_TERMINAL_PROMPT: '0' } });
    return { ok: r.status === 0, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`.trim() };
  };
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...candidates]);
  if (!status.ok) return { sha: null, files: [], refused: true, note: `état non commité : git status a échoué (${status.out.slice(0, 300)})` };
  // `XY path` entries separated by NUL: the state files are never renamed by the tool, the path follows the status.
  const changed = status.stdout.split('\0').filter(e => e.length > 3).map(e => e.slice(3)).filter(f => candidates.includes(f));
  if (!changed.length) return { sha: null, files: [], refused: false, note: 'état déjà commité, rien à faire' };
  if (!hasGitIdentity(checkout, env)) return { sha: null, files: [], refused: true, note: `état non commité : ${IDENTITY_HINT}` };
  const add = git(['add', '--', ...changed]);
  if (!add.ok) return { sha: null, files: [], refused: true, note: `état non commité : git add a échoué (${add.out.slice(0, 500)})` };
  // Paths given to `git commit`: only them, whatever else is staged (the other staged files stay staged).
  // The identity of the repository, never guessed from the host; the origin of the commit stays readable (trailer).
  const commit = git(['-c', 'user.useConfigOnly=true', 'commit', '-m', `chore(apv) : état de l'exécution ${specId} (${label})`, '-m', `Generated-by: apv run ${label === 'livraison' ? 'set' : 'save'}`, '--', ...changed]);
  if (!commit.ok) return { sha: null, files: [], refused: true, note: `état non commité : git commit a échoué (${commit.out.slice(0, 500)})` };
  const sha = gitRead(checkout, ['rev-parse', 'HEAD']);
  return { sha, files: changed, refused: false, note: `état commité sur ${current} : ${sha?.slice(0, 12) ?? '?'} (${changed.join(', ')})` };
}
