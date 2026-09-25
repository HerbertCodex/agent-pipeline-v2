import { type Infer } from '../domain/schema.js';
import { type Issue } from '../domain/issues.js';
import type { PolicyConfig } from '../policy/policy.js';
/** V3 project configuration, versioned with the project. */
export declare const CONFIG_FILE = ".apv/config.json";
/** V2 configuration, read as is for projects not yet migrated. */
export declare const LEGACY_CONFIG_FILE = "pipeline.v2.json";
/**
 * The only configuration sections the V3 tool reads. Agent, budget, timing, model and tuning fields of a
 * V2 file belong to the removed controller: they are ignored, never interpreted (spec, section 14).
 */
export declare const READ_SECTIONS: readonly ["name", "gates", "risk", "validationRules", "environment", "skills", "preview", "design", "structure", "run", "spec", "review"];
/** Sections read and validated by their own command (`db`: `apv db check`, docs/DB-CHECK.md): never reported as ignored. */
export declare const OWN_SECTIONS: readonly ["db"];
/**
 * When `/apv:run` passes the full suite (the checks of stage `full` included):
 * - `final` (default): at the last integration of a spec (every task integrated, before the reviews) and at the
 *   delivery on the final head; the intermediate integrations and the fix passes advance on the task checks and
 *   the targeted tests, verified at the exact commit (`apv gates verify --stage task --base <ref>`);
 * - `each-integration`: at every integration, fix passes included, and at the delivery (the rhythm of 3.0.0-alpha.3 and before).
 */
export declare const FULL_SUITE_MODES: readonly ["final", "each-integration"];
export type FullSuiteMode = typeof FULL_SUITE_MODES[number];
export declare const DEFAULT_FULL_SUITE: FullSuiteMode;
/** Settings of `/apv:run` read by the tool (`apv run next`); absent: defaults. */
export declare const runSettingsSchema: import("../domain/schema.js").Schema<{
    readonly fullSuite: "final" | "each-integration";
}>;
/**
 * Size thresholds of a spec (`apv spec validate` warns above them, never refuses): a spec with more tasks or
 * criteria is better split into independent specs delivered in parallel, and a longer chain of dependency layers
 * makes every layer wait for the integration of the previous one.
 */
export declare const DEFAULT_SPEC_LIMITS: {
    readonly maxTasks: 6;
    readonly maxAcceptance: 30;
    readonly maxDepth: 3;
};
export declare const specSettingsSchema: import("../domain/schema.js").Schema<{
    readonly maxTasks: number;
    readonly maxAcceptance: number;
    readonly maxDepth: number;
}>;
export type SpecLimits = {
    maxTasks: number;
    maxAcceptance: number;
    maxDepth: number;
};
/** Placeholders of the dynamic scan command (`review.dast.command`), replaced as whole arguments. */
export declare const DAST_PLACEHOLDERS: readonly ["reportDir", "commit", "repo"];
export declare const DEFAULT_DAST_RESOURCE = "dast";
export declare const DEFAULT_DAST_TIMEOUT_MS = 3600000;
/**
 * The dynamic security scan of the project (ZAP or another), run by the project lead before the reviews with
 * `apv dast run`, under the lease `resource`, in a detached copy of the reviewed commit. The command prepares what
 * it needs (dependencies, build, server), writes its reports into `{{reportDir}}` and stops what it started.
 */
export declare const dastSchema: import("../domain/schema.js").Schema<{
    readonly command: string[];
    readonly timeoutMs: number;
    readonly passEnv: string[];
    readonly resource: string;
    readonly description: string | undefined;
}>;
export type DastSettings = Infer<typeof dastSchema>;
/** Settings of the reviews (`/apv:review`); absent: no dynamic scan declared. */
export declare const reviewSettingsSchema: import("../domain/schema.js").Schema<{
    readonly dast: {
        readonly command: string[];
        readonly timeoutMs: number;
        readonly passEnv: string[];
        readonly resource: string;
        readonly description: string | undefined;
    } | undefined;
}>;
export declare const apvConfigSchema: import("../domain/schema.js").Schema<{
    readonly name: string | undefined;
    readonly environment: {
        readonly passEnv: string[];
    };
    readonly skills: {
        readonly enabled: ("clean-code" | "design-patterns" | "refactoring" | "security" | "tdd" | "ui-design")[];
        readonly projectType: "unknown" | "backend" | "frontend" | "mobile" | "fullstack" | "library";
        readonly maxContextBytes: number;
    };
    readonly gates: {
        readonly id: string;
        readonly command: string[];
        readonly covers: ("security" | "unit" | "integration" | "browser" | "build" | "lint" | "typecheck" | "architecture")[];
        readonly testPaths: string[];
        readonly timeoutMs: number;
        readonly passEnv: string[];
        readonly dependsOn: string[];
        readonly resources: string[];
        readonly readOnly: boolean;
        readonly outputs: string[];
        readonly paths: string[];
        readonly lanes: ("fast" | "standard" | "high")[];
        readonly mandatory: boolean;
        readonly cacheTtlMs: number;
        readonly stage: "task" | "full" | undefined;
        readonly affected: string[] | undefined;
    }[];
    readonly validationRules: {
        readonly id: string;
        readonly paths: string[];
        readonly requires: ("security" | "unit" | "integration" | "browser" | "build" | "lint" | "typecheck" | "architecture")[];
    }[];
    readonly risk: {
        readonly fastPaths: string[];
        readonly highPaths: string[];
        readonly maxFastFiles: number;
        readonly maxFastLines: number;
    };
    readonly preview: {
        readonly branch: string | undefined;
        readonly dir: string | undefined;
        readonly envFile: string | undefined;
        readonly steps: {
            install: import("../preview/config.js").PreviewStep | undefined;
            migrate: import("../preview/config.js").PreviewStep | undefined;
            build: import("../preview/config.js").PreviewStep | undefined;
            seed: import("../preview/config.js").PreviewStep | undefined;
        };
        readonly serve: {
            readonly command: string | string[];
            readonly port: number;
            readonly host: string | undefined;
            readonly env: Record<string, string>;
        };
        readonly health: {
            path: string;
            timeoutSec: number;
        };
        readonly announce: {
            readonly url: string | undefined;
        } | undefined;
    } | undefined;
    readonly design: {
        readonly dir: string | undefined;
    } | undefined;
    readonly structure: {
        readonly roots: string[] | undefined;
        readonly maxFlatFiles: number | undefined;
        readonly roles: Record<string, string | null> | undefined;
        readonly domains: string[] | undefined;
        readonly ignore: string[] | undefined;
        readonly severity: "warning" | "error" | Record<string, "warning" | "error"> | undefined;
    } | undefined;
    readonly run: {
        readonly fullSuite: "final" | "each-integration";
    } | undefined;
    readonly spec: {
        readonly maxTasks: number;
        readonly maxAcceptance: number;
        readonly maxDepth: number;
    } | undefined;
    readonly review: {
        readonly dast: {
            readonly command: string[];
            readonly timeoutMs: number;
            readonly passEnv: string[];
            readonly resource: string;
            readonly description: string | undefined;
        } | undefined;
    } | undefined;
}>;
/** The spec size thresholds of a configuration: `spec`, defaults for what is absent. */
export declare const specLimits: (config: {
    spec?: Partial<SpecLimits> | undefined;
}) => SpecLimits;
/** The full suite rhythm of a configuration: `run.fullSuite`, `final` when absent. */
export declare const fullSuiteMode: (config: {
    run?: {
        fullSuite: FullSuiteMode;
    } | undefined;
}) => FullSuiteMode;
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
export declare function readSections(raw: unknown): {
    picked: Record<string, unknown>;
    ignored: string[];
};
/** Every problem of a configuration document: schema, duplicate ids, unknown dependencies, cycles. */
export declare function configIssues(raw: unknown): {
    config: ApvConfig | undefined;
    ignored: string[];
    issues: Issue[];
};
/** Configuration file of a project: `--config` when given, then `.apv/config.json`, then `pipeline.v2.json`. */
export declare function configFile(repo: string, explicit?: string): {
    file: string | null;
    legacy: boolean;
};
export declare function loadConfig(repo: string, explicit?: string): LoadedConfig;
/** The policy view of a V3 configuration: evidence-mode review is the only mode V3 knows. */
export declare function policyConfig(config: ApvConfig): PolicyConfig;
