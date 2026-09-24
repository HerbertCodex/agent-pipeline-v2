# Livraison : contrôles, PR brouillon empilées, fusion de la pile

Dans ce document, `apv` désigne l'outil du plugin (voir `SKILL.md`).

## 1. Contrôles du chef de projet (avant chaque PR)
Sur la tête exacte de la branche, dans un worktree propre :
1. `apv gates run` : tous les contrôles déclarés (ou la liste de la consigne commune), ressources partagées sous bail.
2. `apv db check` si des migrations ou des requêtes ont changé.
3. `apv scope check` sur les tâches de la spec.
4. `apv design check` si le projet a des maquettes validées : une référence modifiée sans nouvelle validation de l'opérateur bloque la PR.
5. Relecture du diff complet contre la spec : critères couverts, écarts assumés listés.
Tu notes les nombres de tests : ils vont dans la PR. Un contrôle rouge bloque la PR.

## 2. PR brouillon
- `git push -u origin <branche>` puis `gh pr create --draft --base <base> --head <branche> --title … --body …`, **sans masquer la sortie**. Lis-la, puis vérifie : `gh pr view <n> --json number,baseRefName,headRefName,isDraft,url`.
- Corps de la PR : résumé, critères couverts, preuves (contrôles et nombres de tests, revues, ZAP), écarts assumés à valider, points qui demandent l'opérateur, base de la pile.
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
