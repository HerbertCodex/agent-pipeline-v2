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

## 4. Fusion de la pile (seulement sur ordre explicite de l'opérateur)
La commande `/apv:stack` automatise cette procédure : `apv stack plan <pr...>` vérifie la pile et se montre en entier, puis `APV_ALLOW_MERGE=1 apv stack merge <pr...>` revérifie chaque PR juste avant de la fusionner, re-cible la suivante, contrôle le résultat par une relecture et s'arrête à la première anomalie. Le hook du plugin bloque `gh pr merge` et `apv stack merge` sans `APV_ALLOW_MERGE=1` : cette variable se pose devant la seule commande de fusion, uniquement sur l'ordre explicite de l'opérateur dans son message courant.

Procédure manuelle, si l'outil n'est pas disponible : une PR à la fois, arrêt à la première anomalie.

Avant la fusion : si le corps d'une PR contient une affirmation qui n'est pas `prouve`, montre-la à l'opérateur avec le plan ; son ordre de fusion vaut alors en connaissance de cause.

Pour chaque PR, de la base vers le sommet :
1. `gh pr view <n> --json number,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus` : état attendu (ouverte, contrôles verts, fusionnable).
2. Si la PR précédente vient d'être fusionnée, re-cible par l'API REST : `gh api -X PATCH repos/<propriétaire>/<dépôt>/pulls/<n> -f base=<cible>` **sans masquer la sortie** (propriétaire et dépôt : `gh pr view <n> --json url`). N'emploie pas `gh pr edit --base` : sa requête GraphQL lit aussi les projets classiques de la PR et échoue depuis leur abandon (« Projects (classic) is being deprecated »).
3. **Vérifie la base juste avant de fusionner** : `gh pr view <n> --json baseRefName` doit renvoyer la cible attendue. Sinon, arrêt.
4. Retire le statut brouillon si l'opérateur l'a demandé (`gh pr ready <n>`).
5. `APV_ALLOW_MERGE=1 gh pr merge <n> --merge` (ou la méthode que l'opérateur a fixée), sortie lue.
6. Vérifie : `gh pr view <n> --json state,mergeCommit,baseRefName` (état `MERGED`, bonne base), puis `git fetch` et contrôle que la cible contient le commit de tête attendu.
7. À la moindre anomalie (échec d'une commande, base inattendue, contrôles rouges, conflit) : arrêt, rien d'autre n'est fusionné, rapport à l'opérateur avec l'état exact.

Incident 30 : un script qui masquait la sortie a laissé échouer en silence les re-ciblages, et chaque PR a été fusionnée dans la branche de la précédente au lieu de `main`. Rattrapage : une PR supplémentaire, vérifiée identique au code testé. D'où les étapes 2, 3 et 6.

## 5. Déploiement
Jamais sans ordre explicite. Le hook bloque `vercel --prod`, `vercel promote` et `vercel rollback` sans `APV_ALLOW_DEPLOY=1`. Un aperçu (preview) reste autorisé.
