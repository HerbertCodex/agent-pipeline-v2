import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { s } from '../domain/schema.js';
import { invariant } from '../domain/errors.js';
import { hash } from '../domain/hash.js';
import { Git } from '../execution/git.js';
import { decisionSchema, decisionLedgerMarkdown, ledgerHash, loadDecisionLedger, resolveLedgerFile, validateDecisionLedger } from './decisions.js';
/**
 * Operator-authored change to the Decision Ledger after bootstrap. New entries are appended; an entry
 * that replaces or resolves an existing decision must name it in `supersedes`, and the superseded entry
 * leaves the active ledger (it stays in Git history). The CLI cannot authenticate who wrote a quote:
 * like reviewer labels, quotes are an audited operator declaration, not a proof.
 */
export const ledgerUpdateSchema = s.object({
    decisions: s.array(decisionSchema, 1, 50),
});
const markdownFile = (file) => file.replace(/\.json$/, '.md');
export async function planLedgerUpdate(repoPath, input) {
    const git = new Git();
    const repo = await git.root(repoPath);
    const baseSha = await git.sha(repo);
    const update = ledgerUpdateSchema.parse(input);
    const file = await resolveLedgerFile(repo, baseSha);
    const current = await loadDecisionLedger(repo, baseSha, file);
    const working = join(repo, file);
    if (existsSync(working))
        invariant(JSON.stringify(validateDecisionLedger(JSON.parse(readFileSync(working, 'utf8')))) === JSON.stringify(current), 'LEDGER_DIRTY', `${file} has uncommitted changes; commit or discard them first`);
    const existing = new Map(current.decisions.map(d => [d.id, d]));
    const superseded = new Set();
    for (const decision of update.decisions) {
        invariant(!existing.has(decision.id), 'LEDGER_UPDATE', `Decision ${decision.id} already exists; add a new id that supersedes it`);
        for (const old of decision.supersedes) {
            invariant(existing.has(old), 'LEDGER_UPDATE', `Decision ${decision.id} supersedes unknown decision ${old}`);
            superseded.add(old);
        }
        const replaced = decision.supersedes.map(id => existing.get(id));
        if (replaced.some(d => d.source === 'operator' && ['confirmed', 'ambiguous'].includes(d.status)))
            invariant(decision.source === 'operator' && decision.sourceQuote.trim().length > 0, 'LEDGER_UPDATE', `Decision ${decision.id} replaces an operator decision and must be an operator decision with an exact quote`);
    }
    const ledger = validateDecisionLedger({ schemaVersion: 1, decisions: [...current.decisions.filter(d => !superseded.has(d.id)), ...update.decisions] });
    const currentLedgerHash = ledgerHash(current);
    return { repo, file, baseSha, currentLedgerHash, added: update.decisions.map(d => d.id), superseded: [...superseded].sort(), ledger, ledgerHash: ledgerHash(ledger),
        hash: hash({ repo, file, baseSha, currentLedgerHash, update }) };
}
export async function applyLedgerUpdate(repoPath, input, expectedHash, reviewer, note, commit) {
    invariant(note.trim().length >= 10, 'REVIEW', 'Provide a meaningful --note for the ledger change');
    const plan = await planLedgerUpdate(repoPath, input);
    invariant(plan.hash === expectedHash, 'LEDGER_HASH', 'Ledger update changed since it was reviewed; plan it again and review the new hash');
    const git = new Git();
    const [json, md] = [plan.file, markdownFile(plan.file)];
    const dirty = await git.exec(plan.repo, ['status', '--porcelain=v1', '--', json, md]);
    invariant(dirty.trim() === '', 'LEDGER_DIRTY', 'Decision ledger files have uncommitted changes');
    mkdirSync(join(plan.repo, dirname(json)), { recursive: true });
    writeFileSync(join(plan.repo, json), JSON.stringify(plan.ledger, null, 2) + '\n');
    writeFileSync(join(plan.repo, md), decisionLedgerMarkdown(plan.ledger));
    let commitSha = null;
    if (commit) {
        await git.exec(plan.repo, ['add', '--', json, md]);
        const body = [`Added: ${plan.added.join(', ')}`, `Superseded: ${plan.superseded.join(', ') || 'none'}`, `Reviewer: ${reviewer}`, `Note: ${note.replace(/\s+/g, ' ').trim()}`].join('\n');
        // Pathspec: the operator may have unrelated work staged, and a ledger commit must carry the ledger only.
        await git.exec(plan.repo, ['commit', '--no-verify', '-m', 'chore(decisions): update decision ledger', '-m', body, '--', json, md]);
        commitSha = await git.sha(plan.repo);
    }
    return { ...plan, commitSha };
}
//# sourceMappingURL=ledger-update.js.map