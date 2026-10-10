import { PipelineError, errorMessage } from '../domain/errors.js';
import { gitRead } from '../run/git-probe.js';
import { checkMergeRules, rulesLines } from '../rules/check.js';
import { processGit } from '../stack/batch.js';
import { processGh } from '../stack/github.js';
import { mergeOnOrder } from '../orders/merge.js';
import { UUID } from '../orders/order.js';
import { EXIT, UsageError, json } from './common.js';
/** Options of `apv stack merge` that a merge on order never takes: its method, target and checks are fixed. */
const FOREIGN = ['method', 'target', 'ready', 'allow-behind', 'reason', 'keep-branches', 'wait-ci'];
export const ORDER_USAGE = `--order <référence>  (merge) fusion sur ordre signé de l'opérateur, sans session de l'opérateur : exactement deux PR,
       la PR de publication puis la PR d'article qui porte l'ordre. Lit rules.operatorOrders à la base de confiance (la cible avant
       toute fusion sur cet ordre, fixée pour tout le lancement) : ordre authentifié
       par une clé déclarée, non échu, lié à la décision signée de plus grand numéro, non consommé (pied Apv-Order de
       l'histoire de la cible) ; tête de publication descendante de la cible ; commande de vérification du projet lancée
       depuis une copie propre de la base de confiance ; règles de apv rules check à la tête fusionnée ; attestation fraîche de la
       production liée à un défi tiré par APV ; commit de fusion de parents (cible, tête) avec le pied Apv-Order, poussé
       sans force dans les maxAgeSeconds de l'attestation. Une étape à la fois, publication puis article ; déjà faites :
       already_done (sortie 0). Jamais l'API de fusion de GitHub, jamais de poussée forcée. Refus : code et raison.`;
/** Lines of the report of a merge on order. */
export function orderLines(report, nonce) {
    const lines = [`Fusion sur ordre ${nonce}${report.target ? ` vers ${report.target}` : ''} :`];
    for (const step of report.consumed)
        lines.push(`- étape ${step} : déjà faite (pied Apv-Order présent)`);
    for (const m of report.merged)
        lines.push(`- étape ${m.step} : PR #${m.pr} fusionnée à ${m.head.slice(0, 12)}, commit ${m.mergeCommit.slice(0, 12)} (parents ${m.base.slice(0, 12)}, ${m.head.slice(0, 12)})`);
    lines.push(`Attestations demandées : ${report.attestations}.`, ...report.traceErrors.map(e => `ATTENTION : ${e}`));
    if (report.status === 'already_done')
        lines.push('Ordre déjà exécuté : rien à faire (already_done).');
    else if (report.status === 'merged')
        lines.push('Ordre exécuté : les deux étapes sont fusionnées.');
    else
        lines.push(`Refus : ${report.code}${report.projectCode ? ` (${report.projectCode})` : ''} : ${report.reason}`, 'Rien d\'autre n\'est poussé.');
    return lines;
}
/** `APV_ALLOW_MERGE=1 apv stack merge <publication> <article> --order <nonce>`. */
export async function stackMergeOnOrder(prs, values, io, transcript, traceMerge) {
    const nonce = values.order ?? '';
    const foreign = FOREIGN.filter(k => values[k] !== undefined && values[k] !== false);
    if (foreign.length)
        throw new UsageError(`--${foreign.join(', --')} : sans objet avec --order (méthode, cible et contrôles fixés par l'ordre)`);
    if (!UUID.test(nonce))
        throw new UsageError('--order attend la référence de l\'ordre (UUID en minuscules)');
    if (prs.length !== 2)
        throw new UsageError('--order attend exactement deux PR : la PR de publication, puis la PR d\'article qui porte l\'ordre');
    const repo = gitRead(io.cwd, ['rev-parse', '--show-toplevel']);
    if (!repo)
        throw new PipelineError('NOT_A_REPOSITORY', `Pas un dépôt Git : ${io.cwd}`);
    const bin = io.env['APV_GH'] || 'gh';
    const calls = [];
    const report = await mergeOnOrder({
        repo, remote: 'origin', publicationPr: prs[0], articlePr: prs[1], nonce,
        gh: processGh(bin, io.env, repo), git: processGit(io.env), env: io.env,
        log: line => io.stderr(`${line}\n`),
        onCall: call => { calls.push(call); (values.json ? io.stderr : io.stdout)(transcript(bin, call)); },
        onMerged: merge => traceMerge(repo, merge),
        // The rules at the exact commit of the target APV read and merges on: never a remote-tracking ref left stale.
        rules: async (head, base) => {
            try {
                const r = await checkMergeRules({ repo, commit: head, target: base });
                return r.ok ? [] : rulesLines(r, '  ').slice(1, -1);
            }
            catch (error) {
                return [`règles avant fusion non vérifiables à ${head.slice(0, 12)} : ${errorMessage(error)}`];
            }
        },
    });
    if (values.json)
        json(io, { ...report, nonce, calls });
    else
        io.stdout(`${orderLines(report, nonce).join('\n')}\n`);
    return report.status === 'refused' ? EXIT.failed : EXIT.ok;
}
//# sourceMappingURL=stack-order.js.map