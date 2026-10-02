import { type DesignSettings } from './config.js';
import { type DesignAttributeResult } from './attributes.js';
export { DEFAULT_DESIGN_DIR } from './config.js';
/** Lowercase words joined by single dashes; short enough for the decision id (80 characters at most). */
export declare const SLUG_PATTERN: RegExp;
export interface DesignConfig extends DesignSettings {
    configFile: string | null;
}
/**
 * `design` section of the project configuration, read by the main loader (`.apv/config.json`, else
 * `pipeline.v2.json`): the folder must stay inside the repository, the groups inside the folder.
 */
export declare function loadDesignConfig(repo: string): DesignConfig;
export declare function sha256File(path: string): string;
export type MockupState = 'ok' | 'drift' | 'missing' | 'legacy';
export interface RegisteredMockup {
    slug: string;
    decisionId: string;
    version: number;
    subject: string;
    /** Repository-relative path, or null for a decision written before `apv design register` (no hash). */
    file: string | null;
    sha256: string | null;
    /** Hash of the file on disk, null when absent or unknown. */
    actualSha256: string | null;
    state: MockupState;
    screens: string[];
    artifact: string | null;
    /** Group chosen explicitly (`register --group`), recorded in the decision; null when the patterns decide. */
    recordedGroup: string | null;
    sourceQuote: string;
}
/**
 * The value of a mockup decision with its file path `from` replaced by `to` (the sha256 and every other word kept):
 * the decision of a mockup moved by `apv design organize`. Throws when the value does not carry `from`.
 */
export declare function relocatedValue(value: string, from: string, to: string): string;
/** Validated mockups of the ledger as a commit has it (the base of a change), checked against the files on disk. */
export declare function listMockupsAt(repo: string, sha: string): Promise<RegisteredMockup[]>;
/** Validated mockups of the working-tree ledger, in ledger order. */
export declare function listMockups(repo: string): RegisteredMockup[];
/** Where a validated mockup belongs: its group and the folder of that group. */
export interface MockupPlacement {
    /** Group folder relative to `design.dir`, null for the root of `design.dir`. */
    group: string | null;
    /** Repository-relative folder the file belongs in (`<design.dir>/<group>`). */
    folder: string;
    /** Whether the file is directly in that folder; null for a decision without file (no hash). */
    placed: boolean | null;
}
/**
 * Group of a validated mockup: the group recorded by `register --group` while it is still declared, otherwise the
 * first group whose patterns match its name, otherwise `design.defaultGroup`, otherwise the root of `design.dir`.
 */
export declare function mockupPlacement(settings: DesignSettings, mockup: Pick<RegisteredMockup, 'slug' | 'file' | 'recordedGroup'>): MockupPlacement;
export interface RegisterInput {
    file: string;
    slug: string;
    quote: string;
    title?: string;
    screens?: string[];
    artifact?: string;
    reviewer?: string;
    /**
     * Paths the mockup concerns (portable globs): scope of the decision, so that only the specs whose tasks may
     * change these paths must cover it. Absent: the scope of the active registration, if any, is kept.
     */
    scopePaths?: string[];
    /**
     * Group folder (`design.groups[].dir` or `design.defaultGroup`) chosen explicitly: recorded in the decision, so
     * that the next registrations and `apv design organize` keep it. Absent: the group of the active registration is
     * kept (recorded group, or the folder its file is in), else the patterns decide.
     */
    group?: string;
    /** Injected clock, for tests. */
    now?: Date;
}
export interface RegisterResult {
    repo: string;
    slug: string;
    decisionId: string;
    supersedes: string[];
    target: string;
    /** Group folder of the target (relative to `design.dir`), null for the root of `design.dir`. */
    group: string | null;
    /** File of the active registration when the new one is elsewhere: it is left in place, to remove if unused. */
    previousFile: string | null;
    sha256: string;
    ledgerFile: string;
    ledgerMarkdown: string;
    /** True when the same content was already registered: nothing was written to the mockup or the ledger. */
    unchanged: boolean;
    /** Line of `.gitattributes` that keeps the validated mockups out of `git diff --check`, added when missing. */
    attributes: DesignAttributeResult;
}
export declare function validateSlug(slug: string): void;
/**
 * Registers an operator-validated mockup: copies it to `<design.dir>/<group>/<slug>-validee.html` (group: see
 * `chooseGroup`; none without `design.groups`), and records a
 * confirmed operator decision carrying the file path, its sha256 and the operator's exact words. The
 * ledger is changed through the reviewed ledger-update API (never in place): a re-registration adds
 * `maquette-<slug>-validee-v<n>` that supersedes the active one. Nothing is committed.
 */
export declare function registerMockup(repoPath: string, input: RegisterInput): Promise<RegisterResult>;
/** Normalized screen name, for `list --screen`: case, accents and separators ignored. */
export declare function screenKey(name: string): string;
export declare function matchesScreen(mockup: RegisteredMockup, screen: string): boolean;
