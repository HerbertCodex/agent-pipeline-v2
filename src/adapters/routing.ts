import type { AgentConfig, Config, Lane } from '../domain/contracts.js';
import { decisionRecord } from '../policy/decision.js';

type ModelTarget = Pick<AgentConfig, 'model' | 'effort'>;
/** Replayable model precedence, with only the inputs that influence selection. */
/**
 * Drops absent fields instead of carrying them as undefined.
 * A configuration frozen before the contract gained a field stores it absent; naming it in an object
 * literal turns that absence into an undefined value, which no identity can be computed over. One such
 * record made the whole spec listing fail rather than the single spec it came from.
 */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
export function resolveModelDecision(inputs: { role: ExecutionRole; lane: Lane; provider: AgentConfig['type']; qaDeep: boolean;
  base: ModelTarget; route: ModelTarget | null; profile: ModelTarget | null; override: Partial<ModelTarget> }) {
  const effectiveLane = inputs.role === 'qa' && inputs.qaDeep ? 'high' : inputs.lane;
  const source = inputs.route ? 'modelRouting' : inputs.profile ? `roleProfiles.${effectiveLane === 'high' ? 'deep' : 'quick'}` : 'role-config';
  const selected = { ...(inputs.route ?? inputs.profile ?? inputs.base), ...inputs.override };
  return decisionRecord('model-routing', inputs, { ...selected, effectiveLane, provider: inputs.provider,
    source: Object.keys(inputs.override).length ? 'operational-amendment' : source },
    [source, ...(inputs.qaDeep && inputs.role === 'qa' ? ['dedicated-qa-policy'] : []),
      ...(Object.keys(inputs.override).length ? ['explicit-role-amendment'] : []), selected.model ? 'explicit-model' : 'unresolved-provider-default']);
}

export type ExecutionRole = 'product' | 'design' | 'implementer' | 'qa';
export const executionRoles: ExecutionRole[] = ['product', 'design', 'implementer', 'qa'];
/** Resolve policy, not an unmeasured ranking of model names. */
export function modelChoice(config: Config, role: ExecutionRole, lane: Lane) {
  const agent = role === 'implementer' ? config.agent
    : role === 'design' ? config.roles.design ?? config.roles.product ?? config.agent
      : config.roles[role] ?? config.agent;
  const effectiveLane = role === 'qa' && config.workflow.qaProfile === 'deep' ? 'high' : lane;
  const route = config.modelRouting?.find(r => r.provider === agent.type && r.role === role && r.lane === effectiveLane);
  const profiles = config.roleProfiles?.find(r => r.provider === agent.type && r.role === role);
  const profileName = effectiveLane === 'high' ? 'deep' : 'quick';
  const profile = profiles?.[profileName];
  const target = (a: ModelTarget): ModelTarget => defined({ model: a.model, effort: a.effort });
  const decision = resolveModelDecision({ role, lane, provider: agent.type, qaDeep: config.workflow.qaProfile === 'deep',
    base: target(agent), route: route ? target(route) : null, profile: profile ? target(profile) : null, override: {} });
  const selected = { ...agent, ...defined({ model: decision.result.model, effort: decision.result.effort }) };
  const source = decision.result.source;
  return { agent: selected, role, lane, effectiveLane, source, decision,
    reason: `${role === 'qa' && config.workflow.qaProfile === 'deep' ? 'QA uses the dedicated deep policy independently of implementation risk. ' : ''}${source}; ${selected.model ? 'explicit model' : 'unresolved provider default'}.` };
}
export function roleAgent(config: Config, role: ExecutionRole, lane: Lane): AgentConfig {
  return modelChoice(config, role, lane).agent;
}
export type AgentTuning = Partial<Pick<AgentConfig, 'model' | 'effort' | 'timeoutMs' | 'maxTurns' | 'maxBudgetUsd' | 'usageMode'>>;
export interface ModelOverrides { agent?: AgentTuning | null; roles?: Partial<Record<ExecutionRole, AgentTuning>> }
export function applyModelOverrides(agent: AgentConfig, config: Config, role: ExecutionRole, overrides?: ModelOverrides): AgentConfig {
  const shared = { ...overrides?.agent };
  if (role === 'qa' && (config.roles.qa || config.workflow.qaProfile === 'deep')) { delete shared.model; delete shared.effort; }
  return { ...agent, ...shared, ...overrides?.roles?.[role] };
}
export function modelPlan(config: Config, overrides?: ModelOverrides) {
  return executionRoles.flatMap(role => (['fast', 'standard', 'high'] as const).map(lane => {
    const { agent: base, ...choice } = modelChoice(config, role, lane);
    const agent = applyModelOverrides(base, config, role, overrides);
    const decision = resolveModelDecision({ ...choice.decision.inputs,
      override: { ...(agent.model !== base.model ? { model: agent.model } : {}), ...(agent.effort !== base.effort ? { effort: agent.effort } : {}) } });
    return { ...choice, ...(agent.model !== base.model || agent.effort !== base.effort ? { source: 'operational-amendment', reason: choice.reason + ' Model/effort adjusted by an explicit operational amendment.' } : {}), provider: agent.type, model: agent.model || null, effort: agent.effort, usageMode: agent.usageMode ?? 'legacy', maxBudgetUsd: agent.usageMode === 'subscription' ? null : agent.maxBudgetUsd, preflight: agent.preflight ?? 'off',
      decision, availability: 'not-checked' };
  }));
}
