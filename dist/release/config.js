import { s } from '../domain/schema.js';
const branchName = s.string(1, 200, /^(?!refs\/)(?!-)(?!.*\.\.)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._\/-]+$/);
/**
 * Release decoupled from the merge (docs/CLI.md, « apv release »): PRs reach `from` on the proof of the task, the
 * production branch `branch` only moves by `apv release`, fast-forward, to a commit of `from` whose full suite is proven.
 */
export const releaseSchema = s.object({
    branch: branchName, from: branchName,
    /** Patterns of the migration files (`supabase/migrations/*.sql`): an added one waits for « migration <version> appliquée » typed by the operator. */
    migrations: s.optional(s.array(s.string(1, 500), 0, 100)),
});
export function releaseIssues(release) {
    return release.branch === release.from ? [`release.branch and release.from must differ (${release.branch})`] : [];
}
/** Whether a target of the rules (`origin/main`, `refs/remotes/origin/main`, `main`) names the branch `from`. */
export function targetsBranch(target, branch) {
    return [branch, `origin/${branch}`, `refs/remotes/origin/${branch}`, `refs/heads/${branch}`].includes(target);
}
//# sourceMappingURL=config.js.map