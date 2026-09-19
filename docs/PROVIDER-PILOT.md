# Pilote avec un véritable fournisseur

Les tests automatiques du dépôt utilisent des exécutables contrôlés : ils testent les protocoles, pas les modèles. Aucune authentification réelle ni facture n'est attestée par ces tests.

## Essai borné fourni

Installer et authentifier le fournisseur selon sa documentation officielle. Ne pas coller de clé dans un prompt, un JSON de configuration ou une issue. Utiliser un environnement de développement de confiance avec Git et Node.

```bash
node scripts/provider-pilot.mjs --help
node scripts/provider-pilot.mjs --provider claude --output /chemin/nouveau-pilote-claude --execute
# Ou --provider codex avec un autre dossier neuf.
```

Sans `--execute`, aucun modèle n'est appelé. Avec ce flag, le script peut consommer votre quota. Claude reçoit un plafond par invocation, pas une limite totale de facture garantie. L'opérateur doit vérifier la tarification applicable et les contrôles de compte du fournisseur. Codex conserve le budget temps du contrôleur, sans plafond monétaire attesté.

Le script crée une fixture jetable, utilise des commandes de tests fixes, appelle Product puis l'Implementer et QA, avec correction bornée. Il refuse un périmètre plus large que trois fichiers connus. L'approbation Product est explicitement **simulée pour la fixture**, autorisée par ce lancement du pilote. Une revue humaine réelle n'est ni créée ni revendiquée. Setup assisté n'est pas testé par ce pilote : la configuration de la fixture est fixée pour ne pas exécuter automatiquement une commande proposée par un modèle.

Le rapport conserve la version du fournisseur, le résultat, les limites et la durée. Les événements et le store restent dans le dossier fourni. Ne pas confondre statut `awaiting_review`, QA pass et approbation humaine. Le script ne pousse, ne fusionne ni ne déploie rien. En cas de refus, erreur de schéma, question ou permission manquante : inspecter le résultat, ne pas activer un bypass global.

## Qualification d'équipe

Après ce test de raccordement, mesurer plusieurs tâches représentatives contre un agent seul avec la CI existante. Conserver le même commit de départ, le fournisseur, le modèle, les critères et l'environnement. Comparer le temps jusqu'au changement accepté, les défauts, les interventions humaines et le coût. Les tâches réelles exigent de vraies approbations, jamais les identités de fixture.

La disponibilité de ce script ne prouve pas son exécution avec un vrai compte. Une campagne distincte a utilisé `scripts/evaluate.mjs` avec Claude : [résultats initiaux](../validation/short-loop-2026-09-18/REPORT.md), [calibration](../validation/short-loop-2026-09-18/CALIBRATION.md) et [coûts connus ou réservés](../validation/short-loop-2026-09-18/calibration-spending.json). Ces cas ne couvrent ni un pilote Codex réel ni la nouvelle grille QA du lot 3.

## Pilote de réparation des sorties

```bash
node scripts/repair-pilot.mjs --help
node scripts/repair-pilot.mjs --provider claude --output /chemin/nouveau-pilote-reparation --execute
```

Au plus **deux** appels au fournisseur, sur une fixture jetable.

1. Le contrôleur refuse la première réponse avec une erreur qui cite un jeton aléatoire (`REPAIR-xxxxxxxx`) que le modèle ne peut pas connaître.
2. Le pilote réussit si la seconde réponse contient ce jeton. Cela prouve que le modèle réel a lu l'erreur transmise par `repair.previousError` et corrigé sa réponse.

Le rapport indique :
- le nombre de validations ;
- les événements `role.output_repair` ;
- la durée.

Ce pilote prouve seulement la boucle de réparation avec ce fournisseur, à cette date. Il ne dit rien de la qualité des specs ni du coût d'un projet réel.
