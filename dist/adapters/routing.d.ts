import type { AgentConfig, Config, Lane } from '../domain/contracts.js';
export type ExecutionRole = 'product' | 'design' | 'implementer' | 'qa';
/** Explicit, provider-specific routing. No implicit upgrade or unmeasured model ranking. */
export declare function roleAgent(config: Config, role: ExecutionRole, lane: Lane): AgentConfig;
