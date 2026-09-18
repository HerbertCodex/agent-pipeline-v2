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
        agentTimeoutMs: number;
        runBudgetMs: number;
        repairAttempts: number;
    };
    runnerSetup: string[];
    gates: {
        id: string;
        command: string;
        lanes: ("fast" | "standard" | "high")[];
        mandatory: boolean;
    }[];
    generatedPaths: string[];
    rules: string[];
};
/**
 * Deterministic guard: a task may not name a tool-generated file (lock files by default, configurable
 * through workflow.generatedPaths) when the configured Implementer cannot run the tool that regenerates
 * it. Wildcard allowedPaths are not interpreted here; scope policy governs them.
 */
export declare function validateTaskCapabilities(spec: Spec, config: Config): Spec;
/**
 * Bounds that cut work in progress instead of warning before it starts. Measured on a real project: a Product
 * round for a medium increment runs about 20 minutes, and an implementation attempt reads and writes several
 * files. A provider that stops at its turn, cost or time limit produces nothing usable, and a role leaves
 * nothing to salvage. This is advice on a reviewed configuration, never a refusal.
 */
export declare function configAdvice(config: Config): {
    setting: string;
    value: string;
    why: string;
}[];
