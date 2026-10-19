import { s, type Infer } from '../domain/schema.js';

const branchName = s.string(1, 200, /^(?!refs\/)(?!-)(?!.*\.\.)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._\/-]+$/);

/**
 * Release decoupled from the merge (docs/CLI.md, « apv release »): PRs reach `from` on the proof of the task, the
 * production branch `branch` only moves by `apv release`, fast-forward, to a commit of `from` whose full suite is proven.
 */
export const releaseSchema = s.object({ branch: branchName, from: branchName });
export type ReleaseSettings = Infer<typeof releaseSchema>;

export function releaseIssues(release: ReleaseSettings): string[] {
  return release.branch === release.from ? [`release.branch and release.from must differ (${release.branch})`] : [];
}

/** Whether a target of the rules (`origin/main`, `refs/remotes/origin/main`, `main`) names the branch `from`. */
export function targetsBranch(target: string, branch: string): boolean {
  return [branch, `origin/${branch}`, `refs/remotes/origin/${branch}`, `refs/heads/${branch}`].includes(target);
}
