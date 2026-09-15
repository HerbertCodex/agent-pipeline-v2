// Opt-in pilot of the bounded output-repair loop against a real provider.
// The controller rejects the first answer with an error naming a random token the model cannot know;
// a successful pilot proves the real model read the controller error and corrected its answer.
// It calls the provider at most twice, on a disposable fixture, and never publishes, merges or deploys.
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { providerProfile, VERSION } from '../dist/index.js';
import { Store } from '../dist/persistence/store.js';
import { runRole } from '../dist/lifecycle/roles.js';
import { s } from '../dist/domain/schema.js';
import { invariant } from '../dist/domain/errors.js';
import { makeLifecycleFixture, git } from '../examples/lifecycle-fixture.mjs';

const { values } = parseArgs({ options: { provider: { type: 'string' }, output: { type: 'string' }, execute: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help || !values.execute) {
  console.log('No model called. To authorize at most two quota-consuming calls: node scripts/repair-pilot.mjs --provider codex|claude --output NEW_DIRECTORY --execute');
  process.exit(values.help ? 0 : 2);
}
if (!values.output || !values.provider) throw new Error('Supply --provider and a new --output directory.');
const agent = providerProfile(values.provider);
const root = resolve(values.output);
if (existsSync(root)) throw new Error('Output directory must not exist; nothing will be overwritten.');
mkdirSync(root, { recursive: true, mode: 0o700 });
const version = spawnSync(agent.type, ['--version'], { encoding: 'utf8', timeout: 10000 });
if (version.status !== 0) throw new Error('Provider executable unavailable; no model called.');

const f = makeLifecycleFixture(root);
const store = new Store(f.state);
const doc = store.createDocument('repair-pilot', { provider: agent.type });
const token = `REPAIR-${randomUUID().slice(0, 8)}`;
const schema = s.object({ summary: s.string(1, 2000) });
let validations = 0;
const report = { framework: VERSION, provider: agent.type, providerVersion: version.stdout.trim(), fixtureOnly: true, push: false, merge: false, deployment: false, root };
const started = performance.now();
try {
  const result = await runRole({
    store, documentId: doc.id, repo: f.repo, sha: git(f.repo, 'rev-parse', 'HEAD'), role: 'product', agent,
    passEnv: ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TEMP', 'TMP'], schema, maxRepairs: 1,
    context: { mode: 'repair-pilot', instructions: ['Disposable controller pilot, not a product request: put one short sentence describing this repository in summary.'] },
    validate: (value) => {
      validations++;
      invariant(value.summary.includes(token), 'SCHEMA', `$.summary: must contain the exact acknowledgement token ${token}`);
      return value;
    },
  });
  const events = store.documentEvents(doc.id);
  report.validations = validations;
  report.repairEvents = events.filter(e => e.type === 'role.output_repair').map(e => ({ attempt: e.data.attempt, code: e.data.code }));
  report.summary = result.summary;
  report.tokenAcknowledged = result.summary.includes(token);
  report.successfulPilot = validations === 2 && report.repairEvents.length === 1 && report.tokenAcknowledged;
  process.exitCode = report.successfulPilot ? 0 : 2;
} catch (error) {
  report.result = 'failed'; report.error = String(error); report.validations = validations; report.successfulPilot = false; process.exitCode = 1;
} finally {
  report.durationMs = Math.round(performance.now() - started);
  writeFileSync(join(root, 'events.jsonl'), store.documentEvents(doc.id).map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  store.close();
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
