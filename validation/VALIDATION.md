# Preuves de validation

Ce dossier conserve les preuves utiles à la version testée et aux mesures citées dans les guides. Chaque résultat est daté : il ne certifie pas automatiquement les modifications ultérieures.

| Dossier | Preuves conservées |
| --- | --- |
| [Corrections QA — 19 septembre 2026](qa-cleanup-2026-09-19/README.md) | Suite finale **508/508**, contrôle du paquet installé hors ligne, vérifications UI et empreintes du code testé. |
| [Interface et politique d’exécution — 19 septembre 2026](execution-policy-2026-09-19/README.md) | Vérifications Chromium à quatre largeurs, thèmes clair/sombre, diagnostics et formulaire d’abonnement. |
| [Calibration Claude — 18 septembre 2026](short-loop-2026-09-18/CALIBRATION.md) | Appels réels sur de petits cas, résultats bruts, réussites, échecs, coûts et limites des mesures. |

Les tests du contrôleur utilisent des fournisseurs simulés. Seule la calibration documente ici des appels réels ; elle ne mesure pas la qualité ou la vitesse d’une fonctionnalité complète.

## Reproduire les contrôles

```bash
npm run check
npm run check:package
```

Les scripts navigateur et leurs prérequis sont décrits dans chaque dossier. Les tests de régression maintenus restent dans `test/`, les scripts courants dans `scripts/`.

## Entretien

Conserver une preuve lorsqu’un guide s’appuie dessus ou qu’elle complète la dernière validation. Remplacer les journaux intermédiaires par le résultat final, sans masquer les échecs d’une campagne de modèles. Les anciens audits, captures et bilans redondants ont été supprimés ; leurs versions restent dans l’historique Git.
