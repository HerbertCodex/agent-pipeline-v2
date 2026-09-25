---
name: init
description: "Nouveau projet APV : crée .apv/ avec apv init (configuration, registre des décisions, consigne commune, specs, état), puis complète avec l'opérateur les contrôles détectés du dépôt, la consigne commune et les premières décisions, vérifie le tout et propose un commit. À utiliser une fois par projet, avant la première spec."
argument-hint: "[nom du projet]"
disable-model-invocation: true
allowed-tools: Read Glob Grep Write Edit Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js init*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js ledger*) Bash(apv init*) Bash(apv status*) Bash(apv ledger*) Bash(git status*) Bash(git log*) Bash(git diff*) Bash(git rev-parse*)
---

# /apv:init

Tu es le chef de projet. Tu prépares le dossier `.apv/` d'un projet qui n'est pas encore sous APV, avec l'opérateur. Nom proposé : `$ARGUMENTS` (sinon le nom du dossier du dépôt).

Dans ce document, `apv` désigne `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` (ou `apv` s'il est sur le PATH). Projet V2 (`pipeline.v2.json`, `.agent-pipeline/`) : c'est `/apv:onboard`, pas cette commande.

## 1. Créer le dossier
1. `git rev-parse --show-toplevel` : la commande se lance à la racine d'un dépôt Git. `apv init` refuse hors d'un dépôt (code 1).
2. `apv init --name "<nom>"`, sortie lue en entier. L'outil crée seulement ce qui manque, sans jamais écraser un fichier existant, et liste ce qu'il a créé et ce qui existait déjà :
   - `.apv/config.json` : nom du projet, `gates` vide ;
   - `.apv/DECISIONS.json` : registre vide et valide ;
   - `.apv/brief.md` : consigne commune, depuis le modèle `references/brief-type.md` de la compétence `chef-de-projet` ;
   - `.apv/specs/`, `.apv/state/` ;
   - `.apv/.gitignore` : `state/*.log`, `state/task.json`, `receipts/`.
3. Un fichier qui existait déjà n'est pas remplacé : lis-le et complète-le à la main si besoin, sans perdre ce qu'il contient.

## 2. Contrôles détectés du dépôt
Tu les détectes toi-même, en lecture, puis tu les écris dans `gates` de `.apv/config.json` :
- `package.json` (et ceux des sous-projets) : scripts de typage (`check`, `typecheck`), lint, analyseur du framework (par exemple `svelte-check`), code mort, tests unitaires, build, intégration, navigateur (Playwright), sécurité (`security:*`, `audit:*`, `semgrep*`, `gitleaks*`). Autres piles : `Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, scripts de CI (`.github/workflows/`).
- Un contrôle par commande réelle du projet, jamais une commande inventée ni un scanner absent du dépôt. Forme (champs du schéma de l'outil, voir `${CLAUDE_PLUGIN_ROOT}/docs/CONFIGURATION.md`, section « Graphe de contrôles ») :
  ```json
  { "id": "unit", "command": ["npm", "run", "test"], "covers": ["unit"], "resources": ["test-db"], "dependsOn": ["build"] }
  ```
  `covers` parmi `unit`, `integration`, `browser`, `build`, `lint`, `typecheck`, `security`, `architecture` ; `resources` pour tout ce qui est partagé (base locale, ports fixes, dossier de build) ; `passEnv` pour les seules variables dont un contrôle a besoin ; `readOnly: true` seulement si la commande n'écrit vraiment rien ; `"stage": "full"` pour un contrôle long (suite navigateur complète), passé seulement par la suite complète du chef de projet, les autres restant `task` (valeur par défaut, lancés après chaque tâche) ; pour un tel contrôle, une commande ciblée `affected` (tests concernés par les changements depuis `{{baseSha}}`) quand l'outil de test le permet : c'est elle qui protège les intégrations intermédiaires.
- **Rythme de la suite complète** : section facultative `run` de `.apv/config.json`, `{ "run": { "fullSuite": "final" } }` (défaut, section absente comprise) : suite complète à la dernière intégration de chaque spec et à la livraison, contrôles de tâche et tests ciblés vérifiés au commit exact entre les deux ; `"each-integration"` : suite complète à chaque intégration, corrections comprises, pour un projet où une régression découverte tard coûte trop (vagues très dépendantes, contrôle `full` sans commande `affected`). Écris la section seulement si l'opérateur choisit `"each-integration"`, et dis-lui le compromis de `"final"` en une phrase (une régression entre vagues peut n'être vue qu'à la dernière intégration, avant les revues et avant toute PR). Détails : `${CLAUDE_PLUGIN_ROOT}/docs/CONFIGURATION.md`, section « Exécution : `run` ».
- **Taille des specs** : section facultative `spec` de `.apv/config.json`, `{ "spec": { "maxTasks": 6, "maxAcceptance": 30, "maxDepth": 3 } }` (défauts, section absente comprise) : au-delà, `apv spec validate` avertit sans refuser et propose de découper la spec ou de raccourcir sa chaîne de dépendances ; ne la change que sur demande de l'opérateur.
- Un contrôle qui dépend d'un service (Docker, base locale) le dit dans son identifiant ou sa ressource ; les tests « live » échouent quand le service manque, ils ne sont jamais sautés.
- Si le projet a des maquettes validées : ajoute `apv design check` ; si le projet a une base : `apv db check` (section `db`, voir `${CLAUDE_PLUGIN_ROOT}/docs/DB-CHECK.md`).
- Vérifie la configuration avec `apv status` (fichier lu, contrôles déclarés, erreurs). Ne lance pas tous les contrôles ici : `apv gates run` viendra avec la première spec, ou tout de suite si l'opérateur le demande.

Présente la liste à l'opérateur en une phrase par contrôle ; il peut en retirer ou en ajouter.

## 3. Consigne commune (`.apv/brief.md`)
Remplace chaque passage entre chevrons du modèle avec ce que tu sais du dépôt : description du projet, langue des textes, règles du framework, liste exacte des contrôles (celle de `gates`), services locaux et leurs ports, ressources sous bail, ligne de co-auteur des commits. Demande à l'opérateur seulement ce qui lui revient : public et langue de l'application, ligne de co-auteur voulue, règles de texte (par exemple aucune promesse absolue). Tout le reste, tu le décides et tu le dis.

## 4. Registre des décisions
Les décisions déjà prises par l'opérateur (langue, public, stack imposée, hébergeur choisi) entrent au registre avec **ses mots exacts** :
1. écris la mise à jour `{ "decisions": [ ... ] }` dans un fichier temporaire hors du dépôt (format : `${CLAUDE_PLUGIN_ROOT}/docs/DECISIONS.md`) ;
2. `apv ledger plan --file <fichier>` : toutes les erreurs d'un coup, et une empreinte ;
3. `apv ledger apply --file <fichier> --hash <empreinte> --note "initialisation"`.
Aucune décision inventée, aucune citation reformulée : ce que l'opérateur n'a pas dit reste hors du registre ou devient une question. Une maquette déjà validée se verse par `/apv:design` (`apv design register`), pas à la main.

## 5. Vérifier et proposer le commit
1. `apv status` et `apv ledger validate` sortent sans erreur.
2. Rappelle ce qui est fourni par le plugin sans rien copier dans le projet : agents `apv:*`, compétences, workflows, hooks. Pour ajuster un agent dans ce projet seulement, copie son fichier dans `.claude/agents/` et modifie la copie.
3. Option à proposer : `worktree.baseRef: "head"` dans `.claude/settings.json` du projet, pour que les worktrees des implementers partent de la tête courante (sinon leur consigne leur fait créer leur branche depuis la base exacte, ce qui suffit).
4. `git status` puis `git diff` sur `.apv/` : montre à l'opérateur la liste des fichiers et **propose** le commit `chore(apv): initialisation`. Tu commites (`git add .apv` puis `git commit`) seulement sur son accord. Aucun `.env` ni secret dans le commit.
5. La suite : `/apv:design` pour un écran sans maquette validée, `/apv:spec` pour la première spec, puis `/apv:run`.

Réponds à l'opérateur dans sa langue, en phrases courtes, sans tiret cadratin ni demi-cadratin.
