#!/usr/bin/env node
import { knowledgeHelp, knowledgeCommand } from './knowledge/cli.js';
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { lifecycleCommand, lifecycleHelp } from './lifecycle/cli.js';
import { specSchema, qaSchema, designProposalSchema, securityPlanSchema } from './lifecycle/contracts.js';
import { bootstrapProposalSchema } from './lifecycle/bootstrap.js';
import { securityContextSchema } from './security/owasp.js';
import { decisionLedgerSchema, semanticReviewSchema } from './lifecycle/decisions.js';
import { Pipeline, summarize } from './engine/pipeline.js';
import { taskSchema, configSchema, agentOutputSchema, receiptSchema, VERSION } from './domain/contracts.js';
import { parseJson } from './domain/schema.js';
import { PipelineError, errorMessage, invariant } from './domain/errors.js';
const help = `Agent Pipeline V2 ${VERSION} — local trusted runner

apv2 init --repo PATH                   Write an example operator config (never overwrite)
apv2 run --repo PATH --config FILE --task FILE [--base REF]
apv2 resume RUN_ID [--accept-current]    Never blindly replay an interrupted agent
apv2 verify RUN_ID                      Revalidate candidate; clears previous approvals
apv2 status [RUN_ID]                    Inspect run(s)
apv2 events RUN_ID                      Print ordered JSONL audit events
apv2 approve RUN_ID --sha SHA --reviewer NAME --note TEXT
apv2 reject RUN_ID --note TEXT
apv2 export RUN_ID --output FILE        Export an exact reviewed/validated patch
apv2 recover RUN_ID --confirm-stopped   Explicit crash recovery after orphan inspection
apv2 schemas --output DIRECTORY         Export the runtime contracts as JSON Schema

${knowledgeHelp}
${lifecycleHelp}
All commands accept --state-dir DIR (default: ~/.local/state/agent-pipeline-v2).
Execution requires Linux/macOS/WSL, Git and Node >=22.16. The legacy task commands never push or merge.
Exit: 0 ready/inspection, 2 awaiting review, 1 failed, 130 interrupted.
`;
export const exampleConfig = {
    schemaVersion: 1, executionMode: 'local-trusted', environment: { id: 'REPLACE-with-pinned-environment-id' },
    agent: { type: 'codex', passEnv: ['HOME', 'CODEX_HOME', 'CODEX_API_KEY'] },
    setup: [{ command: ['npm', 'ci', '--ignore-scripts'], timeoutMs: 300000, passEnv: ['HOME'] }],
    gates: [
        { id: 'typecheck', command: ['npm', 'run', 'typecheck'], lanes: ['standard', 'high'], cacheTtlMs: 0 },
        { id: 'test', command: ['npm', 'test'], lanes: ['standard', 'high'], cacheTtlMs: 0 },
        { id: 'diff-check', command: ['git', 'diff', '--check', '{{baseSha}}', '{{candidateSha}}'], mandatory: true, cacheTtlMs: 0 },
    ], concurrency: 2, maxRepairAttempts: 1,
};
function load(path) {
    const text = readFileSync(resolve(path), 'utf8');
    invariant(text.length <= 2000000, 'INPUT_SIZE', 'Input file exceeds 2 MB');
    return parseJson(text);
}
async function main() {
    const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
            provider: { type: 'string' }, 'review-mode': { type: 'string' }, role: { type: 'string' }, repo: { type: 'string' }, config: { type: 'string' }, task: { type: 'string' }, base: { type: 'string' },
            'state-dir': { type: 'string' }, sha: { type: 'string' }, reviewer: { type: 'string' }, note: { type: 'string' }, output: { type: 'string' },
            request: { type: 'string' }, 'request-file': { type: 'string' }, file: { type: 'string' },
            repository: { type: 'string' }, remote: { type: 'string' }, 'confirm-push': { type: 'boolean' }, 'confirm-pr': { type: 'boolean' },
            hash: { type: 'string' }, agent: { type: 'string' }, name: { type: 'string' }, target: { type: 'string' },
            assist: { type: 'boolean' }, execute: { type: 'boolean' }, commit: { type: 'boolean' }, confirm: { type: 'boolean' }, approve: { type: 'boolean' }, amendment: { type: 'string' },
            'manual-qa': { type: 'boolean' }, quiet: { type: 'boolean' }, format: { type: 'string' }, active: { type: 'boolean' },
            id: { type: 'string' }, 'older-than': { type: 'string' },
            'accept-current': { type: 'boolean' }, 'confirm-stopped': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
        } });
    const [command, id] = positionals;
    const required = (value, name) => { invariant(value, 'ARGUMENT', `Missing ${name}`); return value; };
    if (values.version) {
        console.log(VERSION);
        return;
    }
    if (values.help || !command) {
        console.log(help);
        return;
    }
    if (['roles', 'skills', 'providers', 'inspect', 'inventory'].includes(command)) {
        await knowledgeCommand(command, positionals, values);
        return;
    }
    if (command === 'init') {
        const file = resolve(values.repo ?? '.', 'pipeline.v2.json');
        writeFileSync(file, JSON.stringify(exampleConfig, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        console.log(`Created ${file}. Adapt commands to your project, review the security model, then commit this config.`);
        return;
    }
    if (command === 'schemas') {
        const dir = resolve(required(values.output, '--output'));
        mkdirSync(dir, { recursive: true });
        for (const [name, schema] of [['task', taskSchema], ['config', configSchema], ['agent-output', agentOutputSchema], ['receipt', receiptSchema], ['spec', specSchema], ['qa', qaSchema], ['design', designProposalSchema], ['bootstrap', bootstrapProposalSchema], ['decision-ledger', decisionLedgerSchema], ['semantic-review', semanticReviewSchema], ['security-context', securityContextSchema], ['security-plan', securityPlanSchema]]) {
            writeFileSync(join(dir, `${name}.schema.json`), JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema.json }, null, 2) + '\n');
        }
        console.log(`Schemas written to ${dir}`);
        return;
    }
    if (['bootstrap', 'onboard', 'doctor', 'spec', 'ask', 'gc', 'prune', 'decisions'].includes(command)) {
        const root = resolve(values['state-dir'] ?? join(homedir(), '.local', 'state', 'agent-pipeline-v2'));
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        try {
            await lifecycleCommand(command, positionals, values, root, controller.signal);
        }
        finally {
            process.removeListener('SIGINT', stop);
            process.removeListener('SIGTERM', stop);
        }
        return;
    }
    invariant(['run', 'resume', 'verify', 'status', 'events', 'approve', 'reject', 'export', 'recover'].includes(command), 'ARGUMENT', `Unknown command ${command}`);
    const root = resolve(values['state-dir'] ?? join(homedir(), '.local', 'state', 'agent-pipeline-v2'));
    const pipeline = new Pipeline(root);
    const controller = new AbortController();
    const stop = () => { controller.abort(); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
        let run;
        switch (command) {
            case 'run': {
                const created = await pipeline.create({ repo: required(values.repo, '--repo'), config: load(required(values.config, '--config')), task: load(required(values.task, '--task')),
                    ...(values.base ? { baseRef: values.base } : {}) });
                console.error(`Run ${created.id}\nState: ${root}\nLocal-trusted execution: worktrees are not a security sandbox.`);
                run = await pipeline.execute(created.id, { signal: controller.signal });
                break;
            }
            case 'resume':
                run = await pipeline.execute(required(id, 'RUN_ID'), { signal: controller.signal, acceptCurrentCandidate: values['accept-current'] ?? false });
                break;
            case 'verify':
                run = await pipeline.revalidate(required(id, 'RUN_ID'), { signal: controller.signal });
                break;
            case 'status':
                console.log(JSON.stringify(id ? { ...summarize(pipeline.store.get(id)), activeProcesses: pipeline.store.activeProcesses(id) } : pipeline.store.list().map(summarize), null, 2));
                return;
            case 'events':
                for (const event of pipeline.store.events(required(id, 'RUN_ID')))
                    console.log(JSON.stringify(event));
                return;
            case 'approve':
                run = await pipeline.approve(required(id, 'RUN_ID'), required(values.sha, '--sha'), required(values.reviewer, '--reviewer'), required(values.note, '--note'));
                break;
            case 'reject':
                run = pipeline.reject(required(id, 'RUN_ID'), required(values.note, '--note'));
                break;
            case 'recover':
                run = pipeline.recover(required(id, 'RUN_ID'), values['confirm-stopped'] ?? false);
                break;
            case 'export': {
                const file = resolve(required(values.output, '--output'));
                const patch = await pipeline.exportPatch(required(id, 'RUN_ID'));
                mkdirSync(dirname(file), { recursive: true });
                writeFileSync(file, patch, { flag: 'wx', mode: 0o600 });
                console.log(JSON.stringify({ patch: file }, null, 2));
                return;
            }
        }
        invariant(run, 'INTERNAL', 'Missing command result');
        console.log(JSON.stringify(summarize(run), null, 2));
        process.exitCode = run.state === 'interrupted' ? 130 : run.state === 'awaiting_review' ? 2 : ['failed', 'rejected'].includes(run.state) ? 1 : 0;
    }
    finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        pipeline.close();
    }
}
main().catch((error) => {
    console.error(JSON.stringify({ error: error instanceof PipelineError ? error.code : 'ERROR', message: errorMessage(error) }));
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map