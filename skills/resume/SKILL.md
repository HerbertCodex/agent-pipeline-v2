---
name: resume
description: "Reprise après une coupure (session fermée, machine redémarrée, pause de quota) : lit l'état .apv/state, vérifie Docker puis les piles locales, les verrous et processus orphelins, liste les branches et agents à reprendre, relève le quota et propose l'ordre de reprise. À utiliser au début d'une session qui continue un travail APV interrompu."
allowed-tools: Read Glob Grep Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js lock status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js quota*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js run status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js run next*) Bash(apv status*) Bash(apv run status*) Bash(apv run next*) Bash(apv lock status*) Bash(apv quota*) Bash(docker info*) Bash(docker ps*) Bash(git worktree list*) Bash(git status*) Bash(git log*) Bash(git branch -vv*) Bash(git fetch*) Bash(gh pr list*) Bash(ss -ltnp*)
---

# /apv:resume

Suis ces étapes dans l'ordre, sortie de chaque commande lue en entier. `apv` désigne `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js` si `apv` n'est pas sur le PATH. Détails : compétence `chef-de-projet`, `references/reprise-environnement.md`.

1. **État** : lis `.apv/state/resume.md` (notes de reprise), le plan et les notes de la vague en cours, la fin de `.apv/state/journal.log` et de `.apv/journal-pipeline.md`. Lance `apv status`, puis `apv run status` et, pour chaque exécution en cours, `apv run next <spec>` : étape courante, tâches prêtes, tâches à reprendre (branche, worktree, agent, dernier commit) ou à relancer, revues à lancer. Une fois l'environnement remis (étapes 2 à 7), la reprise d'une exécution se mène par `/apv:run <spec>`, qui commence toujours par `apv run next`.
2. **Docker** : `docker info`. S'il ne répond pas, relance-le (sous WSL avec Docker Desktop : lancer l'exécutable Windows de Docker Desktop depuis WSL ; ailleurs : le service du système), puis attends qu'il réponde avant d'aller plus loin.
3. **Piles locales** : pour chaque pile déclarée par le projet (tests, aperçu), vérifie son état (par exemple `npx supabase status` dans son dossier, avec la version épinglée du projet) et relance-la si besoin avec la commande du projet. Ne touche jamais une pile qui n'appartient pas au projet.
4. **Verrous et orphelins** : `apv lock status` (baux expirés, propriétaires morts, file d'attente) ; `ss -ltnp` pour les ports des tests et de l'aperçu. N'arrête que ce que le projet a lancé.
5. **Git** : `git worktree list`, `git branch -vv`, `git fetch` ; pour chaque worktree de tâche, `git status` et `git log -1` : travail non commité, commits non poussés, wip à terminer.
6. **À reprendre** : dresse la liste, dans l'ordre de reprise des notes :
   - tâches et leur agent (identifiant s'il est connu) : reprise par `SendMessage` si l'agent vit encore, sinon nouvel `implementer` sur la branche avec « termine <tâche> à partir du wip <hash>, vérifie tout, tous les contrôles » ;
   - revues interrompues à relancer ;
   - PR à ouvrir ou à mettre à jour ;
   - aperçu à remettre à jour.
7. **Quota** : `apv quota`, puis nombre d'agents à relancer selon les seuils (70, 85, 95 %).
8. **Compte rendu** à l'opérateur, dans sa langue, en quelques lignes : ce qui était en cours, l'état de l'environnement, ce que tu relances et dans quel ordre. Puis relance, et mets `.apv/state/resume.md` à jour. Note l'interruption au journal du pipeline.

Ne réécris jamais un commit déjà poussé pendant la reprise : on empile des commits propres. Aucun tiret cadratin ni demi-cadratin dans ta réponse.
