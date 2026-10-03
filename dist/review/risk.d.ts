/**
 * Risk level of a diff (`apv review plan`, `apv gates run --since`). Pilot project, 3 October 2026: a pull request of
 * tests and interface texts went through four reviews, a loop of corrections and two full suites of 30 minutes.
 *
 * The level is decided by the PATH of each changed file, never by reading its content as « text »: the reviews of
 * 3.0.0-alpha.15 bypassed such a reading nine ways (a block comment followed by code, SQL in a string, `#isAdmin`, a
 * line starting with `*`, `requireAuth: false` in a component, an HTML comment followed by `<img onerror>`, data
 * retention or hosting promises in a messages module).
 * - `faible`: every file is a test named as a test (`*.test.*`, `*.spec.*`, `*.e2e.*`) or under a `test/` or
 *   `tests/` folder, documentation (`*.md` outside the served folders, not a legal text) or a validated mockup; no term
 *   of data or GDPR and no real e-mail address in its changed lines;
 * - `eleve`: everything else, the plan then behaves exactly as in 3.0.0-alpha.14.
 * The level never removes the security review, which every plan keeps.
 */
/** Risk level of a diff. */
export type RiskLevel = 'faible' | 'eleve';
export declare const RISK_LEVELS: readonly RiskLevel[];
export declare const RISK_LABEL: Readonly<Record<RiskLevel, string>>;
/** A test file by its name: `x.test.ts`, `x.spec.js`, `x.e2e.ts`. */
export declare const TEST_NAME: RegExp;
/** A file under a test folder at any depth. */
export declare const TEST_DIRS: readonly ["**/test/**", "**/tests/**"];
/** Folders whose Markdown is served or compiled by the application, never documentation. */
export declare const SERVED_DIR: RegExp;
/**
 * Configuration of the tool, of the test runners, of lint and format, and the dependencies: always of high risk, and
 * stronger than the neutral classes (a configuration never counts as a test or a document), whatever `review.paths`
 * says. Not configurable: a project cannot make its own configuration of low risk.
 */
export declare const CONFIG_FILES: readonly [".apv/config.json", "pipeline.v2.json", "**/*.config.*", "**/*.conf", "**/.eslintrc*", "**/eslint.config.*", "**/.prettierrc*", "**/prettier.config.*", "**/package.json", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/tsconfig*.json", "**/.env*", "**/.npmrc", "**/.nvmrc", "**/.node-version", "**/Dockerfile*", "**/docker-compose*", ".github/**"];
/** A real e-mail address (not on a reserved domain) in the lines, or null. */
export declare function realAddress(lines: readonly string[]): string | null;
export interface DiffRisk {
    level: RiskLevel;
    /** One sentence: what makes the level, with the number of files of each reason. */
    reason: string;
    /** Files of a high risk, with their reason (50 at most), and how many in all. */
    files: {
        path: string;
        why: string;
    }[];
    fileCount: number;
}
/** The level of a diff from the risk of each of its files: high as soon as one file is. */
export declare function diffRisk(files: readonly {
    path: string;
    risk: RiskLevel;
    riskWhy: string;
}[], shown?: number): DiffRisk;
