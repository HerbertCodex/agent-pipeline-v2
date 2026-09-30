import { detectReference } from '../reuse/detect.js';
import { gitRead } from '../run/git-probe.js';
import { commonDir } from '../stacks/idle.js';
import { auditLines, auditMerges } from './merges.js';
import { journalState } from './operator.js';
import { branchProtection } from './protection.js';
export async function anchorStatus(repo, gh) {
    if (!gitRead(repo, ['rev-parse', '--git-dir']))
        return null;
    const common = commonDir(repo);
    const reference = detectReference(repo);
    return { journal: journalState(common), protection: await branchProtection(repo, gh), audit: reference ? auditMerges(repo, common, reference) : null };
}
/** The journal in one or two lines: messages kept, or why none (Claude Code without the source field, no key). */
export function journalLines(j) {
    const kept = j.messages ? `${j.messages} message(s) de l'opérateur signé(s), dernier le ${j.last.slice(0, 16).replace('T', ' ')}` : 'aucun message de l\'opérateur reçu';
    const lines = [`Journal de l'opérateur : ${kept}${j.ignored ? ` ; ${j.ignored} ligne(s) non signée(s) ou altérée(s), ignorée(s)` : ''}.`];
    if (!j.messages) {
        lines.push(j.refused
            ? `  Le crochet a refusé le dernier message (${j.refused.at.slice(0, 16).replace('T', ' ')}) : ${j.refused.reason}. Mets Claude Code à jour (claude update) : il doit transmettre au crochet UserPromptSubmit le champ source (user ou tty). Sans lui, seules comptent les maquettes déjà fusionnées, et aucune dérogation n'est possible.`
            : '  Rien reçu encore : le plugin est-il activé dans cette session (/plugin) ? Le journal se remplit quand l\'opérateur écrit dans la session.');
    }
    if (!j.key)
        lines.push('  Clé d\'ancrage absente (~/.config/apv/anchor.key) : elle se crée au premier message de l\'opérateur.');
    return lines;
}
export function anchorLines(a) {
    return [...journalLines(a.journal), `Protection de branche : ${a.protection.message}.`, ...(a.audit ? auditLines(a.audit) : ['Audit des fusions : aucune branche distante par défaut (origin/HEAD, origin/main).'])];
}
//# sourceMappingURL=anchor-status.js.map