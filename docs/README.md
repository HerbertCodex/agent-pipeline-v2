# Documentation

Les guides ci-dessous décrivent le fonctionnement actuel. Pour commencer : [présentation du projet](../README.md) et [démarrage avec l’assistant](../START-HERE.md).

| Besoin | Guide |
| --- | --- |
| Configurer le projet et les contrôles | [Configuration](CONFIGURATION.md) · [Migration](MIGRATION.md) |
| Choisir les modèles et comprendre les fournisseurs | [Modèles](MODELS.md) · [Adaptateurs](ADAPTERS.md) |
| Comprendre l’abonnement, les limites et les diagnostics | [Politique d’exécution](EXECUTION-POLICY.md) |
| Piloter une spec, reprendre un arrêt et livrer | [Cycle de vie](LIFECYCLE.md) |
| Comprendre les agents et leurs consignes | [Rôles](ROLES.md) · [Skills](SKILLS.md) |
| Exiger des preuves et corriger les défauts | [Qualité et validation](QUALITY.md) |
| Comprendre les frontières et les décisions | [Architecture](ARCHITECTURE.md) · [Décisions produit](DECISIONS.md) |
| Comprendre les garanties et leurs limites | [Sécurité](SECURITY.md) · [Routage OWASP](OWASP-SECURITY.md) |
| Mesurer les délais et comparer les profils | [Performance](PERFORMANCE.md) · [Pilotes fournisseurs](PROVIDER-PILOT.md) |

Les contrats exécutables sont dans [src/domain/contracts.ts](../src/domain/contracts.ts) et [src/lifecycle/contracts.ts](../src/lifecycle/contracts.ts), avec leurs [schémas exportés](../examples/schemas/).

[Évolutions](../CHANGELOG.md) · [Résultats de validation](../validation/VALIDATION.md)

Les guides actuels restent à la racine de `docs/`, les preuves d’exécution dans `validation/`. Les évolutions sont consignées dans le changelog. Un résultat historique atteste uniquement l’état testé ; le numéro de version seul ne suffit pas à identifier cet état.
