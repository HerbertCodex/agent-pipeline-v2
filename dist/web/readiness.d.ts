import type { CheckMode, ReadinessCheck, WebChecks } from './config.js';
/**
 * Search and AI readiness of a site, from what the audited site serves and nothing else: robots.txt, sitemaps, the
 * server HTML of each page (what crawlers that run no script read), llms.txt. Pure functions, tested on sample
 * documents; the fetching lives in audit.ts. These checks measure what the project controls: they never promise
 * an indexing, a ranking or a citation by a search engine or an AI.
 */
export interface RobotsRule {
    allow: boolean;
    path: string;
}
export interface RobotsGroup {
    agents: string[];
    rules: RobotsRule[];
}
export interface Robots {
    groups: RobotsGroup[];
    sitemaps: string[];
}
export declare function parseRobots(text: string): Robots;
/** The group that applies to a crawler: the one naming its product token (case-insensitive), else `*`, else none. */
export declare function robotsGroup(robots: Robots, agent: string): RobotsGroup[];
/** Whether a crawler may fetch a path: the longest matching rule wins, Allow on a tie; no rule: allowed. */
export declare function robotsAllows(robots: Robots, agent: string, path: string): {
    allowed: boolean;
    rule: RobotsRule | null;
};
export interface Sitemap {
    kind: 'urlset' | 'sitemapindex' | 'unknown';
    locs: string[];
}
export declare function parseSitemap(xml: string): Sitemap;
/** Path of a URL for comparisons between the audited origin and absolute URLs of another host (a preview's sitemap names production). */
export declare function pagePath(url: string, base?: string): string | null;
export interface HeadInfo {
    lang: string | null;
    titles: string[];
    descriptions: string[];
    canonicals: string[];
    robots: string[];
    alternates: {
        hreflang: string;
        href: string;
    }[];
    jsonLd: string[];
}
export declare function decodeEntities(text: string): string;
/** Attributes of a start tag (`<meta name="x" content='y' async>`), names lowercased, values decoded. */
export declare function attributes(tag: string): Record<string, string>;
/** What crawlers read in the server HTML: `lang`, title, description, canonical, robots, hreflang alternates, JSON-LD. */
export declare function parseHead(html: string): HeadInfo;
/** Problems of one JSON-LD block: JSON that does not parse, a node without `@context` (top level) or `@type`. */
export declare function jsonLdIssues(raw: string): string[];
/** A hreflang value: `x-default` or a language tag (`fr`, `fr-FR`, `zh-Hant-TW`). */
export declare const HREFLANG: RegExp;
export interface Finding {
    check: ReadinessCheck;
    /** `refuse` fails the audit, `warn` is reported. */
    level: Exclude<CheckMode, 'off'>;
    page: string | null;
    message: string;
}
export interface FetchedPage {
    path: string;
    url: string;
    status: number | null;
    error: string | null;
    xRobotsTag: string | null;
    html: string | null;
}
export interface FetchedText {
    url: string;
    status: number | null;
    error: string | null;
    contentType: string | null;
    text: string | null;
}
export interface ReadinessInput {
    origin: string;
    pages: FetchedPage[];
    robots: FetchedText;
    /** Sitemaps read: those robots.txt declares (and the indexes they list), else `/sitemap.xml`. */
    sitemaps: FetchedText[];
    llms: FetchedText | null;
    checks: WebChecks;
    agents: readonly string[];
}
export interface ReadinessResult {
    findings: Finding[];
    notes: string[];
}
/** Every finding of the readiness checks, `off` checks left out. */
export declare function readinessFindings(input: ReadinessInput): ReadinessResult;
