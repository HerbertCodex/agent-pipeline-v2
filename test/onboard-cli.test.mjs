import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, decision, write } from './cli-helpers.mjs';
import { specTemplate } from '../dist/commands/spec.js';
import { detectGates, previewHints } from '../dist/onboard/detect.js';
import { specIdOf } from '../dist/onboard/v2.js';

const read = (repo, path) => readFileSync(join(repo, path), 'utf8');

/** Every file under a folder with its content: a before/after snapshot shows that nothing changed. */
function snapshot(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { out[`${path}/`] = ''; walk(path); } else out[path] = readFileSync(path, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/** Minimal V2 configuration shaped like the pilot project's pipeline.v2.json (read-only source). */
const v2Config = () => ({
  schemaVersion: 1,
  executionMode: 'local-trusted',
  environment: { id: 'local-linux-x64-node-24', passEnv: ['PATH', 'TMPDIR', 'LANG'] },
  agent: { type: 'claude', usageMode: 'subscription', command: [], timeoutMs: 1800000, model: 'claude-sonnet-5', effort: 'high', maxTurns: 200 },
  skills: { enabled: ['clean-code', 'security'], projectType: 'unknown', maxContextBytes: 16000 },
  knowledge: { languages: [] },
  roles: { product: null, qa: null, design: null },
  roleProfiles: [{ provider: 'claude', role: 'implementer', quick: { model: 'claude-sonnet-5', effort: 'high' }, deep: { model: 'claude-opus-5', effort: 'high' } }],
  workflow: { planningMode: 'adaptive', qualityReview: 'evidence', maxSpecCostUsd: 25 },
  feedback: { gateIds: ['test'], maxCalls: 12, maxTotalMs: 600000 },
  limits: { maxTaskContextChars: 200000, maxQaDiffBytes: 524288 },
  setup: [{ command: ['npm', 'ci', '--ignore-scripts'], timeoutMs: 300000, passEnv: ['HOME'] }],
  gates: [
    { id: 'diff-check', command: ['git', 'diff', '--check', '{{baseSha}}', '{{candidateSha}}'], lanes: ['fast', 'standard', 'high'], mandatory: true, cacheTtlMs: 0 },
    { id: 'test', command: ['npm', 'run', 'test'], covers: ['unit'], resources: ['project-checks'], mandatory: false },
    { id: 'integration', command: ['npm', 'run', 'test:integration'], covers: ['integration'], testPaths: ['tests/e2e/integration/**'], timeoutMs: 600000,
      passEnv: ['HOME', 'SUPABASE_TEST_URL'], resources: ['project-checks'] },
  ],
  validationRules: [],
  concurrency: 3,
  failFast: true,
  maxRunMs: 2700000,
  risk: { fastPaths: ['docs/**', '*.md'], highPaths: [], maxFastFiles: 5, maxFastLines: 100 },
});

const ledger = { schemaVersion: 1, decisions: [decision('langue-francais', { enforcement: 'bootstrap' }), decision('stack-sveltekit', { enforcement: 'bootstrap' })] };

function v2Fixture(t, files = {}) {
  const f = fixture(t, { files: {
    'pipeline.v2.json': `${JSON.stringify(v2Config(), null, 2)}\n`,
    '.agent-pipeline/DECISIONS.json': `${JSON.stringify(ledger, null, 2)}\n`,
    '.agent-pipeline/roles/qa.md': '# QA\n',
    'package.json': `${JSON.stringify({ scripts: { test: 'node --test', preview: 'vite preview' } }, null, 2)}\n`,
    'specs/accueil.json': `${JSON.stringify(specTemplate('Accueil'), null, 2)}\n`,
    'specs/cassee.json': `${JSON.stringify({ ...specTemplate('Cassée'), problem: undefined, extra: 1 }, null, 2)}\n`,
    'specs/notes.json': '{ "unrelated": true }\n',
    ...files,
  } });
  return f;
}

test('apv onboard takes over a V2 project: the read sections, the ledger as is, the valid specs', async t => {
  const f = v2Fixture(t);
  const r = await apv(f.repo, ['onboard', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = r.json();
  assert.deepEqual(out.created, ['.apv/', '.apv/config.json', '.apv/DECISIONS.json', '.apv/DECISIONS.md', '.apv/brief.md', '.apv/specs/', '.apv/state/', '.apv/.gitignore', '.apv/specs/accueil.json']);
  assert.deepEqual([out.dryRun, out.v2.config, out.v2.ledger, out.v2.notImported], [false, 'pipeline.v2.json', '.agent-pipeline/DECISIONS.json', ['.agent-pipeline/roles/']]);
  // Configuration: exactly the sections of spec section 14, as V2 wrote them.
  const v2 = v2Config();
  const config = JSON.parse(read(f.repo, '.apv/config.json'));
  assert.deepEqual(config, { name: 'repo', gates: v2.gates, risk: v2.risk, validationRules: [], skills: v2.skills, environment: { passEnv: v2.environment.passEnv } });
  assert.deepEqual(out.config.kept, ['gates', 'risk', 'validationRules', 'skills', 'environment.passEnv']);
  assert.deepEqual(out.config.ignored, ['agent', 'concurrency', 'environment.id', 'executionMode', 'failFast', 'feedback', 'knowledge', 'limits', 'maxRunMs',
    'roleProfiles', 'roles', 'schemaVersion', 'setup', 'workflow']);
  assert.deepEqual(out.config.gates, ['diff-check', 'test', 'integration']);
  // Ledger: the V2 file byte for byte, and its readable version.
  assert.equal(read(f.repo, '.apv/DECISIONS.json'), read(f.repo, '.agent-pipeline/DECISIONS.json'));
  assert.match(read(f.repo, '.apv/DECISIONS.md'), /langue-francais/);
  assert.deepEqual([out.ledger.status, out.ledger.source, out.ledger.decisions], ['imported', '.agent-pipeline/DECISIONS.json', 2]);
  // Specs: the valid one copied as is, the others listed with their reason.
  assert.deepEqual(out.specs.imported, [{ from: 'specs/accueil.json', to: '.apv/specs/accueil.json', request: null }]);
  assert.equal(read(f.repo, '.apv/specs/accueil.json'), read(f.repo, 'specs/accueil.json'));
  assert.deepEqual(out.specs.rejected.map(s => s.file), ['specs/cassee.json', 'specs/notes.json']);
  assert.match(out.specs.rejected[0].reasons.join('\n'), /problem/);
  assert.match(out.specs.rejected[1].reasons[0], /pas une spec/);
  assert.deepEqual(out.previewHints, ['package.json, script « preview » (vite preview)']);
  assert.ok(out.next.some(n => /apv gates run --base .*diff-check/.test(n)), 'the gate that needs a base is named');
  // The other commands now read .apv/: the ledger validates, nothing is reported ignored.
  const ledgerCheck = await apv(f.repo, ['ledger', 'validate', '--json']);
  assert.deepEqual([ledgerCheck.code, ledgerCheck.json().file, ledgerCheck.json().decisions], [0, '.apv/DECISIONS.json', 2]);
  const status = (await apv(f.repo, ['status', '--json'])).json();
  assert.deepEqual([status.config.file, status.config.legacy, status.config.ignored, status.config.error], ['.apv/config.json', false, [], null]);
  assert.equal((await apv(f.repo, ['spec', 'validate', '.apv/specs/accueil.json', '--draft'])).code, 0);
  // The V2 files are left in place.
  assert.equal(read(f.repo, 'pipeline.v2.json'), `${JSON.stringify(v2Config(), null, 2)}\n`);
});

test('apv onboard is idempotent: a second run changes nothing', async t => {
  const f = v2Fixture(t);
  assert.equal((await apv(f.repo, ['onboard'])).code, 0);
  const before = snapshot(join(f.repo, '.apv'));
  const again = await apv(f.repo, ['onboard', '--json']);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual([again.json().created, again.json().completed], [[], []]);
  assert.deepEqual([again.json().config.status, again.json().ledger.status], ['existing', 'existing']);
  assert.deepEqual(again.json().specs.existing, [{ from: 'specs/accueil.json', to: '.apv/specs/accueil.json' }]);
  assert.deepEqual(snapshot(join(f.repo, '.apv')), before);
  const text = await apv(f.repo, ['onboard']);
  assert.match(text.stdout, /Rien à créer : \.apv\/ est complet\./);
  assert.match(text.stdout, /existe déjà, inchangée/);
});

test('apv onboard --dry-run writes nothing and shows the same plan', async t => {
  const f = v2Fixture(t);
  const dry = await apv(f.repo, ['onboard', '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.ok(!existsSync(join(f.repo, '.apv')), 'nothing written');
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
  assert.match(dry.stdout, /Essai \(--dry-run\) : rien n'est écrit\./);
  assert.match(dry.stdout, /Serait créé : \.apv\/, \.apv\/config\.json, \.apv\/DECISIONS\.json/);
  assert.match(dry.stdout, /ignoré \(contrôleur V2 retiré\) : agent, concurrency, environment\.id/);
  assert.match(dry.stdout, /à copier : specs\/accueil\.json -> \.apv\/specs\/accueil\.json/);
  assert.match(dry.stdout, /1\. relancer sans --dry-run/);
  const plan = (await apv(f.repo, ['onboard', '--dry-run', '--json'])).json();
  const real = (await apv(f.repo, ['onboard', '--json'])).json();
  assert.deepEqual(plan.created, real.created);
  assert.deepEqual({ ...plan.config }, { ...real.config });
});

test('apv onboard completes a partial .apv/ and never parses a V2 file it does not need', async t => {
  const f = v2Fixture(t, { 'pipeline.v2.json': '{ broken', '.apv/config.json': '{ "gates": [] }\n', '.apv/.gitignore': 'mine/\n' });
  const r = await apv(f.repo, ['onboard', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = r.json();
  assert.equal(out.config.status, 'existing');
  assert.equal(read(f.repo, '.apv/config.json'), '{ "gates": [] }\n');
  assert.deepEqual(out.completed, ['.apv/.gitignore']);
  assert.equal(out.ledger.status, 'imported');
});

test('apv onboard without V2 proposes the detected gates, never mandatory', async t => {
  const f = fixture(t, { files: {
    'package.json': JSON.stringify({ scripts: { check: 'svelte-check', lint: 'eslint .', test: 'vitest run', build: 'vite build', 'test:e2e': 'playwright test', dev: 'vite dev' } }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'Makefile': 'lint:\n\techo make\n',
  } });
  const r = await apv(f.repo, ['onboard', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = r.json();
  assert.deepEqual([out.v2.config, out.v2.ledger, out.config.source, out.ledger.status], [null, null, 'detected', 'created']);
  const config = JSON.parse(read(f.repo, '.apv/config.json'));
  assert.deepEqual(config, { name: 'repo', gates: [
    { id: 'check', command: ['pnpm', 'run', 'check'], mandatory: false },
    { id: 'lint', command: ['pnpm', 'run', 'lint'], mandatory: false },
    { id: 'test', command: ['pnpm', 'run', 'test'], mandatory: false },
    { id: 'build', command: ['pnpm', 'run', 'build'], mandatory: false },
    { id: 'e2e', command: ['pnpm', 'run', 'test:e2e'], mandatory: false },
  ] });
  assert.match(out.config.detected[0].source, /package\.json, script « check » \(svelte-check\)/);
  assert.match(out.config.detected[0].note, /mandatory: false/);
  assert.deepEqual(JSON.parse(read(f.repo, '.apv/DECISIONS.json')), { schemaVersion: 1, decisions: [] });
  assert.equal((await apv(f.repo, ['ledger', 'validate'])).code, 0);
  const text = await apv(f.repo, ['onboard', '--dry-run']);
  assert.match(text.stdout, /\(sans V2\)/);
});

test('gate detection reads Makefile targets and pyproject tools, and invents nothing', t => {
  const make = fixture(t, { files: { 'Makefile': 'CC := gcc\ncheck:\n\tmypy .\ntest: build\n\tpytest\nbuild:\n\techo\n' } });
  assert.deepEqual(detectGates(make.repo).map(g => [g.id, g.command.join(' ')]), [['check', 'make check'], ['test', 'make test'], ['build', 'make build']]);
  const py = fixture(t, { files: { 'pyproject.toml': '[project]\nname = "x"\n\n[tool.ruff.lint]\nselect = ["E"]\n\n[tool.pytest.ini_options]\naddopts = "-q"\n', 'uv.lock': '' } });
  assert.deepEqual(detectGates(py.repo).map(g => [g.id, g.command.join(' ')]), [['lint', 'uv run ruff check .'], ['test', 'uv run python -m pytest']]);
  const empty = fixture(t);
  assert.deepEqual(detectGates(empty.repo), []);
  assert.deepEqual(previewHints(empty.repo), []);
  const hinted = fixture(t, { files: { 'scripts/apercu-supabase.sh': '#!/bin/sh\n', 'package.json': '{ "scripts": { "dev": "vite" } }' } });
  assert.deepEqual(previewHints(hinted.repo), ['scripts/apercu-supabase.sh']);
  const broken = fixture(t, { files: { 'package.json': '{ nope' } });
  assert.deepEqual(detectGates(broken.repo), []);
});

test('apv onboard --specs reads exported V2 specs outside the repository, with their request', async t => {
  const f = v2Fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'apv3-v2specs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'spec1-import.json', specTemplate('Refonte 1'));
  write(dir, 'spec1-request.txt', 'Refais la page d\'accueil.\n');
  const r = await apv(f.repo, ['onboard', '--specs', dir, '--json']);
  assert.equal(r.code, 0, r.stderr);
  const imported = r.json().specs.imported.find(s => s.to === '.apv/specs/spec1.json');
  assert.ok(imported, JSON.stringify(r.json().specs));
  assert.equal(imported.request, join(dir, 'spec1-request.txt'));
  const written = JSON.parse(read(f.repo, '.apv/specs/spec1.json'));
  assert.deepEqual(Object.keys(written), ['request', 'spec']);
  assert.equal(written.request, 'Refais la page d\'accueil.\n');
  assert.equal(written.spec.title, 'Refonte 1');
  assert.equal((await apv(f.repo, ['spec', 'validate', '.apv/specs/spec1.json', '--draft', '--json'])).json().requestSource, 'document');
  assert.equal((await apv(f.repo, ['onboard', '--specs', join(dir, 'absent')])).code, 2);
});

test('apv onboard refuses a corrupt V2 file with a clear message and writes nothing', async t => {
  const cases = [
    [{ 'pipeline.v2.json': '{ "gates": [' }, /\[ONBOARD_V2\] : pipeline\.v2\.json n'est pas un JSON valide .*Rien n'est écrit/s],
    [{ 'pipeline.v2.json': JSON.stringify({ ...v2Config(), gates: [{ id: 'test' }] }) }, /sections reprises refusées par le schéma d'APV3, rien n'est écrit :\n- /],
    [{ 'pipeline.v2.json': '[]' }, /doit contenir un objet JSON/],
    [{ '.agent-pipeline/DECISIONS.json': '{ "schemaVersion": 1, "decisions": [ {' }, /DECISIONS\.json n'est pas un JSON valide/],
    [{ '.agent-pipeline/DECISIONS.json': JSON.stringify({ schemaVersion: 1, decisions: [decision('a'), decision('a')] }) }, /n'est pas un registre valide pour apv ledger validate, rien n'est écrit/],
  ];
  for (const [files, message] of cases) {
    const f = v2Fixture(t, files);
    for (const args of [['onboard'], ['onboard', '--dry-run']]) {
      const r = await apv(f.repo, args);
      assert.equal(r.code, 1, `${Object.keys(files)}: ${r.stdout}`);
      assert.match(r.stderr, message);
      assert.ok(!existsSync(join(f.repo, '.apv')), 'nothing written');
    }
  }
});

test('apv onboard refuses outside a Git repository and rejects wrong calls', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'apv3-nogit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'pipeline.v2.json', v2Config());
  const r = await apv(dir, ['onboard']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /NOT_A_REPOSITORY.*Pas un dépôt Git/);
  assert.ok(!existsSync(join(dir, '.apv')));
  const f = fixture(t);
  assert.equal((await apv(f.repo, ['onboard', 'extra'])).code, 2);
  assert.equal((await apv(f.repo, ['onboard', '--bogus'])).code, 2);
  assert.match((await apv(f.repo, ['onboard', '--help'])).stdout, /sans jamais écraser/);
  assert.match((await apv(f.repo, ['help'])).stdout, /apv onboard \[--dry-run\]/);
});

test('spec ids come from the file name, without the V2 import suffix', () => {
  assert.equal(specIdOf('spec1-import.json'), 'spec1');
  assert.equal(specIdOf('Écran Accueil.json'), 'ecran-accueil');
  assert.equal(specIdOf('___.json'), 'spec');
});
