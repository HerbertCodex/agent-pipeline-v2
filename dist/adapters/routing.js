export const executionRoles = ['product', 'design', 'implementer', 'qa'];
/** Resolve policy, not an unmeasured ranking of model names. */
export function modelChoice(config, role, lane) {
    const agent = role === 'implementer' ? config.agent
        : role === 'design' ? config.roles.design ?? config.roles.product ?? config.agent
            : config.roles[role] ?? config.agent;
    const effectiveLane = role === 'qa' && config.workflow.qaProfile === 'deep' ? 'high' : lane;
    const route = config.modelRouting?.find(r => r.provider === agent.type && r.role === role && r.lane === effectiveLane);
    const profiles = config.roleProfiles?.find(r => r.provider === agent.type && r.role === role);
    const profileName = effectiveLane === 'high' ? 'deep' : 'quick';
    const profile = profiles?.[profileName];
    const selected = route ? { ...agent, model: route.model, effort: route.effort } : profile ? { ...agent, ...profile } : agent;
    const source = route ? 'modelRouting' : profile ? `roleProfiles.${profileName}` : 'role-config';
    return { agent: selected, role, lane, effectiveLane, source,
        reason: `${role === 'qa' && config.workflow.qaProfile === 'deep' ? 'QA uses the dedicated deep policy independently of implementation risk. ' : ''}${source}; ${selected.model ? 'explicit model' : 'unresolved provider default'}.` };
}
export function roleAgent(config, role, lane) {
    return modelChoice(config, role, lane).agent;
}
export function applyModelOverrides(agent, config, role, overrides) {
    const shared = { ...overrides?.agent };
    if (role === 'qa' && (config.roles.qa || config.workflow.qaProfile === 'deep')) {
        delete shared.model;
        delete shared.effort;
    }
    return { ...agent, ...shared, ...overrides?.roles?.[role] };
}
export function modelPlan(config, overrides) {
    return executionRoles.flatMap(role => ['fast', 'standard', 'high'].map(lane => {
        const { agent: base, ...choice } = modelChoice(config, role, lane);
        const agent = applyModelOverrides(base, config, role, overrides);
        return { ...choice, ...(agent.model !== base.model || agent.effort !== base.effort ? { source: 'operational-amendment', reason: choice.reason + ' Model/effort adjusted by an explicit operational amendment.' } : {}), provider: agent.type, model: agent.model || null, effort: agent.effort, preflight: agent.preflight ?? 'off',
            availability: 'not-checked' };
    }));
}
//# sourceMappingURL=routing.js.map