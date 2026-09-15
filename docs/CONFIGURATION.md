# Configuration et politique

La configuration est un JSON déclaratif lu avant l'agent et conservé avec la tentative. La tâche ne peut pas fournir une commande à la place d'un contrôle, changer un verdict ni s'accorder une exemption. Les champs inconnus sont refusés.

Les schémas sont dans `examples/schemas/`. Pour les régénérer :

```bash
node dist/cli.js schemas --output examples/schemas
```

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
  "gates": [
    {
      "id": "unit",
      "command": ["npm", "test"],
      "timeoutMs": 120000,
      "mandatory": true,
      "cacheTtlMs": 0
    }
  ],
  "concurrency": 3,
  "maxRunMs": 1800000,
  "maxRepairAttempts": 1
}
```

Le worktree est neuf : un projet dont les tests nécessitent des dépendances doit déclarer un `setup` adapté. L'exemple minimal n'en installe pas implicitement. Ne pas remplacer un vrai contrôle par `true` pour obtenir un résultat vert.

## Commandes et environnement

Une commande est un tableau d'arguments. Il n'y a ni `shell:true`, ni concaténation de texte provenant d'une tâche dans une commande. Déclarer explicitement `bash -lc` reste possible pour un profil de confiance, mais réintroduit alors volontairement un shell sous la responsabilité de l'opérateur.

Les seules substitutions sont des arguments entiers : `{{baseSha}}`, `{{candidateSha}}`, `{{workspace}}`. Une substitution inconnue ou partielle est refusée. Le framework ne calcule pas les commandes depuis les sorties du modèle.

Les variables globales autorisées par défaut sont `PATH`, `SystemRoot`, `WINDIR`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, lorsqu'elles existent. `agent.passEnv`, `gate.passEnv` et `setup.passEnv` ajoutent des noms uniquement pour leur étape. Leurs valeurs ne figurent pas dans la configuration persistée. L'empreinte de validation tient compte des valeurs autorisées ; elle ne doit pas être confondue avec une protection de secrets contre un processus du même utilisateur.

## Graphe de contrôles

`dependsOn` impose l'achèvement réussi des parents. `resources` contient les noms de ressources exclusives, par exemple `test-db` ou `dist`. Deux contrôles partageant une ressource ne tournent pas simultanément. Les dépendances inconnues, doublons et cycles sont refusés avant l'agent.

```json
[
  { "id": "build", "command": ["npm", "run", "build"], "outputs": ["dist/**"], "resources": ["dist"] },
  { "id": "integration", "command": ["npm", "run", "test:integration"], "dependsOn": ["build"], "resources": ["test-db"] },
  { "id": "lint", "command": ["npm", "run", "lint"], "cacheTtlMs": 0 }
]
```

Les ressources déclarées ne détectent pas automatiquement les ports ou fichiers partagés. Elles ne limitent pas non plus les workers qu'un outil lance lui-même. Adapter la concurrence au CPU, à la mémoire et aux outils du projet.

`outputs` est une déclaration utilisée pour refuser le cache de reçus sur les producteurs d'artefacts ; ce n'est pas encore un manifeste d'artefacts vérifié/restauré. Les contrôles ne doivent pas modifier les sources suivies. Les sorties de build doivent être ignorées et leurs consommateurs ordonnés.

## Sélection

Un contrôle `mandatory` s'exécute quel que soit le filtre. Sinon, en `fast` et `standard`, `lanes` et `paths` définissent son applicabilité. Une liste `paths` vide s'applique à tous les changements. Les dépendances transitives d'un contrôle choisi sont incluses, même si leurs propres filtres ne correspondent pas. En `high`, tous les contrôles configurés sont sélectionnés.

Le moteur refuse un plan vide. Un contrôle absent de la configuration n'est toutefois pas inventé par le noyau : calibrer le profil avec des cas qui doivent échouer. Les filtres de chemins sont des décisions de politique, **pas une analyse sémantique de l'impact des imports**.

Les globs supportés sont `*`, `**`, `?`, avec `/` comme séparateur. Les négations, accolades, classes de caractères, chemins absolus et traversées `..` sont refusés. Cette grammaire est volontairement plus petite que celle de certains outils de build.

## Cache et fraîcheur

`cacheTtlMs` vaut zéro par défaut. Une valeur positive n'est acceptée que pour un contrôle indépendant sans sorties déclarées. L'opérateur garantit qu'il est observationnel et suffisamment déterministe. Ne pas activer ce cache pour un scan dont les bases externes, la cible ou l'état réseau ne sont pas représentés dans l'environnement.

La durée de vie d'une entrée concerne sa réutilisation au moment d'une validation. `validationMaxAgeMs`, une heure par défaut, borne séparément le délai avant approbation/export. Une revalidation efface les avis précédents. Le cache ne rafraîchit pas sa propre durée de vie par des lectures successives.

## Budgets

`maxRunMs` borne le temps actif cumulé entre exécution et reprises, hors attente humaine. Les étapes de création du run, l'inspection, la revue et l'export ne font pas partie de ce compteur. Les timeouts de chaque processus restent bornés par le signal global. Une reprise ne remet pas le budget à zéro.

Une réparation est autorisée uniquement après un échec de contrôle considéré comme corrigeable. Les timeouts, l'absence d'exécutable, les erreurs de setup, la violation du scope et les mutations du validateur ne sont pas transformés en boucles infinies de corrections. Le framework ne mesure pas encore les tokens ou le prix du fournisseur.

## Workflow de spec et profils de rôles (alpha.2)

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
    "maxQaRepairs": 1,
    "maxActiveMs": 3600000
  }
}
```

Cet extrait complète une configuration, ce n'est pas un fichier autonome valide. Null signifie hériter de l'adaptateur de réalisation. Un rôle peut avoir son modèle et ses variables autorisées ; ne pas stocker de clés directement dans le JSON. Setup utilise l'adaptateur par défaut, celui de `--config` ou celui du fichier `--agent` explicite.

La politique QA est une décision revue par l'opérateur et incluse dans le hash approuvé. La valeur par défaut appelle QA sur standard/high. Une liste vide la désactive : cela doit être une modification de politique explicitement approuvée, jamais une réparation automatique proposée pour contourner un refus. QA ne compte pas comme avis humain. Les seuils humains restent zéro/un/deux libellés pour fast/standard/high.

Les tâches d'une spec sont séquentielles. Pour plusieurs tâches, le contrôle d'intégration force tous les gates configurés, même si leurs filtres individuels auraient réduit la sélection sur un changement isolé. Les setups restent ceux du profil ; les services externes ne sont pas automatiquement démarrés ou provisionnés.

L'onboarding associe les scripts npm/pnpm détectés à une même ressource exclusive par prudence. Après calibration, retirer cette ressource des commandes réellement indépendantes pour bénéficier du parallélisme ; ne pas supposer leur indépendance à partir de leur nom.

## Fournisseurs et skills (alpha.3)

`agent.type` accepte `command`, `codex`, `claude`. Choisir `--provider` lors du nouvel onboarding ou un profil `--agent`. Product et QA peuvent utiliser `roles.product`/`roles.qa`; null hérite d'agent. Le rôle Setup est choisi au lancement de l'installation.

Les profils natifs acceptent uniquement un chemin d'exécutable dans `command`. Ne pas ajouter de flags arbitraires. Les nouveaux champs `maxTurns` et `maxBudgetUsd` s'appliquent exclusivement à Claude ; voir ADAPTERS.md pour leurs limites.

Le bloc `skills` est documenté dans SKILLS.md. Son absence signifie aucune compétence ajoutée ; les nouveaux plans déterministes proposent explicitement les six compétences et `projectType: unknown`. Pour recevoir ui-design, configurer un type frontend/mobile/fullstack après inspection réelle du projet. `apv2 inspect --repo PATH` affiche les choix effectifs sans lancer de modèle.

## Alpha.5 — politique de revue

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

## Alpha.8 — découverte des gates de sécurité

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

## Fichiers générés : `workflow.generatedPaths`

Globs des fichiers que seul l'outillage du projet régénère. Par défaut, les lockfiles des gestionnaires de paquets courants. Remplacez la liste pour l'adapter à votre stack (par exemple `**/*.generated.ts`).

Si l'Implementer configuré n'a pas de shell (adaptateur Claude natif), une spec dont une tâche nomme explicitement un de ces fichiers dans `allowedPaths` est refusée avec `SPEC_CAPABILITY`. L'étape d'outillage doit alors devenir un prérequis opérateur. Les wrappers `command`, aux capacités inconnues, ne sont pas présumés sans shell.
