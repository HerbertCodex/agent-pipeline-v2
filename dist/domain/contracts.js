import { skillsSchema } from './knowledge.js';
import { s } from './schema.js';
import { invariant } from './errors.js';
export const VERSION = '2.0.0-alpha.8';
export const lanes = ['fast', 'standard', 'high'];
const id = s.string(1, 80, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const paths = s.array(s.string(1, 500), 0, 500);
const argv = s.array(s.string(1, 16000), 1, 200);
const envNames = s.array(s.string(1, 100, /^[a-zA-Z_][a-zA-Z0-9_]*$/), 0, 100);
export const commandSchema = s.object({
    command: argv,
    timeoutMs: s.default(s.number(10, 3600000), 120000),
    passEnv: s.default(envNames, []),
});
export const gateSchema = s.object({
    id, command: argv,
    timeoutMs: s.default(s.number(10, 3600000), 120000),
    passEnv: s.default(envNames, []),
    dependsOn: s.default(s.array(id), []),
    resources: s.default(s.array(id), []),
    outputs: s.default(paths, []),
    paths: s.default(paths, []),
    lanes: s.default(s.array(s.enum(lanes), 1, 3), [...lanes]),
    mandatory: s.default(s.boolean(), false),
    // Explicit opt-in. A zero TTL NEVER participates in cross-validation caching.
    cacheTtlMs: s.default(s.number(0, 86400000), 0),
});
export const taskSchema = s.object({
    id, title: s.string(1, 500), description: s.string(1, 30000),
    acceptance: s.array(s.string(1, 3000), 1, 100),
    allowedPaths: s.array(s.string(1, 500), 1, 500),
    // Existing files remain strict. New supporting files may be created only inside
    // explicitly declared envelopes, with a small deterministic count limit.
    allowedNewPaths: s.default(s.array(s.string(1, 500), 0, 100), []),
    maxNewFiles: s.default(s.number(0, 50), 0),
    // Lifecycle-managed tasks defer human review to the integrated candidate.
    reviewRequired: s.default(s.boolean(), true),
    minimumLane: s.default(s.enum(lanes), 'fast'),
});
export const agentSchema = s.object({
    type: s.enum(['command', 'codex', 'claude']),
    command: s.default(s.array(s.string(1, 16000), 0, 200), []),
    timeoutMs: s.default(s.number(10, 3600000), 900000),
    passEnv: s.default(envNames, []),
    model: s.default(s.string(0, 200), ''),
    maxTurns: s.default(s.number(1, 200), 32),
    maxBudgetUsd: s.default(s.nullable(s.finite(0.01, 1000)), null),
});
export const configSchema = s.object({
    schemaVersion: s.literal(1),
    executionMode: s.literal('local-trusted'),
    environment: s.object({
        id: s.string(1, 500),
        passEnv: s.default(envNames, ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG']),
    }),
    agent: agentSchema,
    skills: s.default(skillsSchema, { enabled: [], projectType: 'unknown', maxContextBytes: 16000 }),
    roles: s.default(s.object({
        product: s.default(s.nullable(agentSchema), null),
        qa: s.default(s.nullable(agentSchema), null),
    }), { product: null, qa: null }),
    workflow: s.default(s.object({
        qaLanes: s.default(s.array(s.enum(lanes), 0, 3), ['standard', 'high']),
        maxQaRepairs: s.default(s.number(0, 3), 2),
        maxActiveMs: s.default(s.number(100, 14400000), 3600000),
        reviewMode: s.default(s.enum(['solo', 'team', 'regulated']), 'team'),
    }), { qaLanes: ['standard', 'high'], maxQaRepairs: 2, maxActiveMs: 3600000, reviewMode: 'team' }),
    setup: s.default(s.array(commandSchema, 0, 20), []),
    gates: s.array(gateSchema, 1, 100),
    concurrency: s.default(s.number(1, 16), 3),
    failFast: s.default(s.boolean(), true),
    maxRunMs: s.default(s.number(100, 7200000), 1800000),
    maxRepairAttempts: s.default(s.number(0, 3), 1),
    validationMaxAgeMs: s.default(s.number(1000, 86400000), 3600000),
    risk: s.default(s.object({
        fastPaths: s.default(paths, ['docs/**', '*.md']),
        highPaths: s.default(paths, []),
        maxFastFiles: s.default(s.number(1, 100), 5),
        maxFastLines: s.default(s.number(1, 1000), 100),
    }), { fastPaths: ['docs/**', '*.md'], highPaths: [], maxFastFiles: 5, maxFastLines: 100 }),
});
export const agentOutputSchema = s.object({ summary: s.string(1, 12000) });
export const states = ['created', 'preparing', 'implementing', 'candidate', 'validating', 'awaiting_review', 'ready', 'failed', 'interrupted', 'rejected'];
const digest = s.string(64, 64, /^[a-f0-9]{64}$/);
const sha = s.string(40, 64, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const receiptSchema = s.object({
    id, runId: id, gateId: id, key: digest, candidateSha: sha, configHash: digest, environmentHash: digest,
    status: s.enum(['passed', 'failed', 'timed_out', 'cancelled', 'spawn_error', 'blocked', 'cached']),
    startedAt: s.number(0, Number.MAX_SAFE_INTEGER), durationMs: s.finite(0, 7200000),
    exitCode: s.nullable(s.number(0, 255)),
    stdoutHash: s.string(0, 64, /^(?:[a-f0-9]{64})?$/), stderrHash: s.string(0, 64, /^(?:[a-f0-9]{64})?$/),
    diagnostic: s.string(0, 8000), reusedFrom: s.nullable(id),
});
export function validateReceipt(value) {
    const r = receiptSchema.parse(value);
    if (r.status === 'passed' || r.status === 'cached')
        invariant(r.exitCode === 0 && r.stdoutHash.length === 64 &&
            r.stderrHash.length === 64, 'RECEIPT', 'Successful receipt requires exit 0 and both stream digests');
    invariant((r.status === 'cached') === (r.reusedFrom !== null), 'RECEIPT', 'Only cache hits may reference an earlier receipt');
    return r;
}
export function validateConfig(value) {
    const config = configSchema.parse(value);
    invariant(config.agent.type !== 'command' || config.agent.command.length > 0, 'CONFIG', 'Command agent requires an argv array');
    invariant(config.agent.type !== 'codex' || config.agent.command.length <= 1, 'CONFIG', 'Codex command may contain only the executable path; use the typed model field');
    for (const agent of [config.agent, config.roles.product, config.roles.qa].filter((a) => a !== null)) {
        invariant(agent.type !== 'command' || agent.command.length > 0, 'CONFIG', 'Role command agent requires an argv array');
        invariant(agent.type === 'command' || agent.command.length <= 1, 'CONFIG', 'Native provider accepts only the executable path');
    }
    invariant(new Set(config.skills.enabled).size === config.skills.enabled.length, 'CONFIG', 'Duplicate enabled skill');
    const ids = config.gates.map(g => g.id);
    invariant(new Set(ids).size === ids.length, 'CONFIG', 'Duplicate gate id');
    for (const gate of config.gates) {
        if (gate.cacheTtlMs > 0)
            invariant(gate.outputs.length === 0 && gate.dependsOn.length === 0 &&
                !config.gates.some(g => g.dependsOn.includes(gate.id)), 'CONFIG', `Receipt-only caching is limited to independent, output-free checks in this alpha: ${gate.id}`);
        invariant(new Set(gate.dependsOn).size === gate.dependsOn.length, 'CONFIG', `Duplicate dependency: ${gate.id}`);
        for (const dep of gate.dependsOn)
            invariant(ids.includes(dep), 'CONFIG', `Unknown dependency ${dep}`);
    }
    return config;
}
const transitions = {
    created: ['preparing', 'failed', 'interrupted'],
    preparing: ['implementing', 'failed', 'interrupted'],
    implementing: ['candidate', 'failed', 'interrupted'],
    candidate: ['validating', 'failed', 'interrupted'],
    validating: ['implementing', 'awaiting_review', 'ready', 'failed', 'interrupted'],
    awaiting_review: ['ready', 'rejected', 'validating', 'failed'],
    ready: ['validating', 'failed'],
    failed: [], rejected: [],
    interrupted: ['preparing', 'candidate', 'validating', 'failed'],
};
export function transition(run, to) {
    invariant(transitions[run.state].includes(to), 'TRANSITION', `Illegal transition ${run.state} -> ${to}`);
    run.state = to;
}
//# sourceMappingURL=contracts.js.map