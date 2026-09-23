# Outil `apv` (Agent Pipeline V3)

`apv` est l'outil en ligne de commande du plugin APV3. Il reprend de V2 ce qui a fait ses preuves (schéma des specs, registre des décisions, minimum de sécurité OWASP, périmètre des tâches, exécution des contrôles, reçus) sans le contrôleur : aucune commande ne lance d'agent, ne décide à la place du chef de projet ni n'écrit sur un service externe.

Installation locale : `npm run build`, puis `node dist/cli.js <commande>` ou `npx apv <commande>` depuis le dépôt du plugin. Node 22.16 ou plus, Git, Linux, macOS ou WSL2. Aucune dépendance d'exécution.

## Conventions communes

- Toutes les commandes acceptent `--help` (ou `apv help <commande>`).
- `--json` produit une sortie structurée, stable, sur la sortie standard ; sans elle, la sortie est un texte en français.
- `--repo <chemin>` désigne le projet (par défaut : le dossier courant).
- Codes de sortie : `0` succès, `1` échec du contrôle (spec invalide, contrôle rouge, fichier hors périmètre...), `2` appel incorrect ou commande indisponible.
- Fichiers lus dans le projet :
  - configuration : `.apv/config.json`, sinon `pipeline.v2.json` (projet V2) ;
  - registre des décisions : `.apv/DECISIONS.json`, sinon `.agent-pipeline/DECISIONS.json` (projet V2).
- De la configuration, seules les sections `name` (nom du projet, écrit par `apv init`), `gates`, `risk`, `validationRules`, `environment.passEnv`, `skills`, `preview` et `design` sont lues par le chargeur commun ; la section `db` est lue et validée par `apv db check`. Les champs d'agent, de budget, de délais, de modèles et de réglage d'un fichier V2 sont ignorés (et listés comme tels par `apv gates run --json` et `apv status --json`).

## `apv init`

```
apv init [--name <nom>] [--repo <chemin>] [--json]
```

Prépare un projet pour APV3 (`/apv:init`). Crée ce qui manque dans `.apv/`, **sans jamais écraser un fichier existant** : la commande peut être relancée, elle ne complète que ce qui manque.

| Élément | Contenu initial |
|---|---|
| `.apv/config.json` | `{ "name": "<nom>", "gates": [] }` : aucun contrôle déclaré, pas de section `preview` ni `design` |
| `.apv/DECISIONS.json` | registre vide, valide pour `apv ledger validate` |
| `.apv/brief.md` | consigne commune des implementers, tirée du modèle `skills/chef-de-projet/references/brief-type.md` du plugin (le bloc de modèle, nom du projet substitué) ; les passages entre chevrons restent à adapter |
| `.apv/specs/`, `.apv/state/` | dossiers vides |
| `.apv/.gitignore` | fichiers machine (`state/*.log`, `state/task.json`, `state/preview.json`, `receipts/`), créé ou complété comme par `apv quota` |

Le nom du projet est `--name`, sinon le nom du dossier du dépôt. La commande travaille à la racine du dépôt Git qui contient le dossier courant (ou `--repo`) et refuse hors d'un dépôt Git. Elle liste ce qui est créé, complété et ce qui existait déjà ; rien n'est commité.

Sortie : `0` succès, `1` hors d'un dépôt Git ou modèle de consigne introuvable, `2` appel incorrect. En JSON : `repo`, `name`, `created`, `completed`, `existing`.

## `apv spec validate`

```
apv spec validate <fichier> [--repo <chemin>] [--request <texte> | --request-file <fichier>]
                  [--config <fichier>] [--draft] [--json]
```

Valide une spec et liste **toutes** les erreurs d'un coup : schéma (propriétés manquantes ou inconnues, longueurs, énumérations), identifiants en double, critères inconnus, dépendances manquantes ou cycliques, motifs de chemins non pris en charge, couverture des décisions du registre, plan de sécurité.

Le minimum de sécurité est recalculé depuis le dépôt exactement comme au lancement en V2 (fin de l'incident 14 du journal) : analyse de la demande de l'opérateur, du type de projet (`skills.projectType`) et des fichiers concernés, à savoir les chemins du dépôt que la demande nomme et les chemins littéraux des tâches. La spec doit reprendre les sujets OWASP, les exigences, le modèle de menace et les tests négatifs que ce minimum impose.

La demande de l'opérateur vient, dans l'ordre :
1. de `--request` ou `--request-file` ;
2. du document de spec, s'il a la forme `{ "request": "...", "spec": { ... } }` ;
3. à défaut, du texte de la spec elle-même (titre, problème, périmètre, critères, tâches ; les exclusions ne comptent pas).

Seule une demande fournie (cas 1 ou 2) sert à vérifier les citations des résolutions de décisions ambiguës.

Par défaut, la spec est contrôlée comme au lancement : aucune question ouverte, aucune ambiguïté non résolue, chaque critère porté par une tâche. `--draft` relâche ces trois règles pour une spec en cours de rédaction.

Sortie : `0` spec valide, `1` spec invalide ou illisible, `2` appel incorrect. En JSON : `valid`, `issues` (`code`, `message`), `security` (`minimumLane`, `topics`, `requiresThreatModel`, `negativeTestsRequired`, `signals`), `requestSource`, `ledgerFile`, `configFile`, `sha`.

## `apv spec new`

```
apv spec new <id> [--title <texte>] [--repo <chemin>] [--json]
```

Écrit le gabarit `.apv/specs/<id>.json` : une tâche exemple, un critère, des passages « À compléter » et une question ouverte (`Q-REDACTION`). Le gabarit passe `apv spec validate --draft` ; la question ouverte fait refuser un gabarit non rédigé par la validation de lancement et par `apv run start`. `<id>` est en kebab-case (minuscules, chiffres, tirets simples, 80 caractères au plus) ; le titre est `--title`, sinon l'identifiant. Un fichier existant n'est jamais écrasé.

Sortie : `0` gabarit écrit, `1` fichier existant ou hors d'un dépôt Git, `2` appel incorrect.

## `apv run`

```
apv run start <spec> [--base <branche>] [--repo <chemin>] [--json]
apv run set <spec-id> <cible> <statut> [--branch b] [--worktree w] [--agent id] [--commit sha]
            [--base sha] [--findings n] [--note texte] [--repo <chemin>] [--json]
apv run next <spec-id> [--repo <chemin>] [--json]
apv run status [<spec-id>] [--repo <chemin>] [--json]
```

État de reprise d'une exécution de spec (`/apv:run`, spécification section 8) dans `.apv/state/run-<spec-id>.json`, versionné avec le projet. Chaque écriture relit l'état, le modifie et le réécrit de façon atomique (fichier temporaire puis renommage) sous le verrou à bail `run:<spec-id>` (`apv lock`, attente de 60 s, ou `APV_RUN_LOCK_WAIT` secondes) : deux agents ne perdent jamais la mise à jour de l'autre. L'outil n'écrit rien d'autre : il ne crée ni branche ni worktree et ne lance aucun agent.

**`start`** valide la spec comme `apv spec validate` en mode lancement (refus en `1` avec toutes les erreurs), puis crée l'état. `<spec>` est un identifiant (`.apv/specs/<id>.json`) ou un chemin (l'identifiant est alors le nom du fichier). La base est `--base`, sinon la branche courante ; elle est enregistrée avec son commit (`baseSha`). Refus si l'état existe déjà : `apv run next` le reprend.

Vagues : couches topologiques des `dependsOn`. Le format de spec n'a pas de marqueur « fondation » (ses tâches refusent les propriétés inconnues) : les tâches de la première couche dont d'autres dépendent forment seules la vague 0, marquée `foundation` ; les autres tâches sans dépendance rejoignent la vague 1 ; une tâche de profondeur d est dans la vague d. Sans aucune dépendance, tout est en vague 0.

Forme de l'état :

```
{ schemaVersion: 1, specId, specFile, specSha256, base, baseSha, branch: "apv/<spec-id>", createdAt, updatedAt,
  steps: { "data-model" | plan | integration | reviews | fixes | delivery: { status, note, updatedAt } },
  waves: [{ index, foundation, tasks: [id...] }],
  tasks: { <id>: { title, dependsOn, wave, status, branch, worktree, agentId, base, commit, note, updatedAt } },
  reviews: { securite | fidelite | donnees | rgpd: { status, findings, note, updatedAt } },
  events: [{ at, target, from, to, note?, commit?, agentId? }] }
```

Statuts : `pending`, `running`, `done`, `failed`, `skipped`.

**`set`** change le statut d'une cible : une étape (`data-model`, `plan`, `integration`, `reviews`, `fixes`, `delivery`), `task:<id>` ou `review:<domaine>` (`securite`, `fidelite`, `donnees`, `rgpd`), et ajoute un événement horodaté. Règles :
- passages permis : `pending` vers `running`, `done`, `skipped`, `failed` ; `running` vers `done`, `failed`, `pending`, `skipped` ; `failed` vers `pending`, `running`, `skipped` ; `skipped` vers `pending`, `running` ; `done` vers `running`, `pending`. Garder le même statut met seulement à jour les champs (nouveau commit wip, autre agent) ;
- rouvrir un travail `done` exige `--note` (la raison est journalisée) ;
- une tâche ne passe `running` que si toutes ses dépendances sont `done` ;
- une tâche `done` exige `--commit` ; le commit (sha ou nom de branche) doit exister dans le dépôt et il est enregistré en entier ;
- `--branch`, `--worktree` (chemin rendu absolu), `--agent` et `--base` (commit de départ de la tâche, pour la reprise) ne valent que pour une tâche ; `--findings` (nombre de constats) que pour une revue ; `--commit` vaut pour toute cible (facultatif sur une étape : commit du plan, tête intégrée ; sur une revue : commit revu), et reste vérifié dans le dépôt.

**`next`** dit ce qu'il faut faire maintenant, de façon déterministe : c'est la base de la reprise après une coupure (`/apv:resume`).
- Étape courante : la première étape non terminée (`done` ou `skipped`), avec `waves` entre `plan` et `integration` tant qu'une tâche reste à faire, et la vague courante (la plus basse qui a une tâche non terminée).
- Tâches prêtes : `pending` dont les dépendances sont `done`, avec leur vague. Les actions proposent d'abord celles de la vague courante (les fondations sont intégrées avant d'ouvrir le parallèle).
- Tâches `running` : **à relancer** si leur worktree n'existe plus, si leur branche est introuvable, si ni branche ni worktree ne sont enregistrés, ou si leur tête n'a aucun commit après leur base (`--base` donné au lancement de la tâche, sinon la base de l'exécution) ; sinon **à reprendre**, avec branche, worktree, agent, tête, nombre de commits après la base et dernier commit enregistré. Une tâche signalée à relancer ne l'est que si son agent ne tourne plus : un agent qui vient de démarrer n'a pas encore de commit.
- Tâches en échec, tâches bloquées (dépendances attendues), revues à lancer (`pending` ou `failed`, une fois les tâches finies et l'intégration faite) et revues en cours.
- `specChanged` : la spec a changé depuis `start` (empreinte différente) ; l'état garde le plan du lancement, l'action le signale.

**`status`** résume toutes les exécutions (étape, tâches faites sur le total, en cours, en échec, date) ou détaille une exécution (étapes, vagues avec l'état de chaque tâche, revues, dernier événement). Un état illisible est signalé, jamais réécrit.

Sortie : `0` succès, `1` refus (spec invalide, état déjà présent ou absent, transition refusée, commit introuvable, état illisible, verrou non obtenu), `2` appel incorrect (cible ou statut inconnu, option sans effet).

## `apv stack`

```
apv stack plan <pr...> [--target <branche>] [--ready] [--json]
APV_ALLOW_MERGE=1 apv stack merge <pr...> [--method merge|squash|rebase] [--target <branche>] [--ready] [--json]
```

Pile de PR, donnée par ses numéros dans l'ordre de fusion (de la base vers le sommet). Fin de l'incident 30 : re-ciblage vérifié, sortie jamais masquée, arrêt à la première anomalie.

**`plan`** lit chaque PR par `gh pr view <n> --json number,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup` et vérifie la pile : chaque PR ouverte ; la base de la première est la branche cible (`--target`, sinon sa base actuelle), celle de la PR n+1 est la tête de la PR n ; `mergeable` à `MERGEABLE` et état de fusion `CLEAN` (ou `HAS_HOOKS`) ; contrôles au vert (`SUCCESS`, `NEUTRAL`, `SKIPPED`) ou absents. Un brouillon est une anomalie, sauf avec `--ready`. Une mergeabilité encore en calcul (`UNKNOWN`) est relue quelques fois avant d'être une anomalie. Toutes les anomalies sont listées ; rien n'est modifié. Les appels `gh` en échec sont affichés en entier.

**`merge`** fusionne, uniquement sur ordre explicite de l'opérateur. Il exige `APV_ALLOW_MERGE=1` dans l'environnement ; sinon il sort en `2` avec le message du hook, sans aucun appel `gh`. Déroulé :
1. la pile est vérifiée comme par `plan` ; une anomalie arrête tout avant la première fusion ;
2. pour chaque PR, dans l'ordre : relecture ; si la précédente vient d'être fusionnée et que la PR vise encore sa tête, re-ciblage par `gh pr edit <n> --base <cible>`, puis **relecture** : la nouvelle base est constatée, jamais déduite du code de sortie ;
3. vérification juste avant la fusion (ouverte, bonne base, fusionnable, contrôles) ; avec `--ready`, `gh pr ready <n>` puis relecture ;
4. `gh pr merge <n> --<méthode> --match-head-commit <tête relue>` : si la branche a bougé depuis la vérification, GitHub refuse ;
5. relecture : état `MERGED` et base attendue, sinon arrêt.

La sortie complète de chaque appel `gh` (commande, sortie standard, sortie d'erreur, code) est affichée au fil de l'eau, sur la sortie d'erreur avec `--json` (et dans le champ `calls`). À la première anomalie, rien d'autre n'est fusionné et le rapport donne les PR fusionnées, la PR d'arrêt, ses raisons et les PR restantes. La commande ne supprime aucune branche.

Le hook de garde bloque `apv stack merge` (et `node …/dist/cli.js stack merge`) sans `APV_ALLOW_MERGE=1` en préfixe, comme `gh pr merge`, et refuse sa sortie envoyée vers `/dev/null`. La variable `APV_GH` remplace l'exécutable `gh` (tests avec un faux `gh`) ; `APV_STACK_POLL_MS` et `APV_STACK_POLL_ATTEMPTS` règlent la relecture d'une mergeabilité en calcul (3 s, 20 fois par défaut).

Sortie : `0` pile cohérente (`plan`) ou entièrement fusionnée (`merge`), `1` anomalie, `2` appel incorrect ou `APV_ALLOW_MERGE` absent. En JSON : `plan` rend `target`, `ok`, `prs` (`number`, `pr`, `expectedBase`, `anomalies`), `calls` ; `merge` rend aussi `method`, `merged`, `stopped` (`pr`, `reasons`).

## `apv ledger`

```
apv ledger validate [--repo <chemin>] [--json]
apv ledger plan --file <mise-a-jour.json> [--repo <chemin>]
apv ledger apply --file <mise-a-jour.json> --hash <empreinte> --note <texte>
                 [--reviewer <nom>] [--commit] [--repo <chemin>]
```

- `validate` lit le registre de l'arbre de travail et liste toutes ses erreurs (schéma, identifiants en double, citation manquante d'une décision de l'opérateur, décision ambiguë sans question ni deux interprétations...). Un projet sans registre a un registre vide (sortie `0`).
- `plan` calcule le registre obtenu par une mise à jour `{ "decisions": [ ... ] }` : les nouvelles entrées s'ajoutent, une entrée qui en remplace une autre la nomme dans `supersedes` et l'ancienne quitte le registre actif (elle reste dans l'historique Git). Le plan affiche une empreinte.
- `apply` écrit exactement le plan relu : l'empreinte doit correspondre, sinon rien n'est écrit. Il met à jour le JSON et sa version lisible (`DECISIONS.md` à côté), et commite ces deux fichiers seulement avec `--commit`. Le relecteur est `--reviewer`, sinon le `user.name` de Git.

Le registre reste à son emplacement : un projet V2 est mis à jour dans `.agent-pipeline/`, un projet V3 (ou sans registre) dans `.apv/`.

## `apv scope check`

```
apv scope check --spec <fichier> --task <id> [--base <ref>] [--repo <chemin>] [--json]
```

Compare les fichiers modifiés par les commits de la tâche aux `allowedPaths` de cette tâche dans la spec. La base est le point de divergence entre `<ref>` et `HEAD` (`main`, sinon `master`, par défaut) : le travail arrivé sur la branche principale depuis n'est pas imputé à la tâche. Les motifs suivent les règles de V2 (`*`, `**`, `?` ; crochets et parenthèses littéraux ; accolades et `!` refusés).

Tous les fichiers hors périmètre sont listés. Les modifications non commitées ne sont pas vérifiées : elles sont signalées, car la vérification stricte a lieu à la fin de la tâche, sur ses commits.

Sortie : `0` dans le périmètre, `1` hors périmètre, `2` appel incorrect (spec illisible, tâche inconnue, base introuvable).

## `apv gates run`

```
apv gates run [--only a,b] [--config <fichier>] [--base <ref>] [--concurrency N]
              [--keep-going] [--repo <chemin>] [--json]
```

Exécute les contrôles déclarés dans `gates` depuis la racine du dépôt, avec l'ordonnanceur de V2 :
- **dépendances** (`dependsOn`) : un contrôle attend les siens ; si l'un échoue, ses dépendants sont « bloqués » ;
- **ressources** (`resources`) : deux contrôles qui partagent une ressource nommée ne tournent jamais en même temps ;
- **lecture seule** (`readOnly`) : seuls les contrôles déclarés en lecture seule tournent en parallèle, un contrôle qui écrit a l'espace de travail pour lui seul ;
- **environnement** : chaque commande reçoit seulement `environment.passEnv` (par défaut `PATH`, `SystemRoot`, `WINDIR`, `TMPDIR`, `TEMP`, `TMP`, `LANG`) et le `passEnv` du contrôle ;
- **délais** : `timeoutMs` par contrôle (120 s par défaut) ; au-delà, le groupe de processus est arrêté ;
- **secrets** : les valeurs des variables dont le nom contient TOKEN, KEY, PASSWORD, SECRET ou CREDENTIAL sont masquées dans les diagnostics.

Paramètres des commandes (argument entier uniquement, jamais d'interprétation par un shell) : `{{workspace}}` (racine du dépôt), `{{candidateSha}}` (HEAD), `{{baseSha}}` (commit de `--base`, obligatoire si un contrôle l'utilise).

`--only` choisit des contrôles et ajoute leurs dépendances. Par défaut, le premier échec arrête les contrôles suivants ; `--keep-going` les laisse tous s'exécuter. `--concurrency` borne le parallélisme (3 par défaut).

Chaque exécution écrit dans `.apv/receipts/<exécution>/` un reçu JSON par contrôle (statut, code de sortie, durée, empreintes des sorties, empreinte de preuve liée au commit, à la configuration, à l'environnement et à l'exécutable, diagnostic en cas d'échec) et un `summary.json`. Le dossier `.apv/receipts/` contient un `.gitignore` : les reçus sont des preuves locales, jamais commitées. Si l'arbre de travail avait des modifications non commitées, le résumé le signale (`dirty`) : les reçus décrivent alors plus que le commit.

Différences avec V2 : pas d'espace de travail jetable (l'implémenteur exécute les contrôles dans le worktree qu'il possède), pas de cache de reçus (`cacheTtlMs` est ignoré), pas de commandes de préparation (`setup`).

Sortie : `0` tous les contrôles passent, `1` au moins un échec ou une configuration invalide, `2` appel incorrect.

## `apv lock`

```
apv lock run <ressource> [--ttl 900] [--wait 1800] -- <commande...>
apv lock acquire|release|status <ressource>
```

Verrous à bail sur les ressources partagées (base de test, ports, navigateur) : propriétaire vérifié, expiration, renouvellement pendant `run`, file d'attente visible (spécification, section 10). `run` est la forme à préférer : une commande par bail, libéré à la sortie quoi qu'il arrive. Détails, options et codes de sortie : [LOCKS.md](LOCKS.md).

## `apv db check`

```
apv db check [--json] [--live] [--config <fichier>] [--root <dossier>]
```

Contrôle du modèle de données (spécification, section 13 bis) : nommage anglais, index des clés étrangères, RLS, politiques, fonctions `security definer`, `select *` dans le code, redondances, clés d'idempotence. `--live` lit aussi la base, en lecture seule, par `APV_PSQL` (commande psql complète, par exemple `docker exec -i <conteneur> psql -U postgres -d postgres`) ou par `APV_DB_URL` et `psql`. Règles, configuration et limites : [DB-CHECK.md](DB-CHECK.md).

## `apv design`

```
apv design register <fichier.html> --name <nom> --quote "<mots de l'opérateur>"
                    [--title "<titre>"] [--screens a,b] [--artifact <url>] [--repo <chemin>] [--json]
apv design list [--screen <écran>] [--repo <chemin>] [--json]
apv design check [--repo <chemin>] [--json]
```

Maquettes validées par l'opérateur, référence absolue des implementers et de la revue de fidélité. Méthode complète : [DESIGN.md](DESIGN.md).

- `register` verse une maquette que l'opérateur vient de valider :
  1. copie le fichier vers `docs/design/<nom>-validee.html` (dossier : `design.dir` de `.apv/config.json`) ;
  2. calcule son sha256 ;
  3. inscrit au registre, par l'API de mise à jour du registre (comme `apv ledger apply`), la décision `maquette-<nom>-validee` : `confirmed`, source `operator`, `sourceQuote` = la citation, `enforcement` `product`, valeur avec le chemin et l'empreinte (et les écrans, l'adresse de l'artefact) ;
  4. affiche les fichiers à commiter (maquette, registre JSON et Markdown). Rien n'est commité.

  La citation est obligatoire : sans les mots de l'opérateur, rien n'est versé (le pipeline n'invente jamais une approbation). Une validation avec réserve (« je valide sauf … ») est refusée. Le registre doit être commité avant (`LEDGER_DIRTY` sinon) ; en cas d'échec, le fichier copié est retiré. Le nom : minuscules, chiffres et tirets, 50 caractères au plus, sans le mot `validee`. Verser de nouveau une maquette déjà versée ajoute `maquette-<nom>-validee-v2` (puis `-v3`…), qui remplace l'ancienne décision (`supersedes`) ; un contenu identique à la version enregistrée ne change rien.
- `list` affiche les maquettes validées du registre de l'arbre de travail : nom, décision, fichier, empreinte, écrans et état du fichier : `ok`, `MODIFIÉE` (empreinte différente), `ABSENTE`, ou `sans empreinte` pour une décision écrite avant l'outil (projet pilote). `--screen` filtre sur un écran (nom ou écran déclaré, sans tenir compte de la casse ni des accents).
- `check` sort en `1` si un fichier de maquette validée a changé ou disparu sans nouvel enregistrement ; les décisions sans empreinte sont listées comme non vérifiables. À déclarer comme contrôle (`gates`) dans les projets qui ont des maquettes.

Configuration (facultative) :

```json
{ "design": { "dir": "docs/design" } }
```

Sortie : `0` succès (maquettes intactes pour `check`), `1` refus ou dérive, `2` appel incorrect (citation ou nom manquant). En JSON, `register` rend `decisionId`, `supersedes`, `target`, `sha256`, `ledgerFile`, `toCommit`, `unchanged` ; `list` rend `mockups` ; `check` rend `ok`, `checked`, `broken`, `legacy`.

## `apv quota`

```
apv quota [--repo <chemin>] [--no-log] [--json]
```

Relève l'usage avec `claude -p "/usage" --setting-sources ''` (délai de 150 s) et lit deux lignes :

```
Current session: 21% used · resets Sep 23, 2:30am (Europe/Paris)
Current week (all models): 7% used · resets Sep 25, 7pm (Europe/Paris)
```

Le niveau se calcule sur la plus haute des deux fenêtres (spécification, section 9) :

| Pourcentage | Niveau | Consigne |
|---|---|---|
| moins de 70 % | `ok` | continuer |
| 70 % | `slow_down` | ralentir, doser les vagues |
| 85 % | `finish_only` | finir les tâches en cours sans en lancer de nouvelles |
| 95 % | `save_now` | sauvegarder (commits « wip », push, notes de reprise) et prévenir l'opérateur |
| illisible | `unknown` | le relevé a échoué ; la sortie de la commande est affichée |

Chaque relevé est ajouté à `.apv/state/quota.log` (un objet JSON par ligne : `at`, `session`, `week`, `percent`, `level`), sauf avec `--no-log` ; le hook de démarrage de session lit la dernière ligne. `apv quota` crée ou complète aussi `.apv/.gitignore` (`state/*.log`, `state/task.json`, `state/preview.json`, `receipts/`) pour que ces fichiers machine ne soient jamais commités. La variable d'environnement `APV_CLAUDE_BIN` remplace l'exécutable `claude` (tests, installation particulière).

Sortie : `0` relevé lu, `1` relevé illisible, `2` appel incorrect.

## `apv preview`

```
apv preview update [branche] [--wait 30m] [--repo <chemin>] [--json]
apv preview status [--repo <chemin>] [--json]
apv preview stop [--wait 30m] [--repo <chemin>] [--json]
apv preview logs [--lines 50] [--update] [--repo <chemin>]
```

Aperçu vivant du projet (spécification, section 12), décrit par la section `preview` de `.apv/config.json` : dossier de la copie, fichier d'environnement, étapes `install`, `migrate`, `build`, `seed`, commande et port du serveur, contrôle de santé, adresse annoncée.

- `update` prend le verrou du projet (`preview:<projet>`), arrête le serveur d'aperçu, copie la branche (`preview.branch`, sinon `main`) par `git archive` dans un dossier neuf, lance les étapes, démarre le serveur détaché (journal `.apv/state/preview.log`, état `.apv/state/preview.json`) et attend sa réponse. Il affiche « aperçu prêt : <adresse> (branche X, commit abc1234) » et les commits arrivés depuis l'aperçu précédent. Un échec nomme l'étape et donne le chemin du journal ; aucun serveur ne reste.
- `status` : en marche (groupe de processus vivant et contrôle de santé réussi), adresse, branche, commit, durée, dernier échec.
- `stop` : arrête le serveur (tout son groupe de processus).
- `logs` : dernières lignes du journal du serveur, ou de la dernière mise à jour avec `--update`.

Chaque étape a un délai maximal (`timeoutSec`, 900 s par défaut, réglable par étape) ; au-delà, tout son groupe de processus est arrêté. Les valeurs du fichier d'environnement sont masquées dans le journal de mise à jour et les sorties ; le journal du serveur, écrit par le serveur lui-même, n'est masqué qu'à l'affichage (`logs`) et reste en droits 600. Un port occupé par un processus qui n'est pas l'aperçu n'est jamais libéré de force : `update` refuse. Configuration, forme des commandes (chaîne pour `sh -c`, tableau sans shell), masquage, sûreté et exemple Supabase : [PREVIEW.md](PREVIEW.md).

Sortie : `0` succès (pour `status` : aperçu en marche), `1` échec ou aperçu arrêté, `2` appel incorrect.

## `apv status`

```
apv status [--repo <chemin>] [--json]
```

Résumé de l'état du projet : fichier de configuration (et format V2 le cas échéant), contrôles déclarés, registre des décisions (nombre de décisions et empreinte, ou nombre d'erreurs), specs de `.apv/specs/` (titre ou erreur de lecture), fichiers d'état de `.apv/state/` (taille et date), une ligne par exécution en cours (`apv run` : étape, tâches faites, en cours, en échec ; un état illisible est signalé), dernier relevé de `.apv/state/quota.log`. En JSON, `runs` liste toutes les exécutions, terminées comprises. La commande ne modifie rien et sort toujours avec `0`, sauf appel incorrect.

## `apv help`

```
apv help [commande]
apv --version
```

Aide générale, ou aide d'une commande. `apv` sans argument affiche l'aide et sort avec `2`.
