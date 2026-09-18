import type { AgentConfig, Config, Lane } from '../domain/contracts.js';
export type ExecutionRole = 'product' | 'design' | 'implementer' | 'qa';
export declare const executionRoles: ExecutionRole[];
/** Resolve policy, not an unmeasured ranking of model names. */
export declare function modelChoice(config: Config, role: ExecutionRole, lane: Lane): {
    agent: {
        readonly type: "command" | "codex" | "claude";
        readonly command: string[];
        readonly timeoutMs: number;
        readonly passEnv: string[];
        readonly model: string;
        readonly effort: "default" | "high" | "low" | "medium";
        readonly preflight: "off" | "probe";
        readonly maxTurns: number;
        readonly maxBudgetUsd: number | null;
    };
    role: ExecutionRole;
    lane: "fast" | "standard" | "high";
    effectiveLane: "fast" | "standard" | "high";
    source: string;
    reason: string;
};
export declare function roleAgent(config: Config, role: ExecutionRole, lane: Lane): AgentConfig;
export type AgentTuning = Partial<Pick<AgentConfig, 'model' | 'effort' | 'timeoutMs' | 'maxTurns' | 'maxBudgetUsd'>>;
export interface ModelOverrides {
    agent?: AgentTuning | null;
    roles?: Partial<Record<ExecutionRole, AgentTuning>>;
}
export declare function applyModelOverrides(agent: AgentConfig, config: Config, role: ExecutionRole, overrides?: ModelOverrides): AgentConfig;
export declare function modelPlan(config: Config, overrides?: ModelOverrides): {
    provider: "command" | "codex" | "claude";
    model: string | null;
    effort: "default" | "high" | "low" | "medium";
    preflight: "off" | "probe";
    availability: string;
    source: string;
    reason: string;
    role: ExecutionRole;
    lane: "fast" | "standard" | "high";
    effectiveLane: "fast" | "standard" | "high";
}[];
