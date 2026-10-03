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
    // A refusal of the seal hook (a review it could not seal) is said always, under its own label.
    const sealRefusal = j.refused && /^relecture\b/.test(j.refused.reason) ? j.refused : null;
    if (sealRefusal)
        lines.push(`  ATTENTION : le crochet du sceau n'a pas scellé une relecture (${sealRefusal.at.slice(0, 16).replace('T', ' ')}) : ${sealRefusal.reason}.`);
    if (!j.messages) {
        lines.push(j.refused && !sealRefusal
            ? `  Le crochet a refusé le dernier message (${j.refused.at.slice(0, 16).replace('T', ' ')}) : ${j.refused.reason}. Seuls comptent les messages tapés dans la session de l'opérateur : champ source user ou tty, ou, sans ce champ, une session Claude Code de premier niveau, pas en mode -p. Un message refusé n'entre pas au journal : une dérogation ou une validation se tape dans la session principale.`
            : '  Rien reçu encore : le plugin est-il activé dans cette session (/plugin) ? Le journal se remplit quand l\'opérateur écrit dans la session.');
    }
    if (j.keyProblem && j.keyCreatedAt)
        lines.push(`  ATTENTION : ${j.keyProblem}.`);
    else if (!j.key)
        lines.push('  Clé d\'ancrage pas encore créée (~/.apv-ancrage/cle-ancrage) : elle se crée au premier message de l\'opérateur.');
    if (j.key && j.keyCreatedAt && Date.now() - Date.parse(j.keyCreatedAt) < 7 * 86_400_000) {
        lines.push(`  Clé d'ancrage créée le ${j.keyCreatedAt.slice(0, 10)} : l'opérateur la sauvegarde hors de cette machine (~/.apv-ancrage/cle-ancrage). Perdue ou remplacée, elle ne se recrée pas en silence et plus rien de signé n'est accepté ; seule la sauvegarde la rétablit.`);
    }
    return lines;
}
export function anchorLines(a) {
    return [...journalLines(a.journal), `Protection de branche : ${a.protection.message}.`, ...(a.audit ? auditLines(a.audit) : ['Audit des fusions : aucune branche distante par défaut (origin/HEAD, origin/main).'])];
}
//# sourceMappingURL=anchor-status.js.map