import type { SuiteQueueSettings } from '../config/load.js';
import { type SuiteHooks } from '../gates/suite.js';
import { type Browser, type LighthouseCommand } from './chrome.js';
import { type FormFactor, type WebSettings } from './config.js';
import { type Opportunity, type RunMeasure, type Shortfall } from './lighthouse.js';
import { type Finding } from './readiness.js';
/**
 * `apv web audit`: Lighthouse in headless Chrome on each page, mobile and desktop, N valid runs whose median is kept,
 * under the queue of the full suites and a machine load threshold; then the search and AI readiness checks. The
 * measure only reads the audited origin (Lighthouse loads the page as a browser does).
 */
/** Variable that marks the Lighthouse processes of an audit: its Chrome, detached by Lighthouse, is found by it and stopped. */
export declare const AUDIT_MARKER = "APV_WEB_AUDIT";
export interface PageFactorResult {
    formFactor: FormFactor;
    valid: boolean;
    /** Valid runs whose median is kept. */
    runs: {
        scores: RunMeasure['scores'];
        metrics: RunMeasure['metrics'];
        load: number;
        benchmarkIndex: number | null;
    }[];
    /** Runs set aside: why each one does not count. */
    invalid: {
        attempt: number;
        reasons: string[];
    }[];
    median: {
        scores: RunMeasure['scores'];
        metrics: RunMeasure['metrics'];
    } | null;
    shortfalls: Shortfall[];
    opportunities: Opportunity[];
    /** Full reports of the representative run (closest to the medians), relative to the audit folder. */
    report: {
        json: string;
        html: string | null;
    } | null;
    browser: string | null;
}
export interface PageResult {
    path: string;
    url: string;
    results: PageFactorResult[];
}
export interface AuditSummary {
    tool: string;
    version: string;
    ok: boolean;
    auditId: string;
    source: 'url' | 'preview';
    origin: string;
    commit: string | null;
    startedAt: string;
    finishedAt: string;
    lighthouse: {
        version: string;
        command: string;
        source: LighthouseCommand['source'];
    } | null;
    browser: Browser | null;
    runs: number;
    formFactors: FormFactor[];
    categories: WebSettings['categories'];
    thresholds: WebSettings['thresholds'];
    queue: {
        held: boolean;
        waitedMs: number;
        reason: string;
    } | null;
    load: {
        max: number;
        atStart: number | null;
        highest: number | null;
    };
    pages: PageResult[];
    readiness: {
        findings: Finding[];
        notes: string[];
    };
    counts: {
        shortfalls: number;
        invalid: number;
        refused: number;
        warnings: number;
    };
    reportsDir: string;
}
export interface AuditOptions {
    repo: string;
    settings: WebSettings;
    suiteQueue: SuiteQueueSettings;
    suiteMaxLoad: number | undefined;
    origin: string;
    source: 'url' | 'preview';
    commit: string | null;
    pages: string[];
    formFactors: FormFactor[];
    runs: number;
    /** Readiness checks only, no Lighthouse (no browser, no queue, no load wait). */
    readinessOnly: boolean;
    env: NodeJS.ProcessEnv;
    log: (line: string) => void;
    signal?: AbortSignal | undefined;
    hooks?: SuiteHooks | undefined;
}
/** File-safe name of a page path: `/` is `accueil`, `/a/b?x=1` is `a-b-x-1`. */
export declare function pageSlug(path: string): string;
export declare function checkReadiness(options: Pick<AuditOptions, 'origin' | 'pages' | 'settings' | 'signal'>): Promise<{
    findings: Finding[];
    notes: string[];
}>;
export declare function runAudit(options: AuditOptions): Promise<AuditSummary>;
