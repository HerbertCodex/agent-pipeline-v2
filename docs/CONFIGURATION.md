# Configuration et politique

> **Écrit pour V2.** APV3 lit encore un `pipeline.v2.json` (ou `.apv/config.json`), mais seulement ses sections `gates`, `risk`, `validationRules`, `environment.passEnv` et `skills` ([outil apv](CLI.md)). Les réglages d'agents, de budgets, de délais, de modèles et de parcours décrits ici ne concernent que le contrôleur V2 ([archive](v2/)).

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

`stage` (facultatif) : `task` (valeur par défaut) pour un contrôle rapide, lancé après chaque tâche par `apv gates run --stage task` ; `full` pour un contrôle long (la suite navigateur complète, par exemple), réservé à la suite complète que le chef de projet passe à chaque intégration et à la livraison (`apv gates run --stage full`, puis `apv gates verify --commit <sha>`). Un contrôle `task` ne peut pas dépendre d'un contrôle `full`. Sans ce champ, tout tourne partout, comme avant ([RUN.md](RUN.md#contrôles--par-tâche-et-suite-complète)).

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
