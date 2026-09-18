/** Offline browser acceptance checks. Use an installed Playwright and Chromium; never downloads tools. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { makeLifecycleFixture, git } from '../examples/lifecycle-fixture.mjs';
import { Lifecycle } from '../dist/index.js';
import { startUi } from '../dist/ui/server.js';

const { values } = parseArgs({ options: { output: { type: 'string' } } });
const moduleUrl = process.env.APV2_PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.APV2_PLAYWRIGHT_MODULE)).href : 'playwright';
const { chromium } = await import(moduleUrl);
const launch = { headless: true, ...(process.env.APV2_CHROMIUM_EXECUTABLE ? { executablePath: process.env.APV2_CHROMIUM_EXECUTABLE } : {}) };
const root = mkdtempSync(join(tmpdir(), 'apv2-quality-browser-'));
const f = makeLifecycleFixture(root), life = new Lifecycle(f.state);
let server, browser;
const output = resolve(values.output ?? join(tmpdir(), 'apv2-quality-browser-results'));
mkdirSync(output, { recursive: true });
try {
  mkdirSync(join(f.repo, 'ui'));
  writeFileSync(join(f.repo, 'ui/card.html'), '<!doctype html><title>Fixture</title><button>Old label</button>');
  writeFileSync(join(f.repo, 'test/browser.mjs'), `import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path';
const {chromium} = await import(${JSON.stringify(moduleUrl)});
const browser = await chromium.launch(${JSON.stringify(launch)});
try { const page = await browser.newPage(); await page.goto(pathToFileURL(resolve('ui/card.html')).href);
  assert.equal(await page.getByRole('button').textContent(), 'Borrow');
  await page.getByRole('button').focus(); assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BUTTON');
} finally { await browser.close(); }`);
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'Browser fixture baseline');
  const worker = join(root, 'edit.mjs');
  writeFileSync(worker, `import {readFileSync,writeFileSync} from 'node:fs';
JSON.parse(readFileSync(0,'utf8')); writeFileSync('ui/card.html','<!doctype html><title>Fixture</title><button>Borrow</button>');
console.log(JSON.stringify({summary:'Updated the existing button label.'}));`);
  const config = { ...f.config, agent: { type: 'command', command: [process.execPath, worker] },
    workflow: { ...f.config.workflow, qualityReview: 'evidence' },
    gates: f.config.gates.map(g => ({ ...g, covers: g.id === 'unit' ? ['unit'] : [] })) };
  const draft = async (title, cfg) => {
    let d = await life.draft({ repo: f.repo, config: cfg, request: 'Update the existing button label.',
      compactTask: { id: 'LABEL', title, description: 'Change the button text to Borrow.',
        acceptance: ['The button displays Borrow and remains focusable.'], allowedPaths: ['ui/card.html'] } });
    d = await life.approveSpec(d.id, life.summary(d).hash, 'Browser Fixture', 'Approve the local fixture label change.');
    return life.run(d.id);
  };
  const missing = await draft('Browser proof missing', config);
  assert.equal(missing.data.error?.code, 'QA_EVIDENCE');
  assert.equal(missing.data.qaRepairs, 0);
  const proved = await draft('Browser proof present', { ...config, gates: [...config.gates, {
    id: 'browser', command: [process.execPath, 'test/browser.mjs'], covers: ['browser'], testPaths: ['test/browser.mjs'],
    paths: ['ui/**'], lanes: ['high'], timeoutMs: 30000,
  }] });
  assert.equal(proved.data.status, 'awaiting_review', JSON.stringify(proved.data.error));
  assert.equal(proved.data.qa, null, 'compact UI requires execution evidence, not another model call');
  assert.equal(life.pipeline.store.get(proved.data.attempts[0].runId).receipts.find(r => r.gateId === 'browser').status, 'passed');
  assert.ok(['passed', 'cached'].includes(life.pipeline.store.get(proved.data.finalRunId).receipts.find(r => r.gateId === 'browser').status));
  server = await startUi({ stateDir: f.state, port: 0 });
  browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(server.url).origin ? route.continue() : route.abort());
  await page.goto(server.url);
  await page.goto(`${new URL(server.url).origin}/#${missing.id}`);
  await page.getByRole('button', { name: 'Examiner les preuves', exact: true }).click();
  await page.getByText('preuve requise absente', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Revalider', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: "Reprendre l'exécution", exact: true }).count(), 0);
  await page.screenshot({ path: join(output, 'missing-proof-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'QA', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('tab', { name: 'QA', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByText('preuve requise absente', { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'missing-proof-mobile.png'), fullPage: true });
  await page.goto(`${new URL(server.url).origin}/#${proved.id}`);
  await page.getByRole('tab', { name: 'QA', exact: true }).click();
  await page.getByText('Contrôles du candidat', { exact: true }).waitFor();
  assert.equal(await page.getByText('preuve requise absente', { exact: true }).count(), 0);
  assert.ok(await page.getByText('preuve présente', { exact: true }).count() >= 2);
  assert.deepEqual(errors, []);
  const result = { passed: true, browser: await browser.version(), network: 'localhost only', realProviderCalls: false,
    checks: ['missing browser blocks compact run without repair', 'runner executes actual Chromium gate',
      'compact browser evidence without model QA', 'missing proof visible before final run', 'desktop and mobile rendering',
      'keyboard QA navigation', 'no invalid revalidate action', 'successful proof visible', 'no browser runtime errors'] };
  writeFileSync(join(output, 'browser.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close(); await server?.close(); life.close(); rmSync(root, { recursive: true, force: true });
}
