# Exécution : abonnement, décisions et reprises

> **Archive V2.** Ce guide décrit le CLI `apv2` d'Agent Pipeline V2 (dernière version 2.0.0-alpha.8, branche `main`) et son contrôleur, retirés d'APV3. Pour APV3 : [plugin](../PLUGIN.md), [outil apv](../CLI.md), [spécification](../APV3-SPEC.md).

La politique distingue le mode d’usage, le choix du modèle et les preuves de qualité. Un montant déclaré par le CLI n’est ni une facture ni une mesure du quota de votre compte.

## Choisir le mode d’usage

`agent.usageMode` et le même champ dans les rôles acceptent :

| Mode | Politique monétaire |
| --- | --- |
| `subscription` | Aucun plafond USD ajouté par la pipeline, y compris pour les probes, le bootstrap et QA. Les estimations restent visibles. |
| `metered` | Plafonds configurés conservés, avec le budget restant partagé entre les appels hors abonnement. |
| `legacy` | Compatibilité avec les anciennes configurations ; c’est le défaut lorsque le champ est absent. |

La déclaration ne change ni l’authentification, ni les variables transmises, ni le plan du compte. Choisir le mode correspondant à la connexion réelle du CLI. Les quotas fournisseur, délais, limites de tours et arrêts sur absence de progrès restent applicables. Les agents natifs en mode abonnement ou facturé exigent un modèle explicite ; les identifiants `YOUR_...` sont refusés avant l’appel.

Pour un nouveau projet, utiliser [le fichier de sélection](../examples/model-selection.example.json), renseigner les modèles accessibles et le mode de chaque choix, puis `--models models.json`. `quick` et `deep` partagent fournisseur et mode ; QA peut utiliser un autre fournisseur et un autre mode. Le choix simple existe aussi : `--provider claude --model IDENTIFIANT --usage-mode subscription` pour bootstrap/onboard. Les anciens fichiers de configuration ne sont pas modifiés automatiquement.

## Migrer une spec existante

Dans le tableau de bord, **Ajuster les limites** permet de choisir le mode par rôle et de désactiver le plafond total en laissant son champ vide. En CLI, préparer par exemple `subscription.json` :

```json
{
  "maxSpecCostUsd": null,
  "agent": { "usageMode": "subscription" }
}
```

```bash
apv2 spec budget SPEC_ID --file subscription.json --approve --note "Utiliser les abonnements des rôles configurés"
apv2 spec show SPEC_ID
```

Ce réglage partagé s’applique aux rôles sans override opérationnel propre. Pour une configuration mixte, déclarer explicitement `roles.qa.usageMode: "metered"` et conserver un plafond total adapté aux appels facturés. Les modes propres à chaque rôle dans un amendement priment sur le réglage partagé. Si des modèles étaient implicites, les renseigner dans le même amendement avant la reprise.

`null` désactive le plafond global ; un champ absent conserve sa valeur précédente. Un amendement ultérieur du délai ne réactive donc pas un plafond désactivé. En mode facturé/historique, désactiver le plafond global ne supprime pas un plafond par appel déjà configuré.

La migration conserve contenu approuvé, historique, candidats et reçus. Elle s’effectue à l’arrêt du workflow. Changer le modèle ou l’effort QA invalide sa revue et la revue humaine associée : la prochaine QA doit réévaluer le candidat complet. Les tests déjà valides restent disponibles. Le changement est refusé après publication/livraison du candidat.

Les événements nouvellement marqués abonnement sont exclus du total soumis au budget. Les anciens coûts sans mode connu restent comptés de manière conservatrice pour les appels facturés ; ils ne sont pas reclassés automatiquement. `cost.knownUsd` conserve les estimations de tous les appels, `cost.budget` expose la partie soumise au plafond.

## Décisions contrôlées et vérifiables

La sélection du parcours et du modèle repose sur des fonctions de politique explicites. Les décisions enregistrent version de politique, entrées utiles, résultat, raisons et empreintes. Les tests rejouent les décisions de parcours et de modèle après sérialisation. La sélection des contrôles enregistre aussi le hash de la configuration conservée, le candidat, le diff observé et la lane.

Priorité modèle : amendement explicite du rôle, règle `modelRouting`, profil `quick/deep`, configuration du rôle. QA dédiée utilise la politique `deep`, indépendamment de la lane Implementer. Un changement global du modèle Implementer ne remplace pas cette QA. Aucun classement de modèles par leur nom, remplacement silencieux ou repli vers une API payante n’est introduit.

Ce déterminisme porte sur le contrôleur et ses entrées enregistrées. Il ne promet pas une réponse identique du modèle, d’un alias fournisseur ou d’un outil externe, ni un rejeu automatique de tous les effets système après crash.

## Comprendre un arrêt

| Code | Cause et reprise |
| --- | --- |
| `PROVIDER_QUOTA` | Quota du compte signalé par le fournisseur ; reprendre après rétablissement. |
| `PROVIDER_RATE_LIMIT` | Limitation de requêtes ; attendre avant de reprendre. |
| `PROVIDER_UNAVAILABLE` | Indisponibilité temporaire du fournisseur. |
| `PROVIDER_BUDGET`, `COST_BUDGET`, `QA_BUDGET` | Plafond monétaire du CLI, de la spec ou nouvelle tentative QA sans allocation suffisante. |
| `AGENT_TIMEOUT`, `BUDGET` | Délai d’appel ou temps actif autorisé écoulé. |
| `PROVIDER_TURNS` | Nombre de tours configuré atteint. |
| `GATES_FAILED`, `QA_REJECTED` | Contrôles ou évaluation QA en échec. |
| `REPAIR_NO_CHANGE`, `REPAIR_NO_PROGRESS` | Réparation sans changement ou mêmes erreurs répétées. |

Les diagnostics identifiables sont classés sans interpréter le texte d’une réponse réussie. Les formats inconnus restent des erreurs génériques inspectables. Le contrôleur ne devine pas une date de rétablissement et ne lance pas de relance automatique sur quota. Une implémentation interrompue conserve son espace pour la procédure existante d’inspection/adoption ; ce n’est pas une acceptation du code.

## Mesurer avant d’optimiser

`spec show` et le panneau **Temps par étape** distinguent Product, architecture, Design, préparation des espaces, implémentation, contrôles et QA. Les probes sont présentés séparément. Les phases terminées comptent les réparations ; les anciens rôles peuvent ne contenir que le temps du processus. Un appel sans résultat affiche son temps écoulé, sans prétendre que le processus tourne encore.

Les parcours courts, checks en session et reçus réutilisables restent en place. Les réparations conservent leur contexte utile ; elles ne reprennent pas encore un thread fournisseur natif. Une nouvelle tâche sélectionne son contexte et QA reste indépendante.

`npm run evaluate -- --usage-mode subscription` prépare une campagne sans plafond USD. Il faut toujours `--execute`, un modèle/configuration et un répertoire de sortie pour lancer les appels. Les campagnes mixtes ne comptabilisent que les appels hors abonnement dans leur plafond. Les coûts inconnus restent inconnus dans les rapports.

La validation de ce lot utilise des doubles de CLI et des dépôts jetables, sans consommation de compte fournisseur. Elle établit le comportement du contrôleur ; aucun gain de vitesse sur une vraie fonctionnalité ni classement de modèles n’est annoncé sans campagne mesurée.
