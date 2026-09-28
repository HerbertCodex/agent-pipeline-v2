import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { SuiteQueueSettings } from '../config/load.js';
import { VERSION } from '../domain/contracts.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { runProcess } from '../execution/process.js';
import { assertProcSupported, listProcesses, protectedTool, sessionPids, stopProcesses } from '../execution/procs.js';
import { enterQueue, markedProcesses, waitForLoad, type QueueHandle, type SuiteHooks } from '../gates/suite.js';
import { gitRead } from '../run/git-probe.js';
import { findBrowser, lighthouseCommand, type Browser, type LighthouseCommand } from './chrome.js';
import { defaultMaxLoad, type FormFactor, type WebSettings } from './config.js';
import { aggregate, analyzeReport, shortfalls, type Opportunity, type RunMeasure, type Shortfall } from './lighthouse.js';
import { readinessFindings, parseRobots, parseSitemap, type FetchedPage, type FetchedText, type Finding } from './readiness.js';

/**
 * `apv web audit`: Lighthouse in headless Chrome on each page, mobile and desktop, N valid runs whose median is kept,
 * under the queue of the full suites and a machine load threshold; then the search and AI readiness checks. The
 * measure only reads the audited origin (Lighthouse loads the page as a browser does).
 */

/** Variable that marks the Lighthouse processes of an audit: its Chrome, detached by Lighthouse, is found by it and stopped. */
export const AUDIT_MARKER = 'APV_WEB_AUDIT';
const SUMMARY = 'summary.json';

export interface PageFactorResult {
  formFactor: FormFactor;
  valid: boolean;
  /** Valid runs whose median is kept. */
  runs: { scores: RunMeasure['scores']; metrics: RunMeasure['metrics']; load: number; benchmarkIndex: number | null }[];
  /** Runs set aside: why each one does not count. */
  invalid: { attempt: number; reasons: string[] }[];
  median: { scores: RunMeasure['scores']; metrics: RunMeasure['metrics'] } | null;
  shortfalls: Shortfall[];
  opportunities: Opportunity[];
  /** Full reports of the representative run (closest to the medians), relative to the audit folder. */
  report: { json: string; html: string | null } | null;
  browser: string | null;
}

export interface PageResult { path: string; url: string; results: PageFactorResult[] }

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
  lighthouse: { version: string; command: string; source: LighthouseCommand['source'] } | null;
  browser: Browser | null;
  runs: number;
  formFactors: FormFactor[];
  categories: WebSettings['categories'];
  thresholds: WebSettings['thresholds'];
  queue: { held: boolean; waitedMs: number; reason: string } | null;
  load: { max: number; atStart: number | null; highest: number | null };
  pages: PageResult[];
  readiness: { findings: Finding[]; notes: string[] };
  counts: { shortfalls: number; invalid: number; refused: number; warnings: number };
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

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
/** File-safe name of a page path: `/` is `accueil`, `/a/b?x=1` is `a-b-x-1`. */
export function pageSlug(path: string): string {
  const slug = path.replace(/^\/+/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 80);
  return slug || 'accueil';
}

// ---------------------------------------------------------------- fetching (the audited origin only)

const MAX_BYTES = 5 * 1024 * 1024;
async function fetchText(url: string, redirect: 'follow' | 'manual', signal?: AbortSignal): Promise<{ status: number | null; error: string | null; contentType: string | null; text: string | null; headers: Headers | null }> {
  try {
    const timeout = AbortSignal.timeout(20_000);
    const response = await fetch(url, { redirect, headers: { 'user-agent': `apv-web-audit/${VERSION}`, accept: 'text/html,application/xml,text/plain,*/*' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.subarray(0, MAX_BYTES).toString('utf8');
    return { status: response.status, error: null, contentType: response.headers.get('content-type'), text: response.status === 200 ? text : null, headers: response.headers };
  } catch (error) { return { status: null, error: errorMessage(error).slice(0, 200), contentType: null, text: null, headers: null }; }
}

/** A URL of the audited origin: an absolute URL of another host keeps its path on the audited origin (never a third-party request). */
function onOrigin(url: string, origin: string): { url: string; moved: boolean } {
  try {
    const u = new URL(url, origin);
    const o = new URL(origin);
    if (u.origin === o.origin) return { url: u.href, moved: false };
    return { url: new URL(`${u.pathname}${u.search}`, o).href, moved: true };
  } catch { return { url, moved: false }; }
}

export async function checkReadiness(options: Pick<AuditOptions, 'origin' | 'pages' | 'settings' | 'signal'>): Promise<{ findings: Finding[]; notes: string[] }> {
  const { origin, settings } = options;
  const pages: FetchedPage[] = [];
  for (const path of options.pages) {
    const url = new URL(path, origin).href;
    const r = await fetchText(url, 'manual', options.signal);
    pages.push({ path, url, status: r.status, error: r.error, xRobotsTag: r.headers?.get('x-robots-tag') ?? null, html: r.text });
  }
  const robotsUrl = new URL('/robots.txt', origin).href;
  const robotsRaw = await fetchText(robotsUrl, 'follow', options.signal);
  const robots: FetchedText = { url: robotsUrl, ...robotsRaw };
  const notes: string[] = [];
  const declared = robots.text !== null ? parseRobots(robots.text).sitemaps : [];
  const queue = declared.length ? declared : ['/sitemap.xml'];
  const sitemaps: FetchedText[] = [];
  const seen = new Set<string>();
  while (queue.length && sitemaps.length < 20) {
    const { url, moved } = onOrigin(queue.shift()!, origin);
    if (seen.has(url)) continue;
    seen.add(url);
    if (moved) notes.push(`sitemap déclaré sur une autre origine, lu sur l'origine auditée : ${url}`);
    const r = await fetchText(url, 'follow', options.signal);
    sitemaps.push({ url, ...r });
    if (r.text !== null) {
      const parsed = parseSitemap(r.text);
      if (parsed.kind === 'sitemapindex') queue.push(...parsed.locs);
    }
  }
  let llms: FetchedText | null = null;
  if (settings.checks.llmsTxt !== 'off') {
    const url = new URL('/llms.txt', origin).href;
    llms = { url, ...(await fetchText(url, 'follow', options.signal)) };
  }
  const result = readinessFindings({ origin, pages, robots, sitemaps, llms, checks: settings.checks, agents: settings.robotsAgents });
  return { findings: result.findings, notes: [...notes, ...result.notes] };
}

// ---------------------------------------------------------------- Lighthouse runs

/** Stops the processes an audit run left behind (Chrome, detached by Lighthouse), found by their marker. Never the session nor a tool. */
async function stopMarked(marker: string): Promise<number> {
  try { assertProcSupported(); } catch { return 0; }
  const all = listProcesses();
  const session = sessionPids(all);
  const targets = markedProcesses(marker, all, '/proc', AUDIT_MARKER).filter(p => !session.has(p.pid) && protectedTool(p) === null);
  if (!targets.length) return 0;
  await stopProcesses(targets, { graceMs: 3000 });
  return targets.length;
}

interface OneRun { measure: RunMeasure; json: string | null; html: string | null }

async function lighthouseRun(options: { command: LighthouseCommand; browser: Browser; url: string; formFactor: FormFactor; settings: WebSettings; workDir: string;
  name: string; env: NodeJS.ProcessEnv; marker: string; signal?: AbortSignal | undefined }): Promise<OneRun> {
  const { settings } = options;
  const out = join(options.workDir, options.name);
  const args = [...options.command.argv, options.url, '--output=json', '--output=html', `--output-path=${out}`,
    `--only-categories=${settings.categories.join(',')}`, `--locale=${settings.locale}`, '--quiet',
    ...(settings.chromeFlags.length ? [`--chrome-flags=${settings.chromeFlags.join(' ')}`] : []),
    ...(options.formFactor === 'desktop' ? ['--preset=desktop'] : [])];
  // Lighthouse runs in a scratch folder (chrome-launcher may leave its profile in the working directory under WSL).
  const result = await runProcess({
    command: args, cwd: options.workDir, timeoutMs: settings.timeoutMs, maxOutputBytes: 65_536,
    env: { ...options.env, CHROME_PATH: options.browser.path, [AUDIT_MARKER]: options.marker, npm_config_update_notifier: 'false' },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await stopMarked(options.marker);
  const json = `${out}.report.json`;
  const html = `${out}.report.html`;
  const expect = { url: options.url, formFactor: options.formFactor, categories: settings.categories, lighthouse: settings.lighthouse };
  if (result.status === 'cancelled') throw new PipelineError('CANCELLED', 'Audit interrompu');
  if (!existsSync(json)) {
    const why = result.status === 'timed_out' ? `Lighthouse arrêté après ${Math.round(settings.timeoutMs / 1000)} s (web.timeoutMs)`
      : result.status === 'spawn_error' ? `Lighthouse non lancé : ${result.stderr.slice(0, 300)}`
      : `Lighthouse sans rapport (code ${result.exitCode}) : ${result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`;
    const measure = analyzeReport(null, expect);
    measure.reasons.splice(0, measure.reasons.length, why);
    return { measure, json: null, html: null };
  }
  let report: unknown = null;
  try { report = JSON.parse(readFileSync(json, 'utf8')); } catch { report = null; }
  const measure = analyzeReport(report, expect);
  if (result.status === 'timed_out') { measure.valid = false; measure.reasons.push('Lighthouse arrêté au délai (web.timeoutMs)'); }
  return { measure, json, html: existsSync(html) ? html : null };
}

/** The queue lock file of the full suites: absolute, or relative to the Git common directory of the repository. */
function queueFile(repo: string, lockFile: string): string {
  if (isAbsolute(lockFile)) return lockFile;
  const common = gitRead(repo, ['rev-parse', '--git-common-dir']);
  if (!common) throw new PipelineError('GIT', `Répertoire Git commun introuvable pour ${repo}`);
  return resolve(isAbsolute(common) ? common : resolve(repo, common), lockFile);
}

/** Keeps the `keep` most recent audit folders (those holding a summary.json) of the reports folder. */
function prune(dir: string, keep: number): void {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  const audits = entries.filter(e => existsSync(join(dir, e, SUMMARY))).sort().reverse();
  for (const old of audits.slice(keep)) rmSync(join(dir, old), { recursive: true, force: true });
}

export async function runAudit(options: AuditOptions): Promise<AuditSummary> {
  const { settings, log } = options;
  const started = new Date();
  const reportsRoot = resolve(options.repo, settings.reportsDir);
  mkdirSync(reportsRoot, { recursive: true });
  // The reports ignore themselves, like the receipts: never committed, and a full suite's tree stays clean.
  if (!existsSync(join(reportsRoot, '.gitignore'))) writeFileSync(join(reportsRoot, '.gitignore'), '# Rapports de apv web audit : jamais versionnés.\n*\n');
  let auditId = `${stamp(started)}-${options.source === 'preview' ? 'apercu' : 'url'}`;
  for (let i = 2; existsSync(join(reportsRoot, auditId)); i++) auditId = `${stamp(started)}-${options.source === 'preview' ? 'apercu' : 'url'}-${i}`;
  const auditDir = join(reportsRoot, auditId);
  mkdirSync(auditDir, { recursive: true });

  const maxLoad = settings.load.max ?? options.suiteMaxLoad ?? defaultMaxLoad();
  const summary: AuditSummary = {
    tool: 'apv web audit', version: VERSION, ok: false, auditId, source: options.source, origin: options.origin, commit: options.commit,
    startedAt: started.toISOString(), finishedAt: '', lighthouse: null, browser: null, runs: options.runs, formFactors: options.formFactors,
    categories: settings.categories, thresholds: settings.thresholds, queue: null, load: { max: maxLoad, atStart: null, highest: null },
    pages: options.pages.map(path => ({ path, url: new URL(path, options.origin).href, results: [] })),
    readiness: { findings: [], notes: [] }, counts: { shortfalls: 0, invalid: 0, refused: 0, warnings: 0 }, reportsDir: auditDir,
  };

  log(`Contrôles de préparation à la recherche et aux IA sur ${options.origin}...`);
  summary.readiness = await checkReadiness(options);

  if (!options.readinessOnly) {
    const browser = findBrowser(settings.chrome, options.repo, options.env);
    const command = lighthouseCommand(options.repo, settings.lighthouse);
    summary.browser = browser;
    summary.lighthouse = { version: settings.lighthouse, command: command.argv.join(' '), source: command.source };
    let queue: QueueHandle | null = null;
    const workDir = mkdtempSync(join(tmpdir(), 'apv-web-'));
    try {
      if (options.env['APV_SUITE_RUN']) summary.queue = { held: false, waitedMs: 0, reason: 'file tenue par la suite complète en cours (APV_SUITE_RUN)' };
      else if (settings.queue && options.suiteQueue.enabled) {
        const lockFile = queueFile(options.repo, options.suiteQueue.lockFile);
        mkdirSync(join(lockFile, '..'), { recursive: true });
        // The load is waited for below, run by run: the queue alone here.
        queue = await enterQueue({ lockFile, settings: { ...options.suiteQueue, maxLoad: undefined }, repo: options.repo, log, signal: options.signal, hooks: options.hooks,
          label: `apv web audit (${options.repo})`, purpose: 'mesure Lighthouse' });
        summary.queue = { held: true, waitedMs: queue.record.waitedMs, reason: `file des suites complètes (${lockFile})` };
      } else summary.queue = { held: false, waitedMs: 0, reason: settings.queue ? 'file des suites désactivée (suite.queue.enabled)' : 'web.queue désactivé' };

      const loadStarted = Date.now();
      const readLoad = options.hooks?.loadAverage ?? (() => loadavg()[0] ?? 0);
      for (const page of summary.pages) {
        for (const formFactor of options.formFactors) {
          const valid: OneRun[] = [];
          const loads: number[] = [];
          const result: PageFactorResult = { formFactor, valid: false, runs: [], invalid: [], median: null, shortfalls: [], opportunities: [], report: null, browser: null };
          for (let attempt = 1; valid.length < options.runs && attempt <= options.runs * 2; attempt++) {
            const budget = Math.max(0, settings.load.waitMs - (Date.now() - loadStarted));
            const load = await waitForLoad(maxLoad, budget, log, options.signal, options.hooks, 'measure');
            if (load.exceeded) {
              throw new PipelineError('WEB_LOAD', `Charge moyenne sur 1 min à ${load.atStart.toFixed(2)}, au-dessus du seuil ${maxLoad} après l'attente permise (web.load.waitMs) : mesure refusée, `
                + 'une mesure sous charge fausse la performance. Relancer quand la machine est calme (apv procs list, apv stacks status).');
            }
            summary.load.atStart ??= load.atStart;
            log(`Lighthouse ${page.path} (${formFactor}), passage ${attempt}...`);
            const run = await lighthouseRun({ command, browser, url: page.url, formFactor, settings, workDir, name: `${pageSlug(page.path)}.${formFactor}.${attempt}`,
              env: options.env, marker: `${auditId}-${process.pid}`, signal: options.signal });
            const after = readLoad();
            summary.load.highest = Math.max(summary.load.highest ?? 0, load.atStart, after);
            result.browser ??= run.measure.browser;
            if (run.measure.valid) { valid.push(run); loads.push(load.atStart); }
            else { result.invalid.push({ attempt, reasons: run.measure.reasons }); log(`  mesure invalide écartée : ${run.measure.reasons.join(' ; ')}`); }
          }
          result.valid = valid.length === options.runs;
          result.runs = valid.map((r, i) => ({ scores: r.measure.scores, metrics: r.measure.metrics, load: Math.round(loads[i]! * 100) / 100, benchmarkIndex: r.measure.benchmarkIndex }));
          if (valid.length) {
            const agg = aggregate(valid.map(v => v.measure), settings.categories);
            result.median = { scores: agg.scores, metrics: agg.metrics };
            result.shortfalls = shortfalls(agg, settings.thresholds, settings.categories);
            const representative = valid[agg.representative]!;
            result.opportunities = representative.measure.opportunities;
            const base = `${pageSlug(page.path)}.${formFactor}`;
            copyFileSync(representative.json!, join(auditDir, `${base}.report.json`));
            if (representative.html) copyFileSync(representative.html, join(auditDir, `${base}.report.html`));
            result.report = { json: `${base}.report.json`, html: representative.html ? `${base}.report.html` : null };
          }
          page.results.push(result);
        }
      }
    } finally {
      await queue?.release();
      await stopMarked(`${auditId}-${process.pid}`);
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  const results = summary.pages.flatMap(p => p.results);
  summary.counts = {
    shortfalls: results.reduce((n, r) => n + r.shortfalls.length, 0),
    invalid: results.filter(r => !r.valid).length,
    refused: summary.readiness.findings.filter(f => f.level === 'refuse').length,
    warnings: summary.readiness.findings.filter(f => f.level === 'warn').length,
  };
  summary.ok = summary.counts.shortfalls === 0 && summary.counts.invalid === 0 && summary.counts.refused === 0;
  summary.finishedAt = new Date().toISOString();
  writeFileSync(join(auditDir, SUMMARY), `${JSON.stringify(summary, null, 2)}\n`);
  prune(reportsRoot, settings.keepAudits);
  return summary;
}
