import type { AgentConfig } from '../domain/contracts.js';
import type { SpecRecord } from '../lifecycle/contracts.js';
/** Null disables a ceiling; only an absent amendment inherits the approved configuration. */
export declare function specCostCeiling(record: Pick<SpecRecord, 'operational' | 'config'>): number | null;
/** Does not alter credentials, permissions, timeouts or provider quotas. */
export declare function executionAgent(agent: AgentConfig): AgentConfig;
