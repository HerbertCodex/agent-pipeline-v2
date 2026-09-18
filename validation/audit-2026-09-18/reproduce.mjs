// Pure local probes: no model, network, worktree or production-state mutation.
import assert from 'node:assert/strict';
import { providerProfile } from '../../dist/adapters/providers.js';
import { agentSchema, configSchema } from '../../dist/domain/contracts.js';
import { assessSecurity } from '../../dist/security/owasp.js';

const profile = providerProfile('claude');
const defaults = agentSchema.parse({ type: 'claude' });
assert.equal(profile.maxBudgetUsd, 5);
assert.equal(profile.maxTurns, 32);
assert.equal(defaults.maxBudgetUsd, null);
assert.equal(defaults.maxTurns, 200);
const negative = assessSecurity({ text: 'Ne pas modifier package.json. Aucun changement de pipeline CI.', projectType: 'fullstack' });
assert.equal(negative.profile.dependencyChange, true);
assert.equal(negative.profile.ciCd, true);
assert.throws(() => configSchema.parse({ schemaVersion: 1, executionMode: 'local-trusted',
  environment: { id: 'audit' }, agent: { type: 'claude' },
  gates: [{ id: 'example', command: ['true'] }], workflow: { maxSpecCostUsd: 25.5 } }), /expected integer/);
console.log(JSON.stringify({
  profile: { maxTurns: profile.maxTurns, maxBudgetUsd: profile.maxBudgetUsd },
  defaults: { maxTurns: defaults.maxTurns, maxBudgetUsd: defaults.maxBudgetUsd },
  negatedRequest: { dependencyChange: negative.profile.dependencyChange, ciCd: negative.profile.ciCd },
  fractionalSpecBudgetRejected: true,
}, null, 2));
