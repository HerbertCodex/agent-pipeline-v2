import { s } from '../domain/schema.js';
/**
 * Settings of `apv review plan` in the `review` section of `.apv/config.json` (docs/CONFIGURATION.md, « Revues »):
 * which paths hold the interface, the data, the personal data, the legal texts, what is neutral (tests,
 * documentation), which words in the changed lines keep a domain, and which domains the project always wants.
 * Each key given replaces its default list; absent keys keep the defaults below.
 */
/** The default review domains of `/apv:review` (same list as `REVIEWS` of the run state). */
export const REVIEW_DOMAINS = ['securite', 'fidelite', 'donnees', 'rgpd'];
/** The review that no diff, no configuration and no option ever skips. */
export const ALWAYS_REVIEWED = 'securite';
/**
 * Path classes of a changed file. `neutral` (tests, documentation) and `tooling` (mocks, fixtures, test helpers) keep
 * no domain of their own, count only for a file that matches no domain class, and their changed lines are still read
 * for the terms of data and GDPR. `server` (server code, configuration), a sensitive path of the high lane and a
 * configuration file (src/review/risk.ts, CONFIG_FILES) are stronger: such a file keeps every domain, unless it is
 * named as a test (the configuration, never).
 */
export const PATH_CLASSES = ['ui', 'data', 'migrations', 'personal', 'legal', 'neutral', 'tooling', 'server'];
/** Generic defaults, for any stack: a project with other conventions declares its own lists. */
export const DEFAULT_REVIEW_PATHS = {
    ui: [
        '**/*.svelte', '**/*.vue', '**/*.jsx', '**/*.tsx', '**/*.astro', '**/*.html', '**/*.htm',
        '**/*.css', '**/*.scss', '**/*.sass', '**/*.less', '**/*.styl',
        '**/*.hbs', '**/*.handlebars', '**/*.ejs', '**/*.njk', '**/*.liquid', '**/*.erb', '**/*.twig', '**/*.jinja', '**/*.jinja2',
        '**/components/**', '**/templates/**', '**/layouts/**', '**/styles/**', '**/assets/**', '**/locales/**', '**/i18n/**',
        'static/**', 'public/**',
    ],
    data: [
        '**/repositories/**', '**/repository/**', '**/*repository*.*', '**/*Repository*.*', '**/queries/**', '**/*queries*.*',
        '**/db/**', '**/database/**', '**/*database*.*', '**/models/**', '**/*.model.*', '**/entities/**', '**/*.entity.*',
        '**/prisma/**', '**/drizzle/**', '**/schema/**', '**/*schema*.*', '**/*.graphql', '**/*.gql', '**/seeds/**',
    ],
    migrations: [
        '**/migrations/**', '**/migration/**', '**/*.sql', '**/*.prisma', '**/alembic/**', '**/*.migration.*', '**/schema.rb',
    ],
    personal: [
        '**/export/**', '**/exports/**', '**/*export*.*', '**/*cookie*.*', '**/*consent*.*', '**/*analytics*.*',
        '**/*tracking*.*', '**/*tracker*.*', '**/*gdpr*.*', '**/*rgpd*.*', '**/gdpr/**', '**/rgpd/**', '.apv/rgpd/**',
        '**/*privacy*.*', '**/*sous-traitant*.*', '**/*subprocessor*.*',
        // Templates of messages sent to people (3.0.0-alpha.15): what they say of an account or its data is personal.
        '**/email*/**', '**/emails/**', '**/mail/**', '**/mails/**', '**/notifications/**',
    ],
    legal: [
        '**/legal/**', '**/*legal*.*', '**/*legales*/**', '**/*mentions*.*', '**/confidentialite/**', '**/*confidentialite*.*',
        '**/privacy/**', '**/*privacy*/**', '**/cgu/**', '**/*cgu*.*', '**/cgv/**', '**/*cgv*.*', '**/terms/**', '**/*terms*.*',
        '**/conditions*/**', '**/cookies/**', '**/imprint/**', '**/impressum/**',
    ],
    neutral: [
        '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test/**', '**/tests/**', '**/e2e/**', 'docs/**',
        '*.md', '**/README.md', '**/CHANGELOG.md', '.apv/**', '.github/**', '.claude/**', '.vscode/**',
        '.editorconfig', '**/.gitignore', '.gitattributes', '.prettierrc*', '.prettierignore', '.eslintrc*', 'eslint.config.*',
        'prettier.config.*', 'LICENSE*', '.nvmrc', '.node-version',
    ],
    tooling: [
        '**/playwright.config.*', '**/vitest.config.*', '**/vitest.workspace.*', '**/vitest.setup.*', '**/vitest-setup.*',
        '**/jest.config.*', '**/jest.setup.*', '**/cypress.config.*', '**/cypress/**', '**/karma.conf.*', '**/.mocharc*',
        '**/setupTests.*', '**/test-setup.*', '**/__mocks__/**', '**/__fixtures__/**', '**/fixtures/**',
        '**/test-utils/**', '**/test-helpers/**', '**/testing-library/**',
    ],
    server: [
        '**/server/**', '**/*.server.*', '**/+server.*', '**/+*.ts', '**/+*.js', '**/api/**', '**/hooks.*', '**/middleware.*',
        '**/middleware/**', '**/functions/**', '**/workers/**', '**/*.worker.*', '**/cron/**', '**/jobs/**', '**/handlers/**',
        '**/controllers/**', '**/app/**/route.*', '**/instrumentation.*', 'server.*', 'app.*', 'index.*', 'main.*',
        '**/*.config.*', '**/*.conf', '**/*.toml', '**/*.yaml', '**/*.yml', '**/*.json', '**/*.ini', '**/*.env*', '**/.env*',
        '**/Dockerfile*', '**/*.sh', '**/*.py', '**/*.rb', '**/*.go', '**/*.rs', '**/*.java', '**/*.kt', '**/*.php', '**/*.cs',
    ],
};
/**
 * Words (case-insensitive substrings) that, in the changed lines of an interface or data file, keep a domain:
 * `data` keeps the data review (a query written in a page), `personal` keeps the GDPR review (a tracker, a cookie,
 * a new personal field). A false alarm keeps a review: the direction of prudence.
 */
export const DEFAULT_REVIEW_TERMS = {
    data: [
        'insert into', 'delete from', 'select *', 'select distinct', 'alter table', 'create table', ".from('", '.from("', '.from(`',
        '.rpc(', '.query(', '.execute(', '.raw(', '.insert(', '.upsert(', 'db.select(', 'db.insert(', 'db.update(', 'db.delete(',
        'prisma.', 'knex', 'drizzle', 'sequelize', 'mongoose', 'supabase.', 'createclient(', 'sql`', 'transaction(',
        // SQL written in a string (3.0.0-alpha.15): the statement words with their space, so that `reset` or `offset` do not count.
        'update ', ' set ', ' where ', 'grant ', 'revoke ', 'truncate ', 'drop table',
    ],
    personal: [
        'cookie', 'localstorage', 'sessionstorage', 'indexeddb', 'sendbeacon', 'geolocation', 'gtag', 'googletagmanager',
        'google-analytics', 'analytics', 'matomo', 'plausible', 'posthog', 'hotjar', 'mixpanel', 'segment.io', 'sentry',
        'fbq(', 'facebook', 'tracker', 'consent', '<iframe', '<script src', 'fonts.googleapis', 'fonts.gstatic',
        'email', 'e-mail', 'courriel', 'phone', 'telephone', 'téléphone', 'birth', 'naissance', 'ip_address', 'user_agent',
        'useragent', 'first_name', 'last_name', 'firstname', 'lastname', 'prenom', 'prénom', 'address', 'adresse',
        'text/csv', 'content-disposition', 'rgpd', 'gdpr', 'privacy', 'confidentialit',
        // What a text says of the data (3.0.0-alpha.15): retention, hosting, processors, transfers, deletion, audience.
        'donnée', 'donnee', 'data', 'conserv', 'retention', 'rétention', 'héberg', 'heberg', 'hosting', 'hosted', 'prestataire',
        'sous-trait', 'soustrait', 'processor', 'transfert', 'transfer', 'supprim', 'delet', 'effac', 'traceur', 'audience',
    ],
};
const patterns = s.array(s.string(1, 500), 0, 500);
const terms = s.array(s.string(2, 200), 0, 500);
export const reviewPathsSchema = s.object({
    ui: s.optional(patterns), data: s.optional(patterns), migrations: s.optional(patterns),
    personal: s.optional(patterns), legal: s.optional(patterns), neutral: s.optional(patterns),
    tooling: s.optional(patterns), server: s.optional(patterns),
});
export const reviewTermsSchema = s.object({ data: s.optional(terms), personal: s.optional(terms) });
/** Domains always kept, whatever the diff: `securite` is kept anyway, and no key can skip it. */
export const reviewAlwaysSchema = s.array(s.enum(REVIEW_DOMAINS), 0, REVIEW_DOMAINS.length);
export function reviewPlanSettings(section) {
    const paths = Object.fromEntries(PATH_CLASSES.map(c => [c, [...(section?.paths?.[c] ?? DEFAULT_REVIEW_PATHS[c])]]));
    return {
        paths,
        terms: {
            data: [...(section?.terms?.data ?? DEFAULT_REVIEW_TERMS.data)].map(t => t.toLowerCase()),
            personal: [...(section?.terms?.personal ?? DEFAULT_REVIEW_TERMS.personal)].map(t => t.toLowerCase()),
        },
        always: [...new Set(section?.always ?? [])],
    };
}
//# sourceMappingURL=config.js.map