# Configuration et politique

> **Écrit pour V2.** APV3 lit encore un `pipeline.v2.json` (ou `.apv/config.json`), mais seulement ses sections `name`, `gates`, `risk`, `validationRules`, `environment.passEnv`, `skills`, `preview`, `design`, `structure`, `run`, `spec`, `review`, `receipts` et `resources` ([outil apv](CLI.md) ; les sections `structure`, `run` et `spec` sont décrites [plus bas](#arborescence--structure)). Les réglages d'agents, de budgets, de délais, de modèles et de parcours décrits ici ne concernent que le contrôleur V2 ([archive](v2/)).

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

Section APV3, facultative, lue par `apv structure check` ([CLI.md](CLI.md#apv-structure-check)) et validée par le chargeur commun (`apv status` signale une valeur invalide, jamais la section comme ignorée). Absente, l'analyse tourne avec ses valeurs par défaut et ne signale que des avertissements.

```json
{
  "structure": {
    "roots": ["src"],
    "maxFlatFiles": 12,
    "roles": { "-gateway": "client", "-store": "store", "session": null },
    "domains": ["offer-prefill"],
    "ignore": ["src/lib/generated/**"],
    "severity": { "flat-folder": "error", "mixed-roles": "error" }
  }
}
```

- `roots` : dossiers analysés, relatifs à la racine du dépôt (par défaut tout le dépôt, fichiers de code seulement).
- `maxFlatFiles` : fichiers de code qu'un dossier peut contenir directement, tests et fichiers compagnons à part (12 par défaut, de 2 à 1000).
- `roles` : rôles ajoutés à ceux par défaut. Une clé qui commence par `-` est un suffixe de nom (`-gateway` : `payment-gateway.ts` a le rôle `client`, domaine `payment`) ; une autre clé est un mot du nom, pour un utilitaire transverse sans domaine (`session` : rôle `auth`). `null` retire un rôle par défaut. Clés et rôles en kebab-case.
- `domains` : noms de domaines connus, en kebab-case. Un domaine de plusieurs mots (`offer-prefill`) regroupe les fichiers qui commencent par lui ; un domaine déclaré suffit à regrouper deux fichiers. Les noms des dossiers du projet sont déjà des domaines connus.
- `ignore` : globs (`*`, `**`, `?`, `{a,b}`) des chemins laissés de côté, en plus de `node_modules/`, `dist/`, `build/`, `coverage/`, `vendor/` et des dossiers qui commencent par un point.
- `severity` : `warning` (défaut) ou `error`, pour tous les constats ou par code (`flat-folder`, `repeated-prefix`, `mixed-roles`, `stray-file`). `apv structure check` sort en `1` dès qu'un constat a la gravité `error`.

**En faire un contrôle.** Une fois l'arborescence rangée avec l'opérateur (plan validé, `git mv`, imports mis à jour), passez en `error` les constats à ne plus laisser revenir et déclarez la commande comme contrôle de tâche, en lecture seule :

```json
{
  "gates": [
    { "id": "structure", "command": ["apv", "structure", "check"], "covers": ["architecture"], "stage": "task", "readOnly": true }
  ],
  "structure": { "severity": { "flat-folder": "error", "mixed-roles": "error", "stray-file": "error" } }
}
```

`apv` doit être sur le `PATH` de la machine (plugin activé ou `npm link`), sinon utilisez `["node", "<chemin du plugin>/dist/cli.js", "structure", "check"]`. Sans gravité `error`, le contrôle réussit toujours : il ne fait que rapporter. Un projet pas encore rangé garde `warning` (ou relève `maxFlatFiles`) plutôt qu'un contrôle rouge dès le départ ; le rangement est une spec à part, décidée par l'opérateur.

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
    "neutral": ["tests/**", "**/*.test.ts", "docs/**"]
  },
  "terms": { "data": [".from('", ".rpc("], "personal": ["cookie", "localstorage", "email"] },
  "always": ["fidelite"]
} }
```

- `paths` : motifs par classe, syntaxe portable des chemins autorisés (`*`, `**`, `?` ; accolades et `!` refusés), 500 au plus par classe. `ui` (composants, styles, gabarits : garde `fidelite`), `data` (requêtes, dépôts, modèles : `donnees`), `migrations` (migrations et schémas : `donnees` et `rgpd`, renommage compris ; `db.migrations` s'y ajoute), `personal` (export, cookies, consentement, traceurs, registre `.apv/rgpd/` : `rgpd`), `legal` (mentions, confidentialité, CGU : `rgpd`), `neutral` (tests, documentation, outillage : aucun domaine, seulement pour un fichier qu'aucune autre classe ne décrit). Défauts : `src/review/config.ts` (`DEFAULT_REVIEW_PATHS`), par exemple `**/*.svelte`, `**/*.css`, `**/components/**` pour `ui`, `**/repositories/**`, `**/db/**`, `**/*schema*.*` pour `data`, `**/migrations/**`, `**/*.sql` pour `migrations`, `**/legal/**`, `**/*cgu*.*` pour `legal`, `**/*.test.*`, `docs/**`, `.apv/**` pour `neutral`. Une maquette validée touchée (dossier `design.dir`) garde `fidelite`.
- `terms` : mots (sous-chaînes, sans casse, de 2 à 200 caractères) qui, dans les lignes changées d'un fichier `ui` ou `data`, gardent `donnees` (`data` : une requête écrite dans une page) ou `rgpd` (`personal` : un traceur, un cookie, un nouveau champ personnel). Défauts : `DEFAULT_REVIEW_TERMS`. Une fausse alerte garde une revue, jamais l'inverse.
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

`apv procs` lit ces ports ([CLI.md](CLI.md#apv-procs)) : `apv procs stop` sans option arrête les processus qui y écoutent encore, s'ils ont été lancés dans un worktree du dépôt (serveurs laissés par une suite coupée au délai d'un appel Bash), jamais un processus hors du dépôt. Absente : aucun port déclaré, et `apv procs stop` demande `--port` ou `--repo <copie>`. Déclarer ici les ports de toutes les piles de test, pas celui de l'aperçu (`preview.serve.port`), qui tourne dans sa propre copie hors du dépôt et que `apv procs` n'arrête jamais.

## Maquettes validées : `design`

Section facultative : `{ "design": { "dir": "docs/design" } }`, le dossier des maquettes validées ([DESIGN.md](DESIGN.md), [CLI.md](CLI.md#apv-design)), relatif, dans le dépôt, sans espace ; absente : `docs/design`. Une maquette validée est figée par son empreinte sha256 : ses espaces de fin de ligne ne peuvent pas être nettoyés sans changer l'empreinte, et `git diff --check` (contrôle `diff-check`, CI des projets) échouerait sur elle. `apv design register`, et `apv init` ou `apv onboard` quand le dossier est déclaré ou existe, ajoutent donc à `.gitattributes` la ligne `<dir>/*.html -whitespace` si Git ne l'applique pas déjà ; `apv design check` signale son absence (sortie `1` si une maquette validée porte des espaces de fin de ligne). Un dossier changé après coup (nouveau `design.dir`) : relancer `apv design register` ou `apv init`, puis commiter `.gitattributes`.
