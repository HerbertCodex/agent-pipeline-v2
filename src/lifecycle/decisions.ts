import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { s, parseJson, type Infer } from '../domain/schema.js';
import { invariant } from '../domain/errors.js';
import { hash } from '../domain/hash.js';
import { Git } from '../execution/git.js';

export const decisionEnforcements = ['bootstrap','product','deferred'] as const;
export const decisionStatuses = ['confirmed','proposed','ambiguous','deferred'] as const;
export const decisionSources = ['operator','derived'] as const;

export const decisionSchema = s.object({
  id: s.string(1,80,/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  subject: s.string(1,1000),
  value: s.string(1,4000),
  enforcement: s.enum(decisionEnforcements),
  status: s.enum(decisionStatuses),
  source: s.enum(decisionSources),
  sourceQuote: s.default(s.string(0,4000),''),
  rationale: s.string(1,4000),
  supersedes: s.default(s.array(s.string(1,80,/^[A-Za-z0-9][A-Za-z0-9._-]*$/),0,20),[]),
  clarificationQuestion: s.default(s.string(0,3000),''),
  interpretations: s.default(s.array(s.string(1,2000),0,10),[]),
});
export type Decision = Infer<typeof decisionSchema>;

export const decisionLedgerSchema = s.object({
  schemaVersion: s.literal(1),
  decisions: s.array(decisionSchema,0,200),
});
export type DecisionLedger = Infer<typeof decisionLedgerSchema>;

export const decisionCoverageSchema = s.object({
  decisionId: s.string(1,80,/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  status: s.enum(['satisfied','deferred','conflict','unknown']),
  evidence: s.array(s.object({
    kind: s.enum(['file','architecture','constraint','acceptance']),
    reference: s.string(1,1000),
    detail: s.string(1,3000),
  }),1,30),
});
export type DecisionCoverage = Infer<typeof decisionCoverageSchema>;

export const semanticReviewSchema = s.object({
  verdict: s.enum(['pass','changes_requested']),
  summary: s.string(1,8000),
  decisions: s.array(s.object({
    decisionId: s.string(1,80,/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    status: s.enum(['pass','fail','unknown','ambiguous']),
    evidence: s.string(1,4000),
  }),0,200),
  missingOperatorDecisions: s.array(s.object({
    sourceQuote: s.string(1,4000),
    description: s.string(1,4000),
  }),0,50),
  findings: s.array(s.object({
    severity: s.enum(['blocker','warning']),
    description: s.string(1,4000),
  }),0,100),
});
export type SemanticReview = Infer<typeof semanticReviewSchema>;

function includesQuote(text: string, quote: string): boolean {
  return text.toLocaleLowerCase('en-US').includes(quote.trim().toLocaleLowerCase('en-US'));
}

/**
 * Conservative deterministic tripwire for a high-value class of scope ambiguities:
 * an approval/acceptance followed by an exception ("je valide ... sauf ...").
 * It intentionally does not try to understand arbitrary natural language; the
 * independent semantic reviewer remains responsible for broader ambiguity.
 */
export function ambiguousApprovalFragments(text: string): string[] {
  const normalized=text.replace(/\r/g,'');
  const patterns=[
    /\b(?:je\s+)?(?:valide|approuve|accepte|confirme)\b[^.!?\n]{0,500}\b(?:sauf|except(?:é|e|és|ées)?|hormis|à\s+part)\b[^.!?\n]{1,300}/giu,
    /\b(?:i\s+)?(?:approve|accept|confirm)\b[^.!?\n]{0,500}\b(?:except|other\s+than)\b[^.!?\n]{1,300}/giu,
  ];
  const matches:string[]=[];
  for(const pattern of patterns) for(const match of normalized.matchAll(pattern)) {
    const value=match[0]?.trim(); if(value) matches.push(value);
  }
  return [...new Set(matches)];
}

export function validateDecisionLedger(ledger: DecisionLedger, operatorText?: string): DecisionLedger {
  const parsed = decisionLedgerSchema.parse(ledger);
  invariant(new Set(parsed.decisions.map(d=>d.id)).size === parsed.decisions.length,'DECISION','Duplicate decision id');
  const ids = new Set(parsed.decisions.map(d=>d.id));
  for (const decision of parsed.decisions) {
    invariant(new Set(decision.supersedes).size === decision.supersedes.length,'DECISION',`Duplicate superseded decision in ${decision.id}`);
    invariant(decision.supersedes.every(id=>id !== decision.id),'DECISION',`Decision ${decision.id} cannot supersede itself`);
    if (decision.source === 'operator' && ['confirmed','ambiguous'].includes(decision.status)) {
      invariant(decision.sourceQuote.trim().length > 0,'DECISION_SOURCE',`${decision.status} operator decision ${decision.id} requires an exact source quote`);
      if (operatorText !== undefined) invariant(includesQuote(operatorText,decision.sourceQuote),'DECISION_SOURCE',`Decision ${decision.id} source quote is not present in the operator request`);
    }
    if (decision.status === 'ambiguous') {
      invariant(decision.enforcement !== 'deferred','DECISION',`Ambiguous decision ${decision.id} cannot use deferred enforcement`);
      invariant(decision.clarificationQuestion.trim().length > 0,'DECISION_AMBIGUOUS',`Ambiguous decision ${decision.id} requires a clarification question`);
      invariant(decision.interpretations.length >= 2,'DECISION_AMBIGUOUS',`Ambiguous decision ${decision.id} requires at least two plausible interpretations`);
      invariant(new Set(decision.interpretations.map(x=>x.trim().toLocaleLowerCase('en-US'))).size === decision.interpretations.length,'DECISION_AMBIGUOUS',`Ambiguous decision ${decision.id} has duplicate interpretations`);
    } else {
      invariant(decision.clarificationQuestion === '' && decision.interpretations.length === 0,'DECISION_AMBIGUOUS',`Only ambiguous decisions may carry clarification metadata (${decision.id})`);
    }
    if (decision.status === 'deferred') invariant(decision.enforcement === 'deferred','DECISION',`Deferred decision ${decision.id} must use deferred enforcement`);
    for (const old of decision.supersedes) invariant(!ids.has(old) || old !== decision.id,'DECISION',`Invalid supersedes relationship for ${decision.id}`);
  }
  return parsed;
}

export function ledgerHash(ledger: DecisionLedger): string { return hash(validateDecisionLedger(ledger)); }

export function confirmedDecisions(ledger: DecisionLedger, enforcement?: 'bootstrap'|'product'): Decision[] {
  const parsed = validateDecisionLedger(ledger);
  return parsed.decisions.filter(d=>d.status === 'confirmed' && (enforcement === undefined || d.enforcement === enforcement));
}

export function ambiguousDecisions(ledger: DecisionLedger, enforcement?: 'bootstrap'|'product'): Decision[] {
  const parsed=validateDecisionLedger(ledger);
  return parsed.decisions.filter(d=>d.status === 'ambiguous' && (enforcement === undefined || d.enforcement === enforcement));
}

export function validateBootstrapCoverage(ledger: DecisionLedger, coverage: DecisionCoverage[], files: string[]): void {
  const parsed = validateDecisionLedger(ledger);
  const byId = new Map(parsed.decisions.map(d=>[d.id,d]));
  invariant(new Set(coverage.map(c=>c.decisionId)).size === coverage.length,'DECISION_COVERAGE','Duplicate decision coverage');
  for (const c of coverage) {
    invariant(byId.has(c.decisionId),'DECISION_COVERAGE',`Coverage references unknown decision ${c.decisionId}`);
    for (const evidence of c.evidence) if (evidence.kind === 'file') invariant(files.includes(evidence.reference),'DECISION_COVERAGE',`Decision ${c.decisionId} references missing bootstrap file ${evidence.reference}`);
  }
  const cov = new Map(coverage.map(c=>[c.decisionId,c]));
  for (const d of confirmedDecisions(parsed,'bootstrap')) {
    const item = cov.get(d.id);
    invariant(item && item.status === 'satisfied','DECISION_COVERAGE',`Confirmed bootstrap decision ${d.id} is not satisfied by the proposal`);
  }
  for (const d of confirmedDecisions(parsed,'product')) {
    const item = cov.get(d.id);
    if (item) invariant(!['conflict','unknown'].includes(item.status),'DECISION_COVERAGE',`Product decision ${d.id} is contradicted by the bootstrap proposal`);
  }
  for(const d of ambiguousDecisions(parsed)) {
    const item=cov.get(d.id);
    if(item) invariant(item.status !== 'satisfied','DECISION_COVERAGE',`Ambiguous decision ${d.id} cannot be claimed as satisfied before clarification`);
  }
}

export function validateSemanticReview(ledger: DecisionLedger, review: SemanticReview): SemanticReview {
  const raw = semanticReviewSchema.parse(review);
  const validated=validateDecisionLedger(ledger);
  const material = validated.decisions.filter(d=>['confirmed','ambiguous'].includes(d.status));
  const ids = new Set(material.map(d=>d.id));
  const known = new Set(validated.decisions.map(d=>d.id));
  invariant(new Set(raw.decisions.map(d=>d.decisionId)).size === raw.decisions.length,'SEMANTIC_REVIEW','Duplicate decision review');
  const unknown = raw.decisions.filter(d=>!known.has(d.decisionId)).map(d=>d.decisionId);
  invariant(unknown.length === 0,'SEMANTIC_REVIEW',`Semantic review references unknown decision(s): ${unknown.join(', ')}`);
  // Reviews of non-material (proposed/deferred) entries are not decision checks; negative signals are kept as warnings.
  const nonMaterial = raw.decisions.filter(d=>!ids.has(d.decisionId));
  const parsed: SemanticReview = semanticReviewSchema.parse({
    ...raw,
    decisions: raw.decisions.filter(d=>ids.has(d.decisionId)),
    findings: [...raw.findings, ...nonMaterial.filter(d=>d.status !== 'pass').map(d=>({severity:'warning',description:`Non-material decision ${d.decisionId} reviewed as ${d.status}: ${d.evidence}`.slice(0,4000)}))],
  });
  const byId = new Map(parsed.decisions.map(d=>[d.decisionId,d]));
  for(const d of material) invariant(byId.has(d.id),'SEMANTIC_REVIEW',`Semantic review omitted decision ${d.id}`);
  for(const d of ambiguousDecisions(validated)) invariant(byId.get(d.id)?.status === 'ambiguous','SEMANTIC_REVIEW',`Semantic review must preserve ambiguity for ${d.id}`);
  if (parsed.verdict === 'pass') {
    invariant(parsed.missingOperatorDecisions.length === 0,'SEMANTIC_REVIEW','Semantic review cannot pass while explicit operator decisions are missing');
    invariant(!parsed.findings.some(f=>f.severity === 'blocker'),'SEMANTIC_REVIEW','Semantic review pass contradicts blocking findings');
    for (const d of confirmedDecisions(validated)) invariant(byId.get(d.id)?.status === 'pass','SEMANTIC_REVIEW',`Semantic review did not pass confirmed decision ${d.id}`);
    invariant(ambiguousDecisions(validated,'bootstrap').length===0,'SEMANTIC_REVIEW','Semantic review cannot pass with unresolved bootstrap ambiguity');
  }
  return parsed;
}

export function decisionLedgerMarkdown(ledger: DecisionLedger): string {
  const parsed = validateDecisionLedger(ledger);
  const lines=['# Decision Ledger','',`Ledger hash: ${ledgerHash(parsed)}`,''];
  for (const d of parsed.decisions) {
    lines.push(`## ${d.id} — ${d.subject}`,'',`Value: ${d.value}`,`Status: ${d.status}`,`Enforcement: ${d.enforcement}`,`Source: ${d.source}`);
    if (d.sourceQuote) lines.push(`Source quote: ${d.sourceQuote}`);
    if(d.status==='ambiguous') {
      lines.push(`Clarification: ${d.clarificationQuestion}`,'','Plausible interpretations:',...d.interpretations.map(x=>`- ${x}`));
    }
    lines.push('',d.rationale,'');
  }
  return lines.join('\n')+'\n';
}

export async function loadDecisionLedger(repo: string, sha = 'HEAD'): Promise<DecisionLedger> {
  const git = new Git();
  const listed = (await git.exec(repo,['ls-tree','-r','--name-only',sha,'--','.agent-pipeline/DECISIONS.json'])).trim();
  if (listed !== '.agent-pipeline/DECISIONS.json') return { schemaVersion:1, decisions:[] };
  const raw = await git.exec(repo,['show',`${sha}:.agent-pipeline/DECISIONS.json`]);
  return validateDecisionLedger(decisionLedgerSchema.parse(parseJson(raw)));
}

export function readWorkingDecisionLedger(repo: string): DecisionLedger {
  const file=join(repo,'.agent-pipeline','DECISIONS.json');
  if (!existsSync(file)) return {schemaVersion:1,decisions:[]};
  return validateDecisionLedger(decisionLedgerSchema.parse(parseJson(readFileSync(file,'utf8'))));
}
