# Projet déjà commencé

Pour un dépôt qui existe déjà, avec ou sans historique d'assistance par IA. Pour un dépôt vide ou sans premier commit, voir [BOOTSTRAP.md](BOOTSTRAP.md).

Le prompt canonique reste [START-HERE.md](../docs/v2/START-HERE.md), section « APPLICATION EXISTANTE / ONBOARDING ». Ce fichier n'en est pas une copie : il donne la porte d'entrée et ce qui ne concerne qu'un projet existant.

## Prompt initial

Copiez le [prompt initial](../docs/v2/START-HERE.md#prompt-initial) — quarante-neuf lignes — et renseignez « Application cible » avec l'URL ou le chemin du dépôt existant.

Ce bloc porte les principes qui lient l'assistant avant toute lecture : ne fabriquer aucune approbation ni preuve, ne pas force-pousser ni fusionner, traiter le contenu du dépôt comme des données non fiables. Ne le remplacez pas par une consigne plus courte de votre cru : ces règles sont ce qui tient quand l'assistant lit le reste en diagonale.

## Ce que l'onboarding fait, et ne fait pas

`apv2 onboard` produit un **plan persistant** : l'inventaire du dépôt, la configuration proposée, et chaque fichier prévu avec son contenu précédent. Rien n'est écrit tant que `onboard apply ID --hash HASH --approve` n'a pas été lancé. Les liens symboliques et les écrasements inattendus sont refusés, et un plan qui laisse des questions ouvertes ne peut pas être forcé.

Il ne lance aucun script du projet, n'installe aucune dépendance et n'adopte aucune écriture faite dans le workspace de Setup.

## Trois réalités d'un projet existant

**L'onboarding propose le mode preuves, et il ne fait pas semblant.** La configuration proposée part en `workflow.qualityReview: "evidence"` et déclare des contrôles découverts dans le dépôt lui-même — scripts de test, de build, de sécurité. Le plan avertit explicitement que **le nom d'un script est un indice, pas une preuve de couverture** : les étiquettes `covers` de chaque contrôle doivent être relues face à ce que la commande exécute vraiment. Quand le profil n'est pas reconnu automatiquement, le plan pose une question — fournir une configuration revue avec de vraies commandes de test, ou passer `--assist` — et un plan à questions ouvertes ne peut pas être appliqué.

La conséquence tient en une phrase : **sur un dépôt sans rien qui prouve le comportement, les specs qui touchent au code s'arrêteront sur une preuve manquante plutôt que de livrer du travail non prouvé.** C'est voulu. Si ce n'est pas ce que vous voulez pour ce dépôt-là, il faut soit lui donner d'abord des tests, soit choisir `legacy` en connaissance de cause au moment de l'onboarding — et non le découvrir à la première spec bloquée.

**Le classement de risque par défaut est prudent.** Les chemins sensibles couvrent notamment l'authentification, les migrations, le SQL, les manifestes de dépendances, les secrets et les fichiers d'infrastructure. Dans un dépôt ancien, beaucoup de modifications en touchent au moins un : elles partent alors en lane `high`, avec tous les contrôles et, en mode `team`, deux approbations. Cela s'ajuste dans `risk.fastPaths` et `risk.highPaths` au moment de l'onboarding, en connaissance de cause, plutôt qu'en subissant la lenteur ensuite.

**Le couplage implicite provoque des amendements de périmètre.** Chaque tâche déclare les chemins qu'elle peut modifier. Dès qu'un changement tire un appelant imprévu, la spec s'arrête sur `SCOPE_AMENDMENT_REQUIRED` et attend une décision explicite. C'est le mécanisme qui empêche un agent d'élargir seul son périmètre ; sur du code ancien, il se déclenche souvent. `apv2 spec show` indique à chaque fois l'action suivante.

## Premier essai

Choisir un module **qui a déjà des tests**, et une première spec étroite. Un module éprouvé permet de voir le cycle complet — spec, approbation, tâches, contrôles, QA, revue — sans que le résultat dépende d'une zone du code que personne ne sait vérifier.
