import type { AgentConfig, Config, Lane } from '../domain/contracts.js';

export type ExecutionRole = 'product' | 'design' | 'implementer' | 'qa';
/** Explicit, provider-specific routing. No implicit upgrade or unmeasured model ranking. */
export function roleAgent(config: Config, role: ExecutionRole, lane: Lane): AgentConfig {
  const agent = role === 'implementer' ? config.agent
    : role === 'design' ? config.roles.design ?? config.roles.product ?? config.agent
      : config.roles[role] ?? config.agent;
  const route = config.modelRouting?.find(r => r.provider === agent.type && r.role === role && r.lane === lane);
  const profiles = config.roleProfiles?.find(r => r.provider === agent.type && r.role === role);
  const profile = profiles?.[lane === 'high' ? 'deep' : 'quick'];
  return route ? { ...agent, model: route.model, effort: route.effort } : profile ? { ...agent, ...profile } : agent;
}
