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
/** Routing folders of the frameworks: what lies under them is served, never a test nor a neutral file. */
export declare const ROUTING_DIR: RegExp;
/** A test folder under a routing folder (`src/routes/tests/+page.svelte`): a route, never a test. */
export declare const ROUTING_TEST_DIR: RegExp;
/**
 * The instructions of the agents (the plugin's own and the project's): what they say changes what the agents do. Of
 * high risk, like the sensitive paths of the high lane, whatever the classes say. The lane without code compares them
 * without case (`docs/claude.md`, `Start-Here.md`): a file system that ignores the case reads them all the same.
 */
export declare const AGENT_INSTRUCTIONS: readonly ["agents/**", "workflows/**", "skills/**", "hooks/**", "commands/**", "output-styles/**", "**/SKILL.md", ".apv/brief.md", "**/CLAUDE.md", "**/CLAUDE.local.md", "**/AGENTS.md", "**/GEMINI.md", "START-HERE.md", "docs/REGLES.md", ".claude/**", ".agents/**", ".cursor/**"];
/** Folders whose Markdown is served or compiled by the application, never documentation. */
export declare const SERVED_DIR: RegExp;
/**
 * Configuration of the tool, of the test runners, of lint and format, and the dependencies: always of high risk, and
 * stronger than the neutral classes (a configuration never counts as a test or a document), whatever `review.paths`
 * says. Not configurable: a project cannot make its own configuration of low risk.
 */
export declare const CONFIG_FILES: readonly [".apv/config.json", "pipeline.v2.json", "**/*.config.*", "**/*.conf", "**/.eslintrc*", "**/eslint.config.*", "**/.prettierrc*", "**/prettier.config.*", "**/package.json", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/tsconfig*.json", "**/.env*", "**/.npmrc", "**/.nvmrc", "**/.node-version", "**/Dockerfile*", "**/docker-compose*", ".github/**"];
/**
 * Notes of the pipeline (`notes de pilotage`): the state of the runs, the journal and the specs, in text or JSON. Never a
 * configuration, whatever their extension says: no domain of their own, their words not read (pilot project, 8 October
 * 2026: « phone », « e-mail », « supprim » in the prose of a journal kept the data and GDPR reviews). The security review
 * reads them: the session hook injects `.apv/state/` into every session. A real e-mail address in them still counts.
 */
export declare const PILOT_NOTES: readonly [".apv/state/**", ".apv/journal-pipeline.md", ".apv/specs/**"];
/** The specs: a note of the pipeline only when added; a spec of the base modified keeps the classification of alpha.20. */
export declare const SPEC_NOTES = ".apv/specs/**";
export declare const PILOT_NOTE_EXTENSIONS: RegExp;
/**
 * Lockfiles of npm, pnpm and Yarn: changed without their `package.json`, the dependencies move inside the ranges already
 * reviewed. The security review alone, with the audit of the dependencies (pilot project, 8 October 2026: two tools of
 * development updated in a lockfile were read by the four reviews, captures included).
 */
export declare const LOCK_FILES: readonly ["**/package-lock.json", "**/npm-shrinkwrap.json", "**/pnpm-lock.yaml", "**/yarn.lock"];
export declare const MANIFEST_FILES: readonly ["**/package.json"];
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
