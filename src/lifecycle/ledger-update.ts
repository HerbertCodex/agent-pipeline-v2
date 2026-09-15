import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { s, type Infer } from '../domain/schema.js';
import { invariant } from '../domain/errors.js';
import { hash } from '../domain/hash.js';
import { Git } from '../execution/git.js';
import { decisionSchema, decisionLedgerMarkdown, ledgerHash, loadDecisionLedger, validateDecisionLedger, type Decision, type DecisionLedger } from './decisions.js';

/**
 * Operator-authored change to the Decision Ledger after bootstrap. New entries are appended; an entry
 * that replaces or resolves an existing decision must name it in `supersedes`, and the superseded entry
 * leaves the active ledger (it stays in Git history). The CLI cannot authenticate who wrote a quote:
 * like reviewer labels, quotes are an audited operator declaration, not a proof.
 */
export const ledgerUpdateSchema = s.object({
  decisions: s.array(decisionSchema, 1, 50),
});
export type LedgerUpdate = Infer<typeof ledgerUpdateSchema>;

export interface LedgerUpdatePlan {
  repo: string;
  baseSha: string;
  currentLedgerHash: string;
  added: string[];
  superseded: string[];
  ledger: DecisionLedger;
  ledgerHash: string;
  hash: string;
}

const LEDGER_JSON = '.agent-pipeline/DECISIONS.json';
const LEDGER_MD = '.agent-pipeline/DECISIONS.md';

export async function planLedgerUpdate(repoPath: string, input: unknown): Promise<LedgerUpdatePlan> {
  const git = new Git();
  const repo = await git.root(repoPath);
  const baseSha = await git.sha(repo);
  const update = ledgerUpdateSchema.parse(input);
  const current = await loadDecisionLedger(repo, baseSha);
  const working = join(repo, LEDGER_JSON);
  if (existsSync(working)) invariant(JSON.stringify(validateDecisionLedger(JSON.parse(readFileSync(working, 'utf8')))) === JSON.stringify(current), 'LEDGER_DIRTY', `${LEDGER_JSON} has uncommitted changes; commit or discard them first`);
  const existing = new Map(current.decisions.map(d => [d.id, d]));
  const superseded = new Set<string>();
  for (const decision of update.decisions) {
    invariant(!existing.has(decision.id), 'LEDGER_UPDATE', `Decision ${decision.id} already exists; add a new id that supersedes it`);
    for (const old of decision.supersedes) {
      invariant(existing.has(old), 'LEDGER_UPDATE', `Decision ${decision.id} supersedes unknown decision ${old}`);
      superseded.add(old);
    }
    const replaced = decision.supersedes.map(id => existing.get(id)!);
    if (replaced.some(d => d.source === 'operator' && ['confirmed', 'ambiguous'].includes(d.status)))
      invariant(decision.source === 'operator' && decision.sourceQuote.trim().length > 0, 'LEDGER_UPDATE', `Decision ${decision.id} replaces an operator decision and must be an operator decision with an exact quote`);
  }
  const ledger = validateDecisionLedger({ schemaVersion: 1, decisions: [...current.decisions.filter(d => !superseded.has(d.id)), ...update.decisions] as Decision[] });
  const currentLedgerHash = ledgerHash(current);
  return { repo, baseSha, currentLedgerHash, added: update.decisions.map(d => d.id), superseded: [...superseded].sort(), ledger, ledgerHash: ledgerHash(ledger),
    hash: hash({ repo, baseSha, currentLedgerHash, update }) };
}

export async function applyLedgerUpdate(repoPath: string, input: unknown, expectedHash: string, reviewer: string, note: string, commit: boolean): Promise<LedgerUpdatePlan & { commitSha: string | null }> {
  invariant(note.trim().length >= 10, 'REVIEW', 'Provide a meaningful --note for the ledger change');
  const plan = await planLedgerUpdate(repoPath, input);
  invariant(plan.hash === expectedHash, 'LEDGER_HASH', 'Ledger update changed since it was reviewed; plan it again and review the new hash');
  const git = new Git();
  const dirty = await git.exec(plan.repo, ['status', '--porcelain=v1', '--', LEDGER_JSON, LEDGER_MD]);
  invariant(dirty.trim() === '', 'LEDGER_DIRTY', 'Decision ledger files have uncommitted changes');
  mkdirSync(join(plan.repo, '.agent-pipeline'), { recursive: true });
  writeFileSync(join(plan.repo, LEDGER_JSON), JSON.stringify(plan.ledger, null, 2) + '\n');
  writeFileSync(join(plan.repo, LEDGER_MD), decisionLedgerMarkdown(plan.ledger));
  let commitSha: string | null = null;
  if (commit) {
    await git.exec(plan.repo, ['add', '--', LEDGER_JSON, LEDGER_MD]);
    const body = [`Added: ${plan.added.join(', ')}`, `Superseded: ${plan.superseded.join(', ') || 'none'}`, `Reviewer: ${reviewer}`, `Note: ${note.replace(/\s+/g, ' ').trim()}`].join('\n');
    await git.exec(plan.repo, ['commit', '--no-verify', '-m', 'chore(decisions): update decision ledger', '-m', body]);
    commitSha = await git.sha(plan.repo);
  }
  return { ...plan, commitSha };
}
