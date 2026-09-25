# Livraison : contrôles, PR brouillon empilées, fusion de la pile

Dans ce document, `apv` désigne l'outil du plugin (voir `SKILL.md`).

## 1. Contrôles du chef de projet (avant chaque PR)
Sur la tête exacte de la branche :
1. La suite complète prouvée sur ce commit exact. D'abord `apv gates verify --commit <tête>`, depuis n'importe quel checkout du dépôt (il lit les reçus du worktree, puis le magasin partagé du dépôt, `<répertoire git commun>/apv/receipts/`, où `apv gates run` copie chaque exécution) : à `0`, elle est déjà prouvée (spec sans corrections, la tête n'a pas bougé), ne la relance pas. Sinon, dans un worktree propre, créé dans ton dossier de session (`git worktree add --detach <dossier de session>/<id>-livraison-<sha court> <branche>`, jamais à côté du dépôt, retiré par `git worktree remove` après la PR) : `apv gates run --stage full` (tous les contrôles déclarés, ou la liste de la consigne commune, ressources partagées sous bail ; `--skip-proven` ne relance rien si la preuve existe déjà), puis `apv gates verify --commit <tête>`, qui doit sortir en `0` (chaque contrôle réussi sur ce commit exact, arbre propre) avant de pousser. Une vérification du niveau tâche (`--stage task`) ne suffit jamais pour une PR.
2. `apv db check` si des migrations ou des requêtes ont changé.
3. `apv scope check` sur les tâches de la spec.
4. `apv design check` si le projet a des maquettes validées : une référence modifiée sans nouvelle validation de l'opérateur bloque la PR.
5. Relecture du diff complet contre la spec : critères couverts, écarts assumés listés.
Tu notes les nombres de tests et l'identifiant d'exécution de la suite complète (ligne « copie partagée : … (exécution <identifiant>) » de `apv gates run`, ou colonne « reçu » de `apv gates verify`) : ils vont dans la PR. Les reçus survivent au retrait de la copie de livraison ; un checkout qui déclare d'autres contrôles que la tête vérifie avec `--commit-config`. Un contrôle rouge bloque la PR et ouvre une passe de corrections, jamais ignorée.

## 2. PR brouillon
- `git push -u origin <branche>` puis `gh pr create --draft --base <base> --head <branche> --title … --body …`, **sans masquer la sortie**. Lis-la, puis vérifie : `gh pr view <n> --json number,baseRefName,headRefName,isDraft,url`.
- Corps de la PR : résumé, critères couverts, preuves (contrôles et nombres de tests, identifiant d'exécution de la suite complète et commit exact : le chef de projet principal le revérifie depuis n'importe quel checkout du dépôt par `apv gates verify --commit <tête>`, sans rien relancer ; revues, scan dynamique : statut de `apv dast run` ou « non vérifié » et pourquoi), écarts assumés à valider, points qui demandent l'opérateur, base de la pile. Chaque affirmation importante porte son niveau de confiance (`references/confiance.md`) ; une affirmation `probable` non vérifiée ou `suppose` (une cause de production non reproduite, par exemple) figure dans les points qui demandent l'opérateur, jamais comme « corrigé ».
- Mets à jour l'aperçu vivant sur la branche livrée avec `/apv:preview` et annonce-le (adresse, branche, ce qui a changé, compte de démo).

## 3. Pile de PR
Quand une spec dépend de la précédente non fusionnée :
- la branche de la spec N part de la tête de la spec N-1 ;
- la PR N vise la branche de la PR N-1 (`--base spec/<n-1>-…`) ;
- une correction faite plus bas dans la pile est reportée vers le haut par fusion (jamais par réécriture) ;
- l'opérateur fusionne tout à la fin, dans l'ordre, ou te l'ordonne explicitement.

PR **parallèles** (préparées côte à côte sur la même base, par deux exécutions simultanées par exemple) : ce n'est pas une pile. Chacune a été vérifiée contre la base de son départ, jamais contre la base qui contient l'autre. Incident du 25 septembre 2026 (projet pilote) : une PR ajoutait un test qui importait un module, une autre déplaçait ce module ; au vert chacune seule, fusionnées l'une après l'autre, elles ont rendu `main` rouge. D'où la règle de la base à jour (section 4).

## 4. Fusion de la pile (seulement sur ordre explicite de l'opérateur)
La commande `/apv:stack` automatise cette procédure : `apv stack plan <pr...>` vérifie la pile et se montre en entier, puis `APV_ALLOW_MERGE=1 apv stack merge <pr...>` revérifie chaque PR juste avant de la fusionner, re-cible la suivante, contrôle le résultat par une relecture et s'arrête à la première anomalie.

**Base à jour.** Une PR n'est fusionnée que si sa tête contient la tête actuelle de sa base (la PR précédente de la pile, ou la cible après re-ciblage), vérifié juste avant sa fusion, après celle de la précédente ; seuls des commits de fusion sans changement de fichier sont tolérés (pile fusionnée par `--method merge`). Sinon l'outil la refuse avec la marche à suivre.

**Ordre de fusion de PR parallèles** : une commande par PR, l'une après l'autre ; d'abord celle dont les autres dépendent, sinon la première prête. Avant la fusion de chaque suivante, mets-la à jour :
1. dans un worktree propre de sa branche : `git fetch origin`, `git merge origin/<base>` (une fusion, jamais de rebase ni de force-push ; conflit : arrêt et rapport) ;
2. au moins les contrôles de tâche sur la nouvelle tête : `apv gates run --stage task --base origin/<base>`, puis `apv gates verify --commit <nouvelle tête> --stage task --base origin/<base>` à `0` (la suite complète si la mise à jour touche ce que ces contrôles ne couvrent pas) ; une configuration sans contrôle de tâche s'en remet aux contrôles GitHub ;
3. `git push` sans force, contrôles GitHub au vert sur la nouvelle tête ;
4. `apv stack plan <n>` : la PR doit être `à jour`, puis `APV_ALLOW_MERGE=1 apv stack merge <n>` sur l'ordre de l'opérateur.
Même mise à jour pour la PR suivante d'une pile fusionnée par `--method squash` ou `rebase` : la fusion de la précédente crée sur la cible des commits neufs, et l'outil s'arrête sur elle.

Dérogation exceptionnelle : `--allow-behind --reason "<raison>"`, seulement sur ordre explicite de l'opérateur qui connaît le risque, dans une commande qui ne vise que cette PR ; l'outil la journalise avant la fusion (`.apv/state/stack.log`), et tu la notes au journal du pipeline. Le hook du plugin bloque `gh pr merge` et `apv stack merge` sans `APV_ALLOW_MERGE=1` : cette variable se pose devant la seule commande de fusion, uniquement sur l'ordre explicite de l'opérateur dans son message courant.

Procédure manuelle, si l'outil n'est pas disponible : une PR à la fois, arrêt à la première anomalie.

Avant la fusion : si le corps d'une PR contient une affirmation qui n'est pas `prouve`, montre-la à l'opérateur avec le plan ; son ordre de fusion vaut alors en connaissance de cause.

Pour chaque PR, de la base vers le sommet :
1. `gh pr view <n> --json number,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus` : état attendu (ouverte, contrôles verts, fusionnable). Puis la base à jour (après le re-ciblage de l'étape 2 pour une PR suivante) : `git fetch origin`, puis `git merge-base --is-ancestor origin/<base> <tête>` doit réussir ; à défaut (PR suivante d'une pile, où seul manque le commit de fusion de la précédente), `git merge-tree --write-tree origin/<base> <tête>` doit rendre exactement l'arbre de la tête (`git rev-parse <tête>^{tree}`). Sinon, mise à jour comme ci-dessus avant d'aller plus loin.
2. Si la PR précédente vient d'être fusionnée, re-cible par l'API REST : `gh api -X PATCH repos/<propriétaire>/<dépôt>/pulls/<n> -f base=<cible>` **sans masquer la sortie** (propriétaire et dépôt : `gh pr view <n> --json url`). N'emploie pas `gh pr edit --base` : sa requête GraphQL lit aussi les projets classiques de la PR et échoue depuis leur abandon (« Projects (classic) is being deprecated »).
3. **Vérifie la base juste avant de fusionner** : `gh pr view <n> --json baseRefName` doit renvoyer la cible attendue. Sinon, arrêt.
4. Retire le statut brouillon si l'opérateur l'a demandé (`gh pr ready <n>`).
5. `APV_ALLOW_MERGE=1 gh pr merge <n> --merge` (ou la méthode que l'opérateur a fixée), sortie lue.
6. Vérifie : `gh pr view <n> --json state,mergeCommit,baseRefName` (état `MERGED`, bonne base), puis `git fetch` et contrôle que la cible contient le commit de tête attendu.
7. À la moindre anomalie (échec d'une commande, base inattendue, contrôles rouges, conflit) : arrêt, rien d'autre n'est fusionné, rapport à l'opérateur avec l'état exact.

Incident 30 : un script qui masquait la sortie a laissé échouer en silence les re-ciblages, et chaque PR a été fusionnée dans la branche de la précédente au lieu de `main`. Rattrapage : une PR supplémentaire, vérifiée identique au code testé. D'où les étapes 2, 3 et 6.

## 5. Déploiement
Jamais sans ordre explicite. Le hook bloque `vercel --prod`, `vercel promote` et `vercel rollback` sans `APV_ALLOW_DEPLOY=1`. Un aperçu (preview) reste autorisé.
