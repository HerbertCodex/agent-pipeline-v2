# Configuration et politique

> **Écrit pour V2.** APV3 lit encore un `pipeline.v2.json` (ou `.apv/config.json`), mais seulement ses sections `name`, `gates`, `risk`, `validationRules`, `environment.passEnv`, `skills`, `preview`, `design`, `structure`, `run`, `spec`, `review`, `receipts`, `resources`, `suite`, `stacks`, `batch`, `stack`, `web`, `reuse`, `map`, `freshness` et `models` ([outil apv](CLI.md) ; les sections `structure`, `run` et `spec` sont décrites [plus bas](#arborescence--structure)). Les réglages d'agents, de budgets, de délais, de modèles et de parcours décrits ici ne concernent que le contrôleur V2 ([archive](v2/)).

La configuration est un JSON déclaratif lu avant l'agent et conservé avec la tentative. La tâche ne peut pas fournir une commande à la place d'un contrôle, changer un verdict ni s'accorder une exemption. Les champs inconnus sont refusés.

Les schémas JSON exportés par V2 sont archivés dans [v2/schemas/](v2/schemas/) ; la commande `apv2 schemas` qui les produisait n'existe plus en V3, où les contrats font foi dans `src/`.

## Exemple minimal pour un projet déjà préparé

```json
{
  "schemaVersion": 1,
  "executionMode": "local-trusted",
  "environment": { "id": "application-dev-image-v3" },
  "agent": {
    "type": "codex",
    "passEnv": ["HOME", "CODEX_HOME", "CODEX_API_KEY"]
  },
  "workflow": { "planningMode": "adaptive", "qualityReview": "evidence" },
  "gates": [
    {
      "id": "unit",
      "covers": ["unit"],
      "command": ["npm", "test"],
      "timeoutMs": 120000,
      "mandatory": true,
      "cacheTtlMs": 0
    }
  ],
  "concurrency": 3
}
```

Cet exemple suppose que `npm test` exécute les tests unitaires du projet. Compléter les gates de build, intégration, navigateur et les mappings `testPaths` selon les changements à réaliser ; une seule gate unitaire ne couvre pas tous les parcours. Voir [les preuves requises](QUALITY.md#exigences-adaptées-au-changement).

### Modes d’usage

`agent.usageMode` et les rôles acceptent `legacy` (défaut compatible), `subscription` et `metered`. En mode `subscription`, les appels ignorent les plafonds monétaires mais conservent délais, tours et contrôles. Un modèle explicite est requis en abonnement et facturé. La connexion au CLI reste inchangée. [Configuration mixte, migration et diagnostics](v2/EXECUTION-POLICY.md).

### Limites de temps, de tours et de coût

Les limites fournisseur peuvent arrêter un appel avant sa réponse finale. Une implémentation interrompue conserve ses fichiers pour inspection et adoption explicite ; Product/Design conservent les sorties déjà reçues dans des checkpoints. Aucun mécanisme ne récupère une réponse finale jamais reçue.

| Réglage | Défaut du schéma | Portée |
| --- | --- | --- |
| `agent.timeoutMs` | 1 800 000 ms (30 min) | Appel Implementer ; pour un rôle de lecture, échéance partagée avec ses réparations de sortie. |
| `agent.maxTurns` | 200 | Nombre de tours d'un appel Claude. |
| `agent.maxBudgetUsd` | `null` | Plafond explicite par appel Claude, s'il est renseigné. |
| `workflow.maxSpecCostUsd` | 25 $ | Coûts déclarés hors abonnement, planification, réparations et QA comprises. |
| `workflow.maxActiveMs` | 3 600 000 ms (1 h) | Temps cumulé de planification et d'exécution de la spec, hors attente humaine. |
| `maxRunMs` | 2 700 000 ms (45 min) | Budget actif d'une tentative, reprises comprises. |
| `validationReserveMs` | 60 000 ms | Temps réservé aux contrôles lors du calcul du timeout Implementer. |
| `maxRepairAttempts` | 3 | Réparations de code après contrôles rouges, entre 0 et 5. |
| `workflow.maxQaRepairs` | 2 | Réparations demandées par QA, entre 0 et 3. |
| `workflow.maxOutputRepairs` | 1 | Réparations du contrat de sortie d'un rôle, entre 0 et 2. |

`workflow.maxSpecCostUsd` est vérifié avant les appels hors abonnement. Pour Claude, le montant restant réduit aussi `maxBudgetUsd` : **le plafond global peut donc interrompre l'appel en cours**. Les coûts proviennent des déclarations du fournisseur, pas d'une facture ; un coût inconnu n'est pas zéro et le dernier tour peut dépasser le plafond. Un adaptateur sans coût monétaire publié ne fournit pas de garantie de dépense en dollars.

Le même amendement couvre aussi les contrôles, dans un bloc `gates` : `add` ajoute un contrôle, `resources` déclare une ressource partagée qui sérialise des contrôles écrivant au même endroit, `timeoutMs` relève un délai. Ce qui définit ce qu'un contrôle prouve — commande, `covers`, `testPaths`, `lanes`, `mandatory` — et la suppression d'un contrôle restent hors amendement : ils exigent une nouvelle spec, car ils affaibliraient une approbation déjà donnée.

Pour relever une allocation, utiliser un amendement chiffré avec `spec budget`, puis reprendre l'étape arrêtée. `maxOutputRepairs` s'amende de la même façon lorsqu'un rôle échoue à rendre une sortie conforme plutôt qu'à faire son travail. L'ancien `spec run --accept-cost` contourne le plafond global pour cette exécution ; il ne relève pas le plafond explicite par appel. Voir [les reprises et budgets](v2/LIFECYCLE.md#échec-interruption-et-budget). `inspect --repo PATH` signale également des réglages susceptibles de couper le travail dans `configAdvice`.

Les réparations de code cessent avant leur plafond si elles ne modifient rien (`REPAIR_NO_CHANGE`) ou laissent exactement les mêmes contrôles échouer (`REPAIR_NO_PROGRESS`). Augmenter la limite ne justifie pas une boucle sans progrès.

Le worktree est neuf : un projet dont les tests nécessitent des dépendances doit déclarer un `setup` adapté. L'exemple minimal n'en installe pas implicitement. Ne pas remplacer un vrai contrôle par `true` pour obtenir un résultat vert.

## Commandes et environnement

Une commande est un tableau d'arguments. Il n'y a ni `shell:true`, ni concaténation de texte provenant d'une tâche dans une commande. Déclarer explicitement `bash -lc` reste possible pour un profil de confiance, mais réintroduit alors volontairement un shell sous la responsabilité de l'opérateur.

Les seules substitutions sont des arguments entiers : `{{baseSha}}`, `{{candidateSha}}`, `{{workspace}}`. Une substitution inconnue ou partielle est refusée. Le framework ne calcule pas les commandes depuis les sorties du modèle.

Les variables globales autorisées par défaut sont `PATH`, `SystemRoot`, `WINDIR`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, lorsqu'elles existent. `agent.passEnv`, `gate.passEnv` et `setup.passEnv` ajoutent des noms uniquement pour leur étape. Leurs valeurs ne figurent pas dans la configuration persistée. L'empreinte de validation tient compte des valeurs autorisées ; elle ne doit pas être confondue avec une protection de secrets contre un processus du même utilisateur.

## Graphe de contrôles

`dependsOn` impose l'achèvement réussi des parents. `resources` contient les noms de ressources exclusives, par exemple `test-db` ou `dist`. Deux contrôles partageant une ressource ne tournent pas simultanément. Les dépendances inconnues, doublons et cycles sont refusés avant l'agent.

Par défaut, un contrôle a un accès exclusif au répertoire de validation, y compris ses fichiers générés ou ignorés par Git. Cela protège aussi les configurations existantes sans ressources déclarées : `build`, synchronisation du framework et E2E ne peuvent plus écraser simultanément le même `.svelte-kit`, `dist` ou cache.

`stage` (facultatif) : `task` (valeur par défaut) pour un contrôle rapide, lancé après chaque tâche par `apv gates run --stage task` ; `full` pour un contrôle long (la suite navigateur complète, par exemple), réservé à la suite complète que le chef de projet passe à la dernière intégration de la spec et à la livraison, ou à chaque intégration selon `run.fullSuite` (section [Exécution](#exécution--run)) (`apv gates run --stage full`, puis `apv gates verify --commit <sha>`). Un contrôle `task` ne peut pas dépendre d'un contrôle `full`. Sans ce champ, tout tourne partout, comme avant ([RUN.md](RUN.md#contrôles--par-tâche-et-suite-complète)).

`affected` (facultatif, contrôle de stage `full` seulement) : commande ciblée, tableau d'arguments avec les mêmes substitutions que `command`, qui lance seulement les tests concernés par les changements depuis la base. `apv gates run --stage task` l'exécute à la place du contrôle complet et la signale « ciblé » (sortie, reçus, `summary.json`) ; la suite complète (`--stage full`) et `apv gates verify` au niveau complet n'en tiennent aucun compte et restent obligatoires à la dernière intégration et à la livraison. `apv gates verify --stage task --base <ref>` l'exige en revanche au niveau tâche : son reçu ciblé compte quand la base de son exécution est `<ref>` ou l'un de ses ancêtres (il a couvert au moins les changements depuis `<ref>`). Ses dépendances doivent être des contrôles `task` ou d'autres contrôles ciblés (sinon configuration refusée). Un contrôle `full` sans `affected` reste « réservé à la suite complète » à l'étape de tâche. Exemple pour Playwright (`--only-changed` compare au commit de base les fichiers de tests et leurs imports ; `--pass-with-no-tests` fait réussir une tâche qui ne touche aucun test) :

```json
{
  "id": "e2e",
  "stage": "full",
  "command": ["apv", "lock", "run", "e2e", "--", "npx", "playwright", "test"],
  "affected": ["apv", "lock", "run", "e2e", "--", "npx", "playwright", "test", "--only-changed={{baseSha}}", "--pass-with-no-tests"],
  "timeoutMs": 900000
}
```

`apv lock run e2e` sérialise le navigateur de test entre agents (voir [LOCKS.md](LOCKS.md)) ; le verrou ne dure que le temps des tests ciblés. `--base <ref>` est obligatoire à l'étape de tâche (`apv gates run --stage task --base <base>`). Limite : `--only-changed` suit les imports des fichiers de tests, pas le navigateur ; une modification de l'application seule ne sélectionne pas les tests e2e qui la parcourent. L'implementer ajoute ou modifie donc le test du comportement qu'il change, et la suite complète reste le filet à la dernière intégration et à la livraison. Pour une interface, faites tourner les tests navigateur en mouvement réduit par défaut (Playwright : `use: { reducedMotion: 'reduce' }` dans la configuration, et des animations CSS qui respectent `prefers-reduced-motion`) : un clic pendant une animation est la première cause d'instabilité ; seuls les tests qui vérifient une animation remettent `reducedMotion: 'no-preference'`.

`reuse` (facultatif, 3.0.0-alpha.26 ; [ACCELERATION-LOTS.md](ACCELERATION-LOTS.md), partie A) : sans ce champ, `apv gates run` et `apv stack batch` reprennent le reçu vert d'un commit au **même arbre** (même configuration des contrôles, même environnement, moins de 20 h, aucun échec plus récent) au lieu de relancer le contrôle, avec un reçu `cached` que `apv gates verify` recontrôle depuis Git et le magasin ([CLI.md](CLI.md#apv-gates-run)). Valeurs : `false` (jamais repris), ou un objet (3.0.0-alpha.27, PR A2) `{ "ignore": [...], "maxAgeMs": ... }` (la reprise par entrées que décrit `ignore` est désactivée, ci-dessous) ; `true` et `{}` sont refusés par le chargeur (laisser le champ absent). Le champ change l'empreinte de configuration comme tout champ d'un contrôle, et une PR qui l'ajoute ou l'élargit est prouvée seule, avec la configuration de sa base.

```json
{ "id": "integration", "stage": "full", "command": ["npm", "run", "test:integration"], "testPaths": ["tests/integration/**"],
  "reuse": { "ignore": ["tests/e2e/browser/**", "tests/e2e/**/*-snapshots/**", "docs/**", ".apv/state/**", "**/*.md"],
             "maxAgeMs": 172800000 } }
```

- **`ignore`** (1 à 100 motifs portables `*`, `**`, `?`, sans accolades ni `!`, 200 caractères et 16 jokers au plus chacun) : les fichiers que le contrôle **ne lit jamais**, par **exclusion** (tout autre fichier, un fichier nouveau compris, serait une entrée). **La reprise par entrées que ce champ décrit est désactivée** (décision du chef du 18 octobre, soir, bis ; relecture sécurité du delta de A2, M1) : `apv gates run` et `apv stack batch` n'écrivent jamais de reçu `basis: "inputs"`, et `apv gates verify` en refuse un quoi qu'il dise (« reprise par entrées désactivée tant que la déclaration reuse.ignore n'est pas prouvée »). Seule la reprise à arbre identique vaut ; un contrôle qui déclare `ignore` le rappelle à chaque exécution où il n'est pas repris (« non repris (… ; reprise par entrées désactivée …) »). **Raison** : rien ne prouve la déclaration. Fausse dès la base (une PR fusionnée fait lire `docs/data.json` au contrôle, `ignore: ["docs/**"]` inchangé), elle donnerait une fausse preuve à la PR suivante qui ne change que ce fichier : contrôle repris, `verify` à 0, alors qu'il échoue. Elle reviendra avec une preuve (PR A2b : le contrôle rejoué dans une copie sans ses fichiers ignorés, reçu exigé). Le champ reste lu et validé, pour ne rien changer aux configurations à ce moment-là : les motifs sont lus à la **base commune** du commit et de sa cible, et le chargeur refuse un motif qui couvre un fichier **jamais ignorable**, casse ignorée : la configuration des contrôles (`.apv/config.json`, `pipeline.v2.json`, le fichier `--config`), les manifestes et verrous de dépendances, la configuration de build, de test et d'exécution (`*.config.*`, `tsconfig*.json`, `Dockerfile`…), la CI, les migrations (`**/migrations/**`, `*.sql`), `scripts/**`, `*.sh`, `.env*`, et les propres `testPaths` et `repeatChanged.paths` du contrôle (liste `ALWAYS_REQUIRED` de `src/gates/proof-scope.ts` sans les dossiers de tests : un contrôle peut ignorer les tests d'un autre).
- **`maxAgeMs`** (de 6 h à 7 jours ; 24 h par défaut) : âge maximal d'une origine reprise, lu à la base lui aussi : l'âge retenu est le plus petit de celui de la base et de celui du commit, et ne dépasse 24 h que si les deux le déclarent. `apv gates run` ne reprend qu'une origine plus jeune que cet âge moins 4 h (la reprise doit rester vérifiable jusqu'à la fusion).

- **Ce qui entre dans l'identité de reprise** (tout doit être égal entre l'origine et la reprise) : l'arbre du commit (`git rev-parse <commit>^{tree}`) et l'empreinte de ses fichiers suivis, recalculés depuis Git ; l'empreinte de la configuration des contrôles ; l'environnement (variables transmises et leurs valeurs, exécutable et son sha256, Node, plateforme, noyau, version de l'outil) ; **la pile** avec `--stacks` (3.0.0-alpha.27) : sans `stacks[].fingerprint`, son identifiant, sa déclaration (sans son `envFile`) et les valeurs de ses variables, donc jamais d'une pile à l'autre ; avec une empreinte, seules les **adresses propres à la pile** parmi ses variables sont normalisées : un port qu'elle **déclare dans `ports`** (la valeur entière, le port d'une URL ou d'un `hôte:port`) et son fichier de verrou ; toute autre valeur reste dans l'identité (`STACK=2` contre `STACK=3`, un drapeau, un nom de projet, l'hôte ou la base d'une URL, `HOST_PORT=postgres:15` contre `postgres:16`, un port que la pile ne déclare pas, quel que soit le nom de la variable : relecture sécurité de A2 et de son delta, F3). Une pile qui ne déclare pas `ports` ne normalise donc aucun port. Depuis 4.0.0-alpha.6 (`normalizeEnv` retiré), la variable qui désigne la pile (`E2E_STACK`) et ses URL gardent leur valeur : aucune reprise d'une pile à l'autre, la reprise ne sert qu'à relancer une mise en ligne au même arbre sur la même pile ; **l'état local que Git ignore** dans la copie où le contrôle tourne (relecture sécurité de A1 et de son delta) : présence de `node_modules`, contenu de l'enregistrement de son installation (`node_modules/.package-lock.json` d'npm, `.modules.yaml` et `.pnpm/lock.yaml` de pnpm, `.yarn-state.yml` et `.yarn-integrity` de Yarn ; un `node_modules` sans aucun de ces enregistrements, installé par bun ou à la main, n'est **jamais comparable**), chaque fichier `.env*` **à toute profondeur** (hors `node_modules`, le `.git` de la copie et les **worktrees enregistrés** par Git, `git worktree list`, comme ceux de `.worktrees/`, qui ont les leurs), et **tous les autres fichiers ignorés** de la copie (dossiers générés comme `.svelte-kit/`, sorties de build, rapports de test), hors `node_modules`, le `.git` de la copie et `.apv/receipts/` ; un dossier qui contient seulement une entrée nommée `.git` (un fichier vide dans `.svelte-kit/`, un clone égaré) est mesuré comme les autres (relecture sécurité de A2, F1) ; un **worktree enregistré situé dans la copie** (`.worktrees/x`, ou un dossier généré dont on a fait un worktree par `git worktree add`) n'est jamais exclu sans mesure : son HEAD et son `git status --porcelain` entrent dans l'état, et ses fichiers sont parcourus comme ceux de tout dossier ignoré (relecture du delta de A2, F1-bis ; une copie principale qui contient les worktrees des agents reprend donc moins, chacun de leurs changements changeant son état) ; chaque **sous-module** entre par son HEAD et son `git status` (D2), et l'arbre est dit modifié dès qu'un sous-module diffère de ce que le commit enregistre, même avec `ignore = all` dans `.gitmodules` (`git status --ignore-submodules=none`). Ces états sont mesurés **une fois par copie avant son premier contrôle** (la copie neuve d'un lot, préparée par le même `batch.setup`, en repart à l'identique ; une copie de travail qui garde les sorties d'une exécution précédente reprend moins). Ces contenus sont hachés en une seule empreinte, jamais écrits en clair. Pour une commande qui lit `{{baseSha}}` : la même base, et une base commune (`merge-base`) de cette base avec le commit au même arbre des deux côtés. La copie neuve d'un lot (`apv stack batch`) est préparée par `batch.setup` avant toute décision de reprise : son état local est mesuré une fois préparé. Hors lot (`apv gates run --stacks` à plusieurs piles), un contrôle de pile que la répartition peut envoyer dans la copie d'une autre pile (aucun `dependsOn` ne le garde dans la copie de la suite) n'est **jamais repris** (« non repris : copie de pile hors lot ») : cette copie est faite après la décision, son état local ne peut pas être comparé à celui de l'origine. Avec une seule pile (`--stacks 2`), chaque contrôle tourne dans la copie de la suite, dont l'état local est mesuré : la reprise reste possible. Le lot garde la reprise : toutes ses copies sont préparées par le même `batch.setup` de la cible.
- **Ce qui n'est jamais repris** : un arbre modifié ; une commande ciblée ou un contrôle tôt ; `"reuse": false` ; une commande qui lance `apv web audit` ou `apv dast`, ou un audit des dépendances qui lit le réseau (`npm audit`, `pnpm audit`, `yarn audit`, `yarn npm audit`, `bun audit`, `outdated`, `audit-ci`, `better-npm-audit`, `osv-scanner`, `snyk`, `npm-check-updates` et `ncu`, `npm-check`), directement, dans un script en ligne (`node -e`, `sh -c`) ou dans un script de `package.json` qu'elle lance (`npm run audit:ci`, `sh -c "npm run x"`, `node --run x`, `npm --prefix dir run x`, `pnpm -C dir x`, `pnpm --filter pkg x`, `npm -w pkg run x` : les valeurs de ces options sont sautées et le script est cherché dans chaque `package.json` du commit) ; `git` hors d'une **liste fermée** de sous-commandes qui ne lisent que l'arbre et la copie (relecture sécurité de A2 et de son delta, F2 et F2-bis), dans la commande, un script en ligne ou un script de `package.json` : sont repris seulement `diff` et `diff-files` sans révision (options seules avant `--` : `git diff --check`, `git diff --exit-code -- dist`), `grep` sans révision ni `-O`, `status` sans la branche (`-b`, `-sb`, `--branch`, `--ahead-behind`) ni `--show-stash`, `ls-files` sans `--with-tree`, `check-attr` sans `--source`, `check-ignore`, `check-ref-format`, `hash-object`, `stripspace`, `version` ; toute autre sous-commande (l'historique, les objets, les références, un **alias** global, local ou `-c alias.*`, puisque sa commande n'est pas celle écrite) n'est jamais reprise ; options globales de git admises : `--no-pager`, `-P`, `--no-optional-locks`, les options de chemins (`--literal-pathspecs`…), `-C` vers un dossier relatif de la copie (sans `..`), `-c` d'affichage seulement (`color.*`, `core.pager`, `core.quotepath`, `advice.*`, `core.fsmonitor=false`) ; toute autre (`--git-dir`, `--work-tree`, `--exec-path`, `--config-env`, `-c diff.external=…`…) empêche la reprise ; une commande qui lit `{{candidateSha}}` ; une origine réussie après relance, réutilisée, sur arbre modifié, ciblée, d'une autre configuration ou trop vieille ; un contrôle dont un reçu plus récent sur le même arbre a échoué, complet, ciblé ou tôt, dans ce worktree ou dans une autre copie du dépôt (chaque reçu est publié dans le magasin partagé dès son écriture).
- **Consigne aux projets : déclarer `"reuse": false`** pour tout contrôle qui lit l'historique Git hors des gabarits (message de commit, signature, `git log`, `git describe`, une branche distante, un diff depuis une référence écrite en dur) ou un état extérieur au dépôt (réseau, base d'avis, heure, service lancé à part, fichier hors de la copie, variable non transmise par `passEnv`), ou **un fichier ignoré que la commande ne régénère pas** (un cache, des fichiers générés par une autre commande ou à la main), quand la détection ci-dessus ne le voit pas : un fichier de script (`node scripts/x.mjs`, `bash check.sh`) qui le fait n'est jamais lu. Dans le doute, `false` : le contrôle est seulement rejoué.

`early` (facultatif, contrôle de stage `full` seulement ; [ACCELERATION-LOTS.md](ACCELERATION-LOTS.md), partie C) : les **contrôles tôt**, commandes rapides que le projet déclare pour qu'un échec qui n'apparaîtrait qu'en fin de suite complète (un budget de taille du JavaScript servi, les captures d'un écran qu'aucun test n'importe, un test instable) se voie au stage task en quelques minutes. Un contrôle tôt **ajoute** un contrôle, il n'en retire aucun : le contrôle `full` reste exigé en entier par la suite complète et par `apv gates verify` au commit exact. Tableau de 1 à 20 objets :
- `id` (obligatoire) : identifiant propre, distinct de tout contrôle et de tout autre contrôle tôt ; c'est le nom de son reçu (`<id>.json`) ;
- `command` (obligatoire) : tableau d'arguments, mêmes substitutions que `command` (`{{baseSha}}` exige `--base`) ;
- `when` (facultatif) : motifs (`*`, `**`, `?`, sans accolades ni `!`), comparés sans retour arrière comme tous les motifs portables de l'outil (3.0.0-alpha.25 : le chemin est lu une fois, en temps borné par sa longueur fois celle du motif, quel que soit le nombre de `*` et `**` ; un motif choisi par une PR ne peut plus bloquer le stage task). **Au plus 200 caractères et 16 jokers (`*` ou `**` ; `***` en compte deux) par motif**, refusé au-delà par le chargeur : chaque comparaison avec un fichier changé reste de l'ordre de la milliseconde ; le contrôle tôt tourne si un fichier changé depuis la base (`--base`, ou le commit de `--since`) y répond : commits, modifications non commitées et fichiers non suivis hors ignorés, les deux côtés d'un renommage. Sans `when`, il tourne toujours ; sans `--base`, `when` ne peut pas s'évaluer et il tourne aussi. Hors `when` : reçu `not_required` du stage task (« non requis (hors when) »), jamais un reçu de la suite complète ;
- `dependsOn` (facultatif) : contrôles de stage `task` dont il a besoin (par exemple `build`, dont il lit la sortie) ; un contrôle `full` ou inconnu est refusé ;
- `timeoutMs` (120000 par défaut), `passEnv`, `lock`, `resources` : comme pour un contrôle ; **rien n'est hérité du contrôle `full`** (ni ses variables, ni son verrou), un contrôle tôt qui lance la pile de test les déclare lui-même.

`apv gates run --stage task` (et `--since`) lance les contrôles tôt des contrôles `full` retenus, chacun juste après son contrôle dans l'ordre de la configuration, après ses dépendances (`--only <contrôle full>` les amène, avec leurs dépendances). La suite complète (`--stage full`) ne les lance jamais. Leur reçu est ciblé (`targeted: true`) et porte `early` (contrôle `full`, identifiant, requis ou non, raison, fichiers qui répondent à `when`, 50 au plus) : **jamais une preuve du contrôle `full`**, ni au niveau complet ni au niveau tâche de `apv gates verify`, qui ne les compte pour aucun contrôle. Un échec rend le stage task rouge : « Échec tôt de integration (budget-js) : la suite complète échouerait sur ce contrôle ». Un contrôle tôt qui prend plus de 5 minutes est signalé « trop lent pour le stage task ». La sortie les nomme `budget-js (tôt : integration)`, le JSON et `summary.json` les listent dans `early`.

**Lu à la base.** Comme les autres contrôles de la base (section précédente et [CLI.md](CLI.md#apv-gates-run)), les contrôles tôt de la base restent lancés : un candidat qui en retire un, ou change sa commande, son délai, ses variables ou son verrou, le voit tourner avec sa définition de base ; son `when` est l'union de celui de la base et de celui du candidat (absent d'un côté : toujours). Une PR ne réduit donc jamais le `when` qui la juge ; elle peut ajouter des contrôles tôt ou élargir un `when`, sans que le contrôle `full` soit tenu pour « modifié ». Sans `early`, rien ne change (lecture et empreinte de configuration comprises) ; l'ajouter change l'empreinte, comme tout champ d'un contrôle.

Exemple (projet pilote) : le budget JavaScript des pages, extrait du test complet en un script qui lit `.svelte-kit/output` après le `build` du stage task, et les captures de l'accueil répétées trois fois quand l'accueil change :

```json
{
  "id": "integration",
  "stage": "full",
  "command": ["npm", "run", "test:integration"],
  "affected": ["npm", "run", "test:e2e:changed", "--", "{{baseSha}}", "--project=integration"],
  "early": [
    { "id": "budget-js", "when": ["src/**", "static/**", "package.json", "package-lock.json", "vite.config.*", "svelte.config.*"],
      "dependsOn": ["build"], "command": ["node", "scripts/e2e/bundle-budget.mjs"], "timeoutMs": 120000 }
  ]
},
{
  "id": "browser",
  "stage": "full",
  "command": ["npm", "run", "test:browser"],
  "affected": ["npm", "run", "test:e2e:changed", "--", "{{baseSha}}", "--project=browser"],
  "early": [
    { "id": "captures-accueil", "when": ["src/routes/(public)/+page.svelte", "src/lib/home/**"],
      "command": ["npx", "playwright", "test", "tests/e2e/browser/accueil-captures.e2e.ts", "--repeat-each=3", "--retries=0"],
      "lock": { "resource": "e2e" }, "timeoutMs": 300000 }
  ]
}
```

`affected` et `early` se complètent : `affected` lance les tests que le graphe d'imports des tests relie au changement ; `early` couvre ce que ce graphe ne voit pas (un budget de taille, une capture d'un écran qu'aucun test n'importe). `--repeat-each` (sans relance, `--retries=0`) dans la commande tôt attrape une instabilité avant la suite complète.

`lock` (facultatif, 3.0.0-alpha.4) : la ressource que le contrôle partage avec d'autres copies du dépôt (une pile de test), tenue autour de sa commande ; son délai (`timeoutMs`) ne commence qu'une fois le verrou obtenu, l'attente est notée dans le reçu (`lockWaitMs`). Deux formes :
- `{ "resource": "e2e", "waitMs": 1800000 }` : bail de `apv lock` ([LOCKS.md](LOCKS.md)), dans le même dossier (`APV_LOCK_DIR` compris), visible par `apv lock status` ; la commande reçoit `APV_LOCK_HELD` (un `apv lock run e2e` à l'intérieur ne s'attend pas lui-même) ; déjà tenu par l'appelant, il n'est pas repris ;
- `{ "file": "../../pilotage/.e2e.lock", "fileEnv": "E2E_LOCK_FILE", "waitMs": 1800000 }` : `flock` du noyau sur ce fichier (relatif au répertoire Git commun, ou absolu ; créé au besoin), pris par `flock(1)` (util-linux) dont la commande du contrôle est un descendant : un script de projet qui prouve le verrou par un ancêtre détenteur (`/proc/locks`) le voit tenu. Une suite lancée sous ce verrou (`flock <verrou> apv gates run`) n'est pas refusée : ses contrôles qui le demandent ne le reprennent pas et passent un à la fois par un verrou compagnon, dans leur `waitMs` : un fichier vide par fichier de verrou réel (deux chemins vers le même fichier partagent le sien), dans `<APV_LOCK_DIR, sinon ${XDG_STATE_HOME:-~/.local/state}/apv/locks>/under/`, laissé en place. Si ce dossier ne peut pas servir, le compagnon va dans `<dossier temporaire>/apv-under-<uid>/`, puis dans `<verrou>.under` à côté du verrou. Un dossier n'est retenu que s'il est un vrai dossier de ce compte, fermé aux autres. Le partage entre suites suppose le même APV_LOCK_DIR (ou XDG_STATE_HOME, HOME). Une suite lancée par un tel contrôle ne reprend pas le compagnon. `fileEnv` : variable qui, transmise au contrôle (`passEnv`) et non vide, remplace le chemin (relatif au dépôt).
`waitMs` : attente maximale, 30 min par défaut ; au-delà, reçu `timed_out`, commande jamais lancée. Sans `lock`, rien ne change (empreinte de configuration comprise). À ne pas confondre avec `resources`, qui n'ordonne que les contrôles d'une même exécution.

`retryFailed` (facultatif, 3.0.0-alpha.4) : `{ "command": [...], "testPattern": "<expression régulière>" }`. Si la commande du contrôle échoue d'elle-même (statut `failed`), `apv gates run` vérifie que HEAD et l'arbre n'ont pas changé, puis lance une seule fois `command` (mêmes substitutions, variables, délai et verrou), qui doit ne relancer que les tests en échec. Réussite : statut `passed_after_retry`, compté comme réussi mais signalé « instable » par `gates run` et `gates verify` ; échec : échec normal. `testPattern` relève les tests concernés dans la sortie de la première passe (groupe 1 s'il existe, sinon la correspondance entière ; codes de couleur retirés ; 100 au plus). Exemple pour Playwright (reporter `list` ou `line`, qui écrit `  1) [chromium] › tests/a.spec.ts:3:5 › titre`) :

```json
{
  "id": "browser",
  "stage": "full",
  "command": ["npm", "run", "test:browser"],
  "retryFailed": { "command": ["npm", "run", "test:e2e", "--", "--last-failed"], "testPattern": "^\\s*\\d+\\) (\\[[^\\]]+\\] › .+?)\\s*─*$" }
}
```

`--last-failed` relit `test-results/.last-run.json`, écrit par la première passe : la relance ne rejoue que ses tests en échec. Pourquoi la garde ne baisse pas : chaque test a réussi sur le code exact du commit, arbre inchangé ; un test qui échoue deux fois fait échouer le contrôle ; un délai dépassé n'est jamais relancé ; l'instabilité reste visible (statut propre, tests listés) et se traite comme un constat.

`affectedList` (facultatif, 4.0.0-alpha.5, avec `retryFailed`, [UNE-SUITE-PAR-PR.md](UNE-SUITE-PAR-PR.md#3-un-test-instable-sans-rapport-ne-bloque-plus-la-production)) : commande (sans shell, mêmes substitutions, `{{baseSha}}` obligatoire en argument entier) qui **liste** les fichiers de test que `affected` lancerait pour les changements depuis `{{baseSha}}`, par le même calcul (graphe d'imports des tests : il ne voit ni l'application servie ni les fichiers lus sans import, voir [UNE-SUITE-PAR-PR.md](UNE-SUITE-PAR-PR.md#4-tests-ciblés-et-e2e-ce-que-le-graphe-dimports-ne-voit-pas)) ; tout chemin du commit dans sa sortie compte. `apv release` la lit **à la production** (jamais dans le changement) et la lance dans la copie neuve avec `{{baseSha}}` = la production : un test relancé par `retryFailed` qu'elle ne liste pas, dont le fichier n'est ni ajouté ni modifié depuis la production, n'empêche plus la mise en ligne ; il est écrit comme constat. Son script vient pourtant de la copie du commit candidat : si le changement depuis la production touche un fichier que la commande exécute (les chemins de ses arguments, le `package.json` et le script d'un `npm run`, ce qu'ils importent localement), aucun test n'est jugé sans rapport et la mise en ligne est refusée (4.0.0-alpha.8). Sans elle, tout test instable bloque la mise en ligne, comme avant. Pour des tests unitaires, qui n'agissent que par import, le graphe d'imports de l'outil suffit. Pour des tests e2e, `--only-changed` seul serait trompeur : le graphe ne voit pas l'application servie ; appeler le même script du projet que `affected`, avec `--list` (règle modèle : [UNE-SUITE-PAR-PR.md](UNE-SUITE-PAR-PR.md#4-tests-ciblés-et-e2e-ce-que-le-graphe-dimports-ne-voit-pas)) :

```json
"affected":     ["npm", "run", "test:e2e:changed", "--", "{{baseSha}}", "--project=browser"],
"affectedList": ["npm", "run", "test:e2e:changed", "--", "{{baseSha}}", "--project=browser", "--list"]
```

`testPattern` de `retryFailed` doit alors nommer chaque test en échec avec son fichier (`tests/a.spec.ts:3:5 › titre`) : un test sans fichier dans son nom bloque.

`repeatChanged` (facultatif, 3.0.0-alpha.6) : la répétition des fichiers de test que le changement ajoute ou modifie, pour qu'un test instable (attente à durée fixe, horloge réelle, données partagées entre tests) soit rouge sur la branche qui l'apporte plutôt que, des jours plus tard, dans la suite d'un autre. Avec `apv gates run --base <ref>`, une fois la commande du contrôle réussie, `command` est lancée sur ces seuls fichiers, ajoutés à la fin, sous le même verrou ; tout échec rend le contrôle rouge, jamais masqué par `retryFailed` ([CLI.md](CLI.md#apv-gates-run)). Champs :
- `paths` (obligatoire) : motifs des fichiers de test concernés (`*`, `**`, `?`, sans accolades ni `!`) ;
- `command` (obligatoire) : la commande de répétition, mêmes substitutions que `command`, plus `{{repeat}}` (obligatoire, remplacé partout dans un argument par `times`) ; sans relance interne (`--retries=0` pour Playwright), sinon un échec rattrapé passerait inaperçu ;
- `times` : répétitions de chaque test, de 2 à 100, 5 par défaut ;
- `maxFiles` : plafond de fichiers répétés, de 1 à 100, 10 par défaut ; au-delà, l'exécution est refusée avant toute attente (`GATE_REPEAT`), jamais un saut silencieux ;
- `timeoutMs` : plafond de durée de la répétition, sinon le `timeoutMs` du contrôle ; au-delà, reçu `timed_out` et refus explicite ;
- `testPattern` : expression régulière qui nomme un test en échec dans la sortie (groupe 1 s'il existe), pour « échoue X fois sur N » ; sinon celle de `retryFailed` ;
- `stressArgs` : arguments ajoutés avant les fichiers pour charger la répétition, par exemple `["--workers=4", "--fully-parallel"]` pour Playwright : les répétitions d'un même test tournent alors en même temps, ce qui révèle les données partagées entre tests et les attentes trop courtes sous charge ; plus lent sur une petite machine, et la charge compte dans `timeoutMs` ;
- `fixedWaits` : lignes ajoutées par le changement aux fichiers répétés qui attendent une durée (`waitForTimeout(`, `sleep(`, `delay(`, `await setTimeout(` de `node:timers/promises`, `new Promise(r => setTimeout(r, …))` avec argument de type et sur deux à quatre lignes) : `"warn"` (défaut, listées), `"refuse"` (exécution refusée avant toute attente), `"off"` ;
- `reference` (obligatoire) : la branche où va le changement (une référence Git, par exemple `"origin/main"`), sans défaut implicite ; à l'étape `full`, une référence qui ne se résout pas fait refuser `apv gates run` (sortie `2`) et rend le contrôle non prouvé par `apv gates verify` (« référence introuvable »), jamais un repli sur `--base` seule : une suite complète répète aussi les tests modifiés depuis sa base commune avec HEAD, et `apv gates verify` les exige, si bien qu'une `--base` trop proche n'en laisse aucun de côté.

Le reçu note les fichiers répétés, `times` et l'issue (`repeat`) ; ajouter ou changer `repeatChanged` change l'empreinte des contrôles, comme tout champ d'un contrôle. Exemple pour Playwright (reporter `list` ou `line`) :

```json
{
  "id": "browser",
  "stage": "full",
  "command": ["npm", "run", "test:browser"],
  "lock": { "file": "../../pilotage/.e2e.lock", "fileEnv": "E2E_LOCK_FILE" },
  "retryFailed": { "command": ["npm", "run", "test:browser", "--", "--last-failed"], "testPattern": "^\\s*\\d+\\) (\\[[^\\]]+\\] › .+?)\\s*─*$" },
  "repeatChanged": {
    "paths": ["tests/e2e/**/*.e2e.ts"],
    "command": ["npm", "run", "e2e:browser", "--", "--repeat-each={{repeat}}", "--retries=0"],
    "times": 5,
    "maxFiles": 10,
    "timeoutMs": 1200000,
    "reference": "origin/main"
  }
}
```

Une exécution qui lance un tel contrôle exige `--base` (sinon appel incorrect, sortie `2`), et une base dont HEAD descend strictement (sinon `GATE_BASE`) : la suite complète avant une PR se lance avec `--base <base de la PR>`, et `apv stack batch` passe la cible (où `maxFiles` s'applique PR par PR). `apv gates verify` ne compte comme réussi un tel contrôle que si son reçu prouve la répétition de chaque fichier de test que le commit ajoute ou modifie depuis la base enregistrée et depuis la référence ([CLI.md](CLI.md#apv-gates-verify)). `stressArgs` n'accepte pas `{{repeat}}` (seule `command` le remplace).

`skipWhenOnly` (facultatif, 3.0.0-alpha.8, spécification section 21 ; refusé sur un contrôle qui lance `apv web audit`, qui décide lui-même d'après `web.paths`) : la **portée de la preuve** d'un contrôle long, pour qu'une PR qui ne change que de la documentation, des décisions ou des specs ne paie pas une suite navigateur complète, sans rien retirer à la preuve d'une PR qui touche le code. Absent : le contrôle est toujours requis, comme avant (empreinte comprise). Champs :
- `paths` (obligatoire) : motifs des fichiers **sans effet** sur ce contrôle (`*`, `**`, `?`, sans accolades ni `!`) ; un motif qui couvrirait du code source ou du contenu servi (`**`, `**/*`, `src/**`, ou `**/*.md` sans `except` qui retire `src/**`, `static/**`, `public/**` et `content/**`) est refusé à la validation. **Tout fichier lu par l'application ou par les tests** (une page Markdown affichée, une maquette comparée, un texte vérifié par un test) **n'est pas sans effet : il va dans `except`**. La dispense suppose qu'**aucun code ne lit ces fichiers ni leurs dossiers** : ni `readdirSync('docs')`, ni `join('docs', nom)`, ni `import.meta.glob('../docs/*.md')`, ni un test qui compare une page à un texte de `docs/`. L'outil le rattrape quand il le peut : le fichier (chemin, nom, chemin Windows) nommé n'importe où dans l'arbre suivi, et pour un fichier atteint par un motif à joker (`docs/**`) chacun de ses dossiers (`docs/`, `/docs`, `'docs'`, `"docs"`, `` `docs` ``, `\docs`, `docs\`) ; hors recherche : les fichiers dispensés eux-mêmes, `.apv/config.json`, `.apv/DECISIONS.*`, `.apv/specs/**`, `.apv/state/**`, `pipeline.v2.json` et les fichiers d'exclusion d'outils (`**/.*ignore`) ; un autre fichier sous `.apv/` (un script d'outil) est fouillé. **Les commentaires comptent comme des mentions** : un `// voir docs/` rend requis tout changement sous `docs/` ; le défaut reste la suite complète. Compromis : un fichier listé **exactement** (motif sans joker, `AGENTS.md`) n'est cherché que par son chemin et son nom, pas par son dossier ; un `readdirSync('.apv')` qui lirait un fichier exact dispensé ne serait donc pas vu, d'où la liste revue. Aussi : la cible d'un lien symbolique, le dossier des maquettes `design.dir`, et, quand la configuration déclare `web`, tout fichier que l'audit web jugerait « web » (hors `web.neutralPaths`, ou dans `web.paths`, `.apv/config.json`, manifestes...), quelle que soit la commande du contrôle. Un chemin entièrement calculé échappe à tout cela : la liste reste une déclaration revue. Les `.md`, `.mdx`, `.svx` et `.html` sous `src/`, `static/`, `public/`, `content/`, `app/` et `pages/` (à toute profondeur, `packages/*/app/` compris) sont toujours requis ; un contenu chargé **par convention du framework** ailleurs (un dossier de contenu Astro, Docusaurus, un `packages/*/content/` lu sans être cité) doit aller dans `except`. **Préférez une liste fermée de fichiers** (`README.md`, `.apv/DECISIONS.json`, `docs/guide-utilisateur.md`) à un motif de dossier quand c'est possible ;
- `except` (facultatif) : motifs retirés de `paths` (comparés sans tenir compte de la casse), par exemple `["src/**", "static/**", "public/**", "content/**"]`, obligatoires quand `paths` contient `**/*.md`, et tout fichier ou dossier lu par l'application ou par les tests ;
- `reference` (obligatoire) : la branche où va le changement (par exemple `"origin/main"`), sans défaut implicite : les fichiers changés se comptent aussi depuis sa base commune avec le commit, et **`paths` et `except` sont lus dans la configuration de cette référence**, jamais dans celle du changement. La configuration de la référence doit déclarer la même `reference` ; la branche cible protégée, jamais une branche de travail. Le nom est résolu par sa ref complète : une branche locale ou un tag du même nom que la branche de suivi distante le rend ambigu, refusé (`refs/remotes/origin/main` lève l'ambiguïté) ; même règle pour `repeatChanged.reference`. Une ref de suivi réécrite à la main sur la machine (`git update-ref`) n'est pas détectée : même confiance que les reçus locaux ; `apv stack batch` récupère la cible et passe son commit.

À la suite complète (`apv gates run --stage full --base <base de la PR>`, `--base` obligatoire), le contrôle est « non requis » seulement si chaque fichier changé depuis la base commune de `--base` et depuis celle de la référence répond à `paths` de la référence, à aucun `except`, à aucun fichier toujours requis (`.apv/config.json`, `package.json` et les verrous de dépendances, la CI, la configuration de build et de test, les tests, les scripts de test, les chemins que nomment les commandes du contrôle, ses `testPaths` et `repeatChanged.paths`, les migrations : liste de [CLI.md](CLI.md#apv-gates-run)) et garde son mode et son type (un lien symbolique ou un fichier rendu exécutable le rend requis). Il n'est alors pas lancé : reçu `not_required` avec la portée (`scope` : bases, référence, fichiers, raison), que `apv gates verify` recalcule depuis le commit. Tout autre cas, ou une incertitude, le rend requis et il tourne. Une PR qui change la liste touche `.apv/config.json` : elle est prouvée sans dispense. Un contrôle requis rend requises ses dépendances. Avant d'activer `skipWhenOnly`, installer 3.0.0-alpha.8 partout où les reçus sont lus (toutes les machines et copies du dépôt) : les versions antérieures ne connaissent pas le statut `not_required` et signalent ces reçus comme illisibles, ou leur exécution du magasin partagé comme altérée. Exemple :

```json
{
  "id": "browser",
  "stage": "full",
  "command": ["npm", "run", "test:browser"],
  "skipWhenOnly": {
    "paths": ["README.md", "CONTRIBUTING.md", ".apv/DECISIONS.json", ".apv/DECISIONS.md", ".apv/specs/**", "docs/guide-utilisateur.md"],
    "reference": "origin/main"
  }
}
```

`readOnly: true` est une déclaration revue par l'opérateur : la commande **et ses sous-processus** ne doivent écrire aucun fichier dans ce répertoire. Seuls ces contrôles peuvent tourner ensemble, dans la limite de `concurrency` et des ressources nommées ; ils attendent aussi la fin d'un contrôle susceptible d'écrire. Ce champ n'est pas un sandbox ni une détection automatique. Ne pas l'activer pour un lint avec cache, un compilateur incrémental, des tests avec couverture ou des E2E qui lancent un build. Les anciens profils peuvent donc valider plus lentement ; déclarer uniquement les commandes réellement en lecture seule permet de retrouver du parallélisme sûr.

```json
[
  { "id": "build", "command": ["npm", "run", "build"], "outputs": ["dist/**"], "resources": ["dist"] },
  { "id": "integration", "command": ["npm", "run", "test:integration"], "dependsOn": ["build"], "resources": ["test-db"] },
  { "id": "lint", "command": ["npm", "run", "lint"], "cacheTtlMs": 0 }
]
```

Les ressources nommées restent nécessaires pour les ports, bases de données ou autres services externes partagés, même entre contrôles en lecture seule. Elles ne limitent pas les workers qu'un outil lance lui-même. Adapter la concurrence au CPU, à la mémoire et aux outils du projet.

`outputs` est une déclaration utilisée pour refuser le cache de reçus sur les producteurs d'artefacts ; ce n'est pas encore un manifeste d'artefacts vérifié/restauré. Les contrôles ne doivent pas modifier les sources suivies. Les sorties de build doivent être ignorées et leurs consommateurs ordonnés.

## Sélection

Un contrôle `mandatory` s'exécute quel que soit le filtre. Sinon, en `fast` et `standard`, `lanes` et `paths` définissent son applicabilité. Une liste `paths` vide s'applique à tous les changements. Les dépendances transitives d'un contrôle choisi sont incluses, même si leurs propres filtres ne correspondent pas. En `high`, tous les contrôles configurés sont sélectionnés. En mode `qualityReview: "evidence"`, les preuves requises par le changement ajoutent les gates applicables nécessaires, même si leur filtre de lane les excluait ; le filtre de chemins et la couverture restent vérifiés. Voir [les exigences de validation](QUALITY.md#contrôles-et-couverture).

Le moteur refuse un plan vide. Un contrôle absent de la configuration n'est toutefois pas inventé par le noyau : calibrer le profil avec des cas qui doivent échouer. Les filtres de chemins sont des décisions de politique, **pas une analyse sémantique de l'impact des imports**.

Les globs supportés sont `*`, `**` et `?`, avec `/` comme séparateur. Les crochets et parenthèses sont des **caractères littéraux** (répertoires de routes dynamiques ou de groupes dans plusieurs stacks, par exemple `routes/items/[id]/page.ts`) : les classes de caractères ne sont pas prises en charge. Les accolades, un segment commençant par `!`, les chemins absolus et les traversées `..` sont refusés, afin qu'une expansion ou une négation ne corresponde jamais silencieusement à rien. Cette grammaire est volontairement plus petite que celle de certains outils de build.

## Cache et fraîcheur

`cacheTtlMs` vaut zéro par défaut. Une valeur positive n'est acceptée que pour un contrôle indépendant sans sorties déclarées. L'opérateur garantit qu'il est observationnel et suffisamment déterministe. Ne pas activer ce cache pour un scan dont les bases externes, la cible ou l'état réseau ne sont pas représentés dans l'environnement.

La durée de vie d'une entrée concerne sa réutilisation au moment d'une validation. `validationMaxAgeMs`, vingt-quatre heures par défaut, borne séparément le délai avant approbation/export : il protège l'approbation contre une preuve qui ne décrit plus l'environnement, et sa valeur doit survivre à l'étape qu'il protège — une revue humaine. Une valeur inférieure à une heure est signalée par `configAdvice`, parce qu'une preuve expirée coûte un rejeu complet des contrôles et une nouvelle revue qualité sur un candidat que personne n'a touché. Une revalidation efface les avis précédents. Le cache ne rafraîchit pas sa propre durée de vie par des lectures successives.

## Budgets

`maxRunMs` borne le temps actif cumulé entre exécution et reprises, hors attente humaine. Les étapes de création du run, l'inspection, la revue et l'export ne font pas partie de ce compteur. Les timeouts de chaque processus restent bornés par le signal global. Une reprise ne remet pas le budget à zéro.

Une réparation est autorisée uniquement après un échec de contrôle considéré comme corrigeable. Les timeouts, l'absence d'exécutable, les erreurs de setup, la violation du scope et les mutations du validateur ne sont pas transformés en boucles infinies de corrections. Le journal `invocation.started/finished` conserve les tokens et coûts publiés par le fournisseur, y compris en cas de sortie rejetée. Les valeurs absentes et appels sans résultat restent explicitement inconnus ; voir [les mesures](v2/PERFORMANCE.md).

## Workflow de spec et profils de rôles

Ajouter au niveau racine de la configuration, par exemple :

```json
{
  "roles": {
    "product": null,
    "qa": {
      "type": "codex",
      "command": ["codex"],
      "timeoutMs": 600000,
      "passEnv": ["HOME", "CODEX_HOME", "CODEX_API_KEY"]
    }
  },
  "workflow": {
    "qaLanes": ["standard", "high"],
    "maxQaRepairs": 2,
    "maxActiveMs": 3600000
  }
}
```

Cet extrait complète une configuration, ce n'est pas un fichier autonome valide. Null signifie hériter de l'adaptateur de réalisation. Un rôle peut avoir son modèle et ses variables autorisées ; ne pas stocker de clés directement dans le JSON. Setup utilise l'adaptateur par défaut, celui de `--config` ou celui du fichier `--agent` explicite.

En mode de planification `legacy`, `qaLanes` détermine les lanes qui appellent QA (standard/high par défaut). Avec les parcours adaptatifs, standard et structural exigent QA ; compact ne l'évite que si le diff final reste dans son enveloppe non sensible et que `reviewMode` n'est pas `regulated`. Une liste `qaLanes: []` ne désactive donc pas la QA de ces parcours. QA ne remplace jamais la revue humaine : ses seuils dépendent de `reviewMode`, voir [le cycle de vie](v2/LIFECYCLE.md#revue-humaine-et-revalidation).

Les tâches d'une spec sont séquentielles. Pour plusieurs tâches, le contrôle d'intégration force tous les gates configurés, même si leurs filtres individuels auraient réduit la sélection sur un changement isolé. Les setups restent ceux du profil ; les services externes ne sont pas automatiquement démarrés ou provisionnés.

L'onboarding associe les scripts npm/pnpm détectés à une même ressource exclusive par prudence. Après calibration, retirer cette ressource des commandes réellement indépendantes pour bénéficier du parallélisme ; ne pas supposer leur indépendance à partir de leur nom.

## Fournisseurs et skills

`agent.type` accepte `command`, `codex`, `claude`. Choisir `--provider` lors du nouvel onboarding ou un profil `--agent`. Product, Design et QA peuvent utiliser `roles.product`/`roles.design`/`roles.qa`; Product et QA héritent de `agent` si leur profil vaut `null` ; Design hérite de Product, puis de `agent`. Le rôle Setup est choisi au lancement de l'installation.

Les profils natifs acceptent uniquement un chemin d'exécutable dans `command`. Ne pas ajouter de flags arbitraires. Les champs `maxTurns` et `maxBudgetUsd` s'appliquent exclusivement à Claude ; voir ADAPTERS.md pour leurs limites.

Le bloc `skills` est documenté dans SKILLS.md. Son absence signifie aucune compétence ajoutée ; les nouveaux plans déterministes proposent explicitement les six compétences et le type de projet détecté, ou `unknown` si la détection ne suffit pas. Pour recevoir ui-design, configurer un type frontend/mobile/fullstack après inspection réelle du projet. `apv2 inspect --repo PATH` affiche les choix effectifs sans lancer de modèle.

## Politique de revue

```json
"workflow": {
  "qaLanes": ["standard", "high"],
  "maxQaRepairs": 2,
  "maxActiveMs": 3600000,
  "reviewMode": "solo"
}
```

`reviewMode` accepte `solo`, `team` ou `regulated` et vaut `team` par défaut pour compatibilité. Le CLI permet de choisir cette politique une fois avec `bootstrap/onboard --review-mode ...`.

La tâche runtime possède aussi `allowedNewPaths`, `maxNewFiles` et `reviewRequired`. Ces champs sont normalement dérivés par le lifecycle : ils ne doivent pas devenir un moyen de contourner les chemins sensibles ou la revue intégrée finale.

## Découverte des gates de sécurité

L'onboarding Node détecte les scripts de sécurité non interactifs déjà présents dans `package.json`, notamment les familles `security:*`, `test:security*`, `lint:security*`, `audit:*`, `sast*`, `scan*`, `semgrep*`, `gitleaks*` et `trivy*`. Ils sont proposés comme gates `standard`/`high` avec une ressource exclusive `security-checks`.

La détection ne crée jamais automatiquement une commande `npm audit`, Semgrep, Trivy, CodeQL ou autre scanner absent du projet. Installer/configurer un outil, lui donner du réseau ou des credentials est une décision distincte. Un scanner existant n'abaisse jamais les autres gates.

## Inventaire du dépôt : `knowledge.languages`

Bloc optionnel. Vide, le contrôleur utilise ses profils de langage intégrés et indexe toute autre technologie texte comme unités de fichier. Un profil projet remplace un profil intégré de même `id` et revendique ses extensions en premier.

```json
"knowledge": {
  "languages": [
    {
      "id": "widget-dsl",
      "extensions": ["widget"],
      "prefilter": "component",
      "declarations": [
        { "kind": "component", "pattern": "^(?<hidden>private\\s+)?component\\s+(?<name>\\w+)", "exported": "unless-hidden" }
      ]
    }
  ]
}
```

`pattern` est une expression régulière JavaScript appliquée à une ligne ; le groupe nommé `name` est obligatoire. `exported` vaut `always`, `marker` (groupe `export`), `capitalized`, `not-underscore` ou `unless-hidden` (groupe `hidden`). `prefilter` est une ERE POSIX transmise à `git grep`. Ce bloc fait partie de la configuration revue et hachée ; il ne donne aucune permission.

## Réparation des sorties de rôle : `workflow.maxOutputRepairs`

Nombre de réinvocations autorisées après une violation du contrat de sortie (schéma, invariants de spec/design/QA/décisions). `1` par défaut, `0` désactive, `2` au maximum. Les délais dépassés, annulations, refus de permission et échecs de processus ne sont jamais réessayés. Chaque réinvocation consomme le budget du fournisseur.

## Limites de contexte : `limits`

```json
"limits": { "maxTaskContextChars": 120000, "maxQaDiffBytes": 524288 }
```

- `maxTaskContextChars` (10 000 à 400 000) borne le contexte approuvé intégré à une tâche ou à une réparation QA : spec, sécurité, design ciblé. Au-delà, l'exécution s'arrête avec `TASK_CONTEXT` au lieu de tronquer.
- `maxQaDiffBytes` (64 Kio à 8 Mio) borne le diff intégré transmis à QA. Au-delà, QA est refusée plutôt que tronquée.

Relever une limite augmente le coût et le risque de dilution du contexte du fournisseur. C'est une décision de politique revue et hachée avec la configuration.

Les longueurs des champs produits par les modèles (par exemple 3 000 caractères par vérification) restent fixées par les schémas exportés et transmis aux fournisseurs. Une réponse qui les dépasse est réparée par `workflow.maxOutputRepairs`, pas ignorée.

## Parcours, profils et checks en session

Les fichiers existants sans réglages explicites conservent `workflow.planningMode: "legacy"` et `workflow.qualityReview: "legacy"`. Les configurations neuves proposées par `init` et l'onboarding activent `adaptive` et `evidence`. Une configuration fournie explicitement conserve ses choix. Les changements s'appliquent aux nouvelles specs après revue de la configuration, pas silencieusement aux specs approuvées.

- `planningMode: "adaptive"` active Product court pour le parcours standard et une décision d'architecture préalable pour le parcours structurant. `spec compact` est le raccourci explicite pour une tâche déjà cadrée. [Choix du parcours](v2/LIFECYCLE.md#choisir-le-parcours).
- `qualityReview: "evidence"` impose les preuves applicables et la grille QA. Les gates déclarent `covers` et, pour relier un test négatif à une commande, `testPaths`. `validationRules` ajoute les obligations propres aux chemins du projet. [Configuration détaillée](QUALITY.md).
- `agent` configure l'Implementer ; Product et QA héritent de lui si leur profil vaut `null`. Design hérite de `roles.product`, puis de `agent`, si `roles.design` vaut `null`.
- `roleProfiles` choisit `quick` pour fast/standard et `deep` pour high, par fournisseur et rôle. Une règle `modelRouting` exacte (fournisseur, rôle, lane) prime ; un amendement opérationnel autorisé prime ensuite. Les modèles et efforts sont explicites, sans modification des permissions.
- `workflow.qaProfile: "deep"` applique à QA la politique high indépendamment du risque de la tâche ; `"lane"` conserve le comportement historique. `--models FILE` au bootstrap/onboarding sélectionne explicitement quick/deep et une QA dédiée, éventuellement chez un autre fournisseur.
- `agent.preflight` et le champ équivalent des rôles natifs acceptent `"off"` (défaut) ou `"probe"`. Le contrôle réel, borné et facturable, précède l'envoi du contexte projet. Il est activé par `--models` et `--model`. [Choix, coûts, priorité et migration des modèles](v2/MODELS.md).

Les checks en session sont désactivés par défaut (`feedback.gateIds: []`). Pour les activer, compléter une configuration qui contient déjà ces deux gates :

```json
{
  "feedback": { "gateIds": ["typecheck", "test"], "maxCalls": 4, "maxTotalMs": 120000 },
  "validationReserveMs": 60000
}
```

Les IDs doivent désigner des gates indépendantes (`dependsOn: []`), sans placeholder `{{...}}`. Le runner exécute leurs commandes fixes sur le worktree de l'Implementer, avec leurs variables autorisées après exclusion des variables fournisseur et des noms de secrets, jamais un argv inventé par le modèle. `maxCalls` et `maxTotalMs` bornent cette boucle ; ses résultats ne sont pas des reçus finaux. La validation indépendante reste obligatoire. [Transport et permissions](v2/ADAPTERS.md).

## Fichiers générés : `workflow.generatedPaths`

Globs des fichiers que seul l'outillage du projet régénère. Par défaut, les lockfiles des gestionnaires de paquets courants. Remplacez la liste pour l'adapter à votre stack (par exemple `**/*.generated.ts`).

Si l'Implementer configuré n'a pas de shell (adaptateur Claude natif), une spec dont une tâche nomme explicitement un de ces fichiers dans `allowedPaths` est refusée avec `SPEC_CAPABILITY`. L'étape d'outillage doit alors devenir un prérequis opérateur. Les wrappers `command`, aux capacités inconnues, ne sont pas présumés sans shell.

## Arborescence : `structure`

Section APV3, facultative, lue par `apv structure check`, `apv structure map` et `apv map` ([CLI.md](CLI.md#apv-structure-check), [STRUCTURE.md](STRUCTURE.md)) et validée par le chargeur commun (`apv status` signale une valeur invalide, jamais la section comme ignorée). Absente, tout tourne avec les valeurs par défaut. Avec `--base`, c'est la section **de la base** qui juge le changement : la modifier passe par une PR de configuration à part, décidée par l'opérateur.

```json
{
  "structure": {
    "roots": ["src"],
    "maxFlatFiles": 12,
    "roles": { "-gateway": "client", "-store": "store", "session": null },
    "domains": ["offer-prefill"],
    "ignore": ["src/lib/generated/**"],
    "severity": { "flat-folder": "error", "mixed-roles": "error" },
    "architectureMap": "docs/carte-architecture.md",
    "profile": "sveltekit"
  }
}
```

- `roots` : dossiers analysés, relatifs à la racine du dépôt (par défaut tout le dépôt, fichiers de code seulement).
- `maxFlatFiles` : fichiers de code qu'un dossier peut contenir directement, tests et fichiers compagnons à part (12 par défaut, de 2 à 1000). Au-delà : `flat-folder` (découpage proposé) et, avec `--base`, tout ajout refusé (`flat-growth`).
- `roles` : rôles ajoutés à ceux par défaut. Une clé qui commence par `-` est un suffixe de nom (`-gateway` : `payment-gateway.ts` a le rôle `client`, domaine `payment`) ; une autre clé est un mot du nom, pour un utilitaire transverse sans domaine (`session` : rôle `auth`). `null` retire un rôle par défaut. Clés et rôles en kebab-case.
- `domains` : noms de domaines connus, en kebab-case. Un domaine de plusieurs mots (`offer-prefill`) regroupe les fichiers qui commencent par lui ; un domaine déclaré suffit à regrouper deux fichiers et sert de nom au découpage par usage. Les noms des dossiers du projet sont déjà des domaines connus.
- `ignore` : globs (`*`, `**`, `?`, `{a,b}`) des chemins laissés de côté, en plus des exclusions par défaut (`node_modules/` partout ; `dist/`, `build/`, `coverage/`, `vendor/` et dossiers qui commencent par un point à la racine du dépôt ou d'un paquet, pour l'existant seulement : ce qu'un changement crée est toujours analysé). Seule façon d'écarter un fichier, un lien symbolique ou un sous-module qu'un changement ajoute ; lue à la base.
- `severity` : `warning` ou `error`, pour tous les constats ou par code. Par défaut `warning` pour l'analyse (`flat-folder`, `repeated-prefix`, `mixed-roles`, `stray-file` : sans `--base`, une gravité `error` fait sortir en `1` ; avec `--base`, seulement sur un fichier créé ou déplacé par le changement) et `error` pour la comparaison avec la base (`flat-growth`, `architecture-map` : seul ce que le changement ajoute bloque).
- `architectureMap` : chemin de la carte de l'architecture (Markdown), `docs/carte-architecture.md` par défaut.
- `profile` : profil de pile dont les conventions s'appliquent (`sveltekit`, `nextjs`, `nuxt`, `astro`, `angular`, `vue`, `react`, `python`, `go`, `generic`) ; détecté par les dépendances et les fichiers marqueurs quand il est absent.

**Le contrôle.** `apv init` et `apv onboard` déclarent pour tout projet :

```json
{
  "gates": [
    { "id": "structure", "command": ["apv", "structure", "check", "--base", "{{baseSha}}"], "covers": ["architecture"], "stage": "task", "readOnly": true, "mandatory": true }
  ]
}
```

`{{baseSha}}` est la base du passage (`apv gates run --base <ref>`), qui fait partie de la clé de preuve de chaque reçu. Un projet pas encore rangé n'est jamais rouge pour son existant : ses dossiers à plat et ses dossiers non décrits sont signalés sans bloquer, seul ce que le changement ajoute bloque. Le rangement est une spec à part, décidée par l'opérateur (compétence `apv:structure`). `apv` doit être sur le `PATH` de la machine (plugin activé ou `npm link`), sinon utilisez `["node", "<chemin du plugin>/dist/cli.js", "structure", "check", "--base", "{{baseSha}}"]`.

## Exécution : `run`

Section APV3, facultative, lue par `apv run next` et validée par le chargeur commun (valeur inconnue refusée). Elle règle le rythme de la suite complète (contrôles de stage `full` compris) sous `/apv:run`.

```json
{ "run": { "fullSuite": "final" } }
```

- `fullSuite` : `"final"` (défaut, section absente comprise) ou `"each-integration"`.
  - `"final"` : la suite complète tourne à la **dernière intégration** (toutes les tâches de la spec intégrées, avant les revues, qui citent ses reçus) et à la **livraison** sur la tête finale, sauf si `apv gates verify --commit <tête>` y sort déjà en `0` (spec sans corrections : pas de double suite). Les intégrations intermédiaires et les passes de corrections avancent `apv/<id>` sur les contrôles de tâche et les tests ciblés (`affected`) de tous les fichiers changés depuis la dernière suite complète, vérifiés au commit exact : `apv gates run --stage task --base <base ciblée>`, puis `apv gates verify --commit <tête> --stage task --base <base ciblée>` à `0`. `apv run next` donne la base ciblée (la base de l'exécution tant qu'aucune suite complète n'est passée, puis la tête de la dernière intégration) et le niveau attendu à chaque étape.
  - `"each-integration"` : la suite complète à chaque intégration, corrections comprises, et à la livraison (rythme de 3.0.0-alpha.3 et avant).

Ce réglage ne touche à aucune autre preuve : contrôles de tâche complets pour chaque implementer, tests négatifs, revues (sécurité aux attaques réelles comprise), suite complète et `apv gates verify` à `0` au commit exact avant toute PR, contrôle rouge jamais ignoré, test instable traité comme un constat. Compromis de `"final"` : une régression entre vagues, hors des fichiers changés et de ce qui en dépend, peut n'être vue qu'à la dernière intégration ; les tests ciblés la limitent, et elle est corrigée avant les revues. Préférez `"each-integration"` quand une découverte tardive coûte trop (spec longue, vagues très dépendantes, contrôle `full` sans commande `affected`).

Repère (projet pilote « Toujours rien », septembre 2026, suite complète d'environ 9 minutes) : une spec à trois vagues avec une passe de corrections lançait 5 suites complètes (3 intégrations, 1 intégration de corrections, 1 livraison) ; avec `"final"`, 2 (dernière intégration, livraison) ; sans corrections, 4 contre 1.

**Le rythme est tenu par l'outil.** Dans le cadre d'une exécution, `apv gates run --stage full` (ou sans `--stage`) refuse, code `1` (`GATE_RHYTHM`), une suite complète qui exécuterait au moins un contrôle de stage `full` quand l'étape courante n'attend que les contrôles de tâche et ciblés : même calcul que `apv run next` (`suite.level` à `task` : intégration intermédiaire ou passe de corrections avec `"final"`). Le message donne le niveau attendu et la commande à lancer à la place (`apv gates run --stage task --base <base ciblée>`, puis `apv gates verify --commit <tête> --stage task --base <base ciblée>`). L'exécution est celle de `--run <spec-id>`, sinon celle de la branche courante (`apv/<id>` ou `apv/<id>-<suffixe>`, l'identifiant le plus long d'abord) quand un worktree du dépôt a `.apv/state/run-<id>.json` (tous les worktrees de `git worktree list` : chaque exécution tourne dans son propre checkout ; plusieurs copies : celle du worktree sur `apv/<id>`, sinon celle du checkout principal, sinon refus `RUN_AMBIGUOUS` qui liste les emplacements). Hors exécution (autre branche, tête détachée, aucun état), à la dernière intégration, à la livraison et avec `"each-integration"`, rien ne change. Dérogation motivée : `--reason "<texte>"` (1 à 500 caractères) laisse passer la suite ; la raison est journalisée dans l'état de l'exécution (événement `gates:full`, avec le commit) et écrite dans chaque reçu et dans `summary.json` (`override`). Ces reçus prouvent la suite complète comme les autres.

Repère (nuit du 24 au 25 septembre 2026, même projet pilote) : une session a lancé la suite complète à une intégration intermédiaire alors que `apv run next` annonçait le niveau tâche ; la suite a trouvé des tests qui se gênaient, deux passes de corrections ont suivi, suite relancée chaque fois : 3 h pour une seule intégration intermédiaire.

## Taille des specs : `spec`

Section APV3, facultative, lue par `apv spec validate` et validée par le chargeur commun (entier hors bornes ou propriété inconnue refusés). Elle fixe les seuils au-delà desquels la validation **avertit**, sans jamais rendre la spec invalide ni changer le code de sortie (seul `userScenarios: "error"`, plus bas, fait d'un constat une erreur).

```json
{ "spec": { "maxTasks": 6, "maxAcceptance": 30, "maxDepth": 3, "minUserScenarios": 3, "userScenarios": "warning" } }
```

- `maxTasks` (défaut `6`, de 1 à 100) : nombre de tâches au-delà duquel la validation propose de découper la demande en specs indépendantes de 4 à 6 tâches, livrées en parallèle (sur des piles de test distinctes quand le projet en déclare plusieurs, par exemple des ressources de contrôle distinctes), chacune avec sa PR.
- `maxAcceptance` (défaut `30`, de 1 à 1000) : même avertissement au-delà de ce nombre de critères d'acceptation.
- `maxDepth` (défaut `3`, de 1 à 100) : nombre de couches du graphe des tâches (les vagues de `apv run start`) au-delà duquel la validation nomme le chemin le plus long. Chaque couche attend l'intégration de la précédente : le motif « contrats d'abord » (une première tâche pose les types, schémas, signatures de fonctions, interfaces de composants et migrations, avec des implémentations minimales testées) laisse les tâches suivantes se construire en parallèle contre ces contrats. Une dépendance ne se déclare que si la tâche a besoin du code de l'autre, pas seulement de son existence future.
- `minUserScenarios` (défaut `3`, de 1 à 5) et `userScenarios` (`warning` par défaut, ou `error`) : **scénarios utilisateur** (`SPEC_USER_SCENARIOS`, hors `--draft`). Une spec qui touche une interface porte de `minUserScenarios` à 5 critères `AC-USER-<n>`, écrits « Étant donné … quand … alors … » (ou « Given … When … Then … »), du point de vue de la personne cible, chacun avec une vérification qui nomme un test navigateur (navigateur, browser, Playwright, Cypress, e2e…) ou le parcours joué par la personne cible avant la fusion. Une spec touche une interface quand l'outil le sait déjà : `experience.uiImpact` autre que `none` ; ou, pour une spec qui ne déclare pas `experience`, un chemin autorisé d'une tâche dans la classe `ui` des revues (`review.paths.ui`, ou ses défauts : les chemins qui gardent la revue de fidélité) ou une maquette validée citée (un texte de la spec qui nomme `design.dir`, `docs/design/` par défaut). Un `"uiImpact": "none"` déclaré, avec sa raison, fait foi : sur le projet pilote, deux specs de rangement (composants déplacés sans effet visible, maquettes citées pour les garder hors du diff) auraient sinon été signalées à tort ; la revue de fidélité suit toujours les chemins. Un scénario mal formé (sans « Étant donné, quand, alors » dans l'ordre, ou sans test navigateur ni parcours joué) est signalé aussi, et chaque message dit quoi ajouter. Une spec sans interface n'est pas concernée. `warning` laisse valider les specs existantes ; `error` refuse la spec, à `apv spec validate` comme à `apv run start`.

Les avertissements sortent aussi en JSON (`warnings`, codes `SPEC_SIZE`, `SPEC_DEPTH` et `SPEC_USER_SCENARIOS`, `limits`, les seuils appliqués, et `userScenarios`, le seuil et le niveau des scénarios). Une spec déjà validée par l'opérateur s'exécute telle quelle.

Repère (projet pilote, 4 octobre 2026) : les specs rédigées décrivaient surtout le code, sans scénario du point de vue de la personne qui utilise l'écran ; l'opérateur a demandé 3 à 5 scénarios par spec, joués par la personne cible avant la fusion, portés par le pipeline pour tous les projets.

Repère (projet pilote, nuit du 24 au 25 septembre 2026) : une spec de 12 tâches et 65 critères, en chaîne de 5 couches (base, données, relances et documents, ajout et actions et fiche, liste et colonnes), a demandé environ 9 h d'exécution, chaque couche attendant l'intégration de la précédente.

## Reçus : `receipts`

Section APV3, facultative, validée par le chargeur commun (entier hors bornes ou propriété inconnue refusés). Elle borne le magasin partagé des reçus, `<répertoire git commun>/apv/receipts/` : `apv gates run` y copie chaque exécution (reçus, `summary.json` et `manifest.json` avec l'empreinte sha256 de chaque fichier) pour qu'elle survive au retrait de son worktree et que `apv gates verify --commit <sha>` prouve le commit depuis n'importe quel checkout du dépôt ([CLI.md](CLI.md#apv-gates-run)). Le magasin est dans le répertoire Git : jamais versionné, commun à tous les worktrees.

```json
{ "receipts": { "keepDays": 30, "keepRuns": 1000 } }
```

- `keepDays` (défaut `30`, de 1 à 3650) : une exécution plus ancienne (heure de début inscrite dans son identifiant) est retirée du magasin.
- `keepRuns` (défaut `1000`, de 1 à 100000) : au-delà, les exécutions les plus anciennes sont retirées.

La rétention s'applique après chaque copie, et à la demande par `apv gates receipts prune` (dont `--keep-days` et `--keep-runs` remplacent la section). Elle ne touche jamais les reçus des worktrees (`.apv/receipts/`) ni les autres entrées du dossier. Repère de taille : une exécution pèse quelques kilo-octets par contrôle. Garder au moins la durée qui sépare une livraison de la fusion de sa PR : la preuve citée dans la PR doit rester vérifiable jusque-là.

## Revues : `review`

Section APV3, facultative, validée par le chargeur commun (propriété inconnue, joker inconnu ou partiel, motif de chemin hors syntaxe portable refusés). Elle déclare ce que `apv review plan` lit pour proposer les domaines de revue d'après le diff (`paths`, `terms`, `always`, plus bas), et le scan dynamique de sécurité du projet (ZAP ou un autre outil), que le chef de projet lance avant les revues par `apv dast run` ([CLI.md](CLI.md#apv-dast-run)) : les agents de revue n'ont pas le droit de lancer Docker, la revue sécurité lit les rapports. Absente : aucun scan déclaré, et la revue sécurité note le scan dynamique « non vérifié : non déclaré par le projet ».

```json
{ "review": { "dast": {
  "command": ["sh", "scripts/dast.sh", "{{reportDir}}", "{{commit}}"],
  "resource": "dast",
  "timeoutMs": 3600000,
  "passEnv": ["HOME", "DOCKER_HOST"],
  "description": "ZAP : balayage de base puis balayage authentifié"
} } }
```

- `command` (obligatoire) : argv sans shell, lancé dans la copie détachée du commit revu. Jokers remplacés comme arguments entiers : `{{reportDir}}` (dossier des rapports, hors de la copie), `{{commit}}` (sha complet de la copie), `{{repo}}` (chemin de la copie) ; mêmes valeurs dans `APV_DAST_REPORT_DIR`, `APV_DAST_COMMIT`, `APV_DAST_REPO`. La commande prépare ce qu'il lui faut (dépendances, build, serveur sur un port à elle), lance le scan, écrit ses rapports (HTML, JSON) dans le dossier, puis arrête ce qu'elle a lancé ; son code de sortie devient le statut du scan (`0` : `passed`).
- `resource` (défaut `"dast"`) : le verrou à bail pris pendant le scan, comme `apv lock run <ressource>` ; un scan qui se sert d'une pile partagée (base locale de test, ports fixes) y nomme la ressource de cette pile (par exemple `"e2e"`).
- `timeoutMs` (défaut `3600000`, de 1000 à 14400000) : durée maximale ; au-delà, la commande est arrêtée (SIGTERM, puis SIGKILL) et le scan est `timed_out`.
- `passEnv` (défaut `[]`) : variables transmises en plus de `environment.passEnv` par défaut (`PATH`, `LANG`, dossiers temporaires) ; un client Docker a souvent besoin de `HOME`.
- `requiredEnv` (relecture de 1786b40, facultatif) : variables sans lesquelles le contrôle ne peut pas tourner (l'adresse et les clés d'une pile de test) ; une absente, apv ne lance pas le contrôle (reçu `spawn_error`) et inscrit le constat dans le reçu (`finding`) : seule une panne ainsi constatée par l'outil permet à `apv release auto` de relancer la suite au même commit.
- `envFile` (facultatif, 3.0.0-alpha.15) : fichier `KEY=valeur` chargé dans l'environnement de la commande (`~/…` pour le dossier personnel, relatif à la copie sinon), par exemple `"~/.config/mon-projet/dast.env"` pour l'adresse de l'aperçu local et un compte de test. Refusé, rien n'est lancé, s'il pose une variable réservée (`APV_*`, `PATH`, `NODE_OPTIONS`, `NODE_PATH`, `HOME`, `LD_*`, `DYLD_*`) ou si une valeur ressemble à une adresse hors bouclage (liste d'autorisation : seuls `localhost`, `*.localhost`, `127.0.0.0/8` et `::1` sont admis ; détail dans [CLI.md](CLI.md#apv-dast-run)) : le scan ne vise jamais la production. Un compte de test s'écrit sur un domaine réservé aux exemples (`demo@example.org`). `summary.json` dit s'il a été chargé et combien de variables, jamais leurs valeurs. La copie reçoit aussi seule ses dépendances (`npm ci --ignore-scripts`) quand elle a un `package-lock.json` que l'outil n'a pas encore installé ([CLI.md](CLI.md#apv-dast-run)).
- `description` (facultatif, 500 caractères au plus) : ce que fait le scan, recopié dans `summary.json`.

Repère (projet pilote, septembre 2026) : la revue sécurité prévoyait un scan ZAP par Docker ; les permissions des agents de revue refusaient `docker run` et `docker pull`, et le scan n'a tourné sur aucune des livraisons suivies.

### Domaines de revue selon le diff : `paths`, `terms`, `always`

`apv review plan` ([CLI.md](CLI.md#apv-review-plan)) classe chaque fichier du diff et propose les domaines : `securite` toujours, sans exception ; `fidelite`, `donnees` et `rgpd` seulement quand un fichier de leur domaine change de contenu, ou qu'un fichier non classé change de contenu (prudence). Absentes, ces clés prennent des valeurs génériques (toute stack) ; une clé donnée **remplace** la liste par défaut de sa classe (une liste plus courte laisse plus de fichiers non classés, donc plus de revues gardées).

```json
{ "review": {
  "paths": {
    "ui": ["src/lib/components/**", "src/routes/**/*.svelte", "**/*.css"],
    "data": ["src/lib/server/**/repository.ts", "src/lib/server/database/**"],
    "migrations": ["supabase/migrations/**"],
    "personal": ["src/lib/export/**", "src/routes/**/export/**"],
    "legal": ["src/routes/(legal)/**"],
    "neutral": ["tests/**", "**/*.test.ts", "docs/**"],
    "tooling": ["scripts/test-*.mjs"]
  },
  "terms": { "data": [".from('", ".rpc("], "personal": ["cookie", "localstorage", "email"] },
  "always": ["fidelite"]
} }
```

- `paths` : motifs par classe, syntaxe portable des chemins autorisés (`*`, `**`, `?` ; accolades et `!` refusés), 500 au plus par classe. `ui` (composants, styles, gabarits : garde `fidelite`), `data` (requêtes, dépôts, modèles : `donnees`), `migrations` (migrations et schémas : `donnees` et `rgpd`, renommage compris ; `db.migrations` s'y ajoute), `personal` (export, cookies, consentement, traceurs, registre `.apv/rgpd/` : `rgpd`), `legal` (mentions, confidentialité, CGU : `rgpd`), `neutral` (tests, documentation, outillage : aucun domaine, seulement pour un fichier qu'aucune autre classe ne décrit). Défauts : `src/review/config.ts` (`DEFAULT_REVIEW_PATHS`), par exemple `**/*.svelte`, `**/*.css`, `**/components/**` pour `ui`, `**/repositories/**`, `**/db/**`, `**/*schema*.*` pour `data`, `**/migrations/**`, `**/*.sql` pour `migrations`, `**/legal/**`, `**/*cgu*.*` pour `legal`, `**/*.test.*`, `docs/**`, `.apv/**` pour `neutral`. Une maquette validée touchée (dossier `design.dir`) garde `fidelite`. `tooling` (mocks, fixtures, utilitaires de test : `__mocks__/`, `fixtures/`, `test-utils/`... : aucun domaine en propre) et `server` (code serveur et configuration : `**/server/**`, `**/*.server.*`, `**/api/**`, `**/*.config.*`, `**/*.json`, `**/*.yml`... : aucun domaine en propre) complètent les classes (3.0.0-alpha.15). `personal` comprend aussi les modèles de messages (`**/email*/**`, `**/emails/**`, `**/mail/**`, `**/notifications/**`). **Priorités** : un fichier `neutral` ou `tooling` qui est aussi `server`, un chemin sensible de la voie high ou une configuration (liste fixe, non configurable : `.apv/config.json`, `pipeline.v2.json`, `*.config.*`, lint et format, `package.json` et verrous, `tsconfig*.json`, `.env*`, `.github/**`, `Dockerfile*`...) garde `fidelite`, `donnees` et `rgpd` ; seul un fichier nommé comme un test (`*.test.*`, `*.spec.*`, `*.e2e.*`) y échappe, jamais une configuration. Un fichier propre au projet que les défauts ne décrivent pas se classe ici : `"ui": ["src/lib/copy/**"]`, `"tooling": ["scripts/test-*.mjs"]` ; une clé donnée remplace sa liste par défaut, la reprendre en entier si on l'étend.
- `terms` : mots (sous-chaînes, sans casse, de 2 à 200 caractères) qui, dans les lignes changées d'un fichier `ui` ou `data`, et aussi d'un test, d'un document ou d'un fichier d'outillage (3.0.0-alpha.15 : une fixture avec des données personnelles), gardent `donnees` (`data` : une requête écrite dans une page, du SQL dans une chaîne) ou `rgpd` (`personal` : un traceur, un cookie, un champ personnel, ce qu'un texte dit de la conservation, de l'hébergement, des prestataires, des transferts ou de la suppression). Une adresse e-mail réelle (domaine non réservé aux exemples) ajoutée garde aussi `rgpd`. Défauts : `DEFAULT_REVIEW_TERMS`, complétés en 3.0.0-alpha.15 (CLI.md). Une fausse alerte garde une revue, jamais l'inverse.
- **Niveau de risque** (3.0.0-alpha.15, `src/review/risk.ts`) : `apv review plan` donne le niveau du diff et sa raison, décidé par le **chemin** seul (le contenu n'est jamais lu comme du « texte » : les relectures de la PR #110 ont contourné une telle lecture de neuf façons). **Faible** quand chaque fichier est un test (nommé `*.test.*`, `*.spec.*`, `*.e2e.*`, ou sous un dossier `test/` ou `tests/`), de la documentation (`*.md` classée neutre (`docs/`, `README`, `CHANGELOG`) hors dossiers servis et hors texte légal) ou une maquette validée, sans terme de `review.terms` ni adresse e-mail réelle dans ses lignes changées : le plan garde `securite`, plus `fidelite` pour une maquette. **Élevé** pour tout le reste, interface comprise (un `.svelte` dont seul le texte change) : le plan est celui de 3.0.0-alpha.14. `--force` et `always` restent au-dessus du niveau. `apv rules check` exige exactement les domaines du plan au commit (même calcul, configuration lue à la base commune), et `apv gates run --since` n'accepte qu'un diff de risque faible. Les instructions des agents (`agents/**`, `workflows/**`, `skills/**`, `SKILL.md`, `.apv/brief.md`, `CLAUDE.md`, `AGENTS.md`, `.claude/**`) sont des chemins sensibles, de risque élevé ; un `.md` non classé (`articles/`) aussi. L'outillage (`fixtures/`, `__mocks__/`) hors d'un dossier `test/` ou `tests/` garde tous les domaines (`src/lib/fixtures/demo.ts`), et un dossier `tests/` sous un dossier de routage (`routes/`, `pages/`, `app/`) n'est jamais un dossier de tests (`src/routes/tests/+page.svelte`).
- `always` : domaines toujours gardés, quel que soit le diff (`fidelite`, `donnees`, `rgpd` ; `securite` l'est de toute façon). L'opérateur en force un autre au lancement par `apv review plan --force <domaine>`.
- Aucune clé ne saute la revue sécurité : une clé inconnue (`skip`, `never`) est refusée par le schéma, et `apv run set <id> review:securite skipped` est refusé par l'état.

Repère (projet pilote, 25 septembre 2026) : une spec de pur rangement (77 renommages, imports, aucun changement de comportement, aucune migration, aucun écran) est passée par les quatre revues, 40 à 70 minutes ; fidélité, données et RGPD n'avaient rien à relire. Sur la branche de ce rangement (tête `676cefd`, 203 fichiers : 42 renommages purs, 142 fichiers aux seuls chemins réécrits, 19 tests, documentation ou outillage), `apv review plan` avec les défauts retient `securite` seule.

## Ressources de test : `resources`

Section APV3, facultative, validée par le chargeur commun (port hors de 1 à 65535, port en double dans une ressource, liste vide ou propriété inconnue refusés). Elle nomme les ressources de test du projet (pile de test navigateur, base locale, scanner), avec les mêmes noms que les `resources` des contrôles et que `apv lock`, et déclare les ports TCP où leurs serveurs écoutent :

```json
{
  "resources": {
    "e2e": { "ports": [4173, 4174], "description": "pile de test 1 : build servi par vite preview" },
    "e2e-2": { "ports": [4273, 4274], "description": "pile de test 2 (E2E_STACK=2)" }
  }
}
```

- `ports` (obligatoire, de 1 à 100 ports) : ports d'écoute des serveurs de la ressource.
- `description` (facultatif, 500 caractères au plus) : texte libre.

`apv procs` lit ces ports, et ceux des piles de `stacks` ([CLI.md](CLI.md#apv-procs)) : `apv procs stop` sans option arrête les processus qui y écoutent encore, s'ils ont été lancés dans un worktree lié du dépôt (serveurs laissés par une suite coupée au délai d'un appel Bash), jamais un processus hors du dépôt ; un processus du checkout principal seulement avec `--include-main`, et seulement sur un port déclaré ici. Absente : aucun port déclaré, et `apv procs stop` demande `--port` ou `--repo <copie>`. Déclarer ici les ports de toutes les piles de test, pas celui de l'aperçu (`preview.serve.port`), qui tourne dans sa propre copie hors du dépôt et que `apv procs` n'arrête jamais.

## Suite complète : `suite`

Section APV3, facultative, validée par le chargeur commun (3.0.0-alpha.4, spécification section 17). Elle règle la suite complète de `apv gates run` (une exécution qui lance en entier au moins un contrôle de stage `full`) : sa file d'attente sur la machine et les ports à libérer avant qu'elle démarre ([CLI.md](CLI.md#apv-gates-run)). Absente : file active avec les valeurs par défaut, aucun port.

```json
{
  "suite": {
    "queue": { "lockFile": "apv/locks/full-suite.lock", "waitMs": 7200000, "maxLoad": 6, "loadWaitMs": 1800000, "slots": "per-stack" },
    "ports": [4173, 4174, 4273, 4274]
  }
}
```

- `queue.enabled` (défaut `true`) : `false` retire la file (chaque suite démarre aussitôt, comme avant 3.0.0-alpha.4).
- `queue.lockFile` (défaut `apv/locks/full-suite.lock`) : verrou à bail de la file, relatif au répertoire Git commun (`git rev-parse --git-common-dir`, commun à tous les worktrees du dépôt) ou absolu (partagé par plusieurs dépôts de la machine) ; nom de fichier en `.lock` ([A-Za-z0-9._-]). Format et garanties de `apv lock` ([LOCKS.md](LOCKS.md)) : FIFO, propriétaire vérifié, bail renouvelé, reprise d'un détenteur mort journalisée ; `apv lock status --dir <dossier du fichier>` le montre.
- `queue.waitMs` (défaut 2 h, de 0 à 24 h) : attente maximale de la file (toutes ses places comprises) ; au-delà, refus `SUITE_QUEUE`, les places prises sont rendues, rien n'est exécuté.
- Parts partagées (4.0.0-alpha.4) : les charges lourdes hors suite (`apv suite share`, `apv gates run --stage task` sur pile ou commande ciblée, `apv lock run` d'une pile) prennent une part partagée de cette file (bails `<nom>-share-<id>`) : elles attendent toute suite, et avec `slots: 1` une suite attend la fin des parts en cours.
- `queue.shareMaxMs` (relecture de 1786b40, défaut 2 h, de 1 ms à 24 h) : durée maximale d'une part partagée ; au-delà, son bail n'est plus renouvelé et une suite complète ne l'attend plus (« au-delà de sa durée maximale »), la commande continue.
- `queue.slots` (3.0.0-alpha.20, défaut `1`) : nombre de suites complètes en même temps sur la machine. Chaque suite tient, dans la file, la **place de chaque pile qu'elle utilise** (bail `<nom de la file>-stack-<pile>` à côté de `lockFile`) : deux suites ne partagent jamais une pile, quel que soit le réglage. Les piles utilisées sont celles de `--stacks`, sinon celles que désignent les verrous de ses contrôles. `1` : en plus, la file entière (une seule suite à la fois, comme avant). `"per-stack"` : les places de ses piles seulement, donc une suite par pile en même temps ; une suite qui n'utilise aucune pile déclarée prend la file entière. Un nombre N (2 à 64) : une des N places numérotées (`<nom>-slot-<k>`, la première libre), puis celles de ses piles. Un contrôle dont le verrou n'est celui d'aucune pile déclarée fait prendre la file entière et la place de toutes les piles (l'outil ne sait pas laquelle il utilise). Avant toute autre, une suite tient la place de sa copie (`<nom>-copy-<empreinte du chemin canonique>`) : jamais deux suites dans la même copie, quel que soit le réglage. Les places se prennent toujours dans le même ordre (copie, file entière, place numérotée, piles triées) : deux suites ne s'attendent jamais en cycle. `apv web audit` prend toutes les places (aucune suite ne tourne pendant une mesure), et une suite dont un contrôle lance `apv web audit` les prend toutes pour lui (dans la suite, l'audit n'en prend aucune) ; `apv stacks stop` et `idle-stop` prennent la place de la pile visée sans attendre.
- `queue.maxLoad` (facultatif, nombre de 0,1 à 10000) : une fois le verrou obtenu, la suite attend que la charge moyenne sur 1 minute (`os.loadavg()`) passe sous ce seuil ; repère : le nombre de cœurs, ou un peu moins si des agents travaillent en même temps.
- `queue.loadWaitMs` (défaut 30 min) : attente maximale de la charge ; au-delà, la suite démarre quand même et le note (sortie, `summary.json`).
- `ports` (défaut aucun, 100 au plus, sans doublon) : ports libérés des orphelins de la copie où tourne la suite (processus lancés dans ce worktree lié), jamais d'une autre copie ni du checkout principal ; en pratique les ports de `resources`. Depuis 3.0.0-alpha.20, un port déclaré par une pile (`stacks[].ports`) que la suite n'utilise pas n'est ni vérifié ni libéré : il est à la suite ou à l'agent qui travaille sur cette pile.

La file ne coûte rien à une suite seule ; elle évite qu'une suite complète en rende d'autres instables par la charge (projet pilote, 28 septembre 2026 : quatre chantiers en parallèle, charge jusqu'à 16, six suites rouges sur des tests chaque fois différents).

## Piles de test : `stacks`

Section APV3, facultative, validée par le chargeur commun (3.0.0-alpha.5, spécification section 18.1). Un tableau (10 piles au plus) des piles de test partagées par les copies du dépôt (une pile Supabase locale et ses serveurs de test, par exemple), avec leur verrou, ce qui les désigne et comment les arrêter. Absente : aucune des règles qui en dépendent ne bloque ni n'arrête rien.

```json
{
  "stacks": [
    { "id": "1", "lockFile": "../../pilote/.e2e.lock", "dockerProject": "mon-projet",
      "lockCommand": ["node", "scripts/e2e/lock.mjs"], "env": { "E2E_STACK": "1" },
      "envFile": "../../pilote/supabase-local/.env.local-supabase", "ports": [4173, 4174, 4175],
      "stop": ["npx", "-y", "supabase@2.117.0", "stop", "--workdir", "/chemin/pilote/supabase-local"],
      "start": ["npx", "-y", "supabase@2.117.0", "start", "--workdir", "/chemin/pilote/supabase-local"],
      "idleAfterMs": 1800000 },
    { "id": "2", "lockFile": "../../pilote/.e2e-2.lock", "dockerProject": "mon-projet-2", "env": { "E2E_STACK": "2" } }
  ]
}
```

- `id` (obligatoire, unique) : lettres, chiffres, `.`, `_`, `-`.
- `lockFile` et `resource` (au moins l'un des deux) : le verrou de la pile, `flock` du noyau sur un fichier (relatif au répertoire Git commun, ou absolu, comme `lock.file` d'un contrôle) ou bail de `apv lock`.
- `lockCommand` (facultatif) : commande du projet qui prend elle-même ce verrou puis lance le reste de ses arguments (un script de verrou du projet) ; le crochet Bash la reconnaît comme tenant le verrou, précédée des variables `env` de la pile quand elle en déclare.
- `dockerProject` (facultatif, unique) : nom de projet Docker de ses conteneurs (`<préfixe>_<dockerProject>`, libellé `…=<dockerProject>`, `project_id` de la CLI Supabase) ; le crochet Bash refuse `docker` et `supabase` qui la modifient sans son verrou.
- `env` et `envFile` (facultatifs) : variables qui désignent la pile, et fichier `CLÉ=valeur` à charger (relatif au répertoire Git commun ou absolu ; `export`, guillemets et commentaires admis, aucune expansion) ; un contrôle réparti sur la pile par `apv gates run --stacks` les reçoit, pour les noms de son `passEnv`.
- `ports` (facultatif) : ports de ses serveurs de test ; ce sont aussi des ports de test déclarés pour `apv procs`, et une pile dont un port écoute est occupée pour `apv stacks idle-stop`.
- `stop`, `start` (facultatifs, sans shell, lancés depuis la racine du dépôt, sous le verrou de la pile) : arrêt et redémarrage de la pile par `apv stacks idle-stop` et `apv stacks start` ; `commandTimeoutMs` (défaut 10 min) les borne.
- `fingerprint` (facultatif, 3.0.0-alpha.27, sans shell, lancé depuis la racine de la copie avec `environment.passEnv` et les variables de la pile, borné à 2 min) : commande dont la sortie dit **contre quoi** les contrôles tournent sur cette pile (digests des images Docker, version de la CLI Supabase…). Lancée une fois par exécution pour chaque pile utilisée ; sa sortie entre dans l'identité de reprise (`reuse` plus haut), **comme la commande elle-même**, voir [Commande d'empreinte](#commande-dempreinte-de-pile) plus bas. Depuis 4.0.0-alpha.6, la variable qui désigne la pile (`E2E_STACK`) et ses URL entrent aussi dans l'identité : aucune reprise d'une pile à l'autre, quelle que soit la sortie. Une empreinte en échec ou vide : aucun contrôle de cette pile n'est repris, ni ne le sera de cette exécution. Exemple : `["sh", "-c", "docker image inspect --format '{{.Id}}' public.ecr.aws/supabase/postgres:15.8.1.085 && npx -y supabase@2.117.0 --version"]` ; n'y imprimer que ce qui change le résultat des tests (pas les ports ni les noms de conteneurs).
- `idleAfterMs` (facultatif, d'une minute à 7 jours, défaut 30 min) : inactivité prouvée avant l'arrêt.
- `description` (facultatif).

Refusés : deux piles au même `id`, au même `lockFile`, à la même `resource` ou au même `dockerProject`, une pile sans verrou, un port en double. `normalizeEnv` (4.0.0-alpha.5) est retiré en 4.0.0-alpha.6 (plus de suite de branche à reprendre) : le chargeur le refuse en disant de supprimer la clé. Les piles ne changent pas l'empreinte des contrôles : les reçus restent valides.

### Commande d'empreinte de pile

- **La commande entre dans l'identité** : elle est **la même sur chaque pile**, un seul script du projet qui lit la pile désignée par `E2E_STACK` (ou la variable de son `env`), pas une commande par pile.
- **Elle lit les conteneurs en marche, pas un fichier de configuration** (`config.toml`) : une pile démarrée depuis une autre copie tourne avec d'autres réglages que son fichier (variables qui priment, fichiers montés d'ailleurs). Par service : l'identifiant de l'image, l'empreinte de ses variables, de sa commande de lancement et du contenu des fichiers montés depuis l'hôte, où le nom de projet et les ports de la pile sont remplacés par leur rôle (ce qui dit seulement **où** elle est ne change pas l'empreinte). Pile inconnue ou aucun conteneur en marche : sortie en erreur, donc aucune reprise.

```js
// scripts/stack-fingerprint.mjs, lancé avec E2E_STACK=<n> : une ligne par service de la pile, rien de ce qui dit où elle est.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { STACKS } from './stacks.mjs';                     // le registre des piles du projet
const sha = text => createHash('sha256').update(text).digest('hex');
const stack = STACKS[process.env.E2E_STACK];            // { projectId, ports: { db: 54322, api: 54321 } }
if (!stack) { console.error('pile inconnue'); process.exit(1); }
const neutral = text => Object.entries(stack.ports).reduce((t, [role, port]) => t.replaceAll(String(port), `{{${role}}}`), text.replaceAll(stack.projectId, '{{projet}}'));
const names = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).split('\n').filter(n => n.endsWith(`_${stack.projectId}`));
if (!names.length) { console.error('aucun conteneur de la pile en marche'); process.exit(1); }
for (const name of names.sort()) {
  const [c] = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }));
  const env = (c.Config.Env ?? []).map(neutral).sort().join('\n');
  const cmd = neutral(JSON.stringify([c.Config.Entrypoint, c.Config.Cmd]));
  const mounts = (c.Mounts ?? []).map(m => `${m.Destination} ${m.Type}`).sort().join('\n'); // + sha256 du contenu des fichiers montés depuis l'hôte
  console.log(neutral(name), c.Image, sha(env), sha(cmd), sha(mounts));
}
```

## Lot et copies : `batch`

Section APV3, facultative (3.0.0-alpha.5, spécification sections 18.5 et 18.6) : la préparation d'une copie neuve du dépôt avant qu'une suite complète y tourne, celle d'un lot de `apv stack batch` et celles des piles suivantes de `apv gates run --stacks`. Depuis 3.0.0-alpha.20, aussi la copie où tourne la suite complète elle-même, quand elle a un `package-lock.json` sans `node_modules` (un worktree neuf) : `setup` y est lancé sous la place de la copie dans la file, après tout refus (une suite refusée n'a rien lancé) ; un échec, ou des fichiers non ignorés écrits par la préparation, refusent la suite (`GATE_SETUP`, rien n'est exécuté) ; jamais dans le checkout principal (refus `GATE_SETUP`) ; la sortie recopiée est masquée (secrets de l'environnement) ; sans `setup`, la suite le signale (« copie de la suite non préparée ») et continue.

```json
{ "batch": { "setup": ["npm", "ci", "--no-audit", "--no-fund"], "setupTimeoutMs": 900000, "passEnv": ["npm_config_cache"] } }
```

- `setup` (facultatif, sans shell, lancé à la racine de la copie) : typiquement l'installation des dépendances. Elle reçoit `environment.passEnv`, `HOME` et `passEnv`. Après elle, la copie doit être propre (fichiers créés ignorés par Git), sinon la copie est refusée. Depuis 3.0.0-alpha.26, une copie de pile n'est créée et préparée que si un contrôle y est réparti ; la copie d'un lot (`apv stack batch`) est préparée **avant** toute décision de reprise, même quand tous ses contrôles sont ensuite repris d'un arbre identique (relecture sécurité de A1, M2) : l'état local comparé à celui de l'origine (`node_modules`, `.env*`, champ `reuse` ci-dessus) est celui de la copie préparée, jamais celui d'une copie vide. Cette préparation précède la file des suites et les refus de la suite.
- `setupTimeoutMs` (défaut 15 min, jusqu'à 1 h).
- Absente : rien n'est préparé (projet sans dépendances à installer).
- Le dépôt d'APV la déclare depuis 3.0.0-alpha.21 (`["npm", "ci", "--no-audit", "--no-fund"]`) : le 9 octobre 2026, ses lots tournaient sans `node_modules` et le contrôle `typecheck` y échouait. Un projet Node qui lance `apv stack batch` ou des suites dans des worktrees neufs la déclare de même.

## Pile de PR : `stack`

Section APV3, facultative : les branches que `apv stack merge` et `apv stack batch --merge` ne suppriment jamais après une fusion ([CLI.md](CLI.md#apv-stack)), en plus des règles de l'outil (branche cible ou par défaut, protégée, fork, base ou tête d'une PR ouverte, déjà base d'une PR, tête déplacée).

```json
{ "stack": { "keepBranches": ["develop", "release/*", "env/**"] } }
```

- `keepBranches` : motifs de noms de branches (`*` à l'intérieur d'un segment, `**` à travers les `/`, `?`, `{a,b}`), 100 au plus. Absente : `develop`, `development`, `release/*`, `releases/*`, `staging`, `hotfix/*`. `[]` : aucune branche gardée par son nom (les autres règles restent).
- La configuration lue est celle du dépôt où la commande est lancée ; illisible, toutes les branches fusionnées sont gardées (avec la raison).

## Maquettes validées : `design`

Section facultative : `{ "design": { "dir": "docs/design" } }`, le dossier des maquettes validées ([DESIGN.md](DESIGN.md), [CLI.md](CLI.md#apv-design)), relatif, dans le dépôt, sans espace ; absente : `docs/design`. Une maquette validée est figée par son empreinte sha256 : ses espaces de fin de ligne ne peuvent pas être nettoyés sans changer l'empreinte, et `git diff --check` (contrôle `diff-check`, CI des projets) échouerait sur elle. `apv design register`, et `apv init` ou `apv onboard` quand le dossier est déclaré ou existe, ajoutent donc à `.gitattributes` la ligne `<dir>/**/*.html -whitespace` (racine et sous-dossiers des groupes) si Git ne l'applique pas déjà ; l'ancienne ligne `<dir>/*.html -whitespace` reste acceptée sans groupes et, avec des groupes (`design.groups`, `design.defaultGroup`, rangement par sous-dossier, [DESIGN.md](DESIGN.md#6-configuration)), est remplacée à sa place ; `apv design check` signale son absence (sortie `1` si une maquette validée porte des espaces de fin de ligne). Un dossier changé après coup (nouveau `design.dir`) : relancer `apv design register` ou `apv init`, puis commiter `.gitattributes`.

## Qualité web : `web`

Section APV3, facultative, validée par le chargeur commun (3.0.0-alpha.7, spécification section 20) : les pages publiques d'un projet web et la façon de les mesurer avec `apv web audit` ([CLI.md](CLI.md#apv-web-audit)). Absente : `apv web audit` refuse (`WEB_NONE`), rien d'autre ne change. Générique : chaque valeur est celle du projet, les défauts sont ambitieux et sans stack.

```json
{
  "web": {
    "pages": ["/", "/faq", "/connexion", "/confidentialite"],
    "productionUrl": "https://www.exemple.fr",
    "lighthouse": "13.5.0",
    "runs": 3,
    "formFactors": ["mobile", "desktop"],
    "thresholds": {
      "categories": { "performance": 90, "accessibility": 100, "best-practices": 100, "seo": 100, "agentic-browsing": 100 },
      "metrics": { "lcp": 2500, "cls": 0.1, "tbt": 200, "fcp": null, "si": null }
    },
    "checks": { "llmsTxt": "warn" },
    "neutralPaths": ["tests/**", "e2e/**", ".github/**", "*.md", "docs/**"]
  }
}
```

- `pages` (obligatoire, 1 à 100, sans doublon) : chemins absolus du site, requête permise, jamais d'origine ni de fragment (`/`, `/faq`, `/tarifs?plan=pro`). Chaque page est auditée sur l'origine choisie (`--url`, `--production`, `--preview`). Une page publique seulement : une page qui exige une connexion redirige, et la mesure est refusée.
- `productionUrl` (facultatif) : origine de production (`https://hôte`, sans chemin), pour `apv web audit --production` après un déploiement.
- `lighthouse` (défaut `13.5.0`) : version exacte de Lighthouse ; la dépendance du projet si elle a exactement cette version, sinon `npx -y lighthouse@<version>`. Un rapport d'une autre version est une mesure invalide. Changer de version change les scores : c'est une décision, notée au registre.
- `chrome` (facultatif) : binaire Chrome ou Chromium (relatif au dépôt, `~/`, ou absolu) ; absent : `CHROME_PATH`, le Chromium de Playwright, puis le système. `chromeFlags` (défaut `["--headless=new"]`, options `--nom[=valeur]` sans espace ; refusées : celles qui lancent un autre programme, ouvrent le navigateur au réseau, chargent du code ou détournent le trafic : `--renderer-cmd-prefix`, `--utility-cmd-prefix`, `--gpu-launcher`, `--browser-subprocess-path`, `--remote-debugging-address`, `--remote-debugging-port`, `--remote-allow-origins`, `--load-extension`, `--user-data-dir`, `--proxy-server`, `--host-resolver-rules`...) ; `locale` (défaut `fr`) : langue des textes Lighthouse.
- `runs` (défaut 3, de 1 à 15) : passages valides par page et appareil, dont la médiane est gardée ; 3 est le minimum qui écarte un passage atypique, 5 resserre la médiane d'une page instable.
- `formFactors` (défaut `["mobile", "desktop"]`) et `categories` (défaut les cinq : `performance`, `accessibility`, `best-practices`, `seo`, `agentic-browsing`) : catégories jugées ; la performance est toujours mesurée (statut du document, métriques).
- `thresholds.categories` : score minimum sur 100 par catégorie (défauts 90, 100, 100, 100, 100 ; une catégorie omise garde son défaut). `thresholds.metrics` : maximum par métrique, en millisecondes (`cls` sans unité) : `lcp` 2500, `tbt` 200, `cls` 0,1 par défaut, `fcp` et `si` sans seuil (`null`) ; `null` retire un seuil (la métrique reste mesurée et affichée). Mêmes seuils en mobile et en bureau. Un seuil ne se baisse que sur décision de l'opérateur, notée au registre.
- `timeoutMs` (défaut 180000) : durée maximale d'un passage Lighthouse.
- `load.max` (facultatif, de 0,1 à 10000) : charge moyenne sur 1 minute au-dessus de laquelle aucun passage ne démarre ; absent : `suite.queue.maxLoad`, sinon la moitié des processeurs. `load.waitMs` (défaut 30 min) : temps total passé à attendre la charge (la mesure elle-même ne le consomme pas) ; au-delà, refus `WEB_LOAD`, les mesures déjà faites gardées (jamais une mesure « quand même »).
- `queue` (défaut `true`) : la mesure prend la file des suites complètes (`suite.queue`), avant le verrou et la construction de l'aperçu, pour qu'aucune suite ne tourne pendant qu'elle mesure ; déjà tenue quand l'audit tourne dans une suite complète (`APV_SUITE_RUN`).
- `reportsDir` (défaut `.apv/web`) : dossier des rapports, relatif, dans le dépôt, sans segment `.` ni `..`, et sans aucun fichier suivi par Git (sinon refus `WEB_REPORTS`) : il porte son propre `.gitignore` ; `keepAudits` (défaut 10) : audits gardés, la rétention ne retirant que des dossiers au nom d'un audit.
- `checks` : un mode par contrôle de préparation à la recherche et aux IA, `refuse` (sortie `1`), `warn` ou `off` : `status`, `robots`, `sitemap`, `canonical`, `title`, `description`, `lang`, `jsonLd`, `hreflang` (`refuse` par défaut), `llmsTxt` (`off` par défaut : `llms.txt` est une proposition, pas un standard ; `warn` ou `refuse` quand le projet en publie un). Détail de chaque contrôle : [CLI.md](CLI.md#apv-web-audit).
- `robotsAgents` (défaut `*`, `Googlebot`, `Bingbot`, `OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`) : robots de moteurs et de recherche des IA auxquels robots.txt doit laisser chaque page ouverte. Les robots d'entraînement (`GPTBot`, `ClaudeBot`, `Google-Extended`...) sont le choix de l'éditeur : ajoutez-les ici seulement si le projet veut les accueillir.
- `neutralPaths` (défaut `["tests/**", "e2e/**", ".github/**", "*.md", "docs/**"]`, motifs portables `*`, `**`, `?`) : fichiers **sans effet web** ; avec `apv web audit --preview --base <ref>`, l'audit est requis dès qu'un fichier changé est hors de cette liste, et « non requis » seulement quand tous le sont. Prudence d'abord : une liste courte oublie un test, jamais un serveur (`hooks.server.ts`, `+page.ts`, `+layout.ts`, `+server.ts`, `src/lib/**`, `svelte.config.js`, `vite.config.ts` comptent tous par défaut). Le Markdown n'est neutre qu'à la racine (`README.md`, `CHANGELOG.md`) : un site en Markdown (mdsvex, Astro, VitePress) a ses pages sous `src/` ou `content/`.
- Toujours web, même dans `neutralPaths`, sans rien déclarer : `.apv/config.json`, tout `package.json`, les fichiers de verrouillage, les contenus `.md`, `.mdx`, `.svx` et `.html` sous un dossier `src/`, `content/`, `static/` ou `public/` (à toute profondeur, monorepo compris), et `docs/**/*.html` (site publié depuis `docs/`, GitHub Pages). Un site dont les pages Markdown sont servies depuis `docs/` (VitePress, Jekyll) retire `docs/**` de `neutralPaths` ou l'ajoute à `paths`.
- `paths` (défaut aucun) : fichiers qui comptent **toujours** comme web, même dans `neutralPaths` (par exemple `docs/**` pour une documentation publiée) ; un ajout, jamais une restriction.

Contrôle d'une PR, dans `gates` (« non requis » quand elle ne change que des fichiers de `neutralPaths`, recalculé par `apv gates verify`) : `{ "id": "web", "stage": "full", "command": ["apv", "web", "audit", "--preview", "--base", "origin/main"], "timeoutMs": 2400000, "passEnv": ["HOME", "CHROME_PATH"] }` (compter environ 15 s par passage : 7 pages, 2 appareils et 3 passages font 42 passages, une dizaine de minutes, plus la construction de l'aperçu). Il exige une section `preview` ([PREVIEW.md](PREVIEW.md)) dont le port est libre dans la copie de la suite. Après un déploiement : `apv web audit --production`. Sur la branche principale elle-même, `--preview --base origin/main` n'a rien à comparer (sortie `2`) : y utiliser `apv web audit --production` ou `--url <origine>`.

## Réutilisation : `reuse` et carte du code : `map`

Sections APV3, facultatives, lues par `apv reuse check` et `apv map` et validées par le chargeur commun (`apv status` signale une valeur invalide, jamais la section comme ignorée). Absentes, les valeurs par défaut s'appliquent : dossiers partagés `**/components/**`, `**/ui/**`, `**/shared/**`, `**/common/**` ; éléments réservés `select`, `dialog`, `datalist` ; feuille globale cherchée parmi les emplacements usuels ; blocs de 5 lignes et 50 jetons ; aucune langue, donc pas de règle typographique ; aucune référence, donc tout compte comme nouveau. Écrites par `apv init` et `apv onboard` pour un projet web.

```json
{
  "gates": [
    { "id": "reuse", "command": ["apv", "reuse", "check", "--base", "{{baseSha}}"], "covers": ["architecture"], "stage": "task", "readOnly": true, "mandatory": true },
    { "id": "code-map", "command": ["apv", "map", "--check"], "covers": ["architecture"], "stage": "task", "readOnly": true, "mandatory": true }
  ],
  "reuse": {
    "reference": "origin/main",
    "shared": ["src/lib/components/**"],
    "native": { "elements": { "select": "src/lib/components/ui/Select.svelte", "dialog": null, "datalist": null }, "allowedPaths": ["src/lib/components/ui/**"] },
    "styles": { "sources": ["src/app.css"], "allowedPaths": ["src/lib/components/ui/**"], "nested": "layout" },
    "duplicates": { "minLines": 5, "minTokens": 50, "styles": "warning" },
    "typography": { "locale": "fr" },
    "severity": { "native": "error", "styles": "error", "duplicates": "error", "names": "warning", "typography": "warning" }
  },
  "map": { "file": ".apv/code-map.md", "maxEntries": 400, "maxBytes": 32768 }
}
```

- `reuse.reference` : branche où vont les PR, pour `apv reuse check` sans `--base` ; ce que le changement ajoute depuis sa base commune est nouveau (bloquant en `error`), le reste existant (signalé). Le contrôle déclaré passe `--base {{baseSha}}`, la base du passage, qui entre dans la clé de preuve.
- `reuse.shared`, `reuse.ignore` : motifs des dossiers de composants partagés, et des chemins laissés de côté par toutes les règles (listés dans le rapport). Les exclusions par défaut (dépendances, dossiers d'outils connus, `docs/`, `dist/`, `build/`, `coverage/`, `vendor/` à la racine du dépôt et des paquets) ne valent que pour les fichiers déjà là à la base : un fichier que le changement crée ou déplace dans l'une d'elles bloque tant qu'il n'est pas déclaré dans `reuse.ignore` (échec fermé, [REUSE.md](REUSE.md), section 2.8).
- `reuse.generated` : motifs des fichiers écrits par un outil, acceptés comme générés même quand le changement les crée ; sans cela, un fichier généré nouveau (par son nom ou sa mention en tête) est un constat bloquant.
- `reuse.native` : `elements` (sélecteur `select` ou `input[type=date]`, vers le composant partagé qui le remplace, ou `null` : le composant générique de même rôle), `allowedPaths` (défaut : les composants génériques, `**/components/ui/**`, `**/ui/**`, `**/primitives/**`, `**/design-system/**`, `**/shared/**`, `**/common/**`).
- `reuse.styles` : `sources` (feuilles globales dont les classes de base des règles de premier niveau sont les primitives), `selectors` et `except` (classes ou préfixes `.btn--*` ajoutés ou retirés), `allowedPaths` (défaut : comme `native.allowedPaths`), `nested` (`layout` par défaut : sous une classe du composant, seule la mise en page d'une primitive se retouche ; `refuse` ; `allow`).
- `reuse.duplicates` : `minLines`, `minTokens`, `paths`, `ignore`, `styles` (gravité d'une copie de styles seuls, `warning` par défaut).
- Fichiers générés (nom ou premières lignes) : toujours laissés de côté, listés dans le rapport.
- `reuse.names.roles` : familles de rôles ajoutées ou retirées (`null`) ; `names.strong` (familles dont le composant partagé générique ne se refait jamais dans la même famille exacte, sans le composer : coquille, barres, toast, liste déroulante, dialogue, sélecteur de date, pagination, onglets, icône) et `names.strongSeverity` (`error` par défaut).
- `reuse.typography.locale` : langue des textes (`fr` active la règle).
- `reuse.severity` : `off`, `warning` ou `error`, pour toutes les règles ou par règle.
- `map.file` (`.md`), `map.ignore`, `map.maxEntries` (de 20 à 5000, partagées entre les sections de la carte), `map.maxBytes` (de 4096 à 1 000 000, 32 768 par défaut).

Chaque règle, son motif et ses limites : [REUSE.md](REUSE.md). Baisser une gravité, élargir `ignore` ou `allowedPaths`, ou retirer un de ces contrôles est une décision de l'opérateur, jamais un moyen de faire passer une tâche.

## Tests modifiés : `testsCheck`

Section facultative (3.0.0-alpha.15) de `apv tests check` ([CLI.md](CLI.md#apv-tests-check)), déclaré comme contrôle de tâche :

```json
"gates": [{ "id": "tests", "command": ["apv", "tests", "check", "--base", "{{baseSha}}"] }],
"testsCheck": {
  "e2e": ["e2e/**", "tests/browser/**"],
  "unit": ["src/**/*.test.ts"],
  "ignore": ["tests/vendor/**"],
  "severity": { "waitForTimeout": "error", "fixedWait": "error", "realClock": "warning", "sharedData": "off" }
}
```

- `enabled` : `false` désactive le contrôle (il passe et le dit) ; absent : actif.
- `reference` : la branche visée (`origin/main`), quand `--base` n'est pas donné.
- `e2e`, `unit`, `ignore` : motifs portables ; une clé donnée remplace sa liste par défaut.
- `severity` : `off`, `warning` ou `error` par règle ; défauts : `waitForTimeout` en erreur, `fixedWait`, `realClock` et `sharedData` en avertissement. Seule une erreur fait échouer le contrôle.

## Règles avant fusion : `rules`

Section APV3, facultative (3.0.0-alpha.12), lue **à la base commune** de la PR et de sa cible par `apv rules check`, `apv stack merge` et `apv stack batch --merge` ([REGLES.md](REGLES.md)). Elle complète les règles, elle ne peut en retirer aucune : il n'existe pas de clé pour les désactiver (`docsOnly` ne fait que réduire ou couper la voie sans code).

```json
"rules": {
  "mode": "leger",
  "captures": { "viewports": ["desktop", "phone"], "themes": ["light", "dark"] },
  "requiredGates": [{ "id": "a11y", "command": ["npm", "run", "check:a11y"] }],
  "screens": ["src/views/**/*.vue"],
  "docsOnly": { "enabled": true, "kinds": ["decisions", "mockups", "drafts", "specs", "journal", "docs"], "exclude": ["docs/legal/**"] }
}
```

- `mode` (4.0.0-alpha.1, défaut `leger`) : `leger` n'exige que les relectures du niveau du diff (`apv review plan` : 0 et 1 aucune, 2 `securite`, 3 `securite` avec `donnees` ou `rgpd` ; `fidelite` seulement pour un écran couvert par une maquette validée), accepte une relecture non scellée, reporte une relecture de tout domaine sur un delta hors de son périmètre, n'exige `captures` qu'avec `fidelite` et `maquette` que dans un projet qui a des maquettes validées (une maquette versée suffit) ; `strict` garde le comportement d'APV3. `preuve`, `instable`, `controles` et les dérogations ne changent pas.
- `captures.viewports` (`desktop`, `phone`, `tablet` ; défaut `desktop` et `phone`) et `captures.themes` (`light`, `dark` ; défaut les deux) : captures qu'exige la relecture de fidélité quand le plan des revues la retient, sauf dans un projet sans écran qui n'en ajoute pas (règle `captures`, REGLES.md). `["light"]` seulement pour un projet sans thème sombre.
- `requiredGates` : contrôles qu'un projet exige en plus de `reuse`, `code-map` et `structure` (projet web) : un identifiant et le début de la commande, reconnue enveloppée ou non (`node <plugin>/dist/cli.js`, `npx apv`) ; ils valent aussi pour un projet sans interface web.
- `screens` : motifs des fichiers d'écran que l'outil ne reconnaît pas seul (il connaît les pages, mises en page et pages d'erreur de SvelteKit, Next, Remix, Nuxt, Astro et `pages/`).
- `docsOnly` : la **voie sans code** ([REGLES.md](REGLES.md), « Voie sans code »), active par défaut avec toutes ses sortes. Elle ne peut que se réduire : `enabled: false` la coupe (toute PR suit les règles normales), `kinds` garde seulement certaines sortes (`decisions`, `mockups`, `drafts`, `specs`, `journal`, `docs` ; `.apv/state/**` n'en est pas une depuis la relecture de sécurité de la PR #121), `exclude` (motifs relatifs, comparés sans tenir compte de la casse) en retire des chemins : un projet y met les documents que ses agents lisent comme consigne sans les importer par `@chemin` (un fichier cité en clair par `CLAUDE.md` ou une compétence n'est pas détecté par l'outil ; au projet pilote, `docs/architecture.md` ; le dépôt d'APV : `docs/**`, `README.md`, `examples/**`). Aucune clé n'ajoute un chemin à la voie. Lue à la base commune par `apv rules check` et les commandes `stack` ; `apv review plan` la lit dans le dépôt, comme le reste de sa configuration.
- `operatorOrders` : la **fusion sur ordre signé de l'opérateur** ([REGLES.md](REGLES.md), section 3 ter), lue à la base par `apv stack merge --order`, affichée par `apv status`. `domain` : domaine des messages signés du projet (minuscules, chiffres, tirets) ; `publicKeys` : une ou deux clés publiques Ed25519 (PEM SPKI ou sa ligne base64), jamais une clé privée (refusée par le chargeur, jamais recopiée dans l'erreur) ; `attestation.url` : adresse de la production avec `{nonce}` et `{challenge}` une fois chacun, en HTTPS seulement, sans exception ni identifiant ; `publicationBranch` (facultatif) : branche dont doit venir la PR de publication, `{slug}` remplacé par le `slug` signé dans l'ordre (`publication/{slug}`) ; `attestation.maxAgeSeconds` (10 à 600, défaut 120) et `attestation.timeoutMs` (défaut 15 000) ; `paths.publication` et `paths.article` (obligatoires pour toute fusion sur ordre) : motifs des chemins que chaque PR d'un ordre peut changer (chemins littéraux, `*` et `?` dans un seul segment, `{slug}` remplacé par le slug signé ; `**` refusé), jamais un motif qui couvre la liste de refus fixe d'APV (REGLES.md, section 3 ter : configuration d'APV, des agents, de la CI, de Git, de l'éditeur, paquets et leur configuration, déploiement, environnement, configuration de la pile) ; `verify.publication` : commande du projet, sans shell, `{{trusted}}` (base de confiance : le projet y lit ses clés), `{{base}}` (base de la fusion vérifiée), `{{head}}`, `{{step}}` remplacés comme arguments entiers (`{{base}}` sans `{{trusted}}` refusé), lancée depuis une copie propre de la base de confiance du lancement (la cible avant toute fusion sur cet ordre, jamais un commit d'une PR), l'ordre vérifié sur son entrée ; `verify.timeoutMs` (défaut 900 000).

```json
"operatorOrders": {
  "domain": "mon-projet",
  "publicKeys": ["-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----\n"],
  "attestation": { "url": "https://exemple.fr/api/articles/attestation?nonce={nonce}&challenge={challenge}", "maxAgeSeconds": 120 },
  "publicationBranch": "publication/{slug}",
  "paths": { "publication": ["src/lib/server/guides/content/{slug}.ts", "src/lib/server/guides/catalog.ts"], "article": ["docs/articles/{slug}/proposition.json"] },
  "verify": { "publication": ["npm", "run", "article:order", "--", "publication", "--base", "{{trusted}}", "--tete", "{{head}}", "--etape", "{{step}}"] }
}
```

- `operatorOrders.reducedProof` (facultatif) : la **preuve réduite** ([PREUVE-REDUITE.md](PREUVE-REDUITE.md)), acceptée à la place de la suite complète par `apv stack merge --order` seulement, quand le diff de l'étape tient dans sa liste de contenu régénéré. `workflow` (sous `.github/workflows/`), `job` et `name` du check run, chacun différent de ceux de `rules.ciProof` ; `gates` : contrôles que le job lance en entier (le check run en tient lieu de reçu) ; `waives` : contrôles de la suite complète que la voie ne lance pas, jamais un contrôle exigé par APV (`reuse`, `code-map`, `structure`, ceux de `rules.requiredGates`), reconnu par son identifiant ou par sa commande ; `gates` et `waives` disjoints et déclarés dans `gates` de la configuration ; `covers` : phrase de ce que le job prouve en plus, recopiée dans la sortie ; `paths.publication` et `paths.article` (une étape au moins) : chemins littéraux recopiés de `rules.operatorOrders.paths` de la même étape, sans `*`, `?` ni `**`, `{slug}` seul remplacé ; `protectedPaths` : fichiers qui produisent la preuve réduite, ajoutés aux défauts de la preuve CI, jamais un chemin de contenu ; `artifact` : pour la mesure. **C'est la seule déclaration de `rules` qui retire des contrôles** : la PR qui l'ajoute ou l'élargit (workflow, job ou nom changé, contrôle de `gates` ou de `waives` ajouté, chemin ajouté, chemin protégé retiré) n'est acceptée par `apv rules check` qu'avec une décision de l'opérateur ancrée dont la citation porte l'empreinte de la déclaration ([REGLES.md](REGLES.md), section 5). La commande `verify.publication` du projet rend, en cas de succès, sur sa dernière ligne `{"ok": true, "regenerated": [{"path": "...", "blob": "..."}], "shape": "literal"}` : sans elle, la voie réduite n'est pas retenue à l'étape publication (la fusion sur ordre reste possible avec la suite complète).

```json
"reducedProof": {
  "workflow": ".github/workflows/preuve-publication.yml", "job": "preuve-publication", "name": "Preuve de publication",
  "gates": ["check", "lint", "test", "build"], "waives": ["integration", "browser"],
  "covers": "typecheck, lint, tests unitaires, build, tests de bout en bout des guides contre un aperçu du commit, captures du guide",
  "paths": { "publication": ["src/lib/server/guides/content/{slug}.ts", "src/lib/server/guides/catalog.ts"], "article": ["docs/articles/{slug}/proposition.json"] },
  "protectedPaths": ["tests/e2e/browser/guides.e2e.ts"]
}
```

## Mise en ligne : `release`

Section APV4 facultative (4.0.0-alpha.2) : `{ "release": { "branch": "production", "from": "main" } }`, deux noms de branche différents. En mode léger, une PR vers `from` se fusionne sur la preuve de tâche (section lue à la base commune, comme `rules`), seulement si la base déclare au moins un contrôle de stage `task` (sinon la suite complète, dit en une ligne) ; `branch` n'avance que par `apv release`, en avance rapide, vers un commit de `from` dont la suite complète est prouvée ([CLI.md](CLI.md#apv-release)). Le garde-fou refuse tout `git push` qui l'écrit (configuration illisible : `production`). Absente : rien ne change, la suite complète reste exigée avant chaque fusion.

`release.migrations` (4.0.0-alpha.3, facultatif) : motifs de chemins des fichiers de migration (`*` dans un segment, `**` à travers les `/`, `?`, `{a,b}` ; 100 au plus), lus sur `from`, réunis avec ceux de la production et du commit publié (un commit qui les vide n'en retire aucun) ; `./` en tête ignoré.
- Chaque migration **ajoutée** depuis la production distante attend « migration <version> appliquée » tapé par l'opérateur dans une session Claude Code (journal de l'opérateur, comme les dérogations) : sans elle, rien n'est publié ([CLI.md](CLI.md#apv-release)).
- Une migration **modifiée**, supprimée ou renommée depuis la production, ou en lien symbolique, est refusée : une migration publiée ne change pas.
- Aucune valeur implicite. Suggestion pour Supabase : `{ "release": { "branch": "production", "from": "main", "migrations": ["supabase/migrations/*.sql"] } }`, les motifs de `db.migrations` (`apv db check`).
- Absente ou `[]` : aucune vérification des migrations à la mise en ligne.
- Le journal est celui du dépôt Git (dossier commun) : le cron `apv release auto` doit tourner dans le même dépôt que les sessions de l'opérateur.

## Fraîcheur de l'état : `freshness`

Section APV3, facultative, validée par le chargeur commun : les fichiers vivants d'état et de reprise que `apv status` (section « Fichiers d'état périmés », `freshness` en JSON) et le crochet de début de session surveillent. Un état de reprise se réécrit court à chaque étape et ce qui est terminé part en archive : un fichier qui n'a pas bougé depuis plus de `maxAgeDays` jours, ou un journal qui dépasse `maxLines` lignes, est signalé avec la proposition « couper : état court + archive ». Lecture seule : rien n'est déplacé ni supprimé.

```json
{
  "freshness": {
    "maxAgeDays": 2,
    "maxLines": 300,
    "paths": ["~/projets/mon-pilotage/lancement/REPRISE.md", "docs/etat/*.md"],
    "ignore": [".apv/state/revues-*.md"],
    "archive": "~/projets/mon-pilotage/archives"
  }
}
```

- Toujours surveillés, sans rien déclarer : `.apv/state/resume.md` et les `.apv/state/*.md` (premier niveau seulement : `.apv/state/archive/` et les autres sous-dossiers ne le sont pas), sauf `.apv/state/suivi-constats.md`, le suivi groupé des constats mineurs, traité par lot. Les journaux machine (`quota.log`, `journal.log`, états `run-*.json`) ne le sont pas. Les rapports de revue et de corrections (`revues-*.md`, `corrections-*.md`) le sont : une fois leur PR fusionnée, ils partent dans le dossier d'archive.
- `maxAgeDays` (défaut 2, de 1 à 365) : au-delà, le fichier est « périmé » (date de dernière modification).
- `maxLines` (défaut 300, de 10 à 1 000 000) : au-delà, le fichier est « trop long ». Le compte s'arrête à `maxLines` + 1 lignes, et un fichier de plus de `maxLines` × 4 Kio est « trop long » d'après sa taille, sans être lu : un journal énorme ne ralentit ni `apv status` ni le début de session.
- `paths` (défaut aucun, 100 au plus) : **fichiers de pilotage** du projet (notes de reprise, plans, journaux de lancement), jamais un dossier de documents personnels ou de clients : leurs noms sont affichés (voir plus bas). Motifs portables (`*`, `**`, `?` ; ni accolades ni `!`, aucun segment `.` ou `..`), relatifs au dépôt, sous le dossier personnel avec `~/` (y compris hors du dépôt), ou absolus. Un fichier ou un dossier absent est ignoré. Un motif lit les entrées de dossier une à une, 5 000 au plus, et garde 200 fichiers ; `node_modules` et `.git` ne sont jamais parcourus, un lien vers un dossier jamais suivi.
- `ignore` (défaut aucun) : motifs de la même forme, retirés de la surveillance.
- `archive` (défaut `.apv/state/archive`) : dossier d'archive cité dans les messages (chemin sans joker, même forme) ; les fichiers qui s'y trouvent ne sont jamais signalés.
- Liens : un lien n'est suivi que si sa cible réelle reste dans le dossier de son motif (la partie avant le premier joker, ou le dossier du fichier nommé), et dans le dépôt pour les motifs par défaut ; `.apv/state/notes.md` lié à `~/.ssh/id_rsa` est ignoré.
- Secrets : seules la date, la taille et le nombre de lignes d'un fichier sont lus, jamais son contenu au-delà du comptage des fins de ligne. Un chemin qui ressemble à un secret, jugé sur son nom **et** sur sa cible réelle, n'est jamais ouvert : seule sa date est lue (`lines` à `null`, `secret` à `true`). Sont des secrets : les noms `.env*`, `id_*` (clés SSH), `*key*`, `*secret*`, `*token*`, `*credential*`, `*password*`, `*passwd*`, `.npmrc`, `.netrc`, `.pgpass`, `.git-credentials`, `hosts.yml`, `.pypirc`, `.htpasswd`, les extensions `.pem`, `.p12`, `.pfx`, `.kdbx`, `.keystore`, `.jks`, `.asc`, `.gpg`, et tout ce qui est sous un dossier `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker` ou `.password-store`.
- Noms affichés : `apv status` affiche le chemin de chaque fichier signalé (dans le terminal de l'opérateur, et dans sa sortie JSON). Le crochet de début de session verse la ligne « Fichiers d'état à rafraîchir » au **contexte de chaque session** : il y nomme les fichiers du dépôt (8 au plus) et ne donne, pour les fichiers hors du dépôt, que leur nombre.
- Configuration invalide : refusée par le chargeur ; `apv status` et le crochet surveillent alors les fichiers par défaut avec les seuils par défaut.

## Modèles par rôle : `models`

Section APV3, facultative (3.0.0-alpha.22), validée par le chargeur commun. Elle dit quel modèle et quel effort chaque rôle reçoit ; `apv status` l'affiche (ligne « Modèles par rôle », champ `models` en JSON). L'outil ne lance aucun agent : le chef de projet passe `model` à l'outil Agent d'après cette section quand il lance un rôle, c'est un jugement qu'il porte dans son rapport ([REGLES.md](REGLES.md), section 4).

```json
{
  "models": {
    "chef": "fable",
    "conception": "opus",
    "implementer": "sonnet",
    "fondations": "opus",
    "integrateur": "opus",
    "relecture": "sonnet",
    "relecture-securite-regles": "opus",
    "recherche": "haiku",
    "effort": "high"
  }
}
```

- Valeurs : `fable`, `opus`, `sonnet` ou `haiku` ; `effort` : `high` ou `xhigh` (élevé au minimum, règle de l'opérateur : `low` et `medium` sont refusés). Une autre valeur est refusée par le chargeur, avec la clé en cause.
- Clés (liste fermée, une autre est refusée) : les rôles du plugin (`chef`, `product`, `architecte`, `architecte-donnees`, `designer`, `critique-design`, `dpo`, `implementer`, `fondations`, `integrateur`, `qa-securite`, `qa-fidelite`, `auditeur-web`, `relecture`, `recherche`) et les trois groupes des défauts : `conception` (`product`, `architecte`, `architecte-donnees`, `designer`, `critique-design`), `relecture` (`qa-fidelite`, `auditeur-web` et toute relecture sans clé propre) et `relecture-securite-regles` (`qa-securite`, `dpo`). La clé d'un rôle l'emporte sur celle de son groupe. `fondations` désigne la tâche de fondations d'une spec, confiée à un `implementer`.
- **Nouveau projet** (décision de l'opérateur du 14 octobre 2026, économie de jetons) : `apv init` écrit la section suivante dans la configuration qu'il crée. Sonnet partout, Opus seulement pour `architecte-donnees` et la clé de groupe `relecture-securite-regles`, Haiku pour la recherche ; `dpo` et `qa-securite` sont mis à Sonnet par leur clé propre, qui l'emporte sur celle du groupe. Une configuration existante n'est jamais modifiée, et un projet sans section garde les défauts ci-dessous. Le chef de projet ne passe une tâche en Opus que si une première passe Sonnet a échoué sur la difficulté, et un designer en Opus que pour une nouvelle direction visuelle (compétence `chef-de-projet`, section 5 ter).

  ```json
  { "models": { "chef": "fable", "conception": "sonnet", "architecte-donnees": "opus", "implementer": "sonnet", "fondations": "sonnet", "integrateur": "sonnet", "relecture": "sonnet", "relecture-securite-regles": "opus", "dpo": "sonnet", "qa-securite": "sonnet", "recherche": "haiku", "effort": "high" } }
  ```
- **Effort par lancement** : le champ `effort` reste le défaut (`high`). Le chef de projet l'ajuste à chaque lancement d'un agent : `medium` pour le travail mécanique sans jugement (inventaires, recherches de fichiers, relevés, pages de suivi, rebase sans conflit), `xhigh` pour un modèle de données neuf ou une faille de sécurité difficile, jamais `low`. Ce choix ne passe pas par la configuration.
- Défauts, section absente ou clé non donnée : les valeurs de l'exemple ci-dessus, effort `high`. `apv status` ajoute « (défauts) » quand la section est absente, et garde les défauts quand la configuration est invalide.
