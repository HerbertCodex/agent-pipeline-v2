import { type FreshnessSettings, type SplitPattern } from './config.js';
/**
 * A path that looks like a secret holder: a name `.env*`, `id_*` (SSH keys), `*key*`, `*secret*`, `*token*`,
 * credentials or passwords, a known credential file (`.npmrc`, `.netrc`, `.pgpass`, `.git-credentials`, `hosts.yml`...),
 * a certificate or a password database (`.pem`, `.p12`, `.pfx`, `.kdbx`...), or anything under `.ssh/`, `.gnupg/`,
 * `.aws/`... Only its date is read, never a byte of its content (no line count).
 */
export declare function secretLike(path: string): boolean;
export interface FreshnessEntry {
    /** Shown path: relative to the repository, `~/...` under the home folder, absolute otherwise. */
    file: string;
    /** True for a file outside the repository: the SessionStart hook counts it without naming it. */
    external: boolean;
    modifiedAt: string;
    /** Whole days since the last modification. */
    ageDays: number;
    /** Size in bytes (from the file system, the content is not read for it). */
    bytes: number;
    /**
     * Exact line count when the file has at most `maxLines` lines; null when it has more (the count stops at
     * `maxLines` + 1, or is not made above `maxLines` × 4 KiB), for a secret-like path (never opened) or an unreadable file.
     */
    lines: number | null;
    secret: boolean;
    stale: boolean;
    /** More than `maxLines` lines. */
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
    /** Files longer than `maxLines` lines, biggest first. */
    long: FreshnessEntry[];
}
export interface FreshnessOptions {
    home?: string;
    now?: Date;
}
/**
 * Existing files matched by one pattern, bounded: the folder entries are read one by one (never a whole folder
 * loaded before the bound) and folder links are never followed. A missing folder or file is simply nothing.
 */
export declare function expandPattern(pattern: SplitPattern, repo: string, home: string): string[];
/**
 * Freshness of the living files of a project: `.apv/state/resume.md`, the `.apv/state/*.md` files and the
 * `freshness.paths` of the configuration, minus `freshness.ignore`, the default exclusions and the archive folder.
 * Read-only: only the date, the size and a bounded line count of each file are read (only the date for a secret-like
 * path, judged on the name and on the real target); a missing file is ignored; a link whose target leaves the folder
 * of its pattern (the repository for the default patterns) is never followed.
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
/**
 * One line for the SessionStart hook, or null when every watched file is fresh and short. Files outside the repository
 * are counted, never named: their names would enter the context of every session.
 */
export declare function freshnessSummary(report: FreshnessReport, clean: (value: string) => string): string | null;
