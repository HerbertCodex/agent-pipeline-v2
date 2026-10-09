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
/** Routing folders of the frameworks: what lies under them is served, never a test nor a neutral file. */
export const ROUTING_DIR = /(?:^|\/)(?:routes|pages|app)\//;
/** A test folder under a routing folder (`src/routes/tests/+page.svelte`): a route, never a test. */
export const ROUTING_TEST_DIR = /(?:^|\/)(?:routes|pages|app)\/(?:.*\/)?tests?\//;
/**
 * The instructions of the agents (the plugin's own and the project's): what they say changes what the agents do. Of
 * high risk, like the sensitive paths of the high lane, whatever the classes say. The lane without code compares them
 * without case (`docs/claude.md`, `Start-Here.md`): a file system that ignores the case reads them all the same.
 */
export const AGENT_INSTRUCTIONS = [
    'agents/**', 'workflows/**', 'skills/**', 'hooks/**', 'commands/**', 'output-styles/**', '**/SKILL.md', '.apv/brief.md',
    '**/CLAUDE.md', '**/CLAUDE.local.md', '**/AGENTS.md', '**/GEMINI.md', 'START-HERE.md', 'docs/REGLES.md',
    '.claude/**', '.agents/**', '.cursor/**',
];
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
 * Notes of the pipeline (`notes de pilotage`): the state of the runs, the journal and the specs, in text or JSON. Never a
 * configuration, whatever their extension says: no domain of their own, their words not read (pilot project, 8 October
 * 2026: « phone », « e-mail », « supprim » in the prose of a journal kept the data and GDPR reviews). The security review
 * reads them: the session hook injects `.apv/state/` into every session. A real e-mail address in them still counts.
 */
export const PILOT_NOTES = ['.apv/state/**', '.apv/journal-pipeline.md', '.apv/specs/**'];
/**
 * The registry of the decisions (`.apv/DECISIONS.json` and its Markdown rendering): a class of its own, neither a
 * configuration nor a note of the pipeline (pilot project, 9 October 2026: a pull request adding one decision kept
 * every review as a « configuration »). The security review always reads it (a decision sets requirements); data and
 * GDPR only on their terms, never by prudence for the sole reason that it is the registry. A real e-mail address counts.
 */
export const LEDGER_FILES = ['.apv/DECISIONS.json', '.apv/DECISIONS.md'];
/** The specs: a note of the pipeline only when added; a spec of the base modified keeps the classification of alpha.20. */
export const SPEC_NOTES = '.apv/specs/**';
export const PILOT_NOTE_EXTENSIONS = /\.(?:md|json|jsonl|log|txt)$/;
/**
 * Lockfiles of npm, pnpm and Yarn: changed without their `package.json`, the dependencies move inside the ranges already
 * reviewed. The security review alone, with the audit of the dependencies (pilot project, 8 October 2026: two tools of
 * development updated in a lockfile were read by the four reviews, captures included).
 */
export const LOCK_FILES = ['**/package-lock.json', '**/npm-shrinkwrap.json', '**/pnpm-lock.yaml', '**/yarn.lock'];
export const MANIFEST_FILES = ['**/package.json'];
/**
 * E-mail domains reserved for examples and tests (RFC 2606, RFC 6761, and `exemple.fr` for the French texts of the
 * projects): an address there is not a real person. Any other address in a changed line keeps the GDPR review (a
 * fixture with a real address is personal data).
 */
const RESERVED_MAIL = /@(?:[\w-]+\.)*(?:example\.(?:com|org|net)|exemple\.fr|example|test|invalid|localhost)$/i;
const MAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
/** Extensions of images that follow an `@` in a file name (`logo@2x.png`): a density suffix, never a domain. */
const IMAGE_EXTENSIONS = /^(?:png|jpe?g|gif|webp|avif|svg|ico)$/i;
/**
 * Whether the part after the `@` can be an Internet domain: a name with a version (`supabase@2.117.0`,
 * `@scope/nom@1.2.3-rc`, `nom@x.y.z`) or a file name (`logo@2x.png`) is not. A domain ends with a top-level domain of
 * letters (two at least, or the `xn--` form) and does not start with a number alone.
 */
function domainLike(host) {
    const labels = host.split('.');
    const tld = labels.at(-1);
    if (/^\d+$/.test(labels[0]) || IMAGE_EXTENSIONS.test(tld) && /^\d+x$/i.test(labels[0]))
        return false;
    return /^\p{L}{2,}$/u.test(tld) || /^xn--[a-z0-9-]+$/i.test(tld);
}
/** A real e-mail address (not on a reserved domain, not a package with a version) in the lines, or null. */
export function realAddress(lines) {
    for (const line of lines)
        for (const m of line.matchAll(MAIL))
            if (!RESERVED_MAIL.test(m[0]) && domainLike(m[0].slice(m[0].lastIndexOf('@') + 1)))
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