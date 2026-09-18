import { agentSchema, validateConfig } from '../domain/contracts.js';
import { s } from '../domain/schema.js';
import { invariant } from '../domain/errors.js';
import { providerProfile } from './providers.js';
const choiceSchema = s.object({
    provider: s.enum(['claude', 'codex']), model: s.string(1, 200, /\S/),
    effort: s.enum(['low', 'medium', 'high']),
});
export const modelSelectionSchema = s.object({ quick: choiceSchema, deep: choiceSchema, qa: choiceSchema });
export function validateModelSelection(input) {
    const selection = modelSelectionSchema.parse(input);
    invariant(selection.quick.provider === selection.deep.provider, 'MODEL_SELECTION', 'Quick and deep execution profiles must use the same provider; QA may use another provider.');
    return selection;
}
export function selectedAgent(choice) {
    return agentSchema.parse({ ...providerProfile(choice.provider), model: choice.model, effort: choice.effort, preflight: 'probe' });
}
/** Only an operator selection can set model policy; Setup cannot replace it. */
export function applyModelSelection(config, selection) {
    const { quick, deep, qa } = selection;
    return validateConfig({ ...config, agent: selectedAgent(quick),
        roles: { product: selectedAgent(quick), design: selectedAgent(deep), qa: selectedAgent(qa) },
        modelRouting: [],
        roleProfiles: ['product', 'design', 'implementer'].map(role => ({ provider: quick.provider, role,
            quick: { model: quick.model, effort: quick.effort }, deep: { model: deep.model, effort: deep.effort } })),
        workflow: { ...config.workflow, qaProfile: 'deep' } });
}
//# sourceMappingURL=model-selection.js.map