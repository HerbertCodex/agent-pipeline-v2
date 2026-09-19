# Mettre à jour un projet existant

## Modèles et QA dédiée

Les champs absents conservent `workflow.qaProfile: "lane"` et `agent.preflight: "off"`. Pour réserver une revue approfondie à QA, revoir son modèle, ses éventuels profils/règles, puis activer `qaProfile: "deep"`. Pour contrôler réellement un modèle natif avant le contexte projet, activer `preflight: "probe"` sur l'agent concerné ; ces contrôles consomment du quota. `--models FILE` est destiné au bootstrap et à la première installation, sans écraser un projet installé.

`models replace` prépare un nouveau fichier pour les identifiants retirés. Les specs déjà créées gardent leur configuration ; un amendement `spec budget` peut ajuster le modèle et l'effort d'un rôle, sans changer son fournisseur ou ses permissions. Voir les [commandes et priorités exactes](MODELS.md).

## Vers les parcours courts et les preuves de qualité

Les lots d'amélioration du 18 septembre suivent la livraison initiale alpha.8, **sans changement de numéro de version**. Identifier aussi le commit de la distribution utilisée. Les sections historiques ci-dessous décrivent leurs versions d'origine, pas les valeurs par défaut actuelles.

1. Terminer ou abandonner explicitement les specs actives avec leur distribution d'origine. Arrêter les processus avant de sauvegarder le dépôt et le store complet, y compris SQLite, WAL/SHM éventuels et workspaces. Ne pas migrer les documents approuvés en place.
2. Mettre à jour le framework entre deux specs. Utiliser `apv2 inspect --repo PATH` pour examiner configuration et dérive des guides installés. Le runtime charge rôles et skills depuis le package ; les copies du projet ne les remplacent pas.
3. Préserver `pipeline.v2.json`, les commandes, permissions et conventions du projet. Les champs absents `workflow.planningMode` et `workflow.qualityReview` restent `legacy`. Les nouvelles configurations `init`/onboarding proposent, elles, `adaptive` et `evidence`.
4. Pour activer les nouveaux comportements, fusionner les réglages suivants dans une configuration revue. Ajouter les labels `covers`, les mappings `testPaths` et les règles locales nécessaires aux **commandes réellement présentes** : [guide de qualité](QUALITY.md#activation-et-compatibilité).
5. Contrôler le diff de configuration, calibrer les commandes avec `doctor --execute` lorsque leur exécution est autorisée, puis créer une nouvelle spec. Une gate manquante ne doit pas être remplacée par un faux succès.

```json
{
  "workflow": {
    "planningMode": "adaptive",
    "qualityReview": "evidence"
  }
}
```

Ce fragment complète le fichier existant ; ce n'est pas une configuration autonome. `feedback.gateIds` reste vide par défaut : autoriser séparément les checks indépendants que l'Implementer peut demander en session. Les modèles peuvent être fixés par `roleProfiles` et `modelRouting`. Voir [la configuration actuelle](CONFIGURATION.md).

Les limites par défaut ont évolué : trois réparations de code, deux réparations QA, 30 minutes pour l'agent et 45 minutes pour un run. Une valeur explicitement configurée est conservée. Le plafond global de spec (25 $ par défaut) contraint aussi le budget restant de chaque appel Claude ; il peut interrompre un appel. Examiner les limites avant un nouveau run, sans confondre allocation et objectif de durée.

Ne pas relancer `onboard apply` pour écraser une installation existante. Il n'y a ni mise à jour destructive automatique ni downgrade automatique du store. Les anciens rapports restent des pièces d'historique ; ils n'acquièrent pas rétroactivement les nouvelles preuves.

## Historique : vers alpha.3

Faire une sauvegarde du dépôt cible et du store local. Terminer ou abandonner explicitement les specs en cours **avec leur version d'origine**, puis installer la nouvelle distribution. Les nouvelles valeurs par défaut et l'identité du runner changent les empreintes de config/preuves : ne pas forcer la reprise d'une spec alpha.2 avec un binaire alpha.3. Créer une nouvelle spec revue au nouveau commit de base.

### Projet déjà configuré

Ne pas relancer aveuglément `onboard apply`. Préserver `pipeline.v2.json`, AGENTS.md, CLAUDE.md et toute personnalisation. `apv2 inspect --repo PATH` est en lecture seule et signale les guides anciens. Les copies ne sont pas des overrides runtime.

La configuration sans bloc `skills` reste valable et n'active aucun nouveau skill. Pour les activer, préparer un changement dédié de configuration, choisir les noms et le type de projet, puis copier les guides correspondants depuis `roles/` et `skills/` vers `.agent-pipeline/roles/` et `.agent-pipeline/skills/`. Examiner le diff avant commit ; ne pas écraser un fichier modifié par l'équipe. Aucun outil de migration destructive ou d'upgrade en place n'est fourni.

Le catalogue provient du package de confiance, pas d'un téléchargement à chaque tâche. Les options natives Claude se configurent dans `agent` ou `roles`; le provider de l'éditeur ne les remplace pas automatiquement. Mettre à jour les wrappers command pour utiliser le champ `guidance` tout en préservant leurs limites de permission.

### Nouveau projet cible

Utiliser le parcours README/START-HERE : choix explicite du fournisseur, plan, accord sur son hash, application, commit autorisé et `doctor --execute` autorisé. Les rôles et références sont installés dans le plan. Les critères de sécurité et de validation ne sont pas allégés par l'activation des skills.

## Historique : alpha.1 vers alpha.2

L'API de tâche et les commandes `init/run/resume/verify/status/events/approve/reject/export/recover` restent disponibles. Les configurations alpha.1 sont acceptées : `roles.product` et `roles.qa` valent null par défaut, `workflow.qaLanes` vaut standard/high, `maxQaRepairs` vaut 1 et `maxActiveMs` vaut 3 600 000. Les runs autonomes alpha.1 ne commencent pas à appeler Product/QA simplement parce que le paquet a été mis à jour : le nouveau parcours utilise les commandes `spec`.

Arrêter les processus du contrôleur et leurs enfants avant de sauvegarder le répertoire d'état complet. Sauvegarder SQLite, les fichiers WAL/SHM éventuels et les workspaces, pas uniquement un JSON exporté. Au premier accès, user_version 1 est migré vers 2 sans supprimer les runs ; ce cas est couvert par un test. Une version de base future inconnue est refusée.

Il n'y a pas de downgrade automatique : revenir à alpha.1 nécessite de restaurer la sauvegarde correspondante, pas de modifier user_version. Le nouvel exécutable et l'ancien ne doivent pas écrire simultanément. Les reçus/caches peuvent nécessiter une revalidation selon les empreintes de moteur/environnement.

`onboard` est destiné à une première installation, non à écraser `pipeline.v2.json`. Dans un projet déjà équipé alpha.1, conserver la configuration existante et ajouter les guides après revue explicite. Les sorties de `onboard --config` doivent être examinées dans un dépôt de test si l'on veut réutiliser le générateur, car il refuse normalement d'écraser les fichiers installés.

## Historique : V0.6 vers V2

Pas de conversion automatique de l'ancien store JSONL, des prompts historiques ou de tous les profils Nest/SvelteKit/data/security. Les anciens rapports restent des pièces d'historique, pas des preuves directement acceptées par la V2. Extraire les commandes et politiques pertinentes, les configurer puis les calibrer sur le dépôt.

Démarrer avec une branche de migration et un projet pilote. Garder les anciennes instructions tant qu'elles servent à comprendre les règles, mais éviter deux orchestrateurs actifs ou des guides contradictoires. Ne pas supprimer les règles de sécurité, les critères métier ou le tracker sous prétexte que le nouveau noyau dispose de moins de rôles administratifs.

Le nouveau parcours retrouve configuration assistée, Product, specs et QA, avec une seule revue intégrée selon le risque. Il ne reprend pas une obligation de deux commits test/code, une CI distante intégralement gérée ou le tableau de bord V1. Les règles spécifiques restent des gates ou une intégration à adapter.

## Historique : vers 2.0.0-alpha.5

- Les configurations existantes restent valides : `workflow.reviewMode` prend `team` par défaut.
- Pour un projet solo, réviser explicitement la configuration ou relancer un plan d'onboarding avec `--review-mode solo` entre deux specs.
- Les nouvelles installations peuvent contenir `.agent-pipeline/ARCHITECTURE.md` ; ne pas remplacer manuellement son contenu pendant une spec active.
- Une spec UI alpha.5 peut exiger une proposition design avant approbation alors qu'une ancienne spec n'en avait pas. Ne pas migrer une spec déjà en exécution ; terminer ou clôturer son historique puis créer une nouvelle spec.
- Les nouveaux champs de tâche (`allowedNewPaths`, `maxNewFiles`, `reviewRequired`) ont des valeurs par défaut conservatrices pour les anciens JSON.


## Historique : vers 2.0.0-alpha.6

- Terminer les specs actives avec leur binaire d’origine ; le hash de spec alpha.6 inclut désormais le Decision Ledger.
- Pour un nouveau bootstrap, utiliser `bootstrap refine` plutôt que recréer un plan à chaque réponse de cadrage.
- Les nouveaux projets écrivent `.agent-pipeline/DECISIONS.json` et `.agent-pipeline/DECISIONS.md` lors de l’application du bootstrap.
- Les anciennes specs sans ledger restent lisibles avec un ledger vide pour compatibilité, mais n’acquièrent pas rétroactivement de décisions confirmées.
- Les propositions Product/QA externes doivent ajouter `decisionCoverage` / `decisionChecks` lorsqu’un ledger alpha.6 contient des décisions `product` confirmées.

## Historique : vers 2.0.0-alpha.7

- Terminer les specs actives avec leur binaire d'origine.
- Les nouveaux Decision Ledgers peuvent contenir `status: "ambiguous"`, `clarificationQuestion` et `interpretations`.
- Les specs qui résolvent une ambiguïté Product utilisent `decisionResolutions`; cette résolution doit citer une réponse opérateur et être couverte par `decisionCoverage`.
- Les propositions externes Product/QA doivent tenir compte des ambiguïtés résolues, qui deviennent des exigences vérifiées comme les décisions Product confirmées.
- Une ambiguïté métier non nécessaire au scaffold ne doit pas être convertie artificiellement en blocker bootstrap.

## Historique : vers 2.0.0-alpha.8

Alpha.8 étend le contrat de spec avec `security`, ajoute `securityChecks` au rapport QA et lie le hash de spec à un `SecurityContext`. Les anciennes specs en cours ne doivent pas être réécrites en place : terminer avec leur version de moteur ou créer une nouvelle spec alpha.8. Les specs sans surface de sécurité détectée reçoivent un plan neutre par défaut.

L'onboarding peut ajouter des gates pour des scripts de sécurité déjà configurés dans le projet. Relire le nouveau plan d'installation avant `onboard apply`; aucun scanner absent n'est ajouté automatiquement.
