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
/** The refusal when Git has no identity for a commit here (user.name and user.email, or GIT_AUTHOR_* and GIT_COMMITTER_*). */
export declare const IDENTITY_HINT = "identit\u00E9 Git absente : git config user.name \"Votre Nom\" && git config user.email \"vous@exemple.fr\" (--global pour tous les d\u00E9p\u00F4ts), ou GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME et GIT_COMMITTER_EMAIL dans l'environnement";
/** Whether Git has an identity for a commit in `cwd`, never guessed from the host (`user.useConfigOnly`). */
export declare function hasGitIdentity(cwd: string, env: NodeJS.ProcessEnv): boolean;
export declare function commitRunState(checkout: string, specId: string, branch: string, label: string, env?: NodeJS.ProcessEnv): StateCommit;
