# Validation — corrections QA obligatoires

État de travail local du 19 septembre 2026, basé sur `484cf52`, avec les modifications non commitées préexistantes. Aucun appel fournisseur, aucune modification de `project-test`.

Après correction et compilation finale : **63 tests ciblés réussis** (61 contrats/qualité/nettoyage et 2 reprises historiques), zéro échec. Le schéma QA exporté correspond au schéma du runtime ; `git diff --check` et la syntaxe JavaScript passent. Le typage et le lint CSS avaient également réussi pendant la suite complète.

La première suite complète a donné **505/508**. Deux échecs provenaient des fixtures reconnaissant la réparation par le préfixe de sa consigne ; ce préfixe a été conservé. Le troisième utilisait une compilation antérieure à l'ajout de l'alias `deadcode` ; une nouvelle compilation et le test de découverte passent. Les trois tests concernés figurent dans les relances finales réussies. La validation avant fusion a ensuite rejoué la suite complète : **508/508 tests réussis**, typage et lint CSS inclus. Le contrôle du paquet installé hors ligne passe également. Voir le [journal final](final-check.log) et le [résultat du paquet](package-result.json).

Scénarios vérifiés :

- Refus d'un `pass` avec un constat mineur dont la correction est requise, y compris sans mode evidence.
- Suppression réelle d'un helper dans une fixture, nouveaux contrôles sur le candidat réparé, nouvelle QA, dette ancienne laissée intacte.
- Refus à la publication d'un rapport persistant devenu contradictoire.
- Limite de réparation atteinte : arrêt explicite, aucun succès implicite.
- Chemins de preuve réels, distinction entre gravité et obligation, compatibilité des anciens rapports.
- Découverte d'un contrôle existant et obligatoire dans toutes les lanes, absence d'outil signalée, alias sans exécutions redondantes.
- UI Chromium en 1440 et 390 pixels : « Correction requise » et « Observation », sans erreur JavaScript ni débordement horizontal. Inspection visuelle de la capture mobile.

Preuves : [résumé et empreintes](summary.json), [tests ciblés](targeted.log), [reprises](compatibility.log), [première suite complète](initial-check.log), [navigateur](browser-results.json).

Le script [ui-check.mjs](ui-check.mjs) utilise `PLAYWRIGHT_MODULE` et `CHROMIUM_EXECUTABLE` pour une installation locale existante. Les captures de cette exécution sont dans `/tmp/apv2-qa-cleanup-ui`. Il ne télécharge rien et utilise des données fictives.

La détection sémantique du code mort reste assurée par les outils configurés et la revue. Le contrôleur impose l'obligation déclarée, sans prétendre comprendre universellement les usages dynamiques. Les rapports historiques ne sont pas requalifiés automatiquement.
