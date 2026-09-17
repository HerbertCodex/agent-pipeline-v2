import { mkdirSync, writeFileSync, renameSync, existsSync, lstatSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, relative, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pipeline, summarize } from '../engine/pipeline.js';
import { validateConfig, taskSchema, DEFAULT_LIMITS } from '../domain/contracts.js';
import { hash, sha256 } from '../domain/hash.js';
import { PipelineError, errorMessage, invariant } from '../domain/errors.js';
import { Git, isInside } from '../execution/git.js';
import { specSchema, qaSchema, designProposalSchema, validateSpec, assertSpecReadiness, criterionAmendmentHash, validateQa, specHash, approvalHash, specMarkdown, stricter, reviewer } from './contracts.js';
import { runRole } from './roles.js';
import { executionCapabilities, validateTaskCapabilities } from './capabilities.js';
import { matches, requiredApprovals } from '../policy/policy.js';
import { inspectRepository } from '../knowledge/repository.js';
import { buildInventory, diffInventory, inventoryMarkdown, testsReferencing } from '../knowledge/inventory.js';
import { confirmedDecisions, ledgerHash, loadDecisionLedger } from './decisions.js';
import { assessSecurity, neutralSecurityContext } from '../security/owasp.js';
const FORBIDDEN_TAG = /^(?:script|iframe|object|embed|link|meta|base|frame|frameset|applet|portal)$/i;
const FORBIDDEN_ATTRIBUTE = /^(?:src|srcdoc|srcset|data|background|lowsrc|dynsrc|xlink:href)$/i;
const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
/** Types a static preview can carry inline. No SVG: it is a scriptable document, not a picture. */
const ASSET_TYPES = {
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};
const MAX_ASSET_BYTES = 512 * 1024;
const MAX_ASSET_TOTAL_BYTES = 2 * 1024 * 1024;
/** Characters of approved mockup (markup plus stylesheet) a task may carry before it degrades to a reference. */
const DESIGN_CONTEXT_BUDGET = 60000;
/** Everything the review workspace owns. The design bundle lives beside it and must survive its rebuilds. */
const REVIEW_ENTRIES = ['candidate', 'candidate.patch', 'QA.md', 'REVIEW.md', 'INVENTORY.md'];
/**
 * Elements and their attributes, quote-aware so a `>` inside an attribute value cannot end a tag early.
 * Text between tags is displayed content: a mockup may legitimately show `src=`, a URL or escaped markup
 * as text, and the validator must not confuse that with an element that loads something.
 */
export function scanTags(html) {
    const tags = [];
    for (let i = html.indexOf('<'); i !== -1; i = html.indexOf('<', i)) {
        const opening = /^<\/?\s*([a-zA-Z][a-zA-Z0-9:._-]*)/.exec(html.slice(i));
        if (!opening) {
            i++;
            continue;
        } // A bare "<" in prose is text, not an element.
        let end = i + opening[0].length;
        for (let quote = ''; end < html.length; end++) {
            const c = html[end];
            if (quote) {
                if (c === quote)
                    quote = '';
            }
            else if (c === '"' || c === "'")
                quote = c;
            else if (c === '>')
                break;
        }
        const attributes = [...html.slice(i + opening[0].length, end).matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)]
            .map(m => ({ name: m[1], value: (m[2] ?? '').replace(/^(['"])([\s\S]*)\1$/, '$2') }));
        tags.push({ name: opening[1].toLowerCase(), attributes });
        i = end + 1;
    }
    return tags;
}
/** Freshly produced spec output that asks no question must already be executable; a draft with a question may not be. */
function readySpec(spec) {
    return spec.questions.length === 0 ? assertSpecReadiness(spec) : spec;
}
export class Lifecycle {
    pipeline;
    /** Inventories keyed by immutable commit SHA and language profiles; bounded, never invalidated. */
    inventories = new Map();
    constructor(stateDir) { this.pipeline = new Pipeline(stateDir); }
    inventoryAt(repo, sha, languages = [], signal) {
        invariant(/^[0-9a-f]{40,64}$/.test(sha), 'REPOSITORY_INDEX', 'Inventory cache requires an immutable commit SHA');
        const key = `${repo}\0${sha}\0${hash(languages)}`;
        let pending = this.inventories.get(key);
        if (!pending) {
            pending = buildInventory(repo, sha, { languages, ...(signal ? { signal } : {}) });
            pending.catch(() => this.inventories.delete(key));
            this.inventories.set(key, pending);
            while (this.inventories.size > 32)
                this.inventories.delete(this.inventories.keys().next().value);
        }
        return pending;
    }
    get store() { return this.pipeline.store; }
    close() { this.pipeline.close(); }
    get(id) {
        const doc = this.store.document(id, 'spec');
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
        if (r.design)
            invariant(r.design.hash === hash(r.design.proposal), 'DB_CORRUPT', 'Design proposal/hash mismatch');
        return doc;
    }
    save(doc, type, data = {}) { this.store.saveDocument(doc, type, data); }
    approved(r) {
        invariant(r.content && r.approval && r.contentHash === specHash(r) && r.approval.hash === approvalHash(r), 'SPEC_APPROVAL', 'An exact, current spec/design approval is required');
        if (this.requiresDesign(r.content, r.config.skills.projectType))
            invariant(r.design && r.design.proposal.questions.length === 0, 'DESIGN_APPROVAL', 'An approved UI design mockup is required before implementation');
        const spec = validateSpec(r.content, true, r.decisionLedger, r.request, r.securityContext);
        // The stored content keeps exactly what the operator approved; corrections are applied on the way
        // out, each carrying its own approval, so the original text stays auditable.
        const corrections = (r.criterionAmendments ?? []).filter(a => a.status === 'approved');
        const scopes = r.scopeAmendments.filter(a => a.status === 'approved');
        if (!corrections.length && !scopes.length)
            return spec;
        const latest = [...corrections].reverse();
        return { ...spec,
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
                    return fix ? { ...q, verification: fix.verification } : q;
                }) },
        };
    }
    /** See SpecRecord.impactAdvice. Tasks are walked in dependency order, like execution. */
    async impactAdvice(r, spec, signal) {
        const inventory = await this.inventoryAt(r.repo, r.baseSha, r.config.knowledge?.languages ?? [], signal);
        // The spec is already validated against its ledger; order it without revalidating (taskOrder would
        // check it against an empty ledger and reject any spec covering a project decision).
        const order = [];
        const done = new Set();
        const visit = (t) => { if (done.has(t.id))
            return; done.add(t.id); t.dependsOn.forEach(id => { const dep = spec.tasks.find(x => x.id === id); if (dep)
            visit(dep); }); order.push(t); };
        spec.tasks.forEach(visit);
        const covers = (t, path) => t.allowedPaths.some(p => matches(path, p));
        const advice = [];
        for (const [i, task] of order.entries()) {
            const changed = task.allowedPaths.filter(p => !/[*?]/.test(p) && !/(^|[./_-])(test|spec)s?([./_-]|$)/i.test(p));
            for (const ref of await testsReferencing(r.repo, inventory, changed, signal)) {
                if (covers(task, ref.path) || order.slice(0, i).some(t => covers(t, ref.path)))
                    continue;
                if (advice.some(a => a.test === ref.path))
                    continue;
                const later = order.slice(i + 1).find(t => covers(t, ref.path));
                advice.push({ test: ref.path, changedBy: task.id, assignedTo: later?.id ?? null, tokens: ref.tokens });
            }
        }
        return advice;
    }
    /**
     * What each completed attempt reported. A criterion may require the Implementer to report something
     * (an observation outside scope, a limitation); without these summaries QA can only answer "unknown".
     */
    taskSummaries(r) {
        return r.attempts.map(a => {
            const run = this.pipeline.store.get(a.runId);
            return { taskId: a.taskId, kind: a.kind, state: run.state, summary: (run.summary ?? '').slice(0, 6000) };
        }).filter(x => x.summary.length > 0);
    }
    /** Operator decisions made after approval, shown to QA with their reasons: they postdate the spec text. */
    approvedAmendments(r) {
        return {
            criteria: (r.criterionAmendments ?? []).filter(a => a.status === 'approved').map(a => ({ criterionId: a.criterionId, previous: a.previous, description: a.description, verification: a.verification, requirements: a.requirements ?? [], reason: a.reason, reviewer: a.reviewer, note: a.note })),
            scope: r.scopeAmendments.filter(a => a.status === 'approved').map(a => ({ taskId: a.taskId, paths: a.paths, reason: a.reason, reviewer: a.reviewer, note: a.note })),
        };
    }
    async draft(options) {
        invariant(options.request.trim().length > 0 && options.request.length <= 30000, 'REQUEST', 'Provide a request up to 30000 characters');
        const git = new Git();
        const repo = await git.root(options.repo);
        await git.clean(repo);
        const baseSha = await git.sha(repo);
        await git.compatible(repo, baseSha);
        invariant(!isInside(repo, this.store.root) && !isInside(this.store.root, repo), 'STATE_PATH', 'State and project must be disjoint');
        const config = validateConfig(options.config);
        const decisionLedger = await loadDecisionLedger(repo, baseSha);
        const r = { repo, baseSha, config, configHash: hash(config), revision: 1, request: options.request, decisionLedger, decisionLedgerHash: ledgerHash(decisionLedger), securityContext: neutralSecurityContext(), securityContextHash: hash(neutralSecurityContext()), content: null, contentHash: null, approval: null, status: 'draft', attempts: [], completedTaskIds: [], currentSha: baseSha, activeRunId: null, finalRunId: null, validationRunIds: [], qa: null, qaRepairs: 0, design: null, scopeAmendments: [], review: null, sessionStartedAt: null, activeMs: 0, delivery: null, publication: null, error: null };
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
    requiresDesign(spec, projectType) {
        if (!['frontend', 'mobile', 'fullstack'].includes(projectType))
            return false;
        if (spec.experience.uiImpact !== 'none')
            return true;
        // Product's declared uiImpact is authoritative; this fallback only reads generic interface vocabulary, never framework file types.
        const text = [spec.title, spec.problem, ...spec.scope, ...spec.tasks.flatMap(t => [t.title, t.description])].join(' ');
        return /(?:\bui\b|user interface|interface utilisateur|screen|dashboard|\bform\b|modal|layout|écran|ecran|tableau de bord|formulaire)/i.test(text);
    }
    companionPaths(paths) {
        const out = new Set();
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
    validateDesignMarkup(p) {
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
                    if (/^style$/i.test(attribute.name))
                        this.validateDesignUrls(attribute.value, declared, `style attribute of ${where}`);
                }
            }
        }
        invariant(!/@import\b|expression\s*\(|javascript:/i.test(p.css), 'DESIGN_MARKUP', 'Design CSS cannot import stylesheets or carry executable content');
        this.validateDesignUrls(p.css, declared, 'design CSS');
    }
    /** url() is allowed only as url(asset:ID) for a repository file the proposal declares; the controller inlines it. */
    validateDesignUrls(css, declared, where) {
        for (const [, , target] of css.matchAll(CSS_URL)) {
            const asset = /^asset:(.+)$/i.exec(target.trim())?.[1];
            invariant(asset, 'DESIGN_MARKUP', `url(${target.slice(0, 80)}) in ${where} is not allowed; reference a declared repository file as url(asset:ID)`);
            invariant(declared.has(asset), 'DESIGN_MARKUP', `url(asset:${asset}) in ${where} is not declared in assets`);
        }
    }
    /**
     * Preview copy of the proposal with every url(asset:ID) replaced by an inline data: URI read from the
     * repository. Previews stay a single self-contained file with no network access, so the mockup can show
     * the project's real typography instead of a substitute.
     */
    inlineDesignAssets(repo, sha, tracked, p) {
        const used = [];
        const uris = new Map();
        let total = 0;
        const load = (id) => {
            const existing = uris.get(id);
            if (existing)
                return existing;
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
        const substitute = (text) => text.replace(CSS_URL, (whole, _quote, target) => {
            const id = /^asset:(.+)$/i.exec(target.trim())?.[1];
            return id ? `url("${load(id)}")` : whole;
        });
        return { css: substitute(p.css), bodyHtml: new Map(p.screens.map(s => [s.id, substitute(s.bodyHtml)])), used };
    }
    /**
     * The spec whose approved visual direction a new design for `repo` continues: the most recently approved,
     * non-rejected spec with a design. Maintenance uses the same rule to keep that document.
     */
    designReference(repo, excludeId) {
        return this.store.documents('spec')
            .filter(d => d.id !== excludeId && d.data.repo === repo && d.data.design && d.data.approval && d.data.status !== 'rejected')
            .sort((a, b) => (b.data.approval?.at ?? 0) - (a.data.approval?.at ?? 0))[0];
    }
    /** Files tracked at one commit: a design asset must be repository content at the reviewed commit, not whatever the working tree happens to hold. */
    async trackedPaths(repo, sha, signal) {
        const listing = await new Git(signal).exec(repo, ['ls-tree', '-r', '--name-only', '-z', sha]);
        return new Set(listing.split('\0').filter(Boolean));
    }
    /**
     * Visual direction already approved for this repository, if any. Passing it to the design role turns a
     * full re-derivation into an extension: the mockup keeps one direction across increments and only covers
     * screens the new spec creates or changes.
     */
    establishedDesign(currentId, repo) {
        const previous = this.designReference(repo, currentId);
        if (!previous?.data.design)
            return null;
        const proposal = previous.data.design.proposal;
        return { specId: previous.id, specTitle: previous.data.content?.title ?? previous.id, approvedAt: previous.data.approval?.at ?? 0,
            visualDirection: proposal.visualDirection, decisions: proposal.decisions, avoid: proposal.avoid, assets: proposal.assets ?? [],
            screens: proposal.screens.map(s => ({ id: s.id, title: s.title, purpose: s.purpose })) };
    }
    validateDesignScopes(p, spec) {
        const tasks = new Set(spec.tasks.map(t => t.id));
        const screens = new Set(p.screens.map(x => x.id));
        invariant(new Set(p.taskScopes.map(x => x.taskId)).size === p.taskScopes.length, 'DESIGN_MARKUP', 'Duplicate design taskScopes entry');
        for (const scope of p.taskScopes) {
            invariant(tasks.has(scope.taskId), 'DESIGN_MARKUP', `Design taskScopes references unknown task ${scope.taskId}`);
            for (const screen of scope.screenIds)
                invariant(screens.has(screen), 'DESIGN_MARKUP', `Design taskScopes references unknown screen ${screen}`);
        }
    }
    htmlEscape(text) {
        return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }
    async prepareDesignProposal(doc, repositoryIntelligence, signal) {
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
                'Fill taskScopes: list every spec task that implements visual work with the screen ids it needs (an empty screenIds list for a task that only needs the shared direction, such as a shared style base). Do not list tasks without visual work; they receive no design context.',
                ...(established ? [
                    `A visual direction is already approved and implemented for this repository (establishedDesign, from spec ${established.specId}). Reuse it: keep its tokens, type scale, spacing, components and grammar. State it briefly in visualDirection as a continuation instead of deriving a new one, and do not restyle existing screens.`,
                    'Mock only the screens this spec creates or materially changes; name unchanged screens in rationale instead of reproducing them. Put in css only what is new or changed relative to the implemented stylesheet, reusing its existing class names and custom properties.',
                    'Propose a change to the established direction only if the operator asked for one or the spec makes it unavoidable; then say so explicitly in decisions.',
                ] : []),
            ],
        };
        const spec = r.content;
        const proposal = await runRole({ store: this.store, documentId: doc.id, repo: r.repo, sha: r.baseSha, role: 'product', skills: r.config.skills,
            agent: r.config.roles.product ?? r.config.agent, passEnv: r.config.environment.passEnv, schema: designProposalSchema, context, ...(signal ? { signal } : {}),
            maxRepairs: r.config.workflow.maxOutputRepairs ?? 1, validate: value => { this.validateDesignMarkup(value); this.validateDesignScopes(value, spec); this.inlineDesignAssets(r.repo, r.baseSha, tracked, value); return value; } });
        const root = resolve(dirname(r.repo), `${basename(r.repo)}-review`, doc.id, 'design');
        invariant(!isInside(r.repo, root) && !isInside(this.store.root, root), 'DESIGN_PATH', 'Design preview must be outside source and operational state');
        rmSync(root, { recursive: true, force: true });
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const screenPaths = [];
        const inlined = this.inlineDesignAssets(r.repo, r.baseSha, tracked, proposal);
        const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; script-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
        for (const screen of proposal.screens) {
            const file = join(root, `${screen.id}.html`);
            const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${this.htmlEscape(screen.title)}</title><style>${inlined.css}</style></head><body>${inlined.bodyHtml.get(screen.id) ?? screen.bodyHtml}</body></html>`;
            writeFileSync(file, html, { flag: 'wx', mode: 0o600 });
            screenPaths.push(file);
        }
        const indexPath = join(root, 'INDEX.md');
        const lines = ['# Design review', '', proposal.summary, '',
            ...(established ? [`Continues the visual direction approved for spec ${established.specId} (${established.specTitle}); screens listed below are the ones this spec creates or changes.`, ''] : []),
            ...(inlined.used.length ? [`Repository assets inlined in the previews: ${inlined.used.map(a => `${a.id} (${a.path})`).join(', ')}`, ''] : []),
            `Rationale: ${proposal.rationale}`, '', `Visual direction: ${proposal.visualDirection}`, '',
            '## Screens', ...proposal.screens.flatMap((x, i) => [`- ${x.title}: ${screenPaths[i]}`, `  - Purpose: ${x.purpose}`, `  - States: ${x.states.join(', ') || 'default'}`, `  - Responsive: ${x.responsive}`]),
            '', '## Decisions', ...proposal.decisions.map(x => `- ${x.decision}: ${x.rationale}`), '', '## Avoid', ...proposal.avoid.map(x => `- ${x}`), '',
            'Open the HTML files above in a browser before approving the spec.'];
        writeFileSync(indexPath, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
        r.design = { proposal, hash: hash(proposal), directory: root, indexPath, screenPaths, generatedAt: Date.now(), reusedFrom: established?.specId ?? null, inlinedAssets: inlined.used };
        this.save(doc, 'design.proposed', { hash: r.design.hash, directory: root, indexPath, screenPaths, questions: proposal.questions, reusedFrom: r.design.reusedFrom, inlinedAssets: inlined.used });
    }
    async product(doc, proposal, signal) {
        const r = doc.data;
        const repositoryIntelligence = await inspectRepository(r.repo, r.baseSha, `${r.request}
${r.decisionLedger.decisions.map(d => `${d.subject}: ${d.value}`).join('\n')}`, { ...(signal ? { signal } : {}), inventory: await this.inventoryAt(r.repo, r.baseSha, r.config.knowledge?.languages ?? [], signal) });
        r.securityContext = assessSecurity({ text: r.request + '\n' + r.decisionLedger.decisions.map(d => `${d.subject}: ${d.value}`).join('\n'), projectType: r.config.skills.projectType, files: repositoryIntelligence.relevantFiles });
        r.securityContextHash = hash(r.securityContext);
        const securityContext = r.securityContext;
        const value = proposal ?? await runRole({ store: this.store, documentId: doc.id, repo: r.repo, sha: r.baseSha, role: 'product', skills: r.config.skills, agent: r.config.roles.product ?? r.config.agent, passEnv: r.config.environment.passEnv, schema: specSchema,
            context: { request: r.request, previous: r.content, decisionLedger: r.decisionLedger, repositoryIntelligence, securityContext, executionCapabilities: executionCapabilities(r.config) }, ...(signal ? { signal } : {}),
            maxRepairs: r.config.workflow.maxOutputRepairs ?? 1, validate: spec => readySpec(validateTaskCapabilities(validateSpec(spec, false, r.decisionLedger, r.request, securityContext), r.config)) });
        this.save(doc, 'product.repository_intelligence', { sha: repositoryIntelligence.sha, fileCount: repositoryIntelligence.fileCount, relevantFiles: repositoryIntelligence.relevantFiles, securityFiles: repositoryIntelligence.securityFiles, reuseCandidates: repositoryIntelligence.reuseCandidates.map(x => ({ name: x.name, kind: x.kind, path: x.path, line: x.line, score: x.score })) });
        this.save(doc, 'security.assessed', { contextHash: r.securityContextHash, minimumLane: r.securityContext.minimumLane, requiresThreatModel: r.securityContext.requiresThreatModel, negativeTestsRequired: r.securityContext.negativeTestsRequired, topics: r.securityContext.topics.map(t => t.id), signals: r.securityContext.signals });
        r.content = readySpec(validateTaskCapabilities(validateSpec(value, false, r.decisionLedger, r.request, r.securityContext), r.config));
        r.contentHash = specHash(r);
        r.impactAdvice = r.content.questions.length === 0 ? await this.impactAdvice(r, r.content, signal) : [];
        r.design = null;
        if (this.requiresDesign(r.content, r.config.skills.projectType) && r.content.questions.length === 0)
            await this.prepareDesignProposal(doc, repositoryIntelligence, signal);
        r.error = null;
        const design = r.design;
        this.save(doc, 'product.proposed', { revision: r.revision, hash: approvalHash(r), specHash: r.contentHash, designHash: design?.hash ?? null, impactAdvice: r.impactAdvice,
            questions: [...r.content.questions, ...(design?.proposal.questions ?? [])], content: r.content,
            design: design ? { hash: design.hash, directory: design.directory, indexPath: design.indexPath, summary: design.proposal.summary } : null });
    }
    async refine(id, request, proposal, signal) {
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
    async approveSpec(id, expectedHash, actor, note) {
        reviewer(actor, note);
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            const r = doc.data;
            invariant(r.attempts.length === 0 && ['draft', 'approved'].includes(r.status), 'STATE', 'Spec no longer accepts Product approval');
            invariant(r.content && approvalHash(r) === expectedHash, 'APPROVAL_HASH', 'Approve the exact spec/design proposal hash');
            validateTaskCapabilities(validateSpec(r.content, true, r.decisionLedger, r.request, r.securityContext), r.config);
            if (this.requiresDesign(r.content, r.config.skills.projectType))
                invariant(r.design && r.design.proposal.questions.length === 0, 'OPEN_QUESTIONS', 'Resolve design questions before approval');
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
    /** Design context scoped to one task: legacy proposals without taskScopes keep the whole design. */
    designContextFor(design, taskId) {
        const proposal = design.proposal;
        const designHash = design.hash;
        const scope = proposal.taskScopes?.length ? proposal.taskScopes.find(x => x.taskId === taskId) : undefined;
        if (proposal.taskScopes?.length && !scope)
            return { hash: designHash, summary: proposal.summary, scope: 'none', note: 'This task has no visual work in the approved design; keep the existing look and do not restyle.' };
        const screens = proposal.screens.filter(x => !scope || scope.screenIds.includes(x.id));
        const previewOf = (id) => design.screenPaths.find(p => basename(p) === `${id}.html`) ?? null;
        // The markup and stylesheet the operator approved, not a paraphrase of them. Bounded: a mockup far
        // over budget degrades to its description plus the preview path rather than breaking the task.
        const full = screens.map(x => ({ ...x, previewPath: previewOf(x.id) }));
        const weight = JSON.stringify(full).length + proposal.css.length;
        const within = weight <= DESIGN_CONTEXT_BUDGET;
        return { hash: designHash, summary: proposal.summary, visualDirection: proposal.visualDirection, implementationBrief: proposal.implementationBrief, decisions: proposal.decisions, avoid: proposal.avoid,
            scope: scope ? 'task' : 'all',
            ...(within ? { css: proposal.css } : { cssOmitted: `The approved stylesheet is ${proposal.css.length} characters; open the preview files instead.` }),
            screens: full.map(x => within
                ? { id: x.id, title: x.title, purpose: x.purpose, states: x.states, responsive: x.responsive, previewPath: x.previewPath, bodyHtml: x.bodyHtml }
                : { id: x.id, title: x.title, purpose: x.purpose, states: x.states, responsive: x.responsive, previewPath: x.previewPath }),
            note: 'This is the mockup the operator approved. Reproduce its structure, classes and states in the real stack; it is a reference, not a file to copy verbatim.' };
    }
    makeTask(r, t) {
        const spec = this.approved(r);
        const acceptance = spec.acceptance.filter(a => t.acceptanceIds.includes(a.id));
        const design = r.design ? this.designContextFor(r.design, t.id) : null;
        const decisionIds = new Set(spec.decisionCoverage.filter(c => c.acceptanceIds.some(id => t.acceptanceIds.includes(id))).map(c => c.decisionId));
        const confirmedProjectDecisions = confirmedDecisions(r.decisionLedger).filter(d => decisionIds.has(d.id));
        const resolvedProjectDecisions = spec.decisionResolutions.filter(d => decisionIds.has(d.decisionId)).map(d => ({ id: d.decisionId, subject: r.decisionLedger.decisions.find(x => x.id === d.decisionId)?.subject ?? d.decisionId, value: d.value, status: 'confirmed-via-product', source: 'operator', sourceQuote: d.sourceQuote, rationale: d.rationale }));
        const projectDecisions = [...confirmedProjectDecisions, ...resolvedProjectDecisions];
        const securityRequirements = spec.security.requirements.filter(req => req.acceptanceIds.some(id => t.acceptanceIds.includes(id)));
        const securityThreats = spec.security.threatModel.threats.filter(threat => threat.acceptanceIds.some(id => t.acceptanceIds.includes(id)));
        const security = { context: r.securityContext, profile: spec.security.profile, requirements: securityRequirements, threats: securityThreats, assumptions: spec.security.assumptions };
        const context = { problem: spec.problem, scope: spec.scope, outOfScope: spec.outOfScope, decisions: spec.decisions, projectDecisions, criteria: acceptance, experience: spec.experience, security, approvedDesign: design };
        const description = t.description + '\n\nApproved Product context (do not expand scope):\n' + JSON.stringify(context);
        const maxContext = r.config.limits?.maxTaskContextChars ?? DEFAULT_LIMITS.maxTaskContextChars;
        invariant(description.length <= maxContext, 'TASK_CONTEXT', `Approved context is too large for a task (${description.length} > limits.maxTaskContextChars ${maxContext}); split the spec or raise the reviewed limit`);
        const amendments = r.scopeAmendments.filter(a => a.status === 'approved' && a.taskId === t.id).flatMap(a => a.paths);
        const allowedPaths = [...new Set([...t.allowedPaths, ...amendments])];
        const allowedNewPaths = this.companionPaths(allowedPaths);
        return taskSchema.parse({ id: t.id, title: t.title, description, acceptance: acceptance.map(a => a.description), allowedPaths, allowedNewPaths, maxNewFiles: allowedNewPaths.length ? 4 : 0, reviewRequired: false, minimumLane: stricter(t.minimumLane, spec.minimumLane, securityRequirements.length ? r.securityContext.minimumLane : 'fast') });
    }
    /** The repair task for the current QA report, built from the current effective spec and amendments. */
    qaRepairTask(r) {
        invariant(r.qa, 'QA_REQUIRED', 'A QA report is required to build a repair');
        const description = [
            'Correct the following QA findings without broadening the approved scope.',
            'When a finding can only be fixed in a file outside the approved paths (for example a comment made false by an approved change), make the smallest change there anyway: the controller then stops and asks the operator for an explicit scope amendment. Never broaden a feature to do so.',
            'When a finding cannot be fixed by changing files (for example it is about what a report must contain), say so precisely in your summary; QA reads the task summaries.',
        ].join('\n') + '\n' + JSON.stringify({ approvedSpec: this.approved(r), qa: r.qa.report, taskSummaries: this.taskSummaries(r) });
        invariant(description.length <= (r.config.limits?.maxTaskContextChars ?? DEFAULT_LIMITS.maxTaskContextChars), 'TASK_CONTEXT', 'QA repair context exceeds limits.maxTaskContextChars; prepare an explicit follow-up');
        return this.aggregateTask(r, description);
    }
    aggregateTask(r, description) {
        const spec = this.approved(r);
        const minimum = stricter(spec.minimumLane, r.securityContext.minimumLane, ...r.attempts.map(a => this.pipeline.store.get(a.runId).risk?.lane ?? 'fast'));
        const allowedPaths = [...new Set([...spec.tasks.flatMap(t => t.allowedPaths), ...r.scopeAmendments.filter(a => a.status === 'approved').flatMap(a => a.paths)])];
        const allowedNewPaths = this.companionPaths(allowedPaths);
        return taskSchema.parse({ id: 'SPEC-INTEGRATION', title: spec.title, description, acceptance: spec.acceptance.map(a => a.description), allowedPaths, allowedNewPaths, maxNewFiles: allowedNewPaths.length ? 8 : 0, reviewRequired: true, minimumLane: minimum });
    }
    async executeActive(doc, options, signal) {
        const r = doc.data;
        invariant(r.activeRunId, 'STATE', 'No active run');
        const before = this.pipeline.store.get(r.activeRunId);
        if (['failed', 'rejected'].includes(before.state))
            return before;
        const run = await this.pipeline.execute(before.id, { signal, acceptCurrentCandidate: options.acceptCurrent ?? false });
        this.save(doc, 'workflow.attempt_observed', { runId: run.id, state: run.state, candidateSha: run.candidateSha });
        return run;
    }
    requestScopeAmendment(doc, run) {
        if (run.error?.code !== 'SCOPE' || !run.candidateSha || !run.changeSet)
            return false;
        const paths = run.changeSet.files.filter(file => !run.task.allowedPaths.some(pattern => matches(file, pattern)));
        if (!paths.length)
            return false;
        const attempt = doc.data.attempts.find(a => a.runId === run.id);
        if (!attempt)
            return false;
        const existing = doc.data.scopeAmendments.find(a => a.sourceRunId === run.id && a.status === 'pending');
        const amendment = existing ?? {
            id: randomUUID(), taskId: attempt.taskId, sourceRunId: run.id, paths,
            reason: `Candidate ${run.candidateSha} needs files outside the approved execution paths: ${paths.join(', ')}`,
            candidateSha: run.candidateSha, status: 'pending', requestedAt: Date.now(), approvedAt: null, reviewer: null, note: null,
        };
        if (!existing)
            doc.data.scopeAmendments.push(amendment);
        doc.data.status = 'blocked';
        doc.data.error = { code: 'SCOPE_AMENDMENT_REQUIRED', message: amendment.reason };
        this.save(doc, 'scope.amendment_requested', { amendment });
        return true;
    }
    block(doc, run) {
        if (this.requestScopeAmendment(doc, run))
            return;
        doc.data.status = 'blocked';
        doc.data.error = run.error ?? { code: run.state === 'interrupted' ? 'INTERRUPTED' : 'EXECUTION', message: `Run ${run.id} is ${run.state}` };
        this.save(doc, 'workflow.blocked', { runId: run.id, error: doc.data.error });
    }
    /** Records a proposed correction of one acceptance criterion and returns its hash for explicit approval. */
    planCriterionAmendment(id, criterionId, correction) {
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            const r = doc.data;
            const spec = this.approved(r);
            invariant(!['closed', 'rejected', 'delivered'].includes(r.status), 'STATE', 'This spec no longer accepts a criterion correction');
            invariant(r.attempts.length > 0, 'CRITERION_AMENDMENT', 'Execution has not started: refine the spec instead of amending a criterion');
            const criterion = spec.acceptance.find(c => c.id === criterionId);
            invariant(criterion, 'CRITERION_AMENDMENT', `Unknown acceptance criterion ${criterionId}`);
            const description = correction.description.trim();
            const verification = correction.verification.trim();
            invariant(description.length >= 10 && description.length <= 3000 && verification.length >= 10 && verification.length <= 3000, 'CRITERION_AMENDMENT', 'A corrected criterion needs an observable description and verification');
            invariant(correction.reason.trim().length >= 20, 'CRITERION_AMENDMENT', 'Explain why the approved criterion cannot hold');
            const requirements = (correction.requirements ?? []).map(x => {
                const requirement = spec.security.requirements.find(q => q.id === x.id);
                invariant(requirement, 'CRITERION_AMENDMENT', `Unknown security requirement ${x.id}`);
                // Only a requirement that verifies this criterion may be corrected with it.
                invariant(requirement.acceptanceIds.includes(criterionId), 'CRITERION_AMENDMENT', `Security requirement ${x.id} does not verify ${criterionId}`);
                const text = x.verification.trim();
                invariant(text.length >= 10 && text.length <= 4000, 'CRITERION_AMENDMENT', `A corrected verification for ${x.id} must be observable`);
                return { id: x.id, previous: requirement.verification, verification: text };
            });
            invariant(new Set(requirements.map(x => x.id)).size === requirements.length, 'CRITERION_AMENDMENT', 'A security requirement is corrected at most once per amendment');
            const changed = description !== criterion.description || verification !== criterion.verification || requirements.some(x => x.verification !== x.previous);
            invariant(changed, 'CRITERION_AMENDMENT', 'The correction is identical to the approved criterion');
            const previous = { description: criterion.description, verification: criterion.verification };
            const amendment = { id: randomUUID(), criterionId, previous, description, verification, requirements, reason: correction.reason.trim(),
                hash: criterionAmendmentHash({ criterionId, previous, description, verification, requirements, reason: correction.reason.trim() }),
                status: 'pending', at: Date.now(), approvedAt: null, reviewer: null, note: null };
            r.criterionAmendments = [...(r.criterionAmendments ?? []).filter(a => !(a.status === 'pending' && a.criterionId === criterionId)), amendment];
            this.save(doc, 'criterion.amendment_proposed', { amendmentId: amendment.id, criterionId, hash: amendment.hash, previous, description, verification, requirements, reason: amendment.reason });
            return doc;
        }
        finally {
            this.store.releaseDocument(id, token);
        }
    }
    /** Applies a criterion correction the operator approved by its exact hash, and reopens assessment. */
    approveCriterionAmendment(id, amendmentId, expectedHash, actor, note) {
        reviewer(actor, note);
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            const r = doc.data;
            this.approved(r);
            const amendment = (r.criterionAmendments ?? []).find(a => a.id === amendmentId);
            invariant(amendment && amendment.status === 'pending', 'CRITERION_AMENDMENT', 'Pending criterion amendment not found');
            invariant(amendment.hash === expectedHash, 'CRITERION_HASH', 'Approve the exact corrected criterion hash');
            amendment.status = 'approved';
            amendment.approvedAt = Date.now();
            amendment.reviewer = actor.trim();
            amendment.note = note.trim();
            // The criterion changed, so no previous assessment of it still applies.
            r.qa = null;
            r.review = null;
            r.delivery = null;
            r.status = 'running';
            r.error = null;
            this.save(doc, 'criterion.amendment_approved', { amendmentId: amendment.id, criterionId: amendment.criterionId, hash: amendment.hash, reviewer: actor.trim(), note: note.trim(), previous: amendment.previous, description: amendment.description });
            return doc;
        }
        finally {
            this.store.releaseDocument(id, token);
        }
    }
    async approveScopeAmendment(id, amendmentId, actor, note) {
        reviewer(actor, note);
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            const r = doc.data;
            this.approved(r);
            const amendment = r.scopeAmendments.find(a => a.id === amendmentId);
            invariant(amendment && amendment.status === 'pending', 'SCOPE_AMENDMENT', 'Pending scope amendment not found');
            const failed = this.pipeline.store.get(amendment.sourceRunId);
            invariant(failed.state === 'failed' && failed.candidateSha === amendment.candidateSha, 'SCOPE_AMENDMENT', 'Scope amendment source candidate is no longer adoptable');
            amendment.status = 'approved';
            amendment.approvedAt = Date.now();
            amendment.reviewer = actor.trim();
            amendment.note = note.trim();
            const spec = this.approved(r);
            const specTask = spec.tasks.find(t => t.id === amendment.taskId);
            const task = specTask ? this.makeTask(r, specTask) : this.aggregateTask(r, `Revalidate the retained QA repair candidate after explicit execution-scope amendment ${amendment.id}.`);
            const validationConfig = { ...r.config, maxRepairAttempts: 0 };
            const validation = await this.pipeline.createValidation({ repo: r.repo, baseRef: failed.baseSha, config: validationConfig, task }, amendment.candidateSha);
            const previousAttempt = r.attempts.find(a => a.runId === amendment.sourceRunId);
            r.attempts.push({ taskId: amendment.taskId, runId: validation.id, kind: previousAttempt.kind });
            r.activeRunId = validation.id;
            if (previousAttempt.kind === 'qa-repair') {
                r.finalRunId = null;
                r.qa = null;
            }
            r.review = null;
            r.delivery = null;
            r.status = 'running';
            r.error = null;
            this.save(doc, 'scope.amendment_approved', { amendmentId: amendment.id, paths: amendment.paths, candidateSha: amendment.candidateSha, validationRunId: validation.id, reviewer: actor.trim() });
            return doc;
        }
        finally {
            this.store.releaseDocument(id, token);
        }
    }
    async run(id, options = {}) {
        const token = this.store.acquireDocument(id);
        let doc;
        let timer;
        let started;
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
            const order = [];
            const visit = (taskId) => {
                if (order.some(t => t.id === taskId))
                    return;
                const t = spec.tasks.find(x => x.id === taskId);
                t.dependsOn.forEach(visit);
                order.push(t);
            };
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
                    r.review = null; // The review described the previous candidate; it is superseded, not stale forever.
                    this.save(doc, 'workflow.qa_repair_completed', { runId: repaired.id, candidateSha: r.currentSha });
                }
                if (!r.finalRunId) {
                    // One task already validates exactly the complete candidate: do not pay for the same gates twice.
                    const only = r.attempts.length === 1 ? this.pipeline.store.get(r.attempts[0].runId) : null;
                    // Reuse is about proof, not about human review: the run must already carry every
                    // configured gate on this exact candidate, and reusing it must not lower the number of
                    // approvals the integration would have required.
                    const proven = (run) => {
                        const seen = new Map(run.receipts.map(x => [x.gateId, x.status]));
                        return r.config.gates.every(g => ['passed', 'cached'].includes(seen.get(g.id) ?? ''));
                    };
                    const reviewPreserved = (run) => run.task.reviewRequired || requiredApprovals(run.risk?.lane ?? 'high', r.config.workflow.reviewMode) === 0;
                    if (only && ['ready', 'awaiting_review'].includes(only.state) && only.baseSha === r.baseSha && only.candidateSha === r.currentSha && proven(only) && reviewPreserved(only)) {
                        r.finalRunId = only.id;
                        this.save(doc, 'integration.reused', { runId: only.id, gates: only.receipts.map(x => x.gateId), reviewRequired: only.task.reviewRequired });
                    }
                    else {
                        const finalConfig = { ...r.config, maxRepairAttempts: 0, gates: r.config.gates.map(g => ({ ...g, mandatory: true })) };
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
                            if (only)
                                this.save(doc, 'integration.adoption_refused', { sourceRunId: only.id, reason: refusal });
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
                if (r.review && r.review.candidateSha !== final.candidateSha) {
                    const superseded = r.review;
                    r.review = null;
                    this.save(doc, 'workflow.review_superseded', { previousCandidateSha: superseded.candidateSha, candidateSha: final.candidateSha });
                }
                const needsQa = r.config.workflow.qaLanes.includes(final.risk.lane);
                if (needsQa && (!r.qa || r.qa.evidenceHash !== evidenceHash || r.qa.report.candidateSha !== final.candidateSha || r.qa.specHash !== r.contentHash)) {
                    r.qa = null;
                    if (options.manualQa) {
                        r.status = 'blocked';
                        r.error = { code: 'QA_REQUIRED', message: 'Import a complete QA report with spec qa, then run again.' };
                        this.save(doc, 'qa.required');
                        return doc;
                    }
                    const diff = await new Git(signal).patch(r.repo, r.baseSha, final.candidateSha);
                    const maxDiff = r.config.limits?.maxQaDiffBytes ?? DEFAULT_LIMITS.maxQaDiffBytes;
                    invariant(Buffer.byteLength(diff) <= maxDiff, 'QA_CONTEXT', `QA diff exceeds limits.maxQaDiffBytes (${maxDiff}); use an explicit external review, never a truncated review`);
                    const inventoryDelta = await this.inventoryDelta(r, final.candidateSha, signal);
                    this.save(doc, 'qa.inventory_delta', { added: inventoryDelta.added.length, removed: inventoryDelta.removed.length, possibleDuplicates: inventoryDelta.possibleDuplicates });
                    const raw = await runRole({ store: this.store, documentId: id, repo: r.repo, sha: final.candidateSha, role: 'qa', skills: r.config.skills, agent: r.config.roles.qa ?? r.config.agent, passEnv: r.config.environment.passEnv, schema: qaSchema, context: { diff, spec, approvedAmendments: this.approvedAmendments(r), taskSummaries: this.taskSummaries(r), decisionLedger: r.decisionLedger, securityContext: r.securityContext, approvedDesign: this.qaDesignContext(r), baseSha: r.baseSha, candidateSha: final.candidateSha, receipts: final.receipts, inventoryDelta, diffCommand: ['git', 'diff', '--no-ext-diff', '--no-textconv', r.baseSha, final.candidateSha, '--'] }, signal,
                        maxRepairs: r.config.workflow.maxOutputRepairs ?? 1, validate: report => validateQa(report, spec, final.candidateSha, r.decisionLedger) });
                    r.qa = { report: raw, specHash: r.contentHash, evidenceHash, at: Date.now(), source: 'agent' };
                    this.save(doc, 'qa.completed', { qa: r.qa });
                }
                if (needsQa && r.qa.report.verdict === 'changes_requested') {
                    if (r.qaRepairs >= r.config.workflow.maxQaRepairs) {
                        r.status = 'blocked';
                        r.error = { code: 'QA_REJECTED', message: 'QA requests changes; automatic repair budget exhausted. Inspect findings and create an explicit follow-up.' };
                        this.save(doc, 'qa.repair_budget_exhausted');
                        return doc;
                    }
                    const run = await this.pipeline.create({ repo: r.repo, baseRef: r.currentSha, config: r.config, task: this.qaRepairTask(r) });
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
    qaMarkdown(r) {
        if (!r.qa)
            return '# QA\n\nQA was not required for this candidate.\n';
        const q = r.qa.report;
        const lines = ['# QA review', '', `Verdict: **${q.verdict}**`, '', q.summary, '', '## Acceptance criteria'];
        for (const c of q.criteria)
            lines.push(`- **${c.id}** — ${c.status}: ${c.evidence}`);
        lines.push('', '## Findings');
        if (!q.findings.length)
            lines.push('- None');
        else
            for (const f of q.findings)
                lines.push(`- **${f.severity}** ${f.id}${f.path ? ` (${f.path})` : ''}: ${f.description}`);
        if (q.securityChecks.length)
            lines.push('', '## Security checks', ...q.securityChecks.map(x => `- **${x.requirementId}** — ${x.status}: ${x.evidence}`));
        if (q.decisionChecks.length)
            lines.push('', '## Decision checks', ...q.decisionChecks.map(x => `- **${x.decisionId}** — ${x.status}: ${x.evidence}`));
        if (q.observations.length)
            lines.push('', '## Observations', ...q.observations.map(x => `- ${x}`));
        return lines.join('\n') + '\n';
    }
    /** The approved mockup QA compares the candidate against; bounded like the Implementer's copy. */
    qaDesignContext(r) {
        if (!r.design)
            return null;
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
    async prepareReviewWorkspace(doc, final) {
        const r = doc.data;
        invariant(final.candidateSha, 'CANDIDATE', 'Review candidate is missing');
        const root = resolve(dirname(r.repo), `${basename(r.repo)}-review`, doc.id);
        const candidate = join(root, 'candidate');
        invariant(!isInside(r.repo, root) && !isInside(this.store.root, root), 'REVIEW_PATH', 'Review workspace must be outside source and operational state');
        const git = new Git();
        // The documents describe a candidate, a spec, a design and a QA report: reuse them only when all of
        // those are unchanged. Keying on the candidate alone left QA.md showing a replaced report.
        const bundleHash = hash({ candidate: final.candidateSha, spec: r.contentHash, design: r.design?.hash ?? null,
            qa: r.qa ? hash(r.qa) : null, receipts: final.receipts.map(x => ({ gateId: x.gateId, status: x.status })) });
        if (r.review?.bundleHash === bundleHash && existsSync(r.review.candidateDirectory)) {
            await git.clean(r.review.candidateDirectory, final.candidateSha);
            return;
        }
        const sameCandidate = r.review?.candidateSha === final.candidateSha && existsSync(candidate);
        if (existsSync(candidate) && !sameCandidate) {
            try {
                await git.removeWorkspace(r.repo, candidate, root);
            }
            catch { /* stale review material is removed below; never trusted */ }
        }
        mkdirSync(root, { recursive: true, mode: 0o700 });
        // Never the whole directory: the approved design bundle is its sibling, and the operator is told to
        // open it before approving. Only the entries this workspace owns are rebuilt.
        for (const entry of REVIEW_ENTRIES)
            if (!(sameCandidate && entry === 'candidate'))
                rmSync(join(root, entry), { recursive: true, force: true });
        if (sameCandidate)
            await git.clean(candidate, final.candidateSha);
        else
            await git.workspace(r.repo, candidate, final.candidateSha);
        const patchPath = join(root, 'candidate.patch');
        const qaPath = join(root, 'QA.md');
        const reviewPath = join(root, 'REVIEW.md');
        const inventoryPath = join(root, 'INVENTORY.md');
        const patch = await git.patch(r.repo, r.baseSha, final.candidateSha);
        writeFileSync(patchPath, patch, { mode: 0o600 });
        writeFileSync(qaPath, this.qaMarkdown(r), { mode: 0o600 });
        const languages = r.config.knowledge?.languages ?? [];
        const candidateInventory = await this.inventoryAt(r.repo, final.candidateSha, languages);
        writeFileSync(inventoryPath, inventoryMarkdown(candidateInventory), { mode: 0o600 });
        const delta = diffInventory(await this.inventoryAt(r.repo, r.baseSha, languages), candidateInventory);
        const surfaceLines = [
            ...(delta.added.length ? delta.added.map(x => `- added \`${x.name}\` (${x.kind}) in \`${x.path}\``) : ['- no new public declaration or file-level unit']),
            ...delta.removed.map(x => `- removed \`${x.name}\` (${x.kind}) from \`${x.path}\``),
            ...delta.possibleDuplicates.map(x => `- possible duplicate: \`${x.added.name}\` in \`${x.added.path}\` vs existing \`${x.existing.name}\` in \`${x.existing.path}\``),
        ].join('\n');
        const gateLines = final.receipts.map(x => `- ${x.gateId}: ${x.status}`).join('\n');
        const securityLines = r.content?.security.requirements.length ? r.content.security.requirements.map(x => `- ${x.id}: ${x.title} [${x.owaspTopics.join(', ')}]`).join('\n') : '- none';
        const text = [`# Candidate review`, ``, `Candidate: ${final.candidateSha}`, `Risk: ${final.risk?.lane ?? 'unknown'}`, `Review mode: ${r.config.workflow.reviewMode}`, `Security minimum: ${r.securityContext.minimumLane}`, `OWASP topics: ${r.securityContext.topics.map(x => x.id).join(', ') || 'none'}`, ``, `Open this directory in your editor:`, ``, candidate, ``, `Patch: ${patchPath}`, `QA: ${qaPath}`, `Inventory: ${inventoryPath}`, ...(r.design ? [`Approved design: ${r.design.indexPath}`, ...r.design.screenPaths.map(p => `  - ${p}`)] : []), ``, `## Gates`, gateLines || '- none', ``, `## Public surface changes`, surfaceLines, ``, `## Security requirements`, securityLines, ''].join('\n');
        writeFileSync(reviewPath, text, { mode: 0o600 });
        r.review = { directory: root, candidateDirectory: candidate, patchPath, qaPath, reviewPath, candidateSha: final.candidateSha, bundleHash };
        this.save(doc, 'workflow.review_workspace_ready', { review: r.review });
    }
    async reviewable(r) {
        this.approved(r);
        invariant(r.finalRunId, 'STATE', 'No integrated candidate');
        const final = this.pipeline.store.get(r.finalRunId);
        invariant(final.candidateSha === r.currentSha, 'CANDIDATE', 'Final candidate is stale');
        const evidenceHash = await this.pipeline.assertValidated(final.id);
        if (r.config.workflow.qaLanes.includes(final.risk.lane))
            invariant(r.qa && r.qa.specHash === r.contentHash && r.qa.evidenceHash === evidenceHash && r.qa.report.candidateSha === final.candidateSha && r.qa.report.verdict === 'pass', 'QA_REQUIRED', 'A passing QA assessment must cover the exact candidate and evidence');
        return final;
    }
    /** Publication adapters still acquire the lifecycle lease and require explicit consent. */
    async publicationCandidate(id, purpose = 'delivery') {
        const doc = this.get(id);
        invariant(!['closed', 'rejected'].includes(doc.data.status), 'STATE', 'Spec cannot be published');
        const final = await this.reviewable(doc.data);
        // A draft PR for reading still requires validated gates and a passing QA on this exact candidate;
        // only the operator's approval, which the reading is meant to inform, is not required yet.
        if (purpose === 'review')
            invariant(['awaiting_review', 'ready'].includes(doc.data.status) && ['awaiting_review', 'ready'].includes(final.state), 'STATE', 'Only a validated candidate awaiting review can be opened for reading');
        else
            await this.pipeline.exportPatch(final.id);
        return final;
    }
    async review(id, sha, actor, note) {
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
    async importQa(id, value) {
        const token = this.store.acquireDocument(id);
        try {
            const doc = this.get(id);
            const r = doc.data;
            const spec = this.approved(r);
            invariant(r.finalRunId && !['closed', 'rejected', 'delivered'].includes(r.status), 'STATE', 'QA requires a pending integrated candidate');
            const final = this.pipeline.store.get(r.finalRunId);
            const evidenceHash = await this.pipeline.assertValidated(final.id);
            const qa = { report: validateQa(value, spec, final.candidateSha, r.decisionLedger), evidenceHash, specHash: r.contentHash, at: Date.now(), source: 'operator-import' };
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
    reject(id, note) {
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
    async verify(id, signal) {
        const token = this.store.acquireDocument(id);
        let doc;
        let started;
        let timer;
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
    async retry(id, confirmed) {
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
                // Rebuild the task from the current state: a frozen copy would ignore amendments, criterion
                // corrections and repair guidance approved or released since the failed attempt was created.
                const specTask = this.approved(r).tasks.find(t => t.id === attempt.taskId);
                const task = attempt.kind === 'qa-repair' && r.qa ? this.qaRepairTask(r) : specTask ? this.makeTask(r, specTask) : failed.task;
                const replacement = await this.pipeline.create({ repo: r.repo, baseRef: failed.baseSha, config: failed.config, task });
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
    recover(id, confirmed) {
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
    async deliver(id, directory) {
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
                const files = JSON.parse(manifest);
                for (const [name, digest] of Object.entries(files))
                    invariant(sha256(readFileSync(join(output, name))) === digest, 'DELIVERY', 'Existing delivery file changed');
                return doc;
            }
            invariant(!existsSync(output), 'EXISTS', 'Delivery destination already exists');
            mkdirSync(dirname(output), { recursive: true });
            const staging = join(dirname(output), `.apv2-delivery-${randomUUID()}`);
            mkdirSync(staging, { mode: 0o700 });
            const files = { 'candidate.patch': patch, 'spec.md': specMarkdown(r, id), 'evidence.json': JSON.stringify({ specId: id, specHash: r.contentHash, productApproval: r.approval, qa: r.qa, run: summarize(final), receipts: final.receipts, approvals: final.approvals }, null, 2) + '\n', 'events.jsonl': this.store.documentEvents(id).map(e => JSON.stringify(e)).join('\n') + '\n', 'run-events.jsonl': [...new Set([...r.attempts.map(a => a.runId), ...r.validationRunIds])].flatMap(runId => this.store.events(runId)).map(e => JSON.stringify(e)).join('\n') + '\n' };
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
            r.delivery = { directory: output, candidateSha: final.candidateSha, manifestHash: sha256(manifest) };
            r.status = 'delivered';
            this.save(doc, 'spec.delivered', { delivery: r.delivery });
            return doc;
        }
        finally {
            this.store.releaseDocument(id, token);
        }
    }
    async branch(id, name, confirmed) {
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
                await git.exec(doc.data.repo, ['update-ref', `refs/heads/${name}`, final.candidateSha, '0'.repeat(final.candidateSha.length)]);
            this.save(doc, 'delivery.branch_created', { branch: name, candidateSha: final.candidateSha });
            return doc;
        }
        finally {
            this.store.releaseDocument(id, token);
        }
    }
    async closeLocal(id, ref, mergeSha, actor, note) {
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
            const candidateSha = r.delivery?.candidateSha ?? final.candidateSha;
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
    async inventoryDelta(r, candidateSha, signal) {
        const languages = r.config.knowledge?.languages ?? [];
        return diffInventory(await this.inventoryAt(r.repo, r.baseSha, languages, signal), await this.inventoryAt(r.repo, candidateSha, languages, signal));
    }
    summary(doc) {
        const r = doc.data;
        const final = r.finalRunId ? this.pipeline.store.get(r.finalRunId) : null;
        let next;
        if (!r.approval)
            next = (r.content?.questions.length || r.design?.proposal.questions.length) ? `apv2 spec refine ${doc.id} --request "answers to the displayed questions"` : `apv2 spec approve ${doc.id} --hash ${approvalHash(r) ?? 'NO_VALID_PROPOSAL'} --approve`;
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
        else if (r.error?.code === 'CANCELLED' || r.error?.code === 'LOCKED')
            next = `apv2 spec recover ${doc.id} --confirm-stopped   (only after checking no controller or agent process is still alive)`;
        else if (r.error?.code === 'TASK_FAILED' || r.error?.code === 'REPAIR_NO_CHANGE')
            next = `apv2 spec retry ${doc.id} --confirm   (authorizes exactly one new attempt of the failed task)`;
        else if (r.error?.code === 'NO_CHANGE') {
            const last = [...r.attempts].reverse().find(a => a.kind === 'qa-repair' || a.kind === 'task');
            const said = last ? (this.pipeline.store.get(last.runId).summary ?? '').replace(/\s+/g, ' ').slice(0, 300) : '';
            next = `The last attempt changed nothing${said ? ` and explained: "${said}"` : ''}. Read it with apv2 spec events ${doc.id}; then apv2 spec retry ${doc.id} --confirm if a change is still expected, or create a follow-up spec.`;
        }
        else if (r.error?.code === 'STALE_EVIDENCE')
            next = `apv2 spec verify ${doc.id}   (replays the gates on the same candidate; then apv2 spec run ${doc.id})`;
        else if (r.status === 'blocked' && r.error)
            next = `Resolve ${r.error.code} before running again: ${r.error.message.slice(0, 200)}`;
        else
            next = `apv2 spec run ${doc.id}`;
        return { id: doc.id, revision: r.revision, status: r.status, title: r.content?.title ?? null, hash: approvalHash(r), specHash: r.contentHash, security: { contextHash: r.securityContextHash ?? null, minimumLane: r.securityContext?.minimumLane ?? null, requiresThreatModel: r.securityContext?.requiresThreatModel ?? null, topics: r.securityContext?.topics.map(x => x.id) ?? [], requirements: r.content?.security?.requirements.map(x => x.id) ?? [] }, design: r.design ? { hash: r.design.hash, directory: r.design.directory, indexPath: r.design.indexPath, summary: r.design.proposal.summary, questions: r.design.proposal.questions } : null, baseSha: r.baseSha, candidateSha: r.currentSha, questions: r.content?.questions ?? [], tasks: r.content?.tasks.map(t => ({ id: t.id, title: t.title, done: r.completedTaskIds.includes(t.id), dependsOn: t.dependsOn })) ?? [], attempts: r.attempts, validationRunIds: r.validationRunIds, activeRunId: r.activeRunId, finalRun: final ? summarize(final) : null, qa: r.qa, activeMs: Math.round(r.activeMs), error: r.error, delivery: r.delivery, publication: r.publication, impactAdvice: r.impactAdvice ?? [], nextAction: next, approvalIdentityWarning: 'Local reviewer labels are not authenticated identities.' };
    }
}
//# sourceMappingURL=service.js.map