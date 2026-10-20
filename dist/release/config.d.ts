import { type Infer } from '../domain/schema.js';
/**
 * Release decoupled from the merge (docs/CLI.md, « apv release »): PRs reach `from` on the proof of the task, the
 * production branch `branch` only moves by `apv release`, fast-forward, to a commit of `from` whose full suite is proven.
 */
export declare const releaseSchema: import("../domain/schema.js").Schema<{
    readonly branch: string;
    readonly from: string;
    readonly migrations: string[] | undefined;
}>;
export type ReleaseSettings = Infer<typeof releaseSchema>;
export declare function releaseIssues(release: ReleaseSettings): string[];
/** Whether a target of the rules (`origin/main`, `refs/remotes/origin/main`, `main`) names the branch `from`. */
export declare function targetsBranch(target: string, branch: string): boolean;
