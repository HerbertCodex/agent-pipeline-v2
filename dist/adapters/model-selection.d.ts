import { type AgentConfig, type Config } from '../domain/contracts.js';
import { type Infer } from '../domain/schema.js';
export declare const modelSelectionSchema: import("../domain/schema.js").Schema<{
    readonly quick: {
        readonly provider: "codex" | "claude";
        readonly model: string;
        readonly usageMode: "legacy" | "subscription" | "metered";
        readonly effort: "high" | "low" | "medium";
    };
    readonly deep: {
        readonly provider: "codex" | "claude";
        readonly model: string;
        readonly usageMode: "legacy" | "subscription" | "metered";
        readonly effort: "high" | "low" | "medium";
    };
    readonly qa: {
        readonly provider: "codex" | "claude";
        readonly model: string;
        readonly usageMode: "legacy" | "subscription" | "metered";
        readonly effort: "high" | "low" | "medium";
    };
}>;
export type ModelSelection = Infer<typeof modelSelectionSchema>;
export declare function validateModelSelection(input: unknown): ModelSelection;
export declare function selectedAgent(choice: ModelSelection['qa']): AgentConfig;
/** Only an operator selection can set model policy; Setup cannot replace it. */
export declare function applyModelSelection(config: Config, selection: ModelSelection): Config;
