# Suivi groupé des constats faibles et conseils (agent-pipeline-v2)

## PR #110
- rgpd (20261003T154308Z-78bc2c6b), info : docs/*.md non servis, termes « gard », « information » absents (ex. « Nous gardons vos informations dix ans » reste faible) ; à ajouter si un projet publie sa documentation.
- donnees (20261003T154309Z-d34c3922), bas : pas de verrou par copie autour de npm ci de dast run ; suivi-constats.md écrit à la main sans verrou (commande atomique à prévoir).
- securite (20261003T154622Z-f405226e), conseil : *.spec.ts importé par du code serveur classé test (risque faible pour --since) ; variables réservées en liste d'interdiction incomplète (BASH_ENV, ENV, GIT_SSH_COMMAND, PYTHONPATH, npm_config_*, path) ; review plan lit la configuration de la tête (antérieur) ; info : evil.localhost admis, .claude/hooks/*.test.mjs classé test.
- fidelite (757c44b), bas : plan.ts WHY.strong, raison inexacte pour l'outillage hors dossier de tests ; info : dast run affiche « rapports » avant un refus DAST_ENV ; code-map contient « where » (mise à jour de carte = risque élevé).
- rgpd (20261003T155508Z-97c37a9f), info : docs/*.md neutral non servi sans terme « gard »/« information » reste faible.
- securite (20261003T155607Z-56315b3a), conseil : fichier de test importé par du code livré reste faible (src/lib/tests/rules.ts importé par src/lib/server/guard.ts, src/lib/server/rules.spec.ts).
- fidelite (703c432), bas : CLI.md « Fichier d'environnement » et CHANGELOG l.12 : préciser que *HOSTNAME et *SERVER_NAME restent des variables d'adresse.
- securite (20261003T160125Z-d2a308eb), conseil : http://localhost\@db.prod.example.com/ admis (new URL et urllib divergent) ; refuser une valeur qui contient à la fois \ et @.
- chef (2026-10-03), à corriger : rules check exige les captures de fidélité sur un projet sans interface web (PR #110, outil CLI) alors que la règle maquette dit « aucun écran » ; captures requises seulement si un écran change.
- 2026-10-03 vers 18 h, opérateur : « ok une commande par fichier dans src/commands » (écart flat-growth src/commands/tests.ts accepté, à inscrire au registre DECISIONS.json d'APV avec ces mots au prochain lot).
- test instable test/gates-suite.test.mjs:106 (attente 200 ms contre verrou de 1,2 s, échec sous charge) à traiter à part.
- tests APV : ~126 serveurs « net.createServer » de test (/tmp/apv3-test-*) laissés orphelins par la suite (fuite, depuis ~3 jours, écoute 127.0.0.1) ; non arrêtés (garde-fou kill/pgrep), à arrêter par l'opérateur ou un redémarrage, et à corriger dans les tests (arrêt garanti en after/finally).
- securite (#115, 20261003T172427Z-23b984f6), conseil : si apv structure check lit un jour les décisions du registre, ancrer leur citation dans le journal de l'opérateur.
- fidelite (#115), info : titre de .apv/DECISIONS.md généré avec un tiret cadratin (src/lifecycle/decisions.ts:236).
- donnees (#115, 20261003T173934Z-aa569575), à regarder : la règle controles lit isWebAt à la tête (check.ts:205) ; une branche qui retire le caractère web à la tête allège l'exigence des contrôles web ; lire à la base commune.
- securite (#115, 20261003T173952Z-52d4124a), conseil : docs/index.html modifié dans une CLI exige des captures alors que hasScreensAt ignore docs/** (DEFAULT_REUSE_IGNORE) ; appliquer le même filtre aux fichiers du diff.
