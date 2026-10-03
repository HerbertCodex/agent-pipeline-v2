import { type FreshnessSettings, type SplitPattern } from './config.js';
/**
 * A name that looks like a secret holder (`.env*`, `*key*`, `*secret*`, `*token*`, credentials, passwords,
 * certificates): only its date is read, never a byte of its content (no line count).
 */
export declare function secretLike(path: string): boolean;
export interface FreshnessEntry {
    /** Shown path: relative to the repository, `~/...` under the home folder, absolute otherwise. */
    file: string;
    modifiedAt: string;
    /** Whole days since the last modification. */
    ageDays: number;
    /** Line count; null for a secret-like name (content never read) or an unreadable file. */
    lines: number | null;
    secret: boolean;
    stale: boolean;
    long: boolean;
}
export interface FreshnessReport {
    maxAgeDays: number;
    maxLines: number;
    /** Archive folder proposed in the messages (as configured, or the default). */
    archive: string;
    /** Existing files watched. */
    checked: number;
    /** Files not modified for more than `maxAgeDays` days, oldest first. */
    stale: FreshnessEntry[];
    /** Files longer than `maxLines` lines, longest first. */
    long: FreshnessEntry[];
}
export interface FreshnessOptions {
    home?: string;
    now?: Date;
}
/** Existing files matched by one pattern, bounded; a missing folder or file is simply nothing. */
export declare function expandPattern(pattern: SplitPattern, repo: string, home: string): string[];
/**
 * Freshness of the living files of a project: `.apv/state/resume.md`, the `.apv/state/*.md` files and the
 * `freshness.paths` of the configuration, minus `freshness.ignore` and the archive folder. Read-only: only the date
 * and the line count of each file are read (only the date for a secret-like name); a missing file is ignored.
 */
export declare function freshnessReport(repo: string, settings: FreshnessSettings | undefined, options?: FreshnessOptions): FreshnessReport;
/**
 * The report of a repository with its own configuration (`freshness`); an unreadable configuration falls back to the
 * defaults and says so in `configError`, so that the default living files are still watched.
 */
export declare function repoFreshness(repo: string, options?: FreshnessOptions): FreshnessReport & {
    configError: string | null;
};
/** Text lines of the section « Fichiers d'état périmés » of `apv status`; `clean` bounds each file name. */
export declare function freshnessLines(report: FreshnessReport, clean: (value: string) => string, time: (iso: string) => string): string[];
/** One line for the SessionStart hook, or null when every watched file is fresh and short. */
export declare function freshnessSummary(report: FreshnessReport, clean: (value: string) => string): string | null;
