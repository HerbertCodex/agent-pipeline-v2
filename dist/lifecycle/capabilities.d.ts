import { type Config } from '../domain/contracts.js';
import type { Spec } from './contracts.js';
/**
 * What the configured roles can actually do, derived from the reviewed configuration and the native
 * adapter contracts. Product plans against this instead of assuming a shell, a package manager or
 * network access that the Implementer does not have.
 */
export declare function executionCapabilities(config: Config): {
    implementer: {
        fileEdits: boolean;
        shell: boolean;
        network: boolean;
        subagents: boolean;
        note: string;
        provider: "command" | "codex" | "claude";
    } | {
        fileEdits: boolean;
        shell: string;
        network: boolean;
        subagents: boolean;
        note: string;
        provider: "command" | "codex" | "claude";
    } | {
        fileEdits: string;
        shell: string;
        network: string;
        subagents: string;
        note: string;
        provider: "command" | "codex" | "claude";
    };
    attempt: {
        providerTurns: number;
        providerBudgetUsd: number | null;
        usageMode: "legacy" | "subscription" | "metered";
        agentTimeoutMs: number;
        runBudgetMs: number;
        repairAttempts: number;
    };
    feedback: {
        readonly gateIds: string[];
        readonly maxCalls: number;
        readonly maxTotalMs: number;
    };
    runnerSetup: string[];
    gates: {
        id: string;
        covers: ("security" | "unit" | "integration" | "browser" | "build" | "lint" | "typecheck" | "architecture")[];
        testPaths: string[];
        paths: string[];
        command: string;
        lanes: ("fast" | "standard" | "high")[];
        mandatory: boolean;
    }[];
    validationRules: {
        readonly id: string;
        readonly paths: string[];
        readonly requires: ("security" | "unit" | "integration" | "browser" | "build" | "lint" | "typecheck" | "architecture")[];
    }[];
    qualityReview: "legacy" | "evidence";
    generatedPaths: string[];
    rules: string[];
};
/**
 * Deterministic guard: a task may not name a tool-generated file (lock files by default, configurable
 * through workflow.generatedPaths) when the configured Implementer cannot run the tool that regenerates
 * it. Wildcard allowedPaths are not interpreted here; scope policy governs them.
 */
export declare function validateTaskCapabilities(spec: Spec, config: Config): Spec;
/** Advice about conflicting limits; short budgets are valid for compact work. */
export declare function configAdvice(config: Config): {
    setting: string;
    value: string;
    why: string;
}[];
