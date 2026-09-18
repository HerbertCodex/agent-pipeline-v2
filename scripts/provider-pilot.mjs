// Opt-in pilot on an isolated fixture. Real model calls may consume quota.
// This script does not publish, deploy, merge, or claim real human code review.
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { Lifecycle, providerProfile, VERSION } from '../dist/index.js';
import { makeLifecycleFixture, git } from '../examples/lifecycle-fixture.mjs';
const { values } = parseArgs({ options: { provider: { type: 'string' }, output: { type: 'string' }, execute: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help || !values.execute) {
  console.log('No model called. To authorize a paid/quota-consuming scratch pilot: node scripts/provider-pilot.mjs --provider codex|claude --output NEW_DIRECTORY --execute');
  process.exit(values.help ? 0 : 2);
}
if (!values.output || !values.provider) throw new Error('Supply --provider and a new --output directory.');
const agent = { ...providerProfile(values.provider), timeoutMs: 600000, maxTurns: 32, maxBudgetUsd: 5 };
const root = resolve(values.output);
if (existsSync(root)) throw new Error('Output directory must not exist; nothing will be overwritten.');
mkdirSync(root, { recursive: true, mode: 0o700 });
const f = makeLifecycleFixture(root);
const before = git(f.repo, 'rev-parse', 'HEAD');
const version = spawnSync(agent.type, ['--version'], { encoding: 'utf8', timeout: 10000 });
if (version.status !== 0) throw new Error('Provider executable unavailable; no model called. Install/authenticate separately.');
const config = { ...f.config, agent, roles: { product: agent, qa: agent }, skills: { enabled: ['clean-code','security','tdd'], projectType: 'library' }, maxRunMs: 900000,
  workflow: { qaLanes: ['standard','high'], maxQaRepairs: 1, maxActiveMs: 1800000 } };
const life = new Lifecycle(f.state); let doc; const started = performance.now();
const report = { framework: VERSION, provider: agent.type, providerVersion: version.stdout.trim(), authenticatedCallsAttempted: true,
  fixtureOnly: true, productApproval: 'Explicitly simulated in an opt-in disposable pilot', realHumanCodeReview: false,
  setupModelCalled: false, push: false, merge: false, deployment: false, root };
try {
  doc = await life.draft({ repo: f.repo, config,
    request: 'Disposable integration pilot, not a real product. Add multiply(a,b) to src/math.mjs; test positive and negative inputs in test/math.test.mjs and document one usage in docs/math.md. Existing add must remain unchanged. Only these three files may be edited. No dependency, config, policy or infrastructure changes. Use the existing node:test suite. No unanswered business choices: both negative and positive integer cases are required. Keep this at one or two coherent tasks. Return the actual spec schema, no execution permissions.' });
  report.specId = doc.id;
  if (doc.data.content.questions.length) { report.result = 'product-questions'; process.exitCode = 2; }
  else {
    const allowed = new Set(['src/math.mjs','test/math.test.mjs','docs/math.md']);
    if (!doc.data.content.tasks.every(t => t.allowedPaths.every(p => allowed.has(p)))) throw new Error('Product proposed wider paths; pilot refuses auto-approval. Inspect the saved spec.');
    // This approval is labelled as a fixture simulation, never as an actual person.
    doc = await life.approveSpec(doc.id, doc.data.contentHash, 'SIMULATED PILOT PRODUCT', 'Opt-in scratch fixture only; no real product or production approval.');
    doc = await life.run(doc.id);
    report.result = doc.data.status; report.qa = doc.data.qa?.report.verdict ?? null; report.error = doc.data.error;
    if (!['ready','awaiting_review'].includes(doc.data.status)) process.exitCode = 2;
  }
  report.sourceUntouched = git(f.repo, 'rev-parse', 'HEAD') === before && git(f.repo, 'status', '--porcelain') === '';
  report.successfulPilot = report.sourceUntouched && ['ready','awaiting_review'].includes(doc.data.status) && doc.data.qa?.report.verdict === 'pass';
} catch (error) { report.result = 'failed'; report.error = { message: String(error) }; report.successfulPilot = false; process.exitCode = 1; }
finally {
  report.durationMs = performance.now() - started;
  doc ??= life.store.documents('spec').at(-1);
  if (doc) report.cost = life.costSummary(doc.id);
  if (doc) writeFileSync(join(root, 'events.jsonl'), life.store.documentEvents(doc.id).map(e => JSON.stringify(e)).join('\n')+'\n', {mode:0o600});
  life.close();writeFileSync(join(root, 'report.json'), JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report,null,2));
}
