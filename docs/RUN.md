# Exécuter une spec avec APV3

Ce guide décrit une exécution complète, de la spec validée à la PR brouillon, puis la fusion d'une pile de PR. La procédure que suit le chef de projet est la commande `/apv:run` (`skills/run/SKILL.md`) ; la méthode d'ensemble est la compétence `chef-de-projet`. Spécification : sections 6, 8 et 9 de [APV3-SPEC.md](APV3-SPEC.md).

Dans ce guide, `apv` désigne l'outil du plugin (`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"`, ou `apv` s'il est sur le PATH) et `<id>` l'identifiant de la spec (`.apv/specs/<id>.json`).

## 1. Avant l'exécution

| Étape | Commande | Résultat |
|---|---|---|
| Projet sous APV | `/apv:init` | `.apv/` créé par `apv init` sans rien écraser, contrôles du dépôt déclarés dans `.apv/config.json`, consigne commune `.apv/brief.md`, registre des décisions, commit proposé |
| Maquettes | `/apv:design` | chaque écran de la spec a une maquette validée par l'opérateur (`apv design list`) |
| Spec | `/apv:spec` | `.apv/specs/<id>.json` rédigée par `apv:product` et `apv spec validate` à `VALID` |

Une spec fournie et validée par l'opérateur s'exécute telle quelle.

## 2. Déroulé de `/apv:run`

| Étape de l'état | Qui | Ce qui se passe | Fin de l'étape |
|---|---|---|---|
| (démarrage) | chef de projet | `apv spec validate`, `apv quota`, `apv run start <spec> --base <base>`, branche `apv/<id>` créée depuis la base, spec commitée dessus | état créé |
| `data-model` | `apv:architecte-donnees` (conception) | `.apv/data-model.md`, présenté à l'opérateur avant tout code | `done --commit`, ou `skipped` si la spec ne touche pas la base |
| `plan` | `apv:architecte` | `.apv/state/plan-<id>.md` et `notes-<id>-vague-<n>.md` sur les vagues calculées par l'outil | `done --commit` |
| tâches de fondation | un seul `apv:implementer` pour les fondations prêtes d'une vague | les fondations (tâches dont au moins deux autres dépendent : modules partagés), marquées par l'outil | `task:<tâche> done --commit` |
| autres tâches | un `apv:implementer` par tâche prête, en parallèle | chacun dans son worktree, sur sa branche `apv/<id>-<tâche>`, avec les contrôles de tâche (`apv gates run --stage task`) et ses seuls fichiers e2e | `task:<tâche> done --commit` |
| `integration` | `apv:integrateur` (ou avance rapide pour une tâche seule) | dès que des tâches sont finies et vérifiées : branche `apv/<id>-integration-<n>`, doublons unifiés, contrôles de tâche ; le chef de projet passe la suite complète sur la tête intégrée et `apv gates verify` ; la branche de la spec avance en avance rapide seulement sur une vérification à `0` | `done` une fois toutes les tâches intégrées |
| `reviews` | `/apv:review` | sécurité, fidélité, données, RGPD en parallèle, en lecture seule, sur copies détachées ; constats consolidés | `review:<domaine> done` puis `reviews done` |
| `fixes` | `apv:implementer` par domaine | corrections décidées dans `.apv/state/corrections-<id>.md` | `done`, ou `skipped` sans constat à corriger |
| `delivery` | chef de projet | suite complète et `apv gates verify` sur la tête exacte, push, PR brouillon, aperçu | `done --note "PR #<n>"` |

Une tâche part **dès qu'elle est prête**, pas vague par vague : ses dépendances sont `done` et le commit enregistré de chacune est intégré dans `apv/<id>` (ancêtre de sa tête, `git merge-base --is-ancestor` ; la base de l'exécution tient lieu de tête tant que la branche n'existe pas). `apv run next` donne les tâches prêtes et, à part, celles « en attente d'intégration » ; `apv run set <id> task:<tâche> running` refuse une tâche dont une dépendance n'est pas intégrée, sauf `--force-unintegrated` avec une `--note` obligatoire, journalisée. Une tâche finie et vérifiée s'intègre donc sans attendre la fin de sa vague : c'est ce qui libère les tâches qui en dépendent, et elles partent de cette tête.

## 3. L'état d'exécution

`apv run start` crée `.apv/state/run-<id>.json`, écrit de façon atomique sous le verrou `run:<id>` de `apv lock`. Il contient : la spec (identifiant, fichier, empreinte sha256), la base, la branche `apv/<id>`, les dates, les étapes (`data-model`, `plan`, `integration`, `reviews`, `fixes`, `delivery`), les vagues (couches des dépendances), les tâches (statut, vague, marqueur de fondation, branche, worktree, agent, commit, note), les revues par domaine et un journal d'événements horodatés.

Statuts : `pending`, `running`, `done`, `failed`, `skipped`.

| Commande | Rôle |
|---|---|
| `apv run start <spec> [--base <branche>]` | valide la spec (même logique que `apv spec validate`), calcule les vagues, crée l'état ; refuse si l'état existe déjà |
| `apv run set <id> <cible> <statut> [--branch] [--worktree] [--agent] [--commit] [--base] [--findings] [--note]` | une transition : cible = une étape, `task:<tâche>` ou `review:<domaine>` (`securite`, `fidelite`, `donnees`, `rgpd`). Une tâche ne passe `running` que si ses dépendances sont `done` ; `done` exige `--commit` pour une tâche |
| `apv run next <id>` | ce qu'il faut faire maintenant, de façon déterministe : étape courante, tâches prêtes (dépendances faites et intégrées), tâches en attente d'intégration, tâches `running` à reprendre (branche, worktree, agent, dernier commit), tâches « à relancer » (worktree disparu ou aucun commit après la base), revues à lancer |
| `apv run status [<id>]` | résumé de toutes les exécutions ou d'une seule ; `apv status` affiche aussi une ligne par exécution en cours |

Toutes acceptent `--json`. Codes de sortie : `0` succès, `1` refus (transition interdite, état existant, spec invalide), `2` appel incorrect.

Règles :
- l'état ne s'écrit que par l'outil ; une transition refusée se corrige par l'ordre des actions, jamais par une édition du fichier ;
- le chef de projet est le seul à écrire l'état : les agents et les workflows rendent leurs rapports, lui les vérifie puis les enregistre ;
- l'état est commité avec les notes de reprise (`resume.md`) aux points de sauvegarde.

## 4. Vagues parallèles

### Workflows du plugin
Claude Code accepte des workflows dans un plugin (dossier `workflows/` à la racine, [référence des plugins](https://code.claude.com/docs/en/plugins-reference.md), [workflows](https://code.claude.com/docs/en/workflows.md)) : des scripts JavaScript qui commencent par `export const meta = { name, description, phases }`, littéral pur, puis orchestrent des sous-agents par `agent()`, `pipeline()`, `parallel()`, `phase()` et `log()`, avec leurs paramètres dans `args`. Ils tournent en arrière-plan (`/workflows` pour suivre), se reprennent dans la même session et se mettent en pause d'eux-mêmes à la limite d'usage (Claude Code 2.1.271 ou plus récent, session interactive). Ceux d'un plugin s'appellent `/<plugin>:<nom>`.

| Workflow | Lancé par | Ce qu'il fait |
|---|---|---|
| `apv:vague` (`workflows/vague.js`) | `/apv:run` | un `apv:implementer` par tâche, chacun en `isolation: worktree`, avec la consigne de démarrage (`git switch -c <branche> <commit de base>` ou reprise de la branche existante, marqueur `.apv/state/task.json`), la fin de tâche (contrôles de tâche et fichiers e2e touchés, commits, `apv scope check`) et un rapport structuré (statut, branche, worktree, commit, contrôles, périmètre) |
| `apv:revues` (`workflows/revues.js`) | `/apv:review` | un agent de revue par domaine (`apv:qa-securite`, `apv:qa-fidelite`, `apv:architecte-donnees`, `apv:dpo`) sur sa copie détachée, rapport structuré, puis un passage de dédoublonnage qui ne supprime aucun constat |

Le chef de projet les lance par l'outil Workflow avec `name: "apv:vague"` ou `name: "apv:revues"` et `args` (nom vérifié avec Claude Code 2.1.280 : le runtime trouve le workflow du plugin et exécute le script). Les deux refusent de démarrer sans leurs paramètres : ce ne sont pas des commandes à lancer seules. Paramètres attendus : section 4 de `skills/run/SKILL.md` et section 4 de `skills/review/SKILL.md`.

### Sans workflow
Quand l'outil Workflow n'est pas disponible (désactivé par `disableWorkflows`, version trop ancienne) ou quand le chef de projet veut parler à chaque agent pendant son travail, il lance plusieurs agents par l'outil Agent, **plusieurs appels dans un même message**, chacun en arrière-plan (`run_in_background: true`), avec le même message que le workflow. Les fondations d'une vague, confiées à un seul agent, et une tâche lancée seule passent toujours par l'outil Agent.

### Vérifications du chef de projet, tâche par tâche
1. Branche : `git log --oneline <base>..<branche>`, fichiers touchés.
2. `apv scope check --spec <spec> --task <tâche> --base <commit de base> --repo <worktree>`.
3. `apv run set <id> task:<tâche> done --commit <sha> --worktree <chemin>`, ou `failed --note "<cause>"`.

### Contrôles : par tâche et suite complète

Premier `/apv:run` réel (« Toujours rien », spec `conformite-rgpd`, 95 minutes) : chaque implementer lançait tous les contrôles, Playwright compris, et plusieurs fois ; la suite navigateur, environ 4 minutes sous le verrou partagé `e2e`, a tourné une vingtaine de fois, les agents s'attendant les uns les autres. Les contrôles se répartissent donc en deux temps.

| Qui | Quand | Commande |
|---|---|---|
| implementer (et intégrateur) | fin de chaque tâche | `apv gates run --stage task --base <base>`, puis, sous `apv lock run e2e -- <commande du projet>`, les seuls fichiers de tests e2e créés ou modifiés (par exemple `npx playwright test <fichiers>`) |
| chef de projet | chaque intégration, avant d'avancer `apv/<id>` et d'ouvrir les tâches suivantes | `apv gates run --stage full --repo <worktree>` sur la tête intégrée, arbre propre, puis `apv gates verify --commit <tête> --repo <worktree>` |
| chef de projet | livraison, avant de pousser | la même chose sur la tête finale, dans un worktree propre |
| revues | après l'intégration | aucune relance de la suite complète ni de Playwright, sauf besoin précis de leur domaine : elles citent les reçus de la suite complète de ce commit |

Configuration : dans `.apv/config.json`, un contrôle long déclare `"stage": "full"` (la suite navigateur complète, par exemple) ; les autres restent `task`, la valeur par défaut. Un projet sans contrôle marqué garde le comportement antérieur : `--stage task` exécute tout. Détails des options et des reçus : [CLI.md](CLI.md#apv-gates-run).

**Rien ne passe pour autant.** Une vague n'est acceptée (avance rapide de `apv/<id>`) et une PR n'est ouverte que sur une suite complète verte **au commit exact** : `apv gates verify` sort en `0` seulement si le reçu le plus récent de chaque contrôle déclaré a réussi sur ce commit, arbre propre, avec la configuration actuelle ; un contrôle réservé n'est jamais compté comme réussi, et un échec plus récent l'emporte sur une réussite plus ancienne. Une suite complète rouge ouvre une passe de corrections, jamais ignorée. Seul le moment de la détection change : un test navigateur cassé par une tâche sans toucher à ses fichiers e2e est détecté à l'intégration de la vague au lieu de la fin de la tâche, et corrigé avant que quoi que ce soit n'avance.

## 5. Quota

`apv quota` avant chaque vague, avant les revues et toutes les 10 à 15 minutes. Niveaux : `ok` (moins de 70 %), `slow_down` (70 % : moins d'agents, revues en mode économe), `finish_only` (85 % : finir sans rien lancer), `save_now` (95 % : sauvegarde). La consommation observée par vague sert de repère pour doser la suivante, jamais de plafond.

Sauvegarde : chaque agent commite son état en `wip`, ou le chef de projet l'arrête et commite le wip de son worktree ; les branches sont poussées sans force ; `.apv/state/resume.md` note les branches, les derniers commits, les agents ou le `runId` du workflow et l'ordre de reprise ; l'opérateur est prévenu avec l'heure de remise à zéro.

## 6. Reprise après interruption

Une exécution se reprend toujours par `apv run next <id>` : `/apv:run <id>` commence par là quand l'état existe et ne relance jamais `apv run start`. Après un redémarrage de la machine, `/apv:resume` remet d'abord l'environnement en marche (Docker, piles locales, verrous et processus orphelins).

| Situation que montre `apv run next` | Reprise |
|---|---|
| tâche `running`, agent vivant dans la session | `SendMessage` à son identifiant |
| vague lancée par workflow, interrompue dans la même session | relance du workflow avec `resumeFromRunId` : les agents terminés rendent leur résultat enregistré |
| tâche `running` avec worktree et commits, agent perdu | wip commité dans le worktree s'il en reste, worktree retiré (`git worktree remove`) pour libérer la branche, nouvel implementer qui reprend la branche : « termine <tâche> à partir du wip <sha> » |
| tâche « à relancer » (worktree disparu ou aucun commit après la base) | nouvel implementer ; si la branche existe, il la reprend telle quelle |
| étape `plan`, `integration`, `fixes` ou `delivery` interrompue | reprise au début de l'étape, avec ce qui est déjà commité |
| revue interrompue | la revue du domaine se relance entière |

Aucun commit déjà poussé n'est réécrit pendant une reprise : on empile des commits propres.

### Simuler une interruption (essai d'acceptation)
1. Lancer `/apv:run <id>` sur une spec à au moins deux tâches parallèles.
2. Pendant la vague, une fois que chaque agent a commité au moins une fois, fermer la session Claude Code (ou arrêter la machine).
3. Rouvrir une session dans le dépôt : le hook de démarrage affiche l'état de reprise ; `/apv:resume`, puis `/apv:run <id>`.
4. Attendu : `apv run next <id>` liste les tâches `running` avec leur branche, leur worktree et leur dernier commit ; le chef de projet reprend chacune sur sa branche sans perdre de commit ni en réécrire, puis l'exécution va jusqu'à la PR brouillon.

## 7. Pile de PR

Une spec qui dépend d'une spec précédente non fusionnée part de sa branche : `apv run start <spec> --base apv/<id-précédent>`, et sa PR vise cette branche (`gh pr create --draft --base apv/<id-précédent>`). Une correction faite plus bas dans la pile remonte par fusion, jamais par réécriture.

La pile se fusionne **uniquement sur ordre explicite de l'opérateur**, par `/apv:stack <pr...>` :

1. `apv stack plan <pr...>` lit chaque PR (`gh pr view`) et vérifie la pile : chaque PR ouverte, la base de la PR n+1 est la tête de la PR n (la première vise la branche cible), fusionnable, contrôles au vert ou absents. Sa sortie est montrée en entier à l'opérateur.
2. `APV_ALLOW_MERGE=1 apv stack merge <pr...> [--method merge|squash|rebase] [--ready] [--target <branche>]` refait la vérification **juste avant chaque fusion**, re-cible la PR suivante sur la base finale quand la précédente est fusionnée, vérifie le résultat par une relecture (jamais par le seul code de sortie), affiche en entier la sortie de chaque appel `gh` et s'arrête à la première anomalie avec un rapport.
3. Une PR brouillon (celles de `/apv:run`) est une anomalie sans `--ready`, qui retire le statut brouillon juste avant chaque fusion ; `--target` fixe la branche d'arrivée (par défaut la base de la première PR).
4. Le hook du plugin bloque `apv stack merge` (comme `gh pr merge`) sans `APV_ALLOW_MERGE=1` posé devant la commande.

C'est la réponse à l'incident 30 du projet pilote : des re-ciblages masqués avaient échoué en silence et chaque PR avait été fusionnée dans la branche de la précédente au lieu de la branche principale.

## 8. Ce que l'exécution ne fait jamais

- Fusionner une PR (seul `/apv:stack`, sur ordre de l'opérateur), déployer, force-push, réécrire un commit poussé, écrire sur une base hébergée ou de production.
- Masquer la sortie d'une commande qui écrit sur un service externe.
- Déclarer un résultat, une approbation ou une maquette validée qu'elle n'a pas observés : les contrôles relancés par le chef de projet font foi, pas les rapports d'agents.
