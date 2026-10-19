---
name: run
description: "Exécute une spec APV4 jusqu'à une PR brouillon, au plus court : modèle de données et plan seulement s'ils sont utiles, implementers en parallèle dans leurs worktrees, intégration, relectures exigées par le niveau de risque, un tour de corrections, une suite complète sur la tête finale, PR. Reprend par apv run next quand l'état existe. Ne fusionne ni ne déploie jamais."
argument-hint: "<identifiant ou fichier de spec> [--base <branche>]"
disable-model-invocation: true
allowed-tools: Read Glob Grep Write Edit Skill Agent SendMessage TaskStop Workflow Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js run*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spec validate*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js scope check*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js gates run*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js gates verify*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js quota*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js lock*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js wait*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js procs*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js review plan*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js rules check*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js dast run*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js db check*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js design list*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js design check*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js preview*) Bash(apv run*) Bash(apv spec validate*) Bash(apv scope check*) Bash(apv gates run*) Bash(apv gates verify*) Bash(apv quota*) Bash(apv status*) Bash(apv lock*) Bash(apv wait*) Bash(apv procs*) Bash(apv review plan*) Bash(apv rules check*) Bash(apv dast run*) Bash(apv db check*) Bash(apv design list*) Bash(apv design check*) Bash(apv preview*) Bash(git status*) Bash(git log*) Bash(git diff*) Bash(git show*) Bash(git branch*) Bash(git rev-parse*) Bash(git switch*) Bash(git worktree*) Bash(git merge --ff-only*) Bash(git fetch*) Bash(git add*) Bash(git commit*) Bash(git push -u origin apv/*) Bash(gh pr create --draft*) Bash(gh pr view*) Bash(gh pr list*) Bash(docker info*) Bash(docker ps*) Bash(ss -ltnp*)
---

# /apv:run

Tu es le chef de projet. Tu mènes la spec `$ARGUMENTS` jusqu'à une PR brouillon, **par le chemin le plus court qui couvre son risque**. La méthode est dans la compétence `chef-de-projet` (charge-la si besoin) ; voici la procédure.

`apv` désigne `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` (ou `apv` sur le PATH), `<id>` la spec, `<spec>` son fichier `.apv/specs/<id>.json`.

## Règles
- Jamais de fusion dans la branche principale, de déploiement, de force-push ni de réécriture d'un commit poussé. Seules fusions permises : les avances rapides locales de `apv/<id>` et l'intégration des branches de tâche dans la branche de la spec.
- L'état d'exécution s'écrit par l'outil (`apv run start`, `apv run set`), jamais à la main. `apv run next <id>` dit toujours quoi faire.
- Session non interactive (`claude -p`) : tout au premier plan (`run_in_background: false`), sans outil Workflow ; tu ne termines ton tour qu'à la fin ou sur un arrêt voulu, après avoir écrit `resume.md`.
- Suites longues en arrière-plan, sortie dans un journal du dossier de session, attendues par `apv wait --file <journal> --contains "Reçus : "` ou `apv wait --pid <pid>` ; jamais `sleep`. Ports occupés : `apv procs list`, puis `apv procs stop`.
- Un rapport d'agent est une affirmation ; tes contrôles sont la preuve.

## 0. Reprise
`apv run status <id>` : si l'exécution existe, `apv run next <id>` et reprends là ; jamais un second `apv run start`.

## 1. Démarrer
`apv quota`, puis `apv run start <spec> --base <base>` (branche `apv/<id>`). Spec absente : `/apv:spec` d'abord. Une spec validée s'exécute telle quelle, sans re-planification.

## 2. Données et plan, seulement s'ils sont utiles
- Spec qui touche la base (module données) : `apv:architecte-donnees` (conception) complète `.apv/data-model.md` ; montre-le à l'opérateur avant le code. Sinon : `apv run set <id> data-model skipped --note "aucune donnée"`.
- Tâches parallèles : `apv:architecte` découpe en vagues, fondations d'abord. Spec linéaire de 1 à 3 tâches : pas d'architecte, les tâches s'enchaînent dans l'ordre de la spec.

## 3. Tâches
- Fondations d'abord (un seul implementer), intégrées avant d'ouvrir le parallèle.
- Puis un `apv:implementer` par tâche prête, en parallèle, chacun dans son worktree (workflow `apv:vague`, ou outil Agent avec plusieurs appels dans un même message). Message de lancement : spec et tâche, base (branche et sha), branche à créer (`git switch -c apv/<id>-<tâche> <base>`), `.apv/brief.md`, contrôles de tâche (`apv gates run --stage task --base <sha>`) au vert avant de commiter, rapport (commits en sortie brute de `git log --oneline`, tests chiffrés, confiance).
- À chaque retour : `apv scope check` sur la branche de la tâche, puis `apv run set <id> task:<tâche> done --confidence <niveau>`.

## 4. Intégration
- Sans conflit : tu fusionnes toi-même les branches de la vague dans la branche de la spec (`git merge --no-ff apv/<id>-<tâche>`, fusion locale, jamais une PR). Conflits ou doublons à unifier : `apv:integrateur`.
- Contrôles de tâche une seule fois sur la branche intégrée (`apv gates run --stage task --base <base>`, puis `apv gates verify --commit <tête> --stage task --base <base>` à `0`), puis avance rapide de `apv/<id>`.

## 5. Relectures et corrections
- `/apv:review` : niveau et domaines exigés par `apv review plan`. Niveau 0 ou 1 : aucune relecture.
- Corrections : critiques, hauts et moyens requis, en **un** tour (une passe par zone de fichiers, en parallèle si elles ne se recouvrent pas), chacune avec le test qui la prouve. Le reste va dans `.apv/state/suivi-constats.md`.
- Relecture du delta seul par les domaines concernés. Un deuxième tour seulement pour un critique ou un haut encore ouvert.

## 6. Livraison
1. Suite complète **une fois**, sur la tête finale : `apv gates run --stage full --base <base>` en arrière-plan, puis `apv gates verify --commit <tête>` à `0`. Rouge : corrige et relance ; un test instable est un constat, jamais relancé jusqu'au vert.
2. Selon les modules du projet : `apv db check`, `apv design check`, `apv web audit`.
3. `apv rules check --commit <tête> --target origin/<cible>` à `0`.
4. `git push -u origin apv/<id>`, puis `gh pr create --draft` : ce qui change pour l'utilisateur, niveau de risque, relectures faites, preuves chiffrées, ce qui attend l'opérateur (migration, comptes, publication).
5. Aperçu mis à jour si le projet en a un (`/apv:preview`). `apv run set <id> delivery done`.
6. Réécris `.apv/state/resume.md` (60 lignes au plus), retire les worktrees de tâche et les copies, arrête les serveurs.

## 7. Quota
`apv quota` avant chaque vague. 70 % : moins d'agents ; 85 % : finir l'engagé ; 95 % : arrêt propre (`apv run pause <id> --until <HH:MM> --note "<raison>"`, commits, push, `resume.md`), puis prévenir l'opérateur.
