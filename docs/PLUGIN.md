# Plugin Claude Code « apv » (Agent Pipeline V3)

Version 3.0.0-alpha.2, phases 1 (socle) et 2 (design et aperçu vivant). Spécification : [APV3-SPEC.md](APV3-SPEC.md). Retour d'expérience qui l'a motivée : [RETOUR-TOUJOURS-RIEN.md](RETOUR-TOUJOURS-RIEN.md).

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

L'outil `apv` est livré compilé dans le plugin (`dist/cli.js`), sans dépendance d'exécution. Les commandes et les hooks l'appellent par `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js` ; pour l'avoir aussi dans le terminal, créez un alias `apv` vers ce fichier.

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
| `architecte` | Graphe de tâches, vague « fondations », notes de vague, ressources et verrous | lecture, Bash, écriture limitée à `.apv/state/` | aucun |
| `architecte-donnees` | Modèle de données avant le code, puis revue des migrations et requêtes avec `apv db check` | lecture, Bash, écriture de `.apv/data-model.md` (migrations sur demande) | aucun |
| `designer` | Maquette itérée avec l'opérateur jusqu'à validation, versée comme référence par `apv design register` | lecture, Bash, écriture dans les maquettes | aucun |
| `implementer` | Code une tâche, tous les contrôles au vert, commits | lecture, écriture, Bash, correcteur Svelte (MCP) | worktree |
| `integrateur` | Fusionne une vague, unifie les doublons, garde tous les tests, relance tout | lecture, écriture, Bash, correcteur Svelte (MCP) | worktree |
| `qa-securite` | Attaques à deux utilisateurs, API directe, en-têtes, secrets, ZAP | lecture, Bash (pas d'écriture de fichiers) | copie isolée |
| `qa-fidelite` | Captures 390 et 1280, clair et sombre, comparaison des textes, accessibilité | lecture, Bash (pas d'écriture de fichiers) | copie isolée |
| `dpo` | Registre RGPD, sous-traitants vérifiés sur les DPA officiels, pages légales contre le code | lecture, Bash, web, écriture de `.apv/rgpd/` (pages légales sur demande) | aucun |

Un agent de plugin ne peut pas déclarer `hooks`, `mcpServers` ni `permissionMode`. Pour les ajuster dans un projet, copiez le fichier dans `.claude/agents/` du projet et modifiez la copie.

## Commandes

| Commande | État |
|---|---|
| `/apv:status` | disponible : état des specs, branches, PR, verrous, quota, aperçu |
| `/apv:quota` | disponible : relevé des fenêtres 5 h et semaine, seuils 70, 85 et 95 % |
| `/apv:resume` | disponible : reprise après coupure (état, Docker, piles, verrous, agents, quota) |
| `/apv:design` | disponible : boucle de maquette par artefact avec l'opérateur jusqu'à sa validation explicite, puis versement par `apv design register` ([DESIGN.md](DESIGN.md)) |
| `/apv:preview` | disponible : mise à jour de l'aperçu vivant par `apv preview update`, vérification, annonce (adresse, branche, changements, compte de démo) |
| `/apv:init`, `/apv:spec`, `/apv:run`, `/apv:review`, `/apv:stack` | phase 3 |
| `/apv:onboard` | phase 4 |

Les commandes des phases suivantes répondent déjà : elles annoncent leur phase et renvoient à la marche à suivre manuelle.

## Compétences

- `chef-de-projet` : la méthode complète (délégation, planification, worktrees, vagues, intégration, revues, livraison, pile de PR, quota, verrous, reprise, aperçu, journal, communication), avec ses références.
- `design-artefact` : boucle de maquette avec l'opérateur et versement de la référence (résumé pour les rôles ; le chef de projet la mène par `/apv:design`).
- `rgpd` : grille du DPO, registres, modèles de textes sans promesse risquée.
- `architecture-donnees` : règles de la section 13 bis, exemples SQL et tests exigés.
- Héritées de V2, inchangées : `clean-code`, `design-patterns`, `refactoring`, `security`, `tdd`, `ui-design`.

## Hooks

| Événement | Script | Effet |
|---|---|---|
| `SessionStart` | `hooks/scripts/session-start.mjs` | Si le projet a un dossier `.apv/`, ajoute au contexte les notes de reprise (`.apv/state/resume.md`), les fichiers d'état récents, le dernier relevé de quota (ligne JSON de `.apv/state/quota.log`, rendue lisible) et la dernière fin de tour. |
| `PreToolUse` (Bash) | `hooks/scripts/bash-guard.mjs` | Bloque le force-push (`--force`, `-f`, `--force-with-lease`, refspec `+`), la fusion de PR (`gh pr merge`, `gh api …/merge`) sauf `APV_ALLOW_MERGE=1`, le déploiement en production (`vercel --prod`, `promote`, `rollback`) sauf `APV_ALLOW_DEPLOY=1`, et toute écriture GitHub dont la sortie est envoyée vers `/dev/null` (incident 30). |
| `PostToolUse` (Write, Edit, MultiEdit, NotebookEdit) | `hooks/scripts/scope-reminder.mjs` | Dans le worktree d'un implementer (marqueur `.apv/state/task.json`), rappelle les chemins autorisés de la tâche quand un fichier écrit en sort, avec la commande `apv scope check` à lancer. Rappel seulement, jamais de blocage : la vérification stricte reste `apv scope check` en fin de tâche. Muet sans marqueur (écritures du chef de projet). |
| `Stop` | `hooks/scripts/stop-journal.mjs` | Si `.apv/` existe, ajoute une ligne horodatée à `.apv/state/journal.log` (session, travaux encore en arrière-plan) et crée ou complète `.apv/.gitignore`. |

Marqueur de tâche : au démarrage, l'implementer écrit dans son worktree `.apv/state/task.json`, soit `{"spec": ".apv/specs/<id>.json", "task": "<id de tâche>"}` (chemins lus dans la spec), soit `{"task": "<id>", "allowedPaths": [...], "allowedNewPaths": [...]}`. Le fichier est ignoré par Git.

Les variables d'autorisation se posent devant la seule commande concernée (`APV_ALLOW_MERGE=1 gh pr merge …`), uniquement sur ordre explicite de l'opérateur ; les commandes `/apv:stack` et de déploiement les poseront elles-mêmes. Ces hooks sont des garde-fous contre l'erreur, pas une frontière de sécurité : pour une interdiction absolue, ajoutez aussi des règles `deny` dans les permissions du projet.

## Dossier `.apv/` du projet

| Chemin | Contenu | Versionné |
|---|---|---|
| `.apv/config` | configuration du projet (format de l'outil `apv`) | oui |
| `.apv/brief.md` | consigne commune des implementers | oui |
| `.apv/specs/` | specs | oui |
| `.apv/data-model.md` | modèle de données | oui |
| `.apv/rgpd/` | registre des traitements, sous-traitants | oui |
| `.apv/journal-pipeline.md` | incidents et améliorations du pipeline | oui |
| `.apv/state/resume.md`, `plan-*.md`, `notes-*.md`, `corrections-*.md` | état de reprise, plans, notes de vague, décisions de correction | oui |
| `.apv/state/*.log` | `journal.log` (hook de fin de tour), `quota.log` (relevés de `apv quota`, un objet JSON par ligne) | non |
| `.apv/state/task.json` | marqueur de tâche d'un worktree d'implementer | non |
| `.apv/receipts/` | reçus de `apv gates run` | non |
| `.apv/.gitignore` | ignore les trois lignes ci-dessus ; créé ou complété par `apv quota` et par le hook de fin de tour, sans toucher aux lignes ajoutées par le projet | oui |

Hors de `.apv/`, les maquettes validées vivent dans `docs/design/<nom>-validee.html` (dossier réglable par `design.dir` de `.apv/config.json`), chacune liée à sa décision `maquette-<nom>-validee` du registre par son empreinte sha256 ; les brouillons de la boucle dans `docs/design/brouillons/`.

## Ancienne version (V2)

Le CLI `apv2` d'Agent Pipeline V2 (dernière version 2.0.0-alpha.8) reste disponible sur la branche `main` jusqu'à la fusion d'APV3 ; son guide de démarrage est archivé dans [docs/v2/START-HERE.md](v2/START-HERE.md).
