# Validation de la politique d’exécution — 19 septembre 2026

Ce dossier conserve les vérifications de l’interface sur quatre formats Chromium : [observations navigateur](browser-results.json), [bilan et empreinte du code testé](summary.json). Les anciens journaux de tests et de paquet ont été remplacés par la [validation finale de 508 tests](../qa-cleanup-2026-09-19/README.md).

Les tests utilisent des CLI factices, de vrais processus locaux et des dépôts temporaires. Aucun compte fournisseur ni magasin de specs réel n’est modifié. Les observations navigateur conservent leur instantané d’origine ; elles n’ont pas été rejouées lors du nettoyage documentaire.

Reproduire les vérifications :

```bash
npm run check
npm run check:package
node dist/cli.js schemas --output examples/schemas
```

Les régressions principales sont dans `test/subscription-policy.test.mjs`, `test/model-policy.test.mjs`, `test/planning-efficiency.test.mjs`, `test/bootstrap.test.mjs`, `test/evaluation-smoke.test.mjs` et `test/reliability.test.mjs` :

- abonnement sans flags/plafonds USD, probes et bootstrap inclus ; configuration mixte ; coûts inconnus conservés ;
- migration par amendement `null`, préservation des preuves et reprise ;
- quota classé, espace conservé sans adoption automatique, campagne interrompue au premier quota ;
- modèle QA changé : nouvelle revue complète même si le schéma change aussi, conservation du candidat ;
- décisions de parcours/modèle rejouées après sérialisation et plan de contrôles recalculé avec la configuration conservée ;
- durées de phases, probes séparés, historique partiel et appels sans résultat.

`ui-check.mjs` sert une API fictive et ouvre Chromium à 1440, 1024, 390 et 320 px, en thèmes sombre/clair. Il vérifie les diagnostics repliables, la copie, le clavier, le contraste secondaire, l’absence de débordement horizontal, les phases et le formulaire d’abonnement. Il contrôle le JSON réellement soumis : `null` pour le plafond vide et aucun remplacement des modèles inchangés.

Utiliser une installation existante de Playwright (`PLAYWRIGHT_MODULE` si elle n’est pas résolue localement) et, si nécessaire, `CHROMIUM_EXECUTABLE`. Les captures et observations vont dans `UI_VALIDATION_OUTPUT`, par défaut `/tmp/apv2-execution-policy-ui`.

```bash
node validation/execution-policy-2026-09-19/ui-check.mjs
```

Ces vérifications établissent les règles du contrôleur, sans benchmark de latence d’un modèle ni preuve de qualité sur une application complète. Les sessions fournisseur ne sont pas reprises par identifiant.
