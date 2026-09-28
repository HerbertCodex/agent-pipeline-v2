import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { s } from '../domain/schema.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { IssueList, schemaIssues } from '../domain/issues.js';
import { DEFAULT_PASS_ENV, envNamesSchema, gateSchema, gateStage, riskSchema, validationRulesSchema } from '../domain/contracts.js';
import { skillsSchema } from '../domain/knowledge.js';
import { previewSchema } from '../preview/config.js';
import { designDir, designSchema } from '../design/config.js';
import { structureSchema, structureSettings } from '../structure/config.js';
import { matches, validateDag } from '../policy/policy.js';
import { DEFAULT_RECEIPT_RETENTION } from '../gates/store.js';
import { gitRead } from '../run/git-probe.js';
import { reviewAlwaysSchema, reviewPathsSchema, reviewTermsSchema } from '../review/config.js';
import { stackIssues, stacksSchema } from '../stacks/config.js';
import { webIssues, webSchema } from '../web/config.js';
/** V3 project configuration, versioned with the project. */
export const CONFIG_FILE = '.apv/config.json';
/** V2 configuration, read as is for projects not yet migrated. */
export const LEGACY_CONFIG_FILE = 'pipeline.v2.json';
/**
 * The only configuration sections the V3 tool reads. Agent, budget, timing, model and tuning fields of a
 * V2 file belong to the removed controller: they are ignored, never interpreted (spec, section 14).
 */
export const READ_SECTIONS = ['name', 'gates', 'risk', 'validationRules', 'environment', 'skills', 'preview', 'design', 'structure', 'run', 'spec', 'review', 'receipts', 'resources', 'suite', 'stacks', 'batch', 'web'];
/** Sections read and validated by their own command (`db`: `apv db check`, docs/DB-CHECK.md): never reported as ignored. */
export const OWN_SECTIONS = ['db'];
/**
 * When `/apv:run` passes the full suite (the checks of stage `full` included):
 * - `final` (default): at the last integration of a spec (every task integrated, before the reviews) and at the
 *   delivery on the final head; the intermediate integrations and the fix passes advance on the task checks and
 *   the targeted tests, verified at the exact commit (`apv gates verify --stage task --base <ref>`);
 * - `each-integration`: at every integration, fix passes included, and at the delivery (the rhythm of 3.0.0-alpha.3 and before).
 */
export const FULL_SUITE_MODES = ['final', 'each-integration'];
export const DEFAULT_FULL_SUITE = 'final';
/** Settings of `/apv:run` read by the tool (`apv run next`); absent: defaults. */
export const runSettingsSchema = s.object({
    fullSuite: s.default(s.enum(FULL_SUITE_MODES), DEFAULT_FULL_SUITE),
});
/**
 * Size thresholds of a spec (`apv spec validate` warns above them, never refuses): a spec with more tasks or
 * criteria is better split into independent specs delivered in parallel, and a longer chain of dependency layers
 * makes every layer wait for the integration of the previous one.
 */
export const DEFAULT_SPEC_LIMITS = { maxTasks: 6, maxAcceptance: 30, maxDepth: 3 };
export const specSettingsSchema = s.object({
    maxTasks: s.default(s.number(1, 100), DEFAULT_SPEC_LIMITS.maxTasks),
    maxAcceptance: s.default(s.number(1, 1000), DEFAULT_SPEC_LIMITS.maxAcceptance),
    maxDepth: s.default(s.number(1, 100), DEFAULT_SPEC_LIMITS.maxDepth),
});
/** Placeholders of the dynamic scan command (`review.dast.command`), replaced as whole arguments. */
export const DAST_PLACEHOLDERS = ['reportDir', 'commit', 'repo'];
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
/**
 * Test resources of the project (a test database, a browser stack, a scanner), named like the `resources` of the
 * checks and of `apv lock`, with the TCP ports their servers listen on. `apv procs` reads the ports: a process
 * left listening there by an interrupted suite, started in a worktree of the repository, can be stopped.
 */
export const RESOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const testResourceSchema = s.object({
    ports: s.array(s.number(1, 65535), 1, 100),
    description: s.optional(s.string(1, 500)),
});
export const resourcesSchema = s.record(RESOURCE_ID, testResourceSchema, 100);
/**
 * The full suite of `apv gates run` (a run that executes a check of stage `full` in full): its machine queue, taken
 * before the first check, with an optional load threshold, and the test ports freed from orphans of the same copy.
 * `lockFile` is relative to the Git common directory (shared by every worktree of the repository) or absolute.
 */
export const DEFAULT_SUITE_QUEUE = { enabled: true, lockFile: 'apv/locks/full-suite.lock', waitMs: 7_200_000, loadWaitMs: 1_800_000 };
export const suiteQueueSchema = s.object({
    enabled: s.default(s.boolean(), DEFAULT_SUITE_QUEUE.enabled),
    lockFile: s.default(s.string(1, 4000, /(^|\/)[A-Za-z0-9][A-Za-z0-9._-]{0,110}\.lock$/), DEFAULT_SUITE_QUEUE.lockFile),
    waitMs: s.default(s.number(0, 86_400_000), DEFAULT_SUITE_QUEUE.waitMs),
    maxLoad: s.optional(s.finite(0.1, 10_000)),
    loadWaitMs: s.default(s.number(0, 86_400_000), DEFAULT_SUITE_QUEUE.loadWaitMs),
});
export const suiteSettingsSchema = s.object({
    queue: s.optional(suiteQueueSchema),
    ports: s.default(s.array(s.number(1, 65535), 0, 100), []),
});
/** The full suite settings of a configuration: `suite`, defaults for what is absent (queue on, no ports). */
export const suiteSettings = (config) => ({ queue: config.suite?.queue ?? suiteQueueSchema.parse({}), ports: config.suite?.ports ?? [] });
/**
 * Preparation of a fresh copy of the repository before a full suite runs in it (`apv stack batch`, the copies of
 * `apv gates run --stacks`): a command without shell run at its root, typically the install of the dependencies.
 */
export const DEFAULT_SETUP_TIMEOUT_MS = 900_000;
export const batchSettingsSchema = s.object({
    setup: s.optional(s.array(s.string(1, 16000), 1, 200)),
    setupTimeoutMs: s.default(s.number(1000, 3_600_000), DEFAULT_SETUP_TIMEOUT_MS),
    passEnv: s.default(envNamesSchema, []),
});
/** Declared test ports, sorted and without duplicates, with the resources (and stacks, `pile <id>`) that declare them. */
export function declaredTestPorts(config) {
    const ports = new Map();
    for (const [resource, { ports: list }] of Object.entries(config.resources ?? {})) {
        for (const port of list)
            ports.set(port, [...(ports.get(port) ?? []), resource]);
    }
    for (const stack of config.stacks ?? []) {
        for (const port of stack.ports ?? [])
            if (!(ports.get(port) ?? []).includes(`pile ${stack.id}`))
                ports.set(port, [...(ports.get(port) ?? []), `pile ${stack.id}`]);
    }
    return new Map([...ports].sort((a, b) => a[0] - b[0]));
}
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
    /** Test resources and their ports (docs/CONFIGURATION.md, « Ressources de test »); absent: none declared. */
    resources: s.optional(resourcesSchema),
    /** Full suite of `apv gates run`: queue, load threshold, ports freed (docs/CONFIGURATION.md, « Suite complète »); absent: queue on. */
    suite: s.optional(suiteSettingsSchema),
    /** Test stacks (docs/CONFIGURATION.md, « Piles de test »); absent: none, the stack rules block and stop nothing. */
    stacks: s.optional(stacksSchema),
    /** Preparation of a fresh copy (docs/CONFIGURATION.md, « Lot et copies »); absent: nothing is prepared. */
    batch: s.optional(batchSettingsSchema),
    /** Web quality of the public pages: Lighthouse and search and AI readiness (docs/CONFIGURATION.md, « Qualité web »); absent: `apv web audit` refuses. */
    web: s.optional(webSchema),
});
/** The spec size thresholds of a configuration: `spec`, defaults for what is absent. */
export const specLimits = (config) => ({ ...DEFAULT_SPEC_LIMITS, ...config.spec });
/** The full suite rhythm of a configuration: `run.fullSuite`, `final` when absent. */
export const fullSuiteMode = (config) => config.run?.fullSuite ?? DEFAULT_FULL_SUITE;
/** Picks the read sections: `environment.passEnv` only, whatever else a V2 environment declared. */
export function readSections(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        throw new PipelineError('CONFIG', 'Configuration must be a JSON object');
    const input = raw;
    const picked = {};
    for (const key of READ_SECTIONS)
        if (input[key] !== undefined)
            picked[key] = input[key];
    const env = input['environment'];
    if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
        const passEnv = env['passEnv'];
        picked['environment'] = passEnv === undefined ? {} : { passEnv };
    }
    const known = [...READ_SECTIONS, ...OWN_SECTIONS];
    return { picked, ignored: Object.keys(input).filter(k => !known.includes(k)).sort() };
}
/** Every problem of a configuration document: schema, duplicate ids, unknown dependencies, cycles. */
export function configIssues(raw) {
    let sections;
    try {
        sections = readSections(raw);
    }
    catch (error) {
        return { config: undefined, ignored: [], issues: [{ code: 'CONFIG', message: errorMessage(error) }] };
    }
    const { value, issues } = schemaIssues(apvConfigSchema, sections.picked);
    if (!value)
        return { config: undefined, ignored: sections.ignored, issues };
    const list = new IssueList();
    const ids = value.gates.map(g => g.id);
    const duplicates = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
    list.check(!duplicates.length, 'CONFIG', `Duplicate gate id: ${duplicates.join(', ')}`);
    for (const gate of value.gates) {
        list.check(new Set(gate.dependsOn).size === gate.dependsOn.length, 'CONFIG', `Duplicate dependency: ${gate.id}`);
        for (const dep of gate.dependsOn)
            list.check(ids.includes(dep), 'CONFIG', `Unknown dependency ${dep} of gate ${gate.id}`);
        // A task check never waits for the full suite: `apv gates run --stage task` could neither run nor skip it.
        if (gateStage(gate) === 'task')
            for (const dep of gate.dependsOn) {
                const target = value.gates.find(g => g.id === dep);
                list.check(!target || gateStage(target) === 'task', 'CONFIG', `Gate ${gate.id} (stage task) depends on ${dep}, reserved for the full suite (stage full)`);
            }
        // A targeted variant replaces a full check at the task stage only, where every dependency must run too.
        if (gate.affected) {
            list.check(gateStage(gate) === 'full', 'CONFIG', `Gate ${gate.id}: affected is the targeted variant of a full check; declare "stage": "full"`);
            for (const dep of gate.dependsOn) {
                const target = value.gates.find(g => g.id === dep);
                list.check(!target || gateStage(target) === 'task' || !!target.affected, 'CONFIG', `Gate ${gate.id} (targeted at stage task) depends on ${dep}, reserved for the full suite without a targeted variant`);
            }
        }
    }
    for (const [resource, { ports }] of Object.entries(value.resources ?? {})) {
        list.check(new Set(ports).size === ports.length, 'CONFIG', `resources.${resource}.ports: duplicate port`);
    }
    for (const message of stackIssues(value.stacks ?? []))
        list.check(false, 'CONFIG', message);
    const suitePorts = value.suite?.ports ?? [];
    list.check(new Set(suitePorts).size === suitePorts.length, 'CONFIG', 'suite.ports: duplicate port');
    for (const gate of value.gates) {
        if (gate.retryFailed?.testPattern !== undefined)
            list.attempt('CONFIG', () => {
                try {
                    new RegExp(gate.retryFailed.testPattern, 'm');
                }
                catch (error) {
                    throw new PipelineError('CONFIG', `Gate ${gate.id}: retryFailed.testPattern is not a valid regular expression: ${errorMessage(error)}`);
                }
            });
        const repeat = gate.repeatChanged;
        if (repeat) {
            if (repeat.testPattern !== undefined)
                list.attempt('CONFIG', () => {
                    try {
                        new RegExp(repeat.testPattern, 'm');
                    }
                    catch (error) {
                        throw new PipelineError('CONFIG', `Gate ${gate.id}: repeatChanged.testPattern is not a valid regular expression: ${errorMessage(error)}`);
                    }
                });
            // Portable globs only: a brace or a negation would silently match nothing, and a changed test would never repeat.
            for (const glob of repeat.paths)
                list.attempt('CONFIG', () => { try {
                    matches('probe', glob);
                }
                catch (error) {
                    throw new PipelineError('CONFIG', `Gate ${gate.id}: repeatChanged.paths: ${errorMessage(error)}`);
                } });
            // The number recorded in the receipt is the number the command runs: never a literal that could differ from `times`.
            list.check(repeat.command.some(a => a.includes('{{repeat}}')), 'CONFIG', `Gate ${gate.id}: repeatChanged.command must repeat the tests through {{repeat}} (for example "--repeat-each={{repeat}}"), replaced by repeatChanged.times`);
            // {{repeat}} is replaced in `command` only: in `stressArgs` it would reach the command as is.
            list.check(!(repeat.stressArgs ?? []).some(a => a.includes('{{repeat}}')), 'CONFIG', `Gate ${gate.id}: repeatChanged.stressArgs cannot use {{repeat}} (only repeatChanged.command does)`);
        }
    }
    // The scope of a proof (skipWhenOnly): portable globs, and none so broad that it would cover source code.
    for (const gate of value.gates) {
        const scope = gate.skipWhenOnly;
        if (!scope)
            continue;
        // `apv web audit` decides its own scope (web paths, recomputed by verify): never mixed with skipWhenOnly.
        const webAudit = [gate.command, gate.affected ?? []].some(argv => argv.some((x, i) => x === 'web' && argv[i + 1] === 'audit'));
        list.check(!webAudit, 'CONFIG', `Gate ${gate.id}: skipWhenOnly cannot be declared on a check that runs apv web audit (the audit decides whether it is required from web.paths)`);
        for (const [field, globs] of [['paths', scope.paths], ['except', scope.except ?? []]]) {
            for (const glob of globs)
                list.attempt('CONFIG', () => { try {
                    matches('probe', glob);
                }
                catch (error) {
                    throw new PipelineError('CONFIG', `Gate ${gate.id}: skipWhenOnly.${field}: ${errorMessage(error)}`);
                } });
        }
        // A probe of source or served content left in a glob, unless an `except` takes it out: `**/*.md` needs src/**, static/**,
        // public/** and content/** in `except`.
        const excepted = (path) => (scope.except ?? []).some(e => { try {
            return matches(path.toLowerCase(), e.toLowerCase());
        }
        catch {
            return false;
        } });
        for (const glob of scope.paths) {
            let covered;
            try {
                covered = CODE_PROBES.find(path => matches(path, glob) && !excepted(path));
            }
            catch {
                continue;
            }
            list.check(!covered, 'CONFIG', `Gate ${gate.id}: skipWhenOnly.paths « ${glob} » covers source code or served content (${covered}): list only files without effect on the check (docs/**...), and take the source, static, public and content folders out through skipWhenOnly.except (src/**, static/**, public/**, content/**)`);
        }
    }
    const ruleIds = value.validationRules.map(r => r.id);
    list.check(new Set(ruleIds).size === ruleIds.length, 'CONFIG', 'Duplicate validation rule id');
    if (value.design)
        list.attempt('CONFIG', () => designDir(value.design));
    if (value.structure)
        list.attempt('CONFIG', () => structureSettings(value.structure));
    for (const arg of value.review?.dast?.command ?? []) {
        if (!arg.includes('{{'))
            continue;
        const key = /^\{\{([A-Za-z]+)\}\}$/.exec(arg)?.[1];
        list.check(!!key && DAST_PLACEHOLDERS.includes(key), 'CONFIG', `review.dast.command: unknown or partial placeholder ${arg} (whole arguments only: ${DAST_PLACEHOLDERS.map(k => `{{${k}}}`).join(', ')})`);
    }
    // Portable globs only (the syntax of allowedPaths): a brace or a negation would silently match nothing.
    for (const [key, globs] of Object.entries(value.review?.paths ?? {})) {
        for (const glob of globs ?? [])
            list.attempt('CONFIG', () => { try {
                matches('probe', glob);
            }
            catch (error) {
                throw new PipelineError('CONFIG', `review.paths.${key}: ${errorMessage(error)}`);
            } });
    }
    if (value.web)
        for (const message of webIssues(value.web))
            list.check(false, 'CONFIG', message);
    if (list.empty)
        list.attempt('DAG', () => validateDag(value.gates));
    return { config: list.empty ? value : undefined, ignored: sections.ignored, issues: list.items };
}
/** Source files of common stacks: a `skipWhenOnly.paths` glob that matches one of them is too broad (refused). */
const CODE_PROBES = ['src/app.ts', 'src/app.js', 'src/lib/view.svelte', 'src/routes/+page.svelte', 'lib/app.py', 'app/models/user.rb', 'main.go', 'index.ts', 'index.js',
    'src/main.rs', 'server/index.mjs', 'app/page.tsx', 'pages/index.vue', 'App.java', 'Program.cs',
    'src/routes/+page.md', 'content/x.md', 'static/x.md', 'public/x.md', 'src/content/x.mdx', 'src/lib/x.svx'];
/** Configuration file of a project: `--config` when given, then `.apv/config.json`, then `pipeline.v2.json`. */
export function configFile(repo, explicit) {
    if (explicit)
        return { file: resolve(repo, explicit), legacy: false };
    const current = join(repo, CONFIG_FILE);
    if (existsSync(current))
        return { file: current, legacy: false };
    const legacy = join(repo, LEGACY_CONFIG_FILE);
    if (existsSync(legacy))
        return { file: legacy, legacy: true };
    return { file: null, legacy: false };
}
/**
 * Configuration of a project as committed at `commit` (a full SHA): `.apv/config.json`, then `pipeline.v2.json`,
 * read from the commit rather than the working tree, so that the proof of a commit is checked against the checks
 * that commit declared from any checkout of the repository. Neither file at the commit: defaults (no checks).
 * `file` is then `<sha>:<path>`.
 */
export function loadConfigAtCommit(repo, commit) {
    for (const [path, legacy] of [[CONFIG_FILE, false], [LEGACY_CONFIG_FILE, true]]) {
        if (gitRead(repo, ['cat-file', '-e', `${commit}:${path}`]) === null)
            continue;
        const text = gitRead(repo, ['show', `${commit}:${path}`]);
        const file = `${commit}:${path}`;
        if (text === null)
            throw new PipelineError('CONFIG', `Configuration unreadable at ${file}`);
        let raw;
        try {
            raw = JSON.parse(text);
        }
        catch (error) {
            throw new PipelineError('CONFIG', `Invalid JSON in ${file}: ${errorMessage(error)}`);
        }
        const { config, ignored, issues } = configIssues(raw);
        if (!config)
            throw new PipelineError(issues[0]?.code ?? 'CONFIG', `Invalid configuration ${file}:\n${issues.map(i => `- ${i.message}`).join('\n')}`);
        return { file, legacy, config, ignored };
    }
    return { file: null, legacy: false, config: apvConfigSchema.parse({}), ignored: [] };
}
export function loadConfig(repo, explicit) {
    const { file, legacy } = configFile(repo, explicit);
    if (!file)
        return { file: null, legacy: false, config: apvConfigSchema.parse({}), ignored: [] };
    if (!existsSync(file))
        throw new PipelineError('CONFIG', `Configuration file not found: ${file}`);
    let raw;
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch (error) {
        throw new PipelineError('CONFIG', `Invalid JSON in ${file}: ${errorMessage(error)}`);
    }
    const { config, ignored, issues } = configIssues(raw);
    if (!config)
        throw new PipelineError(issues[0]?.code ?? 'CONFIG', `Invalid configuration ${file}:\n${issues.map(i => `- ${i.message}`).join('\n')}`);
    return { file, legacy, config, ignored };
}
/** The policy view of a V3 configuration: evidence-mode review is the only mode V3 knows. */
export function policyConfig(config) {
    return { gates: config.gates, risk: config.risk, validationRules: config.validationRules, workflow: { qualityReview: 'evidence' } };
}
//# sourceMappingURL=load.js.map