/** The project directory of APV3: configuration, ledger, specs and state, versioned with the project. */
export declare const APV_DIR = ".apv";
/**
 * Machine files under `.apv/` that are never versioned: journals of the tool and of the hooks
 * (`state/quota.log`, `state/journal.log`), gate receipts, and the task marker of an implementer
 * worktree. Resume notes (`state/resume.md`) and plans stay versioned. The Stop hook of the plugin
 * writes the same lines (hooks/scripts/lib.mjs); a test keeps both lists equal.
 */
export declare const APV_IGNORED: readonly ["state/*.log", "state/task.json", "receipts/"];
/**
 * Creates `.apv/.gitignore`, or appends the ignored lines it lacks. Owned by the writers of the state
 * journals, `apv quota` and the Stop hook: whoever writes a journal makes sure it stays out of commits.
 * `apv gates run` does not call it: a gate may check that the tree is clean, and its receipts ignore
 * themselves (`receipts/.gitignore`). Lines the project added are kept. Returns true when it wrote.
 */
export declare function ensureApvGitignore(repo: string): boolean;
