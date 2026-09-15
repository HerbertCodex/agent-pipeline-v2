import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { providerProfile } from '../adapters/providers.js';
import { readRole } from '../knowledge/catalog.js';
import { claudeCommand, claudeOutput } from '../adapters/claude.js';
import { strictSchema } from '../adapters/structured-schema.js';
import { agentSchema } from '../domain/contracts.js';
import { invariant } from '../domain/errors.js';
import { hash } from '../domain/hash.js';
import { s, parseJson } from '../domain/schema.js';
import { environment, redact, runProcess } from '../execution/process.js';
import { Git, isInside } from '../execution/git.js';
import { reviewer } from './contracts.js';
import { planInstallation } from './onboarding.js';
import { assessSecurity } from '../security/owasp.js';
import { isRepairableOutputError, repairNotice, MAX_REPAIR_ERROR_CHARS } from './roles.js';
import { decisionSchema, decisionCoverageSchema, semanticReviewSchema, validateDecisionLedger, validateBootstrapCoverage, validateSemanticReview, ambiguousApprovalFragments, ambiguousDecisions, decisionLedgerMarkdown, } from './decisions.js';
const projectTypes = ['unknown', 'backend', 'frontend', 'mobile', 'fullstack', 'library'];
const bootstrapFileSchema = s.object({ path: s.string(1, 300), content: s.string(0, 200000) });
const architectureDecisionSchema = s.object({
    decision: s.string(1, 1000), rationale: s.string(10, 4000), evidence: s.array(s.string(1, 2000), 1, 20),
    alternatives: s.array(s.object({ option: s.string(1, 1000), reasonNotChosen: s.string(1, 3000) }), 0, 20),
    tradeoffs: s.array(s.string(1, 2000), 0, 20), reconsiderWhen: s.array(s.string(1, 2000), 1, 20),
});
const architectureSchema = s.object({ summary: s.string(10, 6000), decisions: s.array(architectureDecisionSchema, 1, 30) });
export const bootstrapProposalSchema = s.object({
    projectType: s.enum(projectTypes),
    summary: s.string(1, 6000),
    architecture: architectureSchema,
    decisions: s.array(decisionSchema, 0, 200),
    decisionCoverage: s.array(decisionCoverageSchema, 0, 200),
    files: s.array(bootstrapFileSchema, 1, 200),
    // Only questions that prevent creation of a technically coherent scaffold belong here.
    questions: s.array(s.string(1, 3000), 0, 50),
    productQuestions: s.default(s.array(s.string(1, 3000), 0, 100), []),
    deferredQuestions: s.default(s.array(s.string(1, 3000), 0, 100), []),
    notes: s.array(s.string(1, 3000), 0, 100),
});
function safeRelative(path) {
    invariant(!isAbsolute(path) && !path.includes('\\') && !path.includes('\0'), 'BOOTSTRAP_PATH', `Unsafe bootstrap path: ${path}`);
    const normalized = path.replace(/^\.\//, '');
    invariant(normalized.length > 0 && normalized !== '.git' && !normalized.startsWith('.git/') && !normalized.split('/').includes('..') && !normalized.includes('//'), 'BOOTSTRAP_PATH', `Unsafe bootstrap path: ${path}`);
    return normalized;
}
function directoryIsEmpty(path) { return !existsSync(path) || readdirSync(path).filter(x => x !== '.git').length === 0; }
async function gitRootIfAny(path) {
    if (!existsSync(path))
        return null;
    const result = await runProcess({ command: ['git', 'rev-parse', '--show-toplevel'], cwd: path, env: environment(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'LANG']), timeoutMs: 10000 });
    return result.status === 'passed' ? result.stdout.trim() : null;
}
async function hasHead(repo) {
    const result = await runProcess({ command: ['git', 'rev-parse', '--verify', 'HEAD^{commit}'], cwd: repo, env: environment(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'LANG']), timeoutMs: 10000 });
    return result.status === 'passed';
}
async function ensureBootstrapTarget(path) {
    const directory = resolve(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    invariant(directoryIsEmpty(directory), 'BOOTSTRAP_NOT_EMPTY', 'Bootstrap target must contain no application files; use onboard for an existing project');
    const root = await gitRootIfAny(directory);
    if (root) {
        const physicalDirectory = realpathSync(directory);
        const physicalRoot = realpathSync(resolve(root));
        invariant(physicalRoot === physicalDirectory, 'BOOTSTRAP_REPO', 'Bootstrap target must be the Git repository root');
        invariant(!(await hasHead(directory)), 'BOOTSTRAP_HAS_COMMIT', 'Repository already has a commit; use onboard instead');
        const status = await runProcess({ command: ['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd: directory, env: environment(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'LANG']), timeoutMs: 10000 });
        invariant(status.status === 'passed' && status.stdout === '', 'BOOTSTRAP_DIRTY', 'Empty repository contains uncommitted application files');
        return { directory, git: true };
    }
    return { directory, git: false };
}
const bootstrapInstructions = `${readRole('setup').instructions}\n\nBootstrap-planning mode:\nThe target application is empty. Produce the smallest credible scaffold for the operator's request. Separate technical bootstrap blockers from product questions and decisions that can be deferred. Never block project creation on business rules that Product can decide later or on production hosting, CI, transactional email, dependency lockfile generation, or other details that can safely be completed after an approved scaffold.\n\nDecision ledger requirements:\n- Extract every material explicit operator choice. Use status=confirmed ONLY when the wording has one material interpretation.\n- If wording has multiple reasonable material interpretations (especially approval/acceptance with exceptions such as "je valide ... sauf ..." / "I approve ... except ..."), record status=ambiguous instead of guessing. Preserve an exact sourceQuote, a neutral unresolved value, one clarificationQuestion, and at least two plausible interpretations.\n- Use enforcement=bootstrap only when clarification is necessary to create a technically coherent initial scaffold. Its clarificationQuestion must also appear in questions.\n- Use enforcement=product for business ambiguity that Product can resolve later. Its clarificationQuestion must appear in productQuestions and MUST NOT block bootstrap while the scaffold remains neutral.\n- Use enforcement=deferred/status=deferred for choices explicitly postponed.\n- Do not silently rewrite, weaken, invert or resolve an ambiguous operator decision.\n- decisionCoverage must say how each confirmed decision is respected. Never claim an ambiguous decision is satisfied. Product decisions may remain for Product only when the scaffold does not contradict any plausible interpretation.\n- Setup chooses only the technical substrate required now. Do not invent lending durations, site policies, account-creation rules or other domain behavior merely to complete bootstrap. The controller also supplies a deterministic OWASP-aware securityContext derived from the operator request. Treat it as a minimum set of surfaces to respect, not as a compliance certificate; do not weaken it or invent scanner results.\n\nReturn only the requested JSON manifest. Do not create files, run shell commands, install dependencies, access secrets, push, commit, or claim tests ran. Prefer a minimal maintainable scaffold with at least one real test when possible. Do not fabricate generated lockfiles. For every architecture decision explain rationale, evidence, alternatives, trade-offs and concrete reconsideration triggers. If the operator names a technology preference, preserve it as a decision and explain any concrete framework variant you propose (for example why a full-stack variant is useful) instead of silently substituting a different stack. Paths must be repository-relative and must never include .git or controller-managed .agent-pipeline/DECISIONS.* / ARCHITECTURE.md files.`;
const semanticReviewInstructions = `Act as an independent consistency reviewer for a bootstrap proposal. Compare the literal operator request, the extracted decision ledger, architecture rationale and every proposed file. Do not trust the proposal's own decisionCoverage claims. Reject the proposal if it omits a material explicit operator decision, contradicts a confirmed decision, changes an operator-selected technology, replaces a required domain relationship with a weaker placeholder, changes an authentication choice, or claims scripts/features unsupported by the files/dependencies. Treat materially ambiguous wording as ambiguous: never let Setup convert "approve/validate ... except/sauf ..." into a confirmed inclusion or exclusion without clarification. Every ambiguous ledger entry must remain status=ambiguous in your decision review. An unresolved ambiguity with enforcement=bootstrap requires changes_requested; an enforcement=product ambiguity may coexist with pass when the scaffold is neutral and its clarification is deferred to Product. Product/deferred decisions do not need to be implemented in the scaffold, but the scaffold must not contradict them. Do not promote ordinary tool-resolvable details such as lockfile generation or production hosting into operator blockers unless the request makes them a real constraint. Use the supplied securityContext to reject scaffolds that obviously contradict required authentication, authorization, secret-handling or trust-boundary constraints, but do not claim OWASP compliance. Your decisions array must contain exactly one entry for each ledger decision whose status is confirmed or ambiguous (listed in materialDecisionIds) and no entry for proposed or deferred decisions; report concerns about those as findings instead. Return only the requested JSON review.`;
/** Bootstrap has no project configuration yet: one bounded repair of an output-contract violation. */
export const BOOTSTRAP_OUTPUT_REPAIRS = 1;
async function runStructuredProvider(store, documentId, root, agent, protocol, instructions, payload, schema, signal, validate = value => value) {
    const workspace = join(root, protocol.replace(/[^A-Za-z0-9_-]/g, '_'));
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const schemaFile = join(workspace, 'schema.json');
    const outputFile = join(workspace, 'result.json');
    const env = environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', ...agent.passEnv]);
    if (agent.type === 'codex')
        writeFileSync(schemaFile, JSON.stringify(strictSchema(schema.json)), { flag: 'wx', mode: 0o600 });
    const ids = new Map();
    const hooks = { onStart: (pid) => { ids.set(pid, store.startDocumentChild(documentId, pid)); }, onFinish: (pid) => { const id = ids.get(pid); if (id) {
            store.finishDocumentChild(id);
            ids.delete(pid);
        } } };
    store.documentEvent(documentId, `${protocol}.started`, { provider: agent.type });
    let repair;
    for (let attempt = 0;; attempt++) {
        const repairLine = repair ? `\nCONTROLLER REJECTED YOUR PREVIOUS ANSWER (${repair.previousError.code}): ${repair.previousError.message}\n${repair.instruction}\n` : '';
        let command = agent.command;
        let input = JSON.stringify({ protocol, role: 'setup', instructions, ...payload, ...(repair ? { repair } : {}), outputSchema: schema.json });
        const outputFromFile = agent.type === 'codex';
        if (agent.type === 'codex') {
            rmSync(outputFile, { force: true });
            command = [agent.command[0] ?? 'codex', 'exec', '--sandbox', 'read-only', '--cd', workspace, '--output-schema', schemaFile, '--output-last-message', outputFile, ...(agent.model ? ['--model', agent.model] : []), '-'];
            input = `${instructions}${repairLine}\n${input}`;
        }
        else if (agent.type === 'claude') {
            command = claudeCommand(agent, schema.json, true);
            input = `${instructions}${repairLine}\n${input}`;
        }
        invariant(command.length > 0, 'AGENT', 'Missing bootstrap provider executable');
        const result = await runProcess({ command, cwd: workspace, env, input, timeoutMs: agent.timeoutMs, ...(signal ? { signal } : {}), ...hooks, maxOutputBytes: 3 * 1024 * 1024 });
        invariant(result.status === 'passed', result.status === 'cancelled' ? 'CANCELLED' : 'BOOTSTRAP_PROVIDER', `${protocol} provider ${result.status}: ${redact(result.stderr.slice(-4000), env)}`);
        try {
            let text = result.stdout;
            if (outputFromFile) {
                invariant(existsSync(outputFile) && lstatSync(outputFile).isFile() && !lstatSync(outputFile).isSymbolicLink(), 'BOOTSTRAP_OUTPUT', `Invalid ${protocol} output file`);
                text = readFileSync(outputFile, 'utf8');
            }
            else
                invariant(!result.truncated, 'BOOTSTRAP_OUTPUT', `${protocol} provider output truncated`);
            const raw = agent.type === 'claude' ? claudeOutput(text) : parseJson(text);
            const value = validate(schema.parse(raw));
            store.documentEvent(documentId, `${protocol}.finished`, { provider: agent.type, durationMs: result.durationMs, attempts: attempt + 1 });
            return value;
        }
        catch (error) {
            if (!isRepairableOutputError(error) || attempt >= BOOTSTRAP_OUTPUT_REPAIRS)
                throw error;
            repair = repairNotice(attempt + 1, error);
            store.documentEvent(documentId, `${protocol}.output_repair`, { attempt: attempt + 1, code: error.code, message: error.message.slice(0, MAX_REPAIR_ERROR_CHARS) });
        }
    }
}
function validateProposal(value, operatorText, previous) {
    const parsed = bootstrapProposalSchema.parse(value);
    const proposal = { ...parsed, files: parsed.files.map(file => ({ ...file, path: safeRelative(file.path) })) };
    const seen = new Set();
    let bytes = 0;
    for (const file of proposal.files) {
        invariant(!seen.has(file.path), 'BOOTSTRAP', `Duplicate bootstrap path: ${file.path}`);
        seen.add(file.path);
        bytes += Buffer.byteLength(file.content);
    }
    invariant(bytes <= 2 * 1024 * 1024, 'BOOTSTRAP_SIZE', 'Bootstrap proposal exceeds 2 MiB');
    invariant(proposal.summary.trim().length > 0 && proposal.questions.every(q => q.trim().length > 0), 'BOOTSTRAP', 'Blank bootstrap text is not accepted');
    invariant(!proposal.files.some(f => ['.agent-pipeline/ARCHITECTURE.md', '.agent-pipeline/DECISIONS.json', '.agent-pipeline/DECISIONS.md'].includes(f.path)), 'BOOTSTRAP', 'Decision/architecture files are controller-managed');
    const ledger = validateDecisionLedger({ schemaVersion: 1, decisions: proposal.decisions }, operatorText);
    validateBootstrapCoverage(ledger, proposal.decisionCoverage, proposal.files.map(f => f.path));
    const bootstrapQuestions = new Set(proposal.questions.map(q => q.trim().toLocaleLowerCase('en-US')));
    const productQuestions = new Set(proposal.productQuestions.map(q => q.trim().toLocaleLowerCase('en-US')));
    for (const decision of ambiguousDecisions(ledger)) {
        const target = decision.enforcement === 'bootstrap' ? bootstrapQuestions : productQuestions;
        invariant(target.has(decision.clarificationQuestion.trim().toLocaleLowerCase('en-US')), 'DECISION_AMBIGUOUS', `Clarification for ambiguous ${decision.enforcement} decision ${decision.id} is not routed to the matching question list`);
    }
    for (const fragment of ambiguousApprovalFragments(operatorText)) {
        const fragmentLower = fragment.toLocaleLowerCase('en-US');
        const currentAmbiguous = ambiguousDecisions(ledger).some(d => fragmentLower.includes(d.sourceQuote.trim().toLocaleLowerCase('en-US')) || d.sourceQuote.trim().toLocaleLowerCase('en-US').includes(fragmentLower));
        const previouslyAmbiguous = (previous?.decisions ?? []).filter(d => d.status === 'ambiguous').filter(d => fragmentLower.includes(d.sourceQuote.trim().toLocaleLowerCase('en-US')) || d.sourceQuote.trim().toLocaleLowerCase('en-US').includes(fragmentLower));
        const explicitlyResolved = previouslyAmbiguous.some(old => proposal.decisions.some(d => d.supersedes.includes(old.id) && ['confirmed', 'deferred'].includes(d.status)));
        invariant(currentAmbiguous || explicitlyResolved, 'DECISION_AMBIGUOUS', `Material approval-with-exception wording must remain ambiguous until explicitly clarified: ${fragment}`);
    }
    return proposal;
}
function preserveOperatorDecisions(previous, next, latestRefinement) {
    const nextById = new Map(next.decisions.map(d => [d.id, d]));
    for (const old of previous.decisions.filter(d => d.source === 'operator' && ['confirmed', 'ambiguous'].includes(d.status))) {
        const same = nextById.get(old.id);
        if (same && same.value === old.value && same.subject === old.subject && same.status === old.status)
            continue;
        const replacement = next.decisions.find(d => d.supersedes.includes(old.id));
        const replacementAllowed = old.status === 'confirmed' ? replacement?.status === 'confirmed' : ['confirmed', 'ambiguous', 'deferred'].includes(replacement?.status ?? '');
        invariant(replacement && replacement.source === 'operator' && replacementAllowed && latestRefinement.toLocaleLowerCase('en-US').includes(replacement.sourceQuote.toLocaleLowerCase('en-US')), 'DECISION_IMMUTABLE', `${old.status} operator decision ${old.id} changed without an explicit replacement in the latest refinement`);
    }
}
async function createProposal(store, doc, work, request, latestRefinement, signal) {
    const previous = doc.data.revision > 1 ? doc.data.proposal : null;
    const preliminarySecurity = assessSecurity({ text: request, projectType: previous?.projectType ?? 'unknown', files: [] });
    const proposal = await runStructuredProvider(store, doc.id, work, doc.data.provider, 'agent-pipeline/bootstrap-v2', bootstrapInstructions, { request, previousProposal: previous, securityContext: preliminarySecurity }, bootstrapProposalSchema, signal, raw => { const valid = validateProposal(raw, request, previous ?? undefined); if (previous && latestRefinement !== undefined)
        preserveOperatorDecisions(previous, valid, latestRefinement); return valid; });
    const ledger = { schemaVersion: 1, decisions: proposal.decisions };
    const semanticReview = await runStructuredProvider(store, doc.id, work, doc.data.provider, 'agent-pipeline/bootstrap-review-v1', semanticReviewInstructions, { request, decisionLedger: ledger, materialDecisionIds: ledger.decisions.filter(d => ['confirmed', 'ambiguous'].includes(d.status)).map(d => d.id), proposal, securityContext: assessSecurity({ text: request, projectType: proposal.projectType, files: proposal.files.map(f => f.path) }) }, semanticReviewSchema, signal, review => validateSemanticReview(ledger, review));
    doc.data.proposal = proposal;
    doc.data.semanticReview = semanticReview;
    doc.data.hash = semanticReview.verdict === 'pass' ? bootstrapHash(doc.data) : '';
}
export function bootstrapHash(plan) {
    return hash({ directory: plan.directory, request: plan.request, revision: plan.revision, provider: plan.provider, reviewMode: plan.reviewMode, proposal: plan.proposal, semanticReview: plan.semanticReview });
}
const emptyReview = { verdict: 'changes_requested', summary: 'Bootstrap proposal has not been semantically reviewed.', decisions: [], missingOperatorDecisions: [], findings: [{ severity: 'blocker', description: 'Semantic review pending.' }] };
const emptyProposal = { projectType: 'unknown', summary: 'pending', architecture: { summary: 'pending architecture rationale', decisions: [{ decision: 'pending', rationale: 'pending rationale', evidence: ['pending'], alternatives: [], tradeoffs: [], reconsiderWhen: ['pending'] }] }, decisions: [], decisionCoverage: [], files: [{ path: 'README.md', content: '' }], questions: [], productQuestions: [], deferredQuestions: [], notes: [] };
export async function planBootstrap(store, path, request, provider, signal, reviewMode = 'team') {
    invariant(request.trim().length >= 10 && request.length <= 30000, 'BOOTSTRAP_REQUEST', 'Describe the new application in at least 10 characters');
    const target = await ensureBootstrapTarget(path);
    invariant(!isInside(target.directory, store.root) && !isInside(store.root, target.directory), 'STATE_PATH', 'Keep operational state outside the bootstrap target');
    const agent = typeof provider === 'string' ? providerProfile(provider) : agentSchema.parse(provider);
    const draft = { directory: target.directory, request, revision: 1, provider: agent, reviewMode, proposal: structuredClone(emptyProposal), semanticReview: structuredClone(emptyReview), hash: '', applied: false, commitSha: null, approval: null, onboarding: null };
    const doc = store.createDocument('bootstrap', draft);
    const token = store.acquireDocument(doc.id);
    const work = join(store.root, 'bootstrap', randomUUID());
    mkdirSync(work, { recursive: true, mode: 0o700 });
    try {
        await createProposal(store, doc, work, request, undefined, signal);
        store.saveDocument(doc, 'bootstrap.proposed', { revision: doc.data.revision, hash: doc.data.hash, files: doc.data.proposal.files.map(f => f.path), questions: doc.data.proposal.questions, productQuestions: doc.data.proposal.productQuestions, deferredQuestions: doc.data.proposal.deferredQuestions, semanticVerdict: doc.data.semanticReview.verdict });
        return doc;
    }
    finally {
        store.releaseDocument(doc.id, token);
        rmSync(work, { recursive: true, force: true });
    }
}
export async function refineBootstrap(store, id, request, signal) {
    invariant(request.trim().length > 0 && request.length <= 10000, 'BOOTSTRAP_REQUEST', 'Provide a bounded bootstrap refinement');
    const token = store.acquireDocument(id);
    const work = join(store.root, 'bootstrap', randomUUID());
    mkdirSync(work, { recursive: true, mode: 0o700 });
    try {
        const doc = store.document(id, 'bootstrap');
        invariant(!doc.data.applied, 'STATE', 'Applied bootstrap cannot be refined');
        invariant(doc.data.request.length + request.length + 40 <= 30000, 'BOOTSTRAP_REQUEST', 'Accumulated bootstrap request exceeds 30000 characters');
        doc.data.request += `\n\nOperator refinement:\n${request}`;
        doc.data.revision++;
        doc.data.hash = '';
        doc.data.semanticReview = structuredClone(emptyReview);
        store.saveDocument(doc, 'bootstrap.refinement_requested', { revision: doc.data.revision, request });
        await createProposal(store, doc, work, doc.data.request, request, signal);
        store.saveDocument(doc, 'bootstrap.proposed', { revision: doc.data.revision, hash: doc.data.hash, questions: doc.data.proposal.questions, productQuestions: doc.data.proposal.productQuestions, deferredQuestions: doc.data.proposal.deferredQuestions, semanticVerdict: doc.data.semanticReview.verdict });
        return doc;
    }
    finally {
        store.releaseDocument(id, token);
        rmSync(work, { recursive: true, force: true });
    }
}
function architectureMarkdown(plan) {
    const a = plan.proposal.architecture;
    const lines = ['# Architecture rationale', '', a.summary, '', `Project type: ${plan.proposal.projectType}`, ''];
    a.decisions.forEach((d, i) => lines.push(`## ${i + 1}. ${d.decision}`, '', d.rationale, '', '### Evidence', ...d.evidence.map(x => `- ${x}`), '', '### Alternatives', ...(d.alternatives.length ? d.alternatives.map(x => `- **${x.option}** — ${x.reasonNotChosen}`) : ['- None recorded']), '', '### Trade-offs', ...(d.tradeoffs.length ? d.tradeoffs.map(x => `- ${x}`) : ['- None recorded']), '', '### Reconsider when', ...d.reconsiderWhen.map(x => `- ${x}`), ''));
    lines.push('---', '', 'This file records bootstrap-time reasoning. Confirmed operator decisions are authoritative in DECISIONS.json; revisit derived architecture choices when their triggers occur.', '');
    return lines.join('\n');
}
export async function applyBootstrap(store, id, expectedHash, actor, note, commit) {
    reviewer(actor, note);
    invariant(commit, 'BOOTSTRAP_COMMIT', 'Bootstrap apply requires --commit so the pipeline has an immutable base commit');
    const token = store.acquireDocument(id);
    try {
        const doc = store.document(id, 'bootstrap');
        const plan = doc.data;
        invariant(!plan.applied, 'STATE', 'Bootstrap already applied');
        invariant(plan.semanticReview.verdict === 'pass', 'SEMANTIC_REVIEW', 'Bootstrap proposal has not passed semantic consistency review');
        invariant(plan.hash.length === 64 && plan.hash === expectedHash && plan.hash === bootstrapHash(plan), 'APPROVAL_HASH', 'Review the exact semantically validated bootstrap hash');
        invariant(plan.proposal.questions.length === 0, 'OPEN_QUESTIONS', 'Resolve bootstrap-only questions before applying; Product/deferred questions do not block bootstrap');
        const target = await ensureBootstrapTarget(plan.directory);
        if (!target.git) {
            const init = await runProcess({ command: ['git', 'init'], cwd: plan.directory, env: environment(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'LANG']), timeoutMs: 30000 });
            invariant(init.status === 'passed', 'GIT', 'git init failed');
        }
        const written = [];
        try {
            for (const file of plan.proposal.files) {
                const rel = safeRelative(file.path);
                const full = resolve(plan.directory, rel);
                invariant(isInside(plan.directory, full) && !existsSync(full), 'BOOTSTRAP_CONFLICT', `Refusing to overwrite ${rel}`);
                mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
                writeFileSync(full, file.content, { flag: 'wx', mode: 0o600 });
                written.push(full);
            }
            const architecturePath = resolve(plan.directory, '.agent-pipeline/ARCHITECTURE.md');
            const decisionsJson = resolve(plan.directory, '.agent-pipeline/DECISIONS.json');
            const decisionsMd = resolve(plan.directory, '.agent-pipeline/DECISIONS.md');
            for (const file of [architecturePath, decisionsJson, decisionsMd])
                invariant(!existsSync(file), 'BOOTSTRAP_CONFLICT', `Refusing to overwrite ${file}`);
            mkdirSync(dirname(architecturePath), { recursive: true, mode: 0o700 });
            writeFileSync(architecturePath, architectureMarkdown(plan), { flag: 'wx', mode: 0o600 });
            written.push(architecturePath);
            const ledger = { schemaVersion: 1, decisions: plan.proposal.decisions };
            writeFileSync(decisionsJson, JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
            written.push(decisionsJson);
            writeFileSync(decisionsMd, decisionLedgerMarkdown(ledger), { flag: 'wx', mode: 0o600 });
            written.push(decisionsMd);
            const git = new Git();
            await git.exec(plan.directory, ['add', '--all', '--', '.']);
            await git.exec(plan.directory, ['commit', '--no-verify', '-m', 'chore: bootstrap application']);
            plan.commitSha = await git.sha(plan.directory);
            plan.applied = true;
            plan.approval = { reviewer: actor.trim(), note: note.trim(), at: Date.now() };
            store.saveDocument(doc, 'bootstrap.applied', { hash: expectedHash, commitSha: plan.commitSha, files: plan.proposal.files.map(f => f.path), decisionCount: ledger.decisions.length, semanticReview: plan.semanticReview.summary });
            const onboarding = await planInstallation(store, plan.directory, { agent: plan.provider, reviewMode: plan.reviewMode });
            plan.onboarding = { id: onboarding.id, hash: onboarding.data.hash };
            store.saveDocument(doc, 'bootstrap.onboarding_proposed', plan.onboarding);
            return { bootstrap: doc, onboarding };
        }
        catch (error) {
            if (!(await hasHead(plan.directory)))
                for (const full of written.reverse())
                    rmSync(full, { force: true });
            throw error;
        }
    }
    finally {
        store.releaseDocument(id, token);
    }
}
//# sourceMappingURL=bootstrap.js.map