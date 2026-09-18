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
    runnerSetup: config.setup.map(step => step.command.join(' ')),
    gates: config.gates.map(g => ({ id: g.id, command: g.command.join(' '), lanes: g.lanes, mandatory: g.mandatory })),
    generatedPaths: config.workflow.generatedPaths ?? [...DEFAULT_GENERATED_PATHS],
    rules: [
      'Only the runner executes setup and gates, in a fresh worktree, after the Implementer has finished editing files.',
      'A task must not require the Implementer to run commands, install or update dependencies, regenerate lockfiles, run code generators or migrations, or access the network unless its capabilities above allow it.',
      'When the change needs such a step (for example a new dependency and its lockfile), make it an operator prerequisite: ask a Product question or state it as an explicit precondition outside the tasks.',
      'An Implementer without a shell must not receive a generatedPaths file in a task allowedPaths; the controller rejects such a spec.',
      'Size each task for one agent session: the files it may edit must be readable and writable in that single session, within attempt.agentTimeoutMs and the provider limits above. A task that reaches a provider limit produces nothing usable.',
      'Split by surface, not by layer: one route, module or screen with its own tests per task, rather than one task that touches every route and a second that touches every test.',
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

/**
 * Bounds that cut work in progress instead of warning before it starts. Measured on a real project: a Product
 * round for a medium increment runs about 20 minutes, and an implementation attempt reads and writes several
 * files. A provider that stops at its turn, cost or time limit produces nothing usable, and a role leaves
 * nothing to salvage. This is advice on a reviewed configuration, never a refusal.
 */
export function configAdvice(config: Config): { setting: string; value: string; why: string }[] {
  const advice: { setting: string; value: string; why: string }[] = [];
  const minutes = (ms: number) => `${Math.round(ms / 60000)} min`;
  if (config.agent.maxTurns < 100)
    advice.push({ setting: 'agent.maxTurns', value: String(config.agent.maxTurns), why: 'A turn count measures neither work, time nor money. Below 100 it stops real attempts mid-work; keep it as a net against an endless loop (200) and bound cost and time instead.' });
  if (config.agent.timeoutMs < 1200000)
    advice.push({ setting: 'agent.timeoutMs', value: minutes(config.agent.timeoutMs), why: 'A Product round for a medium increment runs about 20 minutes. A shorter timeout kills rounds that would have produced a spec, and a role leaves nothing to salvage.' });
  if (config.agent.maxBudgetUsd !== null && config.agent.maxBudgetUsd < 10)
    advice.push({ setting: 'agent.maxBudgetUsd', value: `${config.agent.maxBudgetUsd} USD`, why: 'This ceiling is enforced by the provider, which stops mid-work: the money is spent and nothing is produced. Prefer workflow.maxSpecCostUsd, which stops between tasks and asks the operator.' });
  if (config.maxRepairAttempts < 2)
    advice.push({ setting: 'maxRepairAttempts', value: String(config.maxRepairAttempts), why: 'Fixing one red check often reveals the next; a single pass loses the whole attempt. The loop already stops by itself when a repair changes nothing or fails identically.' });
  if (config.workflow.maxSpecCostUsd === null)
    advice.push({ setting: 'workflow.maxSpecCostUsd', value: 'null', why: 'Nothing bounds what a whole spec may spend. This is the ceiling that warns instead of cutting: it stops between tasks, reports the declared cost and waits for an explicit authorization.' });
  if (config.maxRunMs <= config.agent.timeoutMs)
    advice.push({ setting: 'maxRunMs', value: minutes(config.maxRunMs), why: `An attempt is one agent session plus its checks. With agent.timeoutMs at ${minutes(config.agent.timeoutMs)}, an agent that uses its whole allowance leaves nothing for the checks and the run stops on BUDGET.` });
  return advice;
}
