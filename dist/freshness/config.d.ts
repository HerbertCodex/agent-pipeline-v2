import { type Infer } from '../domain/schema.js';
/**
 * Freshness of the living state and resume files (`apv status`, SessionStart hook): a file not rewritten for more
 * than `maxAgeDays` days, or longer than `maxLines` lines, is reported, never moved nor deleted.
 */
export declare const DEFAULT_FRESHNESS: {
    readonly maxAgeDays: 2;
    readonly maxLines: 300;
    readonly archive: ".apv/state/archive";
};
/** Living files watched in every project, whatever the configuration declares. */
export declare const DEFAULT_FRESHNESS_PATHS: readonly [".apv/state/resume.md", ".apv/state/*.md"];
/**
 * Default files left out: the grouped follow-up of minor findings (`.apv/state/suivi-constats.md`, compétence review)
 * is processed by batch, its age says nothing about the freshness of the resume state.
 */
export declare const DEFAULT_FRESHNESS_IGNORE: readonly [".apv/state/suivi-constats.md"];
export declare const freshnessSchema: import("../domain/schema.js").Schema<{
    readonly maxAgeDays: number;
    readonly maxLines: number;
    readonly paths: string[];
    readonly ignore: string[];
    readonly archive: string | undefined;
}>;
export type FreshnessSettings = Infer<typeof freshnessSchema>;
/** Where a pattern starts: the repository, the home folder (`~/`) or the file system root (absolute). */
export type PatternRoot = 'repo' | 'home' | 'root';
export interface SplitPattern {
    root: PatternRoot;
    rest: string;
}
/**
 * Splits a watched path or glob into its root and a portable relative glob (`*`, `**`, `?`; the syntax of
 * allowedPaths). Refused: `..`, `.` and empty segments, braces, a leading `!`, a backslash, a bare `~`.
 */
export declare function splitPattern(pattern: string, field: string): SplitPattern;
/** The archive folder proposed in the messages: a plain path (no wildcard), relative, `~/` or absolute. */
export declare function splitArchive(archive: string): SplitPattern;
/** Every problem of a `freshness` section once its schema passed: the patterns and the archive folder. */
export declare function freshnessIssues(settings: FreshnessSettings): string[];
