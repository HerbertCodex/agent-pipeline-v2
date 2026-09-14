# Migration vers alpha.3

Faire une sauvegarde du dépôt cible et du store local. Terminer ou abandonner explicitement les specs en cours **avec leur version d'origine**, puis installer la nouvelle distribution. Les nouvelles valeurs par défaut et l'identité du runner changent les empreintes de config/preuves : ne pas forcer la reprise d'une spec alpha.2 avec un binaire alpha.3. Créer une nouvelle spec revue au nouveau commit de base.

## Projet déjà configuré

Ne pas relancer aveuglément `onboard apply`. Préserver `pipeline.v2.json`, AGENTS.md, CLAUDE.md et toute personnalisation. `apv2 inspect --repo PATH` est en lecture seule et signale les guides anciens. Les copies ne sont pas des overrides runtime.

La configuration sans bloc `skills` reste valable et n'active aucun nouveau skill. Pour les activer, préparer un changement dédié de configuration, choisir les noms et le type de projet, puis copier les guides correspondants depuis `roles/` et `skills/` vers `.agent-pipeline/roles/` et `.agent-pipeline/skills/`. Examiner le diff avant commit ; ne pas écraser un fichier modifié par l'équipe. Aucun outil de migration destructive ou d'upgrade en place n'est fourni.

Le catalogue provient du package de confiance, pas d'un téléchargement à chaque tâche. Les options natives Claude se configurent dans `agent` ou `roles`; le provider de l'éditeur ne les remplace pas automatiquement. Mettre à jour les wrappers command pour utiliser le champ `guidance` tout en préservant leurs limites de permission.

## Nouveau projet cible

Utiliser le parcours README/START-HERE : choix explicite du fournisseur, plan, accord sur son hash, application, commit autorisé et `doctor --execute` autorisé. Les rôles et références sont installés dans le plan. Les critères de sécurité et de validation ne sont pas allégés par l'activation des skills.

## Historique alpha.1 → alpha.2

# Migration

## Alpha.1 vers alpha.2

L'API de tâche et les commandes `init/run/resume/verify/status/events/approve/reject/export/recover` restent disponibles. Les configurations alpha.1 sont acceptées : `roles.product` et `roles.qa` valent null par défaut, `workflow.qaLanes` vaut standard/high, `maxQaRepairs` vaut 1 et `maxActiveMs` vaut 3 600 000. Les runs autonomes alpha.1 ne commencent pas à appeler Product/QA simplement parce que le paquet a été mis à jour : le nouveau parcours utilise les commandes `spec`.

Arrêter les processus du contrôleur et leurs enfants avant de sauvegarder le répertoire d'état complet. Sauvegarder SQLite, les fichiers WAL/SHM éventuels et les workspaces, pas uniquement un JSON exporté. Au premier accès, user_version 1 est migré vers 2 sans supprimer les runs ; ce cas est couvert par un test. Une version de base future inconnue est refusée.

Il n'y a pas de downgrade automatique : revenir à alpha.1 nécessite de restaurer la sauvegarde correspondante, pas de modifier user_version. Le nouvel exécutable et l'ancien ne doivent pas écrire simultanément. Les reçus/caches peuvent nécessiter une revalidation selon les empreintes de moteur/environnement.

`onboard` est destiné à une première installation, non à écraser `pipeline.v2.json`. Dans un projet déjà équipé alpha.1, conserver la configuration existante et ajouter les guides après revue explicite. Les sorties de `onboard --config` doivent être examinées dans un dépôt de test si l'on veut réutiliser le générateur, car il refuse normalement d'écraser les fichiers installés.

## V0.6 vers V2

Pas de conversion automatique de l'ancien store JSONL, des prompts historiques ou de tous les profils Nest/SvelteKit/data/security. Les anciens rapports restent des pièces d'historique, pas des preuves directement acceptées par la V2. Extraire les commandes et politiques pertinentes, les configurer puis les calibrer sur le dépôt.

Démarrer avec une branche de migration et un projet pilote. Garder les anciennes instructions tant qu'elles servent à comprendre les règles, mais éviter deux orchestrateurs actifs ou des guides contradictoires. Ne pas supprimer les règles de sécurité, les critères métier ou le tracker sous prétexte que le nouveau noyau dispose de moins de rôles administratifs.

Le nouveau parcours retrouve configuration assistée, Product, specs et QA, avec une seule revue intégrée selon le risque. Il ne reprend pas une obligation de deux commits test/code, une CI distante intégralement gérée ou le tableau de bord V1. Les règles spécifiques restent des gates ou une intégration à adapter.

## Vers 2.0.0-alpha.5

- Les configurations existantes restent valides : `workflow.reviewMode` prend `team` par défaut.
- Pour un projet solo, réviser explicitement la configuration ou relancer un plan d'onboarding avec `--review-mode solo` entre deux specs.
- Les nouvelles installations peuvent contenir `.agent-pipeline/ARCHITECTURE.md` ; ne pas remplacer manuellement son contenu pendant une spec active.
- Une spec UI alpha.5 peut exiger une proposition design avant approbation alors qu'une ancienne spec n'en avait pas. Ne pas migrer une spec déjà en exécution ; terminer ou clôturer son historique puis créer une nouvelle spec.
- Les nouveaux champs de tâche (`allowedNewPaths`, `maxNewFiles`, `reviewRequired`) ont des valeurs par défaut conservatrices pour les anciens JSON.


## Vers 2.0.0-alpha.6

- Terminer les specs actives avec leur binaire d’origine ; le hash de spec alpha.6 inclut désormais le Decision Ledger.
- Pour un nouveau bootstrap, utiliser `bootstrap refine` plutôt que recréer un plan à chaque réponse de cadrage.
- Les nouveaux projets écrivent `.agent-pipeline/DECISIONS.json` et `.agent-pipeline/DECISIONS.md` lors de l’application du bootstrap.
- Les anciennes specs sans ledger restent lisibles avec un ledger vide pour compatibilité, mais n’acquièrent pas rétroactivement de décisions confirmées.
- Les propositions Product/QA externes doivent ajouter `decisionCoverage` / `decisionChecks` lorsqu’un ledger alpha.6 contient des décisions `product` confirmées.

## Vers 2.0.0-alpha.7

- Terminer les specs actives avec leur binaire d'origine.
- Les nouveaux Decision Ledgers peuvent contenir `status: "ambiguous"`, `clarificationQuestion` et `interpretations`.
- Les specs qui résolvent une ambiguïté Product utilisent `decisionResolutions`; cette résolution doit citer une réponse opérateur et être couverte par `decisionCoverage`.
- Les propositions externes Product/QA doivent tenir compte des ambiguïtés résolues, qui deviennent des exigences vérifiées comme les décisions Product confirmées.
- Une ambiguïté métier non nécessaire au scaffold ne doit pas être convertie artificiellement en blocker bootstrap.

## Vers 2.0.0-alpha.8

Alpha.8 étend le contrat de spec avec `security`, ajoute `securityChecks` au rapport QA et lie le hash de spec à un `SecurityContext`. Les anciennes specs en cours ne doivent pas être réécrites en place : terminer avec leur version de moteur ou créer une nouvelle spec alpha.8. Les specs sans surface de sécurité détectée reçoivent un plan neutre par défaut.

L'onboarding peut ajouter des gates pour des scripts de sécurité déjà configurés dans le projet. Relire le nouveau plan d'installation avant `onboard apply`; aucun scanner absent n'est ajouté automatiquement.
