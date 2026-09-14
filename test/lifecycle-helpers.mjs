import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Lifecycle } from '../dist/index.js';
import { makeLifecycleFixture, demoSpec, git } from '../examples/lifecycle-fixture.mjs';
export { git, demoSpec };
export function fixture(t, config = {}) { const root = mkdtempSync(join(tmpdir(), 'apv2-life-test-')); const f = makeLifecycleFixture(root); const life = new Lifecycle(f.state); t.after(() => { try {
    life.close();
}
catch { } rmSync(root, { recursive: true, force: true }); }); return { ...f, root, life, config: { ...f.config, ...config } }; }
export function oneTask() { const spec = demoSpec(); spec.scope = [spec.scope[0]]; spec.acceptance = [spec.acceptance[0]]; spec.tasks = [spec.tasks[0]]; return spec; }
export async function approved(f, proposal = demoSpec()) { let doc = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.', proposal }); return f.life.approveSpec(doc.id, doc.data.contentHash, 'Test Product Owner', 'Fixture approval after inspecting scope and criteria.'); }
export function passingQa(doc, sha = doc.data.currentSha) { return { candidateSha: sha, verdict: 'pass', summary: 'Fixture QA assessment.', criteria: doc.data.content.acceptance.map(c => ({ id: c.id, status: 'pass', evidence: 'Fixture inspected source and test evidence.' })), findings: [], observations: [] }; }
