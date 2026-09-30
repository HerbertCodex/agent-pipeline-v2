import { type ReviewDomainName } from '../review/config.js';
import { type CaptureTheme, type CaptureViewport } from './config.js';
/**
 * Review records: what a reviewer agent found at one exact commit, kept in the Git common directory
 * (`<git common dir>/apv/reviews/<commit>/<domaine>/`), outside every worktree and never versioned, with a copy of its
 * report and of its captures under their sha256. `apv review record` writes them; the Bash guard of the plugin lets only
 * the reviewer agent of the domain run it (`apv:qa-securite` for securite...), never the implementer, the integrator nor
 * the lead, and refuses the commands and the writes that name this folder. `apv rules check` reads them before a merge.
 */
export declare const REVIEWS_DIR: readonly ["apv", "reviews"];
/** The reviewer agent of each domain of `apv review plan`: the only one whose record counts. */
export declare const DOMAIN_REVIEWERS: Readonly<Record<ReviewDomainName, string>>;
/** `apv:qa-securite` and `qa-securite` name the same agent. */
export declare const agentName: (value: string) => string;
export interface Findings {
    critical: number;
    high: number;
    medium: number;
    low: number;
}
export interface StoredFile {
    file: string;
    sha256: string;
    bytes: number;
}
export interface StoredCapture extends StoredFile {
    viewport: CaptureViewport;
    theme: CaptureTheme;
}
export interface ReviewRecord {
    version: 1;
    id: string;
    commit: string;
    domain: ReviewDomainName;
    reviewer: string;
    at: string;
    findings: Findings;
    report: StoredFile;
    captures: StoredCapture[];
}
export interface CaptureInput {
    viewport: CaptureViewport;
    theme: CaptureTheme;
    path: string;
}
export interface RecordInput {
    /** The checkout the reviewer read: its HEAD must be the commit, its tracked files unchanged. */
    checkout: string;
    commit: string;
    domain: string;
    reviewer: string;
    findings: Findings;
    report: string;
    captures: CaptureInput[];
    now?: Date;
}
/** Smallest capture accepted, in bytes: an empty or placeholder image proves nothing. */
export declare const MIN_CAPTURE_BYTES = 1024;
/** Smallest report accepted, in bytes. */
export declare const MIN_REPORT_BYTES = 200;
/** How many characters of the commit the report must cite. */
export declare const REPORT_SHA = 12;
/** The image format of a capture from its first bytes (PNG, JPEG, WebP), or null. */
export declare function imageFormat(data: Buffer): 'png' | 'jpg' | 'webp' | null;
export declare function reviewsDir(common: string, commit: string): string;
/** Parses `desktop:dark:chemin.png` (`--capture`). */
export declare function parseCapture(value: string): CaptureInput;
/**
 * Records a review at the exact commit the checkout holds. Refused when the checkout is elsewhere or modified, the
 * reviewer is not the agent of the domain, the report is too short or does not cite the commit, a capture is not an image
 * or the same image stands for two captures (several screens: several captures per width and theme, each its own image). The record is written even with critical or high findings: it is what the
 * reviewer saw, and `apv rules check` refuses the merge on it.
 */
export declare function recordReview(common: string, input: RecordInput): ReviewRecord;
export interface ReadRecord {
    record: ReviewRecord | null;
    file: string;
    problem: string | null;
}
/**
 * The latest record of each domain at `commit` (by date of record), each checked: its report and captures as recorded.
 * A record that does not match (another commit, another domain, a reviewer that is not the agent of the domain, a file
 * changed) is returned with its problem: it proves nothing.
 */
export declare function latestReviews(common: string, commit: string): Map<ReviewDomainName, ReadRecord>;
