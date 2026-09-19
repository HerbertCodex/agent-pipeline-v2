# Validation — corrections QA obligatoires

Validation du 19 septembre 2026, finalisée avant la fusion du commit `fbe8c15` par la PR #51 (`a9070bd`). Aucun appel fournisseur, aucune modification de `project-test`.

Résultat final : **508/508 tests réussis**, compilation, typage et lint CSS valides. Le schéma QA exporté correspond au schéma du runtime. Le contrôle du paquet installé hors ligne passe également. Voir le [journal final](final-check.log), le [résultat du paquet](package-result.json) et le [résumé avec empreintes](summary.json).

Les journaux intermédiaires ont été remplacés par cette suite complète finale. Ces preuves décrivent le code testé avant fusion ; le nettoyage documentaire n’a pas relancé la suite.

Scénarios vérifiés :

- Refus d'un `pass` avec un constat mineur dont la correction est requise, y compris sans mode evidence.
- Suppression réelle d'un helper dans une fixture, nouveaux contrôles sur le candidat réparé, nouvelle QA, dette ancienne laissée intacte.
- Refus à la publication d'un rapport persistant devenu contradictoire.
- Limite de réparation atteinte : arrêt explicite, aucun succès implicite.
- Chemins de preuve réels, distinction entre gravité et obligation, compatibilité des anciens rapports.
- Découverte d'un contrôle existant et obligatoire dans toutes les lanes, absence d'outil signalée, alias sans exécutions redondantes.
- UI Chromium en 1440 et 390 pixels : « Correction requise » et « Observation », sans erreur JavaScript ni débordement horizontal. Inspection visuelle de la capture mobile.

Les [observations navigateur](browser-results.json) complètent les contrôles automatisés.

Le script [ui-check.mjs](ui-check.mjs) utilise `PLAYWRIGHT_MODULE` et `CHROMIUM_EXECUTABLE` pour une installation locale existante. Les captures de cette exécution sont dans `/tmp/apv2-qa-cleanup-ui`. Il ne télécharge rien et utilise des données fictives.

La détection sémantique du code mort reste assurée par les outils configurés et la revue. Le contrôleur impose l'obligation déclarée, sans prétendre comprendre universellement les usages dynamiques. Les rapports historiques ne sont pas requalifiés automatiquement.
