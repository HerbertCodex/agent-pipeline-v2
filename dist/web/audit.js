import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { TextDecoder } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { VERSION } from '../domain/contracts.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { runProcess } from '../execution/process.js';
import { assertProcSupported, listProcesses, protectedTool, sessionPids, stopProcesses } from '../execution/procs.js';
import { enterQueue, markedProcesses, queuePlaces, waitForLoad } from '../gates/suite.js';
import { gitRead } from '../run/git-probe.js';
import { findBrowser, lighthouseCommand } from './chrome.js';
import { defaultMaxLoad } from './config.js';
import { aggregate, analyzeReport, shortfalls } from './lighthouse.js';
import { readinessFindings, parseRobots, parseSitemap } from './readiness.js';
/**
 * `apv web audit`: Lighthouse in headless Chrome on each page, mobile and desktop, N valid runs whose median is kept,
 * under the queue of the full suites and a machine load threshold; then the search and AI readiness checks. The
 * measure only reads the audited origin (Lighthouse loads the page as a browser does).
 */
/** Variable that marks the Lighthouse processes of an audit: its Chrome, detached by Lighthouse, is found by it and stopped. */
export const AUDIT_MARKER = 'APV_WEB_AUDIT';
const SUMMARY = 'summary.json';
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
/** File-safe name of a page path: `/` is `accueil`, `/a/b?x=1` is `a-b-x-1`. */
export function pageSlug(path) {
    const slug = path.replace(/^\/+/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 80);
    return slug || 'accueil';
}
// ---------------------------------------------------------------- fetching (the audited origin only)
const MAX_BYTES = 5 * 1024 * 1024;
/** Redirects followed, on the audited origin only. */
export const MAX_REDIRECTS = 5;
/** The body, read as a stream and bounded (the rest is never downloaded), decoded by its declared charset, BOM removed. */
async function readBounded(response) {
    const reader = response.body?.getReader();
    if (!reader)
        return '';
    const chunks = [];
    let size = 0;
    while (size < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done)
            break;
        chunks.push(value.subarray(0, MAX_BYTES - size));
        size += Math.min(value.byteLength, MAX_BYTES - size);
    }
    await reader.cancel().catch(() => undefined);
    const charset = /charset\s*=\s*"?([A-Za-z0-9._-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1] ?? 'utf-8';
    let decoder;
    try {
        decoder = new TextDecoder(charset);
    }
    catch {
        decoder = new TextDecoder('utf-8');
    }
    return decoder.decode(Buffer.concat(chunks)).replace(/^\uFEFF/, '');
}
/**
 * GET of a URL of the audited origin. Redirects are followed by hand, on the same origin only and 5 at most: a
 * redirect elsewhere is never followed (no third-party request), it is reported.
 */
async function fetchText(url, signal) {
    const origin = new URL(url).origin;
    const redirects = [];
    let current = url;
    const failed = (error, status = null) => ({ url: current, status, error, contentType: null, text: null, headers: null, redirects });
    try {
        for (;;) {
            const timeout = AbortSignal.timeout(20_000);
            const response = await fetch(current, { redirect: 'manual', headers: { 'user-agent': `apv-web-audit/${VERSION}`, accept: 'text/html,application/xml,text/plain,*/*' },
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
            const location = response.headers.get('location');
            if ([301, 302, 303, 307, 308].includes(response.status) && location) {
                await response.body?.cancel().catch(() => undefined);
                let next;
                try {
                    next = new URL(location, current);
                }
                catch {
                    return failed(`redirection vers une adresse invalide : ${location.slice(0, 200)}`, response.status);
                }
                if (next.origin !== origin)
                    return failed(`redirection hors de l'origine auditée vers ${next.href.slice(0, 200)} : non suivie`, response.status);
                if (redirects.length >= MAX_REDIRECTS)
                    return failed(`plus de ${MAX_REDIRECTS} redirections`, response.status);
                redirects.push(next.href);
                current = next.href;
                continue;
            }
            const text = response.status === 200 ? await readBounded(response) : (await response.body?.cancel().catch(() => undefined), null);
            return { url: current, status: response.status, error: null, contentType: response.headers.get('content-type'), text, headers: response.headers, redirects };
        }
    }
    catch (error) {
        return failed(errorMessage(error).slice(0, 200));
    }
}
/** The URL of a page on the audited origin; a path that would leave it is refused. */
export function pageUrl(path, origin) {
    const base = new URL(origin);
    let url;
    try {
        url = new URL(path, base);
    }
    catch {
        throw new PipelineError('WEB_PAGE', `Page invalide : ${path}`);
    }
    if (!path.startsWith('/') || path.includes('\\') || url.origin !== base.origin)
        throw new PipelineError('WEB_PAGE', `La page ${path} ne reste pas sur l'origine auditée ${base.origin} (${url.origin}) : refusée`);
    return url.href;
}
/** A URL of the audited origin: an absolute URL of another host keeps its path on the audited origin (never a third-party request). */
function onOrigin(url, origin) {
    try {
        const u = new URL(url, origin);
        const o = new URL(origin);
        if (u.origin === o.origin)
            return { url: u.href, moved: false };
        return { url: new URL(`${u.pathname}${u.search}`, o).href, moved: true };
    }
    catch {
        return { url, moved: false };
    }
}
export async function checkReadiness(options) {
    const { origin, settings } = options;
    const pages = [];
    for (const path of options.pages) {
        const url = pageUrl(path, origin);
        const r = await fetchText(url, options.signal);
        pages.push({ path, url, status: r.status, error: r.error, xRobotsTag: r.headers?.get('x-robots-tag') ?? null, html: r.redirects.length || r.error ? null : r.text,
            redirectedTo: !r.error && r.redirects.length ? r.redirects[r.redirects.length - 1] : null });
    }
    const text = (r) => ({ url: r.url, status: r.status, error: r.error, contentType: r.contentType, text: r.text });
    const robots = text(await fetchText(new URL('/robots.txt', origin).href, options.signal));
    const notes = [];
    const declared = robots.text !== null ? parseRobots(robots.text).sitemaps : [];
    const queue = declared.length ? declared : ['/sitemap.xml'];
    const sitemaps = [];
    const seen = new Set();
    while (queue.length && sitemaps.length < 20) {
        const { url, moved } = onOrigin(queue.shift(), origin);
        if (seen.has(url))
            continue;
        seen.add(url);
        if (moved)
            notes.push(`sitemap déclaré sur une autre origine, lu sur l'origine auditée : ${url}`);
        const r = text(await fetchText(url, options.signal));
        sitemaps.push(r);
        if (r.text !== null) {
            const parsed = parseSitemap(r.text);
            if (parsed.kind === 'sitemapindex')
                queue.push(...parsed.locs);
        }
    }
    let llms = null;
    if (settings.checks.llmsTxt !== 'off') {
        const url = new URL('/llms.txt', origin).href;
        llms = text(await fetchText(url, options.signal));
    }
    const result = readinessFindings({ origin, pages, robots, sitemaps, llms, checks: settings.checks, agents: settings.robotsAgents });
    return { findings: result.findings, notes: [...notes, ...result.notes] };
}
// ---------------------------------------------------------------- Lighthouse runs
/** Stops the processes an audit run left behind (Chrome, detached by Lighthouse), found by their marker. Never the session nor a tool. */
async function stopMarked(marker) {
    try {
        assertProcSupported();
    }
    catch {
        return 0;
    }
    const all = listProcesses();
    const session = sessionPids(all);
    const targets = markedProcesses(marker, all, '/proc', AUDIT_MARKER).filter(p => !session.has(p.pid) && protectedTool(p) === null);
    if (!targets.length)
        return 0;
    await stopProcesses(targets, { graceMs: 3000 });
    return targets.length;
}
/** Longest scratch folder given to Chrome as TMPDIR (its sockets and singleton files are created there). */
const MAX_TMPDIR = 60;
/** Where the scratch folder of the runs goes: the temporary folder, or `/tmp` when that one's path is too long for Chrome's sockets. */
function scratchRoot() {
    const base = tmpdir();
    return base.length > 40 && process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : base;
}
async function lighthouseRun(options) {
    const { settings } = options;
    const out = join(options.workDir, options.name);
    const args = [...options.command.argv, options.url, '--output=json', '--output=html', `--output-path=${out}`,
        // Performance always runs: the document status and the metrics that make a measure valid come from it.
        `--only-categories=${[...new Set(['performance', ...settings.categories])].join(',')}`, `--locale=${settings.locale}`, '--quiet',
        ...(settings.chromeFlags.length ? [`--chrome-flags=${settings.chromeFlags.join(' ')}`] : []),
        ...(options.formFactor === 'desktop' ? ['--preset=desktop'] : [])];
    // Lighthouse runs in a scratch folder (chrome-launcher may leave its profile in the working directory under WSL).
    const result = await runProcess({
        command: args, cwd: options.workDir, timeoutMs: settings.timeoutMs, maxOutputBytes: 65_536,
        // TMPDIR: the scratch folder too, so that the Chrome profile and its temporary files go away with it; only when its
        // path is short, Chrome's sockets living there (a Unix socket path is limited to about 100 bytes).
        env: { ...options.env, CHROME_PATH: options.browser.path, ...(options.workDir.length <= MAX_TMPDIR ? { TMPDIR: options.workDir } : {}),
            [AUDIT_MARKER]: options.marker, npm_config_update_notifier: 'false' },
        ...(options.signal ? { signal: options.signal } : {}),
    });
    await stopMarked(options.marker);
    const json = `${out}.report.json`;
    const html = `${out}.report.html`;
    const expect = { url: options.url, formFactor: options.formFactor, categories: settings.categories, lighthouse: settings.lighthouse };
    if (result.status === 'cancelled')
        throw new PipelineError('CANCELLED', 'Audit interrompu');
    if (!existsSync(json)) {
        const why = result.status === 'timed_out' ? `Lighthouse arrêté après ${Math.round(settings.timeoutMs / 1000)} s (web.timeoutMs)`
            : result.status === 'spawn_error' ? `Lighthouse non lancé : ${result.stderr.slice(0, 300)}`
                : `Lighthouse sans rapport (code ${result.exitCode}) : ${result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`;
        const measure = analyzeReport(null, expect);
        measure.reasons.splice(0, measure.reasons.length, why);
        return { measure, json: null, html: null };
    }
    let report = null;
    try {
        report = JSON.parse(readFileSync(json, 'utf8'));
    }
    catch {
        report = null;
    }
    const measure = analyzeReport(report, expect);
    if (result.status === 'timed_out') {
        measure.valid = false;
        measure.reasons.push('Lighthouse arrêté au délai (web.timeoutMs)');
    }
    return { measure, json, html: existsSync(html) ? html : null };
}
/** The queue lock file of the full suites: absolute, or relative to the Git common directory of the repository. */
function queueFile(repo, lockFile) {
    if (isAbsolute(lockFile))
        return lockFile;
    const common = gitRead(repo, ['rev-parse', '--git-common-dir']);
    if (!common)
        throw new PipelineError('GIT', `Répertoire Git commun introuvable pour ${repo}`);
    return resolve(isAbsolute(common) ? common : resolve(repo, common), lockFile);
}
/**
 * The queue of the full suites around a measure (`suite.queue`), taken by the caller before anything else (before the
 * preview lock and its build): no suite runs while Lighthouse measures. Inside a full suite (`APV_SUITE_RUN`), the suite
 * already holds every place (a suite with a check that runs `apv web audit` takes them all, src/gates/run.ts): never
 * taken twice. Every place is taken (the whole queue, each numbered place of
 * `suite.queue.slots`, each declared stack), so that no suite runs beside the measure whatever `slots` says. `web.queue` false or the queue disabled: none.
 */
export async function enterAuditQueue(options) {
    if (options.env['APV_SUITE_RUN'])
        return { handle: null, record: { held: false, waitedMs: 0, reason: 'file tenue par la suite complète en cours (APV_SUITE_RUN)' } };
    if (!options.settings.queue || !options.suiteQueue.enabled) {
        return { handle: null, record: { held: false, waitedMs: 0, reason: options.settings.queue ? 'file des suites désactivée (suite.queue.enabled)' : 'web.queue désactivé' } };
    }
    const lockFile = queueFile(options.repo, options.suiteQueue.lockFile);
    mkdirSync(join(lockFile, '..'), { recursive: true });
    // The load is waited for run by run (runAudit): the queue alone here.
    const handle = await enterQueue({ lockFile, settings: { ...options.suiteQueue, maxLoad: undefined }, repo: options.repo, log: options.log, signal: options.signal,
        hooks: options.hooks, label: `apv web audit (${options.repo})`, purpose: 'mesure Lighthouse',
        // Every place of the queue: the whole queue, each numbered place, each stack (suite.queue.slots lets suites run side by side).
        places: queuePlaces(options.suiteQueue.slots, { used: [], declared: options.stackIds ?? [], all: true }) });
    return { handle, record: { held: true, waitedMs: handle.record.waitedMs, reason: `file des suites complètes (${lockFile})` } };
}
/** Name of an audit folder: only folders with such a name (and a summary) are ever removed by the retention. */
export const AUDIT_ID = /^\d{8}-\d{6}-(?:url|apercu)(?:-\d+)?$/;
/** Keeps the `keep` most recent audit folders of the reports folder; nothing else is touched. */
function prune(dir, keep) {
    let entries = [];
    try {
        entries = readdirSync(dir);
    }
    catch {
        return;
    }
    const audits = entries.filter(e => AUDIT_ID.test(e) && existsSync(join(dir, e, SUMMARY))).sort().reverse();
    for (const old of audits.slice(keep))
        rmSync(join(dir, old), { recursive: true, force: true });
}
const inside = (child, parent) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
/**
 * The reports folder: relative to the repository and inside it (symbolic links resolved), and holding no file tracked
 * by Git: it is emptied of its old audits and ignores itself (its own `.gitignore`, never written into a tracked folder).
 */
export function reportsFolder(repo, dir) {
    const root = realpathSync(repo);
    const target = resolve(root, dir);
    if (isAbsolute(dir) || !inside(target, root) || target === root)
        throw new PipelineError('WEB_REPORTS', `web.reportsDir doit être un dossier relatif, dans le dépôt : ${dir}`);
    let existing = target;
    while (!existsSync(existing))
        existing = dirname(existing);
    if (!inside(realpathSync(existing), root))
        throw new PipelineError('WEB_REPORTS', `web.reportsDir sort du dépôt par un lien symbolique : ${dir}`);
    const tracked = gitRead(root, ['ls-files', '-z', '--', relative(root, target)]);
    if (tracked)
        throw new PipelineError('WEB_REPORTS', `web.reportsDir contient des fichiers suivis par Git (${tracked.split('\0').filter(Boolean).slice(0, 3).join(', ')}) : choisir un dossier propre aux rapports, jamais un dossier versionné`);
    return target;
}
export async function runAudit(options) {
    const { settings, log } = options;
    const started = new Date();
    const pages = options.pages.map(path => ({ path, url: pageUrl(path, options.origin), results: [] }));
    const reportsRoot = reportsFolder(options.repo, settings.reportsDir);
    mkdirSync(reportsRoot, { recursive: true });
    // The reports ignore themselves, like the receipts: never committed, and a full suite's tree stays clean.
    if (!existsSync(join(reportsRoot, '.gitignore')))
        writeFileSync(join(reportsRoot, '.gitignore'), '# Rapports de apv web audit : jamais versionnés.\n*\n');
    let auditId = `${stamp(started)}-${options.source === 'preview' ? 'apercu' : 'url'}`;
    for (let i = 2; existsSync(join(reportsRoot, auditId)); i++)
        auditId = `${stamp(started)}-${options.source === 'preview' ? 'apercu' : 'url'}-${i}`;
    const auditDir = join(reportsRoot, auditId);
    mkdirSync(auditDir, { recursive: true });
    const maxLoad = settings.load.max ?? options.suiteMaxLoad ?? defaultMaxLoad();
    const summary = {
        tool: 'apv web audit', version: VERSION, ok: false, auditId, source: options.source, origin: options.origin, commit: options.commit,
        startedAt: started.toISOString(), finishedAt: '', lighthouse: null, browser: null, runs: options.runs, formFactors: options.formFactors,
        categories: settings.categories, thresholds: settings.thresholds, queue: options.queue ?? null,
        load: { max: maxLoad, atStart: null, highest: null, waitedMs: 0, refused: null },
        pages, readiness: { findings: [], notes: [] }, counts: { shortfalls: 0, invalid: 0, refused: 0, warnings: 0 }, reportsDir: auditDir,
    };
    log(`Contrôles de préparation à la recherche et aux IA sur ${options.origin}...`);
    summary.readiness = await checkReadiness(options);
    if (!options.readinessOnly) {
        const browser = findBrowser(settings.chrome, options.repo, options.env);
        const command = lighthouseCommand(options.repo, settings.lighthouse);
        summary.browser = browser;
        summary.lighthouse = { version: settings.lighthouse, command: command.argv.join(' '), source: command.source };
        const workDir = mkdtempSync(join(scratchRoot(), 'apv-web-'));
        const marker = `${auditId}-${process.pid}`;
        try {
            const readLoad = options.hooks?.loadAverage ?? (() => loadavg()[0] ?? 0);
            measure: for (const page of summary.pages) {
                for (const formFactor of options.formFactors) {
                    const valid = [];
                    const loads = [];
                    const result = { formFactor, valid: false, runs: [], invalid: [], median: null, shortfalls: [], opportunities: [], report: null, browser: null };
                    page.results.push(result);
                    for (let attempt = 1; valid.length < options.runs && attempt <= options.runs * 2; attempt++) {
                        // The budget is the time spent waiting for the load, not the time of the audit: measuring never uses it up.
                        const load = await waitForLoad(maxLoad, Math.max(0, settings.load.waitMs - summary.load.waitedMs), log, options.signal, options.hooks, 'measure');
                        summary.load.waitedMs += load.waitedMs;
                        if (load.exceeded) {
                            summary.load.refused = `charge moyenne sur 1 min à ${load.atStart.toFixed(2)}, au-dessus du seuil ${maxLoad} après ${Math.round(summary.load.waitedMs / 1000)} s d'attente en tout (web.load.waitMs)`;
                            result.invalid.push({ attempt, reasons: [`non mesuré : ${summary.load.refused}`] });
                            finish(result, valid, loads, page.path, formFactor);
                            break measure;
                        }
                        summary.load.atStart ??= load.atStart;
                        log(`Lighthouse ${page.path} (${formFactor}), passage ${attempt}...`);
                        const run = await lighthouseRun({ command, browser, url: page.url, formFactor, settings, workDir, name: `${pageSlug(page.path)}.${formFactor}.${attempt}`,
                            env: options.env, marker, signal: options.signal });
                        const after = readLoad();
                        summary.load.highest = Math.max(summary.load.highest ?? 0, load.atStart, after);
                        result.browser ??= run.measure.browser;
                        if (run.measure.valid) {
                            valid.push(run);
                            loads.push(load.atStart);
                        }
                        else {
                            result.invalid.push({ attempt, reasons: run.measure.reasons });
                            log(`  mesure invalide écartée : ${run.measure.reasons.join(' ; ')}`);
                        }
                    }
                    finish(result, valid, loads, page.path, formFactor);
                }
            }
            // Pages and devices left unmeasured by a load refusal: said, never counted as measured.
            if (summary.load.refused) {
                for (const page of summary.pages)
                    for (const formFactor of options.formFactors) {
                        if (!page.results.some(r => r.formFactor === formFactor)) {
                            page.results.push({ formFactor, valid: false, runs: [], invalid: [{ attempt: 0, reasons: [`non mesuré : ${summary.load.refused}`] }], median: null, shortfalls: [], opportunities: [], report: null, browser: null });
                        }
                    }
            }
        }
        finally {
            // Chrome first, then the caller releases the queue: nothing of the measure outlives it.
            await stopMarked(marker);
            rmSync(workDir, { recursive: true, force: true });
        }
    }
    /** Median, shortfalls and the representative report of the valid runs of one page and device. */
    function finish(result, valid, loads, path, formFactor) {
        result.valid = valid.length === options.runs;
        result.runs = valid.map((r, i) => ({ scores: r.measure.scores, metrics: r.measure.metrics, load: Math.round(loads[i] * 100) / 100, benchmarkIndex: r.measure.benchmarkIndex }));
        if (!valid.length)
            return;
        const agg = aggregate(valid.map(v => v.measure), settings.categories);
        result.median = { scores: agg.scores, metrics: agg.metrics };
        result.shortfalls = shortfalls(agg, settings.thresholds, settings.categories);
        const representative = valid[agg.representative];
        result.opportunities = representative.measure.opportunities;
        const base = `${pageSlug(path)}.${formFactor}`;
        copyFileSync(representative.json, join(auditDir, `${base}.report.json`));
        if (representative.html)
            copyFileSync(representative.html, join(auditDir, `${base}.report.html`));
        result.report = { json: `${base}.report.json`, html: representative.html ? `${base}.report.html` : null };
    }
    const results = summary.pages.flatMap(p => p.results);
    summary.counts = {
        shortfalls: results.reduce((n, r) => n + r.shortfalls.length, 0),
        invalid: results.filter(r => !r.valid).length,
        refused: summary.readiness.findings.filter(f => f.level === 'refuse').length,
        warnings: summary.readiness.findings.filter(f => f.level === 'warn').length,
    };
    summary.ok = summary.counts.shortfalls === 0 && summary.counts.invalid === 0 && summary.counts.refused === 0 && !summary.load.refused;
    summary.finishedAt = new Date().toISOString();
    writeFileSync(join(auditDir, SUMMARY), `${JSON.stringify(summary, null, 2)}\n`);
    prune(reportsRoot, settings.keepAudits);
    return summary;
}
//# sourceMappingURL=audit.js.map