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
        runnerSetup: config.setup.map(step => step.command.join(' ')),
        gates: config.gates.map(g => ({ id: g.id, command: g.command.join(' '), lanes: g.lanes, mandatory: g.mandatory })),
        rules: [
            'Only the runner executes setup and gates, in a fresh worktree, after the Implementer has finished editing files.',
            'A task must not require the Implementer to run commands, install or update dependencies, regenerate lockfiles, run code generators or migrations, or access the network unless its capabilities above allow it.',
            'When the change needs such a step (for example a new dependency and its lockfile), make it an operator prerequisite: ask a Product question or state it as an explicit precondition outside the tasks.',
        ],
    };
}
//# sourceMappingURL=capabilities.js.map