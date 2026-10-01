import { type DesignAttributeResult } from './attributes.js';
/** A validated mockup to move into the folder of its group. */
export interface OrganizeMove {
    slug: string;
    decisionId: string;
    from: string;
    to: string;
    /** Group folder relative to `design.dir`, null for its root. */
    group: string | null;
    sha256: string;
    /** Followed by Git: moved by `git mv`; otherwise a plain move. */
    tracked: boolean;
}
/** A mockup out of its group that cannot be moved: nothing is moved while one is listed. */
export interface OrganizeBlock {
    slug: string;
    decisionId: string;
    file: string;
    to: string;
    reason: string;
}
/** Files of the repository that still name an old path (the moved decisions excepted). */
export interface OrganizeReference {
    path: string;
    files: string[];
}
export interface OrganizeResult {
    repo: string;
    dryRun: boolean;
    /** True when the moves and the ledger rewrite were done. */
    applied: boolean;
    moves: OrganizeMove[];
    blocked: OrganizeBlock[];
    /** Decisions without file nor hash (written before `apv design register`): never moved. */
    legacy: string[];
    ledgerFile: string | null;
    ledgerMarkdown: string | null;
    references: OrganizeReference[];
    /** Paths to `git add` after a move (new paths and ledger), and the full pathspec of the commit (old paths too). */
    toAdd: string[];
    toCommit: string[];
    /** The `.gitattributes` line, read only: `organize` never writes it (`apv design register` or `apv init` does). */
    attributes: DesignAttributeResult;
}
/**
 * Moves every validated mockup (confirmed decision with file and hash) that is not in the folder of its group
 * (`mockupPlacement`) into it, by `git mv` when Git follows the file, and rewrites the file path in the value of
 * its decision, in place: the validated content does not change, so no new version of the decision is added. The
 * ledger (JSON and its Markdown view) is the only other file written. Only regular HTML files under `design.dir`
 * move, never through a symbolic link (source or target). All or nothing: a mockup out of `design.dir`, linked,
 * changed or missing since its validation, or a target that already exists, blocks every move; the ledger must be
 * committed; a failure on the way puts the files and the ledger back. Lists the
 * tracked files that still name an old path, without changing them. `dryRun` computes the plan and writes nothing.
 */
export declare function organizeMockups(repoPath: string, options?: {
    dryRun?: boolean;
}): Promise<OrganizeResult>;
