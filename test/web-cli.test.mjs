import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { runAudit } from '../dist/web/audit.js';
import { webSchema } from '../dist/web/config.js';
import { suiteQueueSchema } from '../dist/config/load.js';

/**
 * A stand-in for Lighthouse, installed as the project's dependency (node_modules/lighthouse, pinned version): it
 * writes a report for the URL from `lighthouse-plan.json` (scores, metrics, errors per page and pass), logs its call,
 * and leaves a detached child behind, as Chrome launched by Lighthouse would: the audit must stop it.
 */
const FAKE = String.raw`
const fs = require('node:fs'); const path = require('node:path'); const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith('--'));
const out = args.find(a => a.startsWith('--output-path=')).slice('--output-path='.length);
const desktop = args.includes('--preset=desktop');
const root = path.resolve(__dirname, '..', '..', '..');
const plan = JSON.parse(fs.readFileSync(path.join(root, 'lighthouse-plan.json'), 'utf8'));
const pathname = new URL(url).pathname;
const counter = path.join(root, 'lighthouse-calls.log');
const calls = fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const pass = calls.filter(c => c.url === url && c.desktop === desktop).length;
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
child.unref();
fs.appendFileSync(counter, JSON.stringify({ url, desktop, args, chrome: process.env.CHROME_PATH, marker: process.env.APV_WEB_AUDIT ?? null, child: child.pid, cwd: process.cwd() }) + '\n');
const entry = { performance: 0.95, lcp: 2000, ...(plan[pathname] ?? {}) };
const at = (value) => Array.isArray(value) ? value[pass % value.length] : value;
const failAt = entry.errorOnPass ?? [];
const report = {
  lighthouseVersion: '13.5.0', requestedUrl: url, mainDocumentUrl: url, finalDisplayedUrl: url, runWarnings: [],
  ...(failAt.includes(pass) ? { runtimeError: { code: 'NO_FCP', message: 'The page did not paint any content.' } } : {}),
  configSettings: { formFactor: desktop ? 'desktop' : 'mobile' },
  environment: { benchmarkIndex: 2000, hostUserAgent: 'HeadlessChrome/153.0.0.0' },
  categories: {
    performance: { score: at(entry.performance), auditRefs: [{ id: 'largest-contentful-paint', weight: 25, group: 'metrics' }, { id: 'render-blocking-insight', weight: 0, group: 'insights' }, { id: 'unused-javascript', weight: 0, group: 'diagnostics' }] },
    accessibility: { score: 1, auditRefs: [{ id: 'color-contrast', weight: 7, group: 'a11y-color-contrast' }] },
    'best-practices': { score: 1, auditRefs: [] }, seo: { score: 1, auditRefs: [] }, 'agentic-browsing': { score: 1, auditRefs: [] },
  },
  audits: {
    'first-contentful-paint': { numericValue: 900, score: 1, scoreDisplayMode: 'numeric' },
    'largest-contentful-paint': { numericValue: at(entry.lcp), score: 0.9, scoreDisplayMode: 'numeric', title: 'LCP' },
    'total-blocking-time': { numericValue: 100, score: 1, scoreDisplayMode: 'numeric' },
    'cumulative-layout-shift': { numericValue: 0.01, score: 1, scoreDisplayMode: 'numeric' },
    'speed-index': { numericValue: 1500, score: 1, scoreDisplayMode: 'numeric' },
    'render-blocking-insight': { title: 'Requêtes de blocage du rendu', score: 0, scoreDisplayMode: 'metricSavings', metricSavings: { FCP: 300, LCP: 450 }, displayValue: 'Économies estimées : 450 ms' },
    'unused-javascript': { title: 'Réduisez les ressources JavaScript inutilisées', score: 0.5, scoreDisplayMode: 'metricSavings', metricSavings: { LCP: 150 }, details: { type: 'opportunity', overallSavingsBytes: 105078 } },
    'color-contrast': { title: 'Contraste', score: 1, scoreDisplayMode: 'binary' },
    'network-requests': { score: 1, scoreDisplayMode: 'informative', details: { type: 'table', items: [{ url, statusCode: 200, resourceType: 'Document' }] } },
  },
};
fs.writeFileSync(out + '.report.json', JSON.stringify(report));
fs.writeFileSync(out + '.report.html', '<html>rapport</html>');
process.exit(report.runtimeError ? 1 : 0);
`;

/** The site served for the readiness checks: robots.txt, sitemap and two well-formed pages. */
const SITE = String.raw`
const pages = ['/', '/faq'];
const html = (p) => '<!doctype html><html lang="fr"><head><title>Titre ' + p + '</title><meta name="description" content="Description ' + p + '">'
  + '<link rel="canonical" href="https://site.exemple' + p + '"><script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite"}</script></head><body>ok</body></html>';
function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /prive\nSitemap: https://site.exemple/sitemap.xml\n'); }
  if (u.pathname === '/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); return res.end('<urlset>' + pages.map(p => '<url><loc>https://site.exemple' + p + '</loc></url>').join('') + '</urlset>'); }
  if (pages.includes(u.pathname)) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html(u.pathname)); }
  res.writeHead(404); res.end('absent');
}
module.exports = { handle };
if (require.main === module) require('node:http').createServer(handle).listen(Number(process.env.PORT), '127.0.0.1');
`;

async function freePort() {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise(r => server.close(r));
  return port;
}

async function serve(t, repo) {
  const { handle } = await import(join(repo, 'site.cjs'));
  const server = createServer(handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function project(t, web = {}, extra = {}) {
  const f = fixture(t, { files: { 'site.cjs': SITE, '.gitignore': 'node_modules/\ndist/\nlighthouse-*\n' } });
  write(f.repo, '.apv/config.json', { web: { pages: ['/', '/faq'], load: { max: 10000 }, ...web }, ...extra });
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'web');
  // The project's own Lighthouse, at the pinned version (node_modules/ is ignored by the fixture).
  write(f.repo, 'node_modules/lighthouse/package.json', { name: 'lighthouse', version: '13.5.0', bin: { lighthouse: 'cli/index.js' } });
  write(f.repo, 'node_modules/lighthouse/cli/index.js', FAKE);
  const env = { CHROME_PATH: process.execPath, APV_LOCK_DIR: join(f.root, 'locks'), APV_LOCK_POLL_MS: '20', APV_SUITE_RUN: '' };
  const plan = value => write(f.repo, 'lighthouse-plan.json', value);
  plan({});
  const calls = () => existsSync(join(f.repo, 'lighthouse-calls.log')) ? readFileSync(join(f.repo, 'lighthouse-calls.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  return { ...f, env, plan, calls, run: (args, more = {}) => apv(f.repo, ['web', 'audit', ...args], { ...env, ...more }) };
}

test('apv web audit --url: mobile and desktop, three passes, median kept, reports kept and ignored, Chrome left behind stopped', async t => {
  const p = project(t);
  const origin = await serve(t, p.repo);
  p.plan({ '/': { performance: [0.95, 0.70, 0.92], lcp: [2000, 4000, 2100] } });
  const r = await p.run(['--url', origin, '--json']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const s = r.json();
  assert.equal(s.ok, true);
  assert.deepEqual([s.source, s.origin, s.runs, s.formFactors, s.lighthouse.source, s.browser.source], ['url', origin, 3, ['mobile', 'desktop'], 'project', 'CHROME_PATH']);
  const home = s.pages.find(x => x.path === '/').results.find(x => x.formFactor === 'mobile');
  assert.equal(home.median.scores.performance, 92, 'the median, not the slow pass');
  assert.equal(home.median.metrics.lcp, 2100);
  assert.equal(home.runs.length, 3);
  assert.deepEqual(home.report, { json: 'accueil.mobile.report.json', html: 'accueil.mobile.report.html' });
  assert.ok(existsSync(join(s.reportsDir, 'accueil.mobile.report.html')) && existsSync(join(s.reportsDir, 'faq.desktop.report.json')));
  assert.deepEqual(JSON.parse(readFileSync(join(s.reportsDir, 'summary.json'), 'utf8')).ok, true);
  assert.equal(git(p.repo, 'status', '--porcelain', '--untracked-files=all'), '', 'the reports ignore themselves');
  const calls = p.calls();
  assert.equal(calls.length, 12, '2 pages x 2 devices x 3 passes');
  assert.equal(calls.filter(c => c.desktop).length, 6);
  for (const c of calls) {
    assert.equal(c.chrome, process.execPath);
    assert.ok(c.marker, 'the audit marks its processes');
    assert.ok(c.args.includes('--only-categories=performance,accessibility,best-practices,seo,agentic-browsing'));
    assert.ok(c.args.includes('--locale=fr') && c.args.includes('--chrome-flags=--headless=new') && c.args.includes('--quiet'));
    assert.ok(!c.cwd.startsWith(p.repo), 'Lighthouse runs in a scratch folder');
  }
  for (const c of calls) assert.equal(alive(c.child), false, `process ${c.child} left by a pass is stopped`);
  assert.equal(s.queue.held, true, 'the queue of the full suites is held while measuring');
  assert.deepEqual(s.readiness.findings, []);
});

test('apv web audit: a threshold missed is exit 1 with the table, the shortfall and the three main opportunities', async t => {
  const p = project(t, { formFactors: ['mobile'], runs: 1 });
  const origin = await serve(t, p.repo);
  p.plan({ '/faq': { performance: 0.8, lcp: 3200 } });
  const r = await p.run(['--url', origin]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /^page\s+appareil\s+perf\s+a11y\s+bp\s+seo\s+agent\s+FCP\s+LCP\s+TBT\s+CLS\s+SI/m);
  assert.match(r.stdout, /\/faq\s+mobile\s+80!\s+100\s+100\s+100\s+100\s+900 ms\s+3,2 s!/);
  assert.match(r.stdout, /\/faq \(mobile\) : performance 80 < 90 ; LCP 3,2 s > 2,5 s/);
  assert.match(r.stdout, /1\. Requêtes de blocage du rendu \(performance, render-blocking-insight\) : gain estimé FCP 300 ms, LCP 450 ms ; Économies estimées : 450 ms/);
  assert.match(r.stdout, /2\. Réduisez les ressources JavaScript inutilisées \(performance, unused-javascript\) : gain estimé LCP 150 ms ; 103 Kio en moins/);
  assert.doesNotMatch(r.stdout, /Contraste/, 'a passing audit is not an opportunity');
  assert.match(r.stdout, /Verdict : 2 seuil\(s\) manqué\(s\)\./);
  // Thresholds are the project's: relaxed, the same measure passes.
  write(p.repo, '.apv/config.json', { web: { pages: ['/', '/faq'], formFactors: ['mobile'], runs: 1, load: { max: 10000 }, thresholds: { categories: { performance: 80 }, metrics: { lcp: 3500 } } } });
  assert.equal((await p.run(['--url', origin])).code, 0);
});

test('apv web audit: an invalid pass is set aside and redone, never counted; still invalid, the measure is refused', async t => {
  const p = project(t, { formFactors: ['mobile'], pages: ['/'] });
  const origin = await serve(t, p.repo);
  p.plan({ '/': { errorOnPass: [0] } });
  const once = await p.run(['--url', origin]);
  assert.equal(once.code, 0, once.stdout + once.stderr);
  assert.match(once.stderr, /mesure invalide écartée : erreur Lighthouse NO_FCP/);
  assert.equal(p.calls().length, 4, 'one pass redone');
  p.plan({ '/': { errorOnPass: Array.from({ length: 40 }, (_, i) => i) } });
  const always = await p.run(['--url', origin, '--json']);
  assert.equal(always.code, 1);
  const result = always.json().pages[0].results[0];
  assert.deepEqual([result.valid, result.runs.length, result.invalid.length, result.median], [false, 0, 6, null], 'at most N extra passes');
  assert.equal(always.json().counts.invalid, 1);
});

test('apv web audit: calls refused, a project without web section, --production without its URL', async t => {
  const p = project(t);
  for (const args of [[], ['--url', 'https://a.test', '--preview'], ['--url', 'https://a.test', '--base', 'main'], ['--url', 'ftp://a.test'],
    ['--url', 'https://u:p@a.test'], ['--url', 'https://a.test', '--runs', '0'], ['--url', 'https://a.test', '--form-factor', 'tablet'], ['--url', 'https://a.test', '--page', 'faq']]) {
    const r = await p.run(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
  }
  const prod = await p.run(['--production']);
  assert.equal(prod.code, 1);
  assert.match(prod.stderr, /web\.productionUrl absent/);
  write(p.repo, '.apv/config.json', {});
  const none = await p.run(['--url', 'https://a.test']);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /WEB_NONE/);
});

test('apv web audit --readiness-only: the readiness refusals decide, no browser needed', async t => {
  const p = project(t, { pages: ['/', '/faq', '/absente'] });
  const origin = await serve(t, p.repo);
  const r = await p.run(['--url', origin, '--readiness-only', '--json'], { CHROME_PATH: '' });
  assert.equal(r.code, 1);
  const s = r.json();
  assert.equal(s.lighthouse, null);
  assert.deepEqual(s.readiness.findings.map(f => `${f.check} ${f.page}`), ['status /absente', 'sitemap /absente']);
  assert.match(s.readiness.notes.join(), /sitemap déclaré sur une autre origine, lu sur l'origine auditée/);
  assert.equal(p.calls().length, 0);
});

test('apv web audit --preview --base: nothing to audit without an interface change; with one, the preview is built, audited and stopped', async t => {
  const port = await freePort();
  const p = project(t, { formFactors: ['mobile'], runs: 1, paths: ['src/ui/**'] }, {
    preview: { dir: '../apercu', serve: { command: [process.execPath, 'site.cjs'], port, host: '127.0.0.1' }, health: { path: '/', timeoutSec: 20 } },
  });
  git(p.repo, 'branch', 'base');
  write(p.repo, 'src/math.mjs', 'export const add = (a, b) => a + b;\n');
  git(p.repo, 'commit', '-qam', 'hors interface');
  const skip = await p.run(['--preview', '--base', 'base']);
  assert.equal(skip.code, 0, skip.stderr);
  assert.match(skip.stdout, /Aucun fichier d'interface modifié depuis [0-9a-f]{12} \(base commune avec base, motifs web\.paths\) : audit web non requis\./);
  assert.equal(p.calls().length, 0);

  write(p.repo, 'src/ui/Button.svelte', '<button>ok</button>\n');
  git(p.repo, 'add', '.'); git(p.repo, 'commit', '-qm', 'interface');
  const r = await p.run(['--preview', '--base', 'base', '--json']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const s = r.json();
  assert.deepEqual([s.source, s.origin, s.commit], ['preview', `http://127.0.0.1:${port}`, git(p.repo, 'rev-parse', 'HEAD')]);
  assert.match(r.stderr, /1 fichier\(s\) d'interface modifié\(s\) .*src\/ui\/Button\.svelte/);
  assert.match(r.stderr, /Aperçu arrêté/);
  assert.equal(p.calls().length, 2);
  const status = await apv(p.repo, ['preview', 'status', '--json'], p.env);
  assert.equal(status.json().running, false, 'never a server left running');
});

test('runAudit: a machine load above the threshold refuses the measure instead of measuring under load', async t => {
  const p = project(t);
  const origin = await serve(t, p.repo);
  const settings = webSchema.parse({ pages: ['/'], load: { max: 2, waitMs: 0 }, queue: false });
  await assert.rejects(runAudit({ repo: p.repo, settings, suiteQueue: suiteQueueSchema.parse({}), suiteMaxLoad: undefined, origin, source: 'url', commit: null,
    pages: ['/'], formFactors: ['mobile'], runs: 1, readinessOnly: false, env: { ...process.env, ...p.env }, log: () => {}, hooks: { loadAverage: () => 9, loadPollMs: 5 } }),
  e => e.code === 'WEB_LOAD' && /mesure refusée/.test(e.message));
  assert.equal(p.calls().length, 0, 'nothing measured');
  // The threshold of the full suites applies when the web section sets none.
  const inherited = webSchema.parse({ pages: ['/'], load: { waitMs: 0 }, queue: false });
  await assert.rejects(runAudit({ repo: p.repo, settings: inherited, suiteQueue: suiteQueueSchema.parse({}), suiteMaxLoad: 3, origin, source: 'url', commit: null,
    pages: ['/'], formFactors: ['mobile'], runs: 1, readinessOnly: false, env: { ...process.env, ...p.env }, log: () => {}, hooks: { loadAverage: () => 4, loadPollMs: 5 } }),
  e => e.code === 'WEB_LOAD' && /seuil 3/.test(e.message));
  assert.ok(readdirSync(join(p.repo, '.apv', 'web')).length >= 1);
});

test('a web check in the full suite: the audit runs as a gate with its receipt, inside the queue the suite already holds', async t => {
  const p = project(t, { formFactors: ['mobile'], runs: 1, pages: ['/'] });
  const origin = await serve(t, p.repo);
  const cli = new URL('../dist/cli.js', import.meta.url).pathname;
  write(p.repo, '.apv/config.json', {
    web: { pages: ['/'], formFactors: ['mobile'], runs: 1, load: { max: 10000 } },
    gates: [{ id: 'web', stage: 'full', command: [process.execPath, cli, 'web', 'audit', '--url', origin], timeoutMs: 120000, passEnv: ['CHROME_PATH', 'APV_LOCK_DIR', 'APV_LOCK_POLL_MS', 'HOME'] }],
  });
  git(p.repo, 'add', '.'); git(p.repo, 'commit', '-qm', 'contrôle web');
  const r = await apv(p.repo, ['gates', 'run', '--stage', 'full', '--json'], p.env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const gate = r.json().gates.find(g => g.gate === 'web');
  assert.equal(gate.status, 'passed');
  const receipt = JSON.parse(readFileSync(join(p.repo, '.apv', 'receipts', r.json().runId, 'web.json'), 'utf8'));
  assert.equal(receipt.status, 'passed');
  assert.match(`${receipt.key} ${receipt.configHash}`, /^[a-f0-9]{64} [a-f0-9]{64}$/, 'a receipt with its proof key and configuration fingerprint, like any check');
  const verify = await apv(p.repo, ['gates', 'verify', '--commit', 'HEAD'], p.env);
  assert.equal(verify.code, 0, verify.stdout + verify.stderr);
  const [summary] = readdirSync(join(p.repo, '.apv', 'web')).filter(d => d !== '.gitignore').map(d => JSON.parse(readFileSync(join(p.repo, '.apv', 'web', d, 'summary.json'), 'utf8')));
  assert.deepEqual([summary.queue.held, /APV_SUITE_RUN/.test(summary.queue.reason)], [false, true], 'the suite holds the queue: never waited for twice');
});
