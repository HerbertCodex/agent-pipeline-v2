# Documentation

Agent Pipeline V3 est un plugin Claude Code. Pour commencer : [présentation](../README.md) et [démarrage](../START-HERE.md).

| Besoin | Guide |
| --- | --- |
| Installer le plugin, ses agents, compétences, commandes et hooks | [Plugin](PLUGIN.md) |
| Comprendre ce que fait APV3 et pourquoi | [Spécification](APV3-SPEC.md) · [Retour d'expérience « Toujours rien »](RETOUR-TOUJOURS-RIEN.md) |
| Utiliser l'outil `apv` | [Outil apv](CLI.md) · [Verrous à bail](LOCKS.md) · [Contrôle du modèle de données](DB-CHECK.md) |
| Registre des décisions | [Décisions](DECISIONS.md) |
| Sécurité | [Sécurité](SECURITY.md) · [Routage OWASP](OWASP-SECURITY.md) |
| Configuration reprise de V2, contrôles et preuves | [Configuration](CONFIGURATION.md) · [Qualité et validation](QUALITY.md) · [Compétences](SKILLS.md) |

Les contrats exécutables sont dans [src/domain/contracts.ts](../src/domain/contracts.ts) et [src/lifecycle/contracts.ts](../src/lifecycle/contracts.ts). Exemples : [spec](../examples/spec.example.json) et [tâche](../examples/task.example.json).

## Archive V2

Le CLI `apv2` (dernière version 2.0.0-alpha.8) reste sur la branche `main`. Ses guides propres au contrôleur sont archivés dans [v2/](v2/) : [démarrage](v2/START-HERE.md), [cycle de vie](v2/LIFECYCLE.md), [rôles](v2/ROLES.md), [modèles](v2/MODELS.md), [adaptateurs](v2/ADAPTERS.md), [politique d'exécution](v2/EXECUTION-POLICY.md), [blocages et recours](v2/RECOVERY.md), [architecture](v2/ARCHITECTURE.md), [migration](v2/MIGRATION.md), [performance](v2/PERFORMANCE.md), [pilote fournisseur](v2/PROVIDER-PILOT.md), avec les [portes d'entrée](v2/prompts/), les [consignes de rôles](v2/roles/) et les [schémas JSON exportés](v2/schemas/) de V2.

[Évolutions](../CHANGELOG.md) · [Résultats de validation V2](../validation/VALIDATION.md)
