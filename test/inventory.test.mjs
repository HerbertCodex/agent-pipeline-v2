import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildInventory, diffInventory, inventoryForAgents, inventoryMarkdown } from '../dist/knowledge/inventory.js';
import { inspectRepository } from '../dist/knowledge/repository.js';
import { validateConfig } from '../dist/domain/contracts.js';

const run = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
};
function repo(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'apv2-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  run(root, 'init', '-q'); run(root, 'config', 'user.email', 'test@example.com'); run(root, 'config', 'user.name', 'Test');
  return { root, commit: (more) => { for (const [path, content] of Object.entries(more)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); } run(root, 'add', '-A'); run(root, 'commit', '-qm', 'snapshot'); return run(root, 'rev-parse', 'HEAD'); }, files };
}
const find = (inv, name) => inv.symbols.find(s => s.name === name);

test('inventory recognises languages by declarative profiles and public surface rules', async (t) => {
  const r = repo(t); const sha = r.commit({
    'src/loans.ts': 'export function borrowBook() {}\nconst internalHelper = 1;\nexport type Loan = { id: number };\nexport class LoanService {}\n',
    'src/loans.test.ts': 'export function testOnlyHelper() {}\n',
    'app/models.py': 'def public_fn():\n    pass\ndef _private_fn():\n    pass\nclass Book:\n    pass\n',
    'cmd/main.go': 'package main\nfunc Exported() {}\nfunc helper() {}\nfunc (s *Server) Serve() {}\ntype Server struct{}\n',
    'core/lib.rs': 'pub fn visible() {}\nfn hidden() {}\npub struct Shelf;\n',
  });
  const inv = await buildInventory(r.root, 'HEAD');
  assert.equal(inv.sha, sha);
  assert.deepEqual(inv.languages.map(l => l.id).sort(), ['ecmascript', 'go', 'python', 'rust']);
  assert.equal(find(inv, 'borrowBook').exported, true);
  assert.equal(find(inv, 'internalHelper').exported, false);
  assert.equal(find(inv, 'Loan').kind, 'type');
  assert.equal(find(inv, 'testOnlyHelper').test, true);
  assert.equal(find(inv, 'public_fn').exported, true);
  assert.equal(find(inv, '_private_fn').exported, false);
  assert.equal(find(inv, 'Exported').exported, true);
  assert.equal(find(inv, 'helper').exported, false);
  assert.equal(find(inv, 'Serve').kind, 'method');
  assert.equal(find(inv, 'visible').exported, true);
  assert.equal(find(inv, 'hidden').exported, false);
  const agents = inventoryForAgents(inv);
  assert.ok(agents.exported.some(x => x.name === 'borrowBook'));
  assert.equal(agents.exported.some(x => x.name === 'testOnlyHelper'), false);
});

test('technologies without a declaration grammar become file-level units, never invisible', async (t) => {
  const r = repo(t); r.commit({
    'ui/components/BookCard.widget': '<template>{title}</template>\n',
    'ui/styles/theme.sheet': '.shelf { color: navy }\n',
    'docs/guide.md': '# Guide\n', 'config/app.yaml': 'port: 3000\n',
    'assets/logo.bin': Buffer.from([0, 1, 2, 3, 0, 255]),
    'Makefile': 'all:\n\techo ok\n', '.hidden.widget': 'x\n',
  });
  const inv = await buildInventory(r.root, 'HEAD');
  assert.deepEqual(inv.units.map(u => u.path), ['ui/components/BookCard.widget', 'ui/styles/theme.sheet']);
  assert.equal(inv.units[0].name, 'BookCard');
  assert.deepEqual(inv.unitExtensions, ['sheet', 'widget']);
});

test('a project profile turns an unknown technology into declarations without controller changes', async (t) => {
  const r = repo(t); r.commit({ 'ui/Shelf.widget': 'component Shelf\nprivate component Draft\n' });
  const languages = [{ id: 'widget-dsl', extensions: ['widget'], prefilter: 'component', declarations: [
    { kind: 'component', pattern: '^(?<hidden>private\\s+)?component\\s+(?<name>\\w+)', exported: 'unless-hidden' }] }];
  const config = validateConfig({ schemaVersion: 1, executionMode: 'local-trusted', environment: { id: 'test' }, agent: { type: 'command', command: ['true'] }, gates: [{ id: 'g', command: ['true'] }], knowledge: { languages } });
  const inv = await buildInventory(r.root, 'HEAD', { languages: config.knowledge.languages });
  assert.deepEqual(inv.units, []);
  assert.equal(find(inv, 'Shelf').exported, true);
  assert.equal(find(inv, 'Draft').exported, false);
  await assert.rejects(buildInventory(r.root, 'HEAD', { languages: [{ ...languages[0], declarations: [{ kind: 'component', pattern: '^component\\s+(\\w+)', exported: 'always' }] }] }), /named group "name"/);
});

test('inventory delta surfaces new public surface and possible duplicates across naming conventions', async (t) => {
  const r = repo(t);
  const base = r.commit({ 'src/dates.ts': 'export function formatDate() {}\n', 'ui/LoanBadge.widget': 'x\n' });
  const candidate = r.commit({ 'src/feature/report.ts': 'export function format_date() {}\nexport function buildReport() {}\n', 'ui/feature/LoanBadge.widget': 'y\n' });
  const delta = diffInventory(await buildInventory(r.root, base), await buildInventory(r.root, candidate));
  assert.deepEqual(delta.added.map(x => x.name).sort(), ['LoanBadge', 'buildReport', 'format_date']);
  assert.deepEqual(delta.possibleDuplicates.map(x => `${x.added.path}~${x.existing.path}`).sort(), ['src/feature/report.ts~src/dates.ts', 'ui/feature/LoanBadge.widget~ui/LoanBadge.widget']);
  assert.deepEqual(delta.removed, []);
});

test('repository intelligence exposes the whole inventory and ranks identifiers by their words', async (t) => {
  const r = repo(t); const sha = r.commit({ 'src/loans.ts': 'export function borrowBook() {}\nexport function unrelatedThing() {}\n', 'package.json': '{}\n', 'docs/ARCHITECTURE.md': '# A\n' });
  const ri = await inspectRepository(r.root, sha, 'borrow a book');
  assert.equal(ri.reuseCandidates[0].name, 'borrowBook');
  assert.ok(ri.inventory.exported.some(x => x.name === 'unrelatedThing'));
  assert.deepEqual(ri.manifests, ['package.json']);
  assert.deepEqual(ri.architectureFiles, ['docs/ARCHITECTURE.md']);
  const md = inventoryMarkdown(await buildInventory(r.root, sha));
  assert.match(md, new RegExp(sha));
  assert.match(md, /`borrowBook` \(function, L1\)/);
});

test('repository indexing code stays stack-agnostic: no framework is named in the controller', () => {
  const source = ['languages.ts', 'inventory.ts', 'repository.ts'].map(f => readFileSync(new URL(`../src/knowledge/${f}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(source, /\b(svelte|sveltekit|react|next\.?js|vue|nuxt|angular|django|flask|fastapi|rails|laravel|spring|nestjs|express|flutter)\b/i);
});
