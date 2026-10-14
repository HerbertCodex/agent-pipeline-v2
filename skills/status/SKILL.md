---
name: status
description: "Où en est le projet APV : specs, tâches et branches, PR, verrous, quota, aperçu vivant. À utiliser quand l'opérateur demande l'état d'avancement, au début d'une session de pilotage, ou avant de décider de la vague suivante."
argument-hint: "[spec]"
allowed-tools: Read Glob Grep Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js lock status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js run status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js run next*) Bash(apv status*) Bash(apv run status*) Bash(apv run next*) Bash(apv lock status*) Bash(git worktree list*) Bash(git status*) Bash(git log*) Bash(gh pr list*) Bash(gh pr view*)
---

# /apv:status

1. Lance l'outil, sortie lue en entier :
   `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js status $ARGUMENTS`
   (ou `apv status $ARGUMENTS` si `apv` est sur le PATH).
   Pour les exécutions de specs (`/apv:run`) : `apv run status` (toutes) ou `apv run status <spec>`, et `apv run next <spec>` pour la prochaine action.
2. Si la sous-commande n'existe pas dans la version installée, ou si `.apv/` est absent, reconstitue l'état toi-même, en lecture seule :
   - `.apv/state/resume.md`, les plans `.apv/state/plan-*.md` et les fichiers de corrections, la liste `.apv/specs/` ;
   - `git worktree list`, `git status`, `git log --oneline -5` sur les branches de spec ;
   - `gh pr list --state open --json number,title,baseRefName,headRefName,isDraft,url` ;
   - `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js lock status` ;
   - dernière ligne de `.apv/state/quota.log` (pour un relevé frais : `/apv:quota`) ;
   - aperçu vivant : adresse et branche déclarées dans `.apv/config`.
   Si `.apv/` n'existe pas : dis que le projet n'est pas encore sous APV (initialisation : `/apv:init` ; projet existant ou V2 : `/apv:onboard`).
3. Explique le résultat à l'opérateur, dans sa langue, en quelques lignes :
   - par spec : étape (données, spec, plan, vague n, intégration, revues, corrections, PR), branches, PR et leur base, contrôles connus ;
   - ce qui bloque et pourquoi ; décisions qui l'attendent ;
   - quota (dernier relevé, heure du relevé) et verrous tenus ou expirés ;
   - prochaine action recommandée.
   - **À la question « je dois faire quoi ? »** la liste est COMPLÈTE, jamais seulement ce que `apv status` affiche : (1) les notes de reprise (`.apv/state/resume.md` et les fichiers de pilotage déclarés dans `freshness.paths`) ; (2) les actions ouvertes de la page de suivi du projet (le fichier ou l'artefact que le projet tient à jour, nommé dans `.apv/brief.md` ou `resume.md`) ; (3) les questions ouvertes de chaque spec en brouillon (`questions` de `.apv/specs/*.json`). Chaque ligne dit ce qui est attendu de l'opérateur et ce qui est à toi.
4. N'invente rien : une source illisible ou absente est signalée comme telle. Aucun tiret cadratin ni demi-cadratin dans ta réponse.
