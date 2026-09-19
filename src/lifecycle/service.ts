import { phaseTimings } from './timings.js';
import { stopAdvice } from '../adapters/stops.js';
import { executionAgent, specCostCeiling } from '../adapters/billing.js';
import { assertRequiredEvidence, qualityContext, qualityMarkdown, findingRequiresFix } from '../quality/review.js';
import { roleAgent, modelPlan, modelChoice, applyModelOverrides } from '../adapters/routing.js';
import { adaptiveConfig, architectureSchema, briefSpecSchema, expandBrief, requiresQa, selectPath, pathDecision, targetedQaContext } from './pathways.js';
import { compactProposal } from './compact.js';
import { focusedIntelligence } from '../knowledge/focus.js';
import { pathsMentioned } from '../security/change-signals.js';
import { specCosts } from '../adapters/invocations.js';
import { replanContext, replanHash, revisedContent } from './replan.js';
import { mkdirSync, writeFileSync, renameSync, existsSync, lstatSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, relative, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pipeline, summarize } from '../engine/pipeline.js';
import { validateConfig, agentSchema, gateSchema, taskSchema, DEFAULT_LIMITS, type Config, type Run, type Task } from '../domain/contracts.js';
import { hash, sha256 } from '../domain/hash.js';
import { PipelineError, errorMessage, invariant } from '../domain/errors.js';
import { Git, isInside } from '../execution/git.js';
import type { Document } from '../persistence/store.js';
import { specSchema, qaSchema, designProposalSchema, validateSpec, assertSpecReadiness, criterionAmendmentHash, type CriterionAmendment, validateQa, specHash, approvalHash, specMarkdown, stricter, reviewer, type SpecRecord, type Spec, type QaRecord, type ScopeAmendment, type DesignProposal } from './contracts.js';
import { runRole } from './roles.js';
import { executionCapabilities, validateTaskCapabilities } from './capabilities.js';
import { matches, validateDag, requiredApprovals, type ReviewMode } from '../policy/policy.js';
import { inspectRepository } from '../knowledge/repository.js';
import { buildInventory, diffInventory, inventoryMarkdown, testsReferencing, type Inventory, type InventoryDelta } from '../knowledge/inventory.js';
import type { LanguageProfile } from '../domain/knowledge.js';
import { confirmedDecisions, ledgerHash, loadDecisionLedger } from './decisions.js';
import { assessSecurity, neutralSecurityContext } from '../security/owasp.js';
const FORBIDDEN_TAG = /^(?:script|iframe|object|embed|link|meta|base|frame|frameset|applet|portal)$/i;
const FORBIDDEN_ATTRIBUTE = /^(?:src|srcdoc|srcset|data|background|lowsrc|dynsrc|xlink:href)$/i;
const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
/** Types a static preview can carry inline. No SVG: it is a scriptable document, not a picture. */
const ASSET_TYPES: Record<string, string> = {
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};
const MAX_ASSET_BYTES = 512 * 1024;
const MAX_ASSET_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_STYLESHEET_BYTES = 256 * 1024;
const MAX_STYLESHEET_TOTAL_BYTES = 512 * 1024;
/** Characters of approved mockup (markup plus stylesheet) a task may carry before it degrades to a reference. */
const DESIGN_CONTEXT_BUDGET = 60000;
/**
 * Above this many declared files, a task usually exceeds what one agent session completes: the provider stops
 * mid-work and the attempt yields nothing usable. Advisory only — the operator decides before approving.
 */
const TASK_PATHS_ADVICE = 8;
/** Share of a failed check's diagnostic handed to the retried attempt; diagnostics are already failure-centred. */
const PREVIOUS_DIAGNOSTIC_CHARS = 6000;
/** Everything the review workspace owns. The design bundle lives beside it and must survive its rebuilds. */
const REVIEW_ENTRIES = ['candidate', 'candidate.patch', 'QA.md', 'REVIEW.md', 'INVENTORY.md'];
/** Keep actionable execution causes when Product wraps a failed planning round. */
function planningError(error: unknown) {
    const code = error instanceof PipelineError && /^(?:PROVIDER_|MODEL_|AGENT_TIMEOUT$|COST_BUDGET$|BUDGET$)/.test(error.code) ? error.code : 'PRODUCT';
    return { code, message: errorMessage(error) };
}
/**
 * Elements and their attributes, quote-aware so a `>` inside an attribute value cannot end a tag early.
 * Text between tags is displayed content: a mockup may legitimately show `src=`, a URL or escaped markup
 * as text, and the validator must not confuse that with an element that loads something.
 */
export function scanTags(html: string): { name: string; attributes: { name: string; value: string }[] }[] {
    const tags: { name: string; attributes: { name: string; value: string }[] }[] = [];
    for (let i = html.indexOf('<'); i !== -1; i = html.indexOf('<', i)) {
        const opening = /^<\/?\s*([a-zA-Z][a-zA-Z0-9:._-]*)/.exec(html.slice(i));
        if (!opening) { i++; continue; } // A bare "<" in prose is text, not an element.
        let end = i + opening[0].length;
        for (let quote = ''; end < html.length; end++) {
            const c = html[end]!;
            if (quote) { if (c === quote) quote = ''; }
            else if (c === '"' || c === "'") quote = c;
            else if (c === '>') break;
        }
        const attributes = [...html.slice(i + opening[0].length, end).matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)]
            .map(m => ({ name: m[1]!, value: (m[2] ?? '').replace(/^(['"])([\s\S]*)\1$/, '$2') }));
        tags.push({ name: opening[1]!.toLowerCase(), attributes });
        i = end + 1;
    }
    return tags;
}
/** Freshly produced spec output that asks no question must already be executable; a draft with a question may not be. */
function readySpec(spec: Spec): Spec {
    return spec.questions.length === 0 ? assertSpecReadiness(spec) : spec;
}
export interface WorkflowOptions {
    signal?: AbortSignal;
    acceptCurrent?: boolean;
    acceptCost?: boolean;
    manualQa?: boolean;
}
export class Lifecycle {
    readonly pipeline: Pipeline;
    /** Inventories keyed by immutable commit SHA and language profiles; bounded, never invalidated. */
    private readonly inventories = new Map<string, Promise<Inventory>>();
    constructor(stateDir: string) { this.pipeline = new Pipeline(stateDir); }
    private inventoryAt(repo: string, sha: string, languages: readonly LanguageProfile[] = [], signal?: AbortSignal): Promise<Inventory> {
        invariant(/^[0-9a-f]{40,64}$/.test(sha), 'REPOSITORY_INDEX', 'Inventory cache requires an immutable commit SHA');
        const key = `${repo}\0${sha}\0${hash(languages)}`;
        let pending = this.inventories.get(key);
        if (!pending) {
            pending = buildInventory(repo, sha, { languages, ...(signal ? { signal } : {}) });
            pending.catch(() => this.inventories.delete(key));
            this.inventories.set(key, pending);
            while (this.inventories.size > 32) this.inventories.delete(this.inventories.keys().next().value!);
        }
        return pending;
    }
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
        const spec = validateSpec(r.content, true, r.decisionLedger, r.request, r.securityContext);
        // The stored content keeps exactly what the operator approved; corrections are applied on the way
        // out, each carrying its own approval, so the original text stays auditable.
        const corrections = (r.criterionAmendments ?? []).filter(a => a.status === 'approved');
        const scopes = r.scopeAmendments.filter(a => a.status === 'approved');
        if (!corrections.length && !scopes.length) return spec;
        const latest = [...corrections].reverse();
        const effective = { ...spec,
            acceptance: spec.acceptance.map(c => {
                const fix = latest.find(a => a.criterionId === c.id);
                return fix ? { ...c, description: fix.description, verification: fix.verification } : c;
            }),
            // Every role must see the paths the operator added, not only the Implementer: QA otherwise
            // reports an approved amendment as an out-of-scope change.
            tasks: spec.tasks.map(t => {
                const added = scopes.filter(a => a.taskId === t.id).flatMap(a => a.paths);
                return added.length ? { ...t, allowedPaths: [...new Set([...t.allowedPaths, ...added])] } : t;
            }),
            security: { ...spec.security, requirements: spec.security.requirements.map(q => {
                const fix = latest.flatMap(a => a.requirements ?? []).find(x => x.id === q.id);
                const reviews = latest.flatMap(a => a.requirements ?? []).filter(x => x.id === q.id).flatMap(x => x.reviewTests ?? []);
                const amendedTests = latest.flatMap(a => a.requirements ?? []).find(x => x.id === q.id && x.negativeTests)?.negativeTests ?? q.negativeTests;
                return { ...q, ...(fix ? { verification: fix.verification } : {}),
                    negativeTests: amendedTests.map((text, index) => reviews.some(x => x.index === index) && !text.startsWith('[review] ') ? `[review] ${text}` : text) };
            }) },
        };
        return validateSpec(effective, true, r.decisionLedger, r.request, r.securityContext);
    }
    /** See SpecRecord.impactAdvice. Tasks are walked in dependency order, like execution. */
    private async impactAdvice(r: SpecRecord, spec: Spec, signal?: AbortSignal): Promise<NonNullable<SpecRecord['impactAdvice']>> {
        const inventory = await this.inventoryAt(r.repo, r.baseSha, r.config.knowledge?.languages ?? [], signal);
        // The spec is already validated against its ledger; order it without revalidating (taskOrder would
        // check it against an empty ledger and reject any spec covering a project decision).
        const order: Spec['tasks'] = []; const done = new Set<string>();
        const visit = (t: Spec['tasks'][number]): void => { if (done.has(t.id)) return; done.add(t.id); t.dependsOn.forEach(id => { const dep = spec.tasks.find(x => x.id === id); if (dep) visit(dep); }); order.push(t); };
        spec.tasks.forEach(visit);
        const covers = (t: Spec['tasks'][number], path: string) => t.allowedPaths.some(p => matches(path, p));
        const advice: NonNullable<SpecRecord['impactAdvice']> = [];
        for (const [i, task] of order.entries()) {
            const changed = task.allowedPaths.filter(p => !/[*?]/.test(p) && !/(^|[./_-])(test|spec)s?([./_-]|$)/i.test(p));
            for (const ref of await testsReferencing(r.repo, inventory, changed, signal)) {
                if (covers(task, ref.path) || order.slice(0, i).some(t => covers(t, ref.path))) continue;
                if (advice.some(a => a.test === ref.path)) continue;
                const later = order.slice(i + 1).find(t => covers(t, ref.path));
                // A test no task declares is only reported on direct evidence: a path fragment alone matched
                // many tests that the change never broke.
                if (!later && !ref.resolved) continue;
                advice.push({ test: ref.path, changedBy: task.id, assignedTo: later?.id ?? null, tokens: ref.tokens, evidence: later ? 'declared-later' : 'resolved-import' });
            }
        }
        return advice;
    }
    /**
     * What each completed attempt reported. A criterion may require the Implementer to report something
     * (an observation outside scope, a limitation); without these summaries QA can only answer "unknown".
     */
    private taskSummaries(r: SpecRecord): { taskId: string; kind: string; state: string; summary: string }[] {
        return r.attempts.map(a => {
            const run = this.pipeline.store.get(a.runId);
            return { taskId: a.taskId, kind: a.kind, state: run.state, summary: (run.summary ?? '').slice(0, 6000) };
        }).filter(x => x.summary.length > 0);
    }
    /** Operator decisions made after approval, shown to QA with their reasons: they postdate the spec text. */
    private approvedAmendments(r: SpecRecord) {
        return {
            criteria: (r.criterionAmendments ?? []).filter(a => a.status === 'approved').map(a => ({ criterionId: a.criterionId, previous: a.previous, description: a.description, verification: a.verification, requirements: a.requirements ?? [], reason: a.reason, reviewer: a.reviewer, note: a.note })),
            plans: (r.planRevisions ?? []).filter(p => p.status === 'approved').map(p => ({ reason: p.reason, taskIds: p.tasks.map(t => t.id), hash: p.hash, approval: p.approval })),
            scope: r.scopeAmendments.filter(a => a.status === 'approved').map(a => ({ taskId: a.taskId, paths: a.paths, reason: a.reason, reviewer: a.reviewer, note: a.note })),
        };
    }
    async draft(options: {
        repo: string;
        config: unknown;
        request: string;
        proposal?: unknown;
        compactTask?: unknown;
        pathway?: 'auto' | 'standard' | 'structural';
        signal?: AbortSignal;
    }): Promise<Document<SpecRecord>> {
        invariant(options.request.trim().length > 0 && options.request.length <= 30000, 'REQUEST', 'Provide a request up to 30000 characters');
        const git = new Git();
        const repo = await git.root(options.repo);
        await git.clean(repo);
        const baseSha = await git.sha(repo);
        await git.compatible(repo, baseSha);
        invariant(!isInside(repo, this.store.root) && !isInside(this.store.root, repo), 'STATE_PATH', 'State and project must be disjoint');
        invariant(options.pathway === undefined || ['auto', 'standard', 'structural'].includes(options.pathway), 'ARGUMENT', 'Unknown execution pathway');
        invariant(options.compactTask === undefined || options.proposal === undefined && options.pathway === undefined, 'ARGUMENT', 'Compact task cannot be combined with a proposal or pathway');
        const parsedConfig = validateConfig(options.config);
        const config = options.pathway || options.compactTask !== undefined ? adaptiveConfig(parsedConfig) : parsedConfig;
        const decisionLedger = await loadDecisionLedger(repo, baseSha);
        const r: SpecRecord = { repo, baseSha, config, configHash: hash(config), revision: 1, request: options.request, decisionLedger, decisionLedgerHash: ledgerHash(decisionLedger), securityContext: neutralSecurityContext(), securityContextHash: hash(neutralSecurityContext()), content: null, contentHash: null, approval: null, status: 'draft', attempts: [], completedTaskIds: [], currentSha: baseSha, activeRunId: null, finalRunId: null, validationRunIds: [], qa: null, qaRepairs: 0, design: null, scopeAmendments: [], review: null, sessionStartedAt: null, activeMs: 0, delivery: null, publication: null, error: null };
        if (config.workflow.planningMode === 'adaptive') r.executionPath = options.compactTask !== undefined ? 'compact' : options.pathway === 'structural' ? 'structural' : 'standard';
        const proposal = options.compactTask !== undefined ? compactProposal(options.compactTask, options.request, config) : options.proposal;
        const doc = this.store.createDocument('spec', r);
        const token = this.store.acquireDocument(doc.id);
        try {
            await this.product(doc, proposal, options.signal);
            return doc;
        }
        catch (error) {
            r.error = planningError(error);
            this.save(doc, 'product.failed', { error: r.error });
            throw new PipelineError(r.error.code, `Spec ${doc.id}: ${errorMessage(error)}`, { cause: error });
        }
        finally {
            this.store.releaseDocument(doc.id, token);
        }
    }
    private requiresDesign(spec: Spec, projectType: string): boolean {
        if (!['frontend', 'mobile', 'fullstack'].includes(projectType))
            return false;
        if (spec.experience.uiImpact === 'minor') return false;
        if (spec.experience.uiImpact === 'major') return true;
        // Product's declared uiImpact is authoritative; this fallback only reads generic interface vocabulary, never framework file types.
        const text = [spec.title, spec.problem, ...spec.scope, ...spec.tasks.flatMap(t => [t.title, t.description])].join(' ');
        return /(?:\bui\b|user interface|interface utilisateur|screen|dashboard|\bform\b|modal|layout|écran|ecran|tableau de bord|formulaire)/i.test(text);
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
        const declared = new Set(p.assets?.map(a => a.id) ?? []);
        for (const screen of p.screens) {
            const where = `design screen ${screen.id}`;
            for (const tag of scanTags(screen.bodyHtml)) {
                invariant(!FORBIDDEN_TAG.test(tag.name), 'DESIGN_MARKUP', `Unsafe <${tag.name}> element in ${where}; a mockup is static markup`);
                for (const attribute of tag.attributes) {
                    invariant(!/^on/i.test(attribute.name), 'DESIGN_MARKUP', `Event handler ${attribute.name} in ${where}; a mockup carries no behaviour`);
                    invariant(!FORBIDDEN_ATTRIBUTE.test(attribute.name), 'DESIGN_MARKUP', `Attribute ${attribute.name} in ${where} loads external content; declare a repository file in assets and use url(asset:ID) instead`);
                    invariant(!/^\s*(?:javascript|data|vbscript):/i.test(attribute.value), 'DESIGN_MARKUP', `Executable URL in ${attribute.name} of ${where}`);
                    if (/^(?:href|action|formaction|cite|ping)$/i.test(attribute.name))
                        invariant(!/^\s*(?:https?:|\/\/)/i.test(attribute.value), 'DESIGN_MARKUP', `Remote ${attribute.name} in ${where}; link mockup screens to each other or to # only`);
                    if (/^style$/i.test(attribute.name)) this.validateDesignUrls(attribute.value, declared, `style attribute of ${where}`);
                }
            }
        }
        invariant(!/@import\b|expression\s*\(|javascript:/i.test(p.css), 'DESIGN_MARKUP', 'Design CSS cannot import stylesheets or carry executable content');
        this.validateDesignUrls(p.css, declared, 'design CSS');
    }
    /** url() is allowed only as url(asset:ID) for a repository file the proposal declares; the controller inlines it. */
    private validateDesignUrls(css: string, declared: ReadonlySet<string>, where: string): void {
        for (const [, , target] of css.matchAll(CSS_URL)) {
            const asset = /^asset:(.+)$/i.exec(target!.trim())?.[1];
            invariant(asset, 'DESIGN_MARKUP', `url(${target!.slice(0, 80)}) in ${where} is not allowed; reference a declared repository file as url(asset:ID)`);
            invariant(declared.has(asset), 'DESIGN_MARKUP', `url(asset:${asset}) in ${where} is not declared in assets`);
        }
    }
    /**
     * Preview copy of the proposal with every url(asset:ID) replaced by an inline data: URI read from the
     * repository. Previews stay a single self-contained file with no network access, so the mockup can show
     * the project's real typography instead of a substitute.
     */
    private inlineDesignAssets(repo: string, sha: string, tracked: ReadonlySet<string>, p: DesignProposal): { css: string; bodyHtml: Map<string, string>; used: { id: string; path: string; bytes: number }[] } {
        const used: { id: string; path: string; bytes: number }[] = [];
        const uris = new Map<string, string>();
        let total = 0;
        const load = (id: string): string => {
            const existing = uris.get(id);
            if (existing) return existing;
            const asset = (p.assets ?? []).find(a => a.id === id);
            invariant(asset, 'DESIGN_ASSET', `Design references undeclared asset ${id}`);
            const file = resolve(repo, asset.path);
            invariant(isInside(repo, file) && existsSync(file), 'DESIGN_ASSET', `Design asset ${id} must be an existing repository file`);
            // Lexical containment is not physical containment: a directory of the repository can itself be a
            // symlink pointing outside it. Only the resolved path decides, and only tracked content is read.
            invariant(isInside(realpathSync(repo), realpathSync(file)), 'DESIGN_ASSET', `Design asset ${id} resolves outside the repository`);
            invariant(tracked.has(relative(realpathSync(repo), realpathSync(file))), 'DESIGN_ASSET', `Design asset ${id} is not a file tracked at the reviewed commit ${sha.slice(0, 12)}`);
            const stat = lstatSync(file);
            invariant(stat.isFile(), 'DESIGN_ASSET', `Design asset ${id} must be a regular file, not a symlink or directory`);
            const type = ASSET_TYPES[(/\.[a-z0-9]+$/i.exec(file)?.[0] ?? '').toLowerCase()];
            invariant(type, 'DESIGN_ASSET', `Design asset ${id} has an unsupported type; use ${Object.keys(ASSET_TYPES).join(', ')}`);
            invariant(stat.size <= MAX_ASSET_BYTES, 'DESIGN_ASSET', `Design asset ${id} exceeds ${MAX_ASSET_BYTES} bytes`);
            total += stat.size;
            invariant(total <= MAX_ASSET_TOTAL_BYTES, 'DESIGN_ASSET', `Design assets exceed ${MAX_ASSET_TOTAL_BYTES} bytes in total`);
            const uri = `data:${type};base64,${readFileSync(file).toString('base64')}`;
            uris.set(id, uri);
            used.push({ id, path: asset.path, bytes: stat.size });
            return uri;
        };
        const substitute = (text: string): string => text.replace(CSS_URL, (whole, _quote: string, target: string) => {
            const id = /^asset:(.+)$/i.exec(target.trim())?.[1];
            return id ? `url("${load(id)}")` : whole;
        });
        return { css: substitute(p.css), bodyHtml: new Map(p.screens.map(s => [s.id, substitute(s.bodyHtml)])), used };
    }
    /**
     * The spec whose approved visual direction a new design for `repo` continues: the most recently approved,
     * non-rejected spec with a design. Maintenance uses the same rule to keep that document.
     */
    designReference(repo: string, excludeId?: string): Document<SpecRecord> | undefined {
        return this.store.documents<SpecRecord>('spec')
            .filter(d => d.id !== excludeId && d.data.repo === repo && d.data.design && d.data.approval && d.data.status !== 'rejected')
            .sort((a, b) => (b.data.approval?.at ?? 0) - (a.data.approval?.at ?? 0))[0];
    }
    /** Files tracked at one commit: a design asset must be repository content at the reviewed commit, not whatever the working tree happens to hold. */
    private async trackedPaths(repo: string, sha: string, signal?: AbortSignal): Promise<ReadonlySet<string>> {
        const listing = await new Git(signal).exec(repo, ['ls-tree', '-r', '--name-only', '-z', sha]);
        return new Set(listing.split('\0').filter(Boolean));
    }
    /**
     * Project stylesheets the preview loads before the proposal's css. Same containment as assets (tracked at
     * the reviewed commit, physically inside the repository), plain CSS only, and never text that could close
     * the style element and inject markup into the preview.
     */
    private loadDesignStylesheets(repo: string, sha: string, tracked: ReadonlySet<string>, p: DesignProposal): { css: string; loaded: { path: string; bytes: number }[] } {
        const loaded: { path: string; bytes: number }[] = []; const parts: string[] = []; let total = 0;
        for (const sheet of p.stylesheets ?? []) {
            const file = resolve(repo, sheet.path);
            invariant(isInside(repo, file) && existsSync(file), 'DESIGN_ASSET', `Design stylesheet ${sheet.path} must be an existing repository file`);
            const real = relative(realpathSync(repo), realpathSync(file));
            invariant(isInside(realpathSync(repo), realpathSync(file)) && tracked.has(real), 'DESIGN_ASSET', `Design stylesheet ${sheet.path} is not a file tracked at the reviewed commit ${sha.slice(0, 12)}`);
            invariant(/\.css$/i.test(file) && lstatSync(file).isFile(), 'DESIGN_ASSET', `Design stylesheet ${sheet.path} must be a plain .css file`);
            const size = lstatSync(file).size;
            invariant(size <= MAX_STYLESHEET_BYTES, 'DESIGN_ASSET', `Design stylesheet ${sheet.path} exceeds ${MAX_STYLESHEET_BYTES} bytes`);
            total += size;
            invariant(total <= MAX_STYLESHEET_TOTAL_BYTES, 'DESIGN_ASSET', `Design stylesheets exceed ${MAX_STYLESHEET_TOTAL_BYTES} bytes in total`);
            const text = readFileSync(file, 'utf8');
            invariant(!/<\/\s*style/i.test(text), 'DESIGN_ASSET', `Design stylesheet ${sheet.path} contains text that would close the style element`);
            parts.push(`/* ${real} */\n${text}`);
            loaded.push({ path: real, bytes: size });
        }
        return { css: parts.join('\n'), loaded };
    }
    /**
     * Visual direction already approved for this repository, if any. Passing it to the design role turns a
     * full re-derivation into an extension: the mockup keeps one direction across increments and only covers
     * screens the new spec creates or changes.
     */
    private establishedDesign(currentId: string, repo: string): { specId: string; specTitle: string; approvedAt: number; visualDirection: string; decisions: DesignProposal['decisions']; avoid: string[]; assets: DesignProposal['assets']; stylesheets: DesignProposal['stylesheets']; screens: { id: string; title: string; purpose: string }[] } | null {
        const previous = this.designReference(repo, currentId);
        if (!previous?.data.design) return null;
        const proposal = previous.data.design.proposal;
        return { specId: previous.id, specTitle: previous.data.content?.title ?? previous.id, approvedAt: previous.data.approval?.at ?? 0,
            visualDirection: proposal.visualDirection, decisions: proposal.decisions, avoid: proposal.avoid, assets: proposal.assets ?? [], stylesheets: proposal.stylesheets ?? [],
            screens: proposal.screens.map(s => ({ id: s.id, title: s.title, purpose: s.purpose })) };
    }
    private validateDesignScopes(p: DesignProposal, spec: Spec): void {
        const tasks = new Set(spec.tasks.map(t => t.id)); const screens = new Set(p.screens.map(x => x.id));
        invariant(new Set(p.taskScopes.map(x => x.taskId)).size === p.taskScopes.length, 'DESIGN_MARKUP', 'Duplicate design taskScopes entry');
        for (const scope of p.taskScopes) {
            invariant(tasks.has(scope.taskId), 'DESIGN_MARKUP', `Design taskScopes references unknown task ${scope.taskId}`);
            for (const screen of scope.screenIds) invariant(screens.has(screen), 'DESIGN_MARKUP', `Design taskScopes references unknown screen ${screen}`);
        }
    }
    private htmlEscape(text: string): string {
        return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    }
    private async prepareDesignProposal(doc: Document<SpecRecord>, repositoryIntelligence: unknown, signal?: AbortSignal): Promise<void> {
        const r = doc.data;
        invariant(r.content, 'DESIGN', 'Spec required before design');
        const established = this.establishedDesign(doc.id, r.repo);
        const tracked = await this.trackedPaths(r.repo, r.baseSha, signal);
        const context = {
            mode: 'design-proposal', request: r.request, spec: r.content, decisionLedger: r.decisionLedger, repositoryIntelligence, securityContext: r.securityContext,
            establishedDesign: established,
            instructions: [
                'Create a concrete visual mockup before implementation. Use the ui-design skill and existing design system/assets if present.',
                'Avoid generic AI-dashboard aesthetics and unjustified gradients/cards. Explain visual decisions, alternatives and tradeoffs.',
                'Cover meaningful loading, empty, error, success, focus and responsive states.',
                'Return static HTML fragments and CSS only: no scripts, no behaviour, no network. Elements that load content (script, iframe, object, embed, link, meta, base), event-handler attributes and src/srcset attributes are refused, and so is a remote href or action. Escaped markup shown as text is fine.',
                'To show the project\'s own typography or images, declare the repository files in assets (id, repository-relative path, reason) and reference them as url(asset:ID) in css. The controller inlines them into the preview; url() with anything else, and @import, are refused.',
                'When the project has global stylesheets (plain .css files tracked in the repository), declare them in stylesheets: the preview loads them before your css. Then write in css only what the mockup adds or changes, reusing their classes and custom properties, instead of reproducing them. Their own url() references do not load in the preview; declare fonts through assets.',
                'Fill taskScopes: list every spec task that implements visual work with the screen ids it needs (an empty screenIds list for a task that only needs the shared direction, such as a shared style base). Do not list tasks without visual work; they receive no design context.',
                ...(established ? [
                    `A visual direction is already approved and implemented for this repository (establishedDesign, from spec ${established.specId}). Reuse it: keep its tokens, type scale, spacing, components and grammar. State it briefly in visualDirection as a continuation instead of deriving a new one, and do not restyle existing screens.`,
                    'Mock only the screens this spec creates or materially changes; name unchanged screens in rationale instead of reproducing them. Put in css only what is new or changed relative to the implemented stylesheet, reusing its existing class names and custom properties.',
                    'Propose a change to the established direction only if the operator asked for one or the spec makes it unavoidable; then say so explicitly in decisions.',
                ] : []),
            ],
        };
        const spec = r.content;
        const proposal = await runRole({ store: this.store, documentId: doc.id, budgetDocumentId: doc.id, repo: r.repo, sha: r.baseSha, role: 'product', skills: r.config.skills,
            modelPolicy: modelPlan(r.config, r.operational).find(m => m.role === 'design' && m.lane === (r.content!.minimumLane))?.decision, modelReason: modelChoice(r.config, 'design', r.content.minimumLane).reason, agent: roleAgent(r.config, 'design', r.content.minimumLane), passEnv: r.config.environment.passEnv, schema: designProposalSchema, context, ...(signal ? { signal } : {}),
            maxRepairs: r.config.workflow.maxOutputRepairs ?? 1, validate: value => { this.validateDesignMarkup(value); this.validateDesignScopes(value, spec); this.inlineDesignAssets(r.repo, r.baseSha, tracked, value); this.loadDesignStylesheets(r.repo, r.baseSha, tracked, value); return value; } });
        const root = resolve(dirname(r.repo), `${basename(r.repo)}-review`, doc.id, 'design');
        invariant(!isInside(r.repo, root) && !isInside(this.store.root, root), 'DESIGN_PATH', 'Design preview must be outside source and operational state');
        rmSync(root, { recursive: true, force: true });
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const screenPaths: string[] = [];
        const inlined = this.inlineDesignAssets(r.repo, r.baseSha, tracked, proposal);
        const project = this.loadDesignStylesheets(r.repo, r.baseSha, tracked, proposal);
        const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; script-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
        for (const screen of proposal.screens) {
            const file = join(root, `${screen.id}.html`);
            const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${this.htmlEscape(screen.title)}</title>${project.css ? `<style>${project.css}</style>` : ''}<style>${inlined.css}</style></head><body>${inlined.bodyHtml.get(screen.id) ?? screen.bodyHtml}</body></html>`;
            writeFileSync(file, html, { flag: 'wx', mode: 0o600 });
            screenPaths.push(file);
        }
        const indexPath = join(root, 'INDEX.md');
        const lines = ['# Design review', '', proposal.summary, '',
            ...(established ? [`Continues the visual direction approved for spec ${established.specId} (${established.specTitle}); screens listed below are the ones this spec creates or changes.`, ''] : []),
            ...(inlined.used.length ? [`Repository assets inlined in the previews: ${inlined.used.map(a => `${a.id} (${a.path})`).join(', ')}`, ''] : []),
            ...(project.loaded.length ? [`Project stylesheets loaded before the mockup css: ${project.loaded.map(x => x.path).join(', ')}`, ''] : []),
            `Rationale: ${proposal.rationale}`, '', `Visual direction: ${proposal.visualDirection}`, '',
            '## Screens', ...proposal.screens.flatMap((x, i) => [`- ${x.title}: ${screenPaths[i]}`, `  - Purpose: ${x.purpose}`, `  - States: ${x.states.join(', ') || 'default'}`, `  - Responsive: ${x.responsive}`]),
            '', '## Decisions', ...proposal.decisions.map(x => `- ${x.decision}: ${x.rationale}`), '', '## Avoid', ...proposal.avoid.map(x => `- ${x}`), '',
            'Open the HTML files above in a browser before approving the spec.'];
        writeFileSync(indexPath, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
        r.design = { proposal, hash: hash(proposal), directory: root, indexPath, screenPaths, generatedAt: Date.now(), reusedFrom: established?.specId ?? null, inlinedAssets: inlined.used, loadedStylesheets: project.loaded };
        this.save(doc, 'design.proposed', { hash: r.design.hash, directory: root, indexPath, screenPaths, questions: proposal.questions, reusedFrom: r.design.reusedFrom, inlinedAssets: inlined.used });
    }
    private async product(doc: Document<SpecRecord>, proposal: unknown, signal?: AbortSignal): Promise<void> {
        const r = doc.data;
        invariant(!r.planningStartedAt, 'RECOVERY', 'Recover interrupted planning before continuing');
        const remaining = (r.operational?.maxActiveMs ?? r.config.workflow.maxActiveMs) - r.activeMs - (r.planningMs ?? 0);
        invariant(remaining > 0, 'BUDGET', 'Spec planning and execution time budget exhausted');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), remaining);
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const started = performance.now();
        r.planningStartedAt = Date.now();
        this.save(doc, 'planning.started', { remainingMs: remaining });
        try { await this.buildProduct(doc, proposal, combined); }
        finally {
            clearTimeout(timer);
            r.planningMs = (r.planningMs ?? 0) + performance.now() - started;
            r.planningStartedAt = null;
            this.save(doc, 'planning.finished', { planningMs: r.planningMs });
        }
    }
    private async buildProduct(doc: Document<SpecRecord>, proposal: unknown, signal?: AbortSignal): Promise<void> {
        const r = doc.data;
        const repositoryIntelligence = await inspectRepository(r.repo, r.baseSha, `${r.request}
${r.decisionLedger.decisions.map(d=>`${d.subject}: ${d.value}`).join('\n')}`, { ...(signal ? { signal } : {}), inventory: await this.inventoryAt(r.repo, r.baseSha, r.config.knowledge?.languages ?? [], signal) });
        const securityContext = assessSecurity({ text: r.request, projectType: r.config.skills.projectType, files: pathsMentioned(r.request, [...repositoryIntelligence.relevantFiles, ...repositoryIntelligence.manifests, ...repositoryIntelligence.securityFiles]) });
        const scopedSecurity = (spec: Spec) => assessSecurity({ text: r.request, projectType: r.config.skills.projectType, files: [...pathsMentioned(r.request, [...repositoryIntelligence.relevantFiles, ...repositoryIntelligence.manifests, ...repositoryIntelligence.securityFiles]), ...spec.tasks.flatMap(t => t.allowedPaths).filter(p => !/[*?]/.test(p))] });
        if (r.executionPath) {
            const decision = pathDecision(r.request, securityContext, r.executionPath, r.decisionLedger.decisions.length);
            r.executionPath = decision.result.path;
            if (r.content) r.contentHash = specHash(r);
            this.save(doc, 'planning.path_selected', { path: r.executionPath, decision });
        }
        const selectedContext = r.executionPath ? focusedIntelligence(repositoryIntelligence) : repositoryIntelligence;
        const roleOptions = { store: this.store, documentId: doc.id, budgetDocumentId: doc.id, repo: r.repo, sha: r.baseSha, role: 'product' as const, skills: r.config.skills,
            modelPolicy: modelPlan(r.config, r.operational).find(m => m.role === 'product' && m.lane === (r.executionPath === 'structural' ? 'high' : securityContext.minimumLane))?.decision, modelReason: modelChoice(r.config, 'product', r.executionPath === 'structural' ? 'high' : securityContext.minimumLane).reason, agent: roleAgent(r.config, 'product', r.executionPath === 'structural' ? 'high' : securityContext.minimumLane), passEnv: r.config.environment.passEnv,
            ...(signal ? { signal } : {}), maxRepairs: r.config.workflow.maxOutputRepairs ?? 1 };
        if (r.executionPath === 'structural') {
            const tracked = new Set(await this.trackedPaths(r.repo, r.baseSha, signal));
            r.architecture = await runRole({ ...roleOptions, schema: architectureSchema,
                context: { mode: 'architecture-decision', request: r.request, decisionLedger: r.decisionLedger, securityContext, repositoryIntelligence: selectedContext,
                    instruction: 'Explore only relevant files. Explain the chosen boundaries, alternatives, tradeoffs and reconsideration triggers. Cite existing repository files inspected. Preserve confirmed decisions. This decision will be reviewed with the spec before implementation.' },
                validate: value => { const missing = value.inspection.filter(i => !tracked.has(i.path)).map(i => i.path); invariant(!missing.length, 'SPEC_ARCHITECTURE', `Architecture evidence must reference tracked paths at the baseline. Invalid paths: ${missing.join(', ')}. Put repository-wide observations in the summary, not in inspection paths.`); return value; } });
            if (r.content) r.contentHash = specHash(r);
            this.save(doc, 'architecture.proposed', { architecture: r.architecture });
        }
        const validateProposal = (spec: Spec) => readySpec(validateSpec(validateTaskCapabilities(spec, r.config), false, r.decisionLedger, r.request, scopedSecurity(spec)));
        const context = { request: r.request, planningGuidance: { mode: r.executionPath ?? (securityContext.minimumLane === 'high' ? 'structural' : 'standard'), instruction: 'Produce the smallest complete spec. Group related code and tests in cohesive tasks. Explore relevant files and reuse candidates; avoid repository-wide rereads and speculative architecture.' },
            architecture: r.architecture ?? null, previous: r.content, decisionLedger: r.decisionLedger,
            projectSecurityContext: assessSecurity({ text: r.decisionLedger.decisions.map(d => `${d.subject}: ${d.value}`).join('\n'), projectType: r.config.skills.projectType }),
            repositoryIntelligence: selectedContext, securityContext,
            executionCapabilities: executionCapabilities({ ...this.runConfig(r), agent: applyModelOverrides(
                roleAgent(r.config, 'implementer', r.executionPath === 'structural' ? 'high' : securityContext.minimumLane), r.config, 'implementer', r.operational) }) };
        let value: Spec;
        if (proposal !== undefined) value = specSchema.parse(proposal);
        else if (r.executionPath === 'standard') {
            const brief = await runRole({ ...roleOptions, schema: briefSpecSchema, context: { ...context, mode: 'product-brief' },
                validate: v => { validateSpec(validateTaskCapabilities(expandBrief(v), r.config), false, r.decisionLedger, r.request, securityContext); return v; } });
            value = expandBrief(brief);
        } else value = await runRole({ ...roleOptions, schema: specSchema, context, validate: validateProposal });
        if (r.executionPath && r.executionPath !== 'structural' && selectPath(r.request, scopedSecurity(value), r.executionPath) === 'structural') {
            r.executionPath = 'structural';
            if (r.content) r.contentHash = specHash(r);
            this.save(doc, 'planning.escalated', { reason: 'Proposed scope requires structural planning', fromProposal: true });
            await this.buildProduct(doc, proposal === undefined ? undefined : value, signal);
            return;
        }
        if (r.executionPath === 'structural') value = { ...value, minimumLane: 'high', tasks: value.tasks.map(t => ({ ...t, minimumLane: 'high' })) };
        this.save(doc, 'product.repository_intelligence', { sha: repositoryIntelligence.sha, fileCount: repositoryIntelligence.fileCount, relevantFiles: repositoryIntelligence.relevantFiles, securityFiles: repositoryIntelligence.securityFiles, reuseCandidates: repositoryIntelligence.reuseCandidates.map(x=>({name:x.name,kind:x.kind,path:x.path,line:x.line,score:x.score})) });
        const accepted = validateProposal(specSchema.parse(value));
        r.securityContext = scopedSecurity(accepted); r.securityContextHash = hash(r.securityContext);
        r.content = accepted; r.contentHash = specHash(r);
        this.save(doc, 'security.assessed', { contextHash:r.securityContextHash, minimumLane:r.securityContext.minimumLane, requiresThreatModel:r.securityContext.requiresThreatModel, negativeTestsRequired:r.securityContext.negativeTestsRequired, topics:r.securityContext.topics.map(t=>t.id), signals:r.securityContext.signals });
        r.impactAdvice = r.content.questions.length === 0 ? await this.impactAdvice(r, r.content, signal) : [];
        r.sizeAdvice = r.content.tasks.filter(t => t.allowedPaths.length > TASK_PATHS_ADVICE)
            .map(t => ({ taskId: t.id, title: t.title, paths: t.allowedPaths.length }));
        r.design = null;
        this.save(doc, 'product.checkpoint', { revision: r.revision, specHash: r.contentHash });
        if (this.requiresDesign(r.content, r.config.skills.projectType) && r.content.questions.length===0) await this.prepareDesignProposal(doc, repositoryIntelligence, signal);
        r.error = null;
        const design = r.design as SpecRecord['design'];
        this.save(doc, 'product.proposed', { revision: r.revision, hash: approvalHash(r), specHash: r.contentHash, designHash: design?.hash ?? null, impactAdvice: r.impactAdvice, sizeAdvice: r.sizeAdvice,
            questions: [...r.content.questions, ...(design?.proposal.questions ?? [])], content: r.content,
            design: design ? { hash: design.hash, directory: design.directory, indexPath: design.indexPath, summary: design.proposal.summary } : null });
    }
    /** Resume the exact request; an accepted Product checkpoint survives a failed Design round. */
    async resumePlanning(id: string, signal?: AbortSignal): Promise<Document<SpecRecord>> {
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id); const r = doc.data;
            invariant(r.status === 'draft' && !r.approval && r.attempts.length === 0, 'STATE', 'Only an unapproved draft can resume planning');
            await this.sourceReady(r, signal);
            const checkpoint = this.store.documentEvents(id, ['product.checkpoint']).at(-1)?.data as { revision?: number; specHash?: string } | undefined;
            const proposal = checkpoint?.revision === r.revision && checkpoint.specHash === r.contentHash ? r.content : undefined;
            try { await this.product(doc, proposal, signal); }
            catch (error) { r.error = planningError(error); this.save(doc, 'product.failed', { error: r.error }); throw error; }
            return doc;
        } finally { this.store.releaseDocument(id, token); }
    }
    /**
     * Execution-only gate changes an operator may amend without rewriting an approved spec: a new check, a
     * shared resource that serialises checks writing to the same place, or a longer timeout. What a check
     * proves — command, coverage labels, test paths, lanes, mandatory flag — and the removal of any check stay
     * outside an amendment: they would weaken an approval the operator already gave.
     */
    private amendedGates(r: SpecRecord, input: unknown): NonNullable<NonNullable<SpecRecord['operational']>['gates']> {
        const current = r.operational?.gates ?? { add: [], resources: {}, timeoutMs: {} };
        if (input === undefined) return current;
        invariant(input !== null && typeof input === 'object' && !Array.isArray(input), 'ARGUMENT', 'gates must be an amendment object');
        const values = input as Record<string, unknown>;
        invariant(Object.keys(values).every(k => ['add', 'resources', 'timeoutMs'].includes(k)), 'ARGUMENT', 'Only add, resources and timeoutMs may be amended on gates');
        invariant(values['add'] === undefined || Array.isArray(values['add']), 'ARGUMENT', 'gates.add must be an array');
        for (const key of ['resources', 'timeoutMs']) invariant(values[key] === undefined ||
            (values[key] !== null && typeof values[key] === 'object' && !Array.isArray(values[key])), 'ARGUMENT', `gates.${key} must be an object`);
        const existing = new Map([...r.config.gates, ...current.add].map(g => [g.id, g]));
        const add = [...current.add];
        for (const gate of (values['add'] as unknown[] | undefined) ?? []) {
            const parsed = gateSchema.parse(gate);
            invariant(!existing.has(parsed.id), 'ARGUMENT', `Gate ${parsed.id} already exists; an amendment may only add a new check`);
            existing.set(parsed.id, parsed); add.push(parsed);
        }
        const resources: Record<string, string[]> = Object.assign(Object.create(null), current.resources);
        for (const [gateId, labels] of Object.entries((values['resources'] as Record<string, unknown> | undefined) ?? {})) {
            invariant(existing.has(gateId), 'ARGUMENT', `Unknown gate ${gateId}`);
            invariant(Array.isArray(labels) && labels.every(l => typeof l === 'string' && l.length > 0 && l.length <= 80), 'ARGUMENT', 'Resources are non-empty labels');
            resources[gateId] = [...new Set([...(resources[gateId] ?? []), ...labels as string[]])];
        }
        const timeoutMs: Record<string, number> = Object.assign(Object.create(null), current.timeoutMs);
        for (const [gateId, value] of Object.entries((values['timeoutMs'] as Record<string, unknown> | undefined) ?? {})) {
            const gate = existing.get(gateId);
            invariant(gate, 'ARGUMENT', `Unknown gate ${gateId}`);
            const before = timeoutMs[gateId] ?? gate!.timeoutMs;
            invariant(typeof value === 'number' && Number.isSafeInteger(value) && value <= 3600000, 'ARGUMENT', 'A gate timeout is an integer up to 3600000 ms');
            invariant(value > before, 'ARGUMENT', `A gate timeout may only be raised: ${gateId} is already ${before} ms`);
            timeoutMs[gateId] = value;
        }
        return { add, resources, timeoutMs };
    }
    /** The configuration a run executes: the approved one, plus execution-only amendments. */
    runConfig(r: SpecRecord): Config {
        const amended = r.operational?.gates;
        if (!amended || (!amended.add.length && !Object.keys(amended.resources).length && !Object.keys(amended.timeoutMs).length)) return r.config;
        const gates = [...r.config.gates, ...amended.add].map(g => ({ ...g,
            resources: [...new Set([...g.resources, ...(Object.hasOwn(amended.resources, g.id) ? amended.resources[g.id]! : [])])],
            timeoutMs: Object.hasOwn(amended.timeoutMs, g.id) ? amended.timeoutMs[g.id]! : g.timeoutMs }));
        const config = { ...r.config, gates };
        validateConfig(config);
        validateDag(gates);
        return config;
    }
    amendBudget(id: string, input: unknown, actor: string, note: string): Document<SpecRecord> {
        reviewer(actor, note);
        invariant(input !== null && typeof input === 'object' && !Array.isArray(input), 'ARGUMENT', 'Expected an operational amendment object');
        const values = input as Record<string, unknown>;
        invariant(Object.keys(values).length > 0 && Object.keys(values).every(k => ['maxSpecCostUsd', 'maxActiveMs', 'agent', 'roles', 'gates'].includes(k)), 'ARGUMENT', 'Only maxSpecCostUsd, maxActiveMs, agent, per-role tuning and execution-only gate changes may be amended');
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id); const r = doc.data;
            invariant(!['closed', 'rejected'].includes(r.status) && !r.sessionStartedAt && !r.planningStartedAt, 'STATE', 'Stop/recover the workflow before amending its limits');
            const cost = Object.hasOwn(values, 'maxSpecCostUsd') ? values['maxSpecCostUsd'] : specCostCeiling(r);
            const time = Object.hasOwn(values, 'maxActiveMs') ? values['maxActiveMs'] : r.operational?.maxActiveMs ?? r.config.workflow.maxActiveMs;
            invariant(cost === null || (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0.01 && cost <= 10000), 'ARGUMENT', 'maxSpecCostUsd must be null or within 0.01..10000');
            invariant(typeof time === 'number' && Number.isSafeInteger(time) && time >= 100 && time <= 14400000, 'ARGUMENT', 'maxActiveMs must be within 100..14400000');
            let tuning = r.operational?.agent ?? null;
            if (values['agent'] !== undefined) {
                const v = values['agent'];
                invariant(v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => ['model', 'effort', 'timeoutMs', 'maxTurns', 'maxBudgetUsd', 'usageMode'].includes(k)), 'ARGUMENT', 'Agent tuning cannot change provider, command, credentials or tools');
                agentSchema.parse({ ...r.config.agent, ...tuning, ...v });
                tuning = { ...tuning, ...v };
            }
            const roles = { ...r.operational?.roles };
            if (values['roles'] !== undefined) {
                const input = values['roles'];
                invariant(input !== null && typeof input === 'object' && !Array.isArray(input), 'ARGUMENT', 'roles must be a tuning object');
                for (const [name, v] of Object.entries(input)) {
                    invariant(['product', 'design', 'implementer', 'qa'].includes(name), 'ARGUMENT', 'Unknown model role');
                    invariant(v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => ['model', 'effort', 'timeoutMs', 'maxTurns', 'maxBudgetUsd', 'usageMode'].includes(k)), 'ARGUMENT', 'Role tuning cannot change provider, command, credentials or tools');
                    const role = name as keyof typeof roles;
                    agentSchema.parse({ ...roleAgent(r.config, role, 'high'), ...roles[role], ...v });
                    roles[role] = { ...roles[role], ...v };
                }
            }
            const previousQaModels = modelPlan(r.config, r.operational).filter(m => m.role === 'qa').map(m => ({ provider: m.provider, model: m.model, effort: m.effort }));
            const gates = this.amendedGates(r, values['gates']);
            const previousGates = this.runConfig(r).gates;
            r.operational = { maxSpecCostUsd: cost, maxActiveMs: time, gates, agent: tuning, roles, at: Date.now(), reviewer: actor.trim(), note: note.trim() };
            for (const role of ['product', 'design', 'implementer', 'qa'] as const)
                for (const lane of ['fast', 'standard', 'high'] as const) executionAgent(applyModelOverrides(roleAgent(r.config, role, lane), r.config, role, r.operational));
            const qaChanged = hash(previousQaModels) !== hash(modelPlan(r.config, r.operational).filter(m => m.role === 'qa').map(m => ({ provider: m.provider, model: m.model, effort: m.effort })));
            if (qaChanged) {
                invariant(!r.publication && !r.delivery, 'STATE', 'Changing QA requires an unpublished candidate');
                r.qa = null; r.review = null; r.error = null;
                if (r.approval) r.status = 'approved';
            }
            const gatesChanged = hash(previousGates) !== hash(this.runConfig(r).gates);
            if (gatesChanged) {
                invariant(!r.publication && !r.delivery, 'STATE', 'Gate amendments must precede publication or delivery');
                // A completed candidate must earn new proof under the amended checks, including fresh QA/review.
                if (r.activeRunId === r.finalRunId) r.activeRunId = null;
                r.finalRunId = null;
                r.review = null;
                if (!r.activeRunId) {
                    r.qa = null;
                    r.error = null;
                    if (r.approval) r.status = 'approved';
                }
            }
            this.save(doc, 'workflow.budget_amended', { amendment: r.operational });
            return doc;
        } finally { this.store.releaseDocument(id, token); }
    }
    async refine(id: string, request: string, proposal?: unknown, signal?: AbortSignal): Promise<Document<SpecRecord>> {
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            const r = doc.data;
            invariant(r.attempts.length === 0 && !['closed', 'rejected'].includes(r.status), 'SPEC_IMMUTABLE', 'Execution has started; create a follow-up spec instead of rewriting approved history');
            invariant(!r.planningStartedAt, 'RECOVERY', 'Recover interrupted planning before refining');
            invariant(request.trim().length > 0 && r.request.length + request.length + 30 <= 30000, 'REQUEST', 'Provide a bounded refinement');
            r.request += '\n\nOperator refinement:\n' + request;
            if (r.executionPath === 'compact') r.executionPath = 'standard';
            r.architecture = null;
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
                r.error = planningError(error);
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
            invariant(!r.error, 'PRODUCT', 'Complete or resume the failed planning round before approving its proposal');
            invariant(r.content && approvalHash(r) === expectedHash, 'APPROVAL_HASH', 'Approve the exact spec/design proposal hash');
            validateTaskCapabilities(validateSpec(r.content, true, r.decisionLedger, r.request, r.securityContext), r.config);
            if (this.requiresDesign(r.content, r.config.skills.projectType)) invariant(r.design && r.design.proposal.questions.length === 0, 'OPEN_QUESTIONS', 'Resolve design questions before approval');
            await this.sourceReady(r);
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
    /** Design context scoped to one task: legacy proposals without taskScopes keep the whole design. */
    private designContextFor(design: NonNullable<SpecRecord['design']>, taskId: string) {
        const proposal = design.proposal; const designHash = design.hash;
        const scope = proposal.taskScopes?.length ? proposal.taskScopes.find(x => x.taskId === taskId) : undefined;
        if (proposal.taskScopes?.length && !scope)
            return { hash: designHash, summary: proposal.summary, scope: 'none', note: 'This task has no visual work in the approved design; keep the existing look and do not restyle.' };
        const screens = proposal.screens.filter(x => !scope || scope.screenIds.includes(x.id));
        const previewOf = (id: string): string | null => design.screenPaths.find(p => basename(p) === `${id}.html`) ?? null;
        // The markup and stylesheet the operator approved, not a paraphrase of them. Bounded: a mockup far
        // over budget degrades to its description plus the preview path rather than breaking the task.
        const full = screens.map(x => ({ ...x, previewPath: previewOf(x.id) }));
        const weight = JSON.stringify(full).length + proposal.css.length;
        const within = weight <= DESIGN_CONTEXT_BUDGET;
        return { hash: designHash, summary: proposal.summary, visualDirection: proposal.visualDirection, implementationBrief: proposal.implementationBrief, decisions: proposal.decisions, avoid: proposal.avoid,
            scope: scope ? 'task' : 'all',
            projectStylesheets: (proposal.stylesheets ?? []).map(x => x.path),
            ...(within ? { css: proposal.css } : { cssOmitted: `The approved stylesheet is ${proposal.css.length} characters; open the preview files instead.` }),
            screens: full.map(x => within
                ? { id: x.id, title: x.title, purpose: x.purpose, states: x.states, responsive: x.responsive, previewPath: x.previewPath, bodyHtml: x.bodyHtml }
                : { id: x.id, title: x.title, purpose: x.purpose, states: x.states, responsive: x.responsive, previewPath: x.previewPath }),
            note: 'This is the mockup the operator approved. Reproduce its structure, classes and states in the real stack; it is a reference, not a file to copy verbatim.' };
    }
    private makeTask(r: SpecRecord, t: Spec['tasks'][number]): Task {
        const spec = this.approved(r);
        const acceptance = spec.acceptance.filter(a => t.acceptanceIds.includes(a.id));
        const design = r.design ? this.designContextFor(r.design, t.id) : null;
        const decisionIds = new Set(spec.decisionCoverage.filter(c => c.acceptanceIds.some(id => t.acceptanceIds.includes(id))).map(c => c.decisionId));
        const confirmedProjectDecisions = confirmedDecisions(r.decisionLedger).filter(d => decisionIds.has(d.id));
        const resolvedProjectDecisions = spec.decisionResolutions.filter(d=>decisionIds.has(d.decisionId)).map(d=>({id:d.decisionId,subject:r.decisionLedger.decisions.find(x=>x.id===d.decisionId)?.subject ?? d.decisionId,value:d.value,status:'confirmed-via-product',source:'operator',sourceQuote:d.sourceQuote,rationale:d.rationale}));
        const projectDecisions = [...confirmedProjectDecisions, ...resolvedProjectDecisions];
        const securityRequirements = spec.security.requirements.filter(req => req.acceptanceIds.some(id => t.acceptanceIds.includes(id)));
        const securityThreats = spec.security.threatModel.threats.filter(threat => threat.acceptanceIds.some(id => t.acceptanceIds.includes(id)));
        const security = { context:r.securityContext, profile:spec.security.profile, requirements:securityRequirements, threats:securityThreats, assumptions:spec.security.assumptions };
        const context = { problem: spec.problem, scope: spec.scope, outOfScope: spec.outOfScope, decisions: spec.decisions, projectDecisions, criteria: acceptance, experience: spec.experience, security, approvedDesign: design, ...(r.architecture ? { architecture: r.architecture } : {}) };
        const description = t.description + '\n\nApproved Product context (do not expand scope):\n' + JSON.stringify(context);
        const maxContext = r.config.limits?.maxTaskContextChars ?? DEFAULT_LIMITS.maxTaskContextChars;
        invariant(description.length <= maxContext, 'TASK_CONTEXT', `Approved context is too large for a task (${description.length} > limits.maxTaskContextChars ${maxContext}); split the spec or raise the reviewed limit`);
        const amendments = r.scopeAmendments.filter(a => a.status === 'approved' && a.taskId === t.id).flatMap(a => a.paths);
        const allowedPaths=[...new Set([...t.allowedPaths, ...amendments])];
        const allowedNewPaths=this.companionPaths(allowedPaths);
        return taskSchema.parse({ id: t.id, title: t.title, description, acceptance: acceptance.map(a => a.description), allowedPaths, allowedNewPaths, maxNewFiles: allowedNewPaths.length ? 4 : 0, reviewRequired:false, minimumLane: stricter(t.minimumLane, spec.minimumLane, securityRequirements.length ? r.securityContext.minimumLane : 'fast') });
    }
    /**
     * The retried task, told why the previous attempt stopped: its error, the diagnostics of the checks it
     * failed and its own summary. The new attempt starts from the approved base, so without this it would
     * repeat a failure it cannot see. The context is trimmed to fit `limits.maxTaskContextChars`.
     */
    private withPreviousAttempt(r: SpecRecord, task: Task, failed: Run): Task {
        const failing = this.store.failureDiagnostics(failed).map(x => ({ gateId: x.gateId, diagnostic: x.diagnostic.slice(0, PREVIOUS_DIAGNOSTIC_CHARS) }));
        const previous = { error: failed.error, failedChecks: failing, summary: (failed.summary ?? '').slice(0, 2000) };
        const header = '\n\nThe previous attempt of this task failed and its code was not kept: this attempt starts again from the approved base. Avoid the same failure; in particular the listed checks must pass.\n';
        const room = (r.config.limits?.maxTaskContextChars ?? DEFAULT_LIMITS.maxTaskContextChars) - task.description.length - header.length;
        const context = JSON.stringify(previous);
        if (room <= 0) return task;
        return taskSchema.parse({ ...task, description: task.description + header + (context.length <= room ? context : context.slice(0, room)) });
    }
    private assertReplanFrontier(r: SpecRecord): void {
        this.approved(r);
        invariant(r.status === 'blocked' && r.sessionStartedAt === null && !r.publication && !r.delivery,
            'REPLAN_STATE', 'Replan requires a paused, blocked spec that has not been published or delivered');
        invariant(r.activeRunId && r.attempts.some(a => a.runId === r.activeRunId && a.kind === 'task' && !r.completedTaskIds.includes(a.taskId)) &&
            this.store.get(r.activeRunId).state === 'failed', 'REPLAN_STATE', 'Replan requires a terminal failed task; recover or retry interrupted work first');
        invariant(!r.scopeAmendments.some(a => a.status === 'pending') && !(r.criterionAmendments ?? []).some(a => a.status === 'pending'),
            'REPLAN_STATE', 'Resolve pending scope/criterion amendments before revising the execution plan');
    }
    /** Prepare a bounded operator amendment without another Product call or any code execution. */
    planRemainingTasks(id: string, input: unknown): Document<SpecRecord> {
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id); const r = doc.data;
            this.assertReplanFrontier(r);
            const { reason, tasks } = revisedContent(r, input);
            const proposal = { contextHash: replanContext(r), reason, tasks };
            for (const old of r.planRevisions ?? []) if (old.status === 'pending') old.status = 'superseded';
            r.planRevisions = [...(r.planRevisions ?? []), { ...proposal, id: randomUUID(), hash: replanHash(proposal),
                previousContent: structuredClone(r.content!), previousApproval: structuredClone(r.approval!),
                status: 'pending', at: Date.now(), approval: null }];
            this.save(doc, 'plan.revision_proposed', { revision: r.planRevisions.at(-1) });
            return doc;
        } finally { this.store.releaseDocument(id, token); }
    }
    async approveRemainingTasks(id: string, amendmentId: string, expectedHash: string, actor: string, note: string): Promise<Document<SpecRecord>> {
        reviewer(actor, note);
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id); const r = doc.data;
            this.assertReplanFrontier(r);
            const proposal = r.planRevisions?.find(p => p.id === amendmentId && p.status === 'pending');
            invariant(proposal && proposal.hash === expectedHash && replanHash(proposal) === expectedHash, 'REPLAN_HASH', 'Approve the exact pending plan hash');
            invariant(proposal.contextHash === replanContext(r), 'REPLAN_STALE', 'The execution frontier or its approval changed; prepare a new revision');
            const { content } = revisedContent(r, { reason: proposal.reason, tasks: proposal.tasks });
            await this.sourceReady(r);
            r.content = content; r.revision++; r.contentHash = specHash(r);
            r.approval = { hash: approvalHash(r)!, reviewer: actor.trim(), note: note.trim(), at: Date.now() };
            proposal.status = 'approved'; proposal.approval = { ...r.approval, hash: expectedHash };
            // Failed code stays inspectable in its original run. Only proven completed code is resumed.
            r.activeRunId = null; r.finalRunId = null; r.qa = null; r.review = null; r.delivery = null;
            r.impactAdvice = await this.impactAdvice(r, this.approved(r));
            r.sizeAdvice = content.tasks.filter(t => !r.completedTaskIds.includes(t.id) && t.allowedPaths.length > TASK_PATHS_ADVICE)
                .map(t => ({ taskId: t.id, title: t.title, paths: t.allowedPaths.length }));
            r.status = 'running'; r.error = null;
            this.save(doc, 'plan.revision_approved', { amendmentId, hash: expectedHash, approval: r.approval,
                completedTaskIds: r.completedTaskIds, currentSha: r.currentSha });
            return doc;
        } finally { this.store.releaseDocument(id, token); }
    }
    /** The repair task for the current QA report, built from the current effective spec and amendments. */
    private qaRepairTask(r: SpecRecord): Task {
        invariant(r.qa, 'QA_REQUIRED', 'A QA report is required to build a repair');
        const description = [
            'Correct the following QA findings that require a fix: all blocker/major findings and findings with resolution=required, including minor cleanup. Leave advisory-only findings outside this repair. Preserve the approved scope.',
            'When a finding can only be fixed in a file outside the approved paths (for example a comment made false by an approved change), make the smallest change there anyway: the controller then stops and asks the operator for an explicit scope amendment. Never broaden a feature to do so.',
            'When a finding cannot be fixed by changing files (for example it is about what a report must contain), say so precisely in your summary; QA reads the task summaries.',
        ].join('\n') + '\n' + JSON.stringify({ approvedSpec: this.approved(r), qa: r.qa.report, taskSummaries: this.taskSummaries(r) });
        invariant(description.length <= (r.config.limits?.maxTaskContextChars ?? DEFAULT_LIMITS.maxTaskContextChars), 'TASK_CONTEXT', 'QA repair context exceeds limits.maxTaskContextChars; prepare an explicit follow-up');
        return this.aggregateTask(r, description);
    }
    private aggregateTask(r: SpecRecord, description: string): Task {
        const spec = this.approved(r);
        const minimum = stricter(spec.minimumLane, r.securityContext.minimumLane, ...r.attempts.map(a => this.pipeline.store.get(a.runId).risk?.lane ?? 'fast'));
        const allowedPaths=[...new Set([...spec.tasks.flatMap(t => t.allowedPaths), ...r.scopeAmendments.filter(a=>a.status === 'approved').flatMap(a=>a.paths)])];
        const allowedNewPaths=this.companionPaths(allowedPaths);
        return taskSchema.parse({ id: 'SPEC-INTEGRATION', title: spec.title, description, acceptance: spec.acceptance.map(a => a.description), allowedPaths, allowedNewPaths, maxNewFiles: allowedNewPaths.length ? 8 : 0, reviewRequired:true, minimumLane: minimum });
    }
    /** What the providers declared for this spec so far. Declared values, never an invoice. */
    declaredCostUsd(r: SpecRecord, documentId: string): number {
        return Math.round(specCosts(this.store, r, documentId).knownUsd * 100) / 100;
    }
    costSummary(id: string) {
        const r = this.store.document<SpecRecord>(id, 'spec').data;
        const modes = [...new Set(modelPlan(r.config, r.operational).map(m => m.usageMode))];
        return { ...specCosts(this.store, r, id), budget: specCosts(this.store, r, id, true), usageModes: modes, configuredCeilingUsd: specCostCeiling(r), ceilingUsd: modes.every(m => m === 'subscription') ? null : specCostCeiling(r) };
    }
    /**
     * The reviewed configuration may cap what a spec is allowed to spend. Reaching it stops the workflow with
     * what was spent; continuing is an explicit operator decision (`spec run --accept-cost`), like every other
     * boundary of this controller.
     */
    private costExceeded(doc: Document<SpecRecord>, options: WorkflowOptions): boolean {
        const r = doc.data;
        const ceiling = specCostCeiling(r);
        if (ceiling === null || options.acceptCost || applyModelOverrides(r.config.agent, r.config, 'implementer', r.operational).usageMode === 'subscription') return false;
        const spent = specCosts(this.store, r, doc.id, true).knownUsd;
        if (spent < ceiling) return false;
        r.status = 'blocked';
        r.error = { code: 'COST_BUDGET', message: `The providers declared ${spent.toFixed(2)} USD on this spec, at or above the reviewed ceiling of ${ceiling.toFixed(2)} USD (workflow.maxSpecCostUsd). Nothing was started. Read what remains to do, then authorize the overrun explicitly.` };
        this.save(doc, 'workflow.cost_ceiling_reached', { declaredCostUsd: spent, ceilingUsd: ceiling });
        return true;
    }
    private async executeActive(doc: Document<SpecRecord>, options: WorkflowOptions, signal: AbortSignal): Promise<Run> {
        const r = doc.data;
        invariant(r.activeRunId, 'STATE', 'No active run');
        const before = this.pipeline.store.get(r.activeRunId);
        if (!before.specId) { before.specId = doc.id; this.store.save(before, 'run.spec_linked', { specId: doc.id }); }
        if (['failed', 'rejected'].includes(before.state))
            return before;
        const run = await this.pipeline.execute(before.id, { signal, acceptCurrentCandidate: options.acceptCurrent ?? false, acceptCost: options.acceptCost ?? false });
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
    /** Records a proposed correction of one acceptance criterion and returns its hash for explicit approval. */
    planCriterionAmendment(id: string, criterionId: string, correction: { description: string; verification: string; reason: string; requirements?: { id: string; verification: string; reviewTestIndexes?: number[]; negativeTests?: string[] }[] }): Document<SpecRecord> {
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id); const r = doc.data;
            const spec = this.approved(r);
            invariant(!['closed', 'rejected', 'delivered'].includes(r.status), 'STATE', 'This spec no longer accepts a criterion correction');
            invariant(!r.sessionStartedAt && !r.planningStartedAt && !r.publication, 'STATE', 'Stop execution before amending an unpublished spec');
            invariant(r.attempts.length > 0, 'CRITERION_AMENDMENT', 'Execution has not started: refine the spec instead of amending a criterion');
            const criterion = spec.acceptance.find(c => c.id === criterionId);
            invariant(criterion, 'CRITERION_AMENDMENT', `Unknown acceptance criterion ${criterionId}`);
            const description = correction.description.trim(); const verification = correction.verification.trim();
            invariant(description.length >= 10 && description.length <= 3000 && verification.length >= 10 && verification.length <= 3000, 'CRITERION_AMENDMENT', 'A corrected criterion needs an observable description and verification');
            invariant(correction.reason.trim().length >= 20, 'CRITERION_AMENDMENT', 'Explain why the approved criterion cannot hold');
            const requirements = (correction.requirements ?? []).map(x => {
                const requirement = spec.security.requirements.find(q => q.id === x.id);
                invariant(requirement, 'CRITERION_AMENDMENT', `Unknown security requirement ${x.id}`);
                // Only a requirement that verifies this criterion may be corrected with it.
                invariant(requirement.acceptanceIds.includes(criterionId), 'CRITERION_AMENDMENT', `Security requirement ${x.id} does not verify ${criterionId}`);
                const text = x.verification.trim();
                invariant(text.length >= 10 && text.length <= 4000, 'CRITERION_AMENDMENT', `A corrected verification for ${x.id} must be observable`);
                invariant(x.negativeTests === undefined || x.reviewTestIndexes === undefined, 'CRITERION_AMENDMENT', 'Use negativeTests or reviewTestIndexes, not both');
                invariant(x.negativeTests === undefined || (Array.isArray(x.negativeTests) && x.negativeTests.every(t => typeof t === 'string')), 'CRITERION_AMENDMENT', 'negativeTests must be a list of strings');
                const negativeTests = x.negativeTests?.map(t => t.trim());
                if (negativeTests) {
                    invariant(negativeTests.length === requirement.negativeTests.length, 'CRITERION_AMENDMENT', `The negative cases of ${x.id} may be marked as reviews, never added or removed`);
                    negativeTests.forEach((test, i) => {
                        const before = requirement.negativeTests[i]!;
                        invariant(test === before || (!before.startsWith('[review] ') && test === `[review] ${before}`), 'CRITERION_AMENDMENT', `A negative case of ${x.id} may only gain the [review] marker, not change its text`);
                    });
                    invariant(negativeTests.some((test, i) => test !== requirement.negativeTests[i]), 'CRITERION_AMENDMENT', `No negative case of ${x.id} is reclassified`);
                }
                const indexes = x.reviewTestIndexes ?? [];
                invariant(Array.isArray(indexes) && new Set(indexes).size === indexes.length && indexes.every(i => Number.isInteger(i) && i >= 0 && i < requirement.negativeTests.length), 'CRITERION_AMENDMENT', 'Review indexes must name distinct existing negative cases');
                const reviewTests = indexes.map(index => ({ index, previous: requirement.negativeTests[index]! }));
                invariant(reviewTests.every(test => !test.previous.startsWith('[review] ')), 'CRITERION_AMENDMENT', 'This negative case already permits review');
                return { id: x.id, previous: requirement.verification, verification: text, ...(reviewTests.length ? { reviewTests } : {}),
                    ...(negativeTests ? { previousNegativeTests: [...requirement.negativeTests], negativeTests } : {}) };
            });
            invariant(new Set(requirements.map(x => x.id)).size === requirements.length, 'CRITERION_AMENDMENT', 'A security requirement is corrected at most once per amendment');
            const changed = description !== criterion.description || verification !== criterion.verification || requirements.some(x => x.verification !== x.previous || x.reviewTests?.length || x.negativeTests !== undefined);
            invariant(changed, 'CRITERION_AMENDMENT', 'The correction is identical to the approved criterion');
            const previous = { description: criterion.description, verification: criterion.verification };
            const amendment: CriterionAmendment = { id: randomUUID(), criterionId, previous, description, verification, requirements, reason: correction.reason.trim(),
                hash: criterionAmendmentHash({ criterionId, previous, description, verification, requirements, reason: correction.reason.trim() }),
                status: 'pending', at: Date.now(), approvedAt: null, reviewer: null, note: null };
            this.approved({ ...r, criterionAmendments: [...(r.criterionAmendments ?? []), { ...amendment, status: 'approved' }] });
            r.criterionAmendments = [...(r.criterionAmendments ?? []).filter(a => !(a.status === 'pending' && a.criterionId === criterionId)), amendment];
            this.save(doc, 'criterion.amendment_proposed', { amendmentId: amendment.id, criterionId, hash: amendment.hash, previous, description, verification, requirements, reason: amendment.reason });
            return doc;
        } finally { this.store.releaseDocument(id, token); }
    }
    /** Applies a criterion correction the operator approved by its exact hash, and reopens assessment. */
    approveCriterionAmendment(id: string, amendmentId: string, expectedHash: string, actor: string, note: string): Document<SpecRecord> {
        reviewer(actor, note);
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id); const r = doc.data; this.approved(r);
            const amendment = (r.criterionAmendments ?? []).find(a => a.id === amendmentId);
            invariant(amendment && amendment.status === 'pending', 'CRITERION_AMENDMENT', 'Pending criterion amendment not found');
            invariant(amendment.hash === expectedHash, 'CRITERION_HASH', 'Approve the exact corrected criterion hash');
            invariant(!r.sessionStartedAt && !r.planningStartedAt && !r.publication && !['closed', 'rejected', 'delivered'].includes(r.status), 'STATE', 'Stop execution before amending an unpublished spec');
            const effective = this.approved(r);
            const criterion = effective.acceptance.find(c => c.id === amendment.criterionId);
            invariant(criterion && criterion.description === amendment.previous.description && criterion.verification === amendment.previous.verification &&
                (amendment.requirements ?? []).every(change => {
                    const requirement = effective.security.requirements.find(q => q.id === change.id);
                    return requirement && requirement.verification === change.previous &&
                        (!change.previousNegativeTests || hash(requirement.negativeTests) === hash(change.previousNegativeTests)) && (change.reviewTests ?? []).every(test => requirement.negativeTests[test.index] === test.previous);
                }), 'CRITERION_HASH', 'The correction is stale; propose it again against the current spec');
            this.approved({ ...r, criterionAmendments: [...(r.criterionAmendments ?? []).filter(a => a.id !== amendment.id), { ...amendment, status: 'approved' }] });
            amendment.status = 'approved'; amendment.approvedAt = Date.now(); amendment.reviewer = actor.trim(); amendment.note = note.trim();
            // The criterion changed, so no previous assessment of it still applies.
            r.qa = null; r.review = null; r.delivery = null;
            r.status = 'running'; r.error = null;
            this.save(doc, 'criterion.amendment_approved', { amendmentId: amendment.id, criterionId: amendment.criterionId, hash: amendment.hash, reviewer: actor.trim(), note: note.trim(), previous: amendment.previous, description: amendment.description });
            return doc;
        } finally { this.store.releaseDocument(id, token); }
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
            const validationConfig = { ...this.runConfig(r), maxRepairAttempts: 0 };
            const validation = await this.pipeline.createValidation({ repo: r.repo, baseRef: failed.baseSha, specId: doc.id, config: validationConfig, task }, amendment.candidateSha);
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
            const remaining = (r.operational?.maxActiveMs ?? r.config.workflow.maxActiveMs) - r.activeMs - (r.planningMs ?? 0);
            invariant(remaining > 0, 'BUDGET', 'Spec active-time budget exhausted');
            await this.sourceReady(r);
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
                if (!r.activeRunId && this.costExceeded(doc, options)) return doc;
                if (!r.activeRunId) {
                    let task = this.makeTask(r, t);
                    const previous = [...r.attempts].reverse().find(a => a.kind === 'task' && a.taskId === t.id);
                    if (previous) {
                        const failed = this.store.get(previous.runId);
                        if (failed.state === 'failed') task = this.withPreviousAttempt(r, task, failed);
                    }
                    const run = await this.pipeline.create({ repo: r.repo, baseRef: r.currentSha, specId: doc.id, config: this.runConfig(r), task });
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
                    r.review = null; // The review described the previous candidate; it is superseded, not stale forever.
                    this.save(doc, 'workflow.qa_repair_completed', { runId: repaired.id, candidateSha: r.currentSha });
                }
                if (!r.finalRunId) {
                    // One task already validates exactly the complete candidate: do not pay for the same gates twice.
                    const only = r.attempts.length === 1 ? this.pipeline.store.get(r.attempts[0]!.runId) : null;
                    // Reuse is about proof, not about human review: the run must already carry every
                    // configured gate on this exact candidate, and reusing it must not lower the number of
                    // approvals the integration would have required.
                    const proven = (run: Run): boolean => {
                        const seen = new Map(run.receipts.map(x => [x.gateId, x.status]));
                        return this.sameGates(r, run) && this.runConfig(r).gates.every(g => ['passed', 'cached'].includes(seen.get(g.id) ?? ''));
                    };
                    const reviewPreserved = (run: Run): boolean =>
                        run.task.reviewRequired || requiredApprovals(run.risk?.lane ?? 'high', r.config.workflow.reviewMode as ReviewMode) === 0;
                    if (only && ['ready', 'awaiting_review'].includes(only.state) && only.baseSha === r.baseSha && only.candidateSha === r.currentSha && proven(only) && reviewPreserved(only)) {
                        r.finalRunId = only.id;
                        this.save(doc, 'integration.reused', { runId: only.id, gates: only.receipts.map(x => x.gateId), reviewRequired: only.task.reviewRequired });
                    }
                    else {
                        const config = this.runConfig(r);
                        const finalConfig = { ...config, maxRepairAttempts: 0, gates: config.gates.map(g => ({ ...g, mandatory: true })) };
                        const validation = { repo: r.repo, baseRef: r.baseSha, config: finalConfig, task: this.aggregateTask(r, 'Validate the complete approved specification on its aggregate candidate, including interactions across tasks.') };
                        // The single task already proved this exact candidate: adopt its receipts into the
                        // reviewable integration run instead of replaying every gate. The review requirement stays.
                        const refusal = only && only.baseSha === r.baseSha && only.candidateSha === r.currentSha && proven(only)
                            ? await this.pipeline.adoptionRefusal(validation, only.id) : 'no single proven attempt on this candidate';
                        if (only && refusal === null) {
                            const run = await this.pipeline.adoptValidation(validation, only.id);
                            r.finalRunId = run.id;
                            r.validationRunIds.push(run.id);
                            this.save(doc, 'integration.adopted', { runId: run.id, sourceRunId: only.id, candidateSha: r.currentSha, state: run.state });
                        }
                        else {
                            if (only) this.save(doc, 'integration.adoption_refused', { sourceRunId: only.id, reason: refusal });
                            const run = await this.pipeline.createValidation(validation, r.currentSha);
                            r.finalRunId = run.id;
                            r.validationRunIds.push(run.id);
                            r.activeRunId = run.id;
                            this.save(doc, 'integration.created', { runId: run.id, candidateSha: r.currentSha });
                        }
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
                assertRequiredEvidence(qualityContext(r, final).validation);
                if (r.review && r.review.candidateSha !== final.candidateSha) {
                    const superseded = r.review; r.review = null;
                    this.save(doc, 'workflow.review_superseded', { previousCandidateSha: superseded.candidateSha, candidateSha: final.candidateSha });
                }
                const needsQa = requiresQa(r, final, spec);
                this.save(doc, 'qa.routing', { path: r.executionPath ?? 'legacy', lane: final.risk!.lane, required: needsQa });
                if (needsQa && (!r.qa || r.qa.evidenceHash !== evidenceHash || r.qa.report.candidateSha !== final.candidateSha || r.qa.specHash !== r.contentHash)) {
                    r.qa = null;
                    if (options.manualQa) {
                        r.status = 'blocked';
                        r.error = { code: 'QA_REQUIRED', message: 'Import a complete QA report with spec qa, then run again.' };
                        this.save(doc, 'qa.required');
                        return doc;
                    }
                    const diff = await new Git(signal).patch(r.repo, r.baseSha, final.candidateSha!);
                    const maxDiff = r.config.limits?.maxQaDiffBytes ?? DEFAULT_LIMITS.maxQaDiffBytes;
                    invariant(Buffer.byteLength(diff) <= maxDiff, 'QA_CONTEXT', `QA diff exceeds limits.maxQaDiffBytes (${maxDiff}); use an explicit external review, never a truncated review`);
                    const inventoryDelta = await this.inventoryDelta(r, final.candidateSha!, signal);
                    this.save(doc, 'qa.inventory_delta', { added: inventoryDelta.added.length, removed: inventoryDelta.removed.length, possibleDuplicates: inventoryDelta.possibleDuplicates });
                    // runRole checks the budget only if a model call is needed; retained proof can be free.
                    const quality = await this.qualityEvidence(r, final, signal);
                    const fullContext = { diff, spec, qualityReview: qualityContext(r, final), architecture: r.architecture ?? null, approvedAmendments: this.approvedAmendments(r), taskSummaries: this.taskSummaries(r), decisionLedger: r.decisionLedger, securityContext:r.securityContext, approvedDesign: this.qaDesignContext(r), baseSha: r.baseSha, candidateSha: final.candidateSha, receipts: final.receipts, inventoryDelta, diffCommand: ['git', 'diff', '--no-ext-diff', '--no-textconv', r.baseSha, final.candidateSha, '--'] };
                    const context = r.executionPath && r.executionPath !== 'structural' && final.risk!.lane !== 'high' ? targetedQaContext(fullContext) : fullContext;
                    this.save(doc, 'qa.context_selected', { mode: context === fullContext ? 'full' : 'targeted', bytes: Buffer.byteLength(JSON.stringify(context)), fullBytes: Buffer.byteLength(JSON.stringify(fullContext)), completeDiff: true });
                    const raw = await runRole({ store: this.store, documentId: id, budgetDocumentId: id, acceptCost: options.acceptCost ?? false, repo: r.repo, sha: final.candidateSha!, role: 'qa', skills: r.config.skills, modelPolicy: modelPlan(r.config, r.operational).find(m => m.role === 'qa' && m.lane === (final.risk?.lane ?? spec.minimumLane))?.decision, modelReason: modelChoice(r.config, 'qa', final.risk?.lane ?? spec.minimumLane).reason, agent: roleAgent(r.config, 'qa', final.risk?.lane ?? spec.minimumLane), passEnv: r.config.environment.passEnv, schema: qaSchema, context, signal,
                        maxRepairs: r.config.workflow.maxOutputRepairs ?? 1, validate: report => validateQa(report, spec, final.candidateSha!, r.decisionLedger, quality) });
                    r.qa = { report: raw, specHash: r.contentHash!, evidenceHash, at: Date.now(), source: 'agent' };
                    this.save(doc, 'qa.completed', { qa: r.qa });
                }
                if (needsQa && r.qa!.report.verdict === 'changes_requested') {
                    // An authorization the operator granted on this exact review answers the stop it was
                    // granted for, and nothing else: a later review starts from the automatic rules again.
                    const authorized = r.qaRepairAuthorization ?? null;
                    if (!authorized && r.config.workflow.qualityReview === 'evidence' && [...r.qa!.report.qualityChecks, ...r.qa!.report.criteria,
                        ...r.qa!.report.securityChecks, ...r.qa!.report.decisionChecks, ...(r.qa!.report.negativeTestChecks ?? [])].some(x => x.status === 'unknown')) {
                        r.status = 'blocked';
                        r.error = { code: 'QA_EVIDENCE', message: 'Quality review lacks evidence. Inspect the missing proof and import a substantiated QA report; no automatic code repair is started for unknown evidence.' };
                        this.save(doc, 'qa.evidence_missing', { axes: r.qa!.report.qualityChecks.filter(x => x.status === 'unknown').map(x => x.axis) });
                        return doc;
                    }
                    if (!authorized && r.qaRepairs >= r.config.workflow.maxQaRepairs) {
                        r.status = 'blocked';
                        r.error = { code: 'QA_REJECTED', message: 'QA requests changes; automatic repair budget exhausted. Inspect findings and create an explicit follow-up.' };
                        this.save(doc, 'qa.repair_budget_exhausted');
                        return doc;
                    }
                    const run = await this.pipeline.create({ repo: r.repo, baseRef: r.currentSha, specId: doc.id, config: this.runConfig(r), task: this.qaRepairTask(r) });
                    r.qaRepairs++;
                    r.qaRepairAuthorization = null;
                    r.attempts.push({ taskId: `QA-REPAIR-${r.qaRepairs}`, runId: run.id, kind: 'qa-repair' });
                    r.activeRunId = run.id;
                    this.save(doc, 'workflow.qa_repair_started', { runId: run.id, number: r.qaRepairs, authorization: authorized });
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
    private async qualityEvidence(r: SpecRecord, final: Run, signal?: AbortSignal) {
        if (r.config.workflow.qualityReview !== 'evidence') return undefined;
        const trees = await Promise.all([r.baseSha, final.candidateSha!].map(sha => this.trackedPaths(r.repo, sha, signal)));
        return { context: qualityContext(r, final), paths: new Set(trees.flatMap(tree => [...tree])), candidatePaths: trees[1]! };
    }
    private qaMarkdown(r: SpecRecord): string {
        if (!r.qa) return '# QA\n\nQA was not required for this candidate.\n';
        const q=r.qa.report; const lines=['# QA review','',`Verdict: **${q.verdict}**`,'',q.summary,'','## Acceptance criteria'];
        for (const c of q.criteria) lines.push(`- **${c.id}** — ${c.status}: ${c.evidence}`);
        lines.push('','## Findings');
        if (!q.findings.length) lines.push('- None');
        else for (const f of q.findings) lines.push(`- **${f.severity} · ${findingRequiresFix(f) ? 'correction requise' : 'observation'}** ${f.id}${f.path ? ` (${f.path})` : ''}: ${f.description}`);
        if (q.securityChecks.length) lines.push('','## Security checks',...q.securityChecks.map(x=>`- **${x.requirementId}** — ${x.status}: ${x.evidence}`));
        if (q.negativeTestChecks?.length) {
            lines.push('', '## Negative tests', ...q.negativeTestChecks.map(x =>
                `- ${x.requirementId}[${x.testIndex}]: ${x.status}; ${x.evidence}\n  Tests: ${x.status === 'review' ? 'none (review)' : x.paths.join(', ')}; receipts: ${x.receiptIds.join(', ')}; inspected: ${[...(x.inspectedPaths ?? []), ...(x.status === 'review' ? x.paths : [])].join(', ')}`));
            // A case the spec defined as a review is asserted, never proven: the human reviewer decides.
            const reviewed = q.negativeTestChecks.filter(x => x.status === 'review');
            if (reviewed.length) lines.push('', `### Asserted by review, not proven by a test (${reviewed.length})`,
                'The approved spec defines these negative cases as reviews. No test executes them; read the evidence and judge it yourself.',
                ...reviewed.map(x => `- ${x.requirementId}[${x.testIndex}]: ${x.evidence}`));
        }
        if (q.decisionChecks.length) lines.push('','## Decision checks',...q.decisionChecks.map(x=>`- **${x.decisionId}** — ${x.status}: ${x.evidence}`));
        if (q.qualityChecks?.length) lines.push('', '## Code quality', ...q.qualityChecks.map(x =>
            `- **${x.axis}** — ${x.status}: ${x.evidence}\n  Paths: ${x.paths.join(', ') || 'none'}; receipts: ${x.receiptIds.join(', ') || 'none'}; findings: ${x.findingIds.join(', ') || 'none'}`));
        if (q.observations.length) lines.push('','## Observations',...q.observations.map(x=>`- ${x}`));
        return lines.join('\n')+'\n';
    }
    /** The approved mockup QA compares the candidate against; bounded like the Implementer's copy. */
    private qaDesignContext(r: SpecRecord) {
        if (!r.design) return null;
        const p = r.design.proposal;
        const within = JSON.stringify(p.screens).length + p.css.length <= DESIGN_CONTEXT_BUDGET;
        return { hash: r.design.hash, summary: p.summary, visualDirection: p.visualDirection, decisions: p.decisions, avoid: p.avoid,
            indexPath: r.design.indexPath, screenPaths: r.design.screenPaths,
            ...(within ? { css: p.css } : {}),
            screens: p.screens.map(x => within
                ? { id: x.id, title: x.title, purpose: x.purpose, states: x.states, responsive: x.responsive, bodyHtml: x.bodyHtml }
                : { id: x.id, title: x.title, purpose: x.purpose, states: x.states, responsive: x.responsive }),
            note: 'The operator approved this mockup with the spec. Report a visible departure from it as a finding; do not demand pixel equality.' };
    }
    private async prepareReviewWorkspace(doc: Document<SpecRecord>, final: Run): Promise<void> {
        const r=doc.data; invariant(final.candidateSha,'CANDIDATE','Review candidate is missing');
        const root=resolve(dirname(r.repo),`${basename(r.repo)}-review`,doc.id); const candidate=join(root,'candidate');
        invariant(!isInside(r.repo,root) && !isInside(this.store.root,root),'REVIEW_PATH','Review workspace must be outside source and operational state');
        const git=new Git();
        // The documents describe a candidate, a spec, a design and a QA report: reuse them only when all of
        // those are unchanged. Keying on the candidate alone left QA.md showing a replaced report.
        const bundleHash = hash({ candidate: final.candidateSha, spec: r.contentHash, design: r.design?.hash ?? null,
            qa: r.qa ? hash(r.qa) : null, receipts: final.receipts.map(x => ({ gateId: x.gateId, status: x.status })) });
        if (r.review?.bundleHash === bundleHash && existsSync(r.review.candidateDirectory)) {
            await git.clean(r.review.candidateDirectory,final.candidateSha); return;
        }
        const sameCandidate = r.review?.candidateSha === final.candidateSha && existsSync(candidate);
        if (existsSync(candidate) && !sameCandidate) {
            try { await git.removeWorkspace(r.repo,candidate,root); } catch { /* stale review material is removed below; never trusted */ }
        }
        mkdirSync(root,{recursive:true,mode:0o700});
        // Never the whole directory: the approved design bundle is its sibling, and the operator is told to
        // open it before approving. Only the entries this workspace owns are rebuilt.
        for (const entry of REVIEW_ENTRIES) if (!(sameCandidate && entry === 'candidate')) rmSync(join(root,entry),{recursive:true,force:true});
        if (sameCandidate) await git.clean(candidate,final.candidateSha);
        else await git.workspace(r.repo,candidate,final.candidateSha);
        const patchPath=join(root,'candidate.patch'); const qaPath=join(root,'QA.md'); const reviewPath=join(root,'REVIEW.md'); const inventoryPath=join(root,'INVENTORY.md');
        const patch=await git.patch(r.repo,r.baseSha,final.candidateSha);
        writeFileSync(patchPath,patch,{mode:0o600}); writeFileSync(qaPath,this.qaMarkdown(r),{mode:0o600});
        const languages = r.config.knowledge?.languages ?? [];
        const candidateInventory = await this.inventoryAt(r.repo, final.candidateSha, languages);
        writeFileSync(inventoryPath, inventoryMarkdown(candidateInventory), { mode: 0o600 });
        const delta = diffInventory(await this.inventoryAt(r.repo, r.baseSha, languages), candidateInventory);
        const surfaceLines = [
            ...(delta.added.length ? delta.added.map(x => `- added \`${x.name}\` (${x.kind}) in \`${x.path}\``) : ['- no new public declaration or file-level unit']),
            ...delta.removed.map(x => `- removed \`${x.name}\` (${x.kind}) from \`${x.path}\``),
            ...delta.possibleDuplicates.map(x => `- possible duplicate: \`${x.added.name}\` in \`${x.added.path}\` vs existing \`${x.existing.name}\` in \`${x.existing.path}\``),
        ].join('\n');
        const gateLines=final.receipts.map(x=>`- ${x.gateId}: ${x.status}`).join('\n');
        const securityLines = r.content?.security.requirements.length ? r.content.security.requirements.map(x=>`- ${x.id}: ${x.title} [${x.owaspTopics.join(', ')}]`).join('\n') : '- none';
        const text=[`# Candidate review`,``,`Candidate: ${final.candidateSha}`,`Risk: ${final.risk?.lane ?? 'unknown'}`,`Review mode: ${r.config.workflow.reviewMode}`,`Security minimum: ${r.securityContext.minimumLane}`,`OWASP topics: ${r.securityContext.topics.map(x=>x.id).join(', ') || 'none'}`,``,`Open this directory in your editor:`,``,candidate,``,`Patch: ${patchPath}`,`QA: ${qaPath}`,`Inventory: ${inventoryPath}`,...(r.design ? [`Approved design: ${r.design.indexPath}`,...r.design.screenPaths.map(p=>`  - ${p}`)] : []),``,`## Gates`,gateLines || '- none',``,qualityMarkdown(qualityContext(r, final)),``,`## Public surface changes`,surfaceLines,``,`## Security requirements`,securityLines,''].join('\n');
        writeFileSync(reviewPath,text,{mode:0o600});
        r.review={directory:root,candidateDirectory:candidate,patchPath,qaPath,reviewPath,candidateSha:final.candidateSha,bundleHash};
        this.save(doc,'workflow.review_workspace_ready',{review:r.review});
    }

    /**
     * True when the run enforced the gates the spec requires, amendments included.
     * Both sides go through the gate contract: a spec approved before a gate field existed stores
     * gates without it, and comparing the stored shapes would block publication on a default value
     * rather than on a real difference of command, coverage or scope.
     */
    private sameGates(r: SpecRecord, run: Run): boolean {
        const normalized = (config: Config) => config.gates.map(g => ({ ...gateSchema.parse(g), mandatory: true }));
        return hash(normalized(this.runConfig(r))) === hash(normalized(run.config));
    }

    private async reviewable(r: SpecRecord): Promise<Run> {
        const spec = this.approved(r);
        invariant(r.finalRunId, 'STATE', 'No integrated candidate');
        const final = this.pipeline.store.get(r.finalRunId);
        invariant(final.candidateSha === r.currentSha, 'CANDIDATE', 'Final candidate is stale');
        invariant(this.sameGates(r, final), 'QA_REQUIRED', 'Final validation must cover the amended gates');
        const evidenceHash = await this.pipeline.assertValidated(final.id);
        assertRequiredEvidence(qualityContext(r, final).validation);
        if (requiresQa(r, final, spec))
            invariant(r.qa && r.qa.specHash === r.contentHash && r.qa.evidenceHash === evidenceHash && r.qa.report.candidateSha === final.candidateSha && r.qa.report.verdict === 'pass', 'QA_REQUIRED', 'A passing QA assessment must cover the exact candidate and evidence');
        if (requiresQa(r, final, spec) && r.config.workflow.qualityReview === 'evidence')
            validateQa(r.qa!.report, spec, final.candidateSha!, r.decisionLedger, await this.qualityEvidence(r, final));
        return final;
    }
    /** Publication adapters still acquire the lifecycle lease and require explicit consent. */
    async publicationCandidate(id: string, purpose: 'review' | 'delivery' = 'delivery'): Promise<Run> {
        const doc = this.get(id);
        invariant(!['closed', 'rejected'].includes(doc.data.status), 'STATE', 'Spec cannot be published');
        const final = await this.reviewable(doc.data);
        // A draft PR for reading still requires validated gates and a passing QA on this exact candidate;
        // only the operator's approval, which the reading is meant to inform, is not required yet.
        if (purpose === 'review') invariant(['awaiting_review', 'ready'].includes(doc.data.status) && ['awaiting_review', 'ready'].includes(final.state), 'STATE', 'Only a validated candidate awaiting review can be opened for reading');
        else await this.pipeline.exportPatch(final.id);
        return final;
    }
    /**
     * The source repository must be clean and still checked out on the spec's base: a plan approved
     * against one state of the repository must not be implemented against another.
     *
     * One case is exempt. When the checked-out branch already contains this spec's own candidate, the
     * base moved precisely because this work was merged; nothing about the spec is stale, and holding
     * it to the old HEAD would leave it unable to finish its own review and closure. Workspaces are
     * detached worktrees created at explicit commits, so the branch position never reaches them.
     */
    private async sourceReady(r: SpecRecord, signal?: AbortSignal): Promise<void> {
        const git = new Git(signal);
        if (r.currentSha !== r.baseSha && await git.contains(r.repo, await git.sha(r.repo), r.currentSha)) {
            await git.clean(r.repo);
            await git.sha(r.repo, r.baseSha);
            return;
        }
        await git.clean(r.repo, r.baseSha);
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
            const qa: QaRecord = { report: validateQa(value, spec, final.candidateSha!, r.decisionLedger, await this.qualityEvidence(r, final)), evidenceHash, specHash: r.contentHash!, at: Date.now(), source: 'operator-import' };
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
            // A rejected spec has no active run: keeping the pointer made maintenance treat it as running forever.
            const activeRunId = doc.data.activeRunId;
            if (activeRunId) {
                invariant(!this.pipeline.store.activeProcesses(activeRunId).some(p => p.alive), 'BUSY', `Run ${activeRunId} still has a live process; stop it before rejecting`);
                doc.data.activeRunId = null;
            }
            doc.data.status = 'rejected';
            doc.data.error = { code: 'REJECTED', message: note };
            this.save(doc, 'spec.rejected', { note, releasedRunId: activeRunId });
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
            const remaining = (r.operational?.maxActiveMs ?? r.config.workflow.maxActiveMs) - r.activeMs - (r.planningMs ?? 0);
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
    /**
     * Authorize exactly one quality repair on a spec stopped by evidence the review could not conclude on.
     *
     * The controller never grants this by itself: an unknown assessment can mean the configured checks
     * cannot produce that proof at all, and no code change would ever close it. The operator states,
     * with a note, that the gap is in the candidate rather than in the configuration, and accepts the
     * extra round. Every check must already have proved this candidate, so the repair answers a real
     * gap and not a missing receipt; the next quality review still has to conclude on its own evidence.
     */
    authorizeQaRepair(id: string, actor: string, note: string): Document<SpecRecord> {
        reviewer(actor, note);
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            const r = doc.data;
            this.approved(r);
            invariant(r.status === 'blocked' && ['QA_EVIDENCE', 'QA_REJECTED'].includes(r.error?.code ?? ''), 'STATE',
                'Only a spec stopped by a quality review can authorize a repair');
            invariant(r.qa?.report.verdict === 'changes_requested', 'STATE', 'No quality review requesting changes');
            invariant(!r.qaRepairAuthorization, 'STATE', 'A quality repair is already authorized');
            invariant(r.finalRunId, 'STATE', 'No integrated candidate');
            const final = this.pipeline.store.get(r.finalRunId);
            invariant(final.candidateSha === r.currentSha, 'CANDIDATE', 'Final candidate is stale');
            invariant(this.runConfig(r).gates.every(g => final.receipts.some(x => x.gateId === g.id &&
                x.candidateSha === final.candidateSha && ['passed', 'cached'].includes(x.status))), 'QA_EVIDENCE',
                'A configured check has not proved this candidate; revalidate before authorizing a repair');
            r.qaRepairAuthorization = { at: Date.now(), reviewer: actor.trim(), note: note.trim() };
            r.error = null;
            this.save(doc, 'workflow.qa_repair_authorized', { authorization: r.qaRepairAuthorization, candidateSha: final.candidateSha });
            return doc;
        }
        finally { this.store.releaseDocument(id, token); }
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
            // A stopped agent leaves a salvageable attempt: retrying is the operator's explicit way to discard it.
            invariant(failed.state === 'failed' || (failed.state === 'interrupted' && failed.resumeFrom === 'implementing'), 'STATE',
                'Only a terminal failure or a stopped agent can be retried; an interrupted validation needs resume/recovery');
            if (r.finalRunId === r.activeRunId) {
                r.finalRunId = null;
                r.activeRunId = null;
            }
            else {
                const attempt = r.attempts.find(a => a.runId === failed.id);
                invariant(attempt, 'STATE', 'Failed attempt missing from history');
                // Rebuild the task from the current state: a frozen copy would ignore amendments, criterion
                // corrections and repair guidance approved or released since the failed attempt was created.
                const specTask = this.approved(r).tasks.find(t => t.id === attempt.taskId);
                const rebuilt = attempt.kind === 'qa-repair' && r.qa ? this.qaRepairTask(r) : specTask ? this.makeTask(r, specTask) : null;
                const task = rebuilt ? this.withPreviousAttempt(r, rebuilt, failed) : failed.task;
                // A scope amendment validates retained code with maxRepairAttempts=0. That temporary
                // validation policy must not become the policy of a fresh implementation attempt.
                const replacement = await this.pipeline.create({ repo: r.repo, baseRef: failed.baseSha, specId: doc.id, config: this.runConfig(r), task });
                r.attempts.push({ ...attempt, runId: replacement.id });
                r.activeRunId = replacement.id;
            }
            r.status = 'running';
            r.error = null;
            this.save(doc, 'workflow.retry_authorized', { previousRunId: failed.id, replacementRunId: r.activeRunId, taskRebuilt: r.activeRunId !== null && this.pipeline.store.get(r.activeRunId).task.description !== failed.task.description });
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
            if (r.planningStartedAt) {
                r.planningMs = (r.planningMs ?? 0) + Math.max(0, Date.now() - r.planningStartedAt);
                r.planningStartedAt = null;
            }
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
            const files: Record<string, string> = { 'candidate.patch': patch, 'spec.md': specMarkdown(r, id), 'evidence.json': JSON.stringify({ specId: id, specHash: r.contentHash, productApproval: r.approval, qa: r.qa, quality: qualityContext(r, final), run: summarize(final), receipts: final.receipts, approvals: final.approvals }, null, 2) + '\n', 'events.jsonl': this.store.documentEvents(id).map(e => JSON.stringify(e)).join('\n') + '\n', 'run-events.jsonl': [...new Set([...r.attempts.map(a => a.runId), ...r.validationRunIds])].flatMap(runId => this.store.events(runId)).map(e => JSON.stringify(e)).join('\n') + '\n' };
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
            // A reviewed candidate is enough: the operator may integrate it without exporting a bundle first.
            invariant(r.finalRunId && ['delivered', 'ready'].includes(r.status), 'STATE', 'Review the validated candidate before observing its integration');
            const final = this.pipeline.store.get(r.finalRunId);
            invariant(final.state === 'ready' && final.candidateSha === r.currentSha, 'STATE', 'The final run must hold the reviewed current candidate');
            const candidateSha = r.delivery?.candidateSha ?? final.candidateSha!;
            const git = new Git();
            await git.exec(r.repo, ['check-ref-format', `refs/heads/${ref}`]);
            const observed = await git.sha(r.repo, `refs/heads/${ref}`);
            invariant(observed === mergeSha, 'MERGE_SHA', 'Name the exact observed integration head');
            await git.exec(r.repo, ['merge-base', '--is-ancestor', candidateSha, mergeSha]);
            r.status = 'closed';
            this.save(doc, 'spec.closed', { source: 'local-git-observation', target: ref, mergeSha, candidateSha, delivered: Boolean(r.delivery), reviewer: actor, note, notADeployment: true });
            return doc;
        }
        finally {
            this.store.releaseDocument(id, token);
        }
    }
    /** Deterministic public-surface change between the approved base and the integrated candidate. */
    private async inventoryDelta(r: SpecRecord, candidateSha: string, signal?: AbortSignal): Promise<InventoryDelta> {
        const languages = r.config.knowledge?.languages ?? [];
        return diffInventory(await this.inventoryAt(r.repo, r.baseSha, languages, signal), await this.inventoryAt(r.repo, candidateSha, languages, signal));
    }
    summary(doc: Document<SpecRecord>): Record<string, unknown> {
        const r = doc.data;
        const final = r.finalRunId ? this.pipeline.store.get(r.finalRunId) : null;
        // A stopped agent left its work in the run workspace; the operator adopts or discards it explicitly.
        const active = r.activeRunId ? this.pipeline.store.get(r.activeRunId) : null;
        const stopped = active && active.state === 'interrupted' && active.resumeFrom === 'implementing' && r.status === 'blocked' ? active : null;
        const pendingPlan = r.planRevisions?.find(p => p.status === 'pending' && p.contextHash === replanContext(r));
        let next: string;
        // A round that failed leaves a spec with nothing to approve: relaunching Product is the way out,
        // not an approval of a hash that does not exist.
        if (!r.approval && !r.content)
            next = `apv2 spec plan-resume ${doc.id}   (resume retained planning checkpoints; adjust limits first with spec budget if needed)`;
        else if (!r.approval && r.error)
            next = `apv2 spec plan-resume ${doc.id}   (complete the retained Product/Design proposal)`;
        else if (!r.approval)
            next = (r.content?.questions.length || r.design?.proposal.questions.length) ? `apv2 spec refine ${doc.id} --request "answers to the displayed questions"` : `apv2 spec approve ${doc.id} --hash ${approvalHash(r) ?? 'NO_VALID_PROPOSAL'} --approve`;
        else if (pendingPlan && r.status === 'blocked')
            next = `apv2 spec replan ${doc.id} --amendment ${pendingPlan.id} --hash ${pendingPlan.hash} --approve --note "why the remaining tasks need revision"`;
        else if (r.status === 'awaiting_review')
            next = `apv2 spec review ${doc.id} --sha ${final?.candidateSha} --approve`;
        else if (r.error?.code === 'MERGED_BEFORE_REVIEW')
            next = `apv2 spec review ${doc.id} --sha ${r.currentSha} --approve   (after apv2 spec verify ${doc.id} if the evidence expired; then apv2 spec sync ${doc.id})`;
        else if (r.publication?.url && r.status !== 'closed' && r.status !== 'rejected')
            next = `apv2 spec sync ${doc.id}`;
        else if (r.status === 'ready')
            next = `apv2 spec deliver ${doc.id} --output /path/to/new-delivery   (or, once you have merged it yourself: apv2 spec close ${doc.id} --target main --sha MERGED_HEAD --reviewer NAME --note TEXT)`;
        else if (r.status === 'delivered')
            next = `apv2 spec branch ${doc.id} --name feature/my-change --confirm`;
        else if (r.status === 'closed' || r.status === 'rejected')
            next = 'No automatic action; create a new spec for additional changes.';
        else if (r.error?.code === 'QA_REQUIRED')
            next = `apv2 spec qa ${doc.id} --file /path/to/qa-report.json`;
        // A blocked spec needs the action that lifts its blocker. Recommending `run` again made the operator
        // replay a command that reproduces the same stop, with the amendment id left for them to find.
        else if (r.error?.code === 'SCOPE_AMENDMENT_REQUIRED') {
            const pending = r.scopeAmendments.filter(a => a.status === 'pending').at(-1);
            next = pending
                ? `apv2 spec amend ${doc.id} --amendment ${pending.id} --approve   (then apv2 spec run ${doc.id}; reject the amendment instead if the paths are not in scope)`
                : `Inspect the blocked run: the amendment it required is no longer pending.`;
        }
        else if (r.error?.code === 'QA_REJECTED')
            next = `Read the QA findings above, then create a follow-up spec: the automatic repair budget is spent (apv2 spec draft --repo ${r.repo} --request "...").`;
        else if (r.error?.code === 'QA_REVIEW_AUTHORIZATION')
            next = `Inspect the named negative case: provide its executable test evidence, or propose a justified reviewTestIndexes correction with apv2 spec criterion ${doc.id} --criterion AC_ID --file CORRECTION_JSON and approve its exact hash. Do not rerun unchanged.`;
        else if (r.error?.code === 'COST_BUDGET' || r.error?.code === 'QA_BUDGET')
            next = `apv2 spec budget ${doc.id} --file LIMITS_JSON --approve --note TEXT   (set an explicit remaining-work allowance, then resume; --accept-cost is an unbounded override)`;
        else if (stopped)
            next = `The agent stopped before reporting; its work is kept in ${stopped.workspace}. Inspect it, then apv2 spec run ${doc.id} --accept-current to snapshot and validate it, or apv2 spec retry ${doc.id} --confirm to discard it and start the task again.`;
        else if (r.error?.code === 'CANCELLED' || r.error?.code === 'LOCKED')
            next = `apv2 spec recover ${doc.id} --confirm-stopped   (only after checking no controller or agent process is still alive)`;
        else if (r.error?.code === 'TASK_FAILED' || r.error?.code === 'REPAIR_NO_CHANGE' || r.error?.code === 'GATES_FAILED' || r.error?.code === 'REPAIR_NO_PROGRESS')
            next = `apv2 spec retry ${doc.id} --confirm   (authorizes exactly one new attempt of the failed task)`;
        else if (r.error?.code === 'NO_CHANGE') {
            const last = [...r.attempts].reverse().find(a => a.kind === 'qa-repair' || a.kind === 'task');
            const said = last ? (this.pipeline.store.get(last.runId).summary ?? '').replace(/\s+/g, ' ').slice(0, 300) : '';
            next = `The last attempt changed nothing${said ? ` and explained: "${said}"` : ''}. Read it with apv2 spec events ${doc.id}; then apv2 spec retry ${doc.id} --confirm if a change is still expected, or create a follow-up spec.`;
        }
        else if (r.error?.code === 'QA_EVIDENCE')
            next = `Inspect required validation and unknown assessments. Missing commands or testPaths require a reviewed configuration and a new spec; keep the candidate for reuse. An imported QA report cannot replace missing runner evidence.${final && ['ready', 'awaiting_review'].includes(final.state) ? ` Replay configured gates with apv2 spec verify ${doc.id}, or complete the QA references with apv2 spec qa ${doc.id} --file qa.json. If every check proved this candidate and the gap is in the candidate itself, apv2 spec qa-repair ${doc.id} --confirm --note TEXT authorizes exactly one repair.` : ''}`;
        else if (r.error?.code === 'STALE_EVIDENCE')
            next = `apv2 spec verify ${doc.id}   (replays the gates on the same candidate; then apv2 spec run ${doc.id})`;
        else if (r.status === 'blocked' && r.error)
            next = `Resolve ${r.error.code} before running again: ${r.error.message.slice(0, 200)}`;
        else
            next = `apv2 spec run ${doc.id}`;
        const history = this.store.documentEvents(doc.id);
        const runIds = [...new Set([...r.attempts.map(a => a.runId), ...r.validationRunIds])];
        const timing = phaseTimings(history, runIds.map(id => ({ run: this.store.get(id), events: this.store.events(id, ['invocation.started', 'invocation.finished']) })), Date.now());
        const decisions = history.filter(e => e.type === 'planning.path_selected').map(e => e.data).slice(-1);
        return { timing, stop: stopAdvice(r.error), decisions, id: doc.id, planRevisions: (r.planRevisions ?? []).map(p => ({ id: p.id, reason: p.reason, taskIds: p.tasks.map(t => t.id), hash: p.hash, status: p.status, at: p.at, approval: p.approval })), failedChecks: active ? this.store.failureDiagnostics(active).map(x => ({ runId: active.id, candidateSha: x.candidateSha, gateId: x.gateId, diagnostic: x.diagnostic, authoritative: false })) : [], models: modelPlan(r.config, r.operational), modelOverrides: r.operational ? { agent: r.operational.agent, roles: r.operational.roles ?? {} } : null, executionPath: r.executionPath ?? 'legacy', architecture: r.architecture ?? null, maxActiveMs: r.operational?.maxActiveMs ?? r.config.workflow.maxActiveMs, cost: this.costSummary(doc.id), planningMs: Math.round(r.planningMs ?? 0), revision: r.revision, status: r.status, title: r.content?.title ?? null, hash: approvalHash(r), specHash:r.contentHash, security:{contextHash:r.securityContextHash ?? null,minimumLane:r.securityContext?.minimumLane ?? null,requiresThreatModel:r.securityContext?.requiresThreatModel ?? null,topics:r.securityContext?.topics.map(x=>x.id) ?? [],requirements:r.content?.security?.requirements.map(x=>x.id) ?? []}, design:r.design ? {hash:r.design.hash,directory:r.design.directory,indexPath:r.design.indexPath,summary:r.design.proposal.summary,questions:r.design.proposal.questions} : null, baseSha: r.baseSha, candidateSha: r.currentSha, questions: r.content?.questions ?? [], tasks: r.content?.tasks.map(t => ({ id: t.id, title: t.title, done: r.completedTaskIds.includes(t.id), dependsOn: t.dependsOn })) ?? [], attempts: r.attempts, validationRunIds: r.validationRunIds, activeRunId: r.activeRunId, finalRun: final ? summarize(final) : null, quality: (final ?? active)?.candidateSha ? qualityContext(r, (final ?? active)!) : null, qa: r.qa, activeMs: Math.round(r.activeMs), error: r.error, delivery: r.delivery, publication: r.publication, impactAdvice: r.impactAdvice ?? [], sizeAdvice: r.sizeAdvice ?? [], stoppedWork: stopped ? { runId: stopped.id, workspace: stopped.workspace } : null, nextAction: next, approvalIdentityWarning: 'Local reviewer labels are not authenticated identities.' };
    }
}
