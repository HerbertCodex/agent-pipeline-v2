# Plugin Claude Code « apv » (Agent Pipeline V3)

Version 3.0.0-alpha.3, phases 1 (socle), 2 (design et aperçu vivant) et 3 (exécution) ; phase 4 en cours (`/apv:onboard` disponible : reprise d'un projet V2 ou existant). Spécification : [APV3-SPEC.md](APV3-SPEC.md). Retour d'expérience qui l'a motivée : [RETOUR-TOUJOURS-RIEN.md](RETOUR-TOUJOURS-RIEN.md).

Le plugin fait de la session Claude Code principale un chef de projet : il orchestre de vrais sous-agents (spec, données, design, implémentation en parallèle, intégration, revues), tient l'état du travail dans le dépôt (`.apv/`), suit le quota et bloque les effets externes dangereux.

## Installation

Prérequis : Claude Code, Git, Node.js 22.16 ou plus récent ; `gh` pour les PR ; Docker pour les piles locales et les scans ZAP.

Depuis GitHub, dans Claude Code :

```
/plugin marketplace add HerbertCodex/agent-pipeline-v2@apv3
/plugin install apv@herbertcodex-apv
```

ou dans un terminal :

```bash
claude plugin marketplace add HerbertCodex/agent-pipeline-v2@apv3
claude plugin install apv@herbertcodex-apv
```

En local, pour une session (développement du plugin) :

```bash
claude --plugin-dir /chemin/vers/agent-pipeline-v2
```

L'outil `apv` est livré compilé dans le plugin (`dist/cli.js`), sans dépendance d'exécution, avec l'exécutable `bin/apv`. Tant que le plugin est activé, Claude Code ajoute le dossier `bin/` du plugin au `PATH` de l'outil Bash : `apv` s'y appelle directement, comme toute commande (`apv status`, `apv run next <id>`). `bin/apv` lance, dans le même processus, le `dist/cli.js` de son propre plugin, dont le chemin est calculé depuis l'emplacement réel du script (liens symboliques résolus), jamais depuis le `PATH`, le dossier courant ou une variable d'environnement ; arguments, sortie et code de sortie sont ceux de l'outil.

L'interpréteur, lui, vient du `PATH` : le script commence par `#!/usr/bin/env node`, et Node applique `NODE_OPTIONS`. Un faux `node` placé en tête du `PATH` serait donc lancé à la place du vrai. C'est un risque résiduel accepté : qui contrôle le `PATH` ou l'environnement de la session contrôle déjà `git` et toute autre commande lancée par Bash, et un chemin absolu vers `node` casserait les gestionnaires de versions de Node (nvm et autres). Il est déclaré dans les hypothèses de sécurité de la spec `p3-essai` et vérifié par un test.

Ce `PATH` ne vaut que pour l'outil Bash de Claude Code. Les compétences du plugin utilisent `apv` quand il est sur le `PATH`, sinon `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js` ; pour avoir l'outil dans votre terminal, créez un alias `apv` vers `bin/apv` ou `dist/cli.js`. D'après la documentation de Claude Code, un plugin distribué par les réglages d'organisation de claude.ai ne peut pas contenir de dossier `bin/` ; dans ce cas, seule la forme `node …/dist/cli.js` reste disponible.

## Mettre à jour

```
/plugin marketplace update herbertcodex-apv
/plugin update apv@herbertcodex-apv
/reload-plugins
```

Le plugin fixe sa version dans `.claude-plugin/plugin.json` : une mise à jour n'est proposée que lorsque ce numéro change. Un plugin chargé par `--plugin-dir` relit ses fichiers à chaque session.

## Agents

Chaque agent est un fichier de `agents/`, appelé `apv:<nom>` par l'outil Agent. Tous tournent sur Opus avec un effort élevé ; le chef de projet peut passer un autre modèle à l'appel.

| Agent | Rôle | Outils | Isolement |
|---|---|---|---|
| `product` | Rédige la spec : tâches, chemins autorisés, critères, plan de sécurité ; `apv spec validate` | lecture, Bash, écriture limitée à `.apv/specs/` | aucun |
| `architecte` | Graphe de tâches, vague « fondations », notes de vague, placement des fichiers créés (`apv structure check --path`), ressources et verrous | lecture, Bash, écriture limitée à `.apv/state/` | aucun |
| `architecte-donnees` | Modèle de données avant le code, puis revue des migrations et requêtes avec `apv db check` | lecture, Bash, écriture de `.apv/data-model.md` (migrations sur demande) | aucun |
| `designer` | Directions avant détails (2 ou 3 pour un nouveau produit ou un écran majeur), maquette itérée avec l'opérateur jusqu'à validation, grille de critique remplie, versée comme référence par `apv design register` | lecture, Bash, écriture dans les maquettes | aucun |
| `critique-design` | Critique notée d'une maquette avant présentation : captures 390 et 1280, clair et sombre, empreintes génériques, signature, états, fiche d'animation, test des 5 secondes avec la personne cible, corrections priorisées (deux tours au plus) | lecture, Bash (pas d'écriture de fichiers) | aucun |
| `implementer` | Code une tâche, tous les contrôles au vert, commits | lecture, écriture, Bash, correcteur Svelte (MCP) | worktree |
| `integrateur` | Fusionne une vague, unifie les doublons, garde tous les tests, relance tout | lecture, écriture, Bash, correcteur Svelte (MCP) | worktree |
| `qa-securite` | Attaques à deux utilisateurs, API directe, en-têtes, secrets, ZAP | lecture, Bash (pas d'écriture de fichiers) | copie isolée |
| `qa-fidelite` | Captures 390 et 1280, clair et sombre, comparaison des textes, accessibilité, états, animations et mouvement réduit, test des 5 secondes, fichiers mal placés | lecture, Bash (pas d'écriture de fichiers) | copie isolée |
| `dpo` | Registre RGPD, sous-traitants vérifiés sur les DPA officiels, pages légales contre le code | lecture, Bash, web, écriture de `.apv/rgpd/` (pages légales sur demande) | aucun |

Un agent de plugin ne peut pas déclarer `hooks`, `mcpServers` ni `permissionMode`. Pour les ajuster dans un projet, copiez le fichier dans `.claude/agents/` du projet et modifiez la copie.

## Commandes

| Commande | État |
|---|---|
| `/apv:status` | disponible : état des specs, branches, PR, verrous, quota, aperçu |
| `/apv:quota` | disponible : relevé des fenêtres 5 h et semaine, seuils 70, 85 et 95 % |
| `/apv:resume` | disponible : reprise après coupure (état, Docker, piles, verrous, agents, quota) |
| `/apv:design` | disponible : directions avant détails, critique par `apv:critique-design` avant chaque présentation, boucle de maquette par artefact avec l'opérateur jusqu'à sa validation explicite, puis versement par `apv design register` ; `/apv:design critique <chemin>` critique seule une maquette existante ([DESIGN.md](DESIGN.md)) |
| `/apv:preview` | disponible : mise à jour de l'aperçu vivant par `apv preview update`, vérification, annonce (adresse, branche, changements, compte de démo) |
| `/apv:init` | disponible : `apv init` crée `.apv/` sans rien écraser, puis contrôles détectés du dépôt, consigne commune et premières décisions avec l'opérateur, commit proposé ; réservée à l'opérateur |
| `/apv:spec` | disponible : `apv spec new`, rédaction par `product` (avec `dpo` et `architecte-donnees` consultés si la demande touche aux données), `apv spec validate` jusqu'à `VALID`, présentation à l'opérateur |
| `/apv:run` | disponible : exécution d'une spec pilotée par l'état `apv run` (données, plan, fondations, vagues parallèles, `apv scope check`, intégration, revues, corrections, PR brouillon, aperçu), reprise par `apv run next` ; jamais de fusion ni de déploiement ; réservée à l'opérateur ([RUN.md](RUN.md)) |
| `/apv:review` | disponible : revues sécurité, fidélité, données et RGPD en parallèle, en lecture seule, sur copies détachées du même commit, constats consolidés et dédoublonnés ; domaine facultatif `concurrence` (jamais par défaut), lançable seul pour un audit ciblé des conditions de course d'un projet existant : `/apv:review [branche] concurrence` |
| `/apv:stack` | disponible : `apv stack plan` montré en entier, puis `APV_ALLOW_MERGE=1 apv stack merge` qui re-cible, revérifie et s'arrête à la première anomalie ; uniquement sur ordre explicite de l'opérateur dans son message courant ([RUN.md](RUN.md), section 7) |
| `/apv:onboard` | disponible : `apv onboard --dry-run` montré à l'opérateur, puis `apv onboard` crée `.apv/` sans rien écraser (configuration reprise de `pipeline.v2.json`, champs du contrôleur ignorés et listés, registre V2 repris tel quel, specs V2 valides ; sans V2 : contrôles détectés, non obligatoires), puis contrôles, consigne commune et aperçu complétés avec lui, analyse de l'arborescence (`apv structure check`) et plan de rangement présentés, jamais appliqués, `apv ledger validate`, `apv gates run`, commit proposé ; réservée à l'opérateur ([CLI.md](CLI.md)) |

Les commandes « réservées à l'opérateur » ont des effets (fichiers du projet, branches, PR, fusion) : Claude ne les charge pas de lui-même, il faut les taper. Quand l'opérateur délègue plusieurs specs, le chef de projet suit la procédure de `/apv:run` pour chacune (compétence `chef-de-projet`, section 4).

## Workflows

Le dossier `workflows/` contient deux workflows au format de Claude Code (script JavaScript, `export const meta` puis `agent()`, `pipeline()`, `parallel()`, `phase()`, `log()` et `args`), lancés par les commandes et jamais seuls :

| Workflow | Lancé par | Effet |
|---|---|---|
| `apv:vague` | `/apv:run` | un `apv:implementer` par tâche prête, chacun dans son worktree, rapport structuré par tâche |
| `apv:revues` | `/apv:review` | un agent de revue par domaine sur sa copie détachée, puis dédoublonnage sans perte |

Sans outil Workflow (désactivé ou version trop ancienne), les commandes lancent les mêmes agents par l'outil Agent, plusieurs appels dans un même message, en arrière-plan. Détails : [RUN.md](RUN.md), section 4.

## Compétences

- `chef-de-projet` : la méthode complète (délégation, planification, worktrees, vagues, intégration, revues, livraison, pile de PR, quota, verrous, reprise, aperçu, journal, communication), avec ses références ; elle renvoie aux commandes pour chaque étape.
- `design-artefact` : boucle de maquette avec l'opérateur et versement de la référence (résumé pour les rôles ; le chef de projet la mène par `/apv:design`), et la grille de critique notée `references/grille-critique.md` (designer, `critique-design`, `qa-fidelite`).
- `rgpd` : grille du DPO, registres, modèles de textes sans promesse risquée.
- `architecture-donnees` : règles de la section 13 bis, exemples SQL, tests exigés et grille générique des conditions de course (`references/concurrence.md` : dix familles, toute stack et tout stockage, motif à chercher, question, corrections, preuve).
- Héritées de V2, inchangées : `clean-code`, `design-patterns`, `refactoring`, `security`, `tdd`, `ui-design`.

## Hooks

| Événement | Script | Effet |
|---|---|---|
| `SessionStart` | `hooks/scripts/session-start.mjs` | Si le projet a un dossier `.apv/`, ajoute au contexte, juste après l'en-tête, les exécutions non livrées (voir ci-dessous), puis les notes de reprise (`.apv/state/resume.md`), les fichiers d'état récents, le dernier relevé de quota (ligne JSON de `.apv/state/quota.log`, rendue lisible) et la dernière fin de tour. Lecture seule, 4000 caractères au plus ; les lignes lues sur disque sont nettoyées (séquences d'échappement, caractères de contrôle et de format retirés) et bornées. |
| `PreToolUse` (Bash) | `hooks/scripts/bash-guard.mjs` | Bloque le force-push (`--force`, `-f`, `--force-with-lease`, refspec `+`), la fusion de PR (`gh pr merge`, `gh api …/merge`, `apv stack merge`) sauf `APV_ALLOW_MERGE=1`, le déploiement en production (`vercel --prod`, `promote`, `rollback`) sauf `APV_ALLOW_DEPLOY=1`, et toute écriture GitHub dont la sortie est envoyée vers `/dev/null` (incident 30). |
| `PostToolUse` (Write, Edit, MultiEdit, NotebookEdit) | `hooks/scripts/scope-reminder.mjs` | Dans le worktree d'un implementer (marqueur `.apv/state/task.json`), rappelle les chemins autorisés de la tâche quand un fichier écrit en sort, avec la commande `apv scope check` à lancer. Rappel seulement, jamais de blocage : la vérification stricte reste `apv scope check` en fin de tâche. Muet sans marqueur (écritures du chef de projet). |
| `Stop` | `hooks/scripts/stop-journal.mjs` | Si `.apv/` existe, ajoute une ligne horodatée à `.apv/state/journal.log` (session, travaux encore en arrière-plan) et crée ou complète `.apv/.gitignore`. |

Exécutions au démarrage : le hook lit `.apv/state/run-*.json` par le module de résumé de l'outil (`dist/run/summary.js`, le même que `apv status`) et liste les exécutions non livrées, c'est-à-dire avec une étape ou une tâche encore ouverte, ou dont l'état est illisible. Chacune tient sur une ligne : spec, étape courante, tâches faites sur le total, tâches en cours, dernière mise à jour, ou raison de l'illisibilité. La liste est présentée comme un état lu sur disque, à vérifier, pas comme des consignes. Une ligne propose `apv run next <id>` seulement pour un état lisible dont l'identifiant tiré du nom de fichier respecte le format des identifiants de spec. Le hook lit au plus huit fichiers d'état, les plus récemment modifiés, soit pas plus que de lignes affichées ; les autres sont seulement comptés (« N autre(s) non lue(s) : apv status »). Si le module ne se charge pas (plugin sans son `dist/`), une ligne le signale et la session démarre sans cette liste ; une erreur de lecture de `.apv/state` a sa propre ligne.

Marqueur de tâche : au démarrage, l'implementer écrit dans son worktree `.apv/state/task.json`, soit `{"spec": ".apv/specs/<id>.json", "task": "<id de tâche>"}` (chemins lus dans la spec), soit `{"task": "<id>", "allowedPaths": [...], "allowedNewPaths": [...]}`. Le fichier est ignoré par Git.

Les variables d'autorisation se posent devant la seule commande concernée (`APV_ALLOW_MERGE=1 gh pr merge …`), uniquement sur ordre explicite de l'opérateur ; `/apv:stack` la pose devant la seule commande `apv stack merge` (bloquée elle aussi sans elle). Ces hooks sont des garde-fous contre l'erreur, pas une frontière de sécurité : pour une interdiction absolue, ajoutez aussi des règles `deny` dans les permissions du projet.

## Dossier `.apv/` du projet

| Chemin | Contenu | Versionné |
|---|---|---|
| `.apv/config` | configuration du projet (format de l'outil `apv`) | oui |
| `.apv/brief.md` | consigne commune des implementers | oui |
| `.apv/specs/` | specs | oui |
| `.apv/data-model.md` | modèle de données | oui |
| `.apv/rgpd/` | registre des traitements, sous-traitants | oui |
| `.apv/journal-pipeline.md` | incidents et améliorations du pipeline | oui |
| `.apv/state/resume.md`, `plan-*.md`, `notes-*.md`, `corrections-*.md`, `revues-*.md`, `demande-*.md` | état de reprise, plans, notes de vague, décisions de correction, constats consolidés des revues, demande de l'opérateur mot pour mot | oui |
| `.apv/state/run-<id>.json` | état d'exécution d'une spec, écrit par `apv run start` et `apv run set` seulement ([RUN.md](RUN.md)) | oui, aux points de sauvegarde |
| `.apv/state/*.log` | `journal.log` (hook de fin de tour), `quota.log` (relevés de `apv quota`, un objet JSON par ligne) | non |
| `.apv/state/task.json` | marqueur de tâche d'un worktree d'implementer | non |
| `.apv/receipts/` | reçus de `apv gates run` | non |
| `.apv/.gitignore` | ignore les trois lignes ci-dessus ; créé ou complété par `apv quota` et par le hook de fin de tour, sans toucher aux lignes ajoutées par le projet | oui |

Hors de `.apv/`, les maquettes validées vivent dans `docs/design/<nom>-validee.html` (dossier réglable par `design.dir` de `.apv/config.json`), chacune liée à sa décision `maquette-<nom>-validee` du registre par son empreinte sha256 ; les brouillons de la boucle dans `docs/design/brouillons/`.

## Ancienne version (V2)

Le CLI `apv2` d'Agent Pipeline V2 (dernière version 2.0.0-alpha.8) reste disponible sur la branche `main` jusqu'à la fusion d'APV3 ; son guide de démarrage est archivé dans [docs/v2/START-HERE.md](v2/START-HERE.md).
