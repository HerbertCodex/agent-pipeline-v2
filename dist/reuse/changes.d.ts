import { Git } from '../execution/git.js';
/** Where the base of the comparison comes from: `--base`, the configured reference, or none (everything counts as new). */
export type BaseSource = 'option' | 'reference' | 'none';
export interface ChangeBase {
    source: BaseSource;
    /** The ref as given (`origin/main`), or null without base. */
    ref: string | null;
    /** Merge base of the ref and HEAD: what the change adds is counted from it. */
    mergeBase: string | null;
}
/**
 * What the working tree changes since the merge base: the lines it adds or modifies per file, the files it creates
 * (added, or untracked and not ignored; a renamed file is not new) and the renames. Without base, `all` is true:
 * every line of every file counts as added (a project without history, or a check run without reference).
 */
export interface Changes {
    base: ChangeBase;
    /** Files of the working tree (tracked ones present, untracked ones not ignored), sorted. */
    files: string[];
    all: boolean;
    added: Map<string, Set<number>>;
    created: Set<string>;
    /** New path -> path at the merge base. */
    renamed: Map<string, string>;
}
/** Content of a working tree file, or null when it is unreadable, binary-looking or larger than 2 MB. */
export declare function readWorktree(repo: string, path: string): string | null;
/** The line is added or modified by the change (always true without base, and in a created file). */
export declare function isAdded(changes: Changes, path: string, line: number): boolean;
/** Resolves the base of the comparison: `--base` (any commit-ish), else the configured reference (full ref), else none. */
export declare function resolveBase(repo: string, option: string | undefined, reference: string | null): {
    source: BaseSource;
    ref: string | null;
    sha: string | null;
};
/** Added lines per file from a `git diff -U0` output. */
export declare function parseAddedLines(diff: string): Map<string, Set<number>>;
/** Changes of the working tree since the merge base of `baseSha` and HEAD. */
export declare function collectChanges(repo: string, base: {
    source: BaseSource;
    ref: string | null;
    sha: string | null;
}, git?: Git): Promise<Changes>;
/** Content of a file at the merge base (following a rename), or null when it did not exist there. */
export declare function readAtBase(repo: string, changes: Changes, path: string, read: (repo: string, spec: string) => string | null): string | null;
