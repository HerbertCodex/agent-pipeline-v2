// Historical probes for the a5f6dc2 research snapshot; assertions describe defects before the subscription-policy fix.
// Current regression coverage: test/subscription-policy.test.mjs. Do not treat this historical script as a current acceptance test.
// Read-only controller probes: no provider, live store, project or subprocess.
// Run from the repository root after building: node validation/state-of-art-2026-09-19/inspect.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { configSchema } from '../../dist/domain/contracts.js';
import { budgetedAgent } from '../../dist/adapters/invocations.js';
import { claudeCommand } from '../../dist/adapters/claude.js';
import { Lifecycle } from '../../dist/lifecycle/service.js';
import { selectPath } from '../../dist/lifecycle/pathways.js';
import { modelChoice } from '../../dist/adapters/routing.js';

const config = configSchema.parse({ schemaVersion: 1, executionMode: 'local-trusted',
  environment: { id: 'research-probe' }, agent: { type: 'claude' },
  gates: [{ id: 'test', command: ['node', '--test'] }] });
const record = { config, attempts: [], validationRunIds: [], status: 'approved',
  sessionStartedAt: null, planningStartedAt: null };
const document = { id: 'probe', kind: 'spec', version: 1, data: record };
const store = { document: () => document, documentEvents: () => [],
  acquireDocument: () => 'probe-lease', releaseDocument: () => {} };
const results = [];
function budget(name) {
  const effective = budgetedAgent(store, document.id, config.agent);
  const argv = claudeCommand(effective, { type: 'object', properties: {}, additionalProperties: false }, true);
  const i = argv.indexOf('--max-budget-usd');
  results.push({ name, configuredSpecUsd: config.workflow.maxSpecCostUsd,
    configuredAgentUsd: config.agent.maxBudgetUsd, effectiveCallUsd: effective.maxBudgetUsd,
    budgetFlag: i < 0 ? null : argv[i + 1] });
  return effective.maxBudgetUsd;
}
assert.equal(budget('default-budget-injects-cli-cap'), 25);
config.workflow.maxSpecCostUsd = null;
assert.equal(budget('explicit-null-configuration-disables-cap'), null);
config.workflow.maxSpecCostUsd = 25;
record.operational = { maxSpecCostUsd: null };
assert.equal(budget('null-operational-value-falls-back-to-config'), 25);
delete record.operational;
let amendmentError;
try { Lifecycle.prototype.amendBudget.call({ store, get: () => document }, document.id,
  { maxSpecCostUsd: null }, 'Research reviewer', 'Disable the monetary ceiling for an included subscription.'); }
catch (error) { amendmentError = { code: error.code, message: error.message }; }
assert.equal(amendmentError?.code, 'ARGUMENT');
assert.match(amendmentError.message, /maxSpecCostUsd/);
results.push({ name: 'null-budget-amendment-rejected', ...amendmentError });
const security = { minimumLane: 'fast', requiresThreatModel: false };
assert.equal(selectPath('Fix a local calculation.', security), 'standard');
assert.equal(selectPath('Fix a local calculation.', security, 'compact'), 'compact');
results.push({ name: 'compact-requires-explicit-entry', defaultPath: 'standard', explicitPath: 'compact' });
const choice = modelChoice(config, 'qa', 'standard');
assert.equal(choice.agent.model, '');
results.push({ name: 'bare-config-does-not-pin-qa-model', source: choice.source, model: choice.agent.model });
const files = ['src/domain/contracts.ts', 'src/adapters/invocations.ts', 'src/adapters/model-check.ts',
  'src/adapters/claude.ts', 'src/adapters/routing.ts', 'src/lifecycle/service.ts', 'src/lifecycle/roles.ts',
  'src/lifecycle/pathways.ts', 'src/engine/scheduler.ts', 'src/engine/pipeline.ts',
  'dist/domain/contracts.js', 'dist/adapters/invocations.js', 'dist/adapters/claude.js',
  'dist/adapters/routing.js', 'dist/lifecycle/service.js', 'dist/lifecycle/pathways.js'];
console.log(JSON.stringify({ inspectedOn: '2026-09-19', scope: 'Synthetic records; no model calls or live store access',
  results, sha256: Object.fromEntries(files.map(file => [file,
    createHash('sha256').update(readFileSync(new URL('../../' + file, import.meta.url))).digest('hex')])) }, null, 2));
