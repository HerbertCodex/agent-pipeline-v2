# Plan p3-essai

Graphe de l'outil retenu : SUMMARY (fondation) ; HOOK après SUMMARY ; BIN sans dépendance ; DOCS après HOOK.

Lancement par disponibilité des dépendances : SUMMARY et BIN partent ensemble (fichiers disjoints : src/run, status, dist d'un côté ; bin, package.json, test de ressources de l'autre). HOOK part dès SUMMARY intégrée, DOCS dès HOOK intégrée.

Fichiers possédés :
- SUMMARY : src/run/summary.ts, src/commands/status.ts, test/run-summary.test.mjs, dist/ (seule tâche à recompiler dist en vague 0).
- BIN : bin/apv, package.json (champ files), test/bin-apv.test.mjs, test/plugin-assets.test.mjs. Ne recompile pas dist.
- HOOK : hooks/scripts/session-start.mjs, lib.mjs, tests du hook ; importe dist/run/summary.js.
- DOCS : README.md, docs/PLUGIN.md, CHANGELOG.md.

Point d'extension : summary exporte une fonction pure de lecture (racine du dépôt en entrée, tableau d'objets résumés et une fonction de mise en ligne), utilisable depuis un .mjs du hook.
