import { availableParallelism } from 'node:os';
import { s } from '../domain/schema.js';
import { matches } from '../policy/policy.js';
import { errorMessage } from '../domain/errors.js';
/**
 * Settings of `apv web audit` (section `web` of `.apv/config.json`, docs/CONFIGURATION.md « Qualité web ») : the public
 * pages of a web project measured by Lighthouse (headless, mobile and desktop, N runs, median kept) against thresholds,
 * and the light search and AI readiness checks (robots.txt, sitemap, canonical, title, description, lang, JSON-LD,
 * hreflang, llms.txt). Generic: every value is the project's, the defaults are ambitious and stack-free.
 */
/** Lighthouse categories measured (Lighthouse 13: `agentic-browsing` included). */
export const WEB_CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo', 'agentic-browsing'];
/** Metrics kept (median per page and device): the Lighthouse audit that carries each one. */
export const WEB_METRICS = { fcp: 'first-contentful-paint', lcp: 'largest-contentful-paint', tbt: 'total-blocking-time', cls: 'cumulative-layout-shift', si: 'speed-index' };
export const WEB_METRIC_IDS = Object.keys(WEB_METRICS);
export const FORM_FACTORS = ['mobile', 'desktop'];
/** The search and AI readiness checks, each `refuse`, `warn` or `off`. */
export const READINESS_CHECKS = ['status', 'robots', 'sitemap', 'canonical', 'title', 'description', 'lang', 'jsonLd', 'hreflang', 'llmsTxt'];
export const CHECK_MODES = ['refuse', 'warn', 'off'];
/** Pinned Lighthouse version when the project pins none; `web.lighthouse` replaces it. */
export const DEFAULT_LIGHTHOUSE = '13.5.0';
export const DEFAULT_RUNS = 3;
/** Longest Lighthouse run (one page, one device, one pass), then its process group and its Chrome are stopped. */
export const DEFAULT_RUN_TIMEOUT_MS = 180_000;
/** Ambitious defaults: the best measurable level, never a promise of ranking. */
export const DEFAULT_CATEGORY_THRESHOLDS = { performance: 90, accessibility: 100, 'best-practices': 100, seo: 100, 'agentic-browsing': 100 };
export const DEFAULT_METRIC_THRESHOLDS = { lcp: 2500, cls: 0.1, tbt: 200 };
/** Search engines and AI search crawlers whose access robots.txt must leave open (training crawlers are the publisher's choice). */
export const DEFAULT_ROBOTS_AGENTS = ['*', 'Googlebot', 'Bingbot', 'OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot'];
export const DEFAULT_REPORTS_DIR = '.apv/web';
export const DEFAULT_KEEP_AUDITS = 10;
export const DEFAULT_LOAD_WAIT_MS = 1_800_000;
/** Default load threshold when neither `web.load.max` nor `suite.queue.maxLoad` is set: half of the processors. */
export const defaultMaxLoad = () => Math.max(1, availableParallelism() / 2);
const mode = (fallback) => s.default(s.enum(CHECK_MODES), fallback);
const score = (fallback) => s.default(s.number(0, 100), fallback);
export const webChecksSchema = s.object({
    // Each page served with 200, without redirect: what crawlers index.
    status: mode('refuse'),
    robots: mode('refuse'), sitemap: mode('refuse'), canonical: mode('refuse'), title: mode('refuse'), description: mode('refuse'),
    lang: mode('refuse'), jsonLd: mode('refuse'), hreflang: mode('refuse'),
    // llms.txt is a proposal, not a standard: checked only when the project declares it expected.
    llmsTxt: mode('off'),
});
const CHECK_DEFAULTS = webChecksSchema.parse({});
export const webThresholdsSchema = s.object({
    categories: s.default(s.object({
        performance: score(DEFAULT_CATEGORY_THRESHOLDS.performance),
        accessibility: score(DEFAULT_CATEGORY_THRESHOLDS.accessibility),
        'best-practices': score(DEFAULT_CATEGORY_THRESHOLDS['best-practices']),
        seo: score(DEFAULT_CATEGORY_THRESHOLDS.seo),
        'agentic-browsing': score(DEFAULT_CATEGORY_THRESHOLDS['agentic-browsing']),
    }), { ...DEFAULT_CATEGORY_THRESHOLDS }),
    // Upper bounds, in milliseconds (cls: unitless). `null` (fcp and si by default) : no threshold, still measured and reported.
    metrics: s.default(s.object({
        lcp: s.default(s.nullable(s.number(1, 120_000)), DEFAULT_METRIC_THRESHOLDS.lcp),
        tbt: s.default(s.nullable(s.number(0, 120_000)), DEFAULT_METRIC_THRESHOLDS.tbt),
        cls: s.default(s.nullable(s.finite(0, 10)), DEFAULT_METRIC_THRESHOLDS.cls),
        fcp: s.default(s.nullable(s.number(1, 120_000)), null),
        si: s.default(s.nullable(s.number(1, 120_000)), null),
    }), { ...DEFAULT_METRIC_THRESHOLDS, fcp: null, si: null }),
});
/** A page: an absolute path of the site, query allowed, never a fragment nor an origin. */
export const PAGE_PATH = /^\/(?!\/)[^\s#]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const webSchema = s.object({
    pages: s.array(s.string(1, 2000, PAGE_PATH), 1, 100),
    /** Production origin for `apv web audit --production` (post-deployment audit). */
    productionUrl: s.optional(s.string(1, 2000, /^https?:\/\/[^\s/]+\/?$/)),
    lighthouse: s.default(s.string(1, 50, VERSION), DEFAULT_LIGHTHOUSE),
    /** Chrome or Chromium binary; absent: CHROME_PATH, then the Chromium of Playwright, then the system ones. */
    chrome: s.optional(s.string(1, 4096)),
    chromeFlags: s.default(s.array(s.string(1, 500, /^--[A-Za-z0-9-]+(?:=[^\s]*)?$/), 0, 50), ['--headless=new']),
    /** Language of the Lighthouse texts (titles of the opportunities, warnings). */
    locale: s.default(s.string(2, 10, /^[a-z]{2}(?:-[A-Z]{2})?$/), 'fr'),
    runs: s.default(s.number(1, 15), DEFAULT_RUNS),
    formFactors: s.default(s.array(s.enum(FORM_FACTORS), 1, 2), [...FORM_FACTORS]),
    categories: s.default(s.array(s.enum(WEB_CATEGORIES), 1, WEB_CATEGORIES.length), [...WEB_CATEGORIES]),
    thresholds: s.default(webThresholdsSchema, webThresholdsSchema.parse({})),
    timeoutMs: s.default(s.number(10_000, 900_000), DEFAULT_RUN_TIMEOUT_MS),
    /** Folder of the reports, relative to the repository (ignored by Git: it holds its own `.gitignore`). */
    reportsDir: s.default(s.string(1, 1000), DEFAULT_REPORTS_DIR),
    keepAudits: s.default(s.number(1, 1000), DEFAULT_KEEP_AUDITS),
    /** Machine load: wait for the 1-minute load under `max` (default `suite.queue.maxLoad`, else half the processors), at most `waitMs`, else refuse. */
    load: s.default(s.object({ max: s.optional(s.finite(0.1, 10_000)), waitMs: s.default(s.number(0, 86_400_000), DEFAULT_LOAD_WAIT_MS) }), { waitMs: DEFAULT_LOAD_WAIT_MS }),
    /** Take the queue of the full suites (`suite.queue`) around the measure, so that no suite runs meanwhile. */
    queue: s.default(s.boolean(), true),
    checks: s.default(webChecksSchema, { ...CHECK_DEFAULTS }),
    robotsAgents: s.default(s.array(s.string(1, 100, /^[A-Za-z0-9*._-]+$/), 1, 30), [...DEFAULT_ROBOTS_AGENTS]),
    /** Globs of the files whose change calls for an audit (`--base`); absent: `review.paths.ui`, else the generic interface globs. */
    paths: s.optional(s.array(s.string(1, 500), 1, 500)),
});
/** Every problem of a `web` section beyond its schema: duplicate pages, non-portable globs. */
export function webIssues(web) {
    const issues = [];
    const duplicates = [...new Set(web.pages.filter((p, i) => web.pages.indexOf(p) !== i))];
    if (duplicates.length)
        issues.push(`web.pages: duplicate page ${duplicates.join(', ')}`);
    if (new Set(web.formFactors).size !== web.formFactors.length)
        issues.push('web.formFactors: duplicate form factor');
    if (new Set(web.categories).size !== web.categories.length)
        issues.push('web.categories: duplicate category');
    for (const glob of web.paths ?? []) {
        try {
            matches('probe', glob);
        }
        catch (error) {
            issues.push(`web.paths: ${errorMessage(error)}`);
        }
    }
    return issues;
}
//# sourceMappingURL=config.js.map