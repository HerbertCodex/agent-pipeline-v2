import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { s, type Infer } from '../domain/schema.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { IssueList, schemaIssues, type Issue } from '../domain/issues.js';
import { DEFAULT_PASS_ENV, envNamesSchema, gateSchema, gateStage, riskSchema, validationRulesSchema } from '../domain/contracts.js';
import { skillsSchema } from '../domain/knowledge.js';
import { previewSchema } from '../preview/config.js';
import { designDir, designSchema } from '../design/config.js';
import { structureSchema, structureSettings } from '../structure/config.js';
import type { PolicyConfig } from '../policy/policy.js';
import { matches, validateDag } from '../policy/policy.js';
import { DEFAULT_RECEIPT_RETENTION } from '../gates/store.js';
import { gitRead } from '../run/git-probe.js';
import { reviewAlwaysSchema, reviewPathsSchema, reviewTermsSchema } from '../review/config.js';

/** V3 project configuration, versioned with the project. */
export const CONFIG_FILE = '.apv/config.json';
/** V2 configuration, read as is for projects not yet migrated. */
export const LEGACY_CONFIG_FILE = 'pipeline.v2.json';
/**
 * The only configuration sections the V3 tool reads. Agent, budget, timing, model and tuning fields of a
 * V2 file belong to the removed controller: they are ignored, never interpreted (spec, section 14).
 */
export const READ_SECTIONS = ['name', 'gates', 'risk', 'validationRules', 'environment', 'skills', 'preview', 'design', 'structure', 'run', 'spec', 'review', 'receipts'] as const;
/** Sections read and validated by their own command (`db`: `apv db check`, docs/DB-CHECK.md): never reported as ignored. */
export const OWN_SECTIONS = ['db'] as const;

/**
 * When `/apv:run` passes the full suite (the checks of stage `full` included):
 * - `final` (default): at the last integration of a spec (every task integrated, before the reviews) and at the
 *   delivery on the final head; the intermediate integrations and the fix passes advance on the task checks and
 *   the targeted tests, verified at the exact commit (`apv gates verify --stage task --base <ref>`);
 * - `each-integration`: at every integration, fix passes included, and at the delivery (the rhythm of 3.0.0-alpha.3 and before).
 */
export const FULL_SUITE_MODES = ['final', 'each-integration'] as const;
export type FullSuiteMode = typeof FULL_SUITE_MODES[number];
export const DEFAULT_FULL_SUITE: FullSuiteMode = 'final';
/** Settings of `/apv:run` read by the tool (`apv run next`); absent: defaults. */
export const runSettingsSchema = s.object({
  fullSuite: s.default(s.enum(FULL_SUITE_MODES), DEFAULT_FULL_SUITE),
});

/**
 * Size thresholds of a spec (`apv spec validate` warns above them, never refuses): a spec with more tasks or
 * criteria is better split into independent specs delivered in parallel, and a longer chain of dependency layers
 * makes every layer wait for the integration of the previous one.
 */
export const DEFAULT_SPEC_LIMITS = { maxTasks: 6, maxAcceptance: 30, maxDepth: 3 } as const;
export const specSettingsSchema = s.object({
  maxTasks: s.default(s.number(1, 100), DEFAULT_SPEC_LIMITS.maxTasks),
  maxAcceptance: s.default(s.number(1, 1000), DEFAULT_SPEC_LIMITS.maxAcceptance),
  maxDepth: s.default(s.number(1, 100), DEFAULT_SPEC_LIMITS.maxDepth),
});
export type SpecLimits = { maxTasks: number; maxAcceptance: number; maxDepth: number };

/** Placeholders of the dynamic scan command (`review.dast.command`), replaced as whole arguments. */
export const DAST_PLACEHOLDERS = ['reportDir', 'commit', 'repo'] as const;
export const DEFAULT_DAST_RESOURCE = 'dast';
export const DEFAULT_DAST_TIMEOUT_MS = 3_600_000;
/**
 * The dynamic security scan of the project (ZAP or another), run by the project lead before the reviews with
 * `apv dast run`, under the lease `resource`, in a detached copy of the reviewed commit. The command prepares what
 * it needs (dependencies, build, server), writes its reports into `{{reportDir}}` and stops what it started.
 */
export const dastSchema = s.object({
  command: s.array(s.string(1, 16000), 1, 200),
  timeoutMs: s.default(s.number(1000, 14_400_000), DEFAULT_DAST_TIMEOUT_MS),
  passEnv: s.default(envNamesSchema, []),
  resource: s.default(s.string(1, 80, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/), DEFAULT_DAST_RESOURCE),
  description: s.optional(s.string(1, 500)),
});
export type DastSettings = Infer<typeof dastSchema>;
/**
 * Settings of the reviews (`/apv:review`): the dynamic scan (absent: none declared), and what `apv review plan`
 * reads to propose the domains from the diff (`paths`, `terms`, `always`; absent: generic defaults, src/review/config.ts).
 */
/**
 * Retention of the shared receipt store (`<git common dir>/apv/receipts/`, src/gates/store.ts): `apv gates run`
 * keeps the `keepRuns` most recent runs younger than `keepDays` days. Local receipts (`.apv/receipts/`) are not concerned.
 */
export const receiptsSettingsSchema = s.object({
  keepDays: s.default(s.number(1, 3650), DEFAULT_RECEIPT_RETENTION.keepDays),
  keepRuns: s.default(s.number(1, 100000), DEFAULT_RECEIPT_RETENTION.keepRuns),
});
export const reviewSettingsSchema = s.object({
  dast: s.optional(dastSchema),
  paths: s.optional(reviewPathsSchema),
  terms: s.optional(reviewTermsSchema),
  always: s.optional(reviewAlwaysSchema),
});

export const apvConfigSchema = s.object({
  /** Project name, written by `apv init` (display only). */
  name: s.optional(s.string(1, 100)),
  environment: s.default(s.object({ passEnv: s.default(envNamesSchema, [...DEFAULT_PASS_ENV]) }), { passEnv: [...DEFAULT_PASS_ENV] }),
  skills: s.default(skillsSchema, { enabled: [], projectType: 'unknown', maxContextBytes: 16000 }),
  gates: s.default(s.array(gateSchema, 0, 100), []),
  validationRules: validationRulesSchema,
  risk: riskSchema,
  /** Live preview environment (`apv preview`, spec section 12); absent when the project has none. */
  preview: s.optional(previewSchema),
  /** Folder of validated mockups (`apv design`, docs/DESIGN.md); absent means `docs/design`. */
  design: s.optional(designSchema),
  /** Tree analysis of `apv structure check` (docs/CONFIGURATION.md, « Arborescence »); absent: defaults. */
  structure: s.optional(structureSchema),
  /** Rhythm of `/apv:run` (docs/CONFIGURATION.md, « Exécution »); absent: `fullSuite` is `final`. */
  run: s.optional(runSettingsSchema),
  /** Size thresholds of `apv spec validate` (docs/CONFIGURATION.md, « Taille des specs »); absent: defaults. */
  spec: s.optional(specSettingsSchema),
  /** Reviews: the dynamic scan run before them (docs/CONFIGURATION.md, « Revues »); absent: none declared. */
  review: s.optional(reviewSettingsSchema),
  /** Retention of the shared receipt store (docs/CONFIGURATION.md, « Reçus »); absent: 30 days, 1000 runs. */
  receipts: s.optional(receiptsSettingsSchema),
});
/** The spec size thresholds of a configuration: `spec`, defaults for what is absent. */
export const specLimits = (config: { spec?: Partial<SpecLimits> | undefined }): SpecLimits => ({ ...DEFAULT_SPEC_LIMITS, ...config.spec });
/** The full suite rhythm of a configuration: `run.fullSuite`, `final` when absent. */
export const fullSuiteMode = (config: { run?: { fullSuite: FullSuiteMode } | undefined }): FullSuiteMode => config.run?.fullSuite ?? DEFAULT_FULL_SUITE;
export type ApvConfig = Infer<typeof apvConfigSchema>;

export interface LoadedConfig {
  /** Absolute path of the file read, or null when the project has none (defaults apply). */
  file: string | null;
  legacy: boolean;
  config: ApvConfig;
  /** Top-level sections present in the file and deliberately ignored. */
  ignored: string[];
}

/** Picks the read sections: `environment.passEnv` only, whatever else a V2 environment declared. */
export function readSections(raw: unknown): { picked: Record<string, unknown>; ignored: string[] } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new PipelineError('CONFIG', 'Configuration must be a JSON object');
  const input = raw as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of READ_SECTIONS) if (input[key] !== undefined) picked[key] = input[key];
  const env = input['environment'];
  if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
    const passEnv = (env as Record<string, unknown>)['passEnv'];
    picked['environment'] = passEnv === undefined ? {} : { passEnv };
  }
  const known: readonly string[] = [...READ_SECTIONS, ...OWN_SECTIONS];
  return { picked, ignored: Object.keys(input).filter(k => !known.includes(k)).sort() };
}

/** Every problem of a configuration document: schema, duplicate ids, unknown dependencies, cycles. */
export function configIssues(raw: unknown): { config: ApvConfig | undefined; ignored: string[]; issues: Issue[] } {
  let sections: ReturnType<typeof readSections>;
  try { sections = readSections(raw); }
  catch (error) { return { config: undefined, ignored: [], issues: [{ code: 'CONFIG', message: errorMessage(error) }] }; }
  const { value, issues } = schemaIssues(apvConfigSchema, sections.picked);
  if (!value) return { config: undefined, ignored: sections.ignored, issues };
  const list = new IssueList();
  const ids = value.gates.map(g => g.id);
  const duplicates = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
  list.check(!duplicates.length, 'CONFIG', `Duplicate gate id: ${duplicates.join(', ')}`);
  for (const gate of value.gates) {
    list.check(new Set(gate.dependsOn).size === gate.dependsOn.length, 'CONFIG', `Duplicate dependency: ${gate.id}`);
    for (const dep of gate.dependsOn) list.check(ids.includes(dep), 'CONFIG', `Unknown dependency ${dep} of gate ${gate.id}`);
    // A task check never waits for the full suite: `apv gates run --stage task` could neither run nor skip it.
    if (gateStage(gate) === 'task') for (const dep of gate.dependsOn) {
      const target = value.gates.find(g => g.id === dep);
      list.check(!target || gateStage(target) === 'task', 'CONFIG', `Gate ${gate.id} (stage task) depends on ${dep}, reserved for the full suite (stage full)`);
    }
    // A targeted variant replaces a full check at the task stage only, where every dependency must run too.
    if (gate.affected) {
      list.check(gateStage(gate) === 'full', 'CONFIG', `Gate ${gate.id}: affected is the targeted variant of a full check; declare "stage": "full"`);
      for (const dep of gate.dependsOn) {
        const target = value.gates.find(g => g.id === dep);
        list.check(!target || gateStage(target) === 'task' || !!target.affected, 'CONFIG',
          `Gate ${gate.id} (targeted at stage task) depends on ${dep}, reserved for the full suite without a targeted variant`);
      }
    }
  }
  const ruleIds = value.validationRules.map(r => r.id);
  list.check(new Set(ruleIds).size === ruleIds.length, 'CONFIG', 'Duplicate validation rule id');
  if (value.design) list.attempt('CONFIG', () => designDir(value.design));
  if (value.structure) list.attempt('CONFIG', () => structureSettings(value.structure));
  for (const arg of value.review?.dast?.command ?? []) {
    if (!arg.includes('{{')) continue;
    const key = /^\{\{([A-Za-z]+)\}\}$/.exec(arg)?.[1];
    list.check(!!key && (DAST_PLACEHOLDERS as readonly string[]).includes(key), 'CONFIG',
      `review.dast.command: unknown or partial placeholder ${arg} (whole arguments only: ${DAST_PLACEHOLDERS.map(k => `{{${k}}}`).join(', ')})`);
  }
  // Portable globs only (the syntax of allowedPaths): a brace or a negation would silently match nothing.
  for (const [key, globs] of Object.entries(value.review?.paths ?? {})) {
    for (const glob of globs ?? []) list.attempt('CONFIG', () => { try { matches('probe', glob); } catch (error) { throw new PipelineError('CONFIG', `review.paths.${key}: ${errorMessage(error)}`); } });
  }
  if (list.empty) list.attempt('DAG', () => validateDag(value.gates));
  return { config: list.empty ? value : undefined, ignored: sections.ignored, issues: list.items };
}

/** Configuration file of a project: `--config` when given, then `.apv/config.json`, then `pipeline.v2.json`. */
export function configFile(repo: string, explicit?: string): { file: string | null; legacy: boolean } {
  if (explicit) return { file: resolve(repo, explicit), legacy: false };
  const current = join(repo, CONFIG_FILE);
  if (existsSync(current)) return { file: current, legacy: false };
  const legacy = join(repo, LEGACY_CONFIG_FILE);
  if (existsSync(legacy)) return { file: legacy, legacy: true };
  return { file: null, legacy: false };
}

/**
 * Configuration of a project as committed at `commit` (a full SHA): `.apv/config.json`, then `pipeline.v2.json`,
 * read from the commit rather than the working tree, so that the proof of a commit is checked against the checks
 * that commit declared from any checkout of the repository. Neither file at the commit: defaults (no checks).
 * `file` is then `<sha>:<path>`.
 */
export function loadConfigAtCommit(repo: string, commit: string): LoadedConfig {
  for (const [path, legacy] of [[CONFIG_FILE, false], [LEGACY_CONFIG_FILE, true]] as const) {
    if (gitRead(repo, ['cat-file', '-e', `${commit}:${path}`]) === null) continue;
    const text = gitRead(repo, ['show', `${commit}:${path}`]);
    const file = `${commit}:${path}`;
    if (text === null) throw new PipelineError('CONFIG', `Configuration unreadable at ${file}`);
    let raw: unknown;
    try { raw = JSON.parse(text) as unknown; }
    catch (error) { throw new PipelineError('CONFIG', `Invalid JSON in ${file}: ${errorMessage(error)}`); }
    const { config, ignored, issues } = configIssues(raw);
    if (!config) throw new PipelineError(issues[0]?.code ?? 'CONFIG', `Invalid configuration ${file}:\n${issues.map(i => `- ${i.message}`).join('\n')}`);
    return { file, legacy, config, ignored };
  }
  return { file: null, legacy: false, config: apvConfigSchema.parse({}), ignored: [] };
}

export function loadConfig(repo: string, explicit?: string): LoadedConfig {
  const { file, legacy } = configFile(repo, explicit);
  if (!file) return { file: null, legacy: false, config: apvConfigSchema.parse({}), ignored: [] };
  if (!existsSync(file)) throw new PipelineError('CONFIG', `Configuration file not found: ${file}`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')) as unknown; }
  catch (error) { throw new PipelineError('CONFIG', `Invalid JSON in ${file}: ${errorMessage(error)}`); }
  const { config, ignored, issues } = configIssues(raw);
  if (!config) throw new PipelineError(issues[0]?.code ?? 'CONFIG', `Invalid configuration ${file}:\n${issues.map(i => `- ${i.message}`).join('\n')}`);
  return { file, legacy, config, ignored };
}

/** The policy view of a V3 configuration: evidence-mode review is the only mode V3 knows. */
export function policyConfig(config: ApvConfig): PolicyConfig {
  return { gates: config.gates, risk: config.risk, validationRules: config.validationRules, workflow: { qualityReview: 'evidence' } };
}
