import { skillsSchema, knowledgeSchema } from './knowledge.js';
import { s, type Infer } from './schema.js';
import { invariant } from './errors.js';
export const VERSION = '3.0.0-alpha.11';
export const lanes = ['fast', 'standard', 'high'] as const;
export const validationKinds = ['unit', 'integration', 'browser', 'build', 'lint', 'typecheck', 'security', 'architecture'] as const;
export type Lane = typeof lanes[number];
/**
 * When a check runs: `task` after every task (fast feedback), `full` only in the complete suite that accepts a
 * wave or a delivery. Absent means `task`: a configuration without stages keeps running every check everywhere.
 */
export const gateStages = ['task', 'full'] as const;
export type GateStage = typeof gateStages[number];
const id = s.string(1, 80, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const paths = s.array(s.string(1, 500), 0, 500);
const argv = s.array(s.string(1, 16000), 1, 200);
export const envNamesSchema = s.array(s.string(1, 100, /^[a-zA-Z_][a-zA-Z0-9_]*$/), 0, 100);
export const commandSchema = s.object({
  command: argv,
  timeoutMs: s.default(s.number(10, 3600000), 120000),
  passEnv: s.default(envNamesSchema, []),
});
/** Longest wait for the lock of a check (`lock.waitMs`) when absent: 30 minutes. */
export const DEFAULT_LOCK_WAIT_MS = 1_800_000;
/** Fixed waits found in the lines a change adds to a repeated test file: off, a warning, or a refusal of the run. */
export const fixedWaitModes = ['off', 'warn', 'refuse'] as const;
/** Default ceilings of `repeatChanged`: repetitions of each test, files repeated in one run. */
export const DEFAULT_REPEAT = { times: 5, maxFiles: 10 } as const;
/**
 * `repeatChanged` of a check: `paths` (globs of the test files concerned), `command` (the repetition, the files
 * appended), `times` (repetitions of each test, `{{repeat}}`), `maxFiles` (above: the run is refused), `timeoutMs`
 * (duration ceiling of the repetition), `testPattern` (lines naming a failed test), `stressArgs`, `fixedWaits`, `reference`.
 */
export const repeatChangedSchema = s.object({
  paths: s.array(s.string(1, 500), 1, 50),
  command: argv,
  times: s.default(s.number(2, 100), DEFAULT_REPEAT.times),
  maxFiles: s.default(s.number(1, 100), DEFAULT_REPEAT.maxFiles),
  // Duration ceiling of the repetition (its own timeout); absent: the timeout of the check.
  timeoutMs: s.optional(s.number(10, 3600000)),
  testPattern: s.optional(s.string(1, 500)),
  // Extra arguments that load the repetition (more parallel workers), before the files.
  stressArgs: s.optional(s.array(s.string(1, 1000), 1, 20)),
  fixedWaits: s.default(s.enum(fixedWaitModes), 'warn'),
  // The branch the change goes to (a Git ref, `origin/main` for example), required: a full run also repeats the test
  // files changed since its merge base, and `apv gates verify` requires them; a reference that does not resolve refuses
  // both, never a silent fallback on `--base` alone.
  reference: s.string(1, 200, /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/),
});
/**
 * `skipWhenOnly` of a check: the scope of its proof (docs/APV3-SPEC.md, section 21). `paths` (globs of the files that
 * have no effect on what the check proves: documentation, decisions, specs), `except` (globs taken out of `paths`, for
 * example the sources out of the Markdown files), `reference` (the branch the change goes to, `origin/main` for example, required: the
 * files are also counted from its merge base, and the lists are read there, never in the change). A full run where
 * every file changed since the merge bases of `--base` and of the reference matches `paths` (and no `except`, no file
 * of `ALWAYS_REQUIRED`, no change of mode or type) records the check as not required instead of running it.
 */
export const skipWhenOnlySchema = s.object({
  paths: s.array(s.string(1, 500), 1, 100),
  except: s.optional(s.array(s.string(1, 500), 1, 100)),
  reference: s.string(1, 200, /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/),
});
export const gateSchema = s.object({
  id, command: argv,
  // Reviewed coverage labels, never inferred from a successful exit code or a gate name.
  covers: s.default(s.array(s.enum(validationKinds), 0, validationKinds.length), []),
  // Test files actually included by this command, reviewed together with its argv.
  testPaths: s.default(paths, []),
  timeoutMs: s.default(s.number(10, 3600000), 120000),
  passEnv: s.default(envNamesSchema, []),
  dependsOn: s.default(s.array(id), []),
  resources: s.default(s.array(id), []),
  // Operator assertion: neither this command nor its children writes to the shared workspace.
  // Absent on legacy configurations means exclusive access, including generated/ignored files.
  readOnly: s.default(s.boolean(), false),
  outputs: s.default(paths, []),
  paths: s.default(paths, []),
  lanes: s.default(s.array(s.enum(lanes), 1, 3), [...lanes]),
  mandatory: s.default(s.boolean(), false),
  // Explicit opt-in. A zero TTL NEVER participates in cross-validation caching.
  cacheTtlMs: s.default(s.number(0, 86400000), 0),
  // Optional, never defaulted: a configuration without stages parses and hashes exactly as before.
  stage: s.optional(s.enum(gateStages)),
  // Targeted variant of a `full` check (argv, same placeholders): only the tests concerned by the changes since the
  // base, for example `playwright test --only-changed={{baseSha}}`. Run by the task stage in place of the check,
  // never counted as proof of it. Optional, never defaulted: absent, parsing and hashing are unchanged.
  affected: s.optional(argv),
  // Resource the check shares with other copies of the repository (a test stack): held around its command, whose
  // timeout starts once it is held. A lease of `apv lock` (`resource`) or a kernel `flock` on a file (`file`).
  // Optional, never defaulted: absent, parsing and hashing are unchanged.
  lock: s.optional(s.union(
    s.object({ resource: id, waitMs: s.default(s.number(0, 86_400_000), DEFAULT_LOCK_WAIT_MS) }),
    s.object({ file: s.string(1, 4000), fileEnv: s.optional(s.string(1, 100, /^[a-zA-Z_][a-zA-Z0-9_]*$/)), waitMs: s.default(s.number(0, 86_400_000), DEFAULT_LOCK_WAIT_MS) }),
  )),
  // Relaunch of the failed tests only (argv, same placeholders), run once when the command fails by itself, on the
  // same commit and tree: success gives `passed_after_retry`. `testPattern`: regular expression whose matches in the
  // output of the first pass name the tests concerned (capture group 1 when present). Optional, never defaulted.
  retryFailed: s.optional(s.object({ command: argv, testPattern: s.optional(s.string(1, 500)) })),
  // Repetition of the test files the diff against `--base` adds or modifies (globs `paths`): once the command passed,
  // `command` (`{{repeat}}` anywhere in an argument, `stressArgs` appended) runs on those files only, which are
  // appended; any failure turns the check red, never relaunched by `retryFailed`. Optional, never defaulted.
  repeatChanged: s.optional(repeatChangedSchema),
  // Scope of the proof: a full run whose changes only touch these paths records the check as not required (never run,
  // never proven by the command) after recomputing it from the commit. Optional, never defaulted.
  skipWhenOnly: s.optional(skipWhenOnlySchema),
});
/** Stage of a check; absent means `task`. */
export const gateStage = (gate: { stage?: GateStage | undefined }): GateStage => gate.stage ?? 'task';
/** Variables a command receives by default; every other variable must be named in `passEnv`. */
export const DEFAULT_PASS_ENV = ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG'] as const;
// Additional project-specific obligations; defaults inferred from the diff cannot be removed here.
export const validationRulesSchema = s.default(s.array(s.object({
  id, paths: s.array(s.string(1, 500), 1, 100),
  requires: s.array(s.enum(validationKinds), 1, validationKinds.length),
}), 0, 100), []);
export const riskSchema = s.default(s.object({
  fastPaths: s.default(paths, ['docs/**', '*.md']),
  highPaths: s.default(paths, []),
  maxFastFiles: s.default(s.number(1, 100), 5),
  maxFastLines: s.default(s.number(1, 1000), 100),
}), { fastPaths: ['docs/**', '*.md'], highPaths: [], maxFastFiles: 5, maxFastLines: 100 });
// Hard ceiling of the task contract. The effective lifecycle budget is `limits.maxTaskContextChars`.
export const MAX_TASK_DESCRIPTION = 400000;
export const DEFAULT_LIMITS = { maxTaskContextChars: 120000, maxQaDiffBytes: 524288 } as const;
/** Paths regenerated by project tooling; an Implementer without a shell must not be asked to edit them. */
export const DEFAULT_GENERATED_PATHS = ['**/package-lock.json', '**/npm-shrinkwrap.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/bun.lock', '**/bun.lockb',
  '**/Cargo.lock', '**/go.sum', '**/poetry.lock', '**/Pipfile.lock', '**/uv.lock', '**/pdm.lock', '**/composer.lock', '**/Gemfile.lock',
  '**/packages.lock.json', '**/gradle.lockfile', '**/pubspec.lock', '**/mix.lock', '**/flake.lock', '**/Package.resolved', '**/Podfile.lock'];
export const taskSchema = s.object({
  id, title: s.string(1, 500), description: s.string(1, MAX_TASK_DESCRIPTION),
  acceptance: s.array(s.string(1, 3000), 1, 100),
  allowedPaths: s.array(s.string(1, 500), 1, 500),
  // Existing files remain strict. New supporting files may be created only inside
  // explicitly declared envelopes, with a small deterministic count limit.
  allowedNewPaths: s.default(s.array(s.string(1, 500), 0, 100), []),
  maxNewFiles: s.default(s.number(0, 50), 0),
  // Lifecycle-managed tasks defer human review to the integrated candidate.
  reviewRequired: s.default(s.boolean(), true),
  minimumLane: s.default(s.enum(lanes), 'fast'),
});
export const agentSchema = s.object({
  type: s.enum(['command', 'codex', 'claude']),
  // Explicit account policy, not authentication detection. Legacy preserves existing installations.
  usageMode: s.default(s.enum(['legacy', 'subscription', 'metered']), 'legacy'),
  command: s.default(s.array(s.string(1, 16000), 0, 200), []),
  // Safety ceiling, not a target. A role and its output repairs share this deadline.
  timeoutMs: s.default(s.number(10, 3600000), 1800000),
  passEnv: s.default(envNamesSchema, []),
  model: s.default(s.string(0, 200), ''),
  effort: s.default(s.enum(['default', 'low', 'medium', 'high']), 'default'),
  // Opt-in compatibility probe, without project content, before a native model is used.
  preflight: s.default(s.enum(['off', 'probe']), 'off'),
  // A turn count measures neither useful work, nor time, nor money: it is a net against an endless loop,
  // not the arbiter of daily work. Time and cost are the bounds that measure what an operator wants to limit.
  maxTurns: s.default(s.number(1, 200), 200),
  maxBudgetUsd: s.default(s.nullable(s.finite(0.01, 1000)), null),
});
export type AgentConfig = Infer<typeof agentSchema>;
export const configSchema = s.object({
  schemaVersion: s.literal(1),
  executionMode: s.literal('local-trusted'),
  environment: s.object({
    id: s.string(1, 500),
    passEnv: s.default(envNamesSchema, [...DEFAULT_PASS_ENV]),
  }),
  agent: agentSchema,
  skills: s.default(skillsSchema, { enabled: [], projectType: 'unknown', maxContextBytes: 16000 }),
  knowledge: s.default(knowledgeSchema, { languages: [] }),
  roles: s.default(s.object({
    product: s.default(s.nullable(agentSchema), null),
    qa: s.default(s.nullable(agentSchema), null),
    design: s.default(s.nullable(agentSchema), null),
  }), { product: null, qa: null, design: null }),
  modelRouting: s.default(s.array(s.object({
    provider: s.enum(['claude', 'codex']), role: s.enum(['product', 'design', 'implementer', 'qa']), lane: s.enum(lanes),
    model: s.string(1, 200), effort: s.default(s.enum(['default', 'low', 'medium', 'high']), 'default'),
  }), 0, 24), []),
  roleProfiles: s.default(s.array(s.object({
    provider: s.enum(['claude', 'codex']), role: s.enum(['product', 'design', 'implementer', 'qa']),
    quick: s.object({ model: s.string(1, 200), effort: s.enum(['low', 'medium', 'high']) }),
    deep: s.object({ model: s.string(1, 200), effort: s.enum(['low', 'medium', 'high']) }),
  }), 0, 8), []),
  workflow: s.default(s.object({
    planningMode: s.default(s.enum(['legacy', 'adaptive']), 'legacy'),
    qualityReview: s.default(s.enum(['legacy', 'evidence']), 'legacy'),
    /** QA checks the other roles' work: it takes the deep profile whatever lane the reviewed task ran in. */
    qaProfile: s.default(s.enum(['lane', 'deep']), 'deep'),
    qaLanes: s.default(s.array(s.enum(lanes), 0, 3), ['standard', 'high']),
    maxQaRepairs: s.default(s.number(0, 3), 2),
    maxActiveMs: s.default(s.number(100, 14400000), 3600000),
    reviewMode: s.default(s.enum(['solo', 'team', 'regulated']), 'team'),
    // Extra role invocations after an output-contract violation (schema, spec/design/QA invariants).
    maxOutputRepairs: s.default(s.number(0, 2), 1),
    // Files only project tooling regenerates (lock files by default). Globs; replace the list to adapt to the stack.
    generatedPaths: s.default(s.array(s.string(1, 300), 0, 100), [...DEFAULT_GENERATED_PATHS]),
    /** Stops a spec once the providers declare this much spending on it; continuing is an explicit decision. */
    maxSpecCostUsd: s.default(s.nullable(s.finite(0.01, 10000)), 25),
  }), { planningMode: 'legacy', qualityReview: 'legacy', qaProfile: 'deep', qaLanes: ['standard', 'high'], maxQaRepairs: 2, maxActiveMs: 3600000, reviewMode: 'team', maxOutputRepairs: 1, generatedPaths: [...DEFAULT_GENERATED_PATHS], maxSpecCostUsd: 25 }),
  feedback: s.default(s.object({
    gateIds: s.default(s.array(id, 0, 20), []),
    maxCalls: s.default(s.number(1, 20), 4),
    maxTotalMs: s.default(s.number(100, 600000), 120000),
  }), { gateIds: [], maxCalls: 4, maxTotalMs: 120000 }),
  validationReserveMs: s.default(s.number(0, 600000), 60000),
  limits: s.default(s.object({
    // Characters of approved context embedded in one task or QA-repair description.
    maxTaskContextChars: s.default(s.number(10000, MAX_TASK_DESCRIPTION), DEFAULT_LIMITS.maxTaskContextChars),
    // Integrated diff handed to QA; beyond it QA is refused rather than truncated.
    maxQaDiffBytes: s.default(s.number(65536, 8388608), DEFAULT_LIMITS.maxQaDiffBytes),
  }), { ...DEFAULT_LIMITS }),
  setup: s.default(s.array(commandSchema, 0, 20), []),
  gates: s.array(gateSchema, 1, 100),
  validationRules: validationRulesSchema,
  concurrency: s.default(s.number(1, 16), 3),
  failFast: s.default(s.boolean(), true),
  // An attempt is one agent session plus its checks: leave room for both after the agent timeout.
  maxRunMs: s.default(s.number(100, 7200000), 2700000),
  // Fixing one red check often reveals the next: a single pass loses the whole attempt. The loop stops by
  // itself as soon as a repair changes nothing or leaves the checks failing exactly as before.
  maxRepairAttempts: s.default(s.number(0, 5), 3),
  // The bound guards approval and export against proof that no longer describes the environment.
  // One hour could not survive the step it protects: a human reading a diff, sleeping on it, or
  // merging after lunch came back to expired evidence and paid a full revalidation and a fresh
  // quality review for a candidate nobody had touched. A day is the unit a human review works in.
  validationMaxAgeMs: s.default(s.number(1000, 86400000), 86400000),
  risk: riskSchema,
});
export type Task = Infer<typeof taskSchema>;
export type Config = Infer<typeof configSchema>;
export type Gate = Infer<typeof gateSchema>;
export type CommandSpec = Infer<typeof commandSchema>;
export interface RiskDecision { lane: Lane; reasons: string[] }
export interface ChangeSet { files: string[]; added: string[]; lines: number; binary: boolean }
export interface ProcessResult {
  exitCode: number | null; signal: string | null;
  status: 'passed' | 'failed' | 'timed_out' | 'cancelled' | 'spawn_error';
  durationMs: number; stdoutHash: string; stderrHash: string;
  stdout: string; stderr: string; truncated: boolean;
  /** With `waitReady`: milliseconds from the spawn to the ready signal on fd 3 (the timeout started then), null when it never came. */
  readyMs?: number | null;
}
/**
 * Status of a receipt. `passed_after_retry`: the command failed, then its relaunch of the failed tests
 * (`retryFailed`) passed on the same commit and tree; counted as passed, always shown apart (unstable).
 */
/** Outcome of the repetition of the changed test files recorded in a receipt (`repeat.status`). */
export const repeatStatuses = ['passed', 'failed', 'timed_out', 'cancelled', 'spawn_error', 'none', 'no_base', 'not_run'] as const;
/**
 * `not_required`: a check that declares `skipWhenOnly`, not run because every file the change touches is outside its
 * scope (`scope` of the receipt); never a success by itself, `apv gates verify` recomputes the scope from the commit.
 */
export const receiptStatuses = ['passed','failed','timed_out','cancelled','spawn_error','blocked','cached','passed_after_retry','not_required'] as const;
/** Most changed files a receipt lists in `scope.files`; beyond, a check is always required. */
export const MAX_SCOPE_FILES = 2000;
const digest = s.string(64,64,/^[a-f0-9]{64}$/);
const sha = s.string(40,64,/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
/** What `apv web audit` records for the receipt of the check that runs it (`APV_WEB_RECORD`). */
export const webRecordSchema = s.object({
  required: s.boolean(),
  base: s.nullable(sha),
  reference: s.nullable(s.string(1, 200)),
  files: s.array(s.string(1, 500), 0, 50),
  changed: s.number(0, 10_000_000),
  auditId: s.nullable(s.string(1, 100, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
  ok: s.boolean(),
});
export type WebRecord = Infer<typeof webRecordSchema>;
export const receiptSchema = s.object({
  id,runId: id,gateId: id,key: digest,candidateSha: sha,configHash: digest,environmentHash: digest,
  status: s.enum(receiptStatuses),
  startedAt: s.number(0,Number.MAX_SAFE_INTEGER),durationMs: s.finite(0,86_400_000),
  exitCode: s.nullable(s.number(0,255)),
  stdoutHash: s.string(0,64,/^(?:[a-f0-9]{64})?$/),stderrHash: s.string(0,64,/^(?:[a-f0-9]{64})?$/),
  diagnostic: s.string(0,16000),reusedFrom: s.nullable(id),
  // Written by `apv gates run`: the stage it was asked for, and whether the working tree had uncommitted
  // changes (the receipt then describes more than `candidateSha`). Absent on older receipts.
  stage: s.optional(s.enum(gateStages)),
  dirty: s.optional(s.boolean()),
  // True when the task stage ran the targeted variant (`affected`) of a full check: never proof of the full check.
  targeted: s.optional(s.boolean()),
  // A full suite run while the execution `run` expected the task level at its current step (`apv gates run
  // --reason`): the reason, also journaled in the state of the execution. Absent otherwise.
  override: s.optional(s.object({ run: s.string(1, 80, /^[A-Za-z0-9][A-Za-z0-9._-]*$/), reason: s.string(1, 500) })),
  // Time spent waiting for the lock of the check (`lock`) before its command started. Absent without a lock.
  lockWaitMs: s.optional(s.finite(0, 86_400_000)),
  // The declared test stack the check ran on (`apv gates run --stacks`), in its own copy when not the first. Absent otherwise.
  stack: s.optional(s.string(1, 80, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)),
  // A failed first pass relaunched through `retryFailed`: that pass, the relaunch command, an excerpt of its output
  // and the tests concerned. Present on `passed_after_retry` and on a relaunch that failed too.
  retry: s.optional(s.object({
    command: argv,
    first: s.object({ status: s.enum(['failed']), exitCode: s.nullable(s.number(0,255)), durationMs: s.finite(0,86_400_000),
      stdoutHash: s.string(0,64,/^(?:[a-f0-9]{64})?$/), stderrHash: s.string(0,64,/^(?:[a-f0-9]{64})?$/), diagnostic: s.string(0,16000) }),
    output: s.string(0,16000),
    tests: s.array(s.string(1, 500), 0, 100),
  })),
  // The repetition of the changed test files (`repeatChanged`): the files, how many times, and its outcome. Present
  // whenever the check declares it: `none` (no changed test file), `no_base` (run without `--base`), `not_run` (the
  // command itself did not pass), else the status of the repetition.
  repeat: s.optional(s.object({
    base: s.nullable(sha),
    // The merge base with the reference (`repeatChanged.reference`) the files were also compared to; absent or null: none.
    reference: s.optional(s.nullable(sha)),
    files: s.array(s.string(1, 500), 0, 2000),
    // Changed test files whose only differences with the base are the paths of their imports: listed, not repeated.
    importsOnly: s.default(s.array(s.string(1, 500), 0, 2000), []),
    times: s.number(2, 100),
    status: s.enum(repeatStatuses),
    command: s.optional(argv),
    durationMs: s.optional(s.finite(0, 86_400_000)),
    exitCode: s.optional(s.nullable(s.number(0, 255))),
    failures: s.default(s.array(s.object({ test: s.string(1, 500), count: s.number(1, 1_000_000) }), 0, 100), []),
    output: s.optional(s.string(0, 16000)),
    fixedWaits: s.default(s.array(s.object({ file: s.string(1, 500), line: s.number(1, 10_000_000), text: s.string(0, 300) }), 0, 100), []),
  })),
  // What `apv web audit` run by the check recorded (`APV_WEB_RECORD`): whether the audit was required, from which base,
  // the changed files with a web effect, and the audit made (null: « not required », nothing measured). `apv gates verify`
  // recomputes « required » from the commit: a « not required » receipt proves nothing when the recomputation says required.
  web: s.optional(webRecordSchema),
  // The scope of the proof of a check that declares `skipWhenOnly` (full run): whether it was required and why, the
  // merge bases of `--base` (`base`) and of the reference (`reference`, its name and the commit it named), and the files
  // changed since them (all of them when not required; `blocking`: those that made it required).
  scope: s.optional(s.object({
    required: s.boolean(),
    reason: s.string(1, 2000),
    base: s.nullable(sha),
    reference: s.nullable(sha),
    referenceName: s.string(1, 200),
    referenceSha: s.nullable(sha),
    fileCount: s.number(0, 100_000_000),
    files: s.array(s.string(1, 4096), 0, MAX_SCOPE_FILES),
    blocking: s.default(s.array(s.string(1, 4096), 0, 50), []),
  })),
});
export type GateReceipt = Infer<typeof receiptSchema>;
export function validateReceipt(value: unknown): GateReceipt {
  const r = receiptSchema.parse(value);
  invariant(r.status !== 'passed_after_retry' || r.retry !== undefined, 'RECEIPT', 'A receipt passed after retry carries its first pass');
  if (r.status === 'passed' || r.status === 'cached' || r.status === 'passed_after_retry') invariant(r.exitCode === 0 && r.stdoutHash.length === 64 &&
    r.stderrHash.length === 64,'RECEIPT','Successful receipt requires exit 0 and both stream digests');
  invariant((r.status === 'cached') === (r.reusedFrom !== null),'RECEIPT','Only cache hits may reference an earlier receipt');
  invariant(!r.repeat || !['failed', 'timed_out', 'cancelled', 'spawn_error'].includes(r.repeat.status) || (r.status !== 'passed' && r.status !== 'cached' && r.status !== 'passed_after_retry'),
    'RECEIPT', 'A receipt whose repetition of the changed tests failed is never a success');
  invariant((r.status === 'not_required') === (r.scope?.required === false), 'RECEIPT', 'A receipt is not_required exactly when its scope says the check is not required');
  invariant(r.status !== 'not_required' || (r.exitCode === null && r.scope!.base !== null && r.scope!.reference !== null && r.scope!.referenceSha !== null &&
    r.scope!.files.length === r.scope!.fileCount), 'RECEIPT', 'A not_required receipt runs nothing and lists every changed file with its bases');
  return r;
}
export function validateConfig(value: unknown): Config {
  const config = configSchema.parse(value);
  invariant(config.agent.type !== 'command' || config.agent.command.length > 0, 'CONFIG', 'Command agent requires an argv array');
  invariant(config.agent.type !== 'codex' || config.agent.command.length <= 1, 'CONFIG', 'Codex command may contain only the executable path; use the typed model field');
  for (const agent of [config.agent, config.roles.product, config.roles.qa, config.roles.design].filter((a): a is AgentConfig => a !== null)) {
    invariant(agent.type !== 'command' || agent.command.length > 0, 'CONFIG', 'Role command agent requires an argv array');
    invariant(agent.type === 'command' || agent.command.length <= 1, 'CONFIG', 'Native provider accepts only the executable path');
    invariant(agent.preflight !== 'probe' || agent.type !== 'command', 'CONFIG', 'Model probes require a native provider');
  }
  invariant(new Set(config.skills.enabled).size === config.skills.enabled.length, 'CONFIG', 'Duplicate enabled skill');
  invariant(new Set(config.modelRouting.map(r => `${r.provider}:${r.role}:${r.lane}`)).size === config.modelRouting.length, 'CONFIG', 'Duplicate model route');
  invariant(new Set(config.roleProfiles.map(r => `${r.provider}:${r.role}`)).size === config.roleProfiles.length, 'CONFIG', 'Duplicate role profile');
  const ids = config.gates.map(g => g.id);
  invariant(new Set(ids).size === ids.length, 'CONFIG', 'Duplicate gate id');
  invariant(new Set(config.validationRules.map(r => r.id)).size === config.validationRules.length, 'CONFIG', 'Duplicate validation rule id');
  invariant(new Set(config.feedback.gateIds).size === config.feedback.gateIds.length && config.feedback.gateIds.every(id => config.gates.some(g => g.id === id && g.dependsOn.length === 0 && g.command.every(a => !a.includes('{{')))), 'CONFIG', 'Feedback must reference independent configured checks without candidate placeholders');
  for (const gate of config.gates) {
    invariant(new Set(gate.covers).size === gate.covers.length, 'CONFIG', `Duplicate coverage label: ${gate.id}`);
    if (gate.cacheTtlMs > 0) invariant(gate.outputs.length === 0 && gate.dependsOn.length === 0 &&
      !config.gates.some(g => g.dependsOn.includes(gate.id)), 'CONFIG',
      `Receipt-only caching is limited to independent, output-free checks in this alpha: ${gate.id}`);
    invariant(new Set(gate.dependsOn).size === gate.dependsOn.length, 'CONFIG', `Duplicate dependency: ${gate.id}`);
    for (const dep of gate.dependsOn) invariant(ids.includes(dep), 'CONFIG', `Unknown dependency ${dep}`);
  }
  return config;
}
