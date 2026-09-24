---
name: onboard
description: "Projet existant, V2 ou non : montre le plan de apv onboard --dry-run à l'opérateur, crée .apv/ avec apv onboard (config reprise de pipeline.v2.json ou contrôles détectés, registre V2 repris tel quel, specs V2 valides), puis complète avec lui contrôles, consigne commune et aperçu, vérifie le registre et les contrôles et propose un commit. À utiliser une fois par projet déjà commencé."
argument-hint: "[dossier de specs V2 exportées]"
disable-model-invocation: true
allowed-tools: Read Glob Grep Write Edit Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js onboard*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js ledger validate*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js gates run*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spec validate*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js design list*) Bash(apv onboard*) Bash(apv status*) Bash(apv ledger validate*) Bash(apv gates run*) Bash(apv spec validate*) Bash(apv design list*) Bash(git status*) Bash(git log*) Bash(git diff*) Bash(git rev-parse*)
---

# /apv:onboard

Tu es le chef de projet. Tu fais passer sous APV3 un projet déjà commencé, avec l'opérateur : un projet V2 (`pipeline.v2.json`, `.agent-pipeline/DECISIONS.json`) ou un projet qui n'a jamais eu de pipeline. Dossier de specs V2 exportées, s'il y en a : `$ARGUMENTS`.

Dans ce document, `apv` désigne `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` (ou `apv` s'il est sur le PATH). Projet tout neuf, sans code : c'est `/apv:init`.

## 1. Montrer le plan
1. `git rev-parse --show-toplevel` : la commande se lance dans un dépôt Git ; `apv onboard` refuse ailleurs (code 1).
2. `apv onboard --dry-run` (avec `--specs <dossier>` si l'opérateur a donné un dossier de specs V2 : V2 garde ses specs dans sa base d'état, hors du dépôt). Rien n'est écrit. Lis toute la sortie et montre-la à l'opérateur, en résumant :
   - projet V2 : les sections reprises de `pipeline.v2.json` (`gates`, `risk`, `validationRules`, `skills`, `environment.passEnv`) et la liste de ce qui est **ignoré** (agents, budgets, délais, profils de modèles, réglages : le contrôleur V2 n'existe plus) ;
   - le registre repris tel quel (nombre de décisions, empreinte) ;
   - les specs V2 copiées, et celles qui ne le sont pas avec leur raison ;
   - projet sans V2 : les contrôles détectés, chacun avec sa source et `mandatory: false` ;
   - les indices d'aperçu et les fichiers V2 non repris (rôles, compétences : le plugin les fournit).
3. Un refus (code 1) : `pipeline.v2.json` ou le registre V2 illisible ou invalide. Rien n'a été écrit. Montre le message exact ; corrige le fichier V2 seulement avec l'accord de l'opérateur (un registre se corrige par `apv ledger plan` puis `apv ledger apply`, tant que `.apv/DECISIONS.json` n'existe pas), puis relance l'essai.

## 2. Créer `.apv/`
Sauf objection de l'opérateur, lance `apv onboard` (mêmes options, sans `--dry-run`). L'outil ne crée que ce qui manque, **sans jamais écraser** un fichier, et se relance sans effet. Les fichiers V2 restent en place ; dès que `.apv/config.json` et `.apv/DECISIONS.json` existent, ils sont lus en priorité, et les mises à jour du registre vont dans `.apv/`.

## 3. Compléter la configuration (`.apv/config.json`)
- **Projet V2** : chaque contrôle repris doit encore correspondre à une commande réelle (script présent dans `package.json`, cible du `Makefile`). Les commandes de préparation V2 (`setup`, par exemple `npm ci`) sont ignorées : les dépendances doivent être installées avant `apv gates run`. Un contrôle qui utilise `{{baseSha}}` demande `--base`.
- **Projet sans V2** : relis chaque contrôle détecté avec l'opérateur, complète `covers` (`unit`, `integration`, `browser`, `build`, `lint`, `typecheck`, `security`, `architecture`), `resources` pour ce qui est partagé (base locale, ports fixes), `passEnv` pour les seules variables utiles, `readOnly: true` seulement si la commande n'écrit vraiment rien ; passe `mandatory` à `true` une fois le contrôle confirmé. Ajoute les contrôles que le dépôt a sans que l'outil les ait vus (analyseur du framework, code mort, sécurité, CI dans `.github/workflows/`). Jamais une commande inventée ni un scanner absent du dépôt. Forme et champs : `${CLAUDE_PLUGIN_ROOT}/docs/CONFIGURATION.md`, section « Graphe de contrôles ».
- **Aperçu** : si le projet avait un script d'aperçu (script `preview` ou `apercu`, fichier de `scripts/`, script manuel hors du dépôt comme `apercu-supabase/update.sh` du projet pilote), reprends ce qu'il faisait dans la section `preview` : dossier, fichier d'environnement, étapes `install`, `migrate`, `build`, `seed`, serveur, port, contrôle de santé, adresse (`${CLAUDE_PLUGIN_ROOT}/docs/PREVIEW.md`, exemple SvelteKit et Supabase). Une pile d'aperçu reste séparée de celle des tests. La première mise à jour se fait par `/apv:preview`.
- **Maquettes et base** : `apv design list` montre les maquettes validées du registre ; une décision sans empreinte se rattache par `/apv:design` avec la citation d'origine recopiée telle quelle (`${CLAUDE_PLUGIN_ROOT}/docs/DESIGN.md`, section 7). Ajoute `apv design check` aux contrôles si le projet a des maquettes, et `apv db check` s'il a une base (section `db`, `${CLAUDE_PLUGIN_ROOT}/docs/DB-CHECK.md`).
- `apv status` : configuration lue, aucune section ignorée, aucune erreur.

## 4. Consigne commune (`.apv/brief.md`)
Remplace chaque passage entre chevrons avec ce que le dépôt dit déjà : `CLAUDE.md`, `AGENTS.md`, consigne des implementers du projet s'il en avait une, règles du framework, langue des textes, liste exacte des contrôles (celle de `gates`), services locaux et ports, ressources sous bail, ligne de co-auteur. Demande à l'opérateur seulement ce qui lui revient ; le reste, tu le décides et tu le dis.

## 5. Vérifier
1. `apv ledger validate` : le registre de `.apv/` est valide, avec le nombre de décisions et l'empreinte annoncés à l'étape 1. Aucune décision réécrite ni ajoutée sans les mots exacts de l'opérateur.
2. `apv gates run` (avec `--base <branche de base>` si un contrôle l'utilise). Un contrôle rouge : montre la sortie à l'opérateur ; on ne modifie jamais un contrôle pour qu'il passe. Un contrôle qui dépend d'un service (Docker, base locale) échoue quand le service manque : dis-le, ne le retire pas.
3. Specs copiées : `apv spec validate .apv/specs/<id>.json --draft`. Une spec déjà livrée en V2 peut rester comme trace ou être retirée avec l'accord de l'opérateur.

## 6. Proposer le commit
1. `git status` puis `git diff` sur `.apv/` : montre la liste des fichiers et **propose** le commit `chore(apv): reprise du projet`. Tu commites (`git add .apv` puis `git commit`) seulement sur son accord. Aucun `.env` ni secret dans le commit.
2. Les fichiers V2 (`pipeline.v2.json`, `.agent-pipeline/`) ne sont ni modifiés ni supprimés ; leur retrait éventuel est une décision de l'opérateur, dans un commit à part.
3. La suite : `/apv:status`, puis `/apv:spec` pour la prochaine spec et `/apv:run`.

Réponds à l'opérateur dans sa langue, en phrases courtes, sans tiret cadratin ni demi-cadratin.
