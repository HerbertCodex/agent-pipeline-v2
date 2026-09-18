import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateConfig } from '../domain/contracts.js';
import { invariant } from '../domain/errors.js';
import { parseJson } from '../domain/schema.js';
import { modelPlan, roleAgent } from '../adapters/routing.js';
import { ensureModelReady } from '../adapters/model-check.js';
import { invocationTotals } from '../adapters/invocations.js';
import { environment } from '../execution/process.js';
import { Store } from '../persistence/store.js';
export const modelsHelp = `Model policy:
  apv2 models --config FILE              Explain effective models for each role and risk lane (offline)
  apv2 models check --config FILE [--execute]
                                        --execute makes bounded, billed probes without project content
  apv2 models replace --config FILE --provider codex|claude --from OLD --to NEW --output NEW_FILE
                                        Write a reviewed replacement candidate; never edit the source config
`;
export function replaceModel(config, provider, from, to) {
    invariant(['codex', 'claude'].includes(provider) && from.trim() && to.trim() && from !== to, 'ARGUMENT', 'Supply provider, distinct --from and --to model identifiers.');
    let count = 0;
    const change = (entry, matches) => {
        if (!matches || entry.model !== from)
            return entry;
        count++;
        return { ...entry, model: to };
    };
    const next = { ...config, agent: change(config.agent, config.agent.type === provider),
        roles: Object.fromEntries(Object.entries(config.roles).map(([role, a]) => [role, a ? change(a, a.type === provider) : null])),
        roleProfiles: config.roleProfiles.map(p => ({ ...p, quick: change(p.quick, p.provider === provider), deep: change(p.deep, p.provider === provider) })),
        modelRouting: config.modelRouting.map(r => change(r, r.provider === provider)) };
    invariant(count > 0, 'MODEL_SELECTION', 'No matching model in this provider configuration; nothing was written.');
    return validateConfig(next);
}
export async function modelsCommand(args, values, root, signal) {
    const str = (name) => typeof values[name] === 'string' ? values[name] : undefined;
    invariant(str('config'), 'ARGUMENT', 'Supply --config FILE');
    const text = readFileSync(resolve(str('config')), 'utf8');
    invariant(Buffer.byteLength(text) <= 2000000, 'INPUT_SIZE', 'Configuration exceeds 2 MB');
    const config = validateConfig(parseJson(text));
    const action = args[1];
    invariant(!action || ['check', 'replace'].includes(action), 'ARGUMENT', 'Use models, models check or models replace');
    if (action === 'replace') {
        invariant(str('provider') && str('from') && str('to') && str('output'), 'ARGUMENT', 'Supply --provider, --from, --to and --output NEW_FILE');
        const replacement = replaceModel(config, str('provider'), str('from'), str('to'));
        const output = resolve(str('output'));
        writeFileSync(output, JSON.stringify(replacement, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify({ output, models: modelPlan(replacement), next: 'Review this file, run models check --execute, then adopt it for NEW specs. Existing approved specs keep their configuration; use spec budget role tuning for a retained spec.' }, null, 2));
        return;
    }
    const plan = modelPlan(config);
    if (action !== 'check' || values['execute'] !== true) {
        console.log(JSON.stringify({ models: plan, note: 'No model contacted. Availability and quality are not inferred from a name. models check --execute can consume quota: each distinct native model/effort has a 60-second probe, capped at 0.25 USD for Claude; Codex monetary cost may be unknown.' }, null, 2));
        return;
    }
    const store = new Store(root);
    const doc = store.createDocument('model-check', { models: plan });
    const token = store.acquireDocument(doc.id);
    const ids = new Map();
    const hooks = { onStart: (pid) => { ids.set(pid, store.startDocumentChild(doc.id, pid)); }, onFinish: (pid) => { const id = ids.get(pid); if (id) {
            store.finishDocumentChild(id);
            ids.delete(pid);
        } } };
    let passed = false;
    try {
        for (const row of plan) {
            if (row.provider === 'command')
                continue;
            const agent = { ...roleAgent(config, row.role, row.lane), preflight: 'probe' };
            await ensureModelReady(agent, { store, owner: { kind: 'document', id: doc.id }, env: environment([...config.environment.passEnv, ...agent.passEnv]), signal, hooks });
        }
        passed = true;
    }
    finally {
        const cost = invocationTotals(store.documentEvents(doc.id, ['invocation.started', 'invocation.finished']));
        store.documentEvent(doc.id, 'models.checked', { passed, cost });
        console.log(JSON.stringify({ id: doc.id, passed, cost, note: 'A passed probe verifies a native structured response now, not code quality. Command adapters were not probed; provider defaults must be selected explicitly.' }, null, 2));
        store.releaseDocument(doc.id, token);
        store.close();
    }
}
//# sourceMappingURL=models.js.map