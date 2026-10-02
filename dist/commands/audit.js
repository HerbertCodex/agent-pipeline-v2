import { auditLines, auditMerges } from '../rules/merges.js';
import { detectReference } from '../reuse/detect.js';
import { gitRoot } from '../run/git-probe.js';
import { commonDir } from '../stacks/idle.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
export const usage = `Utilisation :
  apv audit merges [--since <date>] [--target <branche distante>] [--repo <chemin>] [--json]

Parcourt l'historique de la branche par défaut (premier parent, défaut origin/HEAD) et signale chaque commit
qu'aucune fusion de apv stack merge ou apv stack batch --merge n'explique : fusion faite à la main sur GitHub,
poussée directe. Chaque fusion par l'outil écrit une trace signée par la clé d'ancrage (hors du dépôt), liée à la
tête fusionnée et au commit de fusion, dans <répertoire git commun>/apv/merges/. Contrôle a posteriori : il ne bloque
rien, il compense une protection de branche absente (dépôt privé en plan gratuit). Lancé aussi par apv status et par
chaque apv stack merge. --since : date (2026-09-30) ; défaut : la première fusion enregistrée, sinon 30 jours.
Faire git fetch avant, pour auditer la branche telle qu'elle est sur GitHub.
Sortie : 0 aucun commit hors de l'outil, 1 au moins un (ou branche introuvable), 2 appel incorrect.`;
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, { since: { type: 'string' }, target: { type: 'string' }, repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } });
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        const [action, ...rest] = positionals;
        if (action !== 'merges')
            throw new UsageError(action ? `sous-commande inconnue : audit ${action}` : 'sous-commande manquante (merges)');
        if (rest.length)
            throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
        if (values.since !== undefined && Number.isNaN(Date.parse(values.since)))
            throw new UsageError(`--since : date invalide (${values.since})`);
        const repo = gitRoot(repoPath(io, values.repo));
        const ref = values.target ?? detectReference(repo);
        if (!ref)
            throw new UsageError('--target manquant : aucune branche distante par défaut (origin/HEAD, origin/main, origin/master)');
        const audit = auditMerges(repo, commonDir(repo), ref, values.since ? { since: new Date(values.since).toISOString() } : {});
        if (values.json)
            json(io, audit);
        else
            io.stdout(`${auditLines(audit).join('\n')}\n`);
        return audit.head && !audit.unaccounted.length ? EXIT.ok : EXIT.failed;
    });
}
//# sourceMappingURL=audit.js.map