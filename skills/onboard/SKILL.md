---
name: onboard
description: "Projet existant, V2 ou non : montre le plan de apv onboard --dry-run à l'opérateur, crée .apv/ avec apv onboard (config reprise de pipeline.v2.json ou contrôles détectés, registre V2 repris tel quel, specs V2 valides), puis complète avec lui contrôles, consigne commune et aperçu, lui présente l'analyse de l'arborescence (apv structure check) et son plan de rangement, la carte du code et ce qui est déjà dupliqué ou refait (apv reuse check), vérifie le registre et les contrôles et propose un commit. À utiliser une fois par projet déjà commencé."
argument-hint: "[dossier de specs V2 exportées]"
disable-model-invocation: true
allowed-tools: Read Glob Grep Write Edit Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js onboard*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js ledger validate*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js gates run*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spec validate*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js design list*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js structure check*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js structure map*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js reuse check*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js map*) Bash(apv onboard*) Bash(apv status*) Bash(apv ledger validate*) Bash(apv gates run*) Bash(apv spec validate*) Bash(apv design list*) Bash(apv structure check*) Bash(apv structure map*) Bash(apv reuse check*) Bash(apv map*) Bash(git status*) Bash(git log*) Bash(git diff*) Bash(git rev-parse*)
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
   - l'arborescence : le contrôle `structure` ajouté (toujours), la carte de l'architecture à créer (`docs/carte-architecture.md`) et les dossiers à plat déjà présents avec leurs sous-dossiers proposés ;
   - la réutilisation des éléments existants : les contrôles ajoutés (`code-map` toujours, `reuse` pour un projet web), la section `reuse` détectée (dossiers de composants partagés, composant qui remplace chaque élément natif réservé, langue, branche de référence) et ce qui est **déjà** dupliqué ou refait (blocs copiés, éléments natifs, primitives redéfinies, composants homonymes).
3. Un refus (code 1) : `pipeline.v2.json` ou le registre V2 illisible ou invalide. Rien n'a été écrit. Montre le message exact ; corrige le fichier V2 seulement avec l'accord de l'opérateur (un registre se corrige par `apv ledger plan` puis `apv ledger apply`, tant que `.apv/DECISIONS.json` n'existe pas), puis relance l'essai.

## 2. Créer `.apv/`
Sauf objection de l'opérateur, lance `apv onboard` (mêmes options, sans `--dry-run`). L'outil ne crée que ce qui manque, **sans jamais écraser** un fichier, et se relance sans effet. Les fichiers V2 restent en place ; dès que `.apv/config.json` et `.apv/DECISIONS.json` existent, ils sont lus en priorité, et les mises à jour du registre vont dans `.apv/`.

## 3. Compléter la configuration (`.apv/config.json`)
- **Projet V2** : chaque contrôle repris doit encore correspondre à une commande réelle (script présent dans `package.json`, cible du `Makefile`). Les commandes de préparation V2 (`setup`, par exemple `npm ci`) sont ignorées : les dépendances doivent être installées avant `apv gates run`. Un contrôle qui utilise `{{baseSha}}` demande `--base`.
- **Projet sans V2** : relis chaque contrôle détecté avec l'opérateur, complète `covers` (`unit`, `integration`, `browser`, `build`, `lint`, `typecheck`, `security`, `architecture`), `resources` pour ce qui est partagé (base locale, ports fixes), `passEnv` pour les seules variables utiles, `readOnly: true` seulement si la commande n'écrit vraiment rien ; passe `mandatory` à `true` une fois le contrôle confirmé. Ajoute les contrôles que le dépôt a sans que l'outil les ait vus (analyseur du framework, code mort, sécurité, CI dans `.github/workflows/`). Jamais une commande inventée ni un scanner absent du dépôt. Forme et champs : `${CLAUDE_PLUGIN_ROOT}/docs/CONFIGURATION.md`, section « Graphe de contrôles ».
- **Aperçu** : si le projet avait un script d'aperçu (script `preview` ou `apercu`, fichier de `scripts/`, script manuel hors du dépôt comme `apercu-supabase/update.sh` du projet pilote), reprends ce qu'il faisait dans la section `preview` : dossier, fichier d'environnement, étapes `install`, `migrate`, `build`, `seed`, serveur, port, contrôle de santé, adresse (`${CLAUDE_PLUGIN_ROOT}/docs/PREVIEW.md`, exemple SvelteKit et Supabase). Une pile d'aperçu reste séparée de celle des tests. La première mise à jour se fait par `/apv:preview`.
- **Maquettes et base** : `apv design list` montre les maquettes validées du registre ; une décision sans empreinte se rattache par `/apv:design` avec la citation d'origine recopiée telle quelle (`${CLAUDE_PLUGIN_ROOT}/docs/DESIGN.md`, section 7). Ajoute `apv design check` aux contrôles si le projet a des maquettes, et `apv db check` s'il a une base (section `db`, `${CLAUDE_PLUGIN_ROOT}/docs/DB-CHECK.md`).
- `apv status` : configuration lue, aucune section ignorée, aucune erreur.

## 4. Arborescence et carte de l'architecture
Charge la compétence `apv:structure` : elle dit comment juger le découpage proposé et préparer un rangement.
1. `apv structure check` (lecture seule, fichiers suivis par Git). Présente à l'opérateur chaque constat (`flat-folder`, `repeated-prefix`, `mixed-roles`, `stray-file`) avec sa proposition : pour un dossier à plat, le socle gardé à la racine, les sous-dossiers proposés par usage avec leurs raisons et la convention de la pile suivie, puis le plan dossier par dossier (`ancien -> nouveau`) et les fichiers qui « restent en place ». Dis-lui ton jugement (un développeur de la pile s'y retrouverait-il sans explication ?) et ce que le plan ne décide pas : noms à confirmer, fichiers non placés.
2. Le contrôle `structure` (`apv structure check --base {{baseSha}}`, étape tâche, obligatoire) est ajouté par `apv onboard` : les dossiers à plat existants sont signalés sans bloquer, mais aucun fichier de code ne peut plus s'y ajouter ; tout nouveau dossier de premier ou deuxième niveau, route principale ou point d'entrée doit être décrit dans la carte de l'architecture.
3. La carte de l'architecture (`docs/carte-architecture.md`) est écrite avec ses parties générées ; relis avec l'opérateur ses parties écrites en brouillon (en bref, couches et flux, règles transverses) et complète les rôles des dossiers que le code rend évidents, jamais inventés.
4. Rien n'est déplacé pendant la reprise. Si l'opérateur valide un rangement, avec ses mots exacts, c'est une spec à part (`/apv:spec`), placée après les specs en cours qui touchent ces fichiers : `git mv` (historique conservé), imports, configuration des outils et documentation mis à jour, aucun changement de comportement, tests déplacés à côté de leur module, chemins cités par les tests de sécurité mis à jour à l'identique, jamais élargis, carte de l'architecture mise à jour. Sa décision va au registre avec la citation.
5. Constats sans objet pour ce projet (un dossier volontairement plat, un rôle ou un domaine propre au projet) : section `structure` de `.apv/config.json` (`maxFlatFiles`, `roles`, `domains`, `ignore`, `profile` ; `${CLAUDE_PLUGIN_ROOT}/docs/CONFIGURATION.md`, section « Arborescence »), jamais un constat caché sans l'accord de l'opérateur, et dans une PR de configuration à part (le contrôle lit la configuration de la base).

## 4 bis. Réutilisation et carte du code
1. Relis avec l'opérateur la section `reuse` de `.apv/config.json` (`${CLAUDE_PLUGIN_ROOT}/docs/REUSE.md`) : `shared` (dossiers de composants partagés), `native.elements` (le composant partagé qui remplace chaque `<select>`, `<dialog>`, `<datalist>` ; `null` quand il n'existe pas encore), `native.allowedPaths` (où ces éléments restent permis : les primitives), `styles.sources` si la feuille globale n'est pas trouvée, `typography.locale`, `reference` (la branche où vont les PR, pour `apv reuse check` lancé à la main ; le contrôle déclaré compte depuis la base de chaque passage, `{{baseSha}}`, et `apv gates run` demande donc `--base`).
2. `apv reuse check --all` : présente ce qui est déjà dupliqué ou refait, règle par règle. Ces constats existants ne bloquent pas (ils sont sur la référence) ; leur résorption est une spec à part, décidée par l'opérateur, comme un rangement. Ne baisse aucune gravité et n'ajoute aucun chemin à `reuse.ignore` pour faire passer le contrôle.
3. La carte du code `.apv/code-map.md` est écrite (`apv map`) : montre ses sections (composants partagés, modules partagés, routes, propre à une fonctionnalité, doublons possibles). Elle se commite avec `.apv/` ; ensuite, seule l'intégration la régénère, une fois par vague (contrôle `code-map` de la suite complète). Les contrôles appellent `apv` par son nom : si la sortie avertit qu'il n'est pas sur le PATH, dis-le à l'opérateur (plugin activé, `npm link`, ou la forme `node <plugin>/dist/cli.js`).

## 5. Consigne commune (`.apv/brief.md`)
Remplace chaque passage entre chevrons avec ce que le dépôt dit déjà : `CLAUDE.md`, `AGENTS.md`, consigne des implementers du projet s'il en avait une, règles du framework, langue des textes, liste exacte des contrôles (celle de `gates`), services locaux et ports, ressources sous bail, ligne de co-auteur, conventions de placement des fichiers retenues à l'étape 4 (par domaine, noms courts, tests à côté du module), dossiers partagés, éléments réservés et primitives de l'étape 4 bis. Demande à l'opérateur seulement ce qui lui revient ; le reste, tu le décides et tu le dis.

## 6. Vérifier
1. `apv ledger validate` : le registre de `.apv/` est valide, avec le nombre de décisions et l'empreinte annoncés à l'étape 1. Aucune décision réécrite ni ajoutée sans les mots exacts de l'opérateur.
2. `apv gates run` (avec `--base <branche de base>` si un contrôle l'utilise). Un contrôle rouge : montre la sortie à l'opérateur ; on ne modifie jamais un contrôle pour qu'il passe. Un contrôle qui dépend d'un service (Docker, base locale) échoue quand le service manque : dis-le, ne le retire pas.
3. Specs copiées : `apv spec validate .apv/specs/<id>.json --draft`. Une spec déjà livrée en V2 peut rester comme trace ou être retirée avec l'accord de l'opérateur.

## 7. Proposer le commit
1. `git status` puis `git diff` sur `.apv/` : montre la liste des fichiers et **propose** le commit `chore(apv): reprise du projet`. Tu commites (`git add .apv` puis `git commit`) seulement sur son accord. Aucun `.env` ni secret dans le commit.
2. Les fichiers V2 (`pipeline.v2.json`, `.agent-pipeline/`) ne sont ni modifiés ni supprimés ; leur retrait éventuel est une décision de l'opérateur, dans un commit à part.
3. La suite : `/apv:status`, puis `/apv:spec` pour la prochaine spec et `/apv:run`.

Réponds à l'opérateur dans sa langue, en phrases courtes, sans tiret cadratin ni demi-cadratin.
