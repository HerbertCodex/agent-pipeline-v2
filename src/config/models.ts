import { s, type Schema } from '../domain/schema.js';

/**
 * Model of each role (`models` of .apv/config.json, docs/CONFIGURATION.md). The tool only reads and shows it
 * (`apv status`): the project lead passes it as `model` to the Agent tool when it launches a role.
 * Keys: the roles of the plugin (`agents/`), plus the groups the defaults speak in (`conception` covers product,
 * architecte, architecte-donnees, designer and critique-design; `relecture` covers qa-fidelite and auditeur-web;
 * `relecture-securite-regles` covers qa-securite and dpo). A key of a role wins over the key of its group.
 */
export const MODEL_NAMES = ['fable', 'opus', 'sonnet', 'haiku'] as const;
/** High at the least (rule of the operator): neither low nor medium is accepted. */
export const EFFORT_LEVELS = ['high', 'xhigh'] as const;
export type ModelName = typeof MODEL_NAMES[number];
export type EffortLevel = typeof EFFORT_LEVELS[number];

/** Defaults, in the order `apv status` shows them. */
export const DEFAULT_MODELS: { roles: Record<string, ModelName>; effort: EffortLevel } = {
  roles: {
    chef: 'fable', conception: 'opus', implementer: 'sonnet', fondations: 'opus', integrateur: 'opus',
    relecture: 'sonnet', 'relecture-securite-regles': 'opus', recherche: 'haiku',
  },
  effort: 'high',
};

/** Closed list of the keys: the groups of the defaults and every role of the plugin. */
export const MODEL_KEYS: readonly string[] = [...new Set([
  ...Object.keys(DEFAULT_MODELS.roles),
  'product', 'architecte', 'architecte-donnees', 'designer', 'critique-design', 'dpo', 'qa-securite', 'qa-fidelite', 'auditeur-web',
])];

const modelName = s.enum(MODEL_NAMES);
/** Parsed `models`: a model name per key of MODEL_KEYS (each optional) and the effort, all validated by the schema. */
export type ModelsConfig = Record<string, string>;
export const modelsSchema: Schema<ModelsConfig> = s.object({
  ...Object.fromEntries(MODEL_KEYS.map(key => [key, s.optional(modelName)])),
  effort: s.optional(s.enum(EFFORT_LEVELS)),
}) as Schema<ModelsConfig>;

/** What `apv status` reports: the model of each role, the effort, and whether the project set any (`custom`). */
export interface ModelSettings { custom: boolean; roles: Record<string, ModelName>; effort: EffortLevel }

/** The models of a configuration: the defaults completed by what the project sets; the defaults alone when `models` is absent. */
export function modelSettings(models: ModelsConfig | undefined): ModelSettings {
  if (!models) return { custom: false, roles: { ...DEFAULT_MODELS.roles }, effort: DEFAULT_MODELS.effort };
  const { effort, ...roles } = models;
  return { custom: true, roles: { ...DEFAULT_MODELS.roles, ...roles as Record<string, ModelName> }, effort: (effort as EffortLevel | undefined) ?? DEFAULT_MODELS.effort };
}

/** « chef fable ; conception opus ; … (effort high) », followed by « (défauts) » when the project sets nothing. */
export function modelsLine(settings: ModelSettings): string {
  return `Modèles par rôle : ${Object.entries(settings.roles).map(([role, model]) => `${role} ${model}`).join(' ; ')} (effort ${settings.effort})${settings.custom ? '' : ' (défauts)'}`;
}
