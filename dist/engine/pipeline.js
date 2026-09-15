import { guidanceAudit } from '../knowledge/catalog.js';
import { inspectRepository } from '../knowledge/repository.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { agentOutputSchema, taskSchema, validateConfig, transition } from '../domain/contracts.js';
import { hash } from '../domain/hash.js';
import { invariant, PipelineError, errorMessage } from '../domain/errors.js';
import { classify, planGates, assertScope, requiredApprovals, matches, validateDag } from '../policy/policy.js';
import { Store } from '../persistence/store.js';
import { Git, isInside } from '../execution/git.js';
import { environment, runProcess, redact, expandCommand } from '../execution/process.js';
import { runAgent, requestFor } from '../adapters/agent.js';
import { executableIdentity, environmentIdentity, proofKey } from '../evidence/key.js';
import { schedule, success } from './scheduler.js';
export class Pipeline {
    store;
    constructor(stateDir) { this.store = new Store(stateDir); }
    close() { this.store.close(); }
    hooks(runId) {
        const ids = new Map();
        return {
            onStart: pid => { ids.set(pid, this.store.startChild(runId, pid)); },
            onFinish: pid => { const id = ids.get(pid); if (id) {
                this.store.finishChild(id);
                ids.delete(pid);
            } },
        };
    }
    async create(options) {
        const task = taskSchema.parse(options.task);
        const config = validateConfig(options.config);
        validateDag(config.gates);
        for (const path of [...task.allowedPaths, ...task.allowedNewPaths, ...config.risk.fastPaths, ...config.risk.highPaths, ...config.gates.flatMap(g => g.paths)])
            matches('probe', path);
        const git = new Git();
        const repo = await git.root(options.repo);
        invariant(!isInside(repo, this.store.root) && !isInside(this.store.root, repo), 'STATE_PATH', 'State and source repository must be disjoint directories');
        await git.clean(repo);
        const baseSha = await git.sha(repo, options.baseRef ?? 'HEAD');
        await git.compatible(repo, baseSha);
        const id = randomUUID();
        const now = Date.now();
        const parent = join(this.store.root, 'workspaces', id);
        const run = {
            id, version: 0, state: 'created', resumeFrom: null,
            task, config, configHash: hash(config), repo, baseSha,
            workspace: join(parent, 'agent'), validationWorkspace: join(parent, 'validation'),
            candidateSha: null, changeSet: null, risk: null, gateIds: [], receipts: [], approvals: [],
            createdAt: now, updatedAt: now, validatedAt: null, sessionStartedAt: null, remainingMs: config.maxRunMs,
            metrics: { activeMs: 0, preparationMs: 0, agentMs: 0, validationMs: 0, cacheHits: 0, repairAttempts: 0 },
            summary: '', error: null,
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
            await git.exec(run.repo, ['merge-base', '--is-ancestor', run.baseSha, sha]);
            await git.compatible(run.repo, sha);
            const changes = await git.changes(run.repo, run.baseSha, sha);
            invariant(allowEmpty || changes.files.length > 0, 'NO_CHANGE', 'No effective candidate change');
            const autoNew = assertScope(changes, run.task);
            if (autoNew.length)
                this.store.save(run, 'scope.auto_expanded', { files: autoNew, policy: 'new-supporting-files' });
            run.candidateSha = sha;
            run.changeSet = changes;
            run.risk = classify(changes, run.config, run.task.minimumLane);
            run.gateIds = planGates(run.config, changes, run.risk.lane).map(g => g.id);
            // A validation-only attempt has no agent to re-run on a gate failure.
            invariant(run.config.maxRepairAttempts === 0, 'CONFIG', 'Validation-only runs require maxRepairAttempts=0');
            run.state = 'candidate';
            run.summary = 'Existing candidate; no implementation agent invoked.';
            this.store.save(run, 'candidate.imported', { candidateSha: sha, allowEmpty });
            return run;
        }
        catch (error) {
            transition(run, 'failed');
            run.error = { code: 'CANDIDATE_IMPORT', message: errorMessage(error) };
            this.store.save(run, 'candidate.import_failed');
            throw error;
        }
    }
    /** Internal composition boundary: verifies evidence but does NOT approve or export a run. */
    async assertValidated(id) {
        const run = this.store.get(id);
        invariant(['awaiting_review', 'ready'].includes(run.state) && run.candidateSha, 'EVIDENCE', 'Candidate is not validated');
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
            invariant(run.sessionStartedAt === null, 'RECOVERY', 'Previous session did not close; use recover before resume');
            if (!revalidate && (run.state === 'ready' || run.state === 'awaiting_review'))
                return run;
            if (revalidate)
                invariant(run.state === 'ready' || run.state === 'awaiting_review', 'STATE', 'Only completed validations can be revalidated');
            else
                invariant(!['failed', 'rejected'].includes(run.state), 'STATE', 'Terminal run: create a new attempt instead of erasing the failure');
            if (run.state === 'interrupted' && run.resumeFrom === 'implementing') {
                invariant(options.acceptCurrentCandidate, 'UNKNOWN_AGENT_OUTCOME', 'Agent was interrupted. Inspect its workspace; resume --accept-current explicitly snapshots it without relaunching the agent');
            }
            invariant(run.remainingMs > 0, 'BUDGET', 'Run budget exhausted; create an explicitly authorized new attempt');
            executionToken = this.store.acquireExecution(id);
            const start = performance.now();
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new Error('Run budget exhausted')), run.remainingMs);
            const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
            const hooks = this.hooks(id);
            const git = new Git(signal, hooks);
            run.sessionStartedAt = Date.now();
            try {
                this.store.save(run, 'session.started', { remainingMs: run.remainingMs });
                if (revalidate) {
                    transition(run, 'validating');
                    run.approvals = [];
                    run.validatedAt = null;
                    run.error = null;
                    this.store.save(run, 'validation.requested');
                }
                await this.drive(run, git, signal, hooks, revalidate);
            }
            catch (error) {
                const cancelled = signal.aborted || (error instanceof PipelineError && error.code === 'CANCELLED');
                const previous = run.state;
                if (cancelled) {
                    run.resumeFrom = previous;
                    if (run.state !== 'interrupted')
                        transition(run, 'interrupted');
                }
                else if (run.state !== 'failed')
                    transition(run, 'failed');
                run.error = { code: controller.signal.aborted ? 'BUDGET' : cancelled ? 'CANCELLED' : error instanceof PipelineError ? error.code : 'INTERNAL', message: errorMessage(error) };
                this.store.save(run, cancelled ? 'run.interrupted' : 'run.failed', { error: run.error });
            }
            finally {
                clearTimeout(timer);
                const elapsed = Math.round((performance.now() - start) * 1000) / 1000;
                run.remainingMs = Math.max(0, run.remainingMs - elapsed);
                run.metrics.activeMs += elapsed;
                run.sessionStartedAt = null;
                this.store.save(run, 'session.finished', { durationMs: elapsed, remainingMs: run.remainingMs });
            }
            return run;
        }
        finally {
            if (executionToken)
                this.store.releaseExecution(id, executionToken);
            this.store.release(id, token);
        }
    }
    execute(id, options = {}) { return this.session(id, options, false); }
    revalidate(id, options = {}) { return this.session(id, options, true); }
    async drive(run, git, signal, hooks, revalidate) {
        if (run.state === 'interrupted') {
            if (run.resumeFrom === 'implementing') {
                await this.capture(run, git); // Explicit adoption, never blind replay of an agent.
            }
            else {
                const next = run.candidateSha ? 'validating' : 'preparing';
                transition(run, next);
                this.store.save(run, 'run.resumed', { from: run.resumeFrom });
            }
            run.resumeFrom = null;
            run.error = null;
        }
        if (run.state === 'created' || run.state === 'preparing') {
            const start = performance.now();
            if (run.state === 'created')
                transition(run, 'preparing');
            this.store.save(run, 'workspace.preparing');
            try {
                await git.workspace(run.repo, run.workspace, run.baseSha);
                await this.setup(run, run.workspace, signal, hooks);
                await git.clean(run.workspace, run.baseSha);
            }
            finally {
                run.metrics.preparationMs += performance.now() - start;
            }
            transition(run, 'implementing');
            this.store.save(run, 'agent.started');
            await this.implement(run, git, signal, hooks, []);
        }
        invariant(run.state === 'candidate' || run.state === 'validating', 'STATE', `Unexpected executable state ${run.state}`);
        for (;;) {
            invariant(!signal.aborted, 'CANCELLED', 'Execution cancelled before validation');
            const passed = await this.validate(run, git, signal, hooks);
            if (passed)
                return;
            const repairable = run.receipts.some(r => r.status === 'failed') &&
                run.receipts.every(r => ['passed', 'cached', 'failed', 'blocked', 'cancelled'].includes(r.status));
            if (revalidate || !repairable || run.metrics.repairAttempts >= run.config.maxRepairAttempts) {
                throw new PipelineError('GATES_FAILED', 'Required checks failed; diagnostics and the candidate are retained');
            }
            invariant(!signal.aborted, 'CANCELLED', 'Execution cancelled before repair');
            run.metrics.repairAttempts++;
            const failures = run.receipts;
            transition(run, 'implementing');
            this.store.save(run, 'agent.repair_started', { number: run.metrics.repairAttempts });
            await this.implement(run, git, signal, hooks, failures);
        }
    }
    async implement(run, git, signal, hooks, failures) {
        const start = performance.now();
        try {
            const repositoryIntelligence = await inspectRepository(run.repo, run.baseSha, `${run.task.title}\n${run.task.description}\n${run.task.acceptance.join('\n')}`, { signal, languages: run.config.knowledge?.languages ?? [] });
            const request = requestFor(run.task, run.baseSha, run.workspace, failures, run.config.skills, repositoryIntelligence);
            this.store.save(run, 'agent.guidance', { ...guidanceAudit(request.guidance), provider: run.config.agent.type, repositoryIntelligence: { sha: repositoryIntelligence.sha, fileCount: repositoryIntelligence.fileCount, relevantFiles: repositoryIntelligence.relevantFiles, reuseCandidates: repositoryIntelligence.reuseCandidates.map(x => ({ name: x.name, kind: x.kind, path: x.path, line: x.line, score: x.score })) } });
            run.summary = agentOutputSchema.parse({ summary: await runAgent(run.config, request, join(this.store.root, 'outputs', run.id), signal, hooks) }).summary;
        }
        finally {
            run.metrics.agentMs += performance.now() - start;
        }
        invariant(!signal.aborted, 'CANCELLED', 'Agent interrupted');
        await this.capture(run, git);
    }
    async capture(run, git) {
        const start = performance.now();
        try {
            const candidate = await git.snapshot(run.workspace, run.baseSha, run.id);
            const changes = await git.changes(run.workspace, run.baseSha, candidate);
            // Retain the immutable candidate/change-set even when scope validation fails so an explicit scope amendment can adopt it later.
            run.candidateSha = candidate;
            run.changeSet = changes;
            this.store.save(run, 'candidate.observed', { candidateSha: candidate, files: changes.files });
            const autoNew = assertScope(changes, run.task);
            if (autoNew.length)
                this.store.save(run, 'scope.auto_expanded', { files: autoNew, policy: 'new-supporting-files' });
            const minimum = run.risk?.lane === 'high' ? 'high' : run.risk?.lane === 'standard' && run.task.minimumLane === 'fast' ? 'standard' : run.task.minimumLane;
            const risk = classify(changes, run.config, minimum);
            const plan = planGates(run.config, changes, risk.lane);
            run.candidateSha = candidate;
            run.changeSet = changes;
            run.risk = risk;
            run.gateIds = plan.map(g => g.id);
            run.receipts = [];
            run.approvals = [];
            run.validatedAt = null;
            transition(run, 'candidate');
            this.store.save(run, 'candidate.created', { candidateSha: candidate, files: changes.files, risk, gateIds: run.gateIds });
        }
        finally {
            run.metrics.preparationMs += performance.now() - start;
        }
    }
    async setup(run, workspace, signal, hooks) {
        for (let i = 0; i < run.config.setup.length; i++) {
            const spec = run.config.setup[i];
            const env = environment([...run.config.environment.passEnv, ...spec.passEnv]);
            const result = await runProcess({ ...spec, command: expandCommand(spec.command, { baseSha: run.baseSha, candidateSha: run.candidateSha ?? run.baseSha, workspace }), cwd: workspace, env, signal, ...hooks });
            this.store.event(run.id, 'setup.finished', { index: i, status: result.status, durationMs: result.durationMs, workspace: workspace === run.workspace ? 'agent' : 'validation' });
            invariant(result.status === 'passed', result.status === 'cancelled' ? 'CANCELLED' : 'SETUP', `Setup ${i} ${result.status}: ${redact(result.stderr.slice(-4000), env)}`);
        }
    }
    async validate(run, git, signal, hooks) {
        const start = performance.now();
        try {
            invariant(run.candidateSha && run.changeSet && run.risk, 'CANDIDATE', 'Missing candidate');
            const candidate = run.candidateSha;
            await git.workspace(run.repo, run.workspace, candidate);
            await git.clean(run.workspace, candidate);
            const observed = await git.changes(run.workspace, run.baseSha, candidate);
            assertScope(observed, run.task);
            invariant(hash(observed) === hash(run.changeSet), 'CANDIDATE', 'Observed diff changed');
            const plan = planGates(run.config, observed, run.risk.lane);
            if (run.state !== 'validating')
                transition(run, 'validating');
            run.receipts = [];
            run.approvals = [];
            run.validatedAt = null;
            run.gateIds = plan.map(g => g.id);
            this.store.save(run, 'validation.started', { gateIds: run.gateIds });
            // Clean materialization, not a copy of agent-mutated node_modules/builds.
            mkdirSync(join(this.store.root, 'workspaces'), { recursive: true, mode: 0o700 });
            await git.removeWorkspace(run.repo, run.validationWorkspace, join(this.store.root, 'workspaces'));
            await git.workspace(run.repo, run.validationWorkspace, candidate);
            await this.setup(run, run.validationWorkspace, signal, hooks);
            await git.clean(run.validationWorkspace, candidate);
            const receipts = new Map();
            const identities = new Map();
            const execute = async (gate, gateSignal) => {
                const startedAt = Date.now();
                const elapsedStart = performance.now();
                const env = environment([...run.config.environment.passEnv, ...gate.passEnv]);
                const command = expandCommand(gate.command, { baseSha: run.baseSha, candidateSha: candidate, workspace: run.validationWorkspace });
                const identityKey = hash({ command: command[0], env });
                if (!identities.has(identityKey))
                    identities.set(identityKey, executableIdentity(command[0], run.validationWorkspace, env));
                const executable = await identities.get(identityKey);
                const environmentHash = environmentIdentity(run.config.environment.id, env, {
                    setup: run.config.setup, executionMode: run.config.executionMode, executable,
                    // Same executable / PATH is not an attestation of every external service.
                });
                const key = proofKey({ repository: run.repo, baseSha: run.baseSha, candidateSha: candidate, taskHash: hash(run.task),
                    configHash: run.configHash, environmentHash, workspace: run.validationWorkspace, gate: { ...gate, command },
                    dependencyKeys: gate.dependsOn.map(d => receipts.get(d).key), executable });
                const previous = gate.cacheTtlMs > 0 ? this.store.cached(key) : null;
                let receipt;
                if (previous) {
                    receipt = { ...previous, id: randomUUID(), runId: run.id, status: 'cached', startedAt,
                        durationMs: performance.now() - elapsedStart, reusedFrom: previous.id, diagnostic: '' };
                    run.metrics.cacheHits++;
                }
                else {
                    this.store.event(run.id, 'gate.started', { gateId: gate.id, key });
                    const result = await runProcess({ command, cwd: run.validationWorkspace, env, timeoutMs: gate.timeoutMs, signal: gateSignal, ...hooks });
                    receipt = { id: randomUUID(), runId: run.id, gateId: gate.id, key, candidateSha: candidate, configHash: run.configHash, environmentHash,
                        status: result.status, startedAt, durationMs: performance.now() - elapsedStart, exitCode: result.exitCode,
                        stdoutHash: result.stdoutHash, stderrHash: result.stderrHash,
                        diagnostic: result.status === 'passed' ? '' : redact(`${result.status}\n${result.stderr}\n${result.stdout}`.slice(-8000), env), reusedFrom: null };
                }
                this.store.addReceipt(receipt);
                receipts.set(gate.id, receipt);
                return receipt;
            };
            run.receipts = await schedule(plan, { concurrency: run.config.concurrency, failFast: run.config.failFast, signal, execute,
                blocked: (gate, reason) => {
                    const receipt = { id: randomUUID(), runId: run.id, gateId: gate.id, key: hash({ blocked: gate.id, candidate }),
                        candidateSha: candidate, configHash: run.configHash, environmentHash: hash('not-executed'), status: 'blocked',
                        startedAt: Date.now(), durationMs: 0, exitCode: null, stdoutHash: '', stderrHash: '', diagnostic: reason, reusedFrom: null };
                    this.store.addReceipt(receipt);
                    return receipt;
                },
            });
            // Do NOT seal successful individual gates until the batch is quiescent and
            // both workspaces still correspond to the immutable candidate.
            await git.clean(run.validationWorkspace, candidate);
            await git.clean(run.workspace, candidate);
            invariant(!signal.aborted, 'CANCELLED', 'Validation interrupted');
            for (const receipt of run.receipts)
                this.store.seal(receipt, plan.find(g => g.id === receipt.gateId).cacheTtlMs);
            if (!run.receipts.every(success)) {
                this.store.save(run, 'validation.failed');
                return false;
            }
            run.validatedAt = Date.now();
            const required = run.task.reviewRequired ? requiredApprovals(run.risk.lane, run.config.workflow.reviewMode) : 0;
            transition(run, required > 0 ? 'awaiting_review' : 'ready');
            this.store.save(run, 'validation.completed', { candidateSha: candidate, requiredApprovals: required, cacheHits: run.receipts.filter(r => r.status === 'cached').length });
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
            if (!['failed', 'rejected', 'ready', 'awaiting_review', 'interrupted'].includes(run.state)) {
                run.resumeFrom = run.state;
                transition(run, 'interrupted');
            }
            this.store.save(run, 'run.recovered', { budgetAccounting: 'Crash interval charged conservatively until recovery' });
            return run;
        }
        finally {
            this.store.release(id, token);
        }
    }
    async evidenceReady(run, sha) {
        invariant(run.candidateSha === sha && /^[a-f0-9]{40,64}$/.test(sha), 'APPROVAL_SHA', 'Approval/export must name the exact candidate SHA');
        invariant(run.validatedAt !== null && Date.now() - run.validatedAt <= run.config.validationMaxAgeMs, 'STALE_EVIDENCE', 'Validation expired; revalidate before approval/export');
        invariant(run.receipts.length > 0 && run.receipts.length === run.gateIds.length && run.gateIds.every(id => run.receipts.some(r => r.gateId === id && r.candidateSha === sha && r.configHash === run.configHash && success(r))), 'EVIDENCE', 'Required receipts are missing or mismatched');
        for (const receipt of run.receipts)
            this.store.verifyReceipt(receipt);
        const git = new Git();
        await git.clean(run.workspace, sha);
        const observed = await git.changes(run.workspace, run.baseSha, sha);
        invariant(run.risk && hash(observed) === hash(run.changeSet), 'EVIDENCE', 'Observed changes do not match the validation');
        assertScope(observed, run.task);
        const risk = classify(observed, run.config, run.risk.lane);
        invariant(risk.lane === run.risk.lane, 'RISK', 'Risk cannot be downgraded after validation');
        const expected = planGates(run.config, observed, risk.lane).map(g => g.id);
        invariant(hash(expected) === hash(run.gateIds), 'EVIDENCE', 'Validation does not cover the required gate plan');
        return hash({ sha, configHash: run.configHash, gateIds: run.gateIds, receipts: run.receipts.map(r => r.id), validatedAt: run.validatedAt });
    }
    async approve(id, candidateSha, reviewer, note) {
        const token = this.store.acquire(id);
        try {
            const run = this.store.get(id);
            invariant(run.state === 'awaiting_review' && run.risk, 'STATE', 'Run is not awaiting review');
            const evidenceHash = await this.evidenceReady(run, candidateSha);
            const identity = reviewer.trim().toLocaleLowerCase('en-US');
            invariant(identity.length >= 3 && identity.length <= 120 && note.trim().length >= 10 && note.length <= 4000, 'REVIEW', 'A reviewer name and meaningful note are required');
            invariant(!run.approvals.some(a => a.reviewer.toLocaleLowerCase('en-US') === identity), 'REVIEW', 'Same reviewer cannot approve twice');
            run.approvals.push({ reviewer: reviewer.trim(), note: note.trim(), candidateSha, evidenceHash, at: Date.now() });
            if (run.approvals.length >= (run.task.reviewRequired ? requiredApprovals(run.risk.lane, run.config.workflow.reviewMode) : 0))
                transition(run, 'ready');
            this.store.save(run, 'review.approved', { reviewer: reviewer.trim(), candidateSha, evidenceHash });
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
            invariant(['ready', 'awaiting_review'].includes(run.state) && run.risk, 'STATE', 'No completed validation to invalidate review');
            run.approvals = [];
            run.state = run.task.reviewRequired && requiredApprovals(run.risk.lane, run.config.workflow.reviewMode) > 0 ? 'awaiting_review' : 'ready';
            this.store.save(run, 'review.invalidated', { reason });
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
            invariant(run.state === 'awaiting_review', 'STATE', 'Run is not awaiting review');
            invariant(note.trim().length >= 10, 'REVIEW', 'A rejection reason is required');
            transition(run, 'rejected');
            run.error = { code: 'REJECTED', message: note.trim() };
            this.store.save(run, 'review.rejected');
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
            invariant(run.state === 'ready' && run.candidateSha, 'STATE', 'Only ready runs may be exported');
            const evidenceHash = await this.evidenceReady(run, run.candidateSha);
            const approved = new Set(run.approvals.filter(a => a.candidateSha === run.candidateSha && a.evidenceHash === evidenceHash)
                .map(a => a.reviewer.toLocaleLowerCase('en-US')));
            invariant(run.risk, 'RISK', 'Missing validated risk decision');
            const required = run.task.reviewRequired ? requiredApprovals(run.risk.lane, run.config.workflow.reviewMode) : 0;
            invariant(approved.size >= required, 'REVIEW', 'Required approvals do not cover the current evidence');
            const patch = await new Git().patch(run.workspace, run.baseSha, run.candidateSha);
            this.store.event(id, 'patch.exported', { baseSha: run.baseSha, candidateSha: run.candidateSha });
            return patch;
        }
        finally {
            this.store.release(id, token);
        }
    }
}
export function summarize(run) {
    return { id: run.id, task: run.task.title, state: run.state, lane: run.risk?.lane ?? null,
        baseSha: run.baseSha, candidateSha: run.candidateSha, workspace: run.workspace,
        summary: run.summary, files: run.changeSet?.files ?? [], riskReasons: run.risk?.reasons ?? [],
        approvals: run.approvals.length, requiredApprovals: run.risk ? (run.task.reviewRequired ? requiredApprovals(run.risk.lane, run.config.workflow.reviewMode) : 0) : null, reviewRequired: run.task.reviewRequired, reviewMode: run.config.workflow.reviewMode,
        gates: run.receipts.map(r => ({ id: r.gateId, status: r.status, durationMs: Math.round(r.durationMs), diagnostic: r.diagnostic, reusedFrom: r.reusedFrom })),
        metrics: { ...run.metrics, controllerExclusiveMs: Math.max(0, run.metrics.activeMs - run.metrics.preparationMs - run.metrics.agentMs - run.metrics.validationMs) },
        remainingMs: run.remainingMs, error: run.error };
}
//# sourceMappingURL=pipeline.js.map