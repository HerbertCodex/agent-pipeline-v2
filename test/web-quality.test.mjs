import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeReport, aggregate, median, opportunities, shortfalls, samePage } from '../dist/web/lighthouse.js';
import { webSchema, webThresholdsSchema, webIssues } from '../dist/web/config.js';
import { webImpact, webAuditGate, auditBase } from '../dist/web/impact.js';
import { lighthouseCommand } from '../dist/web/chrome.js';
import { pageUrl, reportsFolder } from '../dist/web/audit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseRobots, robotsAllows, parseSitemap, parseHead, jsonLdIssues, readinessFindings } from '../dist/web/readiness.js';
import { configIssues } from '../dist/config/load.js';

/** A real Lighthouse 13.5.0 mobile report, trimmed (details dropped) and anonymised. */
const REAL = JSON.parse(readFileSync(new URL('./fixtures/web/lhr-mobile.json', import.meta.url), 'utf8'));
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo', 'agentic-browsing'];
const expectation = (extra = {}) => ({ url: 'https://site.exemple/', formFactor: 'mobile', categories: CATEGORIES, lighthouse: '13.5.0', ...extra });
const clone = value => structuredClone(value);

/** A synthetic report: scores 0..1, metrics in ms (cls unitless), document status. */
function lhr({ scores = {}, metrics = {}, status = 200, url = 'https://site.exemple/', main = url, formFactor = 'mobile', version = '13.5.0', runtimeError, runWarnings = [] } = {}) {
  const s = { performance: 0.95, accessibility: 1, 'best-practices': 1, seo: 1, 'agentic-browsing': 1, ...scores };
  const m = { fcp: 1000, lcp: 2000, tbt: 100, cls: 0.01, si: 1500, ...metrics };
  const ids = { fcp: 'first-contentful-paint', lcp: 'largest-contentful-paint', tbt: 'total-blocking-time', cls: 'cumulative-layout-shift', si: 'speed-index' };
  return {
    lighthouseVersion: version, requestedUrl: url, mainDocumentUrl: main, finalDisplayedUrl: main, runWarnings, ...(runtimeError ? { runtimeError } : {}),
    configSettings: { formFactor }, environment: { benchmarkIndex: 2000, hostUserAgent: 'Mozilla/5.0 HeadlessChrome/153.0.0.0 Safari/537.36' },
    categories: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { id: k, score: v, auditRefs: [] }])),
    audits: {
      ...Object.fromEntries(Object.entries(ids).map(([k, id]) => [id, { id, numericValue: m[k], score: 1, scoreDisplayMode: 'numeric' }])),
      'network-requests': { id: 'network-requests', score: 1, scoreDisplayMode: 'informative', details: { type: 'table', items: [{ url: main, statusCode: status, resourceType: 'Document' }] } },
    },
  };
}

test('a real Lighthouse 13 report: valid measure, scores on 100, metrics, browser and the main opportunities', () => {
  const m = analyzeReport(REAL, expectation());
  assert.equal(m.valid, true, m.reasons.join('; '));
  assert.deepEqual(m.scores, { performance: 80, accessibility: 100, 'best-practices': 100, seo: 100, 'agentic-browsing': 100 });
  assert.deepEqual(Object.keys(m.metrics), ['fcp', 'lcp', 'tbt', 'cls', 'si']);
  assert.equal(m.metrics.tbt, 764);
  assert.equal(m.metrics.cls, 0.019);
  assert.deepEqual([m.statusCode, m.lighthouseVersion, m.formFactor, m.browser], [200, '13.5.0', 'mobile', 'HeadlessChrome/153.0.0.0']);
  assert.equal(m.opportunities.length, 3);
  // Ranked by the largest estimated saving: the main thread (TBT 750 ms) first; metrics themselves never listed.
  assert.equal(m.opportunities[0].id, 'mainthread-work-breakdown');
  assert.deepEqual(m.opportunities[0].savings, { TBT: 750 });
  assert.ok(m.opportunities.every(o => !['first-contentful-paint', 'total-blocking-time'].includes(o.id)));
  assert.ok(m.opportunities.every((o, i, all) => i === 0 || all[i - 1].savingsMs >= o.savingsMs));
});

test('an invalid measure is refused, never counted: NO_FCP, run warnings, HTTP status, redirect, missing score, other version or device', () => {
  const cases = [
    [lhr({ runtimeError: { code: 'NO_FCP', message: 'The page did not paint any content.' } }), /erreur Lighthouse NO_FCP/],
    [lhr({ runWarnings: ['The page may not be loading as expected because your test URL was redirected.'] }), /avertissement de mesure/],
    [lhr({ status: 404 }), /statut HTTP 404/],
    [lhr({ status: 500 }), /statut HTTP 500/],
    [lhr({ main: 'https://site.exemple/connexion' }), /redirection de https:\/\/site\.exemple\/ vers https:\/\/site\.exemple\/connexion/],
    [lhr({ scores: { performance: null } }), /score performance absent/],
    [lhr({ version: '12.8.0' }), /version de Lighthouse 12\.8\.0 au lieu de 13\.5\.0/],
    [lhr({ formFactor: 'desktop' }), /appareil desktop au lieu de mobile/],
  ];
  for (const [report, reason] of cases) {
    const m = analyzeReport(report, expectation());
    assert.equal(m.valid, false, String(reason));
    assert.ok(m.reasons.some(r => reason.test(r)), `${reason}: ${m.reasons.join(' | ')}`);
  }
  const noNetwork = clone(REAL); delete noNetwork.audits['network-requests'];
  assert.match(analyzeReport(noNetwork, expectation()).reasons.join(), /statut HTTP du document inconnu/);
  const noMetric = clone(REAL); delete noMetric.audits['largest-contentful-paint'];
  assert.match(analyzeReport(noMetric, expectation()).reasons.join(), /métrique LCP absente/);
  assert.equal(analyzeReport('pas un rapport', expectation()).valid, false);
  // Exact: a trailing slash or another query is another page (a redirect from /faq to /faq/ is a redirect).
  assert.ok(samePage('https://a.test/faq', 'https://a.test/faq'));
  assert.ok(!samePage('https://a.test/faq/', 'https://a.test/faq'));
  assert.ok(!samePage('https://a.test/faq?x=1', 'https://a.test/faq'));
});

test('median per category and per metric, and the run closest to the medians represents the page', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.throws(() => median([]));
  const runs = [
    lhr({ scores: { performance: 0.70 }, metrics: { lcp: 4000, tbt: 600 } }),
    lhr({ scores: { performance: 0.92 }, metrics: { lcp: 2100, tbt: 150 } }),
    lhr({ scores: { performance: 0.94 }, metrics: { lcp: 2000, tbt: 120 } }),
  ].map(r => analyzeReport(r, expectation()));
  const agg = aggregate(runs, CATEGORIES);
  assert.equal(agg.scores.performance, 92, 'one slow run does not decide the score');
  assert.equal(agg.metrics.lcp, 2100);
  assert.equal(agg.metrics.tbt, 150);
  assert.equal(agg.representative, 1);
});

test('thresholds: ambitious defaults, a category under its minimum, a metric over its maximum, null disables a metric', () => {
  const t = webThresholdsSchema.parse({});
  assert.deepEqual(t.categories, { performance: 90, accessibility: 100, 'best-practices': 100, seo: 100, 'agentic-browsing': 100 });
  assert.deepEqual(t.metrics, { lcp: 2500, tbt: 200, cls: 0.1, fcp: null, si: null });
  const result = { scores: { performance: 89, accessibility: 100, 'best-practices': 96, seo: 100, 'agentic-browsing': 100 }, metrics: { lcp: 2600, tbt: 200, cls: 0.12, fcp: 9000, si: 9000 } };
  assert.deepEqual(shortfalls(result, t, CATEGORIES).map(s => `${s.id}:${s.value}:${s.threshold}`),
    ['performance:89:90', 'best-practices:96:100', 'lcp:2600:2500', 'cls:0.12:0.1']);
  const relaxed = webThresholdsSchema.parse({ categories: { performance: 80 }, metrics: { cls: null, fcp: 1800 } });
  assert.equal(relaxed.categories.accessibility, 100, 'a category left out keeps its default');
  assert.deepEqual(shortfalls(result, relaxed, CATEGORIES).map(s => s.id), ['best-practices', 'fcp', 'lcp']);
  // Only the measured categories are judged.
  assert.deepEqual(shortfalls(result, t, ['accessibility']).filter(s => s.kind === 'category'), []);
});

test('the web section: defaults, validation and refusals of the common loader', () => {
  const web = webSchema.parse({ pages: ['/', '/faq'] });
  assert.deepEqual([web.lighthouse, web.runs, web.formFactors, web.categories.length, web.reportsDir, web.queue, web.locale, web.neutralPaths, web.paths],
    ['13.5.0', 3, ['mobile', 'desktop'], 5, '.apv/web', true, 'fr', ['tests/**', 'docs/**', '**/*.md', '.github/**'], []]);
  assert.deepEqual(web.checks, { status: 'refuse', robots: 'refuse', sitemap: 'refuse', canonical: 'refuse', title: 'refuse', description: 'refuse', lang: 'refuse', jsonLd: 'refuse', hreflang: 'refuse', llmsTxt: 'off' });
  assert.equal(web.load.max, undefined);
  for (const bad of [{ pages: [] }, { pages: ['faq'] }, { pages: ['//evil.test/'] }, { pages: ['/#x'] }, { pages: ['/'], lighthouse: 'latest' },
    { pages: ['/'], runs: 0 }, { pages: ['/'], formFactors: ['tablet'] }, { pages: ['/'], chromeFlags: ['--x --y'] }, { pages: ['/'], checks: { robots: 'maybe' } },
    { pages: ['/'], unknown: 1 }, { pages: ['/'], productionUrl: 'https://a.test/path' }]) {
    assert.throws(() => webSchema.parse(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(webIssues(webSchema.parse({ pages: ['/', '/'], paths: ['src/{a,b}/**'] })).length, 2);
  // Pages: a backslash or a second slash could leave the origin; refused by the schema, and by the resolved URL.
  for (const bad of ['/\\evil.test/', '/\\\\evil', '//evil.test']) assert.throws(() => webSchema.parse({ pages: [bad] }), undefined, bad);
  assert.equal(pageUrl('/faq?x=1', 'https://site.exemple'), 'https://site.exemple/faq?x=1');
  assert.throws(() => pageUrl('//evil.test/x', 'https://site.exemple'), e => e.code === 'WEB_PAGE');
  assert.throws(() => pageUrl('\\\\evil.test', 'https://site.exemple'), e => e.code === 'WEB_PAGE');
  // Chrome options that run another program or open the browser are refused; the reports folder stays relative, inside.
  for (const flag of ['--renderer-cmd-prefix=gdb', '--remote-debugging-address=0.0.0.0', '--load-extension=/x', '--user-data-dir=/tmp/x']) {
    assert.match(webIssues(webSchema.parse({ pages: ['/'], chromeFlags: [flag] })).join(), /web\.chromeFlags: --[a-z-]+ is refused/, flag);
  }
  assert.deepEqual(webIssues(webSchema.parse({ pages: ['/'], chromeFlags: ['--headless=new', '--no-sandbox'] })), []);
  for (const dir of ['/tmp/rapports', '../rapports', 'a/../../b', '.']) assert.match(webIssues(webSchema.parse({ pages: ['/'], reportsDir: dir })).join(), /web\.reportsDir/, dir);
  const ok = configIssues({ web: { pages: ['/'] } });
  assert.deepEqual(ok.issues, []);
  assert.deepEqual(ok.ignored, [], 'web is a read section, never reported as ignored');
  const dup = configIssues({ web: { pages: ['/', '/'] } });
  assert.match(dup.issues.map(i => i.message).join(), /web\.pages: duplicate page \//);
});

test('robots.txt: groups, the most specific agent, the longest rule, Allow on a tie, wildcards and sitemaps', () => {
  const robots = parseRobots(`# commentaire
User-agent: *
Disallow: /prive
Allow: /prive/public
Disallow: /*.pdf$

User-agent: GPTBot
User-agent: CCBot
Disallow: /

Sitemap: https://site.exemple/sitemap.xml
`);
  assert.deepEqual(robots.sitemaps, ['https://site.exemple/sitemap.xml']);
  assert.equal(robots.groups.length, 2);
  assert.equal(robotsAllows(robots, '*', '/').allowed, true);
  assert.equal(robotsAllows(robots, 'Googlebot', '/prive/x').allowed, false);
  assert.equal(robotsAllows(robots, 'Googlebot', '/prive/public/page').allowed, true, 'longest match wins');
  assert.equal(robotsAllows(robots, 'Googlebot', '/doc.pdf').allowed, false);
  assert.equal(robotsAllows(robots, 'Googlebot', '/doc.pdf?x').allowed, true, '$ anchors the end');
  assert.equal(robotsAllows(robots, 'gptbot', '/').allowed, false, 'agent tokens are case-insensitive');
  assert.equal(robotsAllows(robots, 'CCBot', '/faq').allowed, false);
  const tie = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a\n');
  assert.equal(robotsAllows(tie, '*', '/a').allowed, true);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow:\n'), '*', '/x').allowed, true, 'an empty Disallow allows all');
});

test('sitemaps and the server HTML: locs, head tags, entities, comments and scripts ignored', () => {
  const sm = parseSitemap('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://site.exemple/</loc></url><url><loc> https://site.exemple/faq?a=1&amp;b=2 </loc></url></urlset>');
  assert.deepEqual(sm, { kind: 'urlset', locs: ['https://site.exemple/', 'https://site.exemple/faq?a=1&b=2'] });
  assert.equal(parseSitemap('<sitemapindex><sitemap><loc>https://site.exemple/s1.xml</loc></sitemap></sitemapindex>').kind, 'sitemapindex');
  const head = parseHead(`<!doctype html><html lang="fr-FR" class="x"><head>
    <!-- <title>commentaire</title> -->
    <title> Mon titre &amp; plus </title>
    <meta name="description" content="Une description d&#39;essai">
    <meta name='robots' content='index, follow, max-image-preview:large'>
    <link rel="canonical" href="https://site.exemple/">
    <link rel="alternate" hreflang="fr" href="https://site.exemple/">
    <script>var t = "<title>faux</title>";</script>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Site"}</script>
    </head><body><svg><title>icône</title></svg></body></html>`);
  assert.equal(head.lang, 'fr-FR');
  assert.deepEqual(head.titles, ['Mon titre & plus']);
  assert.deepEqual(head.descriptions, ["Une description d'essai"]);
  assert.deepEqual(head.canonicals, ['https://site.exemple/']);
  assert.deepEqual(head.alternates, [{ hreflang: 'fr', href: 'https://site.exemple/' }]);
  assert.equal(head.jsonLd.length, 1);
  assert.deepEqual(head.robots, ['index, follow, max-image-preview:large']);
});

test('JSON-LD: parseable, @context and @type, @graph nodes typed', () => {
  assert.deepEqual(jsonLdIssues('{"@context":"https://schema.org","@type":"Organization"}'), []);
  assert.deepEqual(jsonLdIssues('[{"@context":"https://schema.org","@type":"FAQPage"}]'), []);
  assert.deepEqual(jsonLdIssues('{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":["Organization","Thing"]}]}'), []);
  assert.match(jsonLdIssues('{"@context":"https://schema.org","@type":"X",}').join(), /JSON-LD illisible/);
  assert.deepEqual(jsonLdIssues('{"@type":"WebSite"}'), ['JSON-LD sans @context']);
  assert.deepEqual(jsonLdIssues('{"@context":"https://schema.org"}'), ['JSON-LD sans @type']);
  assert.deepEqual(jsonLdIssues('{"@context":"https://schema.org","@graph":[{"name":"x"}]}'), ['JSON-LD : nœud 1 de @graph sans @type']);
});

const CHECKS = webSchema.parse({ pages: ['/'] }).checks;
const page = (path, head, extra = {}) => ({ path, url: `https://site.exemple${path}`, status: 200, error: null, xRobotsTag: null, html: `<html lang="fr"><head>${head}</head></html>`, ...extra });
const good = path => `<title>Titre ${path}</title><meta name="description" content="Description ${path}"><link rel="canonical" href="https://site.exemple${path}">`;
const text = (url, body, status = 200, contentType = 'text/plain') => ({ url, status, error: null, contentType, text: status === 200 ? body : null });
const ROBOTS = text('https://site.exemple/robots.txt', 'User-agent: *\nDisallow: /prive\nSitemap: https://site.exemple/sitemap.xml\n');
const SITEMAP = pages => text('https://site.exemple/sitemap.xml', `<urlset>${pages.map(p => `<url><loc>https://site.exemple${p}</loc></url>`).join('')}</urlset>`);
const readiness = (overrides = {}) => readinessFindings({ origin: 'https://site.exemple', pages: [page('/', good('/')), page('/faq', good('/faq'))], robots: ROBOTS,
  sitemaps: [SITEMAP(['/', '/faq'])], llms: null, checks: CHECKS, agents: ['*', 'Googlebot'], ...overrides });

test('readiness: a well-formed site passes; each check refuses what it guards', () => {
  const ok = readiness();
  assert.deepEqual(ok.findings, []);
  assert.match(ok.notes.join(), /aucune donnée structurée JSON-LD/);
  const cases = [
    [{ pages: [page('/', good('/')), page('/prive', good('/prive'))], sitemaps: [SITEMAP(['/', '/prive'])] }, 'robots', /interdit la page à \*/],
    [{ pages: [page('/', `${good('/')}<meta name="robots" content="noindex">`)] , sitemaps: [SITEMAP(['/'])] }, 'robots', /noindex/],
    [{ pages: [page('/', good('/'), { xRobotsTag: 'noindex, nofollow' })], sitemaps: [SITEMAP(['/'])] }, 'robots', /noindex/],
    [{ robots: text('https://site.exemple/robots.txt', '', 404) }, 'robots', /robots\.txt statut HTTP 404/],
    [{ robots: text('https://site.exemple/robots.txt', 'User-agent: *\nDisallow:\n') }, 'sitemap', /aucun sitemap déclaré/],
    [{ sitemaps: [SITEMAP(['/'])] }, 'sitemap', /page absente du sitemap/],
    [{ sitemaps: [text('https://site.exemple/sitemap.xml', '<html></html>')] }, 'sitemap', /ni <urlset> ni <sitemapindex>/],
    [{ pages: [page('/', '<meta name="description" content="d"><link rel="canonical" href="https://site.exemple/">')], sitemaps: [SITEMAP(['/'])] }, 'title', /<title> absente/],
    [{ pages: [page('/', good('/')), page('/faq', good('/').replace('https://site.exemple/', 'https://site.exemple/faq'))] }, 'title', /titre identique sur \/, \/faq/],
    [{ pages: [page('/', good('/')), page('/faq', good('/').replace('https://site.exemple/', 'https://site.exemple/faq'))] }, 'description', /description identique/],
    [{ pages: [page('/', '<title>T</title><link rel="canonical" href="https://site.exemple/">')], sitemaps: [SITEMAP(['/'])] }, 'description', /meta description absente/],
    [{ pages: [page('/', '<title>T</title><meta name="description" content="d">')], sitemaps: [SITEMAP(['/'])] }, 'canonical', /canonical"> absente/],
    [{ pages: [page('/', '<title>T</title><meta name="description" content="d"><link rel="canonical" href="/">')], sitemaps: [SITEMAP(['/'])] }, 'canonical', /pas une adresse absolue/],
    [{ pages: [page('/faq', good('/faq').replace('https://site.exemple/faq', 'https://site.exemple/'))], sitemaps: [SITEMAP(['/faq'])] }, 'canonical', /vers une autre page/],
    [{ pages: [page('/', good('/'), { html: `<html><head>${good('/')}</head></html>` })], sitemaps: [SITEMAP(['/'])] }, 'lang', /lang absent/],
    [{ pages: [page('/', `${good('/')}<script type="application/ld+json">{"@type":"WebSite"}</script>`)], sitemaps: [SITEMAP(['/'])] }, 'jsonLd', /sans @context/],
    [{ pages: [page('/', `${good('/')}<link rel="alternate" hreflang="en" href="https://site.exemple/en">`)], sitemaps: [SITEMAP(['/'])] }, 'hreflang', /ne se cite pas elle-même/],
    [{ pages: [page('/', `${good('/')}<link rel="alternate" hreflang="fr" href="https://site.exemple/"><link rel="alternate" hreflang="english" href="https://site.exemple/en">`)], sitemaps: [SITEMAP(['/'])] }, 'hreflang', /valeur hreflang invalide/],
    [{ pages: [page('/', `${good('/')}<link rel="alternate" hreflang="fr" href="https://site.exemple/"><link rel="alternate" hreflang="en" href="https://site.exemple/en">`),
      page('/en', `${good('/en')}<link rel="alternate" hreflang="en" href="https://site.exemple/en">`)], sitemaps: [SITEMAP(['/', '/en'])] }, 'hreflang', /\/en ne renvoie pas vers \//],
    [{ pages: [page('/', good('/'), { status: 301, html: null })], sitemaps: [SITEMAP(['/'])] }, 'status', /statut HTTP 301 \(redirection/],
    [{ llms: text('https://site.exemple/llms.txt', '', 404) }, 'llmsTxt', /llms\.txt statut HTTP 404/],
    [{ llms: text('https://site.exemple/llms.txt', 'Pas de titre') }, 'llmsTxt', /titre Markdown/],
  ];
  for (const [overrides, check, message] of cases) {
    const checks = { ...CHECKS, llmsTxt: 'refuse' };
    const { findings } = readiness({ ...overrides, checks });
    const hit = findings.find(f => f.check === check && message.test(f.message));
    assert.ok(hit, `${check} ${message}: ${JSON.stringify(findings)}`);
    assert.equal(hit.level, 'refuse');
  }
  // Modes: warn reports without refusing, off says nothing.
  const warn = readiness({ sitemaps: [SITEMAP(['/'])], checks: { ...CHECKS, sitemap: 'warn' } });
  assert.deepEqual(warn.findings.map(f => [f.check, f.level, f.page]), [['sitemap', 'warn', '/faq']]);
  assert.deepEqual(readiness({ sitemaps: [SITEMAP(['/'])], checks: { ...CHECKS, sitemap: 'off' } }).findings, []);
  // A preview whose sitemap names the production host: compared by path, never a false refusal.
  assert.deepEqual(readinessFindings({ origin: 'http://127.0.0.1:5190', pages: [{ ...page('/', good('/')), url: 'http://127.0.0.1:5190/' }], robots: ROBOTS,
    sitemaps: [SITEMAP(['/'])], llms: null, checks: CHECKS, agents: ['*'] }).findings, []);
});

test('robots.txt as Google reads it: BOM, product tokens, merged groups, percent-encoding; exact trailing slash', () => {
  const robots = parseRobots('\uFEFFUser-agent: Googlebot/2.1\nDisallow: /café\n\nUser-agent: googlebot\nDisallow: /b\n\nUser-agent: *\nDisallow: /tout\n');
  assert.equal(robots.groups[0].agents[0], 'googlebot', 'the BOM is not part of the first line, the version not part of the token');
  assert.equal(robotsAllows(robots, 'Googlebot', '/caf%C3%A9/menu').allowed, false, 'a raw UTF-8 rule matches the encoded path');
  assert.equal(robotsAllows(robots, 'Googlebot', '/caf%c3%a9').allowed, false, 'escapes compared in upper case');
  assert.equal(robotsAllows(robots, 'Googlebot', '/b').allowed, false, 'the groups of one agent are merged');
  assert.equal(robotsAllows(robots, 'Googlebot', '/tout').allowed, true, 'a named group replaces *');
  assert.equal(robotsAllows(robots, 'Bingbot', '/tout').allowed, false);
  const { findings } = readinessFindings({ origin: 'https://site.exemple', pages: [page('/faq', good('/faq').replace('https://site.exemple/faq', 'https://site.exemple/faq/'))], robots: ROBOTS,
    sitemaps: [SITEMAP(['/faq/'])], llms: null, checks: CHECKS, agents: ['*'] });
  assert.deepEqual(findings.map(f => f.check).sort(), ['canonical', 'sitemap'], '/faq/ is another URL than /faq');
  const redirected = readinessFindings({ origin: 'https://site.exemple', pages: [page('/ancienne', good('/ancienne'), { redirectedTo: 'https://site.exemple/faq', html: null })], robots: ROBOTS,
    sitemaps: [SITEMAP(['/ancienne'])], llms: null, checks: CHECKS, agents: ['*'] });
  assert.match(redirected.findings.map(f => f.message).join(), /page redirigée vers https:\/\/site\.exemple\/faq/);
});

test('audit required by default: any change outside the files without web effect; manifests, lock files, config and web.paths always count', () => {
  const settings = webSchema.parse({ pages: ['/'] });
  assert.deepEqual(webImpact(['tests/e2e/a.spec.ts', 'docs/guide.md', 'README.md', 'src/lib/README.md', '.github/workflows/ci.yml'], settings), { required: false, files: [] });
  for (const file of ['src/hooks.server.ts', 'src/routes/+page.ts', 'src/routes/+layout.ts', 'src/routes/api/+server.ts', 'src/lib/db.ts', 'svelte.config.js', 'vite.config.ts',
    'static/robots.txt', 'src/app.html', 'Makefile']) {
    assert.deepEqual(webImpact(['docs/x.md', file], settings), { required: true, files: [file] }, file);
  }
  const everything = webSchema.parse({ pages: ['/'], neutralPaths: ['**'], paths: ['docs/site/**'] });
  for (const file of ['.apv/config.json', 'package.json', 'apps/web/package.json', 'package-lock.json', 'pnpm-lock.yaml', 'docs/site/index.md']) {
    assert.equal(webImpact([file], everything).required, true, `${file} always counts, even in neutralPaths`);
  }
  assert.equal(webImpact(['src/x.ts'], everything).required, false);
  // The check that runs the audit, read from its argv.
  assert.deepEqual(webAuditGate(['apv', 'web', 'audit', '--preview', '--base', 'origin/main']), { base: 'origin/main' });
  assert.deepEqual(webAuditGate(['node', 'dist/cli.js', 'web', 'audit', '--preview', '--base=origin/main']), { base: 'origin/main' });
  assert.deepEqual(webAuditGate(['apv', 'web', 'audit', '--preview']), { base: null });
  assert.equal(webAuditGate(['apv', 'web', 'audit', '--url', 'https://a.test']), undefined);
  assert.equal(webAuditGate(['npm', 'test']), undefined);
});

test('the base of an audit: HEAD equal to or upstream of the reference is refused; the project Lighthouse only when it is the real package', t => {
  const root = mkdtempSync(join(tmpdir(), 'apv-web-base-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); writeFileSync(join(root, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'a');
  const first = git('rev-parse', 'HEAD');
  git('branch', 'ref');
  writeFileSync(join(root, 'b.txt'), '2'); git('add', '.'); git('commit', '-qm', 'b');
  const head = git('rev-parse', 'HEAD');
  assert.deepEqual(auditBase(root, 'ref', head), { ok: true, base: first, reference: first });
  assert.equal(auditBase(root, 'main', head).reason, 'not-behind', 'HEAD equal to the reference');
  assert.equal(auditBase(root, 'ref', first).reason, 'not-behind', 'HEAD upstream of the reference');
  assert.equal(auditBase(root, 'absente', head).reason, 'missing');
  // Lighthouse: an alias (npm:other) installed under node_modules/lighthouse is never run.
  const pkg = (name, version) => { mkdirSync(join(root, 'node_modules', 'lighthouse', 'cli'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'lighthouse', 'package.json'), JSON.stringify({ name, version, bin: { lighthouse: 'cli/index.js' } }));
    writeFileSync(join(root, 'node_modules', 'lighthouse', 'cli', 'index.js'), ''); };
  pkg('other', '13.5.0');
  assert.equal(lighthouseCommand(root, '13.5.0').source, 'npx');
  pkg('lighthouse', '13.4.0');
  assert.equal(lighthouseCommand(root, '13.5.0').source, 'npx', 'another version');
  pkg('lighthouse', '13.5.0');
  assert.equal(lighthouseCommand(root, '13.5.0').source, 'project');
  // Reports: inside the repository, never a tracked folder.
  mkdirSync(join(root, 'docs')); writeFileSync(join(root, 'docs', 'x.md'), 'x'); git('add', '.'); git('commit', '-qm', 'docs');
  assert.throws(() => reportsFolder(root, 'docs'), e => e.code === 'WEB_REPORTS' && /suivis par Git/.test(e.message));
  assert.throws(() => reportsFolder(root, '../ailleurs'), e => e.code === 'WEB_REPORTS');
  assert.equal(reportsFolder(root, '.apv/web'), join(execFileSync('realpath', [root], { encoding: 'utf8' }).trim(), '.apv', 'web'));
});
