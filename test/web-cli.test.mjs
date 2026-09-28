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

test('apv web audit --preview --base: not required when every change is without web effect; otherwise the preview is built, audited and stopped', async t => {
  const port = await freePort();
  const p = project(t, { formFactors: ['mobile'], runs: 1 }, {
    preview: { dir: '../apercu', serve: { command: [process.execPath, 'site.cjs'], port, host: '127.0.0.1' }, health: { path: '/', timeoutSec: 20 } },
  });
  git(p.repo, 'branch', 'base');
  // HEAD equal to the base: nothing to compare, refused as an incorrect call.
  const same = await p.run(['--preview', '--base', 'base']);
  assert.equal(same.code, 2, same.stderr);
  assert.match(same.stderr, /--base base : la base commune de base et de [0-9a-f]{12} est [0-9a-f]{12} lui-même/);
  assert.equal((await p.run(['--preview', '--base', 'absente'])).code, 2);
  write(p.repo, 'test/web.test.mjs', '// test\n');
  write(p.repo, 'docs/notes.md', 'notes\n');
  git(p.repo, 'add', '.'); git(p.repo, 'commit', '-qm', 'tests et docs');
  const skip = await p.run(['--preview', '--base', 'base'], { });
  // test/ is not tests/: a file outside the list counts, prudence first.
  assert.equal(skip.code, 0, skip.stderr);
  assert.match(skip.stderr, /1 fichier\(s\) à effet web modifié\(s\) .*test\/web\.test\.mjs/);
  write(p.repo, '.apv/config.json', { web: { pages: ['/', '/faq'], load: { max: 10000 }, formFactors: ['mobile'], runs: 1, neutralPaths: ['test/**', 'docs/**'] },
    preview: { dir: '../apercu', serve: { command: [process.execPath, 'site.cjs'], port, host: '127.0.0.1' }, health: { path: '/', timeoutSec: 20 } } });
  git(p.repo, 'commit', '-qam', 'configuration');
  git(p.repo, 'branch', '-f', 'base');
  write(p.repo, 'test/autre.test.mjs', '// test\n');
  git(p.repo, 'add', 'test/autre.test.mjs'); git(p.repo, 'commit', '-qm', 'tests seulement');
  const calls = p.calls().length;
  const none = await p.run(['--preview', '--base', 'base']);
  assert.equal(none.code, 0, none.stderr);
  assert.match(none.stdout, /Aucun fichier à effet web modifié depuis [0-9a-f]{12} \(base commune avec base\) : 1 fichier\(s\) changé\(s\), tous dans web\.neutralPaths ; audit web non requis\./);
  assert.equal(p.calls().length, calls, 'nothing built nor measured');

  write(p.repo, 'src/hooks.server.ts', 'export const handle = ({ event, resolve }) => resolve(event);\n');
  git(p.repo, 'add', 'src/hooks.server.ts'); git(p.repo, 'commit', '-qm', 'serveur');
  const r = await p.run(['--preview', '--base', 'base', '--json']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const s = r.json();
  assert.deepEqual([s.source, s.origin, s.commit], ['preview', `http://127.0.0.1:${port}`, git(p.repo, 'rev-parse', 'HEAD')]);
  assert.match(r.stderr, /1 fichier\(s\) à effet web modifié\(s\) .*src\/hooks\.server\.ts/);
  assert.match(r.stderr, /Aperçu arrêté/);
  const status = await apv(p.repo, ['preview', 'status', '--json'], p.env);
  assert.equal(status.json().running, false, 'never a server left running');
  // In a full suite, --preview without --base is refused: the proof must say from which base the audit was required.
  const inSuite = await p.run(['--preview'], { APV_SUITE_RUN: 'essai' });
  assert.equal(inSuite.code, 2);
  assert.match(inSuite.stderr, /exige --base/);
});

test('runAudit: a machine load that stays above the threshold stops the measure; the valid measures already made are kept', async t => {
  const p = project(t);
  const origin = await serve(t, p.repo);
  let calls = 0;
  const settings = webSchema.parse({ pages: ['/', '/faq'], formFactors: ['mobile'], runs: 1, load: { max: 2, waitMs: 0 }, queue: false });
  const summary = await runAudit({ repo: p.repo, settings, suiteQueue: suiteQueueSchema.parse({}), suiteMaxLoad: undefined, origin, source: 'url', commit: null,
    pages: ['/', '/faq'], formFactors: ['mobile'], runs: 1, readinessOnly: false, env: { ...process.env, ...p.env }, log: () => {},
    hooks: { loadAverage: () => (++calls <= 2 ? 1 : 9), loadPollMs: 5 } });
  assert.equal(summary.ok, false);
  assert.match(summary.load.refused, /charge moyenne sur 1 min à 9\.00, au-dessus du seuil 2/);
  const [home, faq] = summary.pages.map(x => x.results[0]);
  assert.equal(home.valid, true, 'the measure made before the load rose is kept');
  assert.equal(home.median.scores.performance, 95);
  assert.equal(faq.valid, false);
  assert.match(faq.invalid[0].reasons[0], /non mesuré/);
  assert.equal(p.calls().length, 1);
  // The threshold of the full suites applies when the web section sets none; the budget is the time waited, not the audit's.
  const inherited = webSchema.parse({ pages: ['/'], load: { waitMs: 0 }, queue: false });
  const refused = await runAudit({ repo: p.repo, settings: inherited, suiteQueue: suiteQueueSchema.parse({}), suiteMaxLoad: 3, origin, source: 'url', commit: null,
    pages: ['/'], formFactors: ['mobile'], runs: 1, readinessOnly: false, env: { ...process.env, ...p.env }, log: () => {}, hooks: { loadAverage: () => 4, loadPollMs: 5 } });
  assert.match(refused.load.refused, /seuil 3/);
  const cli = await p.run(['--url', origin, '--page', '/', '--form-factor', 'mobile', '--runs', '1']);
  assert.equal(cli.code, 0, 'a calm machine measures');
});

test('apv web audit: redirects followed on the audited origin only, five at most; the reports folder is never a tracked one, the retention touches only audits', async t => {
  const p = project(t, { formFactors: ['mobile'], runs: 1, pages: ['/', '/faq', '/ancienne', '/boucle', '/dehors'] });
  const { handle } = await import(join(p.repo, 'site.cjs'));
  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(301, { location: '/robots-reel.txt' }); return res.end(); }
    if (req.url === '/robots-reel.txt') { req.url = '/robots.txt'; return handle(req, res); }
    if (req.url === '/ancienne') { res.writeHead(308, { location: '/faq' }); return res.end(); }
    if (req.url.startsWith('/boucle')) { res.writeHead(302, { location: `/boucle${req.url.length}` }); return res.end(); }
    if (req.url === '/dehors') { res.writeHead(301, { location: 'https://ailleurs.test/' }); return res.end(); }
    return handle(req, res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const r = await p.run(['--url', origin, '--readiness-only', '--json']);
  const findings = r.json().readiness.findings.filter(f => f.check === 'status' || f.check === 'robots').map(f => `${f.page} ${f.message}`);
  assert.ok(findings.some(f => /^\/ancienne page redirigée vers http:\/\/127\.0\.0\.1:\d+\/faq/.test(f)), findings.join('\n'));
  assert.ok(findings.some(f => /^\/boucle .*plus de 5 redirections/.test(f)), findings.join('\n'));
  assert.ok(findings.some(f => /^\/dehors .*redirection hors de l'origine auditée vers https:\/\/ailleurs\.test\/ : non suivie/.test(f)), findings.join('\n'));
  assert.ok(!findings.some(f => /robots\.txt/.test(f)), 'robots.txt reached through a same-origin redirect');
  // Retention: only folders named like an audit go; a tracked reports folder is refused before anything is written.
  write(p.repo, '.apv/web/a-garder/note.txt', 'à moi');
  for (let i = 0; i < 3; i++) await p.run(['--url', origin, '--readiness-only', '--page', '/']);
  write(p.repo, '.apv/config.json', { web: { pages: ['/'], load: { max: 10000 }, keepAudits: 1 } });
  await p.run(['--url', origin, '--readiness-only']);
  const left = readdirSync(join(p.repo, '.apv', 'web')).filter(e => e !== '.gitignore');
  assert.equal(left.filter(e => /^\d{8}-\d{6}-url/.test(e)).length, 1);
  assert.ok(left.includes('a-garder'));
  write(p.repo, 'rapports/suivi.txt', 'suivi'); git(p.repo, 'add', 'rapports/suivi.txt'); git(p.repo, 'commit', '-qm', 'dossier suivi');
  write(p.repo, '.apv/config.json', { web: { pages: ['/'], load: { max: 10000 }, reportsDir: 'rapports' } });
  const tracked = await p.run(['--url', origin, '--readiness-only']);
  assert.equal(tracked.code, 1);
  assert.match(tracked.stderr, /WEB_REPORTS.*suivis par Git/);
  assert.equal(existsSync(join(p.repo, 'rapports', '.gitignore')), false, 'no .gitignore written into a tracked folder');
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

test('apv gates verify recomputes « not required » from the commit: a skip proves nothing when the commit changes a file with a web effect', async t => {
  const p = project(t, { formFactors: ['mobile'], runs: 1, pages: ['/'] });
  const cli = new URL('../dist/cli.js', import.meta.url).pathname;
  // A check that runs the audit on the preview against the branch `base`; the preview is never built here (not required).
  const previewPort = await freePort();
  const config = async (command) => ({ web: { pages: ['/'], load: { max: 10000 } }, preview: { serve: { command: ['true'], port: previewPort } },
    gates: [{ id: 'web', stage: 'full', command, timeoutMs: 60000, passEnv: ['CHROME_PATH', 'APV_LOCK_DIR', 'HOME'] }] });
  write(p.repo, '.apv/config.json', await config([process.execPath, cli, 'web', 'audit', '--preview', '--base', 'base']));
  git(p.repo, 'add', '.'); git(p.repo, 'commit', '-qm', 'contrôle web');
  git(p.repo, 'branch', 'base');
  write(p.repo, 'docs/notes.md', 'notes\n');
  git(p.repo, 'add', '.'); git(p.repo, 'commit', '-qm', 'docs');
  const run = await apv(p.repo, ['gates', 'run', '--stage', 'full', '--json'], p.env);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const receipt = JSON.parse(readFileSync(join(p.repo, '.apv', 'receipts', run.json().runId, 'web.json'), 'utf8'));
  assert.deepEqual([receipt.web.required, receipt.web.auditId, receipt.web.reference, receipt.web.changed], [false, null, 'base', 1]);
  const ok = await apv(p.repo, ['gates', 'verify', '--commit', 'HEAD'], p.env);
  assert.equal(ok.code, 0, ok.stdout);

  // The same command, but its record claims « not required » for a commit that changes a server file: not proven.
  const forged = `require('node:fs').writeFileSync(process.env.APV_WEB_RECORD, JSON.stringify({ required: false, base: null, reference: 'base', files: [], changed: 0, auditId: null, ok: true }))`;
  write(p.repo, '.apv/config.json', await config([process.execPath, '-e', forged, 'web', 'audit', '--preview', '--base', 'base']));
  write(p.repo, 'src/hooks.server.ts', 'export {};\n');
  git(p.repo, 'add', '.'); git(p.repo, 'commit', '-qm', 'serveur');
  const run2 = await apv(p.repo, ['gates', 'run', '--stage', 'full'], p.env);
  assert.equal(run2.code, 0, run2.stdout + run2.stderr);
  const verify = await apv(p.repo, ['gates', 'verify', '--commit', 'HEAD', '--json'], p.env);
  assert.equal(verify.code, 1);
  const gate = verify.json().gates[0];
  assert.equal(gate.state, 'unaudited');
  assert.ok(gate.web.files.includes('src/hooks.server.ts') && gate.web.files.includes('.apv/config.json'), JSON.stringify(gate.web));
  assert.deepEqual(verify.json().auditing, ['web']);
  const text = await apv(p.repo, ['gates', 'verify', '--commit', 'HEAD'], p.env);
  assert.match(text.stdout, /web\s+audit web non prouvé/);
  assert.match(text.stdout, /Audit web non prouvé \(apv web audit --preview --base\)/);
  // A receipt without record (an older apv, another command) proves no skip either.
  write(p.repo, '.apv/config.json', await config([process.execPath, '-e', '0', 'web', 'audit', '--preview', '--base', 'base']));
  git(p.repo, 'commit', '-qam', 'sans relevé');
  await apv(p.repo, ['gates', 'run', '--stage', 'full'], p.env);
  const none = await apv(p.repo, ['gates', 'verify', '--commit', 'HEAD', '--json'], p.env);
  assert.match(none.json().gates[0].web.reason, /reçu sans relevé/);
});

test('apv web audit: the performance run always happens (document status, metrics), only the configured categories are judged', async t => {
  const p = project(t, { formFactors: ['mobile'], runs: 1, pages: ['/'], categories: ['seo'] });
  const origin = await serve(t, p.repo);
  p.plan({ '/': { performance: 0.5 } });
  const r = await p.run(['--url', origin, '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(p.calls()[0].args.includes('--only-categories=performance,seo'));
  assert.deepEqual(r.json().pages[0].results[0].median.scores, { seo: 100 });
});
