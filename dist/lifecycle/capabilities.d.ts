import type { Config } from '../domain/contracts.js';
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
    runnerSetup: string[];
    gates: {
        id: string;
        command: string;
        lanes: ("fast" | "standard" | "high")[];
        mandatory: boolean;
    }[];
    rules: string[];
};
