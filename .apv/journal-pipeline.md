# Journal du pipeline, agent-pipeline-v3

## 2026-09-23 : essai d'acceptation de la phase 3 (spec p3-essai)
Déroulé : init, spec (plan de sécurité exigé par le minimum recalculé, voie high), start (3 vagues), modèle de données sauté, plan écrit par le chef de projet, SUMMARY et BIN en parallèle, interruption simulée de BIN (agent arrêté après son premier commit) puis reprise guidée par `apv run next` (« à reprendre depuis 8429f01 ») avec un nouvel agent, intégration par vague avec `apv gates run`, HOOK, DOCS, revues sécurité et fidélité en parallèle sur copies détachées (données et RGPD écartées avec raison), 12 constats consolidés, une passe de corrections (11 constats, 10 commits), livraison en PR brouillon.

Constats sur l'outil et la méthode :
1. `apv run set <étape> --commit` était refusé alors que les commandes l'emploient : corrigé (fcd654b sur apv3-p3).
2. Test FIFO des verrous en échec intermittent (horloge par processus) : corrigé (422bb1f sur apv3-p3).
3. Règle des fondations trop large : toute tâche de première couche dont une autre dépend part en vague 0 « un seul agent » (BIN classée fondation parce que DOCS en dépendait). Contourné en corrigeant la dépendance ; à revoir (marqueur explicite ou seuil). **Traité (b0c98bc sur apv3-p3b)** : vagues = couches des dépendances, fondation = tâche dont au moins deux autres dépendent directement, marquée au niveau de la tâche ; état en version 2, un état de version 1 reste lisible.
4. `apv run next` annonce « prête » une tâche de vague 1 dont les dépendances sont faites, alors que la compétence run dit d'attendre l'intégration de la vague précédente. Les deux se défendent ; à aligner (l'essai a lancé BIN avec SUMMARY, fichiers disjoints). **Traité (3e9d2ae sur apv3-p3b)** : règle unique, prête = dépendances faites et intégrées dans la branche de la spec ; `run set … running` refuse sinon, sauf `--force-unintegrated` avec note journalisée ; lancement dès qu'une tâche est prête, pas vague par vague.
5. `readRunState` (apv run next|set|status <id>) lit encore sans borne : une FIFO nommée comme l'état visé bloquerait. **Traité (9a05514 sur apv3-p3b)** : lecture bornée du résumé (fichier ordinaire, 4 Mio).
6. Workflows `apv:vague` et `apv:revues` non exercés : l'outil Workflow exige l'accord explicite de l'opérateur ; l'essai a utilisé le repli par l'outil Agent (appels parallèles en arrière-plan).
7. Le plugin n'a pas été chargé dans une vraie session : le chef de projet a suivi les compétences et appelé l'outil du dépôt. Chargement réel à faire en phase 4 sur « Toujours rien ».

## 2026-09-23 : fusion des PR #70 et #71 par `apv stack merge`
8. Le re-ciblage de la PR #71 par `gh pr edit 71 --base apv3` a échoué (code 1, « GraphQL: Projects (classic) is being deprecated … (repository.pullRequest.projectCards) ») : la requête GraphQL de `gh pr edit` lit les projets classiques de la PR. L'outil s'est arrêté correctement, rien d'autre n'a été fusionné. **Traité (09dc220 sur apv3-p3b)** : re-ciblage par l'API REST (`gh api -X PATCH repos/<propriétaire>/<dépôt>/pulls/<n> -f base=<cible>`, propriétaire et dépôt lus dans l'adresse de la PR), résultat toujours relu.
