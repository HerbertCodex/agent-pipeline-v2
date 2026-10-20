/**
 * Whether a change calls for a web audit (`apv web audit --preview --base <ref>`, and its recomputation by
 * `apv gates verify`). Prudence first: the audit is required as soon as one changed file may affect the served site,
 * that is any file outside the explicit list of files without web effect (`web.neutralPaths`). The configuration,
 * the manifests and the lock files always count, and so do the files of `web.paths`, even inside that list: a
 * narrow list of « interface » globs would have left out server hooks, load functions, libraries and build settings.
 */
/** Variable naming the file where `apv web audit` writes its record for the receipt of the check that runs it (`apv gates run`). */
export declare const WEB_RECORD = "APV_WEB_RECORD";
/**
 * Always with a web effect, even inside `neutralPaths`: the audit configuration, the dependencies and their resolution,
 * the pages written as content under a source or served folder (`src/routes/blog/+page.md`, `src/content/post.md`), and
 * the HTML of `docs/` (a site published from it, GitHub Pages).
 */
export declare const ALWAYS_WEB_PATHS: readonly [".apv/config.json", "**/package.json", ...string[], "docs/**/*.html"];
export interface ImpactSettings {
    neutralPaths?: readonly string[] | undefined;
    paths?: readonly string[] | undefined;
}
export interface Impact {
    required: boolean;
    files: string[];
}
export declare function webImpact(changed: readonly string[], settings: ImpactSettings | undefined): Impact;
/** Files changed between two commits, renames counted at both paths. */
export declare function changedBetween(repo: string, from: string, to: string): string[] | null;
export type BaseOutcome = {
    ok: true;
    base: string;
    reference: string;
} | {
    ok: false;
    reason: 'missing' | 'no-merge-base' | 'not-behind';
    message: string;
};
/**
 * The merge base of `ref` and `head`, refused when `ref` does not resolve, when there is none, or when it is `head`
 * itself (`head` equal to or upstream of `ref`: nothing to compare, every change would be missed).
 */
export declare function auditBase(repo: string, ref: string, head: string): BaseOutcome;
/** Whether an argv runs `apv web audit` (`web` followed by `audit`), whatever its options. */
export declare function runsWebAudit(argv: readonly string[]): boolean;
/** `--base <ref>` of an `apv web audit --preview` command (argv of a check), or undefined when the command is not one. */
export declare function webAuditGate(argv: readonly string[]): {
    base: string | null;
} | undefined;
