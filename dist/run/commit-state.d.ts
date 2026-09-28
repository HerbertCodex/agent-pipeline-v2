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
export declare const stateFiles: (specId: string) => string[];
export declare function commitRunState(checkout: string, specId: string, branch: string, label: string): StateCommit;
