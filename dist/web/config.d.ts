import { type Infer } from '../domain/schema.js';
/**
 * Settings of `apv web audit` (section `web` of `.apv/config.json`, docs/CONFIGURATION.md « Qualité web ») : the public
 * pages of a web project measured by Lighthouse (headless, mobile and desktop, N runs, median kept) against thresholds,
 * and the light search and AI readiness checks (robots.txt, sitemap, canonical, title, description, lang, JSON-LD,
 * hreflang, llms.txt). Generic: every value is the project's, the defaults are ambitious and stack-free.
 */
/** Lighthouse categories measured (Lighthouse 13: `agentic-browsing` included). */
export declare const WEB_CATEGORIES: readonly ["performance", "accessibility", "best-practices", "seo", "agentic-browsing"];
export type WebCategory = typeof WEB_CATEGORIES[number];
/** Metrics kept (median per page and device): the Lighthouse audit that carries each one. */
export declare const WEB_METRICS: {
    readonly fcp: "first-contentful-paint";
    readonly lcp: "largest-contentful-paint";
    readonly tbt: "total-blocking-time";
    readonly cls: "cumulative-layout-shift";
    readonly si: "speed-index";
};
export type WebMetric = keyof typeof WEB_METRICS;
export declare const WEB_METRIC_IDS: WebMetric[];
export declare const FORM_FACTORS: readonly ["mobile", "desktop"];
export type FormFactor = typeof FORM_FACTORS[number];
/** The search and AI readiness checks, each `refuse`, `warn` or `off`. */
export declare const READINESS_CHECKS: readonly ["status", "robots", "sitemap", "canonical", "title", "description", "lang", "jsonLd", "hreflang", "llmsTxt"];
export type ReadinessCheck = typeof READINESS_CHECKS[number];
export declare const CHECK_MODES: readonly ["refuse", "warn", "off"];
export type CheckMode = typeof CHECK_MODES[number];
/** Pinned Lighthouse version when the project pins none; `web.lighthouse` replaces it. */
export declare const DEFAULT_LIGHTHOUSE = "13.5.0";
export declare const DEFAULT_RUNS = 3;
/** Longest Lighthouse run (one page, one device, one pass), then its process group and its Chrome are stopped. */
export declare const DEFAULT_RUN_TIMEOUT_MS = 180000;
/** Ambitious defaults: the best measurable level, never a promise of ranking. */
export declare const DEFAULT_CATEGORY_THRESHOLDS: Record<WebCategory, number>;
export declare const DEFAULT_METRIC_THRESHOLDS: {
    readonly lcp: 2500;
    readonly cls: 0.1;
    readonly tbt: 200;
};
/** Search engines and AI search crawlers whose access robots.txt must leave open (training crawlers are the publisher's choice). */
export declare const DEFAULT_ROBOTS_AGENTS: readonly ["*", "Googlebot", "Bingbot", "OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"];
export declare const DEFAULT_REPORTS_DIR = ".apv/web";
export declare const DEFAULT_KEEP_AUDITS = 10;
export declare const DEFAULT_LOAD_WAIT_MS = 1800000;
/** Default load threshold when neither `web.load.max` nor `suite.queue.maxLoad` is set: half of the processors. */
export declare const defaultMaxLoad: () => number;
export declare const webChecksSchema: import("../domain/schema.js").Schema<{
    readonly status: "off" | "warn" | "refuse";
    readonly robots: "off" | "warn" | "refuse";
    readonly sitemap: "off" | "warn" | "refuse";
    readonly canonical: "off" | "warn" | "refuse";
    readonly title: "off" | "warn" | "refuse";
    readonly description: "off" | "warn" | "refuse";
    readonly lang: "off" | "warn" | "refuse";
    readonly jsonLd: "off" | "warn" | "refuse";
    readonly hreflang: "off" | "warn" | "refuse";
    readonly llmsTxt: "off" | "warn" | "refuse";
}>;
export type WebChecks = Infer<typeof webChecksSchema>;
export declare const webThresholdsSchema: import("../domain/schema.js").Schema<{
    readonly categories: {
        performance: number;
        accessibility: number;
        "best-practices": number;
        seo: number;
        "agentic-browsing": number;
    };
    readonly metrics: {
        readonly lcp: number | null;
        readonly tbt: number | null;
        readonly cls: number | null;
        readonly fcp: number | null;
        readonly si: number | null;
    };
}>;
export type WebThresholds = Infer<typeof webThresholdsSchema>;
/** A page: an absolute path of the site, query allowed, never a fragment nor an origin. */
export declare const PAGE_PATH: RegExp;
export declare const webSchema: import("../domain/schema.js").Schema<{
    readonly pages: string[];
    readonly productionUrl: string | undefined;
    readonly lighthouse: string;
    readonly chrome: string | undefined;
    readonly chromeFlags: string[];
    readonly locale: string;
    readonly runs: number;
    readonly formFactors: ("mobile" | "desktop")[];
    readonly categories: ("performance" | "accessibility" | "best-practices" | "seo" | "agentic-browsing")[];
    readonly thresholds: {
        readonly categories: {
            performance: number;
            accessibility: number;
            "best-practices": number;
            seo: number;
            "agentic-browsing": number;
        };
        readonly metrics: {
            readonly lcp: number | null;
            readonly tbt: number | null;
            readonly cls: number | null;
            readonly fcp: number | null;
            readonly si: number | null;
        };
    };
    readonly timeoutMs: number;
    readonly reportsDir: string;
    readonly keepAudits: number;
    readonly load: {
        max: number | undefined;
        waitMs: number;
    };
    readonly queue: boolean;
    readonly checks: {
        status: "off" | "warn" | "refuse";
        robots: "off" | "warn" | "refuse";
        sitemap: "off" | "warn" | "refuse";
        canonical: "off" | "warn" | "refuse";
        title: "off" | "warn" | "refuse";
        description: "off" | "warn" | "refuse";
        lang: "off" | "warn" | "refuse";
        jsonLd: "off" | "warn" | "refuse";
        hreflang: "off" | "warn" | "refuse";
        llmsTxt: "off" | "warn" | "refuse";
    };
    readonly robotsAgents: string[];
    readonly paths: string[] | undefined;
}>;
export type WebSettings = Infer<typeof webSchema>;
/** Every problem of a `web` section beyond its schema: duplicate pages, non-portable globs. */
export declare function webIssues(web: WebSettings): string[];
