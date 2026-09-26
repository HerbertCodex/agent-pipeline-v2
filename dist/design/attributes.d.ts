/** Root attributes file of the repository, where the validated-mockup line is written. */
export declare const GITATTRIBUTES = ".gitattributes";
/**
 * Line that keeps the validated mockups out of the whitespace checks (`git diff --check`, and the CI of the
 * projects that run it): a mockup is registered under its sha256, so its trailing spaces cannot be cleaned
 * without changing its fingerprint.
 */
export declare const designAttributeLine: (dir: string) => string;
export type DesignAttributeStatus = 'present' | 'missing' | 'added' | 'ineffective';
export interface DesignAttributeResult {
    file: string;
    line: string;
    status: DesignAttributeStatus;
}
/** Whether Git sees the `whitespace` attribute unset for a mockup of `dir` (any matching line counts). */
export declare function designWhitespaceUnset(repo: string, dir: string): boolean;
/** State of the line for `dir`, without writing anything. */
export declare function designAttributeState(repo: string, dir: string): DesignAttributeResult;
/**
 * Adds the line to the root `.gitattributes` when Git does not already unset `whitespace` for the mockups of `dir`
 * (the file is created when absent, its content kept otherwise). `dryRun` reports `added` without writing. After
 * writing, Git is asked again: `ineffective` when another attributes file still overrides the line.
 */
export declare function ensureDesignAttribute(repo: string, dir: string, dryRun?: boolean): DesignAttributeResult;
/** Trailing whitespace or blank lines at the end of a file: what `git diff --check` reports. */
export declare function hasWhitespaceErrors(path: string): boolean;
