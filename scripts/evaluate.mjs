// Opt-in model evaluation on disposable repositories. No calls or writes without --execute.
import { parseArgs } from 'node:util';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Lifecycle, VERSION } from '../dist/index.js';
import { validateConfig } from '../dist/domain/contracts.js';
import { providerProfile } from '../dist/adapters/providers.js';
import { assessSecurity } from '../dist/security/owasp.js';
import { evaluationReport } from '../dist/evaluation/report.js';
import { evaluationCases } from '../examples/evaluation-cases.mjs';
import { validRelativePath } from '../dist/policy/policy.js';
import { hash } from '../dist/domain/hash.js';

const { values } = parseArgs({ options: {
  execute: { type: 'boolean' }, output: { type: 'string' }, config: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
  effort: { type: 'string' }, case: { type: 'string', multiple: true }, repetitions: { type: 'string' }, planning: { type: 'string' },
  label: { type: 'string' }, 'budget-usd': { type: 'string' }, help: { type: 'boolean' },
  pathway: { type: 'string' }, 'cases-file': { type: 'string' }, 'total-budget-usd': { type: 'string' },
} });
const cases = values['cases-file'] ? JSON.parse(readFileSync(resolve(values['cases-file']), 'utf8')) : evaluationCases;
if (!Array.isArray(cases) || !cases.length || cases.length > 30 || cases.some(c => !c || !/^[a-z0-9-]+$/.test(c.id) || !validRelativePath(c.path) || !c.path.startsWith('src/') || !c.path.endsWith('.mjs') ||
  ['category','request','before','checks'].some(k => typeof c[k] !== 'string' || !c[k].length || c[k].length > 30000)) || new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('Invalid evaluation cases');
const selected = values.case?.length ? cases.filter(c => values.case.includes(c.id)) : cases;
if (!selected.length || values.case?.some(id => !cases.some(c => c.id === id))) throw new Error('Unknown case id');
const pathway = values.pathway ?? 'legacy';
if (!['legacy','auto','compact','standard','structural'].includes(pathway)) throw new Error('Unknown pathway');
const repetitions = Number(values.repetitions ?? 1);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('Repetitions must be in 1..10');
const planning = values.planning ?? 'generated';
if (!['generated', 'fixture'].includes(planning)) throw new Error('Choose --planning generated|fixture');
const budget = Number(values['budget-usd'] ?? 5);
if (!Number.isFinite(budget) || budget < 0.01 || budget > 1000) throw new Error('Invalid per-spec --budget-usd');
const totalBudget = Number(values['total-budget-usd'] ?? budget * repetitions * selected.length);
if (!Number.isFinite(totalBudget) || totalBudget < 0.01 || totalBudget > 10000) throw new Error('Invalid total budget');
if (!values.execute || values.help) {
  console.log(JSON.stringify({ executed: false, cases: selected.map(({ id, category, request }) => ({ id, category, request })), repetitions, planning, perSpecBudgetUsd: budget,
    pathway, totalBudgetUsd: totalBudget,
    usage: 'npm run evaluate -- --provider claude|codex --model PINNED_MODEL --effort medium --pathway auto --label candidate --output NEW_DIRECTORY --execute',
    alternatives: '--config REVIEWED_CONFIG_JSON; --case ID (repeatable); --planning fixture to isolate execution from Product planning',
    limitation: 'Small engineering fixtures, not proof of senior code quality. UI checks inspect generated markup, not a real browser. Costs may be unknown or overshoot a provider ceiling.' }, null, 2));
  process.exit(0);
}
if (!values.output) throw new Error('--output NEW_DIRECTORY is required');
if (values.config && (values.provider || values.model || values.effort)) throw new Error('Choose --config or --provider/--model/--effort');
if (!values.config && (!values.provider || !values.model)) throw new Error('Pin --provider and --model, or provide a reviewed --config');
const root = resolve(values.output);
if (existsSync(root)) throw new Error('Output already exists; nothing was overwritten');
const selectedAgent = values.config ? null : { ...providerProfile(values.provider), model: values.model, effort: values.effort ?? 'medium', timeoutMs: 480000 };
const supplied = values.config ? JSON.parse(readFileSync(resolve(values.config), 'utf8')) : null;
const config = validateConfig(supplied ? { ...supplied, ...(values['budget-usd'] ? { workflow: { ...supplied.workflow, maxSpecCostUsd: budget } } : {}) } : {
  schemaVersion: 1, executionMode: 'local-trusted', environment: { id: `eval-node-${process.version}` }, agent: selectedAgent,
  skills: { enabled: ['clean-code', 'design-patterns', 'refactoring', 'security', 'tdd', 'ui-design'], projectType: 'library' },
  gates: [{ id: 'acceptance', command: [process.execPath, '--test'], mandatory: true }],
  feedback: { gateIds: ['acceptance'], maxCalls: 4, maxTotalMs: 120000 },
  maxRunMs: 600000, maxRepairAttempts: 1, workflow: { maxSpecCostUsd: budget, maxActiveMs: 1200000, maxQaRepairs: 1 },
});
// The immutable fixture oracle is always a gate, even for a custom provider config.
if (!config.gates.some(g => g.id === 'acceptance' && g.mandatory &&
  [[process.execPath, '--test'], [process.execPath, '--test', 'test/acceptance.mjs']].some(argv => g.command.join('\0') === argv.join('\0'))))
  throw new Error('Custom eval config must include mandatory acceptance argv [node-executable,"--test"] (all tests), or the legacy fixed-oracle command');
const label = values.label ?? `${config.agent.type}:${config.agent.model || 'wrapper'}:${config.agent.effort}:${planning}`;
const controller = new AbortController(); const abort = () => controller.abort();
process.on('SIGINT', abort); process.on('SIGTERM', abort);
mkdirSync(root, { recursive: true, mode: 0o700 });
const samples = []; const details = []; let stoppedReason = null;
const git = (repo, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
  cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Evaluation fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'Evaluation fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost' },
});
function proposal(c, request) {
  const context = assessSecurity({ text: request, projectType: config.skills.projectType, files: [c.path] });
  const required = context.requiresThreatModel;
  return { title: c.id, problem: c.request, scope: [c.request], outOfScope: ['Dependency, infrastructure and unrelated changes.'],
    acceptance: [{ id: 'AC-1', description: c.request, verification: 'The immutable test/acceptance.mjs oracle passes; review the implementation and added regression tests.' }],
    decisions: [], questions: [], minimumLane: context.minimumLane,
    tasks: [{ id: 'IMPLEMENT', title: c.id, description: c.request, acceptanceIds: ['AC-1'], allowedPaths: [c.path, 'test/regression.mjs'], dependsOn: [], minimumLane: context.minimumLane }],
    security: { profile: context.profile, owaspTopics: context.topics.map(t => t.id),
      threatModel: { required, summary: required ? 'Preserve the explicit fixture trust boundary.' : '', assets: required ? ['Fixture records and user content'] : [], trustBoundaries: required ? ['Caller input to exported function'] : [],
        threats: required ? [{ id: 'TH-1', category: 'abuse-case', description: 'Malformed or unauthorized input violates the specified boundary.', mitigations: ['Apply the specified validation and isolation rules.'], acceptanceIds: ['AC-1'] }] : [], assumptions: [] },
      requirements: context.topics.map((t, i) => ({ id: `SEC-${i}`, title: t.id, owaspTopics: [t.id], acceptanceIds: ['AC-1'], verification: 'Inspect implementation and fixed positive/negative acceptance assertions.', negativeTests: context.negativeTestsRequired ? ['The immutable oracle rejects malformed or unauthorized cases described in the request.'] : [] })), assumptions: [], deferred: [] },
  };
}
function save() {
  writeFileSync(join(root, 'report.json'), JSON.stringify({ framework: VERSION, node: process.version, configuration: label, planning,
    caseSetHash: hash(selected), checksHash: hash(config.gates),
    simulatedProductApproval: true, realHumanReview: false, limitation: 'Synthetic engineering fixtures; automated success does not establish architecture or craftsmanship quality. No production latency claim.',
    pathway, totalBudgetUsd: totalBudget, stoppedReason, expectedSamples: repetitions * selected.length,
    aggregate: evaluationReport(samples), samples, details }, null, 2) + '\n', { mode: 0o600 });
}
try {
  for (let repeat = 0; repeat < repetitions && !controller.signal.aborted; repeat++) for (const c of selected) {
    if (controller.signal.aborted) break;
    if (stoppedReason) break;
    const remaining = totalBudget - samples.reduce((n, s) => n + s.cost.knownUsd, 0);
    if (remaining < 0.01) { stoppedReason = 'Total declared budget exhausted'; break; }
    if (samples.some(s => s.cost.unknownInvocations || s.cost.pendingInvocations)) { stoppedReason = 'Unknown cost prevents safe continuation within the total budget'; break; }
    const caseConfig = validateConfig({ ...config, workflow: { ...config.workflow, maxSpecCostUsd: Math.min(config.workflow.maxSpecCostUsd ?? budget, budget, remaining) } });
    const directory = join(root, `${repeat + 1}-${c.id}`); const repo = join(directory, 'repo'); mkdirSync(repo, { recursive: true });
    const files = { '.gitignore': 'node_modules/\n', 'package.json': '{"type":"module","private":true}\n', [c.path]: c.before,
      'test/acceptance.mjs': `import test from 'node:test'; import assert from 'node:assert/strict'; import * as mod from '../${c.path}';\ntest(${JSON.stringify(c.id)},async()=>{${c.checks}});\n` };
    for (const [name, content] of Object.entries(files)) { mkdirSync(dirname(join(repo, name)), { recursive: true }); writeFileSync(join(repo, name), content); }
    git(repo, 'init', '-q'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Fixed evaluation baseline');
    const baseSha = git(repo, 'rev-parse', 'HEAD').trim();
    const life = new Lifecycle(join(directory, 'state')); const started = performance.now(); let doc; let error = null;
    const request = `${c.request}\nOnly ${c.path} and optional test/regression.mjs may be edited. The fixed test/acceptance.mjs oracle must remain unchanged. No dependency or infrastructure changes. This is a disposable evaluation fixture with all functional choices specified.`;
    try {
      const route = pathway === 'auto' && c.pathway === 'compact' ? 'compact' : pathway;
      doc = await life.draft({ repo, config: caseConfig, request,
        ...(route === 'compact' ? { compactTask: { id: 'IMPLEMENT', title: c.id, description: c.request, acceptance: [c.request], allowedPaths: [c.path, 'test/regression.mjs'] } }
          : { ...(route !== 'legacy' ? { pathway: route } : {}), ...(planning === 'fixture' ? { proposal: proposal(c, request) } : {}) }), signal: controller.signal });
      if (!doc.data.content.tasks.every(t => t.allowedPaths.every(p => [c.path, 'test/regression.mjs'].includes(p)))) throw new Error('Product scope exceeds the fixed evaluation envelope');
      doc = await life.approveSpec(doc.id, life.summary(doc).hash, 'SIMULATED EVALUATION OWNER', 'Explicit opt-in disposable benchmark approval; no real product approval.');
      doc = await life.run(doc.id, { signal: controller.signal });
    } catch (cause) { error = String(cause); }
    finally {
      doc ??= life.store.documents('spec').at(-1);
      if (doc) doc = life.get(doc.id);
      const untouched = git(repo, 'rev-parse', 'HEAD').trim() === baseSha && git(repo, 'status', '--porcelain').trim() === '';
      const cost = doc ? life.costSummary(doc.id) : { knownUsd: 0, unknownInvocations: 0, pendingInvocations: 0 };
      const success = !!doc && untouched && ['ready', 'awaiting_review'].includes(doc.data.status) && (!doc.data.qa || doc.data.qa.report.verdict === 'pass');
      const events = doc ? [...life.store.documentEvents(doc.id, ['invocation.started','invocation.finished']), ...doc.data.attempts.flatMap(a => life.pipeline.store.events(a.runId, ['invocation.started','invocation.finished']))] : [];
      const calls = events.filter(e => e.type === 'invocation.started');
      const observedModels = [...new Set(events.filter(e => e.type === 'invocation.finished').flatMap(e => e.data.usage?.models ?? []))];
      samples.push({ caseId: c.id, configuration: label, success, wallMs: performance.now() - started, planningMs: doc?.data.planningMs ?? 0, activeMs: doc?.data.activeMs ?? 0, cost,
        invocations: calls.length, inputBytes: calls.reduce((n,e)=>n+(e.data.inputBytes ?? 0),0) });
      if (/hit your (?:session|weekly) limit|api_error_status[^\n]{0,8}429|rate.limit|not logged in|authentication failed/i.test(error ?? doc?.data.error?.message ?? ''))
        stoppedReason = 'Provider unavailable (quota or authentication); do not score this as model quality or retry the remaining cases';
      details.push({ caseId: c.id, repeat, specId: doc?.id ?? null, status: doc?.data.status ?? 'failed-before-draft', error: error ?? doc?.data.error ?? null, untouched, directory,
        executionPath: doc?.data.executionPath ?? 'legacy', observedModels, requestedModels: [...new Set(calls.map(e=>e.data.requestedModel))],
        reviewerChecklist: ['Behavior and negative cases', 'Existing boundaries and justified abstractions', 'Meaningful independent tests', 'Error handling and security', 'Readable diff without speculative machinery'] });
      life.close(); save();
    }
  }
} finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); save(); }
console.log(JSON.stringify(evaluationReport(samples), null, 2));
if (controller.signal.aborted) process.exitCode = 130;
else if (stoppedReason || samples.some(s => !s.success)) process.exitCode = 1;
