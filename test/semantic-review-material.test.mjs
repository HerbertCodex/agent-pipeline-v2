import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSemanticReview } from '../dist/lifecycle/decisions.js';

const ledger = { schemaVersion: 1, decisions: [
  { id: 'D-LENDING', subject: 'core capability', value: 'borrowing', enforcement: 'product', status: 'confirmed', source: 'operator', sourceQuote: 'qui permet d\'emprunter', rationale: 'Explicit need.', supersedes: [], clarificationQuestion: '', interpretations: [] },
  { id: 'D-STACK', subject: 'stack', value: 'derived stack', enforcement: 'bootstrap', status: 'proposed', source: 'derived', sourceQuote: '', rationale: 'Setup suggestion.', supersedes: [], clarificationQuestion: '', interpretations: [] },
] };
const review = (decisions) => ({ verdict: 'pass', summary: 'ok', decisions, missingOperatorDecisions: [], findings: [] });

test('semantic review entries for proposed decisions are dropped, negative ones kept as warnings', () => {
  const out = validateSemanticReview(ledger, review([
    { decisionId: 'D-LENDING', status: 'pass', evidence: 'covered' },
    { decisionId: 'D-STACK', status: 'unknown', evidence: 'not verifiable' },
  ]));
  assert.deepEqual(out.decisions.map(d => d.decisionId), ['D-LENDING']);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].severity, 'warning');
  assert.match(out.findings[0].description, /D-STACK/);
});

test('semantic review still rejects decision ids absent from the ledger', () => {
  assert.throws(() => validateSemanticReview(ledger, review([
    { decisionId: 'D-LENDING', status: 'pass', evidence: 'covered' },
    { decisionId: 'D-GHOST', status: 'pass', evidence: 'invented' },
  ])), /unknown decision\(s\): D-GHOST/);
});

test('semantic review still requires every material decision', () => {
  assert.throws(() => validateSemanticReview(ledger, review([
    { decisionId: 'D-STACK', status: 'pass', evidence: 'fine' },
  ])), /omitted decision D-LENDING/);
});
