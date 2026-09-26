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
- De la configuration, seules les sections `name` (nom du projet, écrit par `apv init`), `gates`, `risk`, `validationRules`, `environment.passEnv`, `skills`, `preview`, `design`, `structure`, `run`, `spec`, `review` et `receipts` sont lues par le chargeur commun ; la section `db` est lue et validée par `apv db check`. Les champs d'agent, de budget, de délais, de modèles et de réglage d'un fichier V2 sont ignorés (et listés comme tels par `apv gates run --json` et `apv status --json`).

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

Maquettes validées : si la configuration existante déclare leur dossier (`design.dir`) ou si ce dossier existe (`docs/design` par défaut), `apv init` ajoute aussi à `.gitattributes` (créé ou complété) la ligne `<dossier>/*.html -whitespace`, quand Git ne l'applique pas déjà (`git check-attr whitespace`) : voir [`apv design`](#apv-design). `apv onboard` fait de même.

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

**Décisions exigées.** Chaque décision `product` confirmée du registre doit être couverte par un critère (`decisionCoverage`), et chaque décision `product` ambiguë posée en question, **sauf si elle déclare un périmètre qui ne concerne pas la spec** : champ facultatif `scope` de la décision ([DECISIONS.md](DECISIONS.md#périmètre-dune-décision--scope)), avec `paths` (motifs de chemins, syntaxe des chemins autorisés) et/ou `specs` (identifiants de specs). Une décision avec `scope` est exigée quand un de ses motifs peut désigner un chemin que les `allowedPaths` d'une tâche autorisent (recoupement exact des deux motifs), ou quand `specs` nomme la spec (nom du fichier sans `.json`) ; une décision sans `scope` reste exigée de toute spec. Le message d'une décision non couverte dit pourquoi elle est exigée (« sans périmètre », « son périmètre src/** recoupe le chemin autorisé src/lib/x.ts », « son périmètre nomme la spec ») et propose la solution : la rattacher à un critère, ou, si elle ne concerne pas la spec, lui donner un périmètre par une décision qui la remplace (`supersedes`, `apv ledger plan` puis `apply`).

**Avertissements de taille et de profondeur** (jamais une erreur, sans effet sur le code de sortie) : au-delà des seuils de la section `spec` de `.apv/config.json` ([CONFIGURATION.md](CONFIGURATION.md#taille-des-specs--spec)), plus de `maxTasks` tâches (6 par défaut) ou de `maxAcceptance` critères (30), la validation propose de découper la demande en specs indépendantes de 4 à 6 tâches, livrées en parallèle, chacune avec sa PR (`SPEC_SIZE`) ; au-delà de `maxDepth` couches de dépendances (3, les vagues de `apv run start`), elle nomme le chemin le plus long et propose le motif « contrats d'abord » (`SPEC_DEPTH`). En sortie lisible, une section « N avertissement(s) » après le résultat.

Sortie : `0` spec valide, `1` spec invalide ou illisible, `2` appel incorrect. En JSON : `valid`, `issues` (`code`, `message`), `warnings` (`code`, `message`), `limits` (`maxTasks`, `maxAcceptance`, `maxDepth` appliqués), `security` (`minimumLane`, `topics`, `requiresThreatModel`, `negativeTestsRequired`, `signals`), `requestSource`, `ledgerFile`, `configFile`, `sha`.

## `apv spec new`

```
apv spec new <id> [--title <texte>] [--repo <chemin>] [--json]
```

Écrit le gabarit `.apv/specs/<id>.json` : une tâche exemple, un critère, des passages « À compléter » et une question ouverte (`Q-REDACTION`). Le gabarit passe `apv spec validate --draft` ; la question ouverte fait refuser un gabarit non rédigé par la validation de lancement et par `apv run start`. `<id>` est en kebab-case (minuscules, chiffres, tirets simples, 80 caractères au plus) ; le titre est `--title`, sinon l'identifiant. Un fichier existant n'est jamais écrasé.

Sortie : `0` gabarit écrit, `1` fichier existant ou hors d'un dépôt Git, `2` appel incorrect.

## `apv run`

```
apv run start <spec> [--base <branche>] [--repo <chemin>] [--json]
apv run set <spec-id> <cible> <statut> [--branch b] [--worktree w] [--agent id] [--commit ref]
            [--base ref] [--findings n] [--confidence prouve|probable|suppose] [--note texte]
            [--force-unintegrated] [--repo <chemin>] [--json]
apv run next <spec-id> [--repo <chemin>] [--json]
apv run status [<spec-id>] [--repo <chemin>] [--json]
apv run pause <spec-id> --until <HH:MM | date ISO> [--note texte] [--repo <chemin>] [--json]
apv run resume <spec-id> [--note texte] [--repo <chemin>] [--json]
```

État de reprise d'une exécution de spec (`/apv:run`, spécification section 8) dans `.apv/state/run-<spec-id>.json`, versionné avec le projet. Chaque écriture relit l'état, le modifie et le réécrit de façon atomique (fichier temporaire puis renommage) sous le verrou à bail `run:<spec-id>` (`apv lock`, attente de 60 s, ou `APV_RUN_LOCK_WAIT` secondes) : deux agents ne perdent jamais la mise à jour de l'autre. L'outil n'écrit rien d'autre : il ne crée ni branche ni worktree et ne lance aucun agent.

**Checkout de l'état.** `start` crée l'état dans le checkout courant (ou `--repo`), celui de l'exécution. Les autres sous-commandes sur une exécution (`set`, `next`, `status <id>`, `pause`, `resume`) lisent et écrivent l'état du checkout courant quand il a `.apv/state/run-<id>.json`, comme avant ; sinon elles le cherchent dans tous les worktrees du dépôt (`git worktree list --porcelain`), le disent par une note sur la sortie d'erreur et travaillent dans le worktree trouvé. Plusieurs copies : le worktree sur la branche `apv/<id>`, sinon le checkout principal, sinon refus `RUN_AMBIGUOUS` (sortie `1`) qui liste les emplacements. Plusieurs exécutions tournent ainsi côte à côte, chacune dans son worktree. Un worktree qui a sa propre copie de l'état (état versionné venu avec un commit) lit cette copie : lance `apv run` depuis le checkout de l'exécution ou depuis un worktree sans copie.

**`start`** valide la spec comme `apv spec validate` en mode lancement (refus en `1` avec toutes les erreurs), puis crée l'état. `<spec>` est un identifiant (`.apv/specs/<id>.json`) ou un chemin (l'identifiant est alors le nom du fichier). La base est `--base`, sinon la branche courante ; elle est enregistrée avec son commit (`baseSha`). Refus si l'état existe déjà : `apv run next` le reprend.

Vagues : les couches topologiques des `dependsOn` ; une tâche de profondeur d (0 sans dépendance, sinon un de plus que sa dépendance la plus profonde) est dans la vague d, dans l'ordre de la spec. Fondations : dans chaque couche, une tâche dont au moins **deux** autres tâches dépendent directement est marquée `foundation: true` dans l'état (le format de spec n'a pas de marqueur : ses tâches refusent les propriétés inconnues). Les fondations d'une vague sont écrites par un seul agent, ses autres tâches partent en parallèle ; une tâche dont une seule autre dépend reste une dépendance ordinaire (dans l'essai de la phase 3, BIN était devenue une fondation parce que DOCS en dépendait). `start` et `status` affichent, pour chaque vague qui en a, « fondations (un seul agent) : … » puis « en parallèle : … ».

Version de l'état : `schemaVersion` 2 depuis ce marqueur. Un état de version 1 (marqueur `foundation` porté par la vague 0) reste lisible : il est converti à la lecture, chaque tâche d'une vague marquée devenant une fondation (c'était la règle de la version 1) et les autres non, puis réécrit en version 2 à sa prochaine écriture. Les vagues et la vague de chaque tâche ne sont jamais recalculées : l'état garde le plan du lancement.

Forme de l'état :

```
{ schemaVersion: 2, specId, specFile, specSha256, base, baseSha, branch: "apv/<spec-id>", createdAt, updatedAt,
  steps: { "data-model" | plan | integration | reviews | fixes | delivery: { status, commit, note, updatedAt, confidence? } },
  waves: [{ index, tasks: [id...] }],
  tasks: { <id>: { title, dependsOn, wave, foundation, status, branch, worktree, agentId, base, commit, note, updatedAt, confidence? } },
  reviews: { securite | fidelite | donnees | rgpd: { status, findings, commit, note, updatedAt } },
  events: [{ at, target, from, to, note?, commit?, agentId?, unintegrated?, until?, confidence? }],
  pause?: { since, until, note } }
```

Les dates de l'état sont des dates ISO en UTC (`Date#toISOString`) ; l'outil les affiche en heure locale (fuseau du système, ou `TZ`), avec leur décalage : `2026-09-24 20:22 UTC+2`. `pause` n'existe que pendant une pause (`apv run pause`) : un état jamais mis en pause garde la forme antérieure. De même, `confidence` n'existe que sur une tâche ou l'étape `fixes` dont le niveau a été noté (`--confidence`) : un état écrit avant ce champ reste lisible et garde sa forme ; un état qui en porte un n'est pas lisible par une version antérieure de l'outil (propriété inconnue).

Statuts : `pending`, `running`, `done`, `failed`, `skipped`.

**`set`** change le statut d'une cible : une étape (`data-model`, `plan`, `integration`, `reviews`, `fixes`, `delivery`), `task:<id>` ou `review:<domaine>` (`securite`, `fidelite`, `donnees`, `rgpd`), et ajoute un événement horodaté. Règles :
- passages permis : `pending` vers `running`, `done`, `skipped`, `failed` ; `running` vers `done`, `failed`, `pending`, `skipped` ; `failed` vers `pending`, `running`, `skipped` ; `skipped` vers `pending`, `running` ; `done` vers `running`, `pending`. Garder le même statut met seulement à jour les champs (nouveau commit wip, autre agent) ;
- rouvrir un travail `done`, ou remplacer le commit enregistré d'une cible `done`, exige `--note` (la raison est journalisée) ;
- sauter une revue (`review:<domaine> skipped`) exige `--note` (la raison de `apv review plan`) ; `review:securite skipped` est toujours refusé : la revue sécurité n'est jamais sautée ;
- une tâche ne passe `running` que si toutes ses dépendances sont `done` **et intégrées** : le commit enregistré de chacune est un ancêtre de la tête de la branche de la spec (`branch` de l'état, `git merge-base --is-ancestor`), ou de la base de l'exécution (`baseSha`) tant que cette branche n'existe pas. Sinon refus en `1` qui nomme les dépendances et leur commit. `--force-unintegrated` passe outre pour les seules dépendances faites mais pas intégrées, avec `--note` obligatoire (sinon `2`) ; l'événement garde la note et la liste des dépendances (`unintegrated`). Une tâche déjà `running` qui met à jour ses champs n'est pas revérifiée ;
- une tâche `done` exige `--commit` ; `--commit` et `--base` acceptent un sha complet ou abrégé, ou un nom de branche, que l'outil résout par git (`git rev-parse --verify <ref>^{commit}`) : le sha complet est enregistré et affiché, suivi de « résolu depuis « <ref> » » quand il diffère de ce qui a été donné (JSON : `resolved.commit` et `resolved.base`, `{ input, sha }`). Un commit introuvable est refusé en `1` (`RUN_COMMIT`), et le message aide à trouver le bon : le commit que désignent ses 7 premiers caractères quand ils en désignent un (un sha recopié d'un rapport peut être inventé au-delà : projet pilote, 24 septembre 2026), et la tête de la branche de la tâche (`--branch`, sinon celle de l'état) ;
- `--confidence prouve|probable|suppose` note le niveau de confiance du travail terminé : seulement avec `done`, pour une tâche ou l'étape `fixes` (sinon `2`). Il est gardé dans l'état (`confidence`) et dans l'événement, affiché par `status`, et retiré quand le travail quitte `done` ; `done` sans `--confidence` garde le niveau déjà noté ;
- `--branch`, `--worktree` (chemin rendu absolu), `--agent` et `--base` (commit de départ de la tâche, pour la reprise) ne valent que pour une tâche ; `--findings` (nombre de constats) que pour une revue ; `--commit` vaut pour toute cible (facultatif sur une étape : commit du plan, tête intégrée ; sur une revue : commit revu), et reste vérifié dans le dépôt.

**`next`** dit ce qu'il faut faire maintenant, de façon déterministe : c'est la base de la reprise après une coupure (`/apv:resume`).
- Étape courante : la première étape non terminée (`done` ou `skipped`), avec `waves` entre `plan` et `integration` tant qu'une tâche reste à faire, et la vague courante (la plus basse qui a une tâche non terminée).
- Tâches prêtes : `pending` dont les dépendances sont `done` et intégrées (même règle que `set`), avec leur vague et leur marqueur de fondation. Règle unique : une tâche se lance dès qu'elle est prête, quelle que soit sa vague ; l'action les propose toutes, les fondations à un seul agent, les autres en parallèle.
- Tâches en attente d'intégration (`awaitingIntegration`) : dépendances toutes `done`, mais au moins une pas encore intégrée ; l'action nomme chaque dépendance à intégrer et les tâches qui l'attendent. `integration` donne la tête mesurée (`head`) et ce qu'elle est (`where` : la branche de la spec, ou la base tant qu'elle n'existe pas).
- Tâches `running` : **à relancer** si leur worktree n'existe plus, si leur branche est introuvable, si ni branche ni worktree ne sont enregistrés, ou si leur tête n'a aucun commit après leur base (`--base` donné au lancement de la tâche, sinon la base de l'exécution) ; sinon **à reprendre**, avec branche, worktree, agent, tête, nombre de commits après la base et dernier commit enregistré. Une tâche signalée à relancer ne l'est que si son agent ne tourne plus : un agent qui vient de démarrer n'a pas encore de commit.
- Tâches en échec, tâches bloquées (dépendances attendues), revues à lancer (`pending` ou `failed`, une fois les tâches finies et l'intégration faite) et revues en cours.
- `specChanged` : la spec a changé depuis `start` (empreinte différente) ; l'état garde le plan du lancement, l'action le signale.
- `suite` : rythme de la suite complète lu dans `run.fullSuite` de `.apv/config.json` (`mode`, `final` par défaut ou `each-integration`, [CONFIGURATION.md](CONFIGURATION.md#exécution--run)), niveau de vérification attendu à l'étape courante (`level` : `task`, contrôles de tâche et tests ciblés vérifiés par `apv gates verify --stage task --base <base ciblée>` ; `full`, suite complète et `apv gates verify` ; `null` à une étape sans intégration) et base ciblée (`targetBase`, `targetBaseWhere`) : le dernier commit prouvé par la suite complète, soit la base de l'exécution tant qu'aucune n'est passée, puis la tête de la dernière intégration (`integration done --commit`) avec `final`, la tête d'intégration avec `each-integration`. Les actions disent la commande attendue : intégration intermédiaire au niveau tâche, dernière intégration en suite complète avant les revues, corrections au niveau tâche avec le test de chaque correction, livraison sans double suite. Une configuration illisible laisse `final`, signalé en première action. `apv gates run --stage full` applique ce même niveau : refus au niveau `task`, sauf `--reason` (section `apv gates run`).
- `pause` : la pause de quota en cours (`since`, `until`, `note`), ou `null` ; signalée en première action tant qu'elle dure.
- `unproven` : le travail fait noté en dessous de `prouve` (`{ target, confidence }`, les tâches puis `fixes`) ; une action par entrée : `probable`, une vérification d'abord ; `suppose`, prouver ou remonter à l'opérateur avant toute fusion, action sur la production ou annonce « corrigé ». Le travail fait sans niveau noté n'y figure pas.

**`status`** résume toutes les exécutions (étape, tâches faites sur le total, en cours, en échec, pause de quota en cours, date) ou détaille une exécution (dates, pause en cours, étapes, vagues avec l'état de chaque tâche et son niveau de confiance noté, revues, les cinq derniers événements avec leur note), heures en heure locale.

**`pause`** note que l'exécution attend la remise à zéro du quota, jusqu'à `--until` : `HH:MM` en heure locale (sa prochaine occurrence, demain si elle est passée) ou une date ISO avec fuseau (`2026-09-24T18:30:00Z`, `2026-09-24T20:30+02:00`) ; `--note` dit pourquoi (fenêtre, pourcentage). Elle écrit `pause` dans l'état et un événement `pause` (`running` vers `pending`, avec `until`) ; une nouvelle pause la prolonge en gardant son début et sa note. Refus en `1` sur une exécution terminée ou une fin déjà passée. **`resume`** la termine (événement `pause`, `pending` vers `running`) ; refus en `1` sans pause. Toute transition `apv run set` termine aussi une pause restée ouverte, journalisée avant elle. Un état illisible est signalé, jamais réécrit ; un état dont l'identifiant de spec diffère du nom de son fichier est refusé. `start`, `set`, `next` et `status <id>` lisent l'état visé comme le résumé : fichier ordinaire seulement (une FIFO ou un dossier nommé comme l'état est refusé sans bloquer), 4 Mio au plus ; l'erreur nomme le fichier par son chemin dans le dépôt et ne cite rien de son contenu. Le résumé est celui de `apv status` : 50 fichiers au plus, les plus récents, et 16 Mio au total, les autres comptés (`unread` en JSON).

Sortie : `0` succès, `1` refus (spec invalide, état déjà présent ou absent, transition refusée, commit introuvable, état illisible, verrou non obtenu), `2` appel incorrect (cible ou statut inconnu, option sans effet).

## `apv stack`

```
apv stack plan <pr...> [--target <branche>] [--ready] [--allow-behind --reason <texte>] [--json]
APV_ALLOW_MERGE=1 apv stack merge <pr...> [--method merge|squash|rebase] [--target <branche>] [--ready] [--allow-behind --reason <texte>] [--json]
```

Pile de PR, donnée par ses numéros dans l'ordre de fusion (de la base vers le sommet). Fin de l'incident 30 : re-ciblage vérifié, sortie jamais masquée, arrêt à la première anomalie.

**`plan`** lit chaque PR par `gh pr view <n> --json number,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,url` et vérifie la pile : chaque PR ouverte ; la base de la première est la branche cible (`--target`, sinon sa base actuelle), celle de la PR n+1 est la tête de la PR n ; `mergeable` à `MERGEABLE` et état de fusion `CLEAN` (ou `HAS_HOOKS`) ; contrôles au vert (`SUCCESS`, `NEUTRAL`, `SKIPPED`) ou absents ; **base à jour** : la tête de chaque PR contient la tête actuelle de sa base (la branche cible pour la première, la branche de la PR précédente pour les suivantes ; voir plus bas). Un brouillon est une anomalie, sauf avec `--ready`. Chaque PR doit avoir une adresse (`url`) de la forme `https://<hôte>/<propriétaire>/<dépôt>/pull/<n>`, avec son propre numéro : c'est elle qui donne le chemin de la comparaison et du re-ciblage. Une mergeabilité encore en calcul (`UNKNOWN`) est relue quelques fois avant d'être une anomalie. Toutes les anomalies sont listées ; rien n'est modifié. Les appels `gh` en échec sont affichés en entier.

**`merge`** fusionne, uniquement sur ordre explicite de l'opérateur. Il exige `APV_ALLOW_MERGE=1` dans l'environnement ; sinon il sort en `2` avec le message du hook, sans aucun appel `gh`. Déroulé :
1. la pile est vérifiée comme par `plan` ; une anomalie arrête tout avant la première fusion ;
2. pour chaque PR, dans l'ordre : relecture ; si la précédente vient d'être fusionnée et que la PR vise encore sa tête, re-ciblage par l'API REST, `gh api -X PATCH repos/<propriétaire>/<dépôt>/pulls/<n> -f base=<cible>` (avec `--hostname <hôte>` hors de github.com), puis **relecture** quel que soit le code de sortie : un appel en échec arrête la pile, et la nouvelle base est constatée par la relecture, jamais déduite du code de sortie. Propriétaire, dépôt et hôte viennent de l'adresse que `gh pr view` a rendue pour cette PR : le même dépôt que la lecture, sans appel de plus. `gh pr edit --base` n'est plus employé : sa requête GraphQL lit aussi les projets classiques de la PR et échoue depuis leur abandon par GitHub (« Projects (classic) is being deprecated », constaté à la fusion des PR #70 et #71) ;
3. vérification juste avant la fusion (ouverte, bonne base, fusionnable, contrôles) ; avec `--ready`, `gh pr ready <n>` puis relecture ; enfin la base à jour, contre la cible telle qu'elle est à cet instant (après la fusion de la PR précédente et le re-ciblage) ;
4. `gh pr merge <n> --<méthode> --match-head-commit <tête relue>` : si la branche a bougé depuis la vérification, GitHub refuse ;
5. relecture : état `MERGED` et base attendue, sinon arrêt.

**Base à jour.** Incident du projet pilote (25 septembre 2026) : deux PR préparées en parallèle sur `main`, l'une ajoutant un test qui importe un module, l'autre déplaçant ce module, chacune au vert seule, fusionnées l'une après l'autre : `main` est devenue rouge, car la seconde n'avait jamais été vérifiée contre la `main` qui contenait déjà la première. Les contrôles d'une PR ne portent sur le résultat de sa fusion que si sa tête contient sa base. L'outil le lit par l'API REST : `gh api repos/<propriétaire>/<dépôt>/compare/<tête>...<base> --jq …` (même hôte que la PR), qui donne le nombre de commits de la base absents de la tête (`ahead_by`), ces commits (combien sont listés, combien sont des fusions) et les fichiers qu'ils changent depuis la base commune. Verdict :
- `à jour` : aucun commit de la base n'y manque ;
- `à jour en contenu` : les commits manquants sont tous listés, tous des commits de fusion, et ne changent aucun fichier (cas de la PR suivante d'une pile fusionnée par `--method merge` : la fusion de la précédente n'apporte rien que la tête n'ait déjà) ; fusionner la base dans la tête ne changerait rien ;
- `EN RETARD` : la base apporte des changements que la tête n'a jamais vus (ou GitHub ne les liste pas) : la PR est refusée (anomalie de `plan`, arrêt de `merge`, code `1`) avec la marche à suivre : dans la branche, `git fetch origin` puis `git merge origin/<base>` (une fusion, jamais de rebase ni de force-push) ; repasser au moins les contrôles de tâche sur la nouvelle tête (`apv gates run --stage task --base origin/<base>`, puis `apv gates verify --commit <nouvelle tête> --stage task --base origin/<base>` à `0`) ; `git push` sans force ; attendre les contrôles GitHub au vert ; relancer `apv stack plan` puis `apv stack merge` ;
- comparaison impossible (appel en échec, réponse illisible) : refus, jamais pris pour « à jour ».

Avec `--method squash` ou `rebase`, la fusion d'une PR crée sur la cible des commits neufs qui portent ses changements : la PR suivante d'une pile est alors en retard et doit être mise à jour avant sa fusion (la commande s'arrête sur elle). Avec `--method merge` (défaut), une pile dont chaque PR est à jour de la précédente passe d'un trait, sauf si autre chose arrive sur la cible entre-temps. La preuve locale au commit exact de la tête (`apv gates verify --commit <tête> --stage task --base origin/<base>`) n'est pas exigée par l'outil (elle dépend des reçus de la machine et bloquerait une PR sans reçus, de documentation ou venue d'ailleurs) : c'est une étape du chef de projet après chaque mise à jour (compétence `/apv:stack`) ; un projet qui ne déclare aucun contrôle de tâche s'en remet aux contrôles GitHub.

**Dérogation, exceptionnelle.** `--allow-behind --reason "<texte>"` (1 à 500 caractères, les deux ensemble, sinon code `2`) laisse passer une PR en retard sur sa base, jamais une comparaison impossible. `plan` la montre sans rien écrire ; `merge` la journalise **avant** la fusion dans `.apv/state/stack.log` du dépôt courant (une ligne JSON : date, `event` `allow-behind`, pile, méthode, PR, tête, base, commits manquants, fichiers, raison ; `state/*.log` n'est jamais versionné) et dans le rapport (`DÉROGATION`, champ `derogations` en JSON) ; un journal impossible à écrire refuse la fusion. Elle vaut pour toutes les PR de la commande : on la réserve à une commande d'une seule PR, sur ordre de l'opérateur qui connaît le risque (la cible peut devenir rouge), jamais pour gagner du temps.

La sortie complète de chaque appel `gh` (commande, sortie standard, sortie d'erreur, code) est affichée au fil de l'eau, sur la sortie d'erreur avec `--json` (et dans le champ `calls`). À la première anomalie, rien d'autre n'est fusionné et le rapport donne les PR fusionnées, la PR d'arrêt, ses raisons et les PR restantes. La commande ne supprime aucune branche.

Le hook de garde bloque `apv stack merge` (et `node …/dist/cli.js stack merge`) sans `APV_ALLOW_MERGE=1` en préfixe, comme `gh pr merge`, et refuse sa sortie envoyée vers `/dev/null`. La variable `APV_GH` remplace l'exécutable `gh` (tests avec un faux `gh`) ; `APV_STACK_POLL_MS` et `APV_STACK_POLL_ATTEMPTS` règlent la relecture d'une mergeabilité en calcul (3 s, 20 fois par défaut).

Sortie : `0` pile cohérente (`plan`) ou entièrement fusionnée (`merge`), `1` anomalie, `2` appel incorrect ou `APV_ALLOW_MERGE` absent. En JSON : `plan` rend `target`, `ok`, `prs` (`number`, `pr`, `expectedBase`, `anomalies`, `freshness` : `base`, `head`, `state` `up_to_date|same_content|behind|unknown`, `missing`, `files`, `mergeBase`, `error`), `calls` ; `merge` rend aussi `method`, `merged`, `stopped` (`pr`, `reasons`), `freshness` (la base de chaque PR juste avant sa fusion) et `derogations`.

## `apv ledger`

```
apv ledger validate [--repo <chemin>] [--json]
apv ledger plan --file <mise-a-jour.json> [--repo <chemin>]
apv ledger apply --file <mise-a-jour.json> --hash <empreinte> --note <texte>
                 [--reviewer <nom>] [--commit] [--repo <chemin>]
```

- `validate` lit le registre de l'arbre de travail et liste toutes ses erreurs (schéma, identifiants en double, citation manquante d'une décision de l'opérateur, décision ambiguë sans question ni deux interprétations, `scope` vide ou motif non pris en charge (`DECISION_SCOPE`)...). Un projet sans registre a un registre vide (sortie `0`).
- `plan` calcule le registre obtenu par une mise à jour `{ "decisions": [ ... ] }` : les nouvelles entrées s'ajoutent, une entrée qui en remplace une autre la nomme dans `supersedes` et l'ancienne quitte le registre actif (elle reste dans l'historique Git). Le plan affiche une empreinte. Une entrée peut porter le champ facultatif `scope` (`{ "paths": ["src/routes/accueil/**"], "specs": ["accueil"] }`) : `apv spec validate` n'exige alors sa couverture que des specs qu'il concerne ; donner un périmètre à une décision existante, c'est la remplacer (`supersedes`) par la même décision avec `scope`. Un registre sans `scope` garde son empreinte.
- `apply` écrit exactement le plan relu : l'empreinte doit correspondre, sinon rien n'est écrit. Il met à jour le JSON et sa version lisible (`DECISIONS.md` à côté), et commite ces deux fichiers seulement avec `--commit`. Le relecteur est `--reviewer`, sinon le `user.name` de Git.

Le commit de `--commit` est fait sous l'identité Git du dépôt (`user.name` et `user.email`, du dépôt ou de la configuration globale), comme auteur et comme commiteur : l'outil n'invente jamais d'auteur. Sans identité configurée, `apply --commit` refuse avant d'écrire quoi que ce soit (sortie `1`, erreur `GIT_IDENTITY`, avec la commande à lancer : `git config user.name "Votre Nom" && git config user.email "vous@exemple.fr"`, `--global` pour tous les dépôts). Sans `--commit`, aucune identité n'est demandée. L'origine du commit reste lisible dans son message, par le trailer final `Generated-by: apv ledger apply` (`git log --format='%(trailers:key=Generated-by)'`). Tout commit créé par l'outil suit cette règle.

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
              [--concurrency N] [--keep-going] [--skip-proven] [--run <spec-id>]
              [--reason <texte>] [--repo <chemin>] [--json]
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

**Rythme d'une exécution** (`/apv:run`, [CONFIGURATION.md](CONFIGURATION.md#exécution--run)) : quand la commande exécuterait au moins un contrôle de stage `full` en entier (`--stage full` ou sans `--stage`), elle cherche l'exécution dont elle fait partie : `--run <spec-id>` (l'état doit exister dans un worktree du dépôt, sinon `RUN_MISSING`, sortie `1`), sinon la branche courante du dépôt, `apv/<id>` ou `apv/<id>-<suffixe>` (branches de tâche, d'intégration, de correction ; l'identifiant le plus long d'abord), quand un worktree du dépôt a `.apv/state/run-<id>.json`. L'état est cherché dans tous les worktrees (`git worktree list --porcelain`), pas seulement dans le checkout principal : chaque exécution tourne dans son propre checkout. Plusieurs copies : celle du worktree sur `apv/<id>` (le checkout de l'exécution), sinon celle du checkout principal, sinon refus `RUN_AMBIGUOUS` (sortie `1`) qui liste les emplacements. Elle calcule le niveau attendu comme `apv run next` (`suite.level`, avec `run.fullSuite` du checkout qui a l'état) ; le JSON donne ce checkout (`rhythm.checkout`) :
- niveau `task` (intégration intermédiaire ou passe de corrections avec `"final"`) : refus, sortie `1`, `Erreur [GATE_RHYTHM]`, avec l'étape, le niveau attendu, la commande à lancer à la place (`apv gates run --stage task --base <base ciblée>`, puis `apv gates verify --commit <tête> --stage task --base <base ciblée>` à `0`) ; rien n'est exécuté ni écrit ;
- `--reason "<texte>"` (1 à 500 caractères, jamais avec `--stage task`) : dérogation motivée, la suite tourne ; un événement `gates:full` (raison et commit) est journalisé dans l'état de l'exécution par l'API d'état, sous le verrou `run:<id>`, et la raison est écrite dans chaque reçu et dans `summary.json` (`override` : `run`, `reason`) ; ces reçus prouvent la suite complète comme les autres ;
- niveau `full` (dernière intégration, livraison, `"each-integration"`) ou aucun niveau à cette étape : rien ne change ;
- hors exécution (autre branche, tête détachée, aucun état ; un état trouvé par la branche mais illisible est signalé par une note) : rien ne change.
Un `--reason` sans effet est signalé par une note. `--stage task` et une sélection `--only` sans contrôle `full` ne sont jamais concernés.

`--only` choisit des contrôles et ajoute leurs dépendances. Par défaut, le premier échec arrête les contrôles suivants ; `--keep-going` les laisse tous s'exécuter. `--concurrency` borne le parallélisme (3 par défaut).

Chaque exécution écrit dans `.apv/receipts/<exécution>/` un reçu JSON par contrôle (statut, code de sortie, durée, empreintes des sorties, empreinte de preuve liée au commit, à la configuration, à l'environnement et à l'exécutable, diagnostic en cas d'échec) et un `summary.json`. Le dossier `.apv/receipts/` contient un `.gitignore` : les reçus sont des preuves locales, jamais commitées. Chaque reçu note le commit (`candidateSha`), le stage demandé (`stage`) et l'état de l'arbre (`dirty`), et `override` pour une suite complète lancée avec `--reason` ; le résumé reprend `stage`, `dirty`, `selected`, `added`, `reserved`, `targeted` et `override`. Le reçu d'un contrôle exécuté par sa commande ciblée porte `targeted: true`. Si l'arbre de travail avait des modifications non commitées (`dirty: true`), les reçus décrivent plus que le commit : `apv gates verify` ne les retient pas.

**Magasin partagé des reçus** : à la fin de chaque exécution, l'outil la copie aussi dans le magasin partagé du dépôt, `<répertoire git commun>/apv/receipts/<exécution>/` (le répertoire que donne `git rev-parse --git-common-dir`, `.git` du checkout principal : commun à tous les worktrees du dépôt, jamais versionné). La copie reprend les reçus et `summary.json` à l'identique, plus un `manifest.json` (`version`, `runId`, `candidateSha`, `worktree` où l'exécution a tourné, `copiedAt`, `files` : l'empreinte sha256 de chaque fichier). Elle passe par un dossier temporaire renommé à la fin : un lecteur ne voit jamais une copie partielle. Ainsi les reçus survivent au retrait du worktree (la copie détachée de livraison, retirée par `git worktree remove` une fois la PR ouverte), et `apv gates verify --commit <sha>` prouve le commit depuis n'importe quel checkout du dépôt. Une copie impossible (magasin non inscriptible, par exemple) est signalée par une ligne « Attention » et `sharedError` en JSON, jamais fatale : l'exécution et ses reçus locaux restent. Le dossier `.apv/receipts/` du worktree garde exactement sa forme (reçus et `summary.json`, sans manifeste). Après chaque copie, la rétention du magasin s'applique (section `receipts` de `.apv/config.json`, [CONFIGURATION.md](CONFIGURATION.md#reçus--receipts) : les 1000 exécutions les plus récentes de moins de 30 jours par défaut) ; les reçus des worktrees ne sont jamais touchés.

Différences avec V2 : pas d'espace de travail jetable (l'implémenteur exécute les contrôles dans le worktree qu'il possède), pas de cache de reçus (`cacheTtlMs` est ignoré), pas de commandes de préparation (`setup`).

En JSON : `ok`, `runId`, `candidateSha`, `baseSha`, `dirty`, `alreadyProven`, `stage`, `config`, `legacyConfig`, `ignoredSections`, `added`, `reserved`, `targeted`, `receiptsDirectory`, `sharedDirectory` (copie dans le magasin partagé, ou `null`), `sharedError` (raison d'une copie impossible, ou `null`), `pruned` (exécutions retirées du magasin par la rétention), `gates` (contrôles exécutés, chacun avec `targeted`), `rhythm` (`run`, `source` : `option` ou `branch`, `step`, `level`, `override`, ou `null` hors exécution), `notes`.

Sortie : `0` tous les contrôles exécutés passent, `1` au moins un échec, une configuration invalide ou une suite complète refusée par le rythme de l'exécution, `2` appel incorrect (dont un `--stage` inconnu, `--commit`, propre à `verify`, un `--run` invalide ou un `--reason` vide, trop long ou avec `--stage task`).

## `apv gates verify`

```
apv gates verify --commit <sha> [--stage full|task] [--base <ref>] [--config <fichier> | --commit-config] [--repo <chemin>] [--json]
```

Vérifie, sans rien exécuter, que les reçus prouvent que chaque contrôle exigé a réussi sur ce commit exact. Contrôles exigés : tous avec `--stage full` (défaut) ; avec `--stage task` (niveau tâche, celui des intégrations intermédiaires et des corrections sous `run.fullSuite` à `final`), ceux de stage `task` et les contrôles `full` qui déclarent `affected`, les autres contrôles `full` étant listés dans `reserved`, jamais prouvés. `--commit` accepte toute révision que Git résout en commit (SHA complet ou abrégé, `HEAD`) ; la comparaison se fait sur le SHA complet.

Pour chaque contrôle exigé, seuls comptent les reçus de ce commit, écrits sur un arbre propre (`dirty: false` ; pour un reçu plus ancien sans ce champ, celui du `summary.json` de son exécution, sinon inconnu donc refusé) et avec la configuration actuelle des contrôles (même `configHash`). Les reçus de toute exécution comptent (une exécution `--stage task` prouve ses contrôles autant qu'une suite complète), mais seul le plus récent de chaque contrôle est retenu : un échec plus récent l'emporte toujours sur une réussite plus ancienne. États : `passed` (réussi), `failed` (échec, avec le statut du reçu), `dirty` (reçus seulement sur un arbre modifié), `missing` (aucun reçu). Les fichiers illisibles et les reçus d'une autre configuration sont ignorés et signalés. Au niveau complet, les reçus ciblés (`targeted: true`, commande `affected` lancée par `--stage task`) ne comptent jamais, ni comme réussite ni comme échec : seule la suite complète prouve un contrôle `full` ; ils sont comptés dans `targeted` et signalés si le contrôle n'est pas prouvé.

**Où les reçus sont lus** : d'abord `.apv/receipts/` du worktree (comme avant), puis le magasin partagé du dépôt (section `apv gates run`) pour les exécutions que le worktree n'a pas : une exécution présente dans le worktree est lue là seulement. Les exigences ne changent pas selon l'emplacement : même commit exact, arbre propre, configuration actuelle, reçu le plus récent de chaque contrôle. Une exécution du magasin partagé ne compte que si elle est intacte : son `manifest.json` la nomme, liste exactement ses fichiers avec leur empreinte sha256, `summary.json` est présent, et chaque reçu appartient à l'exécution (même `runId`, même `candidateSha` que le manifeste, fichier au nom de son contrôle). Sinon aucun de ses reçus ne compte, et elle est signalée : « Exécutions du magasin partagé refusées (altérées) », `altered` en JSON (`runId`, `reason`). Les exécutions dont le manifeste nomme un autre commit ne sont pas lues (elles ne prouvent rien ici). Limite assumée : le manifeste détecte une altération des fichiers (édition, fichier ajouté ou retiré, copie tronquée), pas un faussaire qui réécrit aussi le manifeste ; il n'y a pas de clé secrète, et les reçus du worktree n'ont pas de manifeste. Le tableau marque « (magasin partagé) » un reçu retenu dans le magasin et donne son chemin. Le chef de projet principal vérifie donc la preuve de livraison depuis n'importe quel checkout du dépôt, la copie de livraison retirée.

`--commit-config` : la configuration des contrôles est lue au commit vérifié (`git show <commit>:.apv/config.json`, sinon `pipeline.v2.json` ; aucune : aucun contrôle, refus `NO_GATES`) plutôt que dans le checkout ; `config` vaut alors `<sha>:.apv/config.json` en JSON. Utile depuis un checkout dont la configuration diffère de celle du commit (le checkout principal sur `main` quand la PR change les contrôles) : sans elle, les reçus comptent comme « configuration des contrôles différente ». Avec `--config` : appel incorrect.

Au niveau tâche, un contrôle `full` qui déclare `affected` est prouvé par son reçu ciblé ou par un reçu complet, le plus récent des deux décidant. `--base <ref>` est alors obligatoire (sinon refus `GATE_BASE`, sortie `1`) : le dernier commit prouvé par la suite complète, que donne `apv run next`. Un reçu ciblé ne compte que si la base de son exécution (le `baseSha` du `summary.json` de son exécution) est `<ref>` ou l'un de ses ancêtres, c'est-à-dire s'il a couvert au moins tous les changements depuis `<ref>` ; les autres sont comptés dans `otherBase` et signalés. Un reçu complet compte quelle que soit la base. `--base` sans `--stage task` : appel incorrect. Une vérification du niveau tâche ne remplace jamais la suite complète avant une PR.

En JSON : `ok`, `commit`, `stage`, `base`, `config`, `configHash`, `required`, `targeted` (contrôles exigés par leur variante ciblée), `reserved`, `gates` (`gateId`, `state`, `status`, `receipt`, `runId`, `otherConfig`, `targeted`, `viaTargeted`, `proof` : `full`, `targeted` ou `null`, `otherBase`, `source` : `local`, `shared` ou `null`), `unreadable`, `store` (chemin du magasin partagé), `altered`, `missing` (contrôles non prouvés).

Sortie : `0` preuve complète, `1` preuve incomplète (ce qui manque est listé, avec la commande à relancer), commit introuvable, aucun contrôle exigé, `--base` manquant pour des contrôles ciblés ou configuration invalide, `2` appel incorrect (`--commit` absent, `--base` sans `--stage task`, `--commit-config` avec `--config`, option propre à `run`).

## `apv gates receipts`

```
apv gates receipts list [--commit <ref>] [--limit N] [--repo <chemin>] [--json]
apv gates receipts export <exécution> --out <dossier> [--repo <chemin>] [--json]
apv gates receipts prune [--keep-days N] [--keep-runs N] [--config <fichier>] [--repo <chemin>] [--json]
```

Les exécutions de `apv gates run` du worktree (`.apv/receipts/`) et du magasin partagé du dépôt (section `apv gates run`).

`list` : les plus récentes d'abord, 20 par défaut (`--limit N`), avec commit, stage, verdict, état de l'arbre et emplacement (`worktree`, `magasin partagé`, les deux, ou « altérée » avec la raison) ; `--commit <ref>` garde celles de ce commit. En JSON : `store`, `total`, `runs` (`runId`, `candidateSha`, `stage`, `ok`, `dirty`, `local`, `shared`, `intact`, `reason`).

`export <exécution> --out <dossier>` : copie l'exécution dans `<dossier>/<exécution>/` avec un `manifest.json` (empreinte sha256 de chaque fichier ; `sha256sum` suffit à les recontrôler), depuis le worktree s'il l'a, sinon depuis le magasin partagé, où elle doit être intacte (sinon refus `RECEIPT_EXPORT`, sortie `1`). Pour joindre la preuve d'une livraison à un dossier que l'opérateur garde. La destination ne doit pas exister.

`prune` : applique tout de suite la rétention au magasin partagé : garde les `keepRuns` exécutions les plus récentes de moins de `keepDays` jours (d'après l'heure de début inscrite dans leur identifiant), retire les autres et les copies interrompues de plus d'une heure ; les autres entrées du dossier et les reçus des worktrees ne sont jamais touchés. `--keep-days` (1 à 3650) et `--keep-runs` (1 à 100000) remplacent la section `receipts` de la configuration. `apv gates run` applique la même rétention après chaque copie.

Sortie : `0`, `1` exécution introuvable ou altérée, destination existante, commit introuvable, `2` appel incorrect (sous-commande inconnue, `--out` manquant, option d'une autre sous-commande).

## `apv lock`

```
apv lock run <ressource> [--ttl 900] [--wait 1800] -- <commande...>
apv lock acquire|release|status <ressource>
```

Verrous à bail sur les ressources partagées (base de test, ports, navigateur) : propriétaire vérifié, expiration, renouvellement pendant `run`, file d'attente visible (spécification, section 10). `run` est la forme à préférer : une commande par bail, libéré à la sortie quoi qu'il arrive. Détails, options et codes de sortie : [LOCKS.md](LOCKS.md).

## `apv wait`

```
apv wait --pid <pid> [--timeout <secondes>] [--json]
apv wait --file <chemin> [--contains <texte>] [--timeout <secondes>] [--json]
```

Attente bornée, pour une session qui n'a pas le droit d'attendre par le shell : en session non interactive, `sleep`, `tail --pid` et les boucles sur `kill -0` sont refusés par les permissions (projet pilote, 24 septembre 2026 : la session a bricolé des scripts node pour attendre la suite complète). Une seule condition par appel :
- `--pid` : la fin du processus. Un processus absent, ou zombie (il n'attend plus que son parent), compte comme terminé ; un processus d'un autre utilisateur (`EPERM`) comme vivant. Le code de sortie du processus n'est pas connu de l'outil : on lit son journal ou ses reçus. `0`, `1` et le pid de `apv wait` lui-même sont refusés (`2`).
- `--file` : l'existence du fichier ; avec `--contains <texte>` (non vide), la présence du texte dans le fichier. Chaque relevé ne relit que les octets ajoutés depuis le précédent (plus la longueur du texte, pour un texte à cheval sur deux lectures) ; un fichier raccourci est relu depuis le début ; seul un fichier ordinaire est ouvert (une FIFO ne bloque pas l'attente). Chemin relatif au dossier courant.

`--timeout` : de 1 à 580 secondes (défaut 580), sous la limite de dix minutes d'un appel Bash de Claude Code ; au-delà, refus en `2`, et on relance simplement `apv wait`. Relevé toutes les secondes (`APV_WAIT_POLL_MS` pour les tests). Sortie texte : « Terminé : … » ou « Délai dépassé : … Relancer apv wait pour attendre encore. » ; JSON : `condition`, `pid` ou `file` et `contains`, `met`, `immediate` (condition remplie au premier relevé), `waitedSeconds`, `timeoutSeconds`.

Sortie : `0` condition remplie, `1` délai dépassé, `2` appel incorrect (aucune condition ou les deux, `--contains` sans `--file`, délai hors bornes).

## `apv procs`

```
apv procs list [--repo <copie>] [--port <p>]... [--json]
apv procs stop [--repo <copie>] [--port <p>]... [--grace <secondes>] [--json]
```

Serveurs de test orphelins. Une suite navigateur qui dépasse le délai d'un appel Bash (600 s) est coupée, mais les serveurs qu'elle a lancés (`vite preview`, serveur web de Playwright) restent à l'écoute sur les ports de la pile de test ; une session non interactive n'a pas le droit de `kill` et attendait (projet pilote, 25 et 26 septembre 2026). `apv procs` les trouve et les arrête, sans jamais toucher un processus étranger au dépôt.

Les processus sont lus dans `/proc` (Linux) : répertoire courant (`/proc/<pid>/cwd`), ports TCP en écoute (IPv4 et IPv6), parent, heure de démarrage. Sur un système sans `/proc` (macOS, Windows), refus clair (`PROCS_UNSUPPORTED`, sortie `1`). Un processus **appartient au dépôt** quand son répertoire courant est dans un de ses worktrees (`git worktree list` : copie principale, copies liées, copies détachées d'un dossier de session).

Cibles :
- `--port <p>` (répétable, ou `--port 4173,4174`) : les processus qui écoutent sur ces ports ; `--repo` ne sert alors qu'à trouver le dépôt (défaut : dossier courant) ;
- sans `--port`, `--repo <copie>` : tous les processus lancés dans cette copie, qu'ils écoutent ou non ; la copie doit être un worktree lié du dépôt, jamais la copie principale, qui porte la session et ses outils (refus `2`) ;
- sans l'un ni l'autre : les processus qui écoutent sur les **ports de test déclarés**, section `resources` de `.apv/config.json` ([CONFIGURATION.md](CONFIGURATION.md#ressources-de-test--resources)) ; `stop` sans port déclaré est refusé (`2`) ; `list` montre alors aussi tous les processus des worktrees.

`list` affiche pour chaque cible son pid, ses ports, son worktree (ou son répertoire hors du dépôt), sa commande et s'il serait arrêté ; les ports visés libres sont nommés. `stop` n'arrête que les cibles du dépôt : `SIGTERM` à toutes, puis `SIGKILL` à celles qui tournent encore après `--grace` secondes (défaut 5, de 0 à 60), puis vérification. Jamais arrêtés, et signalés : un processus hors du dépôt (autre projet, autre utilisateur, aperçu de `apv preview` qui tourne dans sa propre copie), un processus dont le répertoire est illisible, `apv` lui-même et ses parents (la session, son shell). Un pid réutilisé entre le relevé et le signal n'est pas visé (heure de démarrage comparée).

Sortie : `0` toutes les cibles arrêtées, ou aucune ; `1` une cible refusée (hors du dépôt, protégée, signal refusé) ou encore vivante après `SIGKILL`, ou système sans `/proc` ; `2` appel incorrect. JSON : `action`, `mode` (`ports`, `copy`, `all`), `repository`, `worktrees`, `copy`, `ports`, `declaredPorts`, `freePorts`, `processes` (`pid`, `ppid`, `ports`, `cwd`, `worktree`, `command`, `stoppable`, `refusal` : `outside`, `protected` ou `unknown-cwd`, et pour `stop` `outcome` : `terminated`, `killed`, `survived`, `gone` ou `denied`), `ok`.

## `apv review plan`

```
apv review plan --base <ref> [--head <ref>] [--force <domaine>]... [--repo <dépôt>] [--json]
```

Propose les domaines de revue de `/apv:review` d'après la nature du diff, pour tous les projets ; le chef de projet la lance avant les revues et ne lance que les domaines retenus. Projet pilote, 25 septembre 2026 : une spec de pur rangement (77 renommages, imports, aucun changement de comportement, aucune migration, aucun écran) est passée par les quatre revues, 40 à 70 minutes, dont trois n'avaient rien à relire. Lecture seule : aucun fichier écrit.

- Diff lu : `git diff -M` depuis la base commune de `--base` (la base de la PR ou de l'exécution) et `--head` (défaut `HEAD`), noms (`--name-status`) et lignes changées. `--repo` : le dépôt (défaut : le dossier courant), où la configuration est lue.
- Chaque fichier a une nature : **renommage pur** (similarité 100 %), **chemins seuls réécrits** (les lignes changées ne font que renommer des références à des fichiers déplacés dans le même diff : imports, `vi.mock`, chemins cités en commentaire ; un spécificateur relatif est résolu depuis le fichier qui le porte ; imports réordonnés ou remis en forme par un formateur), ou **contenu changé** (fichier ajouté, supprimé, binaire, toute autre ligne). Une chaîne modifiée, un nom importé en plus, un autre module de même nom, deux instructions permutées restent des changements de contenu.
- Et des classes, d'après ses chemins (ancien et nouveau) : `ui` (composants, styles, gabarits), `data` (requêtes, dépôts, modèles), `migrations` (migrations et schémas, plus `db.migrations`), `personal` (export, cookies, consentement, traceurs, `.apv/rgpd/`), `legal` (mentions, confidentialité, CGU), `neutral` (tests, documentation, outillage : compte seulement si aucune autre classe ne s'applique), les maquettes validées (`design.dir`) ; aucune : **non classé**. Motifs : `review.paths` ([CONFIGURATION.md](CONFIGURATION.md#revues--review)).
- Règles :
  - `securite` : **toujours**, sans exception ; aucune clé de configuration ni option ne la saute. Les fichiers sensibles de la voie `high` (`sensitivePaths` et `risk.highPaths`) touchés sont cités.
  - `fidelite` : un fichier `ui` au contenu changé, ou une maquette validée touchée (renommée comprise).
  - `donnees` : une migration touchée (renommage compris : l'outil de migration suit les noms), ou un fichier `data` au contenu changé, ou un terme de données (`review.terms.data`, par exemple `.from('`, `insert into`) dans les lignes changées d'un fichier `ui` ou `data`.
  - `rgpd` : une migration touchée, un fichier `personal` ou `legal` au contenu changé, ou un terme RGPD (`review.terms.personal`, par exemple `cookie`, `localStorage`, `email`, `analytics`) dans les lignes changées d'un fichier `ui` ou `data`.
  - **Prudence** : un fichier non classé au contenu changé garde `fidelite`, `donnees` et `rgpd`. Un domaine n'est sauté que sur preuve positive qu'il n'a rien à relire ; une fausse alerte garde une revue, jamais l'inverse.
  - Forcés : `review.always` (configuration) et `--force <domaine>` (opérateur, répétable ou liste séparée par des virgules) gardent un domaine quoi que dise le diff ; `--force` inconnu : `2`.
- Sortie texte : domaines retenus (raison, fichiers qui décident, 50 au plus) et sautés (raison), puis la commande à noter. JSON : `tool`, `base` et `head` (`ref`, `sha`), `mergeBase`, `counts` (`files`, `renames`, `paths`, `content`, `neutral`, `unclassified`), `domains[]` (`domain`, `decision` `retained` ou `skipped`, `reason`, `files`, `fileCount`, `forced` `config`, `operator` ou `null`), `retained`, `skipped[]` (`domain`, `reason`), `files[]` (`path`, `from`, `status`, `change` `none`, `paths` ou `content`, `classes`, `keeps[]` avec `domain` et `why`).
- Un domaine sauté se note dans l'état : `apv run set <id> review:<domaine> skipped --note "<raison>"` (la raison de la sortie ; `--note` exigé pour sauter une revue, et `review:securite` n'est jamais accepté sauté), et va au workflow `apv:revues` (`skipped`) et au fichier de consolidation.

Sortie : `0` plan établi, `1` référence introuvable (`REVIEW_REF`), Git en échec (`REVIEW_GIT`) ou configuration invalide, `2` appel incorrect (`--base` manquant, domaine inconnu).

## `apv dast run`

```
apv dast run [--repo <copie>] [--out <dossier>] [--commit <ref>] [--wait <durée>] [--json]
```

Scan dynamique de sécurité (ZAP ou l'outil du projet) déclaré dans `review.dast` de `.apv/config.json` ([CONFIGURATION.md](CONFIGURATION.md#revues--review)), lancé par le chef de projet avant les revues : les agents de revue n'ont pas le droit de lancer Docker, et sur le projet pilote le scan prévu n'a jamais tourné (quatre livraisons de suite, septembre 2026). La revue sécurité lit ensuite ses rapports.
- `--repo` : la copie détachée du commit revu (défaut : le dossier courant) ; la configuration y est lue. `--commit` vérifie qu'elle est bien sur ce commit (sha, abrégé ou branche ; sinon `1`, `DAST_COMMIT`).
- `--out` : le dossier des rapports, hors de la copie (refus en `1`, `DAST_OUT`, s'il est dedans : la copie est retirée après les revues) et neuf (refus s'il contient déjà un `summary.json`). Défaut : `<dossier temporaire>/apv-dast/<nom de la copie>-<sha court>-<horodatage>`, jamais à côté du dépôt. Sous `/apv:run`, le dossier de session du chef de projet.
- La commande (`review.dast.command`, argv sans shell) tourne dans la copie, sous le verrou `review.dast.resource` (défaut `dast`, attente `--wait`, défaut 30 min, comme `apv lock run`), bornée par `review.dast.timeoutMs` (défaut 1 h ; puis SIGTERM, SIGKILL 10 s plus tard). Jokers, arguments entiers seulement : `{{reportDir}}`, `{{commit}}`, `{{repo}}`. Variables : celles de `DEFAULT_PASS_ENV` et de `review.dast.passEnv` seulement, plus `APV_DAST_REPORT_DIR`, `APV_DAST_COMMIT`, `APV_DAST_REPO` et `APV_LOCK_HELD`. La commande prépare ce qu'il lui faut (dépendances, build, serveur), écrit ses rapports dans le dossier et arrête ce qu'elle a lancé.
- Sortie de la commande dans `<dossier>/dast.log` ; en dernier, écrit de façon atomique, `<dossier>/summary.json` : `tool`, `version`, `commit`, `repo`, `clean` (aucun fichier suivi modifié), `resource`, `command` (jokers remplacés), `description`, `startedAt`, `finishedAt`, `durationMs`, `status` (`passed`, `failed`, `timed_out`, `lock_timeout`), `exitCode`, `timeoutMs`, `log`, `files` (fichiers du dossier, 200 au plus). Un scan lancé en arrière-plan s'attend par `apv wait --file <dossier>/summary.json`.

Sortie : `0` scan terminé à `0`, `1` scan en échec, arrêté au délai, verrou non obtenu, rien de déclaré (`DAST_NONE`) ou refus, `2` appel incorrect.

## `apv db check`

```
apv db check [--json] [--live] [--config <fichier>] [--root <dossier>]
```

Contrôle du modèle de données (spécification, section 13 bis) : nommage anglais, index des clés étrangères, RLS, politiques, fonctions `security definer`, `select *` dans le code, redondances, clés d'idempotence. `--live` lit aussi la base, en lecture seule, par `APV_PSQL` (commande psql complète, par exemple `docker exec -i <conteneur> psql -U postgres -d postgres`) ou par `APV_DB_URL` et `psql`. Règles, configuration et limites : [DB-CHECK.md](DB-CHECK.md).

## `apv design`

```
apv design register <fichier.html> --name <nom> --quote "<mots de l'opérateur>"
                    [--title "<titre>"] [--screens a,b] [--artifact <url>] [--scope <motif,motif>]
                    [--repo <chemin>] [--json]
apv design list [--screen <écran>] [--repo <chemin>] [--json]
apv design check [--repo <chemin>] [--json]
```

Maquettes validées par l'opérateur, référence absolue des implementers et de la revue de fidélité. Méthode complète : [DESIGN.md](DESIGN.md).

- `register` verse une maquette que l'opérateur vient de valider :
  1. copie le fichier vers `docs/design/<nom>-validee.html` (dossier : `design.dir` de `.apv/config.json`) ;
  2. calcule son sha256 ;
  3. inscrit au registre, par l'API de mise à jour du registre (comme `apv ledger apply`), la décision `maquette-<nom>-validee` : `confirmed`, source `operator`, `sourceQuote` = la citation, `enforcement` `product`, valeur avec le chemin et l'empreinte (et les écrans, l'adresse de l'artefact) ;
  4. ajoute à `.gitattributes` (créé ou complété) la ligne `<dossier>/*.html -whitespace` quand Git ne l'applique pas déjà (`git check-attr whitespace`) : une maquette est figée par son empreinte, ses espaces de fin de ligne ne peuvent pas être nettoyés, et sans cette ligne `git diff --check` (contrôle `diff-check`, CI des projets) échoue (projet pilote, 25 septembre 2026 : ligne ajoutée à la main) ;
  5. affiche les fichiers à commiter (maquette, registre JSON et Markdown, `.gitattributes` s'il a changé). Rien n'est commité.

  `--scope <motif,motif>` donne un périmètre à la décision (`scope.paths`, syntaxe des chemins autorisés) : seules les specs dont les tâches peuvent toucher ces chemins doivent la couvrir ([`apv spec validate`](#apv-spec-validate)). Sans `--scope`, le périmètre de l'enregistrement actif est gardé ; un nouveau périmètre sur le même fichier fait un nouvel enregistrement.

  La citation est obligatoire : sans les mots de l'opérateur, rien n'est versé (le pipeline n'invente jamais une approbation). Une validation avec réserve (« je valide sauf … ») est refusée. Le registre doit être commité avant (`LEDGER_DIRTY` sinon) ; en cas d'échec, le fichier copié est retiré. Le nom : minuscules, chiffres et tirets, 50 caractères au plus, sans le mot `validee`. Verser de nouveau une maquette déjà versée ajoute `maquette-<nom>-validee-v2` (puis `-v3`…), qui remplace l'ancienne décision (`supersedes`) ; un contenu identique à la version enregistrée ne change rien.
- `list` affiche les maquettes validées du registre de l'arbre de travail : nom, décision, fichier, empreinte, écrans et état du fichier : `ok`, `MODIFIÉE` (empreinte différente), `ABSENTE`, ou `sans empreinte` pour une décision écrite avant l'outil (projet pilote). `--screen` filtre sur un écran (nom ou écran déclaré, sans tenir compte de la casse ni des accents).
- `check` sort en `1` si un fichier de maquette validée a changé ou disparu sans nouvel enregistrement ; les décisions sans empreinte sont listées comme non vérifiables. Il signale aussi l'absence de la ligne de `.gitattributes` (projet avec des maquettes validées ou un dossier de maquettes) : « Attention » si aucune maquette ne porte d'espace de fin de ligne, « Erreur » et sortie `1` sinon, puisque `git diff --check` échoue alors. À déclarer comme contrôle (`gates`) dans les projets qui ont des maquettes.

Configuration (facultative) :

```json
{ "design": { "dir": "docs/design" } }
```

Sortie : `0` succès (maquettes intactes pour `check`), `1` refus ou dérive, `2` appel incorrect (citation ou nom manquant). En JSON, `register` rend `decisionId`, `supersedes`, `target`, `sha256`, `ledgerFile`, `toCommit`, `unchanged`, `attributes` (`file`, `line`, `status` : `present`, `added` ou `ineffective` quand un autre fichier d'attributs la contredit) ; `list` rend `mockups` ; `check` rend `ok`, `checked`, `broken`, `legacy`, `attributes` (`status` : `present`, `missing` ou `not-applicable` ; `whitespace`, maquettes aux espaces de fin de ligne ; `blocking`).

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

Le niveau se calcule sur la plus haute des deux fenêtres, la fenêtre la plus contraignante (`binding` : `session` ou `week`, la semaine en cas d'égalité), nommée dans la sortie (spécification, section 9) :

| Pourcentage | Niveau | Consigne |
|---|---|---|
| moins de 70 % | `ok` | continuer |
| 70 % | `slow_down` | ralentir, doser les vagues |
| 85 % | `finish_only` | finir les tâches en cours sans en lancer de nouvelles |
| 95 % | `save_now` | sauvegarder (commits « wip », push, notes de reprise) et prévenir l'opérateur |
| illisible | `unknown` | le relevé a échoué ; la sortie de la commande est affichée |

La sortie dit aussi combien d'exécutions `/apv:run` peuvent tourner en même temps : au niveau `ok`, autant que de piles de test libres ; à `slow_down`, une de plus au maximum ; au-delà, aucune nouvelle, celles en cours se terminent.

Chaque relevé est ajouté à `.apv/state/quota.log` (un objet JSON par ligne : `at`, `session`, `week`, `percent`, `level`, `binding`), sauf avec `--no-log` ; le hook de démarrage de session lit la dernière ligne. `apv quota` crée ou complète aussi `.apv/.gitignore` (`state/*.log`, `state/task.json`, `state/preview.json`, `receipts/`) pour que ces fichiers machine ne soient jamais commités. La variable d'environnement `APV_CLAUDE_BIN` remplace l'exécutable `claude` (tests, installation particulière).

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
