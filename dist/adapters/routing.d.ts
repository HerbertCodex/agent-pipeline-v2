import type { AgentConfig, Config, Lane } from '../domain/contracts.js';
type ModelTarget = Pick<AgentConfig, 'model' | 'effort'>;
export declare function resolveModelDecision(inputs: {
    role: ExecutionRole;
    lane: Lane;
    provider: AgentConfig['type'];
    qaDeep: boolean;
    base: ModelTarget;
    route: ModelTarget | null;
    profile: ModelTarget | null;
    override: Partial<ModelTarget>;
}): {
    policyVersion: string;
    kind: string;
    inputs: {
        role: ExecutionRole;
        lane: Lane;
        provider: AgentConfig["type"];
        qaDeep: boolean;
        base: ModelTarget;
        route: ModelTarget | null;
        profile: ModelTarget | null;
        override: Partial<ModelTarget>;
    };
    inputHash: string;
    result: {
        effectiveLane: "fast" | "standard" | "high";
        provider: "command" | "codex" | "claude";
        source: string;
        model: string;
        effort: "default" | "high" | "low" | "medium";
    };
    reasons: string[];
    decisionHash: string;
};
export type ExecutionRole = 'product' | 'design' | 'implementer' | 'qa';
export declare const executionRoles: ExecutionRole[];
/** Resolve policy, not an unmeasured ranking of model names. */
export declare function modelChoice(config: Config, role: ExecutionRole, lane: Lane): {
    agent: {
        model: string;
        effort: "default" | "high" | "low" | "medium";
        type: "command" | "codex" | "claude";
        usageMode: "legacy" | "subscription" | "metered";
        command: string[];
        timeoutMs: number;
        passEnv: string[];
        preflight: "off" | "probe";
        maxTurns: number;
        maxBudgetUsd: number | null;
    };
    role: ExecutionRole;
    lane: "fast" | "standard" | "high";
    effectiveLane: "fast" | "standard" | "high";
    source: string;
    decision: {
        policyVersion: string;
        kind: string;
        inputs: {
            role: ExecutionRole;
            lane: Lane;
            provider: AgentConfig["type"];
            qaDeep: boolean;
            base: ModelTarget;
            route: ModelTarget | null;
            profile: ModelTarget | null;
            override: Partial<ModelTarget>;
        };
        inputHash: string;
        result: {
            effectiveLane: "fast" | "standard" | "high";
            provider: "command" | "codex" | "claude";
            source: string;
            model: string;
            effort: "default" | "high" | "low" | "medium";
        };
        reasons: string[];
        decisionHash: string;
    };
    reason: string;
};
export declare function roleAgent(config: Config, role: ExecutionRole, lane: Lane): AgentConfig;
export type AgentTuning = Partial<Pick<AgentConfig, 'model' | 'effort' | 'timeoutMs' | 'maxTurns' | 'maxBudgetUsd' | 'usageMode'>>;
export interface ModelOverrides {
    agent?: AgentTuning | null;
    roles?: Partial<Record<ExecutionRole, AgentTuning>>;
}
export declare function applyModelOverrides(agent: AgentConfig, config: Config, role: ExecutionRole, overrides?: ModelOverrides): AgentConfig;
export declare function modelPlan(config: Config, overrides?: ModelOverrides): {
    provider: "command" | "codex" | "claude";
    model: string | null;
    effort: "default" | "high" | "low" | "medium";
    usageMode: "legacy" | "subscription" | "metered";
    maxBudgetUsd: number | null;
    preflight: "off" | "probe";
    decision: {
        policyVersion: string;
        kind: string;
        inputs: {
            role: ExecutionRole;
            lane: Lane;
            provider: AgentConfig["type"];
            qaDeep: boolean;
            base: ModelTarget;
            route: ModelTarget | null;
            profile: ModelTarget | null;
            override: Partial<ModelTarget>;
        };
        inputHash: string;
        result: {
            effectiveLane: "fast" | "standard" | "high";
            provider: "command" | "codex" | "claude";
            source: string;
            model: string;
            effort: "default" | "high" | "low" | "medium";
        };
        reasons: string[];
        decisionHash: string;
    };
    availability: string;
    source: string;
    reason: string;
    role: ExecutionRole;
    lane: "fast" | "standard" | "high";
    effectiveLane: "fast" | "standard" | "high";
}[];
export {};
