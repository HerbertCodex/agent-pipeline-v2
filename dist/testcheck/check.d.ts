import { type Infer } from '../domain/schema.js';
/**
 * `apv tests check`: deterministic checks of the test files a change adds or modifies, run as a check of the task
 * stage. Pilot project, 3 October 2026: the same findings came back review after review on a pull request of tests (a
 * fixed wait in a browser test, a delay tested on the real clock), each costing a round of corrections and a new
 * review. What a tool can see in the changed lines, it says before the review:
 * - `waitForTimeout`: `page.waitForTimeout(` (Playwright) added to a browser test: error by default;
 * - `fixedWait`: any other wait on a duration added to a browser test (`sleep(`, `delay(`, `await setTimeout(`,
 *   `new Promise(r => setTimeout(r, …))`): warning by default;
 * - `realClock`: a unit test that tests a delay on the real clock (`setTimeout(` and `Date.now()` or
 *   `performance.now()` in the same file, one of them in a changed line, no fake timers): warning by default;
 * - `sharedData`: an e-mail address written in a changed line of a browser test and also written in another browser
 *   test of the project (two tests that may change the same account): warning by default.
 * The waits are those of `repeatChanged.fixedWaits` (src/gates/repeat.ts), here on every changed test file, at the task
 * stage, whatever the checks declare. Only the lines the change adds count: what existed is never reported.
 */
export declare const TEST_CHECK_RULES: readonly ["waitForTimeout", "fixedWait", "realClock", "sharedData"];
export type TestCheckRule = typeof TEST_CHECK_RULES[number];
export declare const TEST_CHECK_SEVERITIES: readonly ["off", "warning", "error"];
export type TestCheckSeverity = typeof TEST_CHECK_SEVERITIES[number];
export declare const DEFAULT_TEST_CHECK_SEVERITY: Readonly<Record<TestCheckRule, TestCheckSeverity>>;
/** Browser tests (Playwright, Cypress and the usual folders). */
export declare const DEFAULT_E2E_PATHS: readonly ["**/e2e/**", "**/*.e2e.*", "**/playwright/**", "**/cypress/**", "tests/**/*.spec.*", "**/*.pw.*"];
/** Unit tests: test files that are not browser tests. */
export declare const DEFAULT_UNIT_PATHS: readonly ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "test/**", "tests/**"];
export declare const testsCheckSchema: import("../domain/schema.js").Schema<{
    readonly enabled: boolean | undefined;
    readonly reference: string | undefined;
    readonly e2e: string[] | undefined;
    readonly unit: string[] | undefined;
    readonly ignore: string[] | undefined;
    readonly severity: {
        readonly waitForTimeout: "off" | "warning" | "error" | undefined;
        readonly fixedWait: "off" | "warning" | "error" | undefined;
        readonly realClock: "off" | "warning" | "error" | undefined;
        readonly sharedData: "off" | "warning" | "error" | undefined;
    } | undefined;
}>;
export type TestsCheckConfig = Infer<typeof testsCheckSchema>;
export interface TestFinding {
    rule: TestCheckRule;
    severity: Exclude<TestCheckSeverity, 'off'>;
    file: string;
    line: number;
    text: string;
    message: string;
}
export interface TestCheckReport {
    tool: 'apv tests check';
    enabled: boolean;
    base: {
        ref: string | null;
        mergeBase: string | null;
    };
    files: {
        e2e: string[];
        unit: string[];
    };
    severity: Record<TestCheckRule, TestCheckSeverity>;
    findings: TestFinding[];
    ok: boolean;
}
export declare function testsCheckSeverity(config: TestsCheckConfig | undefined): Record<TestCheckRule, TestCheckSeverity>;
export declare function checkTests(repo: string, config: TestsCheckConfig | undefined, options: {
    base?: string;
}): TestCheckReport;
