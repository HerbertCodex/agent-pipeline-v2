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
export const RISK_LEVELS = ['faible', 'eleve'];
export const RISK_LABEL = { faible: 'faible', eleve: 'élevé' };
/** A test file by its name: `x.test.ts`, `x.spec.js`, `x.e2e.ts`. */
export const TEST_NAME = /(?:^|\/)[^/]+\.(?:test|spec|e2e)\.[^/]+$/;
/** A file under a test folder at any depth. */
export const TEST_DIRS = ['**/test/**', '**/tests/**'];
/** Folders whose Markdown is served or compiled by the application, never documentation. */
export const SERVED_DIR = /(?:^|\/)(?:src|static|public|content|app|pages)\//;
/**
 * Configuration of the tool, of the test runners, of lint and format, and the dependencies: always of high risk, and
 * stronger than the neutral classes (a configuration never counts as a test or a document), whatever `review.paths`
 * says. Not configurable: a project cannot make its own configuration of low risk.
 */
export const CONFIG_FILES = [
    '.apv/config.json', 'pipeline.v2.json', '**/*.config.*', '**/*.conf', '**/.eslintrc*', '**/eslint.config.*', '**/.prettierrc*',
    '**/prettier.config.*', '**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/tsconfig*.json',
    '**/.env*', '**/.npmrc', '**/.nvmrc', '**/.node-version', '**/Dockerfile*', '**/docker-compose*', '.github/**',
];
/**
 * E-mail domains reserved for examples and tests (RFC 2606, RFC 6761): an address there is not a real person. Any other
 * address in a changed line keeps the GDPR review (a fixture with a real address is personal data).
 */
const RESERVED_MAIL = /@(?:[\w-]+\.)*(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/i;
const MAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
/** A real e-mail address (not on a reserved domain) in the lines, or null. */
export function realAddress(lines) {
    for (const line of lines)
        for (const m of line.matchAll(MAIL))
            if (!RESERVED_MAIL.test(m[0]))
                return m[0];
    return null;
}
/** The level of a diff from the risk of each of its files: high as soon as one file is. */
export function diffRisk(files, shown = 50) {
    const high = files.filter(f => f.risk === 'eleve');
    const tally = (list) => {
        const whys = new Map();
        for (const f of list)
            whys.set(f.riskWhy, (whys.get(f.riskWhy) ?? 0) + 1);
        return [...whys].map(([why, n]) => `${why} (${n})`).join(' ; ');
    };
    if (!files.length)
        return { level: 'faible', reason: 'diff vide', files: [], fileCount: 0 };
    if (!high.length)
        return { level: 'faible', reason: `seulement ${tally(files)}`, files: [], fileCount: 0 };
    return { level: 'eleve', reason: tally(high), files: high.slice(0, shown).map(f => ({ path: f.path, why: f.riskWhy })), fileCount: high.length };
}
//# sourceMappingURL=risk.js.map