# Une seule suite par PR, mise en ligne sans suite redoublée (4.0.0-alpha.5)

Origine : projet pilote Toujours rien, 20 octobre 2026, décision de l'opérateur (« Oui, telle quelle »), vers 18 h 30. Capacité
générique d'APV, pas un correctif propre au projet.

## Constat

Depuis 4.0.0-alpha.3 (`apv release auto` dans un cron), `main` fusionne sur la preuve de tâche et la suite complète tourne à la
mise en ligne. Le 20 octobre, quatre passes ont échoué : deux vrais défauts, et quatre tests anciens instables sans rapport avec le
changement, révélés par la répétition 5 fois de tous les tests modifiés depuis la production (9 PR en attente). La production est
restée au même commit toute la journée. Le chef de projet a ajouté une suite complète sur chaque branche, mais la mise en ligne ne
la reprenait jamais : autre pile (`E2E_STACK`, URL de `envFile` dans l'identité), autre copie (worktree de travail contre copie
neuve préparée par `batch.setup`). Résultat : 2 × 40 min par PR.

## 1. Une suite complète par PR, sur la branche, comme la mise en ligne

### 1.1 `apv gates run --stage full --fresh-copy`

La suite complète de HEAD tourne dans une **copie neuve** : un worktree détaché du commit sous `<répertoire git commun>/apv/fresh/<arbre>`,
préparé par `batch.setup`, retiré à la fin. C'est la copie de `apv release auto`, **au même chemin pour le même arbre** : même état
local ignoré par Git (dépendances installées par la même préparation, fichiers générés, chemins absolus écrits par les outils),
donc même identité de reprise. Répétition des tests modifiés comprise (depuis `--base` et `repeatChanged.reference`).

- Les reçus restent dans le magasin partagé : `apv gates verify --commit <tête>` les trouve depuis le worktree de travail.
- Pile : celle que prendrait la mise en ligne, la première déclarée au verrou libre, sauf `--stacks` ; toutes tenues : la première,
  la suite attend son verrou.
- Une seule copie d'un arbre à la fois (bail `fresh-<arbre>`) : une seconde est refusée, rien n'est lancé.
- Refusé : `--stage task`, `--allow-dirty`, `--since`, un arbre modifié (comme toute suite complète).

### 1.2 Pile normalisée : `stacks[].normalizeEnv`

Avec `stacks[].fingerprint`, l'identité de reprise ne normalisait que les ports déclarés dans `stacks[].ports` et le fichier de
verrou. `normalizeEnv` nomme en plus les variables de la pile qui ne disent **que où** elle est (`E2E_STACK`, les URL de son
`envFile`) : leur valeur entière est remplacée par `{{<nom> de la pile}}` dans l'identité. Deux piles qui impriment la même
empreinte et ne diffèrent que par ces variables sont donc comparables : une branche vérifiée sur la pile 2 est reprise par la mise
en ligne sur la pile 1 (AC-6).

- Seulement avec `fingerprint` (sinon refus du chargeur) : l'empreinte dit ce qui tourne sur la pile, `normalizeEnv` dit seulement
  où. Une variable qui change la manière dont les contrôles tournent (`PATH`, `HOME`, `LANG`, `TZ`, `NODE_OPTIONS`, `NODE_ENV`,
  `CI`…) est refusée.
- Seules les variables de la pile sont concernées (`env`, `envFile`, `fileEnv` du verrou) ; la liste normalisée entre elle-même dans
  l'identité.
- Limite assumée : une variable déclarée qui change en vrai le résultat (une URL qui pointe vers une autre base que celle de
  l'empreinte) rendrait une reprise fausse. C'est la déclaration de l'opérateur, relue comme le reste de la configuration.

## 2. La mise en ligne ne refait pas la suite quand c'est inutile

### 2.1 Reprise à arbre identique

`apv release auto` ne relance plus tout (`--replay all` retiré). Dans la copie neuve de l'arbre de la tête de `main`, chaque contrôle
dont un reçu vert d'un arbre identique se vérifie (règles de la reprise A1 : premier passage, arbre propre, même configuration,
même environnement normalisé, moins de 20 h, aucun échec plus récent au même arbre) reçoit un reçu « réutilisé ». Une PR seule,
vérifiée sur sa branche et fusionnée sans autre commit, est publiée en quelques minutes (le temps de `batch.setup`), sans suite
(AC-1). Le journal (`stack.log`, champ `reused`) et la sortie disent quel reçu a été repris.

Une preuve verte à la tête ne suffit toujours pas seule : la décision passe par la copie neuve, qui ne reprend que ce qui a tourné
dans **son** environnement.

### 2.2 Crédit de répétition

Plusieurs PR fusionnées depuis la dernière branche vérifiée : une seule suite, sans répétition des tests modifiés déjà répétés sur
leur branche (AC-2). Un fichier de test changé depuis la production est **crédité** quand un reçu complet du même contrôle :

- est réussi au premier passage, de stage full, ni ciblé ni tôt, sur un arbre propre ;
- l'a répété, vert, au moins autant de fois que demandé, avec la même commande de répétition, les mêmes arguments de charge et le
  même motif (lus dans la configuration de son commit) ;
- l'avait au **même contenu** (même blob, même mode) ;

et qu'**aucun** reçu du contrôle, de quelque stage, n'a échoué à le répéter au même contenu : une instabilité vue une fois n'est
jamais effacée par un passage vert. Un fichier sans crédit est répété comme avant (une PR fusionnée sans suite de branche, par
exemple). Le crédit vaut à la mise en ligne seulement (`apv release`, `apv release auto`) ; sur une branche, `apv gates verify`
exige toujours la répétition de chaque test modifié. Les crédits ne sont jamais lus dans le reçu : la mise en ligne les retrouve
dans le magasin et dans Git (`src/gates/repeat-credit.ts`).

### 2.3 Ce qui diffère, dit

Chaque reçu exécuté porte `identityParts`, une empreinte par partie de son identité (chaque variable par son nom, exécutable, état
installé, fichiers ignorés de la copie, système, pile). Quand aucune origine du même arbre n'est dans le même environnement, la
sortie nomme ce qui diffère (« différent de <exécution> : variable(s) PATH, LANG ; fichiers ignorés par Git de la copie »). Le cas
attendu : un cron dont `PATH` ou `LANG` n'est pas celui de la session qui a lancé la suite de branche. Les parties ne décident rien :
seule `reuseIdentity` compte. Ce sont des empreintes, jamais des valeurs (une valeur très courte reste devinable par essai : les reçus
restent dans le répertoire Git du dépôt).

## 3. Un test instable sans rapport ne bloque plus la production

Un contrôle réussi seulement après la relance de ses tests en échec (`passed_after_retry`) à la mise en ligne : chaque test relancé
est jugé. Il est **sans rapport** quand :

- son nom donne son fichier (un chemin du commit, ou le seul fichier dont il est la fin : `a.spec.ts:12:5 › …`) ;
- ce fichier n'est ni ajouté ni modifié depuis la production ;
- il n'est pas dans la liste des tests concernés par le changement : la commande `affectedList` du contrôle, **lue à la
  production**, lancée dans la copie neuve avec `{{baseSha}}` = la production (même calcul que `affected`, par exemple
  `["npx", "playwright", "test", "--list", "--only-changed", "{{baseSha}}"]`) ; tout chemin du commit dans sa sortie compte.

Alors la mise en ligne continue, et le test est écrit comme **constat** : sortie, journal (`stack.log`, champ `unstable` : contrôle,
test, fichiers, « échoue 1 fois sur 2 passages », exécution) et suivi (`.apv/state/suivi-constats.md`, section « Tests instables à
la mise en ligne »), pour une correction à part (AC-3).

Restent bloquants : un test ajouté ou modifié, ou concerné par le changement (AC-4) ; un nom sans fichier, un contrôle sans
`affectedList` à la production (une PR ne s'en sert jamais pour elle-même), une liste en échec ; tout échec que la relance n'a pas
guéri ; toute répétition en échec ; toute migration non confirmée (`release.migrations`, AC-5) ; une preuve instable et incomplète
(jamais relancée au même commit).

Limite : `retryFailed.testPattern` doit nommer **chaque** test en échec de la première passe ; un test qu'il ne nomme pas n'est pas
jugé. Relire le motif avec le format du rapporteur (Playwright `list` ou `line`).

## 4. Ce qui ne change pas

Jamais de publication sans suite verte au même arbre (exécutée ou reprise et vérifiée) ; reçus vérifiés depuis Git et le magasin
partagé ; contrôles de la production gardés ; confirmation des migrations par l'opérateur ; fusion et mise en ligne sur ordre
(`APV_ALLOW_MERGE=1`) ; une suite rouge n'est jamais relancée au même commit.

## Critères d'acceptation et tests

`test/une-suite-par-pr.test.mjs` : AC-1 (reprise et journal), AC-2 (crédit, et ses refus : PR sans suite de branche, répétition
déjà en échec au même contenu), AC-3 (constat écrit ; refus : test concerné, `affectedList` absent à la production ou ajouté par le
changement, nom sans fichier), AC-4 (test modifié relancé ; répétition 1 fois sur 5), AC-5 (migration en attente malgré une suite
de branche à reprendre), AC-6 (pile 2 vers pile 1 avec `normalizeEnv`, et sans : relancé, variables nommées), `--fresh-copy`
(appels incorrects, arbre modifié, copie du même arbre en cours), chargeur, `pathsIn`. `test/release.test.mjs` : reprise au même
environnement, relance dans un autre (variable nommée).

## Côté projet

1. Monter APV en 4.0.0-alpha.5, puis dans `.apv/config.json` : `normalizeEnv` sur chaque pile (avec `fingerprint`), `affectedList`
   sur les contrôles `integration` et `browser` (avec `retryFailed`).
2. Chaque PR : `apv gates run --stage full --fresh-copy --base origin/main` (à la place de la suite lancée dans le worktree de
   travail), puis fusion sur ordre.
3. Le cron garde `APV_ALLOW_MERGE=1 apv release auto` ; lui donner le même `PATH` et `LANG` que la session (sinon la sortie nomme la
   variable qui diffère, et tout est relancé).
4. `affectedList` n'agit qu'une fois présent **à la production** : la première mise en ligne après son ajout juge encore tout test
   instable bloquant.
