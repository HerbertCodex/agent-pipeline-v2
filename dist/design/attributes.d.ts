/** Root attributes file of the repository, where the validated-mockup line is written. */
export declare const GITATTRIBUTES = ".gitattributes";
/**
 * Line that keeps the validated mockups out of the whitespace checks (`git diff --check`, and the CI of the
 * projects that run it): a mockup is registered under its sha256, so its trailing spaces cannot be cleaned
 * without changing its fingerprint. `**` covers the root of the folder and its group sub-folders.
 */
export declare const designAttributeLine: (dir: string) => string;
/** Line written before the groups (3.0.0-alpha.11 and earlier): the root of the folder only. */
export declare const legacyDesignAttributeLine: (dir: string) => string;
export type DesignAttributeStatus = 'present' | 'missing' | 'added' | 'replaced' | 'ineffective';
export interface DesignAttributeResult {
    file: string;
    line: string;
    status: DesignAttributeStatus;
    /**
     * The root-only line found in `.gitattributes` while groups exist: insufficient (state `missing`), or
     * replaced by the line that covers the sub-folders (`replaced`, and `ineffective` after a replacement).
     */
    previous?: string;
}
/**
 * Whether Git sees the `whitespace` attribute unset for a mockup of `dir` and of each of its group
 * sub-folders `groups` (relative to `dir`).
 */
export declare function designWhitespaceUnset(repo: string, dir: string, groups?: readonly string[]): boolean;
/** State of the line for `dir` and its groups, without writing anything. */
export declare function designAttributeState(repo: string, dir: string, groups?: readonly string[]): DesignAttributeResult;
/**
 * Makes Git unset `whitespace` for the mockups of `dir` and of its group sub-folders: nothing when it already does;
 * otherwise the root-only line of an earlier version is replaced in place by the line that covers the sub-folders
 * (`replaced`), or the line is appended to the root `.gitattributes` (`added`; the file is created when absent, its
 * content kept otherwise). `dryRun` reports the change without writing. After writing, Git is asked again:
 * `ineffective` when another attributes file still overrides the line.
 */
export declare function ensureDesignAttribute(repo: string, dir: string, dryRun?: boolean, groups?: readonly string[]): DesignAttributeResult;
/** Trailing whitespace or blank lines at the end of a file: what `git diff --check` reports. */
export declare function hasWhitespaceErrors(path: string): boolean;
