# Configuration et politique

> **Écrit pour V2.** APV3 lit encore un `pipeline.v2.json` (ou `.apv/config.json`), mais seulement ses sections `name`, `gates`, `risk`, `validationRules`, `environment.passEnv`, `skills`, `preview`, `design`, `structure`, `run`, `spec`, `review`, `receipts`, `resources`, `suite`, `stacks`, `batch`, `stack`, `web`, `reuse` et `map` ([outil apv](CLI.md) ; les sections `structure`, `run` et `spec` sont décrites [plus bas](#arborescence--structure)). Les réglages d'agents, de budgets, de délais, de modèles et de parcours décrits ici ne concernent que le contrôleur V2 ([archive](v2/)).

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

Section APV3, facultative, lue par `apv spec validate` et validée par le chargeur commun (entier hors bornes ou propriété inconnue refusés). Elle fixe les seuils au-delà desquels la validation **avertit**, sans jamais rendre la spec invalide ni changer le code de sortie.

```json
{ "spec": { "maxTasks": 6, "maxAcceptance": 30, "maxDepth": 3 } }
```

- `maxTasks` (défaut `6`, de 1 à 100) : nombre de tâches au-delà duquel la validation propose de découper la demande en specs indépendantes de 4 à 6 tâches, livrées en parallèle (sur des piles de test distinctes quand le projet en déclare plusieurs, par exemple des ressources de contrôle distinctes), chacune avec sa PR.
- `maxAcceptance` (défaut `30`, de 1 à 1000) : même avertissement au-delà de ce nombre de critères d'acceptation.
- `maxDepth` (défaut `3`, de 1 à 100) : nombre de couches du graphe des tâches (les vagues de `apv run start`) au-delà duquel la validation nomme le chemin le plus long. Chaque couche attend l'intégration de la précédente : le motif « contrats d'abord » (une première tâche pose les types, schémas, signatures de fonctions, interfaces de composants et migrations, avec des implémentations minimales testées) laisse les tâches suivantes se construire en parallèle contre ces contrats. Une dépendance ne se déclare que si la tâche a besoin du code de l'autre, pas seulement de son existence future.

Les avertissements sortent aussi en JSON (`warnings`, codes `SPEC_SIZE` et `SPEC_DEPTH`, et `limits`, les seuils appliqués). Une spec déjà validée par l'opérateur s'exécute telle quelle.

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
    "tooling": ["playwright.config.ts", "scripts/test-*.mjs"]
  },
  "terms": { "data": [".from('", ".rpc("], "personal": ["cookie", "localstorage", "email"] },
  "always": ["fidelite"]
} }
```

- `paths` : motifs par classe, syntaxe portable des chemins autorisés (`*`, `**`, `?` ; accolades et `!` refusés), 500 au plus par classe. `ui` (composants, styles, gabarits : garde `fidelite`), `data` (requêtes, dépôts, modèles : `donnees`), `migrations` (migrations et schémas : `donnees` et `rgpd`, renommage compris ; `db.migrations` s'y ajoute), `personal` (export, cookies, consentement, traceurs, registre `.apv/rgpd/` : `rgpd`), `legal` (mentions, confidentialité, CGU : `rgpd`), `neutral` (tests, documentation, outillage : aucun domaine, seulement pour un fichier qu'aucune autre classe ne décrit). Défauts : `src/review/config.ts` (`DEFAULT_REVIEW_PATHS`), par exemple `**/*.svelte`, `**/*.css`, `**/components/**` pour `ui`, `**/repositories/**`, `**/db/**`, `**/*schema*.*` pour `data`, `**/migrations/**`, `**/*.sql` pour `migrations`, `**/legal/**`, `**/*cgu*.*` pour `legal`, `**/*.test.*`, `docs/**`, `.apv/**` pour `neutral`. Une maquette validée touchée (dossier `design.dir`) garde `fidelite`. `tooling` (outillage de test : configurations de Playwright, Vitest, Jest, Cypress, `__mocks__/`, `fixtures/`, `test-utils/` : aucun domaine, risque faible) et `server` (code serveur et configuration : `**/server/**`, `**/*.server.*`, `**/api/**`, `**/*.config.*`, `**/*.json`, `**/*.yml`... : aucun domaine en propre, mais un fichier qu'aucune classe de domaine ne décrit et qui y répond garde toujours la prudence et rend le risque élevé) complètent les classes (3.0.0-alpha.15). Un fichier propre au projet que les défauts ne décrivent pas (un module de messages, un script de tests) se classe ici : `"tooling": ["scripts/test-*.mjs"]`, `"ui": ["src/lib/copy/**"]` ; une clé donnée remplace sa liste par défaut, la reprendre en entier si on l'étend.
- `terms` : mots (sous-chaînes, sans casse, de 2 à 200 caractères) qui, dans les lignes changées d'un fichier `ui` ou `data`, gardent `donnees` (`data` : une requête écrite dans une page) ou `rgpd` (`personal` : un traceur, un cookie, un nouveau champ personnel). Défauts : `DEFAULT_REVIEW_TERMS`. Une fausse alerte garde une revue, jamais l'inverse.
- **Niveau de risque** (3.0.0-alpha.15, `src/review/risk.ts`) : `apv review plan` donne le niveau du diff et sa raison. **Faible** quand chaque fichier est un test (`*.test.*`, `*.spec.*`, `tests/`, `e2e/`, même sous un chemin sensible), de l'outillage de test, de la documentation, une maquette, un texte d'interface sans balisage nouveau (mêmes balises, attributs et expressions ; seuls changent les nœuds de texte et des chaînes de prose en valeur d'attribut de texte comme `alt`, `title`, `placeholder`, `aria-label`) ou un fichier non classé hors `server` et hors chemins sensibles dont seules des chaînes de prose changent (une valeur de propriété, une déclaration `const x = '…'` ; une phrase avec une espace et une lettre, jamais une adresse, un chemin, un mot seul comme `'admin'`), sans terme de `review.terms` : le plan garde `securite`, plus `fidelite` si l'interface change de contenu visible ; le module de messages non classé garde `fidelite` seule au lieu des trois domaines. **Élevé** sinon : migration ou schéma, données, données personnelles, export, traceur, texte légal, chemin sensible de la voie high (authentification, session, permissions, dépendances, CI, configuration de sécurité), code serveur ou configuration, balisage ou code changé, fichier déplacé, terme de données ou RGPD, fichier vraiment inconnu (prudence) : le plan est celui d'avant le niveau. `--force` et `always` restent au-dessus du niveau. `apv rules check` exige exactement les domaines du plan au commit (même calcul, configuration lue à la base commune), et `apv gates run --since` n'accepte qu'un diff de risque faible.
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
    "queue": { "lockFile": "apv/locks/full-suite.lock", "waitMs": 7200000, "maxLoad": 6, "loadWaitMs": 1800000 },
    "ports": [4173, 4174, 4273, 4274]
  }
}
```

- `queue.enabled` (défaut `true`) : `false` retire la file (chaque suite démarre aussitôt, comme avant 3.0.0-alpha.4).
- `queue.lockFile` (défaut `apv/locks/full-suite.lock`) : verrou à bail de la file, relatif au répertoire Git commun (`git rev-parse --git-common-dir`, commun à tous les worktrees du dépôt) ou absolu (partagé par plusieurs dépôts de la machine) ; nom de fichier en `.lock` ([A-Za-z0-9._-]). Format et garanties de `apv lock` ([LOCKS.md](LOCKS.md)) : FIFO, propriétaire vérifié, bail renouvelé, reprise d'un détenteur mort journalisée ; `apv lock status --dir <dossier du fichier>` le montre.
- `queue.waitMs` (défaut 2 h, de 0 à 24 h) : attente maximale de la file ; au-delà, refus `SUITE_QUEUE`, rien n'est exécuté.
- `queue.maxLoad` (facultatif, nombre de 0,1 à 10000) : une fois le verrou obtenu, la suite attend que la charge moyenne sur 1 minute (`os.loadavg()`) passe sous ce seuil ; repère : le nombre de cœurs, ou un peu moins si des agents travaillent en même temps.
- `queue.loadWaitMs` (défaut 30 min) : attente maximale de la charge ; au-delà, la suite démarre quand même et le note (sortie, `summary.json`).
- `ports` (défaut aucun, 100 au plus, sans doublon) : ports libérés des orphelins de la copie où tourne la suite (processus lancés dans ce worktree lié), jamais d'une autre copie ni du checkout principal ; en pratique les ports de `resources`.

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
- `idleAfterMs` (facultatif, d'une minute à 7 jours, défaut 30 min) : inactivité prouvée avant l'arrêt.
- `description` (facultatif).

Refusés : deux piles au même `id`, au même `lockFile`, à la même `resource` ou au même `dockerProject`, une pile sans verrou, un port en double. Les piles ne changent pas l'empreinte des contrôles : les reçus restent valides.

## Lot et copies : `batch`

Section APV3, facultative (3.0.0-alpha.5, spécification sections 18.5 et 18.6) : la préparation d'une copie neuve du dépôt avant qu'une suite complète y tourne, celle d'un lot de `apv stack batch` et celles des piles suivantes de `apv gates run --stacks`.

```json
{ "batch": { "setup": ["npm", "ci", "--no-audit", "--no-fund"], "setupTimeoutMs": 900000, "passEnv": ["npm_config_cache"] } }
```

- `setup` (facultatif, sans shell, lancé à la racine de la copie) : typiquement l'installation des dépendances. Elle reçoit `environment.passEnv`, `HOME` et `passEnv`. Après elle, la copie doit être propre (fichiers créés ignorés par Git), sinon la copie est refusée.
- `setupTimeoutMs` (défaut 15 min, jusqu'à 1 h).
- Absente : rien n'est préparé (projet sans dépendances à installer).

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
    { "id": "code-map", "command": ["apv", "map", "--check"], "covers": ["architecture"], "stage": "full", "readOnly": true, "mandatory": true }
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

Section APV3, facultative (3.0.0-alpha.12), lue **à la base commune** de la PR et de sa cible par `apv rules check`, `apv stack merge` et `apv stack batch --merge` ([REGLES.md](REGLES.md)). Elle complète les règles, elle ne peut en retirer aucune : il n'existe pas de clé pour les désactiver.

```json
"rules": {
  "captures": { "viewports": ["desktop", "phone"], "themes": ["light", "dark"] },
  "requiredGates": [{ "id": "a11y", "command": ["npm", "run", "check:a11y"] }],
  "screens": ["src/views/**/*.vue"]
}
```

- `captures.viewports` (`desktop`, `phone`, `tablet` ; défaut `desktop` et `phone`) et `captures.themes` (`light`, `dark` ; défaut les deux) : captures qu'exige la relecture de fidélité d'un changement d'interface. `["light"]` seulement pour un projet sans thème sombre.
- `requiredGates` : contrôles qu'un projet exige en plus de `reuse`, `code-map` et `structure` (projet web) : un identifiant et le début de la commande, reconnue enveloppée ou non (`node <plugin>/dist/cli.js`, `npx apv`) ; ils valent aussi pour un projet sans interface web.
- `screens` : motifs des fichiers d'écran que l'outil ne reconnaît pas seul (il connaît les pages, mises en page et pages d'erreur de SvelteKit, Next, Remix, Nuxt, Astro et `pages/`).
