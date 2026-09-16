import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Lifecycle } from '../dist/index.js';
import { assessSecurity } from '../dist/security/owasp.js';
import { makeLifecycleFixture, demoSpec, git } from '../examples/lifecycle-fixture.mjs';
export { git, demoSpec };
export function fixture(t, config = {}) { const root = mkdtempSync(join(tmpdir(), 'apv2-life-test-')); const f = makeLifecycleFixture(root); const life = new Lifecycle(f.state); t.after(() => { try {
    life.close();
}
catch { } rmSync(root, { recursive: true, force: true }); }); return { ...f, root, life, config: { ...f.config, ...config } }; }
export function oneTask() { const spec = demoSpec(); spec.scope = [spec.scope[0]]; spec.acceptance = [spec.acceptance[0]]; spec.tasks = [spec.tasks[0]]; return spec; }
export async function approved(f, proposal = demoSpec()) { let doc = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.', proposal }); return f.life.approveSpec(doc.id, doc.data.contentHash, 'Test Product Owner', 'Fixture approval after inspecting scope and criteria.'); }
export function passingQa(doc, sha = doc.data.currentSha) { return { candidateSha: sha, verdict: 'pass', summary: 'Fixture QA assessment.', criteria: doc.data.content.acceptance.map(c => ({ id: c.id, status: 'pass', evidence: 'Fixture inspected source and test evidence.' })), findings: [], observations: [] }; }
/** Fills a fixture spec with the security plan the controller routes for a request, when it routes any. */
export function withSecurity(spec, request, projectType = 'unknown') {
  const ctx = assessSecurity({ text: request, projectType, files: [] });
  if (!ctx.topics.length) return spec;
  if (!spec.acceptance.some(x => x.id === 'AC-SEC')) spec.acceptance.push({ id: 'AC-SEC', description: 'The security-sensitive behavior preserves the routed trust-boundary requirements.', verification: 'Inspect implementation and observed negative security tests.' });
  if (!spec.tasks[0].acceptanceIds.includes('AC-SEC')) spec.tasks[0].acceptanceIds.push('AC-SEC');
  spec.minimumLane = ctx.minimumLane;
  spec.security = { profile: { ...ctx.profile }, owaspTopics: ctx.topics.map(t => t.id),
    threatModel: { required: ctx.requiresThreatModel, summary: ctx.requiresThreatModel ? 'Fixture threat model for the routed security surface.' : '', assets: ctx.requiresThreatModel ? ['protected application state'] : [], trustBoundaries: ctx.requiresThreatModel ? ['untrusted client -> application'] : [], threats: ctx.requiresThreatModel ? [{ id: 'TM-FIXTURE', category: 'spoofing', description: 'An untrusted actor attempts to cross the protected boundary.', mitigations: ['Enforce the approved authentication/authorization and validation requirements.'], acceptanceIds: ['AC-SEC'] }] : [], assumptions: [] },
    requirements: [{ id: 'SEC-FIXTURE', title: 'Apply controller-routed security requirements', owaspTopics: ctx.topics.map(t => t.id), acceptanceIds: ['AC-SEC'], verification: 'Inspect code and runner evidence for the routed topics.', negativeTests: ctx.negativeTestsRequired ? ['Reject invalid or unauthorized input without changing protected state.'] : [] }],
    assumptions: [], deferred: [] };
  return spec;
}
