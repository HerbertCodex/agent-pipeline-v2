# Revues p3-essai, commit fe3fa48

Domaines revus : sécurité (qa-securite), fidélité (qa-fidelite). Écartés : données (aucune base ni requête), RGPD (aucune donnée personnelle). Copies détachées nettoyées, aucun fichier suivi modifié.

| Id | Domaines | Gravité | Statut | Emplacement | Correction attendue |
|---|---|---|---|---|---|
| SEC-1 | sécurité | moyenne | requis | src/commands/status.ts (lignes État et Specs) | noms de fichiers et titres de spec passés par cleanLine (ANSI, OSC, sauts de ligne) |
| SEC-2 | sécurité | moyenne | requis | src/run/summary.ts readRunSummaries, hooks/scripts/session-start.mjs | plafond de fichiers lus et budget total d'octets, ligne « N autres non lus » ; le hook ne lit pas plus qu'il n'affiche |
| SEC-3 + FID-1 | sécurité, fidélité | moyenne | requis | bin/apv, test/bin-apv.test.mjs, spec SEC-BIN, CHANGELOG | risque résiduel déclaré (l'interpréteur vient du PATH par le shebang, NODE_OPTIONS honoré ; qui contrôle le PATH contrôle déjà git) ; commentaire corrigé ; test renommé pour dire ce qu'il vérifie |
| FID-3 | fidélité | faible | requis | CHANGELOG.md | entrée --commit sur étapes et revues (champ commit facultatif) |
| FID-2 | fidélité | moyenne | conseil retenu | src/commands/run.ts listRuns | passer par readRunSummaries et runSummaryLine (apv run status bloqué par une FIFO), retirer RunListing si inutile |
| SEC-4 | sécurité | faible | conseil retenu | session-start.mjs stateEntries | try/catch par entrée |
| SEC-5 | sécurité | faible | conseil retenu | src/run/state.ts, summary.ts | updatedAt ISO strict ; specId du contenu égal au nom du fichier, sinon ligne d'erreur ; chemins relatifs et sans extrait du contenu dans les erreurs |
| SEC-6 | sécurité | info | conseil retenu | src/run/state.ts applySet | remplacer le commit d'une cible déjà faite exige --note |
| FID-4 | fidélité | faible | conseil retenu | session-start.mjs RUNS_UNAVAILABLE | distinguer module non chargé et erreur de lecture |
| FID-5 | fidélité | faible | conseil retenu | src/commands/run.ts aide de run set | retour à la ligne comme les lignes voisines |
| FID-6 | fidélité | info | sans correction | .apv/state/run-p3-essai.json | état commité depuis (2ee733c) |

Non vérifié : chargement réel du plugin dans Claude Code, Windows, npm pack.
