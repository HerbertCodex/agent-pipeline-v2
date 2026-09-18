# Documentation

Les guides ci-dessous décrivent le code actuel, y compris les parcours courts et les preuves de qualité ajoutés après la livraison initiale `2.0.0-alpha.8`. Le numéro de version n'a pas changé entre ces travaux : il ne suffit pas à identifier leur périmètre.

## Guides à suivre

| Besoin | Guide |
| --- | --- |
| Démarrer | [Présentation](../README.md) · [Prompt pour l'assistant](../START-HERE.md) |
| Configurer parcours, modèles, budgets et contrôles | [Configuration](CONFIGURATION.md) |
| Choisir les modèles, réserver QA et migrer un identifiant | [Modèles](MODELS.md) |
| Piloter une spec, reprendre un arrêt, livrer | [Cycle de vie](LIFECYCLE.md) |
| Mettre à jour un projet existant | [Migration](MIGRATION.md) |
| Comprendre les fournisseurs et les outils autorisés | [Adaptateurs](ADAPTERS.md) |
| Comprendre les agents et leurs consignes | [Rôles](ROLES.md) · [Skills](SKILLS.md) |
| Exiger des preuves de qualité | [Qualité et validation — lot 3](LOT-3-QUALITE.md) |
| Comprendre les frontières et les décisions | [Architecture](ARCHITECTURE.md) · [Décisions produit](DECISIONS.md) |
| Comprendre les garanties et leurs limites | [Sécurité](SECURITY.md) · [Routage OWASP](OWASP-SECURITY.md) |
| Mesurer les délais et comparer les profils | [Performance](PERFORMANCE.md) · [Pilotes fournisseurs](PROVIDER-PILOT.md) |

## Bilans et historique

Ces documents décrivent un état daté. Leurs résultats et leurs échecs sont conservés ; ils ne remplacent pas les guides actuels.

- [Audit initial du 18 septembre](AUDIT-2026-09-18.md) : constats **avant** les corrections.
- [Bilan des améliorations](AMELIORATIONS-2026-09-18.md) : lots 1 à 3, calibration et limites des mesures.
- [Validation du lot 3](../validation/lot3-2026-09-18/summary.json) : 446 tests, contrôle du paquet et parcours Chromium.
- [Validation des modèles et de QA dédiée](../validation/models-2026-09-18/summary.json) : 465 tests, installation du paquet et affichage Chromium ; fournisseurs simulés.
- [Calibration des profils](../validation/short-loop-2026-09-18/CALIBRATION.md) : petits cas Claude, résultats et coûts déclarés.
- [Validation initiale alpha.8](../validation/VALIDATION.md) : périmètre antérieur aux lots d'amélioration.
- Notes de livraison : [alpha.3](RELEASE-alpha.3.md), [alpha.4](RELEASE-alpha.4.md), [alpha.5](RELEASE-alpha.5.md), [alpha.8](RELEASE-alpha.8.md).
- [Changelog](../CHANGELOG.md) et [sources consultées](SOURCES.md).

Les contrats exécutables sont dans [src/domain/contracts.ts](../src/domain/contracts.ts) et [src/lifecycle/contracts.ts](../src/lifecycle/contracts.ts), avec leurs [schémas exportés](../examples/schemas/). Un bilan de tests prouve son exécution sur un état du code ; il n'atteste pas tous les changements ultérieurs ni la qualité générale d'un modèle.
