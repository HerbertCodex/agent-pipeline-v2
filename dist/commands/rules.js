import { detectReference } from '../reuse/detect.js';
import { checkMergeRules, rulesLines } from '../rules/check.js';
import { branchProtection } from '../rules/protection.js';
import { processGh } from '../stack/github.js';
import { gitRoot } from '../run/git-probe.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
export const usage = `Utilisation :
  apv rules check --commit <sha> [--target <branche distante>] [--offline] [--repo <chemin>] [--json]

Règles vérifiées par l'outil avant toute fusion (docs/REGLES.md), les mêmes que celles de apv stack merge et
apv stack batch --merge, qui refusent de fusionner sans elles :
  preuve     la suite complète prouvée au commit exact (apv gates verify), contrôles de la base compris ; pour
             les contrôles que déclare rules.ciProof (lue à la base) sans reçu local propre, le check run du
             job de GitHub Actions au commit exact, conclu en succès, lu par gh api, quand la PR ne change ni
             le workflow ni les fichiers qui produisent la preuve (sinon, preuve locale exigée) ;
  instable   aucun contrôle réussi seulement après relance (retryFailed) : un test instable s'examine
             comme un bug possible du produit, il ne se relance pas jusqu'au vert ;
  relecture  chaque domaine que apv review plan retient pour le diff a sa relecture enregistrée à ce commit
             (apv review record, par l'agent relecteur du domaine), sans constat critique ni haut ;
  captures   quand apv review plan retient fidelite, sa relecture a les captures (par défaut ordinateur et
             téléphone, thème clair et sombre ; section rules.captures) ; sans objet pour un projet sans
             écran à la base qui n'en ajoute pas (outil en ligne de commande) ;
  controles  un projet web déclare, obligatoires, les contrôles reuse, code-map et structure (et ceux de
             rules.requiredGates) ;
  maquette   chaque écran ajouté ou modifié est couvert par une maquette validée par l'opérateur : déjà sur la
             branche cible, ou apportée par la PR avec des mots que l'opérateur a tapés lui-même dans la session.
Tout se lit à la base commune avec la cible : une PR ne change pas ses propres règles.
Aucune option ne lève un refus. Sans correction, seul l'opérateur le peut, en tapant lui-même dans la session
« dérogation <règle> <12 premiers caractères du commit> : <raison> » (journal de l'opérateur, écrit par le
crochet du plugin, que les agents ne peuvent pas écrire), ou pour la relecture d'un seul domaine
« dérogation relecture:<securite|fidelite|donnees|rgpd> <commit> : <raison> » (les autres domaines restent exigés ;
sur securite, la sortie dit « dérogation sur la sécurité »). Sous relecture, chaque domaine retenu est listé :
relecture enregistrée, dérogation (raison) ou manquante.
--target   branche où va le changement (défaut : la branche distante par défaut, origin/HEAD).
--offline  cible non vérifiée contre le dépôt distant (avec un avertissement), comme apv gates verify --offline ;
           la preuve CI n'est pas lue (preuve locale exigée).
Protection de la branche par défaut sur GitHub (gh api) : dite en une ligne, jamais un refus ; indisponible pour un
dépôt privé en plan gratuit, où les garde-fous et apv audit merges en tiennent lieu.
Sortie : 0 règles respectées, 1 au moins un refus, 2 appel incorrect.`;
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, {
            commit: { type: 'string' }, target: { type: 'string' }, offline: { type: 'boolean' }, repo: { type: 'string' },
            json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
        });
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        const [action, ...rest] = positionals;
        if (action !== 'check')
            throw new UsageError(action ? `sous-commande inconnue : rules ${action}` : 'sous-commande manquante (check)');
        if (rest.length)
            throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
        if (!values.commit)
            throw new UsageError('--commit <sha> manquant (la tête de la PR)');
        if (values.target !== undefined && (!values.target.trim() || values.target.startsWith('-')))
            throw new UsageError('--target attend une référence Git (par exemple origin/main)');
        const repo = gitRoot(repoPath(io, values.repo));
        const target = values.target ?? detectReference(repo);
        if (!target)
            throw new UsageError('--target manquant : aucune branche distante par défaut (origin/HEAD, origin/main, origin/master)');
        // The proof by the CI is read with `gh` itself: APV_GH (a test double of the stack commands) never decides a proof.
        const report = await checkMergeRules({ repo, commit: values.commit, target, remote: { strict: true, offline: values.offline === true },
            ci: { gh: values.offline ? null : processGh('gh', io.env, repo) } });
        // Never a refusal: the only barrier outside the machine, said once (docs/REGLES.md).
        const protection = values.offline ? null : await branchProtection(repo, processGh(io.env['APV_GH'] || 'gh', io.env, repo));
        if (values.json)
            json(io, { ...report, protection });
        else
            io.stdout(`${[...rulesLines(report), ...(protection ? [`Protection de branche : ${protection.message}.`] : [])].join('\n')}\n`);
        return report.ok ? EXIT.ok : EXIT.failed;
    });
}
//# sourceMappingURL=rules.js.map