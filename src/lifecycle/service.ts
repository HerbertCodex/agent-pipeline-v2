import { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, relative, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pipeline, summarize } from '../engine/pipeline.js';
import { validateConfig, taskSchema, MAX_TASK_DESCRIPTION, type Run, type Task } from '../domain/contracts.js';
import { hash, sha256 } from '../domain/hash.js';
import { PipelineError, errorMessage, invariant } from '../domain/errors.js';
import { Git, isInside } from '../execution/git.js';
import type { Document } from '../persistence/store.js';
import { specSchema, qaSchema, designProposalSchema, validateSpec, validateQa, specHash, approvalHash, specMarkdown, stricter, reviewer, type SpecRecord, type Spec, type QaRecord, type ScopeAmendment, type DesignProposal } from './contracts.js';
import { runRole } from './roles.js';
import { matches } from '../policy/policy.js';
import { inspectRepository } from '../knowledge/repository.js';
import { confirmedDecisions, ledgerHash, loadDecisionLedger } from './decisions.js';
import { assessSecurity, neutralSecurityContext } from '../security/owasp.js';
export interface WorkflowOptions {
    signal?: AbortSignal;
    acceptCurrent?: boolean;
    manualQa?: boolean;
}
export class Lifecycle {
    readonly pipeline: Pipeline;
    constructor(stateDir: string) { this.pipeline = new Pipeline(stateDir); }
    get store() { return this.pipeline.store; }
    close(): void { this.pipeline.close(); }
    get(id: string): Document<SpecRecord> {
        const doc = this.store.document<SpecRecord>(id, 'spec');
        const r = doc.data;
        r.scopeAmendments ??= [];
        r.decisionLedger ??= { schemaVersion: 1, decisions: [] };
        r.decisionLedgerHash ??= ledgerHash(r.decisionLedger);
        r.securityContext ??= neutralSecurityContext();
        r.securityContextHash ??= hash(r.securityContext);
        r.review ??= null;
        r.design ??= null;
        invariant(hash(r.config) === r.configHash, 'DB_CORRUPT', 'Spec configuration mismatch');
        if (r.content)
            invariant(hash(validateSpec(r.content, false, r.decisionLedger, r.request, r.securityContext)) === hash(r.content) && r.contentHash === specHash(r), 'DB_CORRUPT', 'Spec content/hash mismatch');
        if (r.design) invariant(r.design.hash === hash(r.design.proposal), 'DB_CORRUPT', 'Design proposal/hash mismatch');
        return doc;
    }
    private save(doc: Document<SpecRecord>, type: string, data: Record<string, unknown> = {}): void { this.store.saveDocument(doc, type, data); }
    private approved(r: SpecRecord): Spec {
        invariant(r.content && r.approval && r.contentHash === specHash(r) && r.approval.hash === approvalHash(r), 'SPEC_APPROVAL', 'An exact, current spec/design approval is required');
        if (this.requiresDesign(r.content, r.config.skills.projectType)) invariant(r.design && r.design.proposal.questions.length === 0, 'DESIGN_APPROVAL', 'An approved UI design mockup is required before implementation');
        return validateSpec(r.content, true, r.decisionLedger, r.request, r.securityContext);
    }
    async draft(options: {
        repo: string;
        config: unknown;
        request: string;
        proposal?: unknown;
        signal?: AbortSignal;
    }): Promise<Document<SpecRecord>> {
        invariant(options.request.trim().length > 0 && options.request.length <= 30000, 'REQUEST', 'Provide a request up to 30000 characters');
        const git = new Git();
        const repo = await git.root(options.repo);
        await git.clean(repo);
        const baseSha = await git.sha(repo);
        await git.compatible(repo, baseSha);
        invariant(!isInside(repo, this.store.root) && !isInside(this.store.root, repo), 'STATE_PATH', 'State and project must be disjoint');
        const config = validateConfig(options.config);
        const decisionLedger = await loadDecisionLedger(repo, baseSha);
        const r: SpecRecord = { repo, baseSha, config, configHash: hash(config), revision: 1, request: options.request, decisionLedger, decisionLedgerHash: ledgerHash(decisionLedger), securityContext: neutralSecurityContext(), securityContextHash: hash(neutralSecurityContext()), content: null, contentHash: null, approval: null, status: 'draft', attempts: [], completedTaskIds: [], currentSha: baseSha, activeRunId: null, finalRunId: null, validationRunIds: [], qa: null, qaRepairs: 0, design: null, scopeAmendments: [], review: null, sessionStartedAt: null, activeMs: 0, delivery: null, publication: null, error: null };
        const doc = this.store.createDocument('spec', r);
        const token = this.store.acquireDocument(doc.id);
        try {
            await this.product(doc, options.proposal, options.signal);
            return doc;
        }
        catch (error) {
            r.error = { code: 'PRODUCT', message: errorMessage(error) };
            this.save(doc, 'product.failed', { error: r.error });
            throw new PipelineError('PRODUCT', `Spec ${doc.id}: ${errorMessage(error)}`, { cause: error });
        }
        finally {
            this.store.releaseDocument(doc.id, token);
        }
    }
    private requiresDesign(spec: Spec, projectType: string): boolean {
        if (!['frontend', 'mobile', 'fullstack'].includes(projectType))
            return false;
        if (spec.experience.uiImpact !== 'none')
            return true;
        const text = [spec.title, spec.problem, ...spec.scope, ...spec.tasks.flatMap(t => [t.title, t.description, ...t.allowedPaths])].join(' ');
        return /(?:\.svelte\b|\.tsx\b|\.jsx\b|\.vue\b|\bui\b|interface|screen|page|dashboard|form|modal|layout|component|route|écran|ecran|tableau de bord|formulaire)/i.test(text);
    }
    private companionPaths(paths: string[]): string[] {
        const out = new Set<string>();
        for (const path of paths) {
            if (/[*?]/.test(path))
                continue;
            const i = path.lastIndexOf('/');
            if (i <= 0)
                continue;
            const dir = path.slice(0, i);
            if (/^(?:src|app|lib|pages|routes|components)(?:\/|$)/.test(dir))
                out.add(`${dir}/*`);
        }
        return [...out].slice(0, 20);
    }
    private validateDesignMarkup(p: DesignProposal): void {
        const dangerous = /<\s*(?:script|iframe|object|embed|link|meta|base)\b|\bon[a-z]+\s*=|javascript:|\b(?:src|srcdoc)\s*=|\bhref\s*=\s*["'](?:https?:|\/\/)/i;
        for (const screen of p.screens)
            invariant(!dangerous.test(screen.bodyHtml), 'DESIGN_MARKUP', `Unsafe markup in design screen ${screen.id}`);
        invariant(!/@import\b|url\s*\(|expression\s*\(|javascript:/i.test(p.css), 'DESIGN_MARKUP', 'Design CSS cannot load external resources or executable content');
    }
    private htmlEscape(text: string): string {
        return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    }
    private async prepareDesignProposal(doc: Document<SpecRecord>, repositoryIntelligence: unknown, signal?: AbortSignal): Promise<void> {
        const r = doc.data;
        invariant(r.content, 'DESIGN', 'Spec required before design');
        const context = {
            mode: 'design-proposal', request: r.request, spec: r.content, decisionLedger: r.decisionLedger, repositoryIntelligence, securityContext: r.securityContext,
            instructions: [
                'Create a concrete visual mockup before implementation. Use the ui-design skill and existing design system/assets if present.',
                'Avoid generic AI-dashboard aesthetics and unjustified gradients/cards. Explain visual decisions, alternatives and tradeoffs.',
                'Cover meaningful loading, empty, error, success, focus and responsive states.',
                'Return static HTML fragments and CSS only; no scripts, remote assets, network URLs or executable content.',
            ],
        };
        const raw = await runRole({ store: this.store, documentId: doc.id, repo: r.repo, sha: r.baseSha, role: 'product', skills: r.config.skills,
            agent: r.config.roles.product ?? r.config.agent, passEnv: r.config.environment.passEnv, schema: designProposalSchema, context, ...(signal ? { signal } : {}) });
        const proposal = designProposalSchema.parse(raw);
        this.validateDesignMarkup(proposal);
        const root = resolve(dirname(r.repo), `${basename(r.repo)}-review`, doc.id, 'design');
        invariant(!isInside(r.repo, root) && !isInside(this.store.root, root), 'DESIGN_PATH', 'Design preview must be outside source and operational state');
        rmSync(root, { recursive: true, force: true });
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const screenPaths: string[] = [];
        const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; script-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
        for (const screen of proposal.screens) {
            const file = join(root, `${screen.id}.html`);
            const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${this.htmlEscape(screen.title)}</title><style>${proposal.css}</style></head><body>${screen.bodyHtml}</body></html>`;
            writeFileSync(file, html, { flag: 'wx', mode: 0o600 });
            screenPaths.push(file);
        }
        const indexPath = join(root, 'INDEX.md');
        const lines = ['# Design review', '', proposal.summary, '', `Rationale: ${proposal.rationale}`, '', `Visual direction: ${proposal.visualDirection}`, '',
            '## Screens', ...proposal.screens.flatMap((x, i) => [`- ${x.title}: ${screenPaths[i]}`, `  - Purpose: ${x.purpose}`, `  - States: ${x.states.join(', ') || 'default'}`, `  - Responsive: ${x.responsive}`]),
            '', '## Decisions', ...proposal.decisions.map(x => `- ${x.decision}: ${x.rationale}`), '', '## Avoid', ...proposal.avoid.map(x => `- ${x}`), '',
            'Open the HTML files above in a browser before approving the spec.'];
        writeFileSync(indexPath, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
        r.design = { proposal, hash: hash(proposal), directory: root, indexPath, screenPaths, generatedAt: Date.now() };
        this.save(doc, 'design.proposed', { hash: r.design.hash, directory: root, indexPath, screenPaths, questions: proposal.questions });
    }
    private async product(doc: Document<SpecRecord>, proposal: unknown, signal?: AbortSignal): Promise<void> {
        const r = doc.data;
        const repositoryIntelligence = await inspectRepository(r.repo, r.baseSha, `${r.request}
${r.decisionLedger.decisions.map(d=>`${d.subject}: ${d.value}`).join('\n')}`, signal);
        r.securityContext = assessSecurity({ text: r.request + '\n' + r.decisionLedger.decisions.map(d=>`${d.subject}: ${d.value}`).join('\n'), projectType: r.config.skills.projectType, files: repositoryIntelligence.relevantFiles });
        r.securityContextHash = hash(r.securityContext);
        const value = proposal ?? await runRole({ store: this.store, documentId: doc.id, repo: r.repo, sha: r.baseSha, role: 'product', skills: r.config.skills, agent: r.config.roles.product ?? r.config.agent, passEnv: r.config.environment.passEnv, schema: specSchema, context: { request: r.request, previous: r.content, decisionLedger: r.decisionLedger, repositoryIntelligence, securityContext: r.securityContext }, ...(signal ? { signal } : {}) });
        this.save(doc, 'product.repository_intelligence', { sha: repositoryIntelligence.sha, fileCount: repositoryIntelligence.fileCount, relevantFiles: repositoryIntelligence.relevantFiles, securityFiles: repositoryIntelligence.securityFiles, reuseCandidates: repositoryIntelligence.reuseCandidates.map(x=>({name:x.name,kind:x.kind,path:x.path,line:x.line,score:x.score})) });
        this.save(doc, 'security.assessed', { contextHash:r.securityContextHash, minimumLane:r.securityContext.minimumLane, requiresThreatModel:r.securityContext.requiresThreatModel, negativeTestsRequired:r.securityContext.negativeTestsRequired, topics:r.securityContext.topics.map(t=>t.id), signals:r.securityContext.signals });
        r.content = validateSpec(value, false, r.decisionLedger, r.request, r.securityContext);
        r.contentHash = specHash(r);
        r.design = null;
        if (this.requiresDesign(r.content, r.config.skills.projectType) && r.content.questions.length===0) await this.prepareDesignProposal(doc, repositoryIntelligence, signal);
        r.error = null;
        const design = r.design as SpecRecord['design'];
        this.save(doc, 'product.proposed', { revision: r.revision, hash: approvalHash(r), specHash: r.contentHash, designHash: design?.hash ?? null,
            questions: [...r.content.questions, ...(design?.proposal.questions ?? [])], content: r.content,
            design: design ? { hash: design.hash, directory: design.directory, indexPath: design.indexPath, summary: design.proposal.summary } : null });
    }
    async refine(id: string, request: string, proposal?: unknown, signal?: AbortSignal): Promise<Document<SpecRecord>> {
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            const r = doc.data;
            invariant(r.attempts.length === 0 && !['closed', 'rejected'].includes(r.status), 'SPEC_IMMUTABLE', 'Execution has started; create a follow-up spec instead of rewriting approved history');
            invariant(request.trim().length > 0 && r.request.length + request.length + 30 <= 30000, 'REQUEST', 'Provide a bounded refinement');
            r.request += '\n\nOperator refinement:\n' + request;
            r.revision++;
            r.approval = null;
            r.design = null;
            r.status = 'draft';
            r.error = null;
            if (r.content)
                r.contentHash = specHash(r);
            this.save(doc, 'product.refinement_requested', { revision: r.revision, approvalInvalidated: true });
            try {
                await this.product(doc, proposal, signal);
            }
            catch (error) {
                r.error = { code: 'PRODUCT', message: errorMessage(error) };
                this.save(doc, 'product.failed', { error: r.error });
                throw error;
            }
            return doc;
        }
        finally {
            this.store.releaseDocument(id, token);
        }
    }
    async approveSpec(id: string, expectedHash: string, actor: string, note: string): Promise<Document<SpecRecord>> {
        reviewer(actor, note);
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            const r = doc.data;
            invariant(r.attempts.length === 0 && ['draft', 'approved'].includes(r.status), 'STATE', 'Spec no longer accepts Product approval');
            invariant(r.content && approvalHash(r) === expectedHash, 'APPROVAL_HASH', 'Approve the exact spec/design proposal hash');
            validateSpec(r.content, true, r.decisionLedger, r.request, r.securityContext);
            if (this.requiresDesign(r.content, r.config.skills.projectType)) invariant(r.design && r.design.proposal.questions.length === 0, 'OPEN_QUESTIONS', 'Resolve design questions before approval');
            await new Git().clean(r.repo, r.baseSha);
            r.approval = { hash: expectedHash, reviewer: actor.trim(), note: note.trim(), at: Date.now() };
            r.status = 'approved';
            r.error = null;
            this.save(doc, 'spec.approved', { approval: r.approval });
            return doc;
        }
        finally {
            this.store.releaseDocument(id, token);
        }
    }
    private makeTask(r: SpecRecord, t: Spec['tasks'][number]): Task {
        const spec = this.approved(r);
        const acceptance = spec.acceptance.filter(a => t.acceptanceIds.includes(a.id));
        const design = r.design ? { hash:r.design.hash, summary:r.design.proposal.summary, visualDirection:r.design.proposal.visualDirection, implementationBrief:r.design.proposal.implementationBrief, decisions:r.design.proposal.decisions, avoid:r.design.proposal.avoid, screens:r.design.proposal.screens.map(x=>({id:x.id,title:x.title,purpose:x.purpose,states:x.states,responsive:x.responsive})) } : null;
        const decisionIds = new Set(spec.decisionCoverage.filter(c => c.acceptanceIds.some(id => t.acceptanceIds.includes(id))).map(c => c.decisionId));
        const confirmedProjectDecisions = confirmedDecisions(r.decisionLedger).filter(d => decisionIds.has(d.id));
        const resolvedProjectDecisions = spec.decisionResolutions.filter(d=>decisionIds.has(d.decisionId)).map(d=>({id:d.decisionId,subject:r.decisionLedger.decisions.find(x=>x.id===d.decisionId)?.subject ?? d.decisionId,value:d.value,status:'confirmed-via-product',source:'operator',sourceQuote:d.sourceQuote,rationale:d.rationale}));
        const projectDecisions = [...confirmedProjectDecisions, ...resolvedProjectDecisions];
        const securityRequirements = spec.security.requirements.filter(req => req.acceptanceIds.some(id => t.acceptanceIds.includes(id)));
        const securityThreats = spec.security.threatModel.threats.filter(threat => threat.acceptanceIds.some(id => t.acceptanceIds.includes(id)));
        const security = { context:r.securityContext, profile:spec.security.profile, requirements:securityRequirements, threats:securityThreats, assumptions:spec.security.assumptions };
        const context = { problem: spec.problem, scope: spec.scope, outOfScope: spec.outOfScope, decisions: spec.decisions, projectDecisions, criteria: acceptance, experience: spec.experience, security, approvedDesign: design };
        const description = t.description + '\n\nApproved Product context (do not expand scope):\n' + JSON.stringify(context);
        invariant(description.length <= MAX_TASK_DESCRIPTION, 'TASK_CONTEXT', 'Approved context is too large for a task; split the spec before execution');
        const amendments = r.scopeAmendments.filter(a => a.status === 'approved' && a.taskId === t.id).flatMap(a => a.paths);
        const allowedPaths=[...new Set([...t.allowedPaths, ...amendments])];
        const allowedNewPaths=this.companionPaths(allowedPaths);
        return taskSchema.parse({ id: t.id, title: t.title, description, acceptance: acceptance.map(a => a.description), allowedPaths, allowedNewPaths, maxNewFiles: allowedNewPaths.length ? 4 : 0, reviewRequired:false, minimumLane: stricter(t.minimumLane, spec.minimumLane, securityRequirements.length ? r.securityContext.minimumLane : 'fast') });
    }
    private aggregateTask(r: SpecRecord, description: string): Task {
        const spec = this.approved(r);
        const minimum = stricter(spec.minimumLane, r.securityContext.minimumLane, ...r.attempts.map(a => this.pipeline.store.get(a.runId).risk?.lane ?? 'fast'));
        const allowedPaths=[...new Set([...spec.tasks.flatMap(t => t.allowedPaths), ...r.scopeAmendments.filter(a=>a.status === 'approved').flatMap(a=>a.paths)])];
        const allowedNewPaths=this.companionPaths(allowedPaths);
        return taskSchema.parse({ id: 'SPEC-INTEGRATION', title: spec.title, description, acceptance: spec.acceptance.map(a => a.description), allowedPaths, allowedNewPaths, maxNewFiles: allowedNewPaths.length ? 8 : 0, reviewRequired:true, minimumLane: minimum });
    }
    private async executeActive(doc: Document<SpecRecord>, options: WorkflowOptions, signal: AbortSignal): Promise<Run> {
        const r = doc.data;
        invariant(r.activeRunId, 'STATE', 'No active run');
        const before = this.pipeline.store.get(r.activeRunId);
        if (['failed', 'rejected'].includes(before.state))
            return before;
        const run = await this.pipeline.execute(before.id, { signal, acceptCurrentCandidate: options.acceptCurrent ?? false });
        this.save(doc, 'workflow.attempt_observed', { runId: run.id, state: run.state, candidateSha: run.candidateSha });
        return run;
    }
    private requestScopeAmendment(doc: Document<SpecRecord>, run: Run): boolean {
        if (run.error?.code !== 'SCOPE' || !run.candidateSha || !run.changeSet) return false;
        const paths = run.changeSet.files.filter(file => !run.task.allowedPaths.some(pattern => matches(file, pattern)));
        if (!paths.length) return false;
        const attempt = doc.data.attempts.find(a => a.runId === run.id);
        if (!attempt) return false;
        const existing = doc.data.scopeAmendments.find(a => a.sourceRunId === run.id && a.status === 'pending');
        const amendment: ScopeAmendment = existing ?? {
            id: randomUUID(), taskId: attempt.taskId, sourceRunId: run.id, paths,
            reason: `Candidate ${run.candidateSha} needs files outside the approved execution paths: ${paths.join(', ')}`,
            candidateSha: run.candidateSha, status: 'pending', requestedAt: Date.now(), approvedAt: null, reviewer: null, note: null,
        };
        if (!existing) doc.data.scopeAmendments.push(amendment);
        doc.data.status = 'blocked';
        doc.data.error = { code: 'SCOPE_AMENDMENT_REQUIRED', message: amendment.reason };
        this.save(doc, 'scope.amendment_requested', { amendment });
        return true;
    }
    private block(doc: Document<SpecRecord>, run: Run): void {
        if (this.requestScopeAmendment(doc, run)) return;
        doc.data.status = 'blocked';
        doc.data.error = run.error ?? { code: run.state === 'interrupted' ? 'INTERRUPTED' : 'EXECUTION', message: `Run ${run.id} is ${run.state}` };
        this.save(doc, 'workflow.blocked', { runId: run.id, error: doc.data.error });
    }
    async approveScopeAmendment(id: string, amendmentId: string, actor: string, note: string): Promise<Document<SpecRecord>> {
        reviewer(actor, note);
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id); const r = doc.data; this.approved(r);
            const amendment = r.scopeAmendments.find(a => a.id === amendmentId);
            invariant(amendment && amendment.status === 'pending', 'SCOPE_AMENDMENT', 'Pending scope amendment not found');
            const failed = this.pipeline.store.get(amendment.sourceRunId);
            invariant(failed.state === 'failed' && failed.candidateSha === amendment.candidateSha, 'SCOPE_AMENDMENT', 'Scope amendment source candidate is no longer adoptable');
            amendment.status = 'approved'; amendment.approvedAt = Date.now(); amendment.reviewer = actor.trim(); amendment.note = note.trim();
            const spec = this.approved(r);
            const specTask = spec.tasks.find(t => t.id === amendment.taskId);
            const task = specTask ? this.makeTask(r, specTask) : this.aggregateTask(r, `Revalidate the retained QA repair candidate after explicit execution-scope amendment ${amendment.id}.`);
            const validationConfig = { ...r.config, maxRepairAttempts: 0 };
            const validation = await this.pipeline.createValidation({ repo: r.repo, baseRef: failed.baseSha, config: validationConfig, task }, amendment.candidateSha);
            const previousAttempt = r.attempts.find(a => a.runId === amendment.sourceRunId)!;
            r.attempts.push({ taskId: amendment.taskId, runId: validation.id, kind: previousAttempt.kind });
            r.activeRunId = validation.id;
            if (previousAttempt.kind === 'qa-repair') { r.finalRunId = null; r.qa = null; }
            r.review = null; r.delivery = null; r.status = 'running'; r.error = null;
            this.save(doc, 'scope.amendment_approved', { amendmentId: amendment.id, paths: amendment.paths, candidateSha: amendment.candidateSha, validationRunId: validation.id, reviewer: actor.trim() });
            return doc;
        } finally { this.store.releaseDocument(id, token); }
    }
    async run(id: string, options: WorkflowOptions = {}): Promise<Document<SpecRecord>> {
        const token = this.store.acquireDocument(id);
        let doc: Document<SpecRecord> | undefined;
        let timer: NodeJS.Timeout | undefined;
        let started: number | undefined;
        try {
            doc = this.get(id);
            const r = doc.data;
            const spec = this.approved(r);
            invariant(r.status !== 'rejected', 'STATE', 'Spec was rejected; create a follow-up spec');
            if (['closed', 'delivered'].includes(r.status))
                return doc;
            invariant(r.sessionStartedAt === null, 'RECOVERY', 'Recover the interrupted workflow explicitly first');
            const remaining = r.config.workflow.maxActiveMs - r.activeMs;
            invariant(remaining > 0, 'BUDGET', 'Spec active-time budget exhausted');
            await new Git().clean(r.repo, r.baseSha);
            const controller = new AbortController();
            timer = setTimeout(() => controller.abort(), remaining);
            const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
            started = performance.now();
            r.sessionStartedAt = Date.now();
            r.error = null;
            r.status = 'running';
            this.save(doc, 'workflow.session_started', { remainingMs: remaining });
            // A single implementation at a time avoids speculative merge/revalidation costs.
            // Dependency order is deterministic, even when independent task order was arbitrary in Product output.
            const done = new Set(r.completedTaskIds);
            const order: Spec['tasks'] = [];
            const visit = (taskId: string): void => { if (order.some(t => t.id === taskId))
                return; const t = spec.tasks.find(x => x.id === taskId)!; t.dependsOn.forEach(visit); order.push(t); };
            spec.tasks.forEach(t => visit(t.id));
            for (const t of order) {
                if (done.has(t.id))
                    continue;
                invariant(!signal.aborted, 'CANCELLED', 'Spec execution cancelled');
                if (!r.activeRunId) {
                    const run = await this.pipeline.create({ repo: r.repo, baseRef: r.currentSha, config: r.config, task: this.makeTask(r, t) });
                    r.attempts.push({ taskId: t.id, runId: run.id, kind: 'task' });
                    r.activeRunId = run.id;
                    this.save(doc, 'workflow.task_started', { taskId: t.id, runId: run.id, baseSha: r.currentSha });
                }
                const attempt = r.attempts.find(a => a.runId === r.activeRunId);
                invariant(attempt?.taskId === t.id && attempt.kind === 'task', 'STATE', 'Active task does not match dependency frontier');
                const run = await this.executeActive(doc, options, signal);
                if (!['ready', 'awaiting_review'].includes(run.state)) {
                    this.block(doc, run);
                    return doc;
                }
                await this.pipeline.assertValidated(run.id);
                invariant(run.candidateSha, 'CANDIDATE', 'Task lacks candidate');
                r.currentSha = run.candidateSha;
                r.activeRunId = null;
                r.completedTaskIds.push(t.id);
                done.add(t.id);
                this.save(doc, 'workflow.task_completed', { taskId: t.id, runId: run.id, candidateSha: run.candidateSha, humanApprovalDeferredToIntegration: true });
            }
            for (;;) {
                invariant(!signal.aborted, 'CANCELLED', 'Spec execution cancelled');
                // Continue a QA repair whose pointer was saved before executing the agent.
                if (r.activeRunId && r.attempts.some(a => a.runId === r.activeRunId && a.kind === 'qa-repair')) {
                    const repaired = await this.executeActive(doc, options, signal);
                    if (!['ready', 'awaiting_review'].includes(repaired.state)) {
                        this.block(doc, repaired);
                        return doc;
                    }
                    await this.pipeline.assertValidated(repaired.id);
                    invariant(repaired.candidateSha, 'CANDIDATE', 'Repair lacks candidate');
                    r.currentSha = repaired.candidateSha;
                    r.activeRunId = null;
                    r.finalRunId = null;
                    r.qa = null;
                    r.delivery = null;
                    this.save(doc, 'workflow.qa_repair_completed', { runId: repaired.id, candidateSha: r.currentSha });
                }
                if (!r.finalRunId) {
                    // One task already validates exactly the complete candidate: do not pay for the same gates twice.
                    const only = r.attempts.length === 1 ? this.pipeline.store.get(r.attempts[0]!.runId) : null;
                    if (only && only.task.reviewRequired && ['ready', 'awaiting_review'].includes(only.state) && only.baseSha === r.baseSha && only.candidateSha === r.currentSha) {
                        r.finalRunId = only.id;
                        this.save(doc, 'integration.reused', { runId: only.id });
                    }
                    else {
                        const finalConfig = { ...r.config, maxRepairAttempts: 0, gates: r.config.gates.map(g => ({ ...g, mandatory: true })) };
                        const run = await this.pipeline.createValidation({ repo: r.repo, baseRef: r.baseSha, config: finalConfig, task: this.aggregateTask(r, 'Validate the complete approved specification on its aggregate candidate, including interactions across tasks.') }, r.currentSha);
                        r.finalRunId = run.id;
                        r.validationRunIds.push(run.id);
                        r.activeRunId = run.id;
                        this.save(doc, 'integration.created', { runId: run.id, candidateSha: r.currentSha });
                    }
                }
                let final = this.pipeline.store.get(r.finalRunId);
                if (!['ready', 'awaiting_review'].includes(final.state)) {
                    r.activeRunId = final.id;
                    this.save(doc, 'integration.validation_started', { runId: final.id });
                    final = await this.executeActive(doc, options, signal);
                    if (!['ready', 'awaiting_review'].includes(final.state)) {
                        this.block(doc, final);
                        return doc;
                    }
                }
                r.activeRunId = null;
                const evidenceHash = await this.pipeline.assertValidated(final.id);
        invariant(!r.review || r.review.candidateSha === final.candidateSha, 'REVIEW_STALE', 'Review workspace does not match the current candidate');
                const needsQa = r.config.workflow.qaLanes.includes(final.risk!.lane);
                if (needsQa && (!r.qa || r.qa.evidenceHash !== evidenceHash || r.qa.report.candidateSha !== final.candidateSha || r.qa.specHash !== r.contentHash)) {
                    r.qa = null;
                    if (options.manualQa) {
                        r.status = 'blocked';
                        r.error = { code: 'QA_REQUIRED', message: 'Import a complete QA report with spec qa, then run again.' };
                        this.save(doc, 'qa.required');
                        return doc;
                    }
                    const diff = await new Git(signal).patch(r.repo, r.baseSha, final.candidateSha!);
                    invariant(Buffer.byteLength(diff) <= 524288, 'QA_CONTEXT', 'QA diff exceeds 512 KiB; use an explicit external review, never a truncated review');
                    const raw = await runRole({ store: this.store, documentId: id, repo: r.repo, sha: final.candidateSha!, role: 'qa', skills: r.config.skills, agent: r.config.roles.qa ?? r.config.agent, passEnv: r.config.environment.passEnv, schema: qaSchema, context: { diff, spec: r.content, decisionLedger: r.decisionLedger, securityContext:r.securityContext, baseSha: r.baseSha, candidateSha: final.candidateSha, receipts: final.receipts, diffCommand: ['git', 'diff', '--no-ext-diff', '--no-textconv', r.baseSha, final.candidateSha, '--'] }, signal });
                    r.qa = { report: validateQa(raw, spec, final.candidateSha!, r.decisionLedger), specHash: r.contentHash!, evidenceHash, at: Date.now(), source: 'agent' };
                    this.save(doc, 'qa.completed', { qa: r.qa });
                }
                if (needsQa && r.qa!.report.verdict === 'changes_requested') {
                    if (r.qaRepairs >= r.config.workflow.maxQaRepairs) {
                        r.status = 'blocked';
                        r.error = { code: 'QA_REJECTED', message: 'QA requests changes; automatic repair budget exhausted. Inspect findings and create an explicit follow-up.' };
                        this.save(doc, 'qa.repair_budget_exhausted');
                        return doc;
                    }
                    const description = 'Correct the following QA findings without broadening the approved scope.\n' + JSON.stringify({ approvedSpec: spec, qa: r.qa!.report });
                    invariant(description.length <= MAX_TASK_DESCRIPTION, 'TASK_CONTEXT', 'QA repair context too large; prepare an explicit follow-up');
                    const run = await this.pipeline.create({ repo: r.repo, baseRef: r.currentSha, config: r.config, task: this.aggregateTask(r, description) });
                    r.qaRepairs++;
                    r.attempts.push({ taskId: `QA-REPAIR-${r.qaRepairs}`, runId: run.id, kind: 'qa-repair' });
                    r.activeRunId = run.id;
                    this.save(doc, 'workflow.qa_repair_started', { runId: run.id, number: r.qaRepairs });
                    continue;
                }
                await this.prepareReviewWorkspace(doc, final);
                r.status = final.state === 'ready' ? 'ready' : 'awaiting_review';
                r.error = null;
                this.save(doc, 'workflow.review_ready', { runId: final.id, candidateSha: final.candidateSha, qaRequired: needsQa, review: r.review });
                return doc;
            }
        }
        catch (error) {
            if (doc && started !== undefined) {
                doc.data.status = 'blocked';
                doc.data.error = { code: error instanceof PipelineError ? error.code : 'WORKFLOW', message: errorMessage(error) };
                this.save(doc, 'workflow.error', { error: doc.data.error });
                return doc;
            }
            throw error;
        }
        finally {
            if (timer)
                clearTimeout(timer);
            if (doc && started !== undefined) {
                doc.data.activeMs += Math.max(0, performance.now() - started);
                doc.data.sessionStartedAt = null;
                this.save(doc, 'workflow.session_finished', { activeMs: doc.data.activeMs });
            }
            this.store.releaseDocument(id, token);
        }
    }
    private qaMarkdown(r: SpecRecord): string {
        if (!r.qa) return '# QA\n\nQA was not required for this candidate.\n';
        const q=r.qa.report; const lines=['# QA review','',`Verdict: **${q.verdict}**`,'',q.summary,'','## Acceptance criteria'];
        for (const c of q.criteria) lines.push(`- **${c.id}** — ${c.status}: ${c.evidence}`);
        lines.push('','## Findings');
        if (!q.findings.length) lines.push('- None');
        else for (const f of q.findings) lines.push(`- **${f.severity}** ${f.id}${f.path ? ` (${f.path})` : ''}: ${f.description}`);
        if (q.securityChecks.length) lines.push('','## Security checks',...q.securityChecks.map(x=>`- **${x.requirementId}** — ${x.status}: ${x.evidence}`));
        if (q.decisionChecks.length) lines.push('','## Decision checks',...q.decisionChecks.map(x=>`- **${x.decisionId}** — ${x.status}: ${x.evidence}`));
        if (q.observations.length) lines.push('','## Observations',...q.observations.map(x=>`- ${x}`));
        return lines.join('\n')+'\n';
    }
    private async prepareReviewWorkspace(doc: Document<SpecRecord>, final: Run): Promise<void> {
        const r=doc.data; invariant(final.candidateSha,'CANDIDATE','Review candidate is missing');
        const root=resolve(dirname(r.repo),`${basename(r.repo)}-review`,doc.id); const candidate=join(root,'candidate');
        invariant(!isInside(r.repo,root) && !isInside(this.store.root,root),'REVIEW_PATH','Review workspace must be outside source and operational state');
        const git=new Git();
        if (r.review?.candidateSha === final.candidateSha && existsSync(r.review.candidateDirectory)) {
            await git.clean(r.review.candidateDirectory,final.candidateSha); return;
        }
        if (existsSync(candidate)) {
            try { await git.removeWorkspace(r.repo,candidate,root); } catch { /* stale review material is removed below; never trusted */ }
        }
        rmSync(root,{recursive:true,force:true}); mkdirSync(root,{recursive:true,mode:0o700});
        await git.workspace(r.repo,candidate,final.candidateSha);
        const patchPath=join(root,'candidate.patch'); const qaPath=join(root,'QA.md'); const reviewPath=join(root,'REVIEW.md');
        const patch=await git.patch(r.repo,r.baseSha,final.candidateSha);
        writeFileSync(patchPath,patch,{mode:0o600}); writeFileSync(qaPath,this.qaMarkdown(r),{mode:0o600});
        const gateLines=final.receipts.map(x=>`- ${x.gateId}: ${x.status}`).join('\n');
        const securityLines = r.content?.security.requirements.length ? r.content.security.requirements.map(x=>`- ${x.id}: ${x.title} [${x.owaspTopics.join(', ')}]`).join('\n') : '- none';
        const text=[`# Candidate review`,``,`Candidate: ${final.candidateSha}`,`Risk: ${final.risk?.lane ?? 'unknown'}`,`Review mode: ${r.config.workflow.reviewMode}`,`Security minimum: ${r.securityContext.minimumLane}`,`OWASP topics: ${r.securityContext.topics.map(x=>x.id).join(', ') || 'none'}`,``,`Open this directory in your editor:`,``,candidate,``,`Patch: ${patchPath}`,`QA: ${qaPath}`,``,`## Gates`,gateLines || '- none',``,`## Security requirements`,securityLines,''].join('\n');
        writeFileSync(reviewPath,text,{mode:0o600});
        r.review={directory:root,candidateDirectory:candidate,patchPath,qaPath,reviewPath,candidateSha:final.candidateSha};
        this.save(doc,'workflow.review_workspace_ready',{review:r.review});
    }

    private async reviewable(r: SpecRecord): Promise<Run> {
        this.approved(r);
        invariant(r.finalRunId, 'STATE', 'No integrated candidate');
        const final = this.pipeline.store.get(r.finalRunId);
        invariant(final.candidateSha === r.currentSha, 'CANDIDATE', 'Final candidate is stale');
        const evidenceHash = await this.pipeline.assertValidated(final.id);
        if (r.config.workflow.qaLanes.includes(final.risk!.lane))
            invariant(r.qa && r.qa.specHash === r.contentHash && r.qa.evidenceHash === evidenceHash && r.qa.report.candidateSha === final.candidateSha && r.qa.report.verdict === 'pass', 'QA_REQUIRED', 'A passing QA assessment must cover the exact candidate and evidence');
        return final;
    }
    /** Publication adapters still acquire the lifecycle lease and require explicit consent. */
    async publicationCandidate(id: string): Promise<Run> {
        const doc = this.get(id);
        invariant(!['closed', 'rejected'].includes(doc.data.status), 'STATE', 'Spec cannot be published');
        const final = await this.reviewable(doc.data);
        await this.pipeline.exportPatch(final.id);
        return final;
    }
    async review(id: string, sha: string, actor: string, note: string): Promise<Document<SpecRecord>> {
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            invariant(!['closed', 'rejected'].includes(doc.data.status), 'STATE', 'Spec cannot be reviewed');
            const final = await this.reviewable(doc.data);
            const run = await this.pipeline.approve(final.id, sha, actor, note);
            doc.data.status = run.state === 'ready' ? 'ready' : 'awaiting_review';
            doc.data.error = null;
            this.save(doc, 'spec.reviewed', { runId: run.id, reviewer: actor, candidateSha: sha });
            return doc;
        }
        finally {
            this.store.releaseDocument(id, token);
        }
    }
    async importQa(id: string, value: unknown): Promise<Document<SpecRecord>> {
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            const r = doc.data;
            const spec = this.approved(r);
            invariant(r.finalRunId && !['closed', 'rejected', 'delivered'].includes(r.status), 'STATE', 'QA requires a pending integrated candidate');
            const final = this.pipeline.store.get(r.finalRunId);
            const evidenceHash = await this.pipeline.assertValidated(final.id);
            const qa: QaRecord = { report: validateQa(value, spec, final.candidateSha!, r.decisionLedger), evidenceHash, specHash: r.contentHash!, at: Date.now(), source: 'operator-import' };
            this.pipeline.invalidateApprovals(final.id, 'QA assessment imported/replaced');
            r.qa = qa;
            r.status = 'running';
            r.error = null;
            this.save(doc, 'qa.imported', { qa });
            return doc;
        }
        finally {
            this.store.releaseDocument(id, token);
        }
    }
    reject(id: string, note: string): Document<SpecRecord> {
        invariant(note.trim().length >= 10, 'REVIEW', 'Meaningful rejection reason required');
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            invariant(doc.data.status !== 'closed', 'STATE', 'Already merged/closed');
            doc.data.status = 'rejected';
            doc.data.error = { code: 'REJECTED', message: note };
            this.save(doc, 'spec.rejected', { note });
            return doc;
        }
        finally {
            this.store.releaseDocument(id, token);
        }
    }
    async verify(id: string, signal?: AbortSignal): Promise<Document<SpecRecord>> {
        const token = this.store.acquireDocument(id);
        let doc: Document<SpecRecord> | undefined;
        let started: number | undefined;
        let timer: NodeJS.Timeout | undefined;
        try {
            doc = this.get(id);
            const r = doc.data;
            this.approved(r);
            invariant(r.finalRunId && !['closed', 'rejected'].includes(r.status), 'STATE', 'Nothing to revalidate');
            invariant(r.sessionStartedAt === null, 'RECOVERY', 'Recover the previous workflow session first');
            const remaining = r.config.workflow.maxActiveMs - r.activeMs;
            invariant(remaining > 0, 'BUDGET', 'Spec active budget exhausted');
            const controller = new AbortController();
            timer = setTimeout(() => controller.abort(), remaining);
            const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
            started = performance.now();
            r.sessionStartedAt = Date.now();
            r.activeRunId = r.finalRunId;
            r.qa = null;
            r.delivery = null;
            r.status = 'running';
            this.save(doc, 'integration.revalidation_requested', { approvalsInvalidated: true });
            const run = await this.pipeline.revalidate(r.finalRunId, { signal: combined });
            r.error = run.error;
            r.status = ['ready', 'awaiting_review'].includes(run.state) ? 'running' : 'blocked';
            if (['ready', 'awaiting_review'].includes(run.state))
                r.activeRunId = null;
            this.save(doc, 'integration.revalidated', { runId: run.id, state: run.state });
            return doc;
        }
        catch (error) {
            if (doc && started !== undefined) {
                doc.data.status = 'blocked';
                doc.data.error = { code: error instanceof PipelineError ? error.code : 'WORKFLOW', message: errorMessage(error) };
                this.save(doc, 'integration.revalidation_failed', { error: doc.data.error });
                return doc;
            }
            throw error;
        }
        finally {
            if (timer)
                clearTimeout(timer);
            if (doc && started !== undefined) {
                doc.data.activeMs += Math.max(0, performance.now() - started);
                doc.data.sessionStartedAt = null;
                this.save(doc, 'workflow.session_finished', { activeMs: doc.data.activeMs });
            }
            this.store.releaseDocument(id, token);
        }
    }
    async retry(id: string, confirmed: boolean): Promise<Document<SpecRecord>> {
        invariant(confirmed, 'CONFIRM', 'Explicitly confirm an additional attempt');
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            const r = doc.data;
            this.approved(r);
            invariant(r.status === 'blocked' && r.activeRunId, 'STATE', 'No failed active attempt to retry');
            const failed = this.pipeline.store.get(r.activeRunId);
            invariant(failed.state === 'failed', 'STATE', 'Only terminal failures can be retried; interrupted runs need resume/recovery');
            if (r.finalRunId === r.activeRunId) {
                r.finalRunId = null;
                r.activeRunId = null;
            }
            else {
                const attempt = r.attempts.find(a => a.runId === failed.id);
                invariant(attempt, 'STATE', 'Failed attempt missing from history');
                const replacement = await this.pipeline.create({ repo: r.repo, baseRef: failed.baseSha, config: failed.config, task: failed.task });
                r.attempts.push({ ...attempt, runId: replacement.id });
                r.activeRunId = replacement.id;
            }
            r.status = 'running';
            r.error = null;
            this.save(doc, 'workflow.retry_authorized', { previousRunId: failed.id, replacementRunId: r.activeRunId });
            return doc;
        }
        finally {
            this.store.releaseDocument(id, token);
        }
    }
    recover(id: string, confirmed: boolean): Document<SpecRecord> {
        this.store.recoverDocument(id, confirmed);
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            const r = doc.data;
            if (r.activeRunId)
                this.pipeline.recover(r.activeRunId, confirmed);
            if (r.sessionStartedAt !== null) {
                r.activeMs += Math.max(0, Date.now() - r.sessionStartedAt);
                r.sessionStartedAt = null;
            }
            if (!['closed', 'rejected'].includes(r.status))
                r.status = r.approval ? 'blocked' : 'draft';
            this.save(doc, 'workflow.recovered', { budgetAccounting: 'Conservatively includes crash interval' });
            return doc;
        }
        finally {
            this.store.releaseDocument(id, token);
        }
    }
    async deliver(id: string, directory: string): Promise<Document<SpecRecord>> {
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            const r = doc.data;
            invariant(!['closed', 'rejected'].includes(r.status), 'STATE', 'Cannot deliver closed/rejected spec');
            const final = await this.reviewable(r);
            const patch = await this.pipeline.exportPatch(final.id);
            const output = resolve(directory);
            invariant(!isInside(r.repo, output) && !isInside(this.store.root, output), 'OUTPUT_PATH', 'Deliver outside source and operational state');
            // Resolve existing ancestors before creating directories: an external path
            // may otherwise redirect through a symlink into the source or state.
            let ancestor = dirname(output);
            while (!existsSync(ancestor))
                ancestor = dirname(ancestor);
            const physical = resolve(realpathSync(ancestor), relative(ancestor, output));
            invariant(!isInside(realpathSync(r.repo), physical) && !isInside(realpathSync(this.store.root), physical), 'OUTPUT_PATH', 'Delivery path redirects into source or operational state');
            if (r.delivery?.directory === output && r.delivery.candidateSha === final.candidateSha) {
                const manifest = readFileSync(join(output, 'manifest.json'), 'utf8');
                invariant(sha256(manifest) === r.delivery.manifestHash, 'DELIVERY', 'Existing delivery manifest changed');
                const files = JSON.parse(manifest) as Record<string, string>;
                for (const [name, digest] of Object.entries(files))
                    invariant(sha256(readFileSync(join(output, name))) === digest, 'DELIVERY', 'Existing delivery file changed');
                return doc;
            }
            invariant(!existsSync(output), 'EXISTS', 'Delivery destination already exists');
            mkdirSync(dirname(output), { recursive: true });
            const staging = join(dirname(output), `.apv2-delivery-${randomUUID()}`);
            mkdirSync(staging, { mode: 0o700 });
            const files: Record<string, string> = { 'candidate.patch': patch, 'spec.md': specMarkdown(r, id), 'evidence.json': JSON.stringify({ specId: id, specHash: r.contentHash, productApproval: r.approval, qa: r.qa, run: summarize(final), receipts: final.receipts, approvals: final.approvals }, null, 2) + '\n', 'events.jsonl': this.store.documentEvents(id).map(e => JSON.stringify(e)).join('\n') + '\n', 'run-events.jsonl': [...new Set([...r.attempts.map(a => a.runId), ...r.validationRunIds])].flatMap(runId => this.store.events(runId)).map(e => JSON.stringify(e)).join('\n') + '\n' };
            const manifest = JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)])), null, 2) + '\n';
            try {
                for (const [name, text] of Object.entries(files))
                    writeFileSync(join(staging, name), text, { flag: 'wx', mode: 0o600 });
                writeFileSync(join(staging, 'manifest.json'), manifest, { flag: 'wx', mode: 0o600 });
                invariant(!existsSync(output), 'EXISTS', 'Delivery target appeared during preparation');
                renameSync(staging, output);
            }
            catch (error) {
                rmSync(staging, { recursive: true, force: true });
                throw error;
            }
            r.delivery = { directory: output, candidateSha: final.candidateSha!, manifestHash: sha256(manifest) };
            r.status = 'delivered';
            this.save(doc, 'spec.delivered', { delivery: r.delivery });
            return doc;
        }
        finally {
            this.store.releaseDocument(id, token);
        }
    }
    async branch(id: string, name: string, confirmed: boolean): Promise<Document<SpecRecord>> {
        invariant(confirmed, 'CONFIRM', 'Creating a local branch requires explicit confirmation');
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            invariant(!['closed', 'rejected'].includes(doc.data.status), 'STATE', 'Cannot branch closed/rejected spec');
            const final = await this.reviewable(doc.data);
            await this.pipeline.exportPatch(final.id);
            const git = new Git();
            await git.exec(doc.data.repo, ['check-ref-format', `refs/heads/${name}`]);
            const refs = (await git.exec(doc.data.repo, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/heads/${name}`])).trim();
            if (refs)
                invariant(refs === `refs/heads/${name} ${final.candidateSha}`, 'BRANCH_CONFLICT', 'Branch already exists at another commit');
            else
                await git.exec(doc.data.repo, ['update-ref', `refs/heads/${name}`, final.candidateSha!, '0'.repeat(final.candidateSha!.length)]);
            this.save(doc, 'delivery.branch_created', { branch: name, candidateSha: final.candidateSha });
            return doc;
        }
        finally {
            this.store.releaseDocument(id, token);
        }
    }
    async closeLocal(id: string, ref: string, mergeSha: string, actor: string, note: string): Promise<Document<SpecRecord>> {
        reviewer(actor, note);
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            const r = doc.data;
            this.approved(r);
            invariant(r.delivery && r.finalRunId && r.status === 'delivered', 'STATE', 'Deliver the validated candidate before observing a local integration');
            const git = new Git();
            await git.exec(r.repo, ['check-ref-format', `refs/heads/${ref}`]);
            const observed = await git.sha(r.repo, `refs/heads/${ref}`);
            invariant(observed === mergeSha, 'MERGE_SHA', 'Name the exact observed integration head');
            await git.exec(r.repo, ['merge-base', '--is-ancestor', r.delivery.candidateSha, mergeSha]);
            r.status = 'closed';
            this.save(doc, 'spec.closed', { source: 'local-git-observation', target: ref, mergeSha, candidateSha: r.delivery.candidateSha, reviewer: actor, note, notADeployment: true });
            return doc;
        }
        finally {
            this.store.releaseDocument(id, token);
        }
    }
    summary(doc: Document<SpecRecord>): Record<string, unknown> {
        const r = doc.data;
        const final = r.finalRunId ? this.pipeline.store.get(r.finalRunId) : null;
        let next: string;
        if (!r.approval)
            next = (r.content?.questions.length || r.design?.proposal.questions.length) ? `apv2 spec refine ${doc.id} --request "answers to the displayed questions"` : `apv2 spec approve ${doc.id} --hash ${approvalHash(r) ?? 'NO_VALID_PROPOSAL'} --approve`;
        else if (r.status === 'awaiting_review')
            next = `apv2 spec review ${doc.id} --sha ${final?.candidateSha} --approve`;
        else if (r.publication?.url && r.status !== 'closed' && r.status !== 'rejected')
            next = `apv2 spec sync ${doc.id}`;
        else if (r.status === 'ready')
            next = `apv2 spec deliver ${doc.id} --output /path/to/new-delivery`;
        else if (r.status === 'delivered')
            next = `apv2 spec branch ${doc.id} --name feature/my-change --confirm`;
        else if (r.status === 'closed' || r.status === 'rejected')
            next = 'No automatic action; create a new spec for additional changes.';
        else if (r.error?.code === 'QA_REQUIRED')
            next = `apv2 spec qa ${doc.id} --file /path/to/qa-report.json`;
        else
            next = `apv2 spec run ${doc.id}`;
        return { id: doc.id, revision: r.revision, status: r.status, title: r.content?.title ?? null, hash: approvalHash(r), specHash:r.contentHash, security:{contextHash:r.securityContextHash,minimumLane:r.securityContext.minimumLane,requiresThreatModel:r.securityContext.requiresThreatModel,topics:r.securityContext.topics.map(x=>x.id),requirements:r.content?.security.requirements.map(x=>x.id) ?? []}, design:r.design ? {hash:r.design.hash,directory:r.design.directory,indexPath:r.design.indexPath,summary:r.design.proposal.summary,questions:r.design.proposal.questions} : null, baseSha: r.baseSha, candidateSha: r.currentSha, questions: r.content?.questions ?? [], tasks: r.content?.tasks.map(t => ({ id: t.id, title: t.title, done: r.completedTaskIds.includes(t.id), dependsOn: t.dependsOn })) ?? [], attempts: r.attempts, validationRunIds: r.validationRunIds, activeRunId: r.activeRunId, finalRun: final ? summarize(final) : null, qa: r.qa, activeMs: Math.round(r.activeMs), error: r.error, delivery: r.delivery, publication: r.publication, nextAction: next, approvalIdentityWarning: 'Local reviewer labels are not authenticated identities.' };
    }
}
