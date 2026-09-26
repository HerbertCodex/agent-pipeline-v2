import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { s, parseJson } from '../domain/schema.js';
import { errorMessage, invariant } from '../domain/errors.js';
import { IssueList, schemaIssues } from '../domain/issues.js';
import { hash } from '../domain/hash.js';
import { Git } from '../execution/git.js';
import { matches } from '../policy/policy.js';
import { globsOverlap } from '../policy/overlap.js';
export const decisionEnforcements = ['bootstrap', 'product', 'deferred'];
export const decisionStatuses = ['confirmed', 'proposed', 'ambiguous', 'deferred'];
export const decisionSources = ['operator', 'derived'];
/** Kebab-case spec id, as in `.apv/specs/<id>.json`. */
const specIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * Optional perimeter of a decision: the paths it concerns (portable globs, the syntax of `allowedPaths`) and/or
 * the specs it concerns (ids). A confirmed Product decision with a scope is required by a spec only when one of
 * its paths can match a path a task of the spec may change, or when it names the spec; without a scope it is
 * required by every spec (the historical rule).
 */
export const decisionScopeSchema = s.object({
    paths: s.optional(s.array(s.string(1, 500), 1, 100)),
    specs: s.optional(s.array(s.string(1, 80, specIdPattern), 1, 100)),
});
export const decisionSchema = s.object({
    id: s.string(1, 80, /^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    subject: s.string(1, 1000),
    value: s.string(1, 4000),
    enforcement: s.enum(decisionEnforcements),
    status: s.enum(decisionStatuses),
    source: s.enum(decisionSources),
    sourceQuote: s.default(s.string(0, 4000), ''),
    rationale: s.string(1, 4000),
    supersedes: s.default(s.array(s.string(1, 80, /^[A-Za-z0-9][A-Za-z0-9._-]*$/), 0, 20), []),
    clarificationQuestion: s.default(s.string(0, 3000), ''),
    interpretations: s.default(s.array(s.string(1, 2000), 0, 10), []),
    // Optional, never defaulted: a ledger without scopes parses and hashes exactly as before.
    scope: s.optional(decisionScopeSchema),
});
export const decisionLedgerSchema = s.object({
    schemaVersion: s.literal(1),
    decisions: s.array(decisionSchema, 0, 200),
});
export const decisionCoverageSchema = s.object({
    decisionId: s.string(1, 80, /^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    status: s.enum(['satisfied', 'deferred', 'conflict', 'unknown']),
    evidence: s.array(s.object({
        kind: s.enum(['file', 'architecture', 'constraint', 'acceptance']),
        reference: s.string(1, 1000),
        detail: s.string(1, 3000),
    }), 1, 30),
});
export const semanticReviewSchema = s.object({
    verdict: s.enum(['pass', 'changes_requested']),
    summary: s.string(1, 8000),
    decisions: s.array(s.object({
        decisionId: s.string(1, 80, /^[A-Za-z0-9][A-Za-z0-9._-]*$/),
        status: s.enum(['pass', 'fail', 'unknown', 'ambiguous']),
        evidence: s.string(1, 4000),
    }), 0, 200),
    missingOperatorDecisions: s.array(s.object({
        sourceQuote: s.string(1, 4000),
        description: s.string(1, 4000),
    }), 0, 50),
    findings: s.array(s.object({
        severity: s.enum(['blocker', 'warning']),
        description: s.string(1, 4000),
    }), 0, 100),
});
function includesQuote(text, quote) {
    return text.toLocaleLowerCase('en-US').includes(quote.trim().toLocaleLowerCase('en-US'));
}
/**
 * Conservative deterministic tripwire for a high-value class of scope ambiguities:
 * an approval/acceptance followed by an exception ("je valide ... sauf ...").
 * It intentionally does not try to understand arbitrary natural language; the
 * independent semantic reviewer remains responsible for broader ambiguity.
 */
export function ambiguousApprovalFragments(text) {
    const normalized = text.replace(/\r/g, '');
    const patterns = [
        /\b(?:je\s+)?(?:valide|approuve|accepte|confirme)\b[^.!?\n]{0,500}\b(?:sauf|except(?:é|e|és|ées)?|hormis|à\s+part)\b[^.!?\n]{1,300}/giu,
        /\b(?:i\s+)?(?:approve|accept|confirm)\b[^.!?\n]{0,500}\b(?:except|other\s+than)\b[^.!?\n]{1,300}/giu,
    ];
    const matches = [];
    for (const pattern of patterns)
        for (const match of normalized.matchAll(pattern)) {
            const value = match[0]?.trim();
            if (value)
                matches.push(value);
        }
    return [...new Set(matches)];
}
/** Semantic rules of a parsed ledger, every violation listed (V2 stopped at the first). */
export function decisionLedgerRuleIssues(parsed, operatorText) {
    const list = new IssueList();
    list.check(new Set(parsed.decisions.map(d => d.id)).size === parsed.decisions.length, 'DECISION', 'Duplicate decision id');
    const ids = new Set(parsed.decisions.map(d => d.id));
    for (const decision of parsed.decisions) {
        list.check(new Set(decision.supersedes).size === decision.supersedes.length, 'DECISION', `Duplicate superseded decision in ${decision.id}`);
        list.check(decision.supersedes.every(id => id !== decision.id), 'DECISION', `Decision ${decision.id} cannot supersede itself`);
        if (decision.source === 'operator' && ['confirmed', 'ambiguous'].includes(decision.status)) {
            if (list.check(decision.sourceQuote.trim().length > 0, 'DECISION_SOURCE', `${decision.status} operator decision ${decision.id} requires an exact source quote`) && operatorText !== undefined)
                list.check(includesQuote(operatorText, decision.sourceQuote), 'DECISION_SOURCE', `Decision ${decision.id} source quote is not present in the operator request`);
        }
        if (decision.status === 'ambiguous') {
            list.check(decision.enforcement !== 'deferred', 'DECISION', `Ambiguous decision ${decision.id} cannot use deferred enforcement`);
            list.check(decision.clarificationQuestion.trim().length > 0, 'DECISION_AMBIGUOUS', `Ambiguous decision ${decision.id} requires a clarification question`);
            list.check(decision.interpretations.length >= 2, 'DECISION_AMBIGUOUS', `Ambiguous decision ${decision.id} requires at least two plausible interpretations`);
            list.check(new Set(decision.interpretations.map(x => x.trim().toLocaleLowerCase('en-US'))).size === decision.interpretations.length, 'DECISION_AMBIGUOUS', `Ambiguous decision ${decision.id} has duplicate interpretations`);
        }
        else {
            list.check(decision.clarificationQuestion === '' && decision.interpretations.length === 0, 'DECISION_AMBIGUOUS', `Only ambiguous decisions may carry clarification metadata (${decision.id})`);
        }
        if (decision.status === 'deferred')
            list.check(decision.enforcement === 'deferred', 'DECISION', `Deferred decision ${decision.id} must use deferred enforcement`);
        for (const old of decision.supersedes)
            list.check(!ids.has(old) || old !== decision.id, 'DECISION', `Invalid supersedes relationship for ${decision.id}`);
        if (decision.scope) {
            list.check((decision.scope.paths?.length ?? 0) + (decision.scope.specs?.length ?? 0) > 0, 'DECISION_SCOPE', `Decision ${decision.id}: scope must name paths or specs (remove it for a decision that concerns every spec)`);
            for (const pattern of decision.scope.paths ?? []) {
                try {
                    matches('probe', pattern);
                }
                catch (error) {
                    list.check(false, 'DECISION_SCOPE', `Decision ${decision.id}: scope.paths: ${errorMessage(error)}`);
                }
            }
        }
    }
    return list.items;
}
/** Every problem of an unparsed ledger document: schema first, then the ledger rules. */
export function decisionLedgerIssues(value, operatorText) {
    const { value: parsed, issues } = schemaIssues(decisionLedgerSchema, value);
    return parsed ? decisionLedgerRuleIssues(parsed, operatorText) : issues;
}
export function validateDecisionLedger(ledger, operatorText) {
    const parsed = decisionLedgerSchema.parse(ledger);
    const list = new IssueList();
    list.items.push(...decisionLedgerRuleIssues(parsed, operatorText));
    list.throwFirst();
    return parsed;
}
export function ledgerHash(ledger) { return hash(validateDecisionLedger(ledger)); }
export function confirmedDecisions(ledger, enforcement) {
    const parsed = validateDecisionLedger(ledger);
    return parsed.decisions.filter(d => d.status === 'confirmed' && (enforcement === undefined || d.enforcement === enforcement));
}
export function ambiguousDecisions(ledger, enforcement) {
    const parsed = validateDecisionLedger(ledger);
    return parsed.decisions.filter(d => d.status === 'ambiguous' && (enforcement === undefined || d.enforcement === enforcement));
}
/**
 * Why a decision concerns a spec, or null when it does not: no scope (every spec), the spec named in
 * `scope.specs`, or a `scope.paths` glob that can match a path allowed to one of the tasks.
 */
export function decisionReason(decision, target) {
    const scope = decision.scope;
    if (!scope)
        return 'sans périmètre (champ scope absent), elle vaut pour toute spec';
    if (target.specId && scope.specs?.includes(target.specId))
        return `son périmètre nomme la spec ${target.specId}`;
    for (const pattern of scope.paths ?? []) {
        const allowed = target.paths.find(path => globsOverlap(pattern, path));
        if (allowed !== undefined)
            return `son périmètre ${pattern} recoupe le chemin autorisé ${allowed}`;
    }
    return null;
}
export const decisionApplies = (decision, target) => decisionReason(decision, target) !== null;
export function validateBootstrapCoverage(ledger, coverage, files) {
    const parsed = validateDecisionLedger(ledger);
    const byId = new Map(parsed.decisions.map(d => [d.id, d]));
    invariant(new Set(coverage.map(c => c.decisionId)).size === coverage.length, 'DECISION_COVERAGE', 'Duplicate decision coverage');
    for (const c of coverage) {
        invariant(byId.has(c.decisionId), 'DECISION_COVERAGE', `Coverage references unknown decision ${c.decisionId}`);
        for (const evidence of c.evidence)
            if (evidence.kind === 'file')
                invariant(files.includes(evidence.reference), 'DECISION_COVERAGE', `Decision ${c.decisionId} references missing bootstrap file ${evidence.reference}`);
    }
    const cov = new Map(coverage.map(c => [c.decisionId, c]));
    for (const d of confirmedDecisions(parsed, 'bootstrap')) {
        const item = cov.get(d.id);
        invariant(item && item.status === 'satisfied', 'DECISION_COVERAGE', `Confirmed bootstrap decision ${d.id} is not satisfied by the proposal`);
    }
    for (const d of confirmedDecisions(parsed, 'product')) {
        const item = cov.get(d.id);
        if (item)
            invariant(!['conflict', 'unknown'].includes(item.status), 'DECISION_COVERAGE', `Product decision ${d.id} is contradicted by the bootstrap proposal`);
    }
    for (const d of ambiguousDecisions(parsed)) {
        const item = cov.get(d.id);
        if (item)
            invariant(item.status !== 'satisfied', 'DECISION_COVERAGE', `Ambiguous decision ${d.id} cannot be claimed as satisfied before clarification`);
    }
}
export function validateSemanticReview(ledger, review) {
    const raw = semanticReviewSchema.parse(review);
    const validated = validateDecisionLedger(ledger);
    const material = validated.decisions.filter(d => ['confirmed', 'ambiguous'].includes(d.status));
    const ids = new Set(material.map(d => d.id));
    const known = new Set(validated.decisions.map(d => d.id));
    invariant(new Set(raw.decisions.map(d => d.decisionId)).size === raw.decisions.length, 'SEMANTIC_REVIEW', 'Duplicate decision review');
    const unknown = raw.decisions.filter(d => !known.has(d.decisionId)).map(d => d.decisionId);
    invariant(unknown.length === 0, 'SEMANTIC_REVIEW', `Semantic review references unknown decision(s): ${unknown.join(', ')}`);
    // Reviews of non-material (proposed/deferred) entries are not decision checks; negative signals are kept as warnings.
    const nonMaterial = raw.decisions.filter(d => !ids.has(d.decisionId));
    const parsed = semanticReviewSchema.parse({
        ...raw,
        decisions: raw.decisions.filter(d => ids.has(d.decisionId)),
        findings: [...raw.findings, ...nonMaterial.filter(d => d.status !== 'pass').map(d => ({ severity: 'warning', description: `Non-material decision ${d.decisionId} reviewed as ${d.status}: ${d.evidence}`.slice(0, 4000) }))],
    });
    const byId = new Map(parsed.decisions.map(d => [d.decisionId, d]));
    for (const d of material)
        invariant(byId.has(d.id), 'SEMANTIC_REVIEW', `Semantic review omitted decision ${d.id}`);
    for (const d of ambiguousDecisions(validated))
        invariant(byId.get(d.id)?.status === 'ambiguous', 'SEMANTIC_REVIEW', `Semantic review must preserve ambiguity for ${d.id}`);
    if (parsed.verdict === 'pass') {
        invariant(parsed.missingOperatorDecisions.length === 0, 'SEMANTIC_REVIEW', 'Semantic review cannot pass while explicit operator decisions are missing');
        invariant(!parsed.findings.some(f => f.severity === 'blocker'), 'SEMANTIC_REVIEW', 'Semantic review pass contradicts blocking findings');
        for (const d of confirmedDecisions(validated))
            invariant(byId.get(d.id)?.status === 'pass', 'SEMANTIC_REVIEW', `Semantic review did not pass confirmed decision ${d.id}`);
        invariant(ambiguousDecisions(validated, 'bootstrap').length === 0, 'SEMANTIC_REVIEW', 'Semantic review cannot pass with unresolved bootstrap ambiguity');
    }
    return parsed;
}
export function decisionLedgerMarkdown(ledger) {
    const parsed = validateDecisionLedger(ledger);
    const lines = ['# Decision Ledger', '', `Ledger hash: ${ledgerHash(parsed)}`, ''];
    for (const d of parsed.decisions) {
        lines.push(`## ${d.id} — ${d.subject}`, '', `Value: ${d.value}`, `Status: ${d.status}`, `Enforcement: ${d.enforcement}`, `Source: ${d.source}`);
        if (d.sourceQuote)
            lines.push(`Source quote: ${d.sourceQuote}`);
        if (d.scope)
            lines.push(`Scope: ${[...(d.scope.paths ?? []).map(p => `paths ${p}`), ...(d.scope.specs ?? []).map(x => `spec ${x}`)].join(', ')}`);
        if (d.status === 'ambiguous') {
            lines.push(`Clarification: ${d.clarificationQuestion}`, '', 'Plausible interpretations:', ...d.interpretations.map(x => `- ${x}`));
        }
        lines.push('', d.rationale, '');
    }
    // One final newline: a blank last line fails `git diff --check` in the projects that version this file.
    return lines.join('\n').replace(/\n+$/, '') + '\n';
}
/** V3 location of the ledger, versioned with the project. */
export const LEDGER_FILE = '.apv/DECISIONS.json';
/** V2 location, still read (and updated in place) for projects not yet migrated. */
export const LEGACY_LEDGER_FILE = '.agent-pipeline/DECISIONS.json';
async function trackedAt(repo, sha, file) {
    return (await new Git().exec(repo, ['ls-tree', '-r', '--name-only', sha, '--', file])).trim() === file;
}
/**
 * Where this project keeps its ledger: `.apv/DECISIONS.json` when it exists (in the working tree or at
 * `sha`), otherwise the V2 `.agent-pipeline/DECISIONS.json` when that one exists, otherwise the V3 location.
 */
export async function resolveLedgerFile(repo, sha = 'HEAD') {
    for (const file of [LEDGER_FILE, LEGACY_LEDGER_FILE]) {
        if (existsSync(join(repo, file)))
            return file;
        if (sha && await trackedAt(repo, sha, file))
            return file;
    }
    return LEDGER_FILE;
}
/** Committed ledger at `sha`; an absent file is an empty ledger. */
export async function loadDecisionLedger(repo, sha = 'HEAD', file) {
    const path = file ?? await resolveLedgerFile(repo, sha);
    if (!await trackedAt(repo, sha, path))
        return { schemaVersion: 1, decisions: [] };
    const raw = await new Git().exec(repo, ['show', `${sha}:${path}`]);
    return validateDecisionLedger(decisionLedgerSchema.parse(parseJson(raw)));
}
/** Working-tree ledger (V3 location first, then V2); an absent file is an empty ledger. */
export function readWorkingDecisionLedger(repo) {
    const file = [LEDGER_FILE, LEGACY_LEDGER_FILE].map(f => join(repo, f)).find(f => existsSync(f));
    if (!file)
        return { schemaVersion: 1, decisions: [] };
    return validateDecisionLedger(decisionLedgerSchema.parse(parseJson(readFileSync(file, 'utf8'))));
}
//# sourceMappingURL=decisions.js.map