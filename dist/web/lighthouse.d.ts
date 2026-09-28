import { type FormFactor, type WebCategory, type WebMetric, type WebThresholds } from './config.js';
/**
 * Reading of a Lighthouse JSON report (Lighthouse 13, `lhr`): validity of the measure, scores, metrics and the main
 * opportunities; median of several runs; thresholds. Pure functions: no process, no network, tested on sample reports.
 */
/** An opportunity or a diagnostic of a run, ranked by estimated gain. */
export interface Opportunity {
    id: string;
    title: string;
    category: WebCategory;
    /** Lighthouse score of the audit, 0 to 1. */
    score: number;
    displayValue: string | null;
    /** Estimated saving per metric (`LCP`, `FCP`, `TBT` in milliseconds, `CLS` unitless), as Lighthouse gives it. */
    savings: Record<string, number>;
    /** Largest of those savings, in milliseconds (CLS counted as 1000 ms per unit): the ranking key. */
    savingsMs: number;
    savingsBytes: number;
    /** Points of the category score lost to this audit (its weight times its shortfall). */
    impact: number;
}
export interface RunMeasure {
    valid: boolean;
    /** Why the measure does not count, in French; empty when valid. */
    reasons: string[];
    /** Category scores, 0 to 100. */
    scores: Partial<Record<WebCategory, number>>;
    metrics: Partial<Record<WebMetric, number>>;
    statusCode: number | null;
    finalUrl: string | null;
    lighthouseVersion: string | null;
    formFactor: string | null;
    benchmarkIndex: number | null;
    /** Browser of the run, from the host user agent (`HeadlessChrome/153.0.0.0`). */
    browser: string | null;
    fetchTime: string | null;
    opportunities: Opportunity[];
}
export interface Expectation {
    url: string;
    formFactor: FormFactor;
    categories: readonly WebCategory[];
    lighthouse: string;
}
type Json = Record<string, unknown>;
/** Same page for Lighthouse: scheme, host, path and query compared exactly (`/faq/` is another page than `/faq`). */
export declare function samePage(a: string, b: string): boolean;
/** Opportunities and diagnostics that cost points in the measured categories, best gains first. */
export declare function opportunities(report: Json, categories: readonly WebCategory[], limit?: number): Opportunity[];
/**
 * Reads one Lighthouse report. The measure is invalid (never counted as a score) on a runtime error (`NO_FCP`,
 * `ERRORED_DOCUMENT_REQUEST`...), any run warning (page too slow, background tab, extension, slow host CPU...), a
 * document status other than 200, a redirect away from the requested page, a missing category score or metric,
 * another Lighthouse version than the pinned one, or another device than the one requested.
 */
export declare function analyzeReport(input: unknown, expect: Expectation): RunMeasure;
/** Median of numbers: the middle one, or the mean of the two middle ones. */
export declare function median(values: readonly number[]): number;
export interface Aggregate {
    scores: Partial<Record<WebCategory, number>>;
    metrics: Partial<Record<WebMetric, number>>;
    /** Index (among the runs given) of the run closest to the medians: its report and opportunities represent the page. */
    representative: number;
}
/** Median per category and per metric of valid runs, and the run closest to them. */
export declare function aggregate(runs: readonly RunMeasure[], categories: readonly WebCategory[]): Aggregate;
export interface Shortfall {
    kind: 'category' | 'metric';
    id: string;
    value: number;
    threshold: number;
}
/** Thresholds missed by the medians: a category under its minimum, a metric over its maximum. */
export declare function shortfalls(result: Pick<Aggregate, 'scores' | 'metrics'>, thresholds: WebThresholds, categories: readonly WebCategory[]): Shortfall[];
export {};
