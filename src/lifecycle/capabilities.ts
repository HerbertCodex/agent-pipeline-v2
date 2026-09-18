import { DEFAULT_GENERATED_PATHS, type Config } from '../domain/contracts.js';
import { invariant } from '../domain/errors.js';
import { matches } from '../policy/policy.js';
import type { Spec } from './contracts.js';

/** Implementers known to have no command execution at all. Unknown wrappers are not guessed. */
const NO_SHELL = new Set<Config['agent']['type']>(['claude']);

/**
 * What the configured roles can actually do, derived from the reviewed configuration and the native
 * adapter contracts. Product plans against this instead of assuming a shell, a package manager or
 * network access that the Implementer does not have.
 */
export function executionCapabilities(config: Config) {
  const implementer = config.agent.type;
  const implementerTools = implementer === 'claude'
    ? { fileEdits: true, shell: false, network: false, subagents: false, note: 'Claude Code with Read/Glob/Grep/Edit/Write only; it cannot run commands, install dependencies or regenerate lockfiles.' }
    : implementer === 'codex'
      ? { fileEdits: true, shell: 'provider-sandboxed', network: false, subagents: false, note: 'Codex workspace-write sandbox; command execution and network are provider-controlled and not guaranteed. Do not rely on installs or generators.' }
      : { fileEdits: 'wrapper-defined', shell: 'unknown', network: 'unknown', subagents: 'unknown', note: 'Command-protocol wrapper: capabilities are defined by the operator wrapper. Assume no command execution unless the spec is told otherwise.' };
  return {
    implementer: { provider: implementer, ...implementerTools },
    // One task is one agent session bounded by these limits. A task larger than a session is not slower:
    // the provider stops mid-work and the whole attempt has to be adopted or started again.
    attempt: {
      providerTurns: config.agent.maxTurns ?? null,
      providerBudgetUsd: config.agent.maxBudgetUsd ?? null,
      agentTimeoutMs: config.agent.timeoutMs,
      runBudgetMs: config.maxRunMs,
      repairAttempts: config.maxRepairAttempts,
    },
    feedback: config.feedback ?? { gateIds: [], maxCalls: 0, maxTotalMs: 0 },
    runnerSetup: config.setup.map(step => step.command.join(' ')),
    gates: config.gates.map(g => ({ id: g.id, covers: g.covers ?? [], testPaths: g.testPaths ?? [], paths: g.paths, command: g.command.join(' '), lanes: g.lanes, mandatory: g.mandatory })),
    validationRules: config.validationRules ?? [],
    qualityReview: config.workflow.qualityReview,
    generatedPaths: config.workflow.generatedPaths ?? [...DEFAULT_GENERATED_PATHS],
    rules: [
      'In evidence mode, code needs behavioral tests, UI needs browser checks, compiled/build inputs need a production build, and structural/high-risk or integration-boundary changes need integration tests. Project validationRules can add obligations. Missing evidence blocks validation without code repairs; raise missing commands as prerequisites before implementation. Security negative tests need testPaths reviewed against the gate command.',
      'The runner performs independent final checks in a fresh worktree. If feedback.gateIds is nonempty, the Implementer can request those checks during its session through the bounded run_check tool; these observations are not final receipts.',
      'A task must not require the Implementer to run commands, install or update dependencies, regenerate lockfiles, run code generators or migrations, or access the network unless its capabilities above allow it.',
      'When the change needs such a step (for example a new dependency and its lockfile), make it an operator prerequisite: ask a Product question or state it as an explicit precondition outside the tasks.',
      'An Implementer without a shell must not receive a generatedPaths file in a task allowedPaths; the controller rejects such a spec.',
      'Size each task for one agent session: the files it may edit must be readable and writable in that single session, within attempt.agentTimeoutMs and the provider limits above. A task that reaches a provider limit produces nothing usable.',
      'Split by surface, not by layer: one route, module or screen with its own tests per task, rather than one task that touches every route and a second that touches every test.',
      'Every task must leave the repository in a state where the configured checks can pass on their own: they run after each task, not only at the end. When a task changes a shared declaration its callers rely on (rename, split, signature or return shape), either update those callers in the same task, or keep the previous declaration working until the task that migrates them runs. A task whose checks can only pass once a later task lands is not a task; merge them or order them differently.',
    ],
  };
}

/**
 * Deterministic guard: a task may not name a tool-generated file (lock files by default, configurable
 * through workflow.generatedPaths) when the configured Implementer cannot run the tool that regenerates
 * it. Wildcard allowedPaths are not interpreted here; scope policy governs them.
 */
export function validateTaskCapabilities(spec: Spec, config: Config): Spec {
  if (!NO_SHELL.has(config.agent.type)) return spec;
  const generated = config.workflow.generatedPaths ?? [...DEFAULT_GENERATED_PATHS];
  for (const task of spec.tasks) for (const path of task.allowedPaths) {
    if (/[*?]/.test(path)) continue;
    const pattern = generated.find(g => matches(path, g));
    invariant(!pattern, 'SPEC_CAPABILITY', `Task ${task.id} lists ${path} (generated file, workflow.generatedPaths ${pattern}), but the ${config.agent.type} Implementer has no shell to regenerate it. Make the dependency/tooling step an operator prerequisite outside the tasks, then keep only hand-edited files in allowedPaths.`);
  }
  return spec;
}

/** Advice about conflicting limits; short budgets are valid for compact work. */
export function configAdvice(config: Config): { setting: string; value: string; why: string }[] {
  const advice: { setting: string; value: string; why: string }[] = [];
  if (config.workflow.maxSpecCostUsd === null)
    advice.push({ setting: 'workflow.maxSpecCostUsd', value: 'null', why: 'No shared spec cost ceiling is configured. Set a reviewed budget; provider costs that are unknown remain explicitly unaccounted for.' });
  if (config.maxRunMs <= config.agent.timeoutMs)
    advice.push({ setting: 'maxRunMs', value: String(config.maxRunMs), why: 'The agent timeout fills the run budget. The controller shortens it to reserve final checks; align these limits with measured task duration.' });
  if (config.agent.maxBudgetUsd !== null && config.workflow.maxSpecCostUsd !== null && config.agent.maxBudgetUsd > config.workflow.maxSpecCostUsd)
    advice.push({ setting: 'agent.maxBudgetUsd', value: String(config.agent.maxBudgetUsd), why: 'The per-call limit exceeds the entire spec budget. The controller caps each supported call at the remaining declared spec budget.' });
  return advice;
}
