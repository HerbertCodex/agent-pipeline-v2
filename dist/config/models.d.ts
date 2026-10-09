import { type Schema } from '../domain/schema.js';
/**
 * Model of each role (`models` of .apv/config.json, docs/CONFIGURATION.md). The tool only reads and shows it
 * (`apv status`): the project lead passes it as `model` to the Agent tool when it launches a role.
 * Keys: the roles of the plugin (`agents/`), plus the groups the defaults speak in (`conception` covers product,
 * architecte, architecte-donnees, designer and critique-design; `relecture` covers qa-fidelite and auditeur-web;
 * `relecture-securite-regles` covers qa-securite and dpo). A key of a role wins over the key of its group.
 */
export declare const MODEL_NAMES: readonly ["fable", "opus", "sonnet", "haiku"];
export declare const EFFORT_LEVELS: readonly ["low", "medium", "high", "xhigh"];
export type ModelName = typeof MODEL_NAMES[number];
export type EffortLevel = typeof EFFORT_LEVELS[number];
/** Defaults, in the order `apv status` shows them. */
export declare const DEFAULT_MODELS: {
    roles: Record<string, ModelName>;
    effort: EffortLevel;
};
/** Closed list of the keys: the groups of the defaults and every role of the plugin. */
export declare const MODEL_KEYS: readonly string[];
/** Parsed `models`: a model name per key of MODEL_KEYS (each optional) and the effort, all validated by the schema. */
export type ModelsConfig = Record<string, string>;
export declare const modelsSchema: Schema<ModelsConfig>;
/** What `apv status` reports: the model of each role, the effort, and whether the project set any (`custom`). */
export interface ModelSettings {
    custom: boolean;
    roles: Record<string, ModelName>;
    effort: EffortLevel;
}
/** The models of a configuration: the defaults completed by what the project sets; the defaults alone when `models` is absent. */
export declare function modelSettings(models: ModelsConfig | undefined): ModelSettings;
/** « chef fable ; conception opus ; … (effort high) », followed by « (défauts) » when the project sets nothing. */
export declare function modelsLine(settings: ModelSettings): string;
