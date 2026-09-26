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

**Des specs petites et larges plutôt qu'une longue chaîne.** Nuit du 24 au 25 septembre 2026 sur « Toujours rien » : une spec de 12 tâches et 65 critères, en chaîne de 5 couches (base, données, relances et documents, ajout et actions et fiche, liste et colonnes), a tourné environ 9 h, dont 2 h 30 de pause de quota (trois exécutions simultanées) et 3 h pour une seule intégration intermédiaire ; chaque couche attendait l'intégration de la précédente. `apv spec validate` avertit donc (sans refuser) au-delà de 6 tâches, 30 critères ou 3 couches de dépendances (section `spec` de `.apv/config.json`, [CONFIGURATION.md](CONFIGURATION.md#taille-des-specs--spec)), en nommant le chemin le plus long. Une demande large se découpe en plusieurs specs de 4 à 6 tâches, indépendantes quand c'est possible, livrées en parallèle, chacune avec sa PR, sur des piles de test distinctes quand le projet en déclare plusieurs. Dans une spec, le motif « contrats d'abord » : la première tâche pose les contrats partagés (types, schémas, signatures de fonctions, interfaces de composants, migrations) avec des implémentations minimales testées, et les tâches suivantes se construisent en parallèle contre eux ; une dépendance ne se déclare que si la tâche a besoin du code de l'autre, pas seulement de son existence future.

## 2. Déroulé de `/apv:run`

| Étape de l'état | Qui | Ce qui se passe | Fin de l'étape |
|---|---|---|---|
| (démarrage) | chef de projet | `apv spec validate`, `apv quota`, `apv run start <spec> --base <base>`, branche `apv/<id>` créée depuis la base, spec commitée dessus | état créé |
| `data-model` | `apv:architecte-donnees` (conception) | `.apv/data-model.md`, présenté à l'opérateur avant tout code | `done --commit`, ou `skipped` si la spec ne touche pas la base |
| `plan` | `apv:architecte` | `.apv/state/plan-<id>.md` et `notes-<id>-vague-<n>.md` sur les vagues calculées par l'outil | `done --commit` |
| tâches de fondation | un seul `apv:implementer` pour les fondations prêtes d'une vague | les fondations (tâches dont au moins deux autres dépendent : modules partagés), marquées par l'outil | `task:<tâche> done --commit` |
| autres tâches | un `apv:implementer` par tâche prête, en parallèle | chacun dans son worktree, sur sa branche `apv/<id>-<tâche>`, avec les contrôles de tâche (`apv gates run --stage task`) et ses seuls fichiers e2e | `task:<tâche> done --commit` |
| `integration` | `apv:integrateur` (ou avance rapide pour une tâche seule) | dès que des tâches sont finies et vérifiées : branche `apv/<id>-integration-<n>`, doublons unifiés, contrôles de tâche ; le chef de projet vérifie la tête intégrée au commit exact : contrôles de tâche et tests ciblés à une intégration intermédiaire, suite complète à la dernière (réglage `run.fullSuite`, section 4) ; la branche de la spec avance en avance rapide seulement sur une vérification à `0` | `done` une fois toutes les tâches intégrées |
| `reviews` | chef de projet, puis `/apv:review` | scan dynamique déclaré (`apv dast run`) lancé par le chef de projet ; puis sécurité, fidélité, données, RGPD en parallèle, en lecture seule, sur copies détachées dans le dossier de session ; constats consolidés | `review:<domaine> done` puis `reviews done` |
| `fixes` | `apv:implementer` par domaine | corrections décidées dans `.apv/state/corrections-<id>.md`, intégrées au niveau tâche avec le test qui prouve chaque correction | `done --confidence <niveau>`, ou `skipped` sans constat à corriger |
| `delivery` | chef de projet | suite complète prouvée sur la tête exacte (`apv gates verify` à `0`, relancée seulement si elle n'y est pas déjà), push, PR brouillon, aperçu | `done --note "PR #<n>"` |

Une tâche part **dès qu'elle est prête**, pas vague par vague : ses dépendances sont `done` et le commit enregistré de chacune est intégré dans `apv/<id>` (ancêtre de sa tête, `git merge-base --is-ancestor` ; la base de l'exécution tient lieu de tête tant que la branche n'existe pas). `apv run next` donne les tâches prêtes et, à part, celles « en attente d'intégration » ; `apv run set <id> task:<tâche> running` refuse une tâche dont une dépendance n'est pas intégrée, sauf `--force-unintegrated` avec une `--note` obligatoire, journalisée. Une tâche finie et vérifiée s'intègre donc sans attendre la fin de sa vague : c'est ce qui libère les tâches qui en dépendent, et elles partent de cette tête.

## 3. L'état d'exécution

`apv run start` crée `.apv/state/run-<id>.json`, écrit de façon atomique sous le verrou `run:<id>` de `apv lock`. Il contient : la spec (identifiant, fichier, empreinte sha256), la base, la branche `apv/<id>`, les dates, les étapes (`data-model`, `plan`, `integration`, `reviews`, `fixes`, `delivery`), les vagues (couches des dépendances), les tâches (statut, vague, marqueur de fondation, branche, worktree, agent, commit, note, niveau de confiance quand il est noté), les revues par domaine et un journal d'événements horodatés.

Statuts : `pending`, `running`, `done`, `failed`, `skipped`.

| Commande | Rôle |
|---|---|
| `apv run start <spec> [--base <branche>]` | valide la spec (même logique que `apv spec validate`), calcule les vagues, crée l'état ; refuse si l'état existe déjà |
| `apv run set <id> <cible> <statut> [--branch] [--worktree] [--agent] [--commit] [--base] [--findings] [--confidence] [--note]` | une transition : cible = une étape, `task:<tâche>` ou `review:<domaine>` (`securite`, `fidelite`, `donnees`, `rgpd`). Une tâche ne passe `running` que si ses dépendances sont `done` ; `done` exige `--commit` pour une tâche. `--commit` et `--base` acceptent un sha complet ou abrégé, ou une branche : l'outil les résout par git et affiche le sha complet. `--confidence prouve\|probable\|suppose` avec `done`, pour une tâche ou `fixes` |
| `apv run next <id>` | ce qu'il faut faire maintenant, de façon déterministe : étape courante, tâches prêtes (dépendances faites et intégrées), tâches en attente d'intégration, tâches `running` à reprendre (branche, worktree, agent, dernier commit), tâches « à relancer » (worktree disparu ou aucun commit après la base), revues à lancer, travail fait noté en dessous de `prouve` (`unproven`) |
| `apv run status [<id>]` | résumé de toutes les exécutions ou d'une seule ; `apv status` affiche aussi une ligne par exécution en cours |

Toutes acceptent `--json`. Codes de sortie : `0` succès, `1` refus (transition interdite, état existant, spec invalide), `2` appel incorrect.

Règles :
- l'état ne s'écrit que par l'outil ; une transition refusée se corrige par l'ordre des actions, jamais par une édition du fichier ;
- le chef de projet est le seul à écrire l'état : les agents et les workflows rendent leurs rapports, lui les vérifie puis les enregistre ;
- l'état est commité avec les notes de reprise (`resume.md`) aux points de sauvegarde ;
- l'état vit dans le checkout de l'exécution, celui où `apv run start` l'a créé (sur `apv/<id>`) ; plusieurs exécutions peuvent tourner côte à côte, chacune dans son worktree. Depuis un checkout qui n'a pas l'état, `apv run` et `apv gates run` le trouvent dans les autres worktrees du dépôt (plusieurs copies : celle du worktree sur `apv/<id>`, sinon celle du checkout principal, sinon refus `RUN_AMBIGUOUS`) ; un checkout qui a sa propre copie (versionnée, venue avec un commit), `apv run` la lit : lance-le depuis le checkout de l'exécution.

### Exécution détachée et suivi

Une exécution lancée dans une autre session (`claude -p "/apv:run <id>"`, depuis la session du chef de projet ou un terminal) doit être **détachée** : un processus lancé en tâche de fond du shell (`&` seul) appartient à la session qui l'a lancé et s'arrête avec elle. Nuit du 23 au 24 septembre 2026 sur « Toujours rien » : l'exécution `statut-a-envoyer`, lancée ainsi, a été coupée en vague 2 à la fin de la session du chef de projet ; relancée détachée, elle a survécu. `setsid` la place dans une nouvelle session sans terminal, `nohup` la protège de SIGHUP, et ses entrées et sorties ne dépendent plus du shell :

```sh
setsid nohup sh -c 'echo "pid $$"; exec claude -p "/apv:run <id>" --plugin-dir <plugin> --output-format stream-json --verbose' \
  > .apv/state/session-<id>.log 2>&1 < /dev/null &
```

La première ligne du journal donne le pid (`exec` garde le même processus) ; `.apv/state/*.log` n'est jamais commité. La session détachée suit les règles des sessions non interactives de `/apv:run` (agents au premier plan, pas d'outil Workflow).

**Suivi par moniteur, pas par relevés espacés.** Le chef de projet qui surveille cette exécution réagit à chaque changement de `.apv/state/run-<id>.json` (toute transition passe par `apv run set`) et à la fin du processus, au lieu de relever l'état toutes les 30 minutes : une tâche finie, une intégration rouge ou une session arrêtée se voient dans la minute. Avec l'outil Monitor de Claude Code (délai maximal 30 minutes, réarmé à chaque expiration) :

```sh
f=.apv/state/run-<id>.json; read -r _ pid < .apv/state/session-<id>.log; last=""
while true; do
  cur=$(cksum < "$f" 2>/dev/null)
  if [ "$cur" != "$last" ]; then last=$cur; apv run status <id> 2>&1 | sed -n '1,6p'; fi
  kill -0 "$pid" 2>/dev/null || { echo "session <id> terminée (pid $pid)"; apv run next <id> 2>&1 | sed -n '1,6p'; exit 0; }
  sleep 5
done
```

Sans l'outil Monitor : une boucle bornée, lancée par l'outil Bash en arrière-plan, qui sort au premier changement de l'état, à la fin du processus ou après 25 minutes au plus (sa fin relance le chef de projet), puis relancée. À chaque événement : `apv run next <id>`, et la fin du journal de session si le processus s'est arrêté avant la livraison (reprise : section 6).

### Attendre sans dormir : `apv wait`

Une session non interactive n'a pas le droit d'attendre par le shell : `sleep`, `tail --pid`, une boucle sur `kill -0` et un préfixe de variable devant une commande sont refusés par les permissions (projet pilote, 24 septembre 2026 : la session a bricolé des scripts node pour attendre la suite complète). L'outil attend à sa place, borné pour tenir dans un appel Bash (dix minutes au plus) :

```sh
apv wait --pid <pid> [--timeout <s>]                       # fin d'un processus (absent, ou zombie)
apv wait --file <chemin> [--contains <texte>] [--timeout <s>]  # un fichier, ou un texte dans ce fichier
```

580 s au plus par appel (`--timeout` pour moins) ; code `0` « Terminé », code `1` « Délai dépassé » : on relance l'appel. `--contains` ne relit que les octets ajoutés depuis le relevé précédent, un journal qui grossit ne coûte rien. `apv wait` ne connaît pas le code de sortie du processus attendu : on lit son journal ou ses reçus. Exemples : la suite complète lancée en arrière-plan (`apv wait --pid <pid>`, puis `apv gates verify`), le scan dynamique (`apv wait --file <dossier>/summary.json`), une exécution détachée (`apv wait --pid <pid de la première ligne du journal>`).

### Serveurs de test orphelins : `apv procs`

Un appel Bash est coupé à 600 s. Une suite navigateur coupée ainsi laisse ses serveurs (`vite preview`, serveur web de Playwright) à l'écoute sur les ports de la pile de test, et une session non interactive n'a pas le droit de `kill` : sur le projet pilote (25 et 26 septembre 2026), la session `/apv:run` s'est arrêtée à attendre que les ports se libèrent. Deux règles :

1. **Les suites longues tournent en arrière-plan** : outil Bash avec `run_in_background: true`, sortie redirigée dans un journal du dossier de session, puis `apv wait --file <journal> --contains "Reçus : "` (dernière ligne de `apv gates run`) ou `apv wait --pid <pid>`, appel après appel. La suite n'est plus coupée par la limite de l'appel.
2. **Des ports occupés par des orphelins du dépôt se libèrent par l'outil**, pas en attendant :

```sh
apv procs list                              # qui tient les ports de test déclarés, et les processus des worktrees
apv procs stop                              # arrête ce qui écoute sur les ports déclarés (resources.<ressource>.ports)
apv procs stop --port 4173 --port 4174      # ports nommés
apv procs stop --repo <copie de la tâche>   # tout ce qui a été lancé dans cette copie (avant git worktree remove)
```

`apv procs stop` envoie `SIGTERM`, puis `SIGKILL` après `--grace` secondes (5 par défaut), et n'arrête qu'un processus dont le répertoire courant est dans un worktree du dépôt : jamais un processus d'un autre projet ou d'un autre utilisateur, jamais la session ni ses parents, jamais l'aperçu de `apv preview` (copie hors du dépôt). Un port tenu par un processus hors du dépôt sort en `1` (« hors du dépôt : non arrêté ») : c'est à l'opérateur de le libérer. Déclarer les ports des piles de test dans `.apv/config.json` ([CONFIGURATION.md](CONFIGURATION.md#ressources-de-test--resources)) pour que `apv procs stop` sans option les connaisse. Linux seulement (lecture de `/proc`) ; ailleurs, refus clair. `/apv:run` a le droit de le lancer (`node .../dist/cli.js procs`).

## 4. Vagues parallèles

### Workflows du plugin
Claude Code accepte des workflows dans un plugin (dossier `workflows/` à la racine, [référence des plugins](https://code.claude.com/docs/en/plugins-reference.md), [workflows](https://code.claude.com/docs/en/workflows.md)) : des scripts JavaScript qui commencent par `export const meta = { name, description, phases }`, littéral pur, puis orchestrent des sous-agents par `agent()`, `pipeline()`, `parallel()`, `phase()` et `log()`, avec leurs paramètres dans `args`. Ils tournent en arrière-plan (`/workflows` pour suivre), se reprennent dans la même session et se mettent en pause d'eux-mêmes à la limite d'usage (Claude Code 2.1.271 ou plus récent, session interactive). Ceux d'un plugin s'appellent `/<plugin>:<nom>`.

| Workflow | Lancé par | Ce qu'il fait |
|---|---|---|
| `apv:vague` (`workflows/vague.js`) | `/apv:run` | un `apv:implementer` par tâche, chacun en `isolation: worktree`, avec la consigne de démarrage (`git switch -c <branche> <commit de base>` ou reprise de la branche existante, marqueur `.apv/state/task.json`), la fin de tâche (contrôles de tâche et fichiers e2e touchés, commits, `apv scope check`) et un rapport structuré (statut, branche, worktree, commit, contrôles, périmètre) |
| `apv:revues` (`workflows/revues.js`) | `/apv:review` | un agent de revue par domaine (`apv:qa-securite`, `apv:qa-fidelite`, `apv:architecte-donnees`, `apv:dpo` ; `apv:architecte-donnees` en audit de concurrence pour le domaine facultatif `concurrence`, avec l'inventaire `paths`) sur sa copie détachée, rapport structuré, puis un passage de dédoublonnage qui ne supprime aucun constat |

Le chef de projet les lance par l'outil Workflow avec `name: "apv:vague"` ou `name: "apv:revues"` et `args` (nom vérifié avec Claude Code 2.1.280 : le runtime trouve le workflow du plugin et exécute le script). Les deux refusent de démarrer sans leurs paramètres : ce ne sont pas des commandes à lancer seules. Paramètres attendus : section 4 de `skills/run/SKILL.md` et section 4 de `skills/review/SKILL.md`.

### Sans workflow
Quand l'outil Workflow n'est pas disponible (désactivé par `disableWorkflows`, version trop ancienne) ou quand le chef de projet veut parler à chaque agent pendant son travail, il lance plusieurs agents par l'outil Agent, **plusieurs appels dans un même message**, chacun en arrière-plan (`run_in_background: true`), avec le même message que le workflow. Les fondations d'une vague, confiées à un seul agent, et une tâche lancée seule passent toujours par l'outil Agent.

### Vérifications du chef de projet, tâche par tâche
1. Branche : `git log --oneline <base>..<branche>`, fichiers touchés.
2. `apv scope check --spec <spec> --task <tâche> --base <commit de base> --repo <worktree>`.
3. Niveau de confiance du rapport (`confidence` et `evidence`) : `prouve`, la preuve porte-t-elle sur la tâche ; `probable` (`escalation.verify`), une vérification d'abord ; `suppose` (`escalation.operator`), pas de `done`. Un rapport refusé (`refused`) n'est jamais compté. Voir [CONFIANCE.md](CONFIANCE.md).
4. Commit relu, jamais recopié du rapport : `git rev-parse <branche>` (projet pilote, 24 septembre 2026 : un rapport a donné un sha complet dont seuls les 7 premiers caractères étaient justes). Le rapport colle les sorties brutes de `git rev-parse HEAD` et `git log --oneline -1` (`headRevParse`, `headLog` du workflow `apv:vague`, qui liste dans `commitChecks` les rapports où elles ne s'accordent pas avec `commit`).
5. `apv run set <id> task:<tâche> done --commit <sha relu ou branche> --confidence <niveau> --worktree <chemin>`, ou `failed --note "<cause>"`. `--commit <branche>` est résolu par l'outil, qui affiche le sha complet enregistré ; un sha introuvable est refusé avec le commit que désignent ses 7 premiers caractères et la tête de la branche de la tâche. `--confidence` garde dans l'état le niveau retenu après vérification (affiché par `apv run status`, retiré si la tâche est rouverte) ; `apv run next` liste les tâches faites en dessous de `prouve`.

### Contrôles : par tâche et suite complète

Premier `/apv:run` réel (« Toujours rien », spec `conformite-rgpd`, 95 minutes) : chaque implementer lançait tous les contrôles, Playwright compris, et plusieurs fois ; la suite navigateur, environ 4 minutes sous le verrou partagé `e2e`, a tourné une vingtaine de fois, les agents s'attendant les uns les autres. Les contrôles se répartissent donc en deux temps. Puis, en septembre 2026 sur le même projet, la suite complète (intégration et navigateur, environ 9 minutes) tournait à chaque intégration, à chaque intégration de corrections et à la livraison : 4 à 5 fois par spec, environ 45 minutes, plus l'attente du verrou `e2e` partagé. D'où le rythme `run.fullSuite` : `"final"` par défaut.

| Qui | Quand | Commande |
|---|---|---|
| implementer (et intégrateur) | fin de chaque tâche | `apv gates run --stage task --base <base>` ; si le contrôle navigateur déclare `affected`, il y lance déjà les tests concernés par les changements (« ciblé ») ; sinon, sous `apv lock run e2e -- <commande du projet>`, les seuls fichiers de tests e2e créés ou modifiés (par exemple `npx playwright test <fichiers>`) |
| chef de projet | intégration intermédiaire (il reste des tâches), avant d'avancer `apv/<id>` | `apv gates run --stage task --base <base ciblée> --repo <worktree>` sur la tête intégrée, arbre propre, puis `apv gates verify --commit <tête> --stage task --base <base ciblée> --repo <worktree>` ; la base ciblée est le dernier commit prouvé par la suite complète (la base de l'exécution tant qu'aucune n'est passée), `apv run next` la donne |
| chef de projet | dernière intégration (toutes les tâches), avant les revues | `apv gates run --stage full --run <id> --repo <worktree>` sur la tête intégrée, arbre propre, puis `apv gates verify --commit <tête> --repo <worktree>` ; ses reçus sont aussi copiés dans le magasin partagé du dépôt, vérifiables depuis n'importe quel checkout |
| chef de projet | intégration d'une passe de corrections | niveau tâche comme une intégration intermédiaire, base ciblée = tête de la dernière intégration, et le test qui prouve chaque correction vu vert |
| chef de projet | livraison, avant de pousser | `apv gates verify --commit <tête>` depuis n'importe quel checkout du dépôt : à `0` sur la tête exacte (spec sans corrections), pas de nouvelle suite ; sinon la suite complète sur la tête finale, dans un worktree propre (`apv gates run --stage full`, ou `--skip-proven` qui fait les deux), puis `apv gates verify --commit <tête>` ; la PR cite l'identifiant d'exécution de la suite complète |
| revues | après la dernière intégration | aucune relance de la suite complète ni de Playwright, sauf besoin précis de leur domaine : elles citent les reçus de la suite complète de ce commit |

Avec `"run": { "fullSuite": "each-integration" }`, le chef de projet passe la suite complète à chaque intégration, corrections comprises (rythme de 3.0.0-alpha.3 et avant) ; la livraison ne la relance pas non plus si elle est déjà prouvée sur la tête exacte. Pour une spec à trois vagues avec une passe de corrections : 5 suites complètes avec l'ancien rythme (3 intégrations, 1 intégration de corrections, 1 livraison), 2 avec `"final"` (dernière intégration, livraison) ; sans corrections : 4 contre 1.

**Reçus partagés entre worktrees.** `apv gates run` écrit ses reçus dans `.apv/receipts/<exécution>/` du worktree où il tourne, et les copie dans le magasin partagé du dépôt, `<répertoire git commun>/apv/receipts/<exécution>/` (commun à tous les worktrees, jamais versionné, avec l'empreinte sha256 de chaque fichier). `apv gates verify --commit <sha>` lit le worktree, puis ce magasin : la preuve d'un commit reste vérifiable après le retrait de la copie où la suite a tourné, depuis n'importe quel checkout du dépôt, avec les mêmes exigences (commit exact, arbre propre, configuration actuelle, reçu le plus récent) ; une exécution du magasin altérée est refusée en entier. Le corps de la PR cite l'identifiant d'exécution de la suite complète (la ligne « copie partagée : … (exécution <identifiant>) » de `apv gates run`) ; le chef de projet principal la revérifie par `apv gates verify --commit <tête>` sans rien relancer (`--commit-config` quand son checkout déclare d'autres contrôles que la tête, `apv gates receipts list --commit <tête>` pour retrouver les exécutions, `apv gates receipts export <exécution> --out <dossier>` pour en garder une copie). Origine : projet pilote, 25 septembre 2026 (PR #32), la copie de livraison retirée a emporté ses reçus et la suite complète, 10 minutes, a dû être relancée pour revérifier la PR. Rétention : section `receipts` ([CONFIGURATION.md](CONFIGURATION.md#reçus--receipts)).

Configuration : dans `.apv/config.json`, un contrôle long déclare `"stage": "full"` (la suite navigateur complète, par exemple) ; les autres restent `task`, la valeur par défaut. Un projet sans contrôle marqué garde le comportement antérieur : `--stage task` exécute tout. Rythme : `run.fullSuite` ([CONFIGURATION.md](CONFIGURATION.md#exécution--run)). Détails des options et des reçus : [CLI.md](CLI.md#apv-gates-run).

**Le rythme est tenu par l'outil.** Dans le cadre d'une exécution, `apv gates run --stage full` refuse (sortie `1`, `GATE_RHYTHM`) quand l'étape courante n'attend que les contrôles de tâche et ciblés, avec le même calcul que `apv run next`, et donne la commande à lancer à la place. L'exécution est celle de `--run <id>`, sinon celle de la branche courante (`apv/<id>` ou `apv/<id>-<suffixe>`, comme les branches d'intégration et de correction) quand un worktree du dépôt a son état : l'outil le cherche dans tous les worktrees, car plusieurs exécutions tournent côte à côte, chacune dans son checkout (plusieurs copies : celle du worktree sur `apv/<id>`, sinon celle du checkout principal, sinon refus `RUN_AMBIGUOUS` qui liste les emplacements). Dérogation motivée seulement : `--reason "<raison>"`, journalisée dans l'état (événement `gates:full`, visible dans `apv run status <id>`) et écrite dans les reçus (`override`). Dernière intégration, livraison, `"each-integration"` et travail hors exécution : inchangés. Origine : nuit du 24 au 25 septembre 2026 sur le projet pilote, une session a lancé la suite complète à une intégration intermédiaire alors que `apv run next` annonçait le niveau tâche ; avec deux passes de corrections et la suite relancée chaque fois, cette intégration a pris 3 h.

**Tests ciblés.** Un contrôle `full` peut déclarer une commande `affected` (Playwright : `--only-changed={{baseSha}}`), que `--stage task` exécute à sa place, signalée « ciblé » ; un reçu ciblé ne prouve jamais la suite complète (`apv gates verify`, niveau complet) ; il prouve le contrôle au niveau tâche (`apv gates verify --stage task --base <base ciblée>`) quand la base de son exécution couvre tous les changements depuis la base ciblée ([CONFIGURATION.md](CONFIGURATION.md#graphe-de-contrôles)). **Test instable** : on répète le seul test en cause (`<fichier>:<ligne>` ou `-g "<titre>"`), `--repeat-each` borné à 20 au plus, jamais un fichier entier sous le verrou `e2e` (sur « Toujours rien », un agent a répété 20 fois un fichier de 5 minutes et bloqué tous les autres). Ces instabilités venaient surtout de clics pendant des animations : un projet à interface fait tourner ses tests navigateur en mouvement réduit par défaut (Playwright : `use: { reducedMotion: 'reduce' }`), les tests d'animation gardant leur réglage.

**Rien ne passe pour autant.** Une vague n'est acceptée (avance rapide de `apv/<id>`) que sur une vérification à `0` **au commit exact**, au niveau que l'étape demande, et une PR n'est ouverte que sur une suite complète verte au commit exact : `apv gates verify` sort en `0` seulement si le reçu le plus récent de chaque contrôle exigé a réussi sur ce commit, arbre propre, avec la configuration actuelle ; un contrôle réservé n'est jamais compté comme réussi, et un échec plus récent l'emporte sur une réussite plus ancienne. Un contrôle rouge ouvre une passe de corrections, jamais ignorée ; un test instable est un constat. Restent entiers les contrôles de tâche complets de chaque implementer (typage, lint, unitaires, build, audit de sécurité), les tests négatifs et toutes les revues, dont la revue sécurité aux attaques réelles. Seul le moment de la détection change : un test navigateur cassé par une tâche sans toucher à ses fichiers e2e ni à ce qu'ils importent est détecté à la dernière intégration (ou à l'intégration de la vague avec `"each-integration"`) au lieu de la fin de la tâche, et corrigé avant les revues et avant toute PR ; les tests ciblés sur l'ensemble des changements depuis la dernière suite complète réduisent ce cas.

### Revues : domaines selon le diff

**Domaines selon le diff, proposés par l'outil.** Projet pilote, 25 septembre 2026 : une spec de pur rangement (77 renommages, imports, aucun changement de comportement, aucune migration, aucun écran) est passée par les quatre revues, 40 à 70 minutes, dont trois n'avaient rien à relire ; la session l'avait décidé seule. Avant les revues, le chef de projet lance

```sh
apv review plan --base <base de l'exécution> --head <tête> --json
```

qui classe chaque fichier du diff (renommage pur, chemins seuls réécrits, ou contenu changé ; interface, données, migration, données personnelles, texte légal, neutre ou non classé ; motifs de `review.paths`, [CONFIGURATION.md](CONFIGURATION.md#domaines-de-revue-selon-le-diff--paths-terms-always)) et rend les domaines retenus et sautés, chacun avec sa raison et les fichiers qui décident ([CLI.md](CLI.md#apv-review-plan)). **`securite` est toujours retenue**, sans exception ; `fidelite`, `donnees` et `rgpd` ne sont sautées que sur preuve positive qu'elles n'ont rien à relire : un fichier non classé au contenu changé les garde toutes. Le chef de projet ne lance que les domaines retenus ; chaque domaine sauté est noté `apv run set <id> review:<domaine> skipped --note "<raison de l'outil>"` (note exigée ; `review:securite` n'est jamais accepté sauté), passé au workflow `apv:revues` (`skipped`, rendu dans son résultat) et cité dans le fichier de consolidation et dans la PR. L'opérateur garde un domaine par `--force <domaine>` ; le projet, par `review.always`.

### Revues : scan dynamique et copies détachées

**Copies hors du dépôt.** Les copies détachées des revues, du scan et de la livraison (`git worktree add --detach <copie> <commit>`) vont dans le dossier de session du chef de projet (le dossier de travail temporaire de la session Claude Code) ou sous un chemin que l'outil donne, jamais à côté du dépôt : sur le projet pilote, une copie de livraison est apparue dans un dossier frère du dépôt, où les permissions de la session refusent au chef de projet ses commandes. Chacune est retirée par `git worktree remove` à la fin. Le workflow `apv:revues` refuse une copie donnée par un chemin relatif.

**Scan dynamique par le chef de projet.** Les agents de revue n'ont pas le droit de lancer Docker : le scan ZAP prévu par la revue sécurité n'a jamais tourné sur quatre livraisons de suite du projet pilote (septembre 2026). Un projet déclare son scan dans `review.dast` de `.apv/config.json` ([CONFIGURATION.md](CONFIGURATION.md#revues--review)) ; le chef de projet le lance avant les revues, dans une copie détachée du commit revu :

```sh
apv dast run --repo <copie> --out <dossier de session>/dast-<sha court> --commit <commit revu>
```

L'outil prend le verrou `review.dast.resource` (par défaut `dast`), lance la commande du projet dans la copie (bornée par `review.dast.timeoutMs`), écrit sa sortie dans `dast.log` et, en dernier, `summary.json` (statut, commit, fichiers). Un scan plus long qu'un appel Bash se lance en arrière-plan et s'attend par `apv wait --file <dossier>/summary.json`. Le dossier va à la revue sécurité (paramètre `dast` du workflow `apv:revues`), qui lit les rapports sans relancer le scan ; sans scan déclaré, ou avec un scan en échec, la raison lui est donnée (`dastMissing`) et le scan dynamique est « non vérifié » dans son rapport et dans la PR.

## 5. Quota

`apv quota` avant chaque vague, avant les revues et toutes les 10 à 15 minutes. Niveaux : `ok` (moins de 70 %), `slow_down` (70 % : moins d'agents, revues en mode économe), `finish_only` (85 % : finir sans rien lancer), `save_now` (95 % : sauvegarde). La consommation observée par vague sert de repère pour doser la suivante, jamais de plafond.

**Exécutions simultanées.** Avant de lancer une exécution `/apv:run` de plus en parallèle, relever `apv quota` et regarder la fenêtre la plus contraignante (session de 5 h ou semaine, nommée dans la sortie ; la semaine compte autant que la session) : au niveau `ok`, autant d'exécutions que de piles de test libres ; au premier seuil (`slow_down`, 70 %), une exécution de plus au maximum ; au-delà (`finish_only`, `save_now`), aucune nouvelle exécution, on finit celles en cours. Le chef de projet principal compte aussi sa propre consommation (vérifications, relectures, suivi des exécutions). Repère : la nuit du 24 au 25 septembre 2026, trois exécutions simultanées sur le projet pilote ont coûté 2 h 30 de pause de quota.

Sauvegarde : chaque agent commite son état en `wip`, ou le chef de projet l'arrête et commite le wip de son worktree ; les branches sont poussées sans force ; `.apv/state/resume.md` note les branches, les derniers commits, les agents ou le `runId` du workflow et l'ordre de reprise ; l'opérateur est prévenu avec l'heure de remise à zéro.

Pause visible : toute pause pour le quota (sauvegarde, ou simple attente d'une remise à zéro proche) s'écrit dans l'état, `apv run pause <id> --until <HH:MM> --note "<fenêtre, pourcentage>"`, et se termine par `apv run resume <id>` (ou par la transition `apv run set` suivante). Elle est journalisée et visible dans `apv run status`, `apv run next` et `apv status`. Toutes les heures affichées par l'outil sont en heure locale (fuseau du système, avec son décalage) ; l'état garde des dates ISO en UTC.

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

1. `apv stack plan <pr...>` lit chaque PR (`gh pr view`) et vérifie la pile : chaque PR ouverte, la base de la PR n+1 est la tête de la PR n (la première vise la branche cible), fusionnable, contrôles au vert ou absents, et la tête de chaque PR contient la tête actuelle de sa base (comparaison par l'API REST). Sa sortie est montrée en entier à l'opérateur.
2. `APV_ALLOW_MERGE=1 apv stack merge <pr...> [--method merge|squash|rebase] [--ready] [--target <branche>]` refait la vérification **juste avant chaque fusion**, re-cible la PR suivante sur la base finale quand la précédente est fusionnée, vérifie le résultat par une relecture (jamais par le seul code de sortie), affiche en entier la sortie de chaque appel `gh` et s'arrête à la première anomalie avec un rapport.
3. Une PR brouillon (celles de `/apv:run`) est une anomalie sans `--ready`, qui retire le statut brouillon juste avant chaque fusion ; `--target` fixe la branche d'arrivée (par défaut la base de la première PR).
4. Le hook du plugin bloque `apv stack merge` (comme `gh pr merge`) sans `APV_ALLOW_MERGE=1` posé devant la commande.
5. **Base à jour** : une PR dont la tête ne contient pas la tête actuelle de sa base est refusée, au plan comme juste avant sa fusion (après la fusion de la précédente et le re-ciblage) ; seuls des commits de fusion sans aucun changement de fichier sont tolérés (la PR suivante d'une pile fusionnée par `--method merge`). Le message donne la marche à suivre : fusionner la base dans la branche (`git merge origin/<base>`, jamais de rebase ni de force-push), repasser au moins les contrôles de tâche sur la nouvelle tête (`apv gates run --stage task --base origin/<base>` puis `apv gates verify --commit <tête> --stage task --base origin/<base>` à `0`), pousser sans force, attendre les contrôles GitHub au vert, relancer. Dérogation exceptionnelle : `--allow-behind --reason "<texte>"`, journalisée dans `.apv/state/stack.log` avant la fusion.

PR préparées en parallèle sur la même base (deux exécutions simultanées, par exemple) : ce n'est pas une pile, chacune se fusionne par sa propre commande, l'une après l'autre. Après la fusion de la première, la suivante est en retard : elle est mise à jour (fusion de la base), revérifiée et poussée avant sa fusion. C'est la réponse à l'incident du 25 septembre 2026 : deux PR au vert chacune seule, fusionnées l'une après l'autre, ont rendu `main` rouge (un test ajouté par l'une importait un module que l'autre déplaçait).

C'est la réponse à l'incident 30 du projet pilote : des re-ciblages masqués avaient échoué en silence et chaque PR avait été fusionnée dans la branche de la précédente au lieu de la branche principale.

## 8. Ce que l'exécution ne fait jamais

- Fusionner une PR (seul `/apv:stack`, sur ordre de l'opérateur), déployer, force-push, réécrire un commit poussé, écrire sur une base hébergée ou de production.
- Masquer la sortie d'une commande qui écrit sur un service externe.
- Déclarer un résultat, une approbation ou une maquette validée qu'elle n'a pas observés : les contrôles relancés par le chef de projet font foi, pas les rapports d'agents.
