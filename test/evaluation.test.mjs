import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluationReport, compareEvaluations } from '../dist/evaluation/report.js';
import { proposeConfiguration } from '../dist/lifecycle/onboarding.js';

test('evaluation includes failed costs and durations, without turning unknown spending into zero', () => {
  const samples = [
    { configuration: 'A', caseId: 'bug', success: true, wallMs: 10, planningMs: 2, activeMs: 8, cost: { knownUsd: 1, unknownInvocations: 0, pendingInvocations: 0 } },
    { configuration: 'A', caseId: 'feature', success: false, wallMs: 100, planningMs: 20, activeMs: 80, cost: { knownUsd: 4, unknownInvocations: 1, pendingInvocations: 0 } },
    { configuration: 'B', caseId: 'bug', success: false, wallMs: 50, planningMs: 5, activeMs: 45, cost: { knownUsd: 3, unknownInvocations: 0, pendingInvocations: 1 } },
  ];
  const [a, b] = evaluationReport(samples);
  assert.equal(a.successRate, 0.5); assert.equal(a.knownUsdPerSuccessIncludingFailures, 5);
  assert.equal(a.p95WallMs, 100); assert.equal(a.costComplete, false); assert.equal(a.unknownInvocations, 1);
  assert.equal(b.knownUsdPerSuccessIncludingFailures, null); assert.equal(b.costComplete, false);
  assert.deepEqual(evaluationReport([]), []);
});

test('onboarding proposes existing build, integration and browser checks; never promotes watch scripts', () => {
  const inventory = { repo: '/fixture', baseSha: 'a'.repeat(40), files: [], stack: 'node-typescript', projectType: 'frontend', packageManager: 'npm', warnings: [], securityScripts: [],
    scripts: { test: 'node --test', build: 'vite build', lint: 'eslint .', 'test:integration': 'node --test integration', 'test:e2e': 'playwright test', check: 'tsc --watch' } };
  const { config } = proposeConfiguration(inventory);
  for (const id of ['test', 'build', 'lint', 'test-integration', 'test-e2e']) assert.equal(config.gates.some(g => g.id === id), true);
  assert.equal(config.gates.some(g => g.id === 'check'), false);
  assert.deepEqual(config.feedback.gateIds, [], 'check tool access is an explicit configuration decision');
  assert.equal(config.workflow.qualityReview, 'evidence');
  assert.deepEqual(config.gates.find(g => g.id === 'test-e2e').covers, ['browser']);
  assert.deepEqual(config.gates.find(g => g.id === 'test-integration').covers, ['integration']);
  inventory.scripts.check = 'npm run build && npm test';
  assert.deepEqual(proposeConfiguration(inventory).config.gates.find(g => g.id === 'check').covers, [], 'composite coverage needs explicit review');
});

test('model comparison requires matched cases and checks and never ranks incomplete or unknown-cost runs', () => {
  const report = (configuration, ms, cost) => ({ configuration, caseSetHash: 'cases', checksHash: 'checks', expectedSamples: 1, samples: [
    { configuration, caseId: 'case', success: true, wallMs: ms, planningMs: 0, activeMs: ms, cost: { knownUsd: cost, unknownInvocations: 0, pendingInvocations: 0 } },
  ] });
  const a = report('quick', 100, 1), b = report('deep', 200, 2);
  assert.equal(compareEvaluations([a,b]).fastestPassingConfiguration, 'quick');
  assert.equal(compareEvaluations([a,b]).cheapestPassingConfiguration, 'quick');
  assert.throws(() => compareEvaluations([a,{...b,checksHash:'different'}]), /same cases/);
  assert.throws(() => compareEvaluations([a,{...b,caseSetHash:'different'}]), /same cases/);
  assert.equal(compareEvaluations([{...a,stoppedReason:'quota'},b]).fastestPassingConfiguration, null);
  a.samples[0].cost.unknownInvocations = 1;
  assert.equal(compareEvaluations([a,b]).cheapestPassingConfiguration, 'deep');
  b.samples[0].success = false;
  assert.equal(compareEvaluations([a,b]).fastestPassingConfiguration, null);
});
