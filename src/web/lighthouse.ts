import { WEB_METRICS, WEB_METRIC_IDS, type FormFactor, type WebCategory, type WebMetric, type WebThresholds } from './config.js';

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
const obj = (value: unknown): Json | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null => typeof value === 'string' ? value : null;
const one = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 300);

/** Same page for Lighthouse: scheme, host, path and query compared exactly (`/faq/` is another page than `/faq`). */
export function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a); const y = new URL(b);
    return x.protocol === y.protocol && x.host === y.host && x.pathname === y.pathname && x.search === y.search;
  } catch { return a === b; }
}

/** Audit kinds that never lower a score: not opportunities. */
const NOT_SCORED = new Set(['notApplicable', 'manual', 'informative', 'error']);

/** Opportunities and diagnostics that cost points in the measured categories, best gains first. */
export function opportunities(report: Json, categories: readonly WebCategory[], limit = 3): Opportunity[] {
  const audits = obj(report['audits']) ?? {};
  const cats = obj(report['categories']) ?? {};
  const found = new Map<string, Opportunity>();
  for (const category of categories) {
    const refs = obj(cats[category])?.['auditRefs'];
    if (!Array.isArray(refs)) continue;
    for (const raw of refs) {
      const ref = obj(raw);
      const id = str(ref?.['id']);
      if (!ref || !id || ref['group'] === 'metrics' || ref['group'] === 'hidden' || found.has(id)) continue;
      const audit = obj(audits[id]);
      const score = num(audit?.['score']);
      const displayMode = str(audit?.['scoreDisplayMode']) ?? '';
      if (!audit || score === null || NOT_SCORED.has(displayMode)) continue;
      const failing = displayMode === 'binary' ? score < 1 : score < 0.9;
      if (!failing) continue;
      const savings = obj(audit['metricSavings']) ?? {};
      let savingsMs = 0;
      const perMetric: Record<string, number> = {};
      for (const [metric, value] of Object.entries(savings)) {
        const v = num(value);
        if (v === null || v <= 0) continue;
        perMetric[metric] = metric === 'CLS' ? Math.round(v * 1000) / 1000 : Math.round(v);
        savingsMs = Math.max(savingsMs, metric === 'CLS' ? v * 1000 : v);
      }
      const details = obj(audit['details']);
      const savingsBytes = num(details?.['overallSavingsBytes']) ?? 0;
      const weight = num(ref['weight']) ?? 0;
      found.set(id, {
        id, title: one(str(audit['title']) ?? id), category, score, displayValue: str(audit['displayValue']) ? one(str(audit['displayValue'])!) : null,
        savings: perMetric, savingsMs: Math.round(savingsMs), savingsBytes: Math.round(savingsBytes), impact: Math.round(weight * (1 - score) * 100) / 100,
      });
    }
  }
  return [...found.values()].sort((a, b) => b.savingsMs - a.savingsMs || b.impact - a.impact || b.savingsBytes - a.savingsBytes || a.score - b.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** HTTP status of the requested document: the first document request of the report (a redirect shows as 3xx). */
function documentStatus(report: Json, requested: string): number | null {
  const items = obj(obj(obj(report['audits'])?.['network-requests'])?.['details'])?.['items'];
  if (!Array.isArray(items)) return null;
  const docs = items.map(obj).filter((i): i is Json => !!i && i['resourceType'] === 'Document');
  const first = docs.find(i => typeof i['url'] === 'string' && samePage(i['url'], requested)) ?? docs[0];
  return first ? num(first['statusCode']) : null;
}

/**
 * Reads one Lighthouse report. The measure is invalid (never counted as a score) on a runtime error (`NO_FCP`,
 * `ERRORED_DOCUMENT_REQUEST`...), any run warning (page too slow, background tab, extension, slow host CPU...), a
 * document status other than 200, a redirect away from the requested page, a missing category score or metric,
 * another Lighthouse version than the pinned one, or another device than the one requested.
 */
export function analyzeReport(input: unknown, expect: Expectation): RunMeasure {
  const report = obj(input);
  const measure: RunMeasure = {
    valid: false, reasons: [], scores: {}, metrics: {}, statusCode: null, finalUrl: null, lighthouseVersion: null, formFactor: null,
    benchmarkIndex: null, browser: null, fetchTime: null, opportunities: [],
  };
  if (!report) { measure.reasons.push('rapport Lighthouse illisible (pas un objet JSON)'); return measure; }
  measure.lighthouseVersion = str(report['lighthouseVersion']);
  measure.finalUrl = str(report['finalDisplayedUrl']) ?? str(report['finalUrl']);
  measure.fetchTime = str(report['fetchTime']);
  measure.formFactor = str(obj(report['configSettings'])?.['formFactor']);
  const env = obj(report['environment']);
  measure.benchmarkIndex = num(env?.['benchmarkIndex']);
  measure.browser = /(?:Headless)?Chrom(?:e|ium)\/[\d.]+/.exec(str(env?.['hostUserAgent']) ?? '')?.[0] ?? null;
  const reasons = measure.reasons;

  const runtime = obj(report['runtimeError']);
  if (runtime) reasons.push(`erreur Lighthouse ${str(runtime['code']) ?? '?'} : ${one(str(runtime['message']) ?? '')}`);
  const warnings = Array.isArray(report['runWarnings']) ? report['runWarnings'] : [];
  for (const warning of warnings) reasons.push(`avertissement de mesure : ${one(typeof warning === 'string' ? warning : JSON.stringify(warning))}`);
  if (measure.lighthouseVersion !== expect.lighthouse) reasons.push(`version de Lighthouse ${measure.lighthouseVersion ?? 'inconnue'} au lieu de ${expect.lighthouse} (web.lighthouse)`);
  if (measure.formFactor !== expect.formFactor) reasons.push(`appareil ${measure.formFactor ?? 'inconnu'} au lieu de ${expect.formFactor}`);

  measure.statusCode = documentStatus(report, expect.url);
  if (measure.statusCode === null) reasons.push('statut HTTP du document inconnu (requête du document absente du rapport)');
  else if (measure.statusCode !== 200) reasons.push(`statut HTTP ${measure.statusCode} pour ${expect.url} (200 attendu)`);
  const main = str(report['mainDocumentUrl']);
  if (main && !samePage(main, expect.url)) reasons.push(`redirection de ${expect.url} vers ${main} : auditer l'adresse finale`);

  const categories = obj(report['categories']) ?? {};
  for (const category of expect.categories) {
    const value = num(obj(categories[category])?.['score']);
    if (value === null) reasons.push(`score ${category} absent (audit en erreur)`);
    else measure.scores[category] = Math.round(value * 100);
  }
  const audits = obj(report['audits']) ?? {};
  for (const metric of WEB_METRIC_IDS) {
    const value = num(obj(audits[WEB_METRICS[metric]])?.['numericValue']);
    if (value === null) reasons.push(`métrique ${metric.toUpperCase()} absente`);
    else measure.metrics[metric] = metric === 'cls' ? Math.round(value * 1000) / 1000 : Math.round(value);
  }
  measure.opportunities = opportunities(report, expect.categories);
  measure.valid = reasons.length === 0;
  return measure;
}

/** Median of numbers: the middle one, or the mean of the two middle ones. */
export function median(values: readonly number[]): number {
  if (!values.length) throw new Error('median of nothing');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface Aggregate {
  scores: Partial<Record<WebCategory, number>>;
  metrics: Partial<Record<WebMetric, number>>;
  /** Index (among the runs given) of the run closest to the medians: its report and opportunities represent the page. */
  representative: number;
}

/** Median per category and per metric of valid runs, and the run closest to them. */
export function aggregate(runs: readonly RunMeasure[], categories: readonly WebCategory[]): Aggregate {
  if (!runs.length) throw new Error('aggregate of no run');
  const scores: Aggregate['scores'] = {};
  const metrics: Aggregate['metrics'] = {};
  for (const c of categories) {
    const values = runs.map(r => r.scores[c]).filter((v): v is number => v !== undefined);
    if (values.length) scores[c] = median(values);
  }
  for (const m of WEB_METRIC_IDS) {
    const values = runs.map(r => r.metrics[m]).filter((v): v is number => v !== undefined);
    if (values.length) metrics[m] = m === 'cls' ? Math.round(median(values) * 1000) / 1000 : Math.round(median(values));
  }
  let best = 0; let bestDistance = Infinity;
  runs.forEach((run, i) => {
    let d = 0;
    for (const c of categories) d += Math.abs((run.scores[c] ?? 0) - (scores[c] ?? 0)) / 100;
    for (const m of WEB_METRIC_IDS) d += Math.abs((run.metrics[m] ?? 0) - (metrics[m] ?? 0)) / Math.max(metrics[m] ?? 0, m === 'cls' ? 0.01 : 1);
    if (d < bestDistance) { bestDistance = d; best = i; }
  });
  return { scores, metrics, representative: best };
}

export interface Shortfall { kind: 'category' | 'metric'; id: string; value: number; threshold: number }

/** Thresholds missed by the medians: a category under its minimum, a metric over its maximum. */
export function shortfalls(result: Pick<Aggregate, 'scores' | 'metrics'>, thresholds: WebThresholds, categories: readonly WebCategory[]): Shortfall[] {
  const out: Shortfall[] = [];
  for (const c of categories) {
    const value = result.scores[c];
    const min = thresholds.categories[c];
    if (value !== undefined && value < min) out.push({ kind: 'category', id: c, value, threshold: min });
  }
  for (const m of WEB_METRIC_IDS) {
    const value = result.metrics[m];
    const max = thresholds.metrics[m];
    if (value !== undefined && max !== null && value > max) out.push({ kind: 'metric', id: m, value, threshold: max });
  }
  return out;
}
