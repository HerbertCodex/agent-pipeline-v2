import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { demoSpec } from './lifecycle-helpers.mjs';
import { apv, write, decision } from './cli-helpers.mjs';
import { jsonSchemaIssues, schemaIssues } from '../dist/domain/issues.js';
import { specSchema } from '../dist/lifecycle/contracts.js';
import { VERSION } from '../dist/domain/contracts.js';
import { commands } from '../dist/commands/index.js';

test('apv status on a project without .apv says so', async t => {
  const f = fixture(t);
  const r = await apv(f.repo, ['status']);
  assert.equal(r.code, 0);
  for (const line of [/Configuration : aucune/, /Registre : aucun/, /Specs \(\.apv\/specs\) : aucune/, /État \(\.apv\/state\) : aucun/, /Quota : aucun relevé/]) assert.match(r.stdout, line);
});

test('apv status summarises configuration, ledger, specs, state and last quota', async t => {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { gates: [{ id: 'unit', command: ['npm', 'test'] }], design: { dir: 'maquettes' }, db: { migrations: ['supabase/migrations'] }, agent: { type: 'claude' } });
  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-1'), decision('D-2')] });
  write(f.repo, '.apv/specs/001-math.json', demoSpec());
  write(f.repo, '.apv/specs/002-wrapped.json', { request: 'Add it.', spec: { ...demoSpec(), title: 'Wrapped' } });
  write(f.repo, '.apv/specs/003-broken.json', '{');
  write(f.repo, '.apv/state/run.json', { wave: 1 });
  write(f.repo, '.apv/state/quota.log', '{"at":"2026-09-23T08:00:00.000Z","session":{"percent":21,"resets":null},"week":{"percent":7,"resets":null},"percent":21,"level":"ok"}\n');
  const r = await apv(f.repo, ['status', '--json']);
  assert.equal(r.code, 0);
  const s = r.json();
  assert.deepEqual(s.config, { file: '.apv/config.json', legacy: false, gates: ['unit'], ignored: ['agent'], error: null });
  assert.equal(s.ledger.file, '.apv/DECISIONS.json'); assert.equal(s.ledger.decisions, 2); assert.match(s.ledger.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(s.specs.map(x => [x.file, x.title]), [['.apv/specs/001-math.json', 'Multiplication et documentation'], ['.apv/specs/002-wrapped.json', 'Wrapped'], ['.apv/specs/003-broken.json', null]]);
  assert.ok(s.specs[2].error);
  assert.deepEqual(s.state.map(x => x.file), ['.apv/state/quota.log', '.apv/state/run.json']);
  assert.equal(s.quota.level, 'ok');
  const human = await apv(f.repo, ['status']);
  assert.match(human.stdout, /Configuration : \.apv\/config\.json ; contrôles : unit/);
  assert.match(human.stdout, /Registre : \.apv\/DECISIONS\.json ; 2 décision\(s\), empreinte [a-f0-9]{64}/);
  assert.match(human.stdout, /- \.apv\/specs\/001-math\.json : Multiplication et documentation/);
  assert.match(human.stdout, /Quota : 2026-09-23T08:00:00\.000Z ; session 21 % ; semaine 7 % ; niveau ok/);
});

test('apv status reports an invalid configuration or ledger without failing', async t => {
  const f = fixture(t);
  write(f.repo, 'pipeline.v2.json', { gates: 'nope' });
  write(f.repo, '.agent-pipeline/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-1'), decision('D-1')] });
  const r = await apv(f.repo, ['status']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Configuration : pipeline\.v2\.json ; invalide/);
  assert.match(r.stdout, /Registre : \.agent-pipeline\/DECISIONS\.json ; invalide \(1 erreur\(s\)/);
  assert.equal((await apv(f.repo, ['status', 'extra'])).code, 2);
});

test('the main loader reads the design section and checks its folder', async t => {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { design: { dir: '../dehors' } });
  const r = await apv(f.repo, ['status']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Configuration : \.apv\/config\.json ; invalide/);
  assert.match((await apv(f.repo, ['status', '--json'])).json().config.error, /design\.dir doit être un dossier relatif/);
  write(f.repo, '.apv/config.json', { design: { dir: 'docs/maquettes/' } });
  const ok = (await apv(f.repo, ['status', '--json'])).json();
  assert.deepEqual(ok.config.ignored, []);
  assert.equal(ok.config.error, null);
});

test('the dispatcher lists every command, init, run and stack included', async t => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(commands), ['init', 'spec', 'run', 'stack', 'ledger', 'scope', 'gates', 'lock', 'db', 'design', 'quota', 'preview', 'status']);
  const help = await apv(f.repo, ['help']);
  assert.equal(help.code, 0);
  for (const name of Object.keys(commands)) assert.match(help.stdout, new RegExp(`apv ${name}`));
  assert.equal((await apv(f.repo, [])).code, 2);
  assert.equal((await apv(f.repo, ['--help'])).code, 0);
  assert.equal((await apv(f.repo, ['--version'])).stdout, `${VERSION}\n`);
  const unknown = await apv(f.repo, ['deploy']);
  assert.equal(unknown.code, 2); assert.match(unknown.stderr, /Commande inconnue : deploy/);
  assert.equal((await apv(f.repo, ['help', 'deploy'])).code, 2);
  const topic = await apv(f.repo, ['help', 'gates']);
  assert.equal(topic.code, 0); assert.match(topic.stdout, /apv gates run/);
  // lock and db are the real modules since integration: they answer, and `apv help` shows their usage.
  const locks = await apv(f.repo, ['lock', 'status', '--dir', `${f.repo}/.locks`]);
  assert.equal(locks.code, 0, locks.stderr);
  const lockHelp = await apv(f.repo, ['help', 'lock']);
  assert.equal(lockHelp.code, 0); assert.match(lockHelp.stdout, /apv lock run <ressource>/);
  const dbHelp = await apv(f.repo, ['help', 'db']);
  assert.equal(dbHelp.code, 0); assert.match(dbHelp.stdout, /apv db check/);
});

test('the apv binary runs as a separate process', () => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const r = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stdout, `${VERSION}\n`);
  assert.equal(VERSION, '3.0.0-alpha.2');
  const bad = spawnSync(process.execPath, [cli, 'nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

test('the schema walker and the parser agree on every mutation of a valid spec', () => {
  const base = demoSpec();
  const mutations = [
    s => s, s => { delete s.title; }, s => { s.title = ''; }, s => { s.title = 'a\0b'; }, s => { s.tasks = 'x'; }, s => { s.tasks[0].dependsOn = [1]; },
    s => { s.minimumLane = 'fast'; }, s => { s.extra = null; }, s => { s.security = { profile: { exposure: 'mars' } }; }, s => { s.security = {}; },
    s => { s.acceptance = []; }, s => { s.experience = { uiImpact: 'major', surfaces: [], rationale: 'Big change.' }; }, s => { s.questions.push({ id: 'Q', question: 1 }); },
    s => { s.decisionCoverage = undefined; }, s => { s.tasks[0].minimumLane = null; },
  ];
  for (const [i, mutate] of mutations.entries()) {
    const value = structuredClone(base); mutate(value);
    let parses = true; try { specSchema.parse(value); } catch { parses = false; }
    assert.equal(jsonSchemaIssues(specSchema.json, value).length === 0, parses, `mutation ${i}`);
    assert.equal(schemaIssues(specSchema, value).value !== undefined, parses, `mutation ${i}`);
  }
});
