import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { makeLifecycleFixture, git } from '../examples/lifecycle-fixture.mjs';
import { VERSION } from '../dist/domain/contracts.js';
const { values } = parseArgs({ options: { output: { type: 'string' } } });
let root;
if (values.output) {
    root = resolve(values.output);
    if (existsSync(root))
        throw new Error('Choose a new demo output directory');
    mkdirSync(root, { recursive: true });
}
else
    root = mkdtempSync(join(tmpdir(), 'apv2-lifecycle-'));
const f = makeLifecycleFixture(root);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const transcript = [];
function call(args, expected = 0) {
    const result = spawnSync(process.execPath, [cli, ...args, '--state-dir', f.state], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env } });
    transcript.push({ args, exit: result.status, stderr: result.stderr, stdout: result.stdout });
    if (result.status !== expected) {
        writeFileSync(join(root, 'failed-transcript.json'), JSON.stringify(transcript, null, 2));
        throw new Error(`CLI ${args.join(' ')} exit ${result.status}: ${result.stdout}\n${result.stderr}`);
    }
    return JSON.parse(result.stdout);
}
const installation = call(['onboard', '--repo', f.repo, '--assist', '--agent', join(root, 'agent.json')]);
assert.equal(installation.questions.length, 0);
call(['onboard', 'apply', installation.id, '--hash', installation.hash, '--reviewer', 'DEMO OPERATOR', '--note', 'SIMULATION: inspect and approve the fixture installation.', '--commit']);
assert.ok(readFileSync(join(f.repo, 'AGENTS.md'), 'utf8').includes('Do not erase this text.'));
const baselineSha = git(f.repo, 'rev-parse', 'HEAD');
const baseline = call(['doctor', '--repo', f.repo, '--execute']);
assert.equal(baseline.passed, true);
let spec = call(['spec', 'draft', '--repo', f.repo, '--request', 'Ajouter la multiplication et sa documentation. DEMO_QUESTION'], 2);
assert.equal(spec.questions.length, 1);
spec = call(['spec', 'refine', spec.id, '--request', 'Inclure les nombres négatifs et leurs tests.']);
assert.equal(spec.questions.length, 0);
call(['spec', 'approve', spec.id, '--hash', spec.hash, '--reviewer', 'DEMO PRODUCT OWNER', '--note', 'SIMULATION: this bounded spec is approved for the demo.']);
spec = call(['spec', 'run', spec.id], 2);
assert.equal(spec.status, 'awaiting_review');
assert.equal(spec.qa.report.verdict, 'pass');
assert.equal(spec.attempts.length, 3);
assert.equal(spec.tasks.length, 2);
assert.ok(spec.tasks.every(t => t.done));
const candidate = spec.candidateSha;
spec = call(['spec', 'review', spec.id, '--sha', candidate, '--reviewer', 'DEMO CODE REVIEWER', '--note', 'SIMULATION: inspected the fixture diff, criteria and QA report.']);
assert.equal(spec.status, 'ready');
const delivery = join(root, 'delivery');
spec = call(['spec', 'deliver', spec.id, '--output', delivery]);
assert.equal(spec.status, 'delivered');
git(f.repo, 'apply', '--check', join(delivery, 'candidate.patch'));
call(['spec', 'branch', spec.id, '--name', 'feature/demo-multiply', '--confirm']);
assert.equal(git(f.repo, 'rev-parse', 'HEAD'), baselineSha);
assert.equal(git(f.repo, 'status', '--porcelain'), '');
// The DEMO, not the pipeline, simulates the human integrator using a real local merge.
const integration = join(root, 'integration');
git(f.repo, 'worktree', 'add', '-b', 'integration-demo', integration, baselineSha);
git(integration, 'merge', '--no-ff', '--no-edit', 'feature/demo-multiply');
const merged = git(integration, 'rev-parse', 'HEAD');
spec = call(['spec', 'close', spec.id, '--target', 'integration-demo', '--sha', merged, '--reviewer', 'DEMO INTEGRATOR', '--note', 'SIMULATION: observed the local merge on the integration branch.']);
assert.equal(spec.status, 'closed');
assert.equal(git(f.repo, 'rev-parse', 'HEAD'), baselineSha);
assert.equal(git(f.repo, 'status', '--porcelain'), '');
const report = { version: VERSION, kind: 'Full CLI lifecycle with deterministic fixtures; no model, external GitHub, real human review or deployment.', root,
    installationApplied: true, existingInstructionsPreserved: true, baselinePassed: baseline.passed, productQuestionResolved: true,
    tasks: spec.tasks.length, qaRepairAttempts: spec.attempts.filter(a => a.kind === 'qa-repair').length, qaVerdict: spec.qa.report.verdict,
    humanApprovalsAreSimulated: true, aggregateCandidate: candidate, patchApplies: true, sourceUnchangedAfterOnboarding: true,
    localBranchCreated: true, localMergePerformedByDemo: true, mergeSha: merged, status: spec.status, activeMs: spec.activeMs, cliCalls: transcript.length };
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
writeFileSync(join(root, 'transcript.json'), JSON.stringify(transcript, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
