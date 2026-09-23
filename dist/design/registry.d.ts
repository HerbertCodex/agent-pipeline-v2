export { DEFAULT_DESIGN_DIR } from './config.js';
/** Lowercase words joined by single dashes; short enough for the decision id (80 characters at most). */
export declare const SLUG_PATTERN: RegExp;
export interface DesignConfig {
    dir: string;
    configFile: string | null;
}
/**
 * `design.dir` of the project configuration, read by the main loader (`.apv/config.json`, else
 * `pipeline.v2.json`): the folder must stay inside the repository.
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
    sourceQuote: string;
}
/** Validated mockups of the working-tree ledger, in ledger order. */
export declare function listMockups(repo: string): RegisteredMockup[];
export interface RegisterInput {
    file: string;
    slug: string;
    quote: string;
    title?: string;
    screens?: string[];
    artifact?: string;
    reviewer?: string;
    /** Injected clock, for tests. */
    now?: Date;
}
export interface RegisterResult {
    repo: string;
    slug: string;
    decisionId: string;
    supersedes: string[];
    target: string;
    sha256: string;
    ledgerFile: string;
    ledgerMarkdown: string;
    /** True when the same content was already registered: nothing was written. */
    unchanged: boolean;
}
export declare function validateSlug(slug: string): void;
/**
 * Registers an operator-validated mockup: copies it to `<design.dir>/<slug>-validee.html`, and records a
 * confirmed operator decision carrying the file path, its sha256 and the operator's exact words. The
 * ledger is changed through the reviewed ledger-update API (never in place): a re-registration adds
 * `maquette-<slug>-validee-v<n>` that supersedes the active one. Nothing is committed.
 */
export declare function registerMockup(repoPath: string, input: RegisterInput): Promise<RegisterResult>;
/** Normalized screen name, for `list --screen`: case, accents and separators ignored. */
export declare function screenKey(name: string): string;
export declare function matchesScreen(mockup: RegisteredMockup, screen: string): boolean;
