import { DEFAULT_GENERATED_PATHS } from '../domain/contracts.js';
import { invariant } from '../domain/errors.js';
import { matches } from '../policy/policy.js';
/** Implementers known to have no command execution at all. Unknown wrappers are not guessed. */
const NO_SHELL = new Set(['claude']);
/**
 * What the configured roles can actually do, derived from the reviewed configuration and the native
 * adapter contracts. Product plans against this instead of assuming a shell, a package manager or
 * network access that the Implementer does not have.
 */
export function executionCapabilities(config) {
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
export function validateTaskCapabilities(spec, config) {
    if (!NO_SHELL.has(config.agent.type))
        return spec;
    const generated = config.workflow.generatedPaths ?? [...DEFAULT_GENERATED_PATHS];
    for (const task of spec.tasks)
        for (const path of task.allowedPaths) {
            if (/[*?]/.test(path))
                continue;
            const pattern = generated.find(g => matches(path, g));
            invariant(!pattern, 'SPEC_CAPABILITY', `Task ${task.id} lists ${path} (generated file, workflow.generatedPaths ${pattern}), but the ${config.agent.type} Implementer has no shell to regenerate it. Make the dependency/tooling step an operator prerequisite outside the tasks, then keep only hand-edited files in allowedPaths.`);
        }
    return spec;
}
//# sourceMappingURL=capabilities.js.map