# Outil `apv` (Agent Pipeline V3)

`apv` est l'outil en ligne de commande du plugin APV3. Il reprend de V2 ce qui a fait ses preuves (schéma des specs, registre des décisions, minimum de sécurité OWASP, périmètre des tâches, exécution des contrôles, reçus) sans le contrôleur : aucune commande ne lance d'agent, ne décide à la place du chef de projet ni n'écrit sur un service externe.

Installation locale : `npm run build`, puis `node dist/cli.js <commande>` ou `npx apv <commande>` depuis le dépôt du plugin. Node 22.16 ou plus, Git, Linux, macOS ou WSL2. Aucune dépendance d'exécution.

## Conventions communes

- Toutes les commandes acceptent `--help` (ou `apv help <commande>`).
- `--json` produit une sortie structurée, stable, sur la sortie standard ; sans elle, la sortie est un texte en français.
- `--repo <chemin>` désigne le projet (par défaut : le dossier courant).
- Codes de sortie : `0` succès, `1` échec du contrôle (spec invalide, contrôle rouge, fichier hors périmètre...), `2` appel incorrect ou commande indisponible.
- Fichiers lus dans le projet :
  - configuration : `.apv/config.json`, sinon `pipeline.v2.json` (projet V2, tant que `apv onboard` n'a pas créé `.apv/config.json`) ;
  - registre des décisions : `.apv/DECISIONS.json`, sinon `.agent-pipeline/DECISIONS.json` (projet V2).
- De la configuration, seules les sections `name` (nom du projet, écrit par `apv init`), `gates`, `risk`, `validationRules`, `environment.passEnv`, `skills`, `preview`, `design` et `structure` sont lues par le chargeur commun ; la section `db` est lue et validée par `apv db check`. Les champs d'agent, de budget, de délais, de modèles et de réglage d'un fichier V2 sont ignorés (et listés comme tels par `apv gates run --json` et `apv status --json`).

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

## `apv onboard`

```
apv onboard [--repo <chemin>] [--specs <dossier>] [--dry-run] [--json]
```

Fait passer sous APV3 un projet déjà commencé (`/apv:onboard`, spécification section 14). Comme `apv init`, la commande crée seulement ce qui manque dans `.apv/`, **sans jamais écraser un fichier existant**, et se relance sans effet ; elle travaille à la racine du dépôt Git et refuse hors d'un dépôt. Le nom du projet est celui du dossier du dépôt. Tout est lu et vérifié avant la première écriture : un refus laisse le dépôt intact.

**Projet V2** (`pipeline.v2.json` et/ou `.agent-pipeline/DECISIONS.json`) :

| Source V2 | Dans `.apv/` |
|---|---|
| `pipeline.v2.json` | `config.json` : `name`, puis `gates`, `risk`, `validationRules`, `skills` et `environment.passEnv` recopiés tels quels et validés par le schéma d'APV3. Tout le reste (`agent`, `roles`, `roleProfiles`, `modelRouting`, `workflow`, `feedback`, `limits`, `setup`, `concurrency`, `maxRunMs`, `environment.id`...) est **ignoré** et listé : ces champs pilotaient le contrôleur retiré. |
| `.agent-pipeline/DECISIONS.json` | `DECISIONS.json` : copie à l'identique. Le format du registre n'a pas changé entre V2 et V3 (même schéma, même `apv ledger validate`) : aucune conversion. `DECISIONS.md` est régénéré depuis le registre, comme par `apv ledger apply`. |
| specs V2 | `specs/<id>.json`, voir ci-dessous |

Un `pipeline.v2.json` ou un registre V2 illisible, ou refusé par le schéma (le registre : par les mêmes règles que `apv ledger validate`), fait sortir en `1` avec toutes les erreurs, **sans rien écrire** : un registre vide créé dans `.apv/` masquerait les décisions V2, puisque `.apv/DECISIONS.json` est lu en priorité. Un fichier V2 dont la cible existe déjà dans `.apv/` n'est pas relu. Les fichiers V2 restent en place, jamais modifiés.

**Specs V2.** V2 garde ses specs dans sa base d'état (`~/.local/state/agent-pipeline-v2`), hors du dépôt : l'outil ne la lit pas. Il cherche les fichiers de spec gardés par le projet (les propositions passées à `apv2 spec draft --file`) dans `.agent-pipeline/specs/`, `specs/`, `docs/specs/` et dans le dossier `--specs` (qui peut être hors du dépôt). Chaque fichier `.json` qui a la forme d'une spec (`title` et `tasks`, ou `{ "request", "spec" }`) est validé comme par `apv spec validate --draft` sur le dépôt ; accepté, il est copié tel quel dans `.apv/specs/<id>.json`, où `<id>` est son nom en kebab-case sans le suffixe `-import`. Une demande de l'opérateur rangée à côté (`<id>-request.txt`, comme dans le projet pilote) est jointe : le fichier écrit a alors la forme `{ "request": "...", "spec": { ... } }`. Les fichiers refusés sont listés avec leurs erreurs, jamais copiés.

**Projet sans V2** : `config.json` propose les contrôles que le dépôt déclare déjà, avec `mandatory: false` et, dans la sortie, leur source et une note (à relire, `covers`, `resources` et `passEnv` à compléter) :

| Contrôle | `package.json` (scripts) | `Makefile` (cibles) | `pyproject.toml` |
|---|---|---|---|
| `check` | `check`, `typecheck`, `type-check` | `check`, `typecheck` | `[tool.mypy]` : `mypy .` |
| `lint` | `lint` | `lint` | `[tool.ruff]` : `ruff check .` |
| `test` | `test` | `test` | `[tool.pytest]` : `python -m pytest` |
| `build` | `build` | `build` | |
| `e2e` | `e2e`, `test:e2e` | `e2e`, `test-e2e` | |

Le gestionnaire de paquets vient de `packageManager`, sinon du fichier de verrouillage (`pnpm`, `yarn`, `bun`, sinon `npm run <script>`) ; les outils Python passent par `uv run` ou `poetry run` si le projet a leur fichier de verrouillage. La première source trouvée gagne ; aucune commande n'est inventée. Le registre créé est vide.

Dans les deux cas, le reste est celui d'`apv init` : `brief.md`, `specs/`, `state/`, `.gitignore`. La sortie liste aussi les fichiers de `.agent-pipeline/` non repris (rôles, compétences : le plugin les fournit) et les indices d'aperçu (script `preview` ou `apercu`, fichier de `scripts/`), à décrire dans la section `preview` avec l'opérateur ; puis la suite : relire `config.json` et `brief.md`, `apv ledger validate`, `apv gates run` (avec `--base` si un contrôle utilise `{{baseSha}}`), commit de `.apv/`. Rien n'est commité.

`--dry-run` prend les mêmes décisions et affiche le même plan (« Serait créé »), sans rien écrire.

Sortie : `0` succès, `1` hors d'un dépôt Git, fichier V2 illisible ou invalide, modèle de consigne introuvable, `2` appel incorrect (dont un dossier `--specs` introuvable). En JSON : `repo`, `name`, `dryRun`, `v2` (`config`, `ledger`, `notImported`), `config` (`status`, `source`, `kept`, `ignored`, `gates`, `detected`), `ledger` (`status`, `source`, `decisions`, `hash`), `specs` (`searched`, `imported`, `existing`, `rejected`), `previewHints`, `created`, `completed`, `existing`, `next`.

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
3. à défaut, de la demande rangée par `/apv:spec` dans `.apv/state/demande-<id>.md` (pour la spec `.apv/specs/<id>.json`), que `apv run start` lit de la même façon : même minimum de sécurité à la validation et au lancement ;
4. à défaut, du texte de la spec elle-même (titre, problème, périmètre, critères, tâches ; les exclusions ne comptent pas).

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
            [--base sha] [--findings n] [--note texte] [--force-unintegrated] [--repo <chemin>] [--json]
apv run next <spec-id> [--repo <chemin>] [--json]
apv run status [<spec-id>] [--repo <chemin>] [--json]
apv run pause <spec-id> --until <HH:MM | date ISO> [--note texte] [--repo <chemin>] [--json]
apv run resume <spec-id> [--note texte] [--repo <chemin>] [--json]
```

État de reprise d'une exécution de spec (`/apv:run`, spécification section 8) dans `.apv/state/run-<spec-id>.json`, versionné avec le projet. Chaque écriture relit l'état, le modifie et le réécrit de façon atomique (fichier temporaire puis renommage) sous le verrou à bail `run:<spec-id>` (`apv lock`, attente de 60 s, ou `APV_RUN_LOCK_WAIT` secondes) : deux agents ne perdent jamais la mise à jour de l'autre. L'outil n'écrit rien d'autre : il ne crée ni branche ni worktree et ne lance aucun agent.

**`start`** valide la spec comme `apv spec validate` en mode lancement (refus en `1` avec toutes les erreurs), puis crée l'état. `<spec>` est un identifiant (`.apv/specs/<id>.json`) ou un chemin (l'identifiant est alors le nom du fichier). La base est `--base`, sinon la branche courante ; elle est enregistrée avec son commit (`baseSha`). Refus si l'état existe déjà : `apv run next` le reprend.

Vagues : les couches topologiques des `dependsOn` ; une tâche de profondeur d (0 sans dépendance, sinon un de plus que sa dépendance la plus profonde) est dans la vague d, dans l'ordre de la spec. Fondations : dans chaque couche, une tâche dont au moins **deux** autres tâches dépendent directement est marquée `foundation: true` dans l'état (le format de spec n'a pas de marqueur : ses tâches refusent les propriétés inconnues). Les fondations d'une vague sont écrites par un seul agent, ses autres tâches partent en parallèle ; une tâche dont une seule autre dépend reste une dépendance ordinaire (dans l'essai de la phase 3, BIN était devenue une fondation parce que DOCS en dépendait). `start` et `status` affichent, pour chaque vague qui en a, « fondations (un seul agent) : … » puis « en parallèle : … ».

Version de l'état : `schemaVersion` 2 depuis ce marqueur. Un état de version 1 (marqueur `foundation` porté par la vague 0) reste lisible : il est converti à la lecture, chaque tâche d'une vague marquée devenant une fondation (c'était la règle de la version 1) et les autres non, puis réécrit en version 2 à sa prochaine écriture. Les vagues et la vague de chaque tâche ne sont jamais recalculées : l'état garde le plan du lancement.

Forme de l'état :

```
{ schemaVersion: 2, specId, specFile, specSha256, base, baseSha, branch: "apv/<spec-id>", createdAt, updatedAt,
  steps: { "data-model" | plan | integration | reviews | fixes | delivery: { status, commit, note, updatedAt } },
  waves: [{ index, tasks: [id...] }],
  tasks: { <id>: { title, dependsOn, wave, foundation, status, branch, worktree, agentId, base, commit, note, updatedAt } },
  reviews: { securite | fidelite | donnees | rgpd: { status, findings, commit, note, updatedAt } },
  events: [{ at, target, from, to, note?, commit?, agentId?, unintegrated?, until? }],
  pause?: { since, until, note } }
```

Les dates de l'état sont des dates ISO en UTC (`Date#toISOString`) ; l'outil les affiche en heure locale (fuseau du système, ou `TZ`), avec leur décalage : `2026-09-24 20:22 UTC+2`. `pause` n'existe que pendant une pause (`apv run pause`) : un état jamais mis en pause garde la forme antérieure.

Statuts : `pending`, `running`, `done`, `failed`, `skipped`.

**`set`** change le statut d'une cible : une étape (`data-model`, `plan`, `integration`, `reviews`, `fixes`, `delivery`), `task:<id>` ou `review:<domaine>` (`securite`, `fidelite`, `donnees`, `rgpd`), et ajoute un événement horodaté. Règles :
- passages permis : `pending` vers `running`, `done`, `skipped`, `failed` ; `running` vers `done`, `failed`, `pending`, `skipped` ; `failed` vers `pending`, `running`, `skipped` ; `skipped` vers `pending`, `running` ; `done` vers `running`, `pending`. Garder le même statut met seulement à jour les champs (nouveau commit wip, autre agent) ;
- rouvrir un travail `done`, ou remplacer le commit enregistré d'une cible `done`, exige `--note` (la raison est journalisée) ;
- une tâche ne passe `running` que si toutes ses dépendances sont `done` **et intégrées** : le commit enregistré de chacune est un ancêtre de la tête de la branche de la spec (`branch` de l'état, `git merge-base --is-ancestor`), ou de la base de l'exécution (`baseSha`) tant que cette branche n'existe pas. Sinon refus en `1` qui nomme les dépendances et leur commit. `--force-unintegrated` passe outre pour les seules dépendances faites mais pas intégrées, avec `--note` obligatoire (sinon `2`) ; l'événement garde la note et la liste des dépendances (`unintegrated`). Une tâche déjà `running` qui met à jour ses champs n'est pas revérifiée ;
- une tâche `done` exige `--commit` ; le commit (sha ou nom de branche) doit exister dans le dépôt et il est enregistré en entier ;
- `--branch`, `--worktree` (chemin rendu absolu), `--agent` et `--base` (commit de départ de la tâche, pour la reprise) ne valent que pour une tâche ; `--findings` (nombre de constats) que pour une revue ; `--commit` vaut pour toute cible (facultatif sur une étape : commit du plan, tête intégrée ; sur une revue : commit revu), et reste vérifié dans le dépôt.

**`next`** dit ce qu'il faut faire maintenant, de façon déterministe : c'est la base de la reprise après une coupure (`/apv:resume`).
- Étape courante : la première étape non terminée (`done` ou `skipped`), avec `waves` entre `plan` et `integration` tant qu'une tâche reste à faire, et la vague courante (la plus basse qui a une tâche non terminée).
- Tâches prêtes : `pending` dont les dépendances sont `done` et intégrées (même règle que `set`), avec leur vague et leur marqueur de fondation. Règle unique : une tâche se lance dès qu'elle est prête, quelle que soit sa vague ; l'action les propose toutes, les fondations à un seul agent, les autres en parallèle.
- Tâches en attente d'intégration (`awaitingIntegration`) : dépendances toutes `done`, mais au moins une pas encore intégrée ; l'action nomme chaque dépendance à intégrer et les tâches qui l'attendent. `integration` donne la tête mesurée (`head`) et ce qu'elle est (`where` : la branche de la spec, ou la base tant qu'elle n'existe pas).
- Tâches `running` : **à relancer** si leur worktree n'existe plus, si leur branche est introuvable, si ni branche ni worktree ne sont enregistrés, ou si leur tête n'a aucun commit après leur base (`--base` donné au lancement de la tâche, sinon la base de l'exécution) ; sinon **à reprendre**, avec branche, worktree, agent, tête, nombre de commits après la base et dernier commit enregistré. Une tâche signalée à relancer ne l'est que si son agent ne tourne plus : un agent qui vient de démarrer n'a pas encore de commit.
- Tâches en échec, tâches bloquées (dépendances attendues), revues à lancer (`pending` ou `failed`, une fois les tâches finies et l'intégration faite) et revues en cours.
- `specChanged` : la spec a changé depuis `start` (empreinte différente) ; l'état garde le plan du lancement, l'action le signale.
- `suite` : rythme de la suite complète lu dans `run.fullSuite` de `.apv/config.json` (`mode`, `final` par défaut ou `each-integration`, [CONFIGURATION.md](CONFIGURATION.md#exécution--run)), niveau de vérification attendu à l'étape courante (`level` : `task`, contrôles de tâche et tests ciblés vérifiés par `apv gates verify --stage task --base <base ciblée>` ; `full`, suite complète et `apv gates verify` ; `null` à une étape sans intégration) et base ciblée (`targetBase`, `targetBaseWhere`) : le dernier commit prouvé par la suite complète, soit la base de l'exécution tant qu'aucune n'est passée, puis la tête de la dernière intégration (`integration done --commit`) avec `final`, la tête d'intégration avec `each-integration`. Les actions disent la commande attendue : intégration intermédiaire au niveau tâche, dernière intégration en suite complète avant les revues, corrections au niveau tâche avec le test de chaque correction, livraison sans double suite. Une configuration illisible laisse `final`, signalé en première action.
- `pause` : la pause de quota en cours (`since`, `until`, `note`), ou `null` ; signalée en première action tant qu'elle dure.

**`status`** résume toutes les exécutions (étape, tâches faites sur le total, en cours, en échec, pause de quota en cours, date) ou détaille une exécution (dates, pause en cours, étapes, vagues avec l'état de chaque tâche, revues, les cinq derniers événements avec leur note), heures en heure locale.

**`pause`** note que l'exécution attend la remise à zéro du quota, jusqu'à `--until` : `HH:MM` en heure locale (sa prochaine occurrence, demain si elle est passée) ou une date ISO avec fuseau (`2026-09-24T18:30:00Z`, `2026-09-24T20:30+02:00`) ; `--note` dit pourquoi (fenêtre, pourcentage). Elle écrit `pause` dans l'état et un événement `pause` (`running` vers `pending`, avec `until`) ; une nouvelle pause la prolonge en gardant son début et sa note. Refus en `1` sur une exécution terminée ou une fin déjà passée. **`resume`** la termine (événement `pause`, `pending` vers `running`) ; refus en `1` sans pause. Toute transition `apv run set` termine aussi une pause restée ouverte, journalisée avant elle. Un état illisible est signalé, jamais réécrit ; un état dont l'identifiant de spec diffère du nom de son fichier est refusé. `start`, `set`, `next` et `status <id>` lisent l'état visé comme le résumé : fichier ordinaire seulement (une FIFO ou un dossier nommé comme l'état est refusé sans bloquer), 4 Mio au plus ; l'erreur nomme le fichier par son chemin dans le dépôt et ne cite rien de son contenu. Le résumé est celui de `apv status` : 50 fichiers au plus, les plus récents, et 16 Mio au total, les autres comptés (`unread` en JSON).

Sortie : `0` succès, `1` refus (spec invalide, état déjà présent ou absent, transition refusée, commit introuvable, état illisible, verrou non obtenu), `2` appel incorrect (cible ou statut inconnu, option sans effet).

## `apv stack`

```
apv stack plan <pr...> [--target <branche>] [--ready] [--json]
APV_ALLOW_MERGE=1 apv stack merge <pr...> [--method merge|squash|rebase] [--target <branche>] [--ready] [--json]
```

Pile de PR, donnée par ses numéros dans l'ordre de fusion (de la base vers le sommet). Fin de l'incident 30 : re-ciblage vérifié, sortie jamais masquée, arrêt à la première anomalie.

**`plan`** lit chaque PR par `gh pr view <n> --json number,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,url` et vérifie la pile : chaque PR ouverte ; la base de la première est la branche cible (`--target`, sinon sa base actuelle), celle de la PR n+1 est la tête de la PR n ; `mergeable` à `MERGEABLE` et état de fusion `CLEAN` (ou `HAS_HOOKS`) ; contrôles au vert (`SUCCESS`, `NEUTRAL`, `SKIPPED`) ou absents. Un brouillon est une anomalie, sauf avec `--ready`. Une PR après la première doit avoir une adresse (`url`) de la forme `https://<hôte>/<propriétaire>/<dépôt>/pull/<n>`, avec son propre numéro : c'est elle qui donne le chemin du re-ciblage. Une mergeabilité encore en calcul (`UNKNOWN`) est relue quelques fois avant d'être une anomalie. Toutes les anomalies sont listées ; rien n'est modifié. Les appels `gh` en échec sont affichés en entier.

**`merge`** fusionne, uniquement sur ordre explicite de l'opérateur. Il exige `APV_ALLOW_MERGE=1` dans l'environnement ; sinon il sort en `2` avec le message du hook, sans aucun appel `gh`. Déroulé :
1. la pile est vérifiée comme par `plan` ; une anomalie arrête tout avant la première fusion ;
2. pour chaque PR, dans l'ordre : relecture ; si la précédente vient d'être fusionnée et que la PR vise encore sa tête, re-ciblage par l'API REST, `gh api -X PATCH repos/<propriétaire>/<dépôt>/pulls/<n> -f base=<cible>` (avec `--hostname <hôte>` hors de github.com), puis **relecture** quel que soit le code de sortie : un appel en échec arrête la pile, et la nouvelle base est constatée par la relecture, jamais déduite du code de sortie. Propriétaire, dépôt et hôte viennent de l'adresse que `gh pr view` a rendue pour cette PR : le même dépôt que la lecture, sans appel de plus. `gh pr edit --base` n'est plus employé : sa requête GraphQL lit aussi les projets classiques de la PR et échoue depuis leur abandon par GitHub (« Projects (classic) is being deprecated », constaté à la fusion des PR #70 et #71) ;
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
apv gates run [--stage task|full] [--only a,b] [--config <fichier>] [--base <ref>]
              [--concurrency N] [--keep-going] [--skip-proven] [--repo <chemin>] [--json]
```

Exécute les contrôles déclarés dans `gates` depuis la racine du dépôt, avec l'ordonnanceur de V2 :
- **dépendances** (`dependsOn`) : un contrôle attend les siens ; si l'un échoue, ses dépendants sont « bloqués » ;
- **ressources** (`resources`) : deux contrôles qui partagent une ressource nommée ne tournent jamais en même temps ;
- **lecture seule** (`readOnly`) : seuls les contrôles déclarés en lecture seule tournent en parallèle, un contrôle qui écrit a l'espace de travail pour lui seul ;
- **environnement** : chaque commande reçoit seulement `environment.passEnv` (par défaut `PATH`, `SystemRoot`, `WINDIR`, `TMPDIR`, `TEMP`, `TMP`, `LANG`) et le `passEnv` du contrôle ;
- **délais** : `timeoutMs` par contrôle (120 s par défaut) ; au-delà, le groupe de processus est arrêté ;
- **secrets** : les valeurs des variables dont le nom contient TOKEN, KEY, PASSWORD, SECRET ou CREDENTIAL sont masquées dans les diagnostics.

Paramètres des commandes (argument entier uniquement, jamais d'interprétation par un shell) : `{{workspace}}` (racine du dépôt), `{{candidateSha}}` (HEAD), `{{baseSha}}` (commit de `--base`, obligatoire si un contrôle l'utilise).

**Stage** : chaque contrôle peut déclarer `"stage": "task"` (contrôle rapide, lancé après chaque tâche) ou `"stage": "full"` (réservé à la suite complète, par exemple les tests navigateur). Champ absent : `task`, si bien qu'une configuration sans stage garde son sens (tout tourne partout). Un contrôle `task` ne peut pas dépendre d'un contrôle `full` (configuration refusée). `--stage task` exécute seulement les contrôles de stage `task` ; les contrôles `full` sélectionnés sont listés dans le tableau comme « réservé à la suite complète », dans `reserved` en JSON et dans `summary.json`, sans reçu : ils ne sont jamais comptés comme réussis. `--stage full` (défaut, comportement antérieur) exécute tout. Voir [RUN.md](RUN.md#contrôles--par-tâche-et-suite-complète) pour l'usage pendant un run.

**Contrôle ciblé** (`affected`) : un contrôle de stage `full` peut déclarer, en plus de `command`, une commande `affected` qui lance seulement les tests concernés par les changements depuis la base, par exemple `["apv", "lock", "run", "e2e", "--", "npx", "playwright", "test", "--only-changed={{baseSha}}", "--pass-with-no-tests"]` (exemple complet dans [CONFIGURATION.md](CONFIGURATION.md#graphe-de-contrôles)). `--stage task` exécute alors cette commande à la place du contrôle complet, avec le même identifiant, les mêmes dépendances, ressources, variables et délai. Le contrôle est signalé « ciblé » : `e2e (ciblé)` dans le tableau et les diagnostics, une phrase dans le verdict, `targeted: true` dans son reçu et sa ligne JSON, sa liste dans `targeted` en JSON et dans `summary.json`. Un reçu ciblé ne prouve jamais le contrôle complet : `apv gates verify` au niveau complet l'ignore ; au niveau tâche (`--stage task --base <ref>`), il prouve le contrôle quand la base de son exécution couvre `<ref>`. `--stage full` exécute toujours la commande complète. Si `affected` utilise `{{baseSha}}`, `--base` est obligatoire.

**Suite déjà prouvée** : avant d'exécuter la suite complète entière (`--stage full`, sans `--only`), l'outil regarde si elle est déjà prouvée sur ce commit exact, arbre propre (la vérification de `apv gates verify --commit HEAD` à `0`). Si oui, il le signale en tête de sortie (`alreadyProven: true` en JSON) avant de la relancer ; avec `--skip-proven`, il ne relance rien et sort en `0` (`skipped: true` en JSON, avec les reçus qui font la preuve). Arbre modifié, reçu manquant, échec plus récent ou autre configuration : pas de preuve, la suite tourne. `--skip-proven` avec `--stage task` ou `--only` : appel incorrect.

`--only` choisit des contrôles et ajoute leurs dépendances. Par défaut, le premier échec arrête les contrôles suivants ; `--keep-going` les laisse tous s'exécuter. `--concurrency` borne le parallélisme (3 par défaut).

Chaque exécution écrit dans `.apv/receipts/<exécution>/` un reçu JSON par contrôle (statut, code de sortie, durée, empreintes des sorties, empreinte de preuve liée au commit, à la configuration, à l'environnement et à l'exécutable, diagnostic en cas d'échec) et un `summary.json`. Le dossier `.apv/receipts/` contient un `.gitignore` : les reçus sont des preuves locales, jamais commitées. Chaque reçu note le commit (`candidateSha`), le stage demandé (`stage`) et l'état de l'arbre (`dirty`) ; le résumé reprend `stage`, `dirty`, `selected`, `added`, `reserved` et `targeted`. Le reçu d'un contrôle exécuté par sa commande ciblée porte `targeted: true`. Si l'arbre de travail avait des modifications non commitées (`dirty: true`), les reçus décrivent plus que le commit : `apv gates verify` ne les retient pas.

Différences avec V2 : pas d'espace de travail jetable (l'implémenteur exécute les contrôles dans le worktree qu'il possède), pas de cache de reçus (`cacheTtlMs` est ignoré), pas de commandes de préparation (`setup`).

En JSON : `ok`, `runId`, `candidateSha`, `baseSha`, `dirty`, `alreadyProven`, `stage`, `config`, `legacyConfig`, `ignoredSections`, `added`, `reserved`, `targeted`, `receiptsDirectory`, `gates` (contrôles exécutés, chacun avec `targeted`).

Sortie : `0` tous les contrôles exécutés passent, `1` au moins un échec ou une configuration invalide, `2` appel incorrect (dont un `--stage` inconnu ou `--commit`, propre à `verify`).

## `apv gates verify`

```
apv gates verify --commit <sha> [--stage full|task] [--base <ref>] [--config <fichier>] [--repo <chemin>] [--json]
```

Vérifie, sans rien exécuter, que les reçus de `.apv/receipts/` prouvent que chaque contrôle exigé a réussi sur ce commit exact. Contrôles exigés : tous avec `--stage full` (défaut) ; avec `--stage task` (niveau tâche, celui des intégrations intermédiaires et des corrections sous `run.fullSuite` à `final`), ceux de stage `task` et les contrôles `full` qui déclarent `affected`, les autres contrôles `full` étant listés dans `reserved`, jamais prouvés. `--commit` accepte toute révision que Git résout en commit (SHA complet ou abrégé, `HEAD`) ; la comparaison se fait sur le SHA complet.

Pour chaque contrôle exigé, seuls comptent les reçus de ce commit, écrits sur un arbre propre (`dirty: false` ; pour un reçu plus ancien sans ce champ, celui du `summary.json` de son exécution, sinon inconnu donc refusé) et avec la configuration actuelle des contrôles (même `configHash`). Les reçus de toute exécution comptent (une exécution `--stage task` prouve ses contrôles autant qu'une suite complète), mais seul le plus récent de chaque contrôle est retenu : un échec plus récent l'emporte toujours sur une réussite plus ancienne. États : `passed` (réussi), `failed` (échec, avec le statut du reçu), `dirty` (reçus seulement sur un arbre modifié), `missing` (aucun reçu). Les fichiers illisibles et les reçus d'une autre configuration sont ignorés et signalés. Au niveau complet, les reçus ciblés (`targeted: true`, commande `affected` lancée par `--stage task`) ne comptent jamais, ni comme réussite ni comme échec : seule la suite complète prouve un contrôle `full` ; ils sont comptés dans `targeted` et signalés si le contrôle n'est pas prouvé.

Au niveau tâche, un contrôle `full` qui déclare `affected` est prouvé par son reçu ciblé ou par un reçu complet, le plus récent des deux décidant. `--base <ref>` est alors obligatoire (sinon refus `GATE_BASE`, sortie `1`) : le dernier commit prouvé par la suite complète, que donne `apv run next`. Un reçu ciblé ne compte que si la base de son exécution (le `baseSha` du `summary.json` de son exécution) est `<ref>` ou l'un de ses ancêtres, c'est-à-dire s'il a couvert au moins tous les changements depuis `<ref>` ; les autres sont comptés dans `otherBase` et signalés. Un reçu complet compte quelle que soit la base. `--base` sans `--stage task` : appel incorrect. Une vérification du niveau tâche ne remplace jamais la suite complète avant une PR.

En JSON : `ok`, `commit`, `stage`, `base`, `config`, `configHash`, `required`, `targeted` (contrôles exigés par leur variante ciblée), `reserved`, `gates` (`gateId`, `state`, `status`, `receipt`, `runId`, `otherConfig`, `targeted`, `viaTargeted`, `proof` : `full`, `targeted` ou `null`, `otherBase`), `unreadable`, `missing` (contrôles non prouvés).

Sortie : `0` preuve complète, `1` preuve incomplète (ce qui manque est listé, avec la commande à relancer), commit introuvable, aucun contrôle exigé, `--base` manquant pour des contrôles ciblés ou configuration invalide, `2` appel incorrect (`--commit` absent, `--base` sans `--stage task`, option propre à `run`).

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

## `apv structure check`

```
apv structure check [--path <dossier>]... [--repo <chemin>] [--json]
```

Analyse déterministe de l'arborescence : les fichiers suivis par Git (`git ls-files`), jamais les fichiers ignorés ni non suivis, et seulement les fichiers de code (TypeScript, JavaScript, Svelte, Vue, Python, Go, Rust...). `node_modules/`, `dist/`, `build/`, `coverage/`, `vendor/` et les dossiers qui commencent par un point (`.github`, `.claude`...) sont toujours laissés de côté. Chaque dossier est examiné pour ses fichiers directs ; un fichier et ses compagnons (`x.ts`, `x.svelte.ts`, `x.d.ts`) comptent pour un, ses tests (`x.test.ts`, `x.spec.ts`, `x.fixture.ts`, dossiers `tests/`, `__tests__/`, `e2e/`) sont comptés à part et le suivent quand il est déplacé.

| Constat | Quand | Proposition |
|---|---|---|
| `flat-folder` | plus de `maxFlatFiles` fichiers de code directement dans le dossier (12 par défaut) | ranger par domaine selon le plan, ou découpage à décider avec l'opérateur si aucun préfixe ni rôle n'aide |
| `repeated-prefix` | plusieurs fichiers commencent par le même mot de domaine, singulier et pluriel rapprochés (`application-actions.ts`, `applications-repository.ts`) : deux fichiers qui ont un rôle, trois fichiers, ou un mot qui est déjà le nom d'un dossier du projet ou un domaine déclaré | `<domaine>/` avec des noms sans préfixe (`applications/actions.ts`) ; des composants (`QuickAddDialog.svelte`) gardent leur nom et ne sont regroupés, par trois au moins, que dans un dossier trop plein |
| `mixed-roles` | au moins trois fichiers à rôle, deux rôles et deux domaines côte à côte (`*-actions`, `*-repository`, `*-client`, utilitaires HTTP ou d'authentification) | un dossier par domaine (`settings/repository.ts`), les utilitaires transverses regroupés par rôle (`http/`, `auth/`) sans changer leur nom |
| `stray-file` | un fichier dont le nom commence par celui d'un dossier voisin (`email-templates.ts` à côté de `email/`) | le ranger dans ce dossier (`email/templates.ts`) |

Les rôles se reconnaissent par suffixe (`-actions`, `-action`, `-repository`, `-repo`, `-client`, `-service`, `-controller`, `-handler`, `-middleware`, `-utils`, `-helpers`) ou par un mot du nom (`http`, `headers`, `cookie`, `cors`, `csrf`, `request`, `response`, `body`, `ip` pour le rôle `http` ; `auth`, `oauth`, `login`, `logout`, `sign-in`, `sign-out`, `sign-up`, `session`, `password` pour `auth`). Dans un dossier à rôles mêlés, des noms composés qui s'enchaînent sont un même sujet : `account-deletion.ts`, `deletion-purge.ts` et `purge-schedule.ts` vont ensemble dans `account/`. Un déplacement n'écrase jamais un fichier suivi : le nom est gardé, sinon le fichier reste en place. Les fichiers qu'aucune règle ne place sont listés « restent en place, à décider avec l'opérateur ».

Le plan (`ancien -> nouveau`) n'est **jamais appliqué** par l'outil : il se valide avec l'opérateur, puis se fait par `git mv`, imports, configuration des outils et documentation mis à jour, sans changement de comportement.

- `--path` limite les constats à un dossier et à ses sous-dossiers (chemin relatif à la racine du dépôt, répétable) : l'architecte l'utilise sur les dossiers que touche son plan.
- Configuration facultative, section `structure` de `.apv/config.json` : [CONFIGURATION.md](CONFIGURATION.md#arborescence--structure).

Sortie : `0` aucun constat de gravité `error` (par défaut tout est `warning` : l'analyse ne fait pas échouer un projet qui n'a rien déclaré), `1` au moins un constat `error` ou configuration invalide, `2` appel incorrect (sous-commande, option, `--path` hors du dépôt). En JSON : `ok`, `analyzedFiles`, `maxFlatFiles`, `folders` (dossier, fichiers de code, tests, compagnons, fichiers non placés), `findings` (`code`, `severity`, `folder`, `files`, `proposal`, `moves`), `plan` (tous les déplacements, tests et compagnons compris), `repo`, `paths`.

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

Résumé de l'état du projet : fichier de configuration (et format V2 le cas échéant), contrôles déclarés, registre des décisions (nombre de décisions et empreinte, ou nombre d'erreurs), specs de `.apv/specs/` (titre ou erreur de lecture), fichiers d'état de `.apv/state/` (taille et date), une ligne par exécution en cours (`apv run` : étape, tâches faites, en cours, en échec ; un état illisible est signalé), dernier relevé de `.apv/state/quota.log`. En JSON, `runs` liste les exécutions lues, terminées comprises, et `runsUnread` le nombre de fichiers d'état laissés de côté (50 fichiers et 16 Mio au plus, les plus récents d'abord). Les noms de fichiers, titres et erreurs affichés sont nettoyés (une ligne, sans séquence d'échappement ni caractère de contrôle). La commande ne modifie rien et sort toujours avec `0`, sauf appel incorrect.

## `apv help`

```
apv help [commande]
apv --version
```

Aide générale, ou aide d'une commande. `apv` sans argument affiche l'aide et sort avec `2`.
