import { invariant } from '../domain/errors.js';
/** Null disables a ceiling; only an absent amendment inherits the approved configuration. */
export function specCostCeiling(record) {
    return record.operational && Object.hasOwn(record.operational, 'maxSpecCostUsd')
        ? record.operational.maxSpecCostUsd : record.config.workflow.maxSpecCostUsd;
}
/** Does not alter credentials, permissions, timeouts or provider quotas. */
export function executionAgent(agent) {
    if (agent.type !== 'command' && agent.usageMode && agent.usageMode !== 'legacy')
        invariant(agent.model.trim() && !/^YOUR_/i.test(agent.model), 'MODEL_SELECTION', 'Choose an explicit model for subscription/metered execution; configure quick, deep and QA or the role model.');
    return agent.usageMode === 'subscription' ? { ...agent, maxBudgetUsd: null } : agent;
}
//# sourceMappingURL=billing.js.map