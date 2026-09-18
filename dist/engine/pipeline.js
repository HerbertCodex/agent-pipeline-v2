import { ensureModelReady } from '../adapters/model-check.js';
import { assertRequiredEvidence, requiredEvidence } from "../quality/review.js";
import { modelChoice } from '../adapters/routing.js';
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { requestFor, runAgent } from "../adapters/agent.js";
import { budgetedAgent, remainingSpecMs } from "../adapters/invocations.js";
import { agentOutputSchema, taskSchema, transition, validateConfig, } from "../domain/contracts.js";
import { errorMessage, invariant, PipelineError } from "../domain/errors.js";
import { hash } from "../domain/hash.js";
import { environmentIdentity, executableIdentity, proofKey, } from "../evidence/key.js";
import { Git, isInside } from "../execution/git.js";
import { environment, expandCommand, redact, runProcess, } from "../execution/process.js";
import { guidanceAudit } from "../knowledge/catalog.js";
import { inspectRepository } from "../knowledge/repository.js";
import { focusedIntelligence } from "../knowledge/focus.js";
import { Store } from "../persistence/store.js";
import { assertScope, classify, matches, planGates, requiredApprovals, validateDag, } from "../policy/policy.js";
import { failureExcerpt, failureFingerprint, MAX_DIAGNOSTIC_CHARS, } from "./diagnostic.js";
import { schedule, success } from "./scheduler.js";
/**
 * An agent that stops without a usable outcome — turn or budget limit of the provider, timeout, unreadable
 * output — has usually already written files in its workspace. Those failures keep the run interrupted, so
 * the operator can inspect that work and adopt it with an explicit `--accept-current`, or discard it with a
 * new attempt. Throwing it away silently made the work be paid for twice.
 */
const SALVAGEABLE_AGENT_ERRORS = new Set(["AGENT", "AGENT_OUTPUT", "BUDGET", "COST_BUDGET", "MODEL_SELECTION", "MODEL_CLI", "MODEL_CHECK", "MODEL_AUTH", "MODEL_EFFORT", "MODEL_UNAVAILABLE"]);
export class Pipeline {
    store;
    constructor(stateDir) {
        this.store = new Store(stateDir);
    }
    close() {
        this.store.close();
    }
    hooks(runId) {
        const ids = new Map();
        return {
            onStart: (pid) => {
                ids.set(pid, this.store.startChild(runId, pid));
            },
            onFinish: (pid) => {
                const id = ids.get(pid);
                if (id) {
                    this.store.finishChild(id);
                    ids.delete(pid);
                }
            },
        };
    }
    async create(options) {
        const task = taskSchema.parse(options.task);
        const config = validateConfig(options.config);
        validateDag(config.gates);
        for (const path of [
            ...task.allowedPaths,
            ...task.allowedNewPaths,
            ...config.risk.fastPaths,
            ...config.risk.highPaths,
            ...config.gates.flatMap((g) => [...g.paths, ...g.testPaths]),
            ...config.validationRules.flatMap(r => r.paths),
        ])
            matches("probe", path);
        const git = new Git();
        const repo = await git.root(options.repo);
        invariant(!isInside(repo, this.store.root) && !isInside(this.store.root, repo), "STATE_PATH", "State and source repository must be disjoint directories");
        await git.clean(repo);
        const baseSha = await git.sha(repo, options.baseRef ?? "HEAD");
        await git.compatible(repo, baseSha);
        const id = randomUUID();
        const now = Date.now();
        const parent = join(this.store.root, "workspaces", id);
        const run = {
            id,
            version: 0,
            state: "created",
            resumeFrom: null,
            task,
            config,
            configHash: hash(config),
            repo,
            baseSha,
            ...(options.specId ? { specId: options.specId } : {}),
            workspace: join(parent, "agent"),
            validationWorkspace: join(parent, "validation"),
            candidateSha: null,
            changeSet: null,
            risk: null,
            gateIds: [],
            receipts: [],
            approvals: [],
            createdAt: now,
            updatedAt: now,
            validatedAt: null,
            sessionStartedAt: null,
            remainingMs: config.maxRunMs,
            metrics: {
                activeMs: 0,
                preparationMs: 0,
                agentMs: 0,
                validationMs: 0,
                cacheHits: 0,
                repairAttempts: 0,
            },
            summary: "",
            error: null,
        };
        this.store.create(run);
        return run;
    }
    /** Validate an already materialized commit, without calling the implementation agent.
     * Used for baseline diagnosis and final, aggregate spec validation. It never asserts approval. */
    async createValidation(options, candidateRef, allowEmpty = false) {
        const run = await this.create(options);
        const git = new Git();
        try {
            const sha = await git.sha(run.repo, candidateRef);
            await git.exec(run.repo, [
                "merge-base",
                "--is-ancestor",
                run.baseSha,
                sha,
            ]);
            await git.compatible(run.repo, sha);
            const changes = await git.changes(run.repo, run.baseSha, sha);
            invariant(allowEmpty || changes.files.length > 0, "NO_CHANGE", "No effective candidate change");
            const autoNew = assertScope(changes, run.task);
            if (autoNew.length)
                this.store.save(run, "scope.auto_expanded", {
                    files: autoNew,
                    policy: "new-supporting-files",
                });
            run.candidateSha = sha;
            run.changeSet = changes;
            run.risk = classify(changes, run.config, run.task.minimumLane);
            run.gateIds = planGates(run.config, changes, run.risk.lane).map((g) => g.id);
            // A validation-only attempt has no agent to re-run on a gate failure.
            invariant(run.config.maxRepairAttempts === 0, "CONFIG", "Validation-only runs require maxRepairAttempts=0");
            run.state = "candidate";
            run.summary = "Existing candidate; no implementation agent invoked.";
            this.store.save(run, "candidate.imported", {
                candidateSha: sha,
                allowEmpty,
            });
            return run;
        }
        catch (error) {
            transition(run, "failed");
            run.error = { code: "CANDIDATE_IMPORT", message: errorMessage(error) };
            this.store.save(run, "candidate.import_failed");
            throw error;
        }
    }
    /**
     * Why a validation of `options` could not adopt the proof already produced by `sourceId`, or null when it
     * can. Adoption is deliberately narrow: same base, candidate, change set and risk lane; the same gate plan
     * (commands, environment variables, dependencies, setup); the same environment identity measured now; and
     * fresh, verified evidence on the source. Anything else must be validated again.
     */
    async adoptionRefusal(options, sourceId) {
        const source = this.store.get(sourceId);
        if (!["ready", "awaiting_review"].includes(source.state) ||
            !source.candidateSha ||
            !source.risk ||
            !source.changeSet)
            return "source run is not validated";
        try {
            await this.evidenceReady(source, source.candidateSha);
        }
        catch (error) {
            return `source evidence is not usable: ${errorMessage(error)}`;
        }
        const config = validateConfig(options.config);
        const git = new Git();
        const base = await git.sha(options.repo, options.baseRef ?? "HEAD");
        if (base !== source.baseSha)
            return "base differs";
        const changes = await git.changes(options.repo, source.baseSha, source.candidateSha);
        if (hash(changes) !== hash(source.changeSet))
            return "change set differs";
        const lane = classify(changes, config, taskSchema.parse(options.task).minimumLane).lane;
        if (lane !== source.risk.lane)
            return `risk lane differs (${lane} vs ${source.risk.lane})`;
        const shape = (g) => ({
            id: g.id,
            command: g.command,
            passEnv: g.passEnv,
            dependsOn: g.dependsOn,
            outputs: g.outputs,
        });
        const plan = planGates(config, changes, lane);
        if (hash(plan.map(shape)) !==
            hash(planGates(source.config, source.changeSet, source.risk.lane).map(shape)))
            return "gate plan differs";
        if (hash(config.setup) !== hash(source.config.setup) ||
            config.executionMode !== source.config.executionMode ||
            config.environment.id !== source.config.environment.id)
            return "setup or environment differs";
        if (!plan.every((g) => source.receipts.some((r) => r.gateId === g.id && success(r))))
            return "source does not prove every planned gate";
        return null;
    }
    /**
     * Validation run that adopts the receipts of `sourceId` instead of replaying its gates. Each adopted receipt
     * is `cached` with `reusedFrom`, bound to this run's identity, and keeps the source validation time: adoption
     * never extends freshness. The run keeps its own review requirement.
     */
    async adoptValidation(options, sourceId) {
        const refusal = await this.adoptionRefusal(options, sourceId);
        invariant(refusal === null, "ADOPTION", `Proof cannot be adopted: ${refusal}`);
        const source = this.store.get(sourceId);
        const run = await this.createValidation({ ...options, baseRef: source.baseSha }, source.candidateSha);
        const token = this.store.acquire(run.id);
        try {
            const candidate = run.candidateSha;
            const git = new Git();
            await git.workspace(run.repo, run.workspace, candidate);
            await git.clean(run.workspace, candidate);
            const plan = planGates(run.config, run.changeSet, run.risk.lane);
            transition(run, "validating");
            run.receipts = [];
            run.approvals = [];
            run.gateIds = plan.map((g) => g.id);
            const adopted = new Map();
            for (const gate of plan) {
                const original = source.receipts.find((r) => r.gateId === gate.id && success(r));
                const env = environment([
                    ...run.config.environment.passEnv,
                    ...gate.passEnv,
                ]);
                const command = expandCommand(gate.command, {
                    baseSha: run.baseSha,
                    candidateSha: candidate,
                    workspace: run.validationWorkspace,
                });
                const executable = await executableIdentity(command[0], run.workspace, env);
                const environmentHash = environmentIdentity(run.config.environment.id, env, {
                    setup: run.config.setup,
                    executionMode: run.config.executionMode,
                    executable,
                });
                invariant(environmentHash === original.environmentHash, "ADOPTION", `Environment of gate ${gate.id} changed since it was proven`);
                const key = proofKey({
                    repository: run.repo,
                    baseSha: run.baseSha,
                    candidateSha: candidate,
                    taskHash: hash(run.task),
                    configHash: run.configHash,
                    environmentHash,
                    workspace: run.validationWorkspace,
                    gate: { ...gate, command },
                    dependencyKeys: gate.dependsOn.map((d) => adopted.get(d).key),
                    executable,
                });
                const receipt = {
                    ...original,
                    id: randomUUID(),
                    runId: run.id,
                    key,
                    configHash: run.configHash,
                    status: "cached",
                    startedAt: Date.now(),
                    durationMs: 0,
                    diagnostic: "",
                    reusedFrom: original.id,
                };
                this.store.addReceipt(receipt);
                adopted.set(gate.id, receipt);
                run.receipts.push(receipt);
                run.metrics.cacheHits++;
            }
            run.validatedAt = source.validatedAt;
            try {
                await this.evidenceReady(run, candidate);
            }
            catch (error) {
                transition(run, "failed");
                run.error = { code: "ADOPTION", message: errorMessage(error) };
                this.store.save(run, "validation.adoption_failed");
                throw error;
            }
            const required = run.task.reviewRequired
                ? requiredApprovals(run.risk.lane, run.config.workflow.reviewMode)
                : 0;
            transition(run, required > 0 ? "awaiting_review" : "ready");
            this.store.save(run, "validation.adopted", {
                sourceRunId: source.id,
                candidateSha: candidate,
                requiredApprovals: required,
                receipts: run.receipts.map((r) => ({
                    gateId: r.gateId,
                    reusedFrom: r.reusedFrom,
                })),
            });
            return run;
        }
        finally {
            this.store.release(run.id, token);
        }
    }
    /** Internal composition boundary: verifies evidence but does NOT approve or export a run. */
    async assertValidated(id) {
        const run = this.store.get(id);
        invariant(["awaiting_review", "ready"].includes(run.state) && run.candidateSha, "EVIDENCE", "Candidate is not validated");
        return this.evidenceReady(run, run.candidateSha);
    }
    async start(options, execution = {}) {
        return this.execute((await this.create(options)).id, execution);
    }
    async session(id, options, revalidate) {
        const token = this.store.acquire(id);
        let run;
        let executionToken = null;
        try {
            run = this.store.get(id);
            invariant(run.sessionStartedAt === null, "RECOVERY", "Previous session did not close; use recover before resume");
            if (!revalidate &&
                (run.state === "ready" || run.state === "awaiting_review"))
                return run;
            if (revalidate)
                invariant(run.state === "ready" || run.state === "awaiting_review", "STATE", "Only completed validations can be revalidated");
            else
                invariant(!["failed", "rejected"].includes(run.state), "STATE", "Terminal run: create a new attempt instead of erasing the failure");
            if (run.state === "interrupted" && run.resumeFrom === "implementing") {
                invariant(options.acceptCurrentCandidate, "UNKNOWN_AGENT_OUTCOME", "Agent was interrupted. Inspect its workspace; resume --accept-current explicitly snapshots it without relaunching the agent");
            }
            invariant(run.remainingMs > 0, "BUDGET", "Run budget exhausted; create an explicitly authorized new attempt");
            executionToken = this.store.acquireExecution(id);
            const start = performance.now();
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new Error("Run budget exhausted")), run.remainingMs);
            const signal = options.signal
                ? AbortSignal.any([controller.signal, options.signal])
                : controller.signal;
            const hooks = this.hooks(id);
            const git = new Git(signal, hooks);
            run.sessionStartedAt = Date.now();
            try {
                this.store.save(run, "session.started", {
                    remainingMs: run.remainingMs,
                });
                if (revalidate) {
                    transition(run, "validating");
                    run.approvals = [];
                    run.validatedAt = null;
                    run.error = null;
                    this.store.save(run, "validation.requested");
                }
                await this.drive(run, git, signal, hooks, revalidate, options.acceptCost ?? false);
            }
            catch (error) {
                const cancelled = signal.aborted ||
                    (error instanceof PipelineError && error.code === "CANCELLED");
                const previous = run.state;
                const salvageable = !cancelled &&
                    previous === "implementing" &&
                    error instanceof PipelineError &&
                    SALVAGEABLE_AGENT_ERRORS.has(error.code);
                if (cancelled || salvageable) {
                    run.resumeFrom = previous;
                    if (run.state !== "interrupted")
                        transition(run, "interrupted");
                }
                else if (run.state !== "failed")
                    transition(run, "failed");
                run.error = {
                    code: controller.signal.aborted
                        ? "BUDGET"
                        : cancelled
                            ? "CANCELLED"
                            : error instanceof PipelineError
                                ? error.code
                                : "INTERNAL",
                    message: errorMessage(error),
                };
                this.store.save(run, cancelled || salvageable ? "run.interrupted" : "run.failed", {
                    error: run.error,
                    workspace: salvageable ? run.workspace : undefined,
                });
            }
            finally {
                clearTimeout(timer);
                const elapsed = Math.round((performance.now() - start) * 1000) / 1000;
                run.remainingMs = Math.max(0, run.remainingMs - elapsed);
                run.metrics.activeMs += elapsed;
                run.sessionStartedAt = null;
                this.store.save(run, "session.finished", {
                    durationMs: elapsed,
                    remainingMs: run.remainingMs,
                });
            }
            return run;
        }
        finally {
            if (executionToken)
                this.store.releaseExecution(id, executionToken);
            this.store.release(id, token);
        }
    }
    execute(id, options = {}) {
        return this.session(id, options, false);
    }
    revalidate(id, options = {}) {
        return this.session(id, options, true);
    }
    async drive(run, git, signal, hooks, revalidate, acceptCost = false) {
        if (run.state === "interrupted") {
            if (run.resumeFrom === "implementing") {
                await this.capture(run, git); // Explicit adoption, never blind replay of an agent.
            }
            else {
                const next = run.candidateSha ? "validating" : "preparing";
                transition(run, next);
                this.store.save(run, "run.resumed", { from: run.resumeFrom });
            }
            run.resumeFrom = null;
            run.error = null;
        }
        if (run.state === "created" || run.state === "preparing") {
            const start = performance.now();
            if (run.state === "created")
                transition(run, "preparing");
            this.store.save(run, "workspace.preparing");
            try {
                await git.workspace(run.repo, run.workspace, run.baseSha);
                await this.setup(run, run.workspace, signal, hooks);
                await git.clean(run.workspace, run.baseSha);
            }
            finally {
                run.metrics.preparationMs += performance.now() - start;
            }
            transition(run, "implementing");
            this.store.save(run, "agent.started");
            await this.implement(run, git, signal, hooks, [], acceptCost);
        }
        invariant(run.state === "candidate" || run.state === "validating", "STATE", `Unexpected executable state ${run.state}`);
        // What the checks reproached, to tell a repair that fixed something from one that is going in circles.
        let previousFailures = null;
        for (;;) {
            invariant(!signal.aborted, "CANCELLED", "Execution cancelled before validation");
            const passed = await this.validate(run, git, signal, hooks);
            if (passed)
                return;
            const repairable = run.receipts.some((r) => r.status === "failed") &&
                run.receipts.every((r) => ["passed", "cached", "failed", "blocked", "cancelled"].includes(r.status));
            const failureSignature = hash(run.receipts
                .filter((r) => r.status === "failed")
                .map((r) => ({
                gateId: r.gateId,
                reproach: failureFingerprint(r.diagnostic),
            })));
            if (previousFailures === failureSignature) {
                this.store.save(run, "agent.repair_no_progress", {
                    number: run.metrics.repairAttempts,
                });
                throw new PipelineError("REPAIR_NO_PROGRESS", "The repair changed the candidate but the checks fail exactly as before; the remaining repair attempts are not spent. Read the diagnostics: the fix may need a file outside the task scope or information the agent does not have.");
            }
            previousFailures = failureSignature;
            if (revalidate ||
                !repairable ||
                run.metrics.repairAttempts >= run.config.maxRepairAttempts) {
                throw new PipelineError("GATES_FAILED", "Required checks failed; diagnostics and the candidate are retained");
            }
            invariant(!signal.aborted, "CANCELLED", "Execution cancelled before repair");
            run.metrics.repairAttempts++;
            const failures = run.receipts;
            const previousCandidate = run.candidateSha;
            transition(run, "implementing");
            this.store.save(run, "agent.repair_started", {
                number: run.metrics.repairAttempts,
            });
            await this.implement(run, git, signal, hooks, failures, acceptCost);
            if (run.candidateSha === previousCandidate) {
                this.store.save(run, "agent.repair_no_change", {
                    number: run.metrics.repairAttempts,
                    candidateSha: run.candidateSha,
                });
                throw new PipelineError("REPAIR_NO_CHANGE", "The repair attempt changed nothing; the same failing candidate is retained without re-running checks. Inspect the gate diagnostics: the fix may need a file outside the task scope or information the agent did not have.");
            }
        }
    }
    async implement(run, git, signal, hooks, failures, acceptCost = false) {
        const start = performance.now();
        try {
            const contextKey = hash({ sha: run.baseSha, task: run.task, knowledge: run.config.knowledge });
            const saved = failures.length ? this.store.events(run.id).filter(e => e.type === 'agent.context').at(-1)?.data : undefined;
            const intelligence = saved?.key === contextKey ? saved.intelligence : await inspectRepository(run.repo, run.baseSha, `${run.task.title}\n${run.task.description}\n${run.task.acceptance.join("\n")}`, {
                signal,
                languages: run.config.knowledge?.languages ?? [],
                focusPaths: run.task.allowedPaths,
            });
            const repositoryIntelligence = run.config.workflow.planningMode === 'adaptive' ? focusedIntelligence(intelligence, run.task.allowedPaths) : intelligence;
            if (saved?.key === contextKey)
                this.store.save(run, 'agent.context_reused', { key: contextKey });
            else
                this.store.save(run, 'agent.context', { key: contextKey, intelligence: repositoryIntelligence });
            const request = requestFor(run.task, run.baseSha, run.workspace, failures, run.config.skills, repositoryIntelligence);
            this.store.save(run, "agent.guidance", {
                ...guidanceAudit(request.guidance),
                provider: run.config.agent.type,
                repositoryIntelligence: {
                    sha: repositoryIntelligence.sha,
                    fileCount: repositoryIntelligence.fileCount,
                    relevantFiles: repositoryIntelligence.relevantFiles,
                    reuseCandidates: repositoryIntelligence.reuseCandidates.map((x) => ({
                        name: x.name,
                        kind: x.kind,
                        path: x.path,
                        line: x.line,
                        score: x.score,
                    })),
                },
            });
            const choice = modelChoice(run.config, 'implementer', run.risk?.lane ?? run.task.minimumLane);
            this.store.save(run, 'model.selected', { role: choice.role, lane: choice.lane, source: choice.source, reason: choice.reason });
            let effective = budgetedAgent(this.store, run.specId, choice.agent, acceptCost, 'implementer');
            const reserve = Math.min(run.config.validationReserveMs ?? 0, run.config.maxRunMs / 5);
            const beforeProbe = Math.min(remainingSpecMs(this.store, run.specId), run.remainingMs - Math.max(0, Date.now() - (run.sessionStartedAt ?? Date.now())));
            invariant(beforeProbe > reserve, "BUDGET", "Insufficient time for model preflight and the reserved final checks");
            await ensureModelReady({ ...effective, timeoutMs: Math.max(1, Math.min(effective.timeoutMs, beforeProbe - reserve)) }, { store: this.store, owner: { kind: 'run', id: run.id }, env: environment([...run.config.environment.passEnv, ...effective.passEnv]), cwd: run.workspace, signal, hooks });
            effective = budgetedAgent(this.store, run.specId, choice.agent, acceptCost, 'implementer');
            const available = Math.min(remainingSpecMs(this.store, run.specId), run.remainingMs - Math.max(0, Date.now() - (run.sessionStartedAt ?? Date.now())));
            invariant(available > reserve, "BUDGET", "Insufficient time for another agent session and the reserved final checks");
            const agent = { ...effective, timeoutMs: Math.max(1, Math.min(effective.timeoutMs, available - reserve)) };
            const answer = await runAgent({ ...run.config, agent }, request, join(this.store.root, "outputs", run.id), signal, hooks, { store: this.store, runId: run.id });
            run.summary = agentOutputSchema.parse({
                summary: answer.summary,
            }).summary;
            // Declared by the provider, never measured here: shown to the operator, and summed per spec.
            if (answer.usage) {
                run.metrics.costUsd =
                    (run.metrics.costUsd ?? 0) + (answer.usage.costUsd ?? 0);
                run.metrics.providerTurns =
                    (run.metrics.providerTurns ?? 0) + (answer.usage.turns ?? 0);
                this.store.save(run, "agent.usage", {
                    ...answer.usage,
                    declaredByProvider: true,
                });
            }
        }
        finally {
            run.metrics.agentMs += performance.now() - start;
        }
        invariant(!signal.aborted, "CANCELLED", "Agent interrupted");
        await this.capture(run, git);
    }
    async capture(run, git) {
        const start = performance.now();
        try {
            const candidate = await git.snapshot(run.workspace, run.baseSha, run.id, run.task.title);
            const changes = await git.changes(run.workspace, run.baseSha, candidate);
            // Retain the immutable candidate/change-set even when scope validation fails so an explicit scope amendment can adopt it later.
            run.candidateSha = candidate;
            run.changeSet = changes;
            this.store.save(run, "candidate.observed", {
                candidateSha: candidate,
                files: changes.files,
            });
            const autoNew = assertScope(changes, run.task);
            if (autoNew.length)
                this.store.save(run, "scope.auto_expanded", {
                    files: autoNew,
                    policy: "new-supporting-files",
                });
            const minimum = run.risk?.lane === "high"
                ? "high"
                : run.risk?.lane === "standard" && run.task.minimumLane === "fast"
                    ? "standard"
                    : run.task.minimumLane;
            const risk = classify(changes, run.config, minimum);
            const plan = planGates(run.config, changes, risk.lane);
            run.candidateSha = candidate;
            run.changeSet = changes;
            run.risk = risk;
            run.gateIds = plan.map((g) => g.id);
            run.receipts = [];
            run.approvals = [];
            run.validatedAt = null;
            transition(run, "candidate");
            this.store.save(run, "candidate.created", {
                candidateSha: candidate,
                files: changes.files,
                risk,
                gateIds: run.gateIds,
            });
        }
        finally {
            run.metrics.preparationMs += performance.now() - start;
        }
    }
    async setup(run, workspace, signal, hooks) {
        for (let i = 0; i < run.config.setup.length; i++) {
            const spec = run.config.setup[i];
            const env = environment([
                ...run.config.environment.passEnv,
                ...spec.passEnv,
            ]);
            const result = await runProcess({
                ...spec,
                command: expandCommand(spec.command, {
                    baseSha: run.baseSha,
                    candidateSha: run.candidateSha ?? run.baseSha,
                    workspace,
                }),
                cwd: workspace,
                env,
                signal,
                ...hooks,
            });
            this.store.event(run.id, "setup.finished", {
                index: i,
                status: result.status,
                durationMs: result.durationMs,
                workspace: workspace === run.workspace ? "agent" : "validation",
            });
            invariant(result.status === "passed", result.status === "cancelled" ? "CANCELLED" : "SETUP", `Setup ${i} ${result.status}: ${redact(result.stderr.slice(-4000), env)}`);
        }
    }
    async validate(run, git, signal, hooks) {
        const start = performance.now();
        try {
            invariant(run.candidateSha && run.changeSet && run.risk, "CANDIDATE", "Missing candidate");
            const candidate = run.candidateSha;
            await git.workspace(run.repo, run.workspace, candidate);
            await git.clean(run.workspace, candidate);
            const observed = await git.changes(run.workspace, run.baseSha, candidate);
            assertScope(observed, run.task);
            invariant(hash(observed) === hash(run.changeSet), "CANDIDATE", "Observed diff changed");
            const plan = planGates(run.config, observed, run.risk.lane);
            if (run.state !== "validating")
                transition(run, "validating");
            run.receipts = [];
            run.approvals = [];
            run.validatedAt = null;
            run.gateIds = plan.map((g) => g.id);
            this.store.save(run, "validation.started", { gateIds: run.gateIds });
            // Clean materialization, not a copy of agent-mutated node_modules/builds.
            mkdirSync(join(this.store.root, "workspaces"), {
                recursive: true,
                mode: 0o700,
            });
            await git.removeWorkspace(run.repo, run.validationWorkspace, join(this.store.root, "workspaces"));
            await git.workspace(run.repo, run.validationWorkspace, candidate);
            await this.setup(run, run.validationWorkspace, signal, hooks);
            await git.clean(run.validationWorkspace, candidate);
            const receipts = new Map();
            const identities = new Map();
            const execute = async (gate, gateSignal) => {
                const startedAt = Date.now();
                const elapsedStart = performance.now();
                const env = environment([
                    ...run.config.environment.passEnv,
                    ...gate.passEnv,
                ]);
                const command = expandCommand(gate.command, {
                    baseSha: run.baseSha,
                    candidateSha: candidate,
                    workspace: run.validationWorkspace,
                });
                const identityKey = hash({ command: command[0], env });
                if (!identities.has(identityKey))
                    identities.set(identityKey, executableIdentity(command[0], run.validationWorkspace, env));
                const executable = await identities.get(identityKey);
                const environmentHash = environmentIdentity(run.config.environment.id, env, {
                    setup: run.config.setup,
                    executionMode: run.config.executionMode,
                    executable,
                    // Same executable / PATH is not an attestation of every external service.
                });
                const key = proofKey({
                    repository: run.repo,
                    baseSha: run.baseSha,
                    candidateSha: candidate,
                    taskHash: hash(run.task),
                    configHash: run.configHash,
                    environmentHash,
                    workspace: run.validationWorkspace,
                    gate: { ...gate, command },
                    dependencyKeys: gate.dependsOn.map((d) => receipts.get(d).key),
                    executable,
                });
                const previous = gate.cacheTtlMs > 0 ? this.store.cached(key) : null;
                let receipt;
                if (previous) {
                    receipt = {
                        ...previous,
                        id: randomUUID(),
                        runId: run.id,
                        status: "cached",
                        startedAt,
                        durationMs: performance.now() - elapsedStart,
                        reusedFrom: previous.id,
                        diagnostic: "",
                    };
                    run.metrics.cacheHits++;
                }
                else {
                    this.store.event(run.id, "gate.started", { gateId: gate.id, key });
                    const result = await runProcess({
                        command,
                        cwd: run.validationWorkspace,
                        env,
                        timeoutMs: gate.timeoutMs,
                        signal: gateSignal,
                        ...hooks,
                        maxOutputBytes: 1024 * 1024,
                    });
                    receipt = {
                        id: randomUUID(),
                        runId: run.id,
                        gateId: gate.id,
                        key,
                        candidateSha: candidate,
                        configHash: run.configHash,
                        environmentHash,
                        status: result.status,
                        startedAt,
                        durationMs: performance.now() - elapsedStart,
                        exitCode: result.exitCode,
                        stdoutHash: result.stdoutHash,
                        stderrHash: result.stderrHash,
                        diagnostic: result.status === "passed"
                            ? ""
                            : redact(failureExcerpt(result.status, result.stderr, result.stdout), env).slice(0, MAX_DIAGNOSTIC_CHARS),
                        reusedFrom: null,
                    };
                }
                this.store.addReceipt(receipt);
                receipts.set(gate.id, receipt);
                return receipt;
            };
            run.receipts = await schedule(plan, {
                concurrency: run.config.concurrency,
                failFast: run.config.failFast,
                signal,
                execute,
                blocked: (gate, reason) => {
                    const receipt = {
                        id: randomUUID(),
                        runId: run.id,
                        gateId: gate.id,
                        key: hash({ blocked: gate.id, candidate }),
                        candidateSha: candidate,
                        configHash: run.configHash,
                        environmentHash: hash("not-executed"),
                        status: "blocked",
                        startedAt: Date.now(),
                        durationMs: 0,
                        exitCode: null,
                        stdoutHash: "",
                        stderrHash: "",
                        diagnostic: reason,
                        reusedFrom: null,
                    };
                    this.store.addReceipt(receipt);
                    return receipt;
                },
            });
            // Do NOT seal successful individual gates until the batch is quiescent and
            // both workspaces still correspond to the immutable candidate.
            await git.clean(run.validationWorkspace, candidate);
            await git.clean(run.workspace, candidate);
            invariant(!signal.aborted, "CANCELLED", "Validation interrupted");
            for (const receipt of run.receipts)
                this.store.seal(receipt, plan.find((g) => g.id === receipt.gateId).cacheTtlMs);
            if (!run.receipts.every(success)) {
                this.store.save(run, "validation.failed");
                return false;
            }
            assertRequiredEvidence(requiredEvidence(run));
            run.validatedAt = Date.now();
            const required = run.task.reviewRequired
                ? requiredApprovals(run.risk.lane, run.config.workflow.reviewMode)
                : 0;
            transition(run, required > 0 ? "awaiting_review" : "ready");
            this.store.save(run, "validation.completed", {
                candidateSha: candidate,
                requiredApprovals: required,
                cacheHits: run.receipts.filter((r) => r.status === "cached").length,
            });
            return true;
        }
        finally {
            run.metrics.validationMs += performance.now() - start;
        }
    }
    recover(id, confirmStopped) {
        this.store.recover(id, confirmStopped);
        const token = this.store.acquire(id);
        try {
            const run = this.store.get(id);
            if (run.sessionStartedAt !== null) {
                const elapsed = Math.max(0, Date.now() - run.sessionStartedAt);
                run.remainingMs = Math.max(0, run.remainingMs - elapsed);
                run.metrics.activeMs += elapsed;
                run.sessionStartedAt = null;
            }
            if (![
                "failed",
                "rejected",
                "ready",
                "awaiting_review",
                "interrupted",
            ].includes(run.state)) {
                run.resumeFrom = run.state;
                transition(run, "interrupted");
            }
            this.store.save(run, "run.recovered", {
                budgetAccounting: "Crash interval charged conservatively until recovery",
            });
            return run;
        }
        finally {
            this.store.release(id, token);
        }
    }
    async evidenceReady(run, sha) {
        invariant(run.candidateSha === sha && /^[a-f0-9]{40,64}$/.test(sha), "APPROVAL_SHA", "Approval/export must name the exact candidate SHA");
        invariant(run.validatedAt !== null &&
            Date.now() - run.validatedAt <= run.config.validationMaxAgeMs, "STALE_EVIDENCE", "Validation expired; revalidate before approval/export");
        invariant(run.receipts.length > 0 &&
            run.receipts.length === run.gateIds.length &&
            run.gateIds.every((id) => run.receipts.some((r) => r.gateId === id &&
                r.candidateSha === sha &&
                r.configHash === run.configHash &&
                success(r))), "EVIDENCE", "Required receipts are missing or mismatched");
        for (const receipt of run.receipts)
            this.store.verifyReceipt(receipt);
        assertRequiredEvidence(requiredEvidence(run));
        const git = new Git();
        await git.clean(run.workspace, sha);
        const observed = await git.changes(run.workspace, run.baseSha, sha);
        invariant(run.risk && hash(observed) === hash(run.changeSet), "EVIDENCE", "Observed changes do not match the validation");
        assertScope(observed, run.task);
        const risk = classify(observed, run.config, run.risk.lane);
        invariant(risk.lane === run.risk.lane, "RISK", "Risk cannot be downgraded after validation");
        const expected = planGates(run.config, observed, risk.lane).map((g) => g.id);
        invariant(hash(expected) === hash(run.gateIds), "EVIDENCE", "Validation does not cover the required gate plan");
        return hash({
            sha,
            configHash: run.configHash,
            gateIds: run.gateIds,
            receipts: run.receipts.map((r) => r.id),
            validatedAt: run.validatedAt,
        });
    }
    async approve(id, candidateSha, reviewer, note) {
        const token = this.store.acquire(id);
        try {
            const run = this.store.get(id);
            invariant(run.state === "awaiting_review" && run.risk, "STATE", "Run is not awaiting review");
            const evidenceHash = await this.evidenceReady(run, candidateSha);
            const identity = reviewer.trim().toLocaleLowerCase("en-US");
            invariant(identity.length >= 3 &&
                identity.length <= 120 &&
                note.trim().length >= 10 &&
                note.length <= 4000, "REVIEW", "A reviewer name and meaningful note are required");
            invariant(!run.approvals.some((a) => a.reviewer.toLocaleLowerCase("en-US") === identity), "REVIEW", "Same reviewer cannot approve twice");
            run.approvals.push({
                reviewer: reviewer.trim(),
                note: note.trim(),
                candidateSha,
                evidenceHash,
                at: Date.now(),
            });
            if (run.approvals.length >=
                (run.task.reviewRequired
                    ? requiredApprovals(run.risk.lane, run.config.workflow.reviewMode)
                    : 0))
                transition(run, "ready");
            this.store.save(run, "review.approved", {
                reviewer: reviewer.trim(),
                candidateSha,
                evidenceHash,
            });
            return run;
        }
        finally {
            this.store.release(id, token);
        }
    }
    invalidateApprovals(id, reason) {
        const token = this.store.acquire(id);
        try {
            const run = this.store.get(id);
            invariant(["ready", "awaiting_review"].includes(run.state) && run.risk, "STATE", "No completed validation to invalidate review");
            run.approvals = [];
            run.state =
                run.task.reviewRequired &&
                    requiredApprovals(run.risk.lane, run.config.workflow.reviewMode) > 0
                    ? "awaiting_review"
                    : "ready";
            this.store.save(run, "review.invalidated", { reason });
            return run;
        }
        finally {
            this.store.release(id, token);
        }
    }
    reject(id, note) {
        const token = this.store.acquire(id);
        try {
            const run = this.store.get(id);
            invariant(run.state === "awaiting_review", "STATE", "Run is not awaiting review");
            invariant(note.trim().length >= 10, "REVIEW", "A rejection reason is required");
            transition(run, "rejected");
            run.error = { code: "REJECTED", message: note.trim() };
            this.store.save(run, "review.rejected");
            return run;
        }
        finally {
            this.store.release(id, token);
        }
    }
    async exportPatch(id) {
        const token = this.store.acquire(id);
        try {
            const run = this.store.get(id);
            invariant(run.state === "ready" && run.candidateSha, "STATE", "Only ready runs may be exported");
            const evidenceHash = await this.evidenceReady(run, run.candidateSha);
            const approved = new Set(run.approvals
                .filter((a) => a.candidateSha === run.candidateSha &&
                a.evidenceHash === evidenceHash)
                .map((a) => a.reviewer.toLocaleLowerCase("en-US")));
            invariant(run.risk, "RISK", "Missing validated risk decision");
            const required = run.task.reviewRequired
                ? requiredApprovals(run.risk.lane, run.config.workflow.reviewMode)
                : 0;
            invariant(approved.size >= required, "REVIEW", "Required approvals do not cover the current evidence");
            const patch = await new Git().patch(run.workspace, run.baseSha, run.candidateSha);
            this.store.event(id, "patch.exported", {
                baseSha: run.baseSha,
                candidateSha: run.candidateSha,
            });
            return patch;
        }
        finally {
            this.store.release(id, token);
        }
    }
}
export function summarize(run) {
    return {
        id: run.id,
        task: run.task.title,
        state: run.state,
        lane: run.risk?.lane ?? null,
        baseSha: run.baseSha,
        candidateSha: run.candidateSha,
        workspace: run.workspace,
        summary: run.summary,
        files: run.changeSet?.files ?? [],
        riskReasons: run.risk?.reasons ?? [],
        approvals: run.approvals.length,
        requiredApprovals: run.risk
            ? run.task.reviewRequired
                ? requiredApprovals(run.risk.lane, run.config.workflow.reviewMode)
                : 0
            : null,
        reviewRequired: run.task.reviewRequired,
        reviewMode: run.config.workflow.reviewMode,
        gates: run.receipts.map((r) => ({
            id: r.gateId,
            status: r.status,
            durationMs: Math.round(r.durationMs),
            diagnostic: r.diagnostic,
            reusedFrom: r.reusedFrom,
        })),
        metrics: {
            ...run.metrics,
            controllerExclusiveMs: Math.max(0, run.metrics.activeMs -
                run.metrics.preparationMs -
                run.metrics.agentMs -
                run.metrics.validationMs),
        },
        remainingMs: run.remainingMs,
        error: run.error,
    };
}
//# sourceMappingURL=pipeline.js.map