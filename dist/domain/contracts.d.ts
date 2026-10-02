import { type Infer } from './schema.js';
export declare const VERSION = "3.0.0-alpha.12";
export declare const lanes: readonly ["fast", "standard", "high"];
export declare const validationKinds: readonly ["unit", "integration", "browser", "build", "lint", "typecheck", "security", "architecture"];
export type Lane = typeof lanes[number];
/**
 * When a check runs: `task` after every task (fast feedback), `full` only in the complete suite that accepts a
 * wave or a delivery. Absent means `task`: a configuration without stages keeps running every check everywhere.
 */
export declare const gateStages: readonly ["task", "full"];
export type GateStage = typeof gateStages[number];
export declare const envNamesSchema: import("./schema.js").Schema<string[]>;
export declare const commandSchema: import("./schema.js").Schema<{
    readonly command: string[];
    readonly timeoutMs: number;
    readonly passEnv: string[];
}>;
/** Longest wait for the lock of a check (`lock.waitMs`) when absent: 30 minutes. */
export declare const DEFAULT_LOCK_WAIT_MS = 1800000;
/** Fixed waits found in the lines a change adds to a repeated test file: off, a warning, or a refusal of the run. */
export declare const fixedWaitModes: readonly ["off", "warn", "refuse"];
/** Default ceilings of `repeatChanged`: repetitions of each test, files repeated in one run. */
export declare const DEFAULT_REPEAT: {
    readonly times: 5;
    readonly maxFiles: 10;
};
/**
 * `repeatChanged` of a check: `paths` (globs of the test files concerned), `command` (the repetition, the files
 * appended), `times` (repetitions of each test, `{{repeat}}`), `maxFiles` (above: the run is refused), `timeoutMs`
 * (duration ceiling of the repetition), `testPattern` (lines naming a failed test), `stressArgs`, `fixedWaits`, `reference`.
 */
export declare const repeatChangedSchema: import("./schema.js").Schema<{
    readonly paths: string[];
    readonly command: string[];
    readonly times: number;
    readonly maxFiles: number;
    readonly timeoutMs: number | undefined;
    readonly testPattern: string | undefined;
    readonly stressArgs: string[] | undefined;
    readonly fixedWaits: "off" | "warn" | "refuse";
    readonly reference: string;
}>;
/**
 * `skipWhenOnly` of a check: the scope of its proof (docs/APV3-SPEC.md, section 21). `paths` (globs of the files that
 * have no effect on what the check proves: documentation, decisions, specs), `except` (globs taken out of `paths`, for
 * example the sources out of the Markdown files), `reference` (the branch the change goes to, `origin/main` for example, required: the
 * files are also counted from its merge base, and the lists are read there, never in the change). A full run where
 * every file changed since the merge bases of `--base` and of the reference matches `paths` (and no `except`, no file
 * of `ALWAYS_REQUIRED`, no change of mode or type) records the check as not required instead of running it.
 */
export declare const skipWhenOnlySchema: import("./schema.js").Schema<{
    readonly paths: string[];
    readonly except: string[] | undefined;
    readonly reference: string;
}>;
export declare const gateSchema: import("./schema.js").Schema<{
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
    readonly lock: {
        readonly resource: string;
        readonly waitMs: number;
    } | {
        readonly file: string;
        readonly fileEnv: string | undefined;
        readonly waitMs: number;
    } | undefined;
    readonly retryFailed: {
        readonly command: string[];
        readonly testPattern: string | undefined;
    } | undefined;
    readonly repeatChanged: {
        readonly paths: string[];
        readonly command: string[];
        readonly times: number;
        readonly maxFiles: number;
        readonly timeoutMs: number | undefined;
        readonly testPattern: string | undefined;
        readonly stressArgs: string[] | undefined;
        readonly fixedWaits: "off" | "warn" | "refuse";
        readonly reference: string;
    } | undefined;
    readonly skipWhenOnly: {
        readonly paths: string[];
        readonly except: string[] | undefined;
        readonly reference: string;
    } | undefined;
}>;
/** Stage of a check; absent means `task`. */
export declare const gateStage: (gate: {
    stage?: GateStage | undefined;
}) => GateStage;
/** Variables a command receives by default; every other variable must be named in `passEnv`. */
export declare const DEFAULT_PASS_ENV: readonly ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG"];
export declare const validationRulesSchema: import("./schema.js").Schema<{
    readonly id: string;
    readonly paths: string[];
    readonly requires: ("security" | "unit" | "integration" | "browser" | "build" | "lint" | "typecheck" | "architecture")[];
}[]>;
export declare const riskSchema: import("./schema.js").Schema<{
    readonly fastPaths: string[];
    readonly highPaths: string[];
    readonly maxFastFiles: number;
    readonly maxFastLines: number;
}>;
export declare const MAX_TASK_DESCRIPTION = 400000;
export declare const DEFAULT_LIMITS: {
    readonly maxTaskContextChars: 120000;
    readonly maxQaDiffBytes: 524288;
};
/** Paths regenerated by project tooling; an Implementer without a shell must not be asked to edit them. */
export declare const DEFAULT_GENERATED_PATHS: string[];
export declare const taskSchema: import("./schema.js").Schema<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly acceptance: string[];
    readonly allowedPaths: string[];
    readonly allowedNewPaths: string[];
    readonly maxNewFiles: number;
    readonly reviewRequired: boolean;
    readonly minimumLane: "fast" | "standard" | "high";
}>;
export declare const agentSchema: import("./schema.js").Schema<{
    readonly type: "command" | "codex" | "claude";
    readonly usageMode: "legacy" | "subscription" | "metered";
    readonly command: string[];
    readonly timeoutMs: number;
    readonly passEnv: string[];
    readonly model: string;
    readonly effort: "default" | "high" | "low" | "medium";
    readonly preflight: "off" | "probe";
    readonly maxTurns: number;
    readonly maxBudgetUsd: number | null;
}>;
export type AgentConfig = Infer<typeof agentSchema>;
export declare const configSchema: import("./schema.js").Schema<{
    readonly schemaVersion: 1;
    readonly executionMode: "local-trusted";
    readonly environment: {
        readonly id: string;
        readonly passEnv: string[];
    };
    readonly agent: {
        readonly type: "command" | "codex" | "claude";
        readonly usageMode: "legacy" | "subscription" | "metered";
        readonly command: string[];
        readonly timeoutMs: number;
        readonly passEnv: string[];
        readonly model: string;
        readonly effort: "default" | "high" | "low" | "medium";
        readonly preflight: "off" | "probe";
        readonly maxTurns: number;
        readonly maxBudgetUsd: number | null;
    };
    readonly skills: {
        readonly enabled: ("clean-code" | "design-patterns" | "refactoring" | "security" | "tdd" | "ui-design")[];
        readonly projectType: "unknown" | "backend" | "frontend" | "mobile" | "fullstack" | "library";
        readonly maxContextBytes: number;
    };
    readonly knowledge: {
        readonly languages: {
            readonly id: string;
            readonly extensions: string[];
            readonly prefilter: string;
            readonly declarations: {
                readonly kind: string;
                readonly pattern: string;
                readonly exported: "always" | "marker" | "capitalized" | "not-underscore" | "unless-hidden";
            }[];
        }[];
    };
    readonly roles: {
        readonly product: {
            readonly type: "command" | "codex" | "claude";
            readonly usageMode: "legacy" | "subscription" | "metered";
            readonly command: string[];
            readonly timeoutMs: number;
            readonly passEnv: string[];
            readonly model: string;
            readonly effort: "default" | "high" | "low" | "medium";
            readonly preflight: "off" | "probe";
            readonly maxTurns: number;
            readonly maxBudgetUsd: number | null;
        } | null;
        readonly qa: {
            readonly type: "command" | "codex" | "claude";
            readonly usageMode: "legacy" | "subscription" | "metered";
            readonly command: string[];
            readonly timeoutMs: number;
            readonly passEnv: string[];
            readonly model: string;
            readonly effort: "default" | "high" | "low" | "medium";
            readonly preflight: "off" | "probe";
            readonly maxTurns: number;
            readonly maxBudgetUsd: number | null;
        } | null;
        readonly design: {
            readonly type: "command" | "codex" | "claude";
            readonly usageMode: "legacy" | "subscription" | "metered";
            readonly command: string[];
            readonly timeoutMs: number;
            readonly passEnv: string[];
            readonly model: string;
            readonly effort: "default" | "high" | "low" | "medium";
            readonly preflight: "off" | "probe";
            readonly maxTurns: number;
            readonly maxBudgetUsd: number | null;
        } | null;
    };
    readonly modelRouting: {
        readonly provider: "codex" | "claude";
        readonly role: "product" | "implementer" | "qa" | "design";
        readonly lane: "fast" | "standard" | "high";
        readonly model: string;
        readonly effort: "default" | "high" | "low" | "medium";
    }[];
    readonly roleProfiles: {
        readonly provider: "codex" | "claude";
        readonly role: "product" | "implementer" | "qa" | "design";
        readonly quick: {
            readonly model: string;
            readonly effort: "high" | "low" | "medium";
        };
        readonly deep: {
            readonly model: string;
            readonly effort: "high" | "low" | "medium";
        };
    }[];
    readonly workflow: {
        readonly planningMode: "legacy" | "adaptive";
        readonly qualityReview: "legacy" | "evidence";
        readonly qaProfile: "lane" | "deep";
        readonly qaLanes: string[];
        readonly maxQaRepairs: number;
        readonly maxActiveMs: number;
        readonly reviewMode: "solo" | "team" | "regulated";
        readonly maxOutputRepairs: number;
        readonly generatedPaths: string[];
        readonly maxSpecCostUsd: number | null;
    };
    readonly feedback: {
        readonly gateIds: string[];
        readonly maxCalls: number;
        readonly maxTotalMs: number;
    };
    readonly validationReserveMs: number;
    readonly limits: {
        readonly maxTaskContextChars: number;
        readonly maxQaDiffBytes: number;
    };
    readonly setup: {
        readonly command: string[];
        readonly timeoutMs: number;
        readonly passEnv: string[];
    }[];
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
        readonly lock: {
            readonly resource: string;
            readonly waitMs: number;
        } | {
            readonly file: string;
            readonly fileEnv: string | undefined;
            readonly waitMs: number;
        } | undefined;
        readonly retryFailed: {
            readonly command: string[];
            readonly testPattern: string | undefined;
        } | undefined;
        readonly repeatChanged: {
            readonly paths: string[];
            readonly command: string[];
            readonly times: number;
            readonly maxFiles: number;
            readonly timeoutMs: number | undefined;
            readonly testPattern: string | undefined;
            readonly stressArgs: string[] | undefined;
            readonly fixedWaits: "off" | "warn" | "refuse";
            readonly reference: string;
        } | undefined;
        readonly skipWhenOnly: {
            readonly paths: string[];
            readonly except: string[] | undefined;
            readonly reference: string;
        } | undefined;
    }[];
    readonly validationRules: {
        readonly id: string;
        readonly paths: string[];
        readonly requires: ("security" | "unit" | "integration" | "browser" | "build" | "lint" | "typecheck" | "architecture")[];
    }[];
    readonly concurrency: number;
    readonly failFast: boolean;
    readonly maxRunMs: number;
    readonly maxRepairAttempts: number;
    readonly validationMaxAgeMs: number;
    readonly risk: {
        readonly fastPaths: string[];
        readonly highPaths: string[];
        readonly maxFastFiles: number;
        readonly maxFastLines: number;
    };
}>;
export type Task = Infer<typeof taskSchema>;
export type Config = Infer<typeof configSchema>;
export type Gate = Infer<typeof gateSchema>;
export type CommandSpec = Infer<typeof commandSchema>;
export interface RiskDecision {
    lane: Lane;
    reasons: string[];
}
export interface ChangeSet {
    files: string[];
    added: string[];
    lines: number;
    binary: boolean;
}
export interface ProcessResult {
    exitCode: number | null;
    signal: string | null;
    status: 'passed' | 'failed' | 'timed_out' | 'cancelled' | 'spawn_error';
    durationMs: number;
    stdoutHash: string;
    stderrHash: string;
    stdout: string;
    stderr: string;
    truncated: boolean;
    /** With `waitReady`: milliseconds from the spawn to the ready signal on fd 3 (the timeout started then), null when it never came. */
    readyMs?: number | null;
}
/**
 * Status of a receipt. `passed_after_retry`: the command failed, then its relaunch of the failed tests
 * (`retryFailed`) passed on the same commit and tree; counted as passed, always shown apart (unstable).
 */
/** Outcome of the repetition of the changed test files recorded in a receipt (`repeat.status`). */
export declare const repeatStatuses: readonly ["passed", "failed", "timed_out", "cancelled", "spawn_error", "none", "no_base", "not_run"];
/**
 * `not_required`: a check that declares `skipWhenOnly`, not run because every file the change touches is outside its
 * scope (`scope` of the receipt); never a success by itself, `apv gates verify` recomputes the scope from the commit.
 */
export declare const receiptStatuses: readonly ["passed", "failed", "timed_out", "cancelled", "spawn_error", "blocked", "cached", "passed_after_retry", "not_required"];
/** Most changed files a receipt lists in `scope.files`; beyond, a check is always required. */
export declare const MAX_SCOPE_FILES = 2000;
/** What `apv web audit` records for the receipt of the check that runs it (`APV_WEB_RECORD`). */
export declare const webRecordSchema: import("./schema.js").Schema<{
    readonly required: boolean;
    readonly base: string | null;
    readonly reference: string | null;
    readonly files: string[];
    readonly changed: number;
    readonly auditId: string | null;
    readonly ok: boolean;
}>;
export type WebRecord = Infer<typeof webRecordSchema>;
export declare const receiptSchema: import("./schema.js").Schema<{
    readonly id: string;
    readonly runId: string;
    readonly gateId: string;
    readonly key: string;
    readonly candidateSha: string;
    readonly configHash: string;
    readonly environmentHash: string;
    readonly status: "passed" | "failed" | "timed_out" | "cancelled" | "spawn_error" | "blocked" | "cached" | "passed_after_retry" | "not_required";
    readonly startedAt: number;
    readonly durationMs: number;
    readonly exitCode: number | null;
    readonly stdoutHash: string;
    readonly stderrHash: string;
    readonly diagnostic: string;
    readonly reusedFrom: string | null;
    readonly stage: "task" | "full" | undefined;
    readonly dirty: boolean | undefined;
    readonly targeted: boolean | undefined;
    readonly override: {
        readonly run: string;
        readonly reason: string;
    } | undefined;
    readonly nearTimeout: {
        readonly timeoutMs: number;
        readonly percent: number;
    } | undefined;
    readonly lockWaitMs: number | undefined;
    readonly stack: string | undefined;
    readonly retry: {
        readonly command: string[];
        readonly first: {
            readonly status: "failed";
            readonly exitCode: number | null;
            readonly durationMs: number;
            readonly stdoutHash: string;
            readonly stderrHash: string;
            readonly diagnostic: string;
        };
        readonly output: string;
        readonly tests: string[];
    } | undefined;
    readonly repeat: {
        readonly base: string | null;
        readonly reference: string | null | undefined;
        readonly files: string[];
        readonly importsOnly: string[];
        readonly movedPathsOnly: string[];
        readonly times: number;
        readonly status: "passed" | "failed" | "timed_out" | "cancelled" | "spawn_error" | "none" | "no_base" | "not_run";
        readonly command: string[] | undefined;
        readonly durationMs: number | undefined;
        readonly exitCode: number | null | undefined;
        readonly failures: {
            readonly test: string;
            readonly count: number;
        }[];
        readonly output: string | undefined;
        readonly fixedWaits: {
            readonly file: string;
            readonly line: number;
            readonly text: string;
        }[];
    } | undefined;
    readonly web: {
        readonly required: boolean;
        readonly base: string | null;
        readonly reference: string | null;
        readonly files: string[];
        readonly changed: number;
        readonly auditId: string | null;
        readonly ok: boolean;
    } | undefined;
    readonly scope: {
        readonly required: boolean;
        readonly reason: string;
        readonly base: string | null;
        readonly reference: string | null;
        readonly referenceName: string;
        readonly referenceSha: string | null;
        readonly fileCount: number;
        readonly files: string[];
        readonly blocking: string[];
    } | undefined;
}>;
export type GateReceipt = Infer<typeof receiptSchema>;
export declare function validateReceipt(value: unknown): GateReceipt;
export declare function validateConfig(value: unknown): Config;
