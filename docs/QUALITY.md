# Qualité du code et preuves de validation

> **Écrit pour V2.** APV3 reprend la planification des contrôles et les reçus (`apv gates run`, [outil apv](CLI.md)) ; les passages sur l'appel QA du contrôleur décrivent V2. En V3, les revues sont des sous-agents ([plugin](PLUGIN.md)).

La pipeline examine la qualité dans **l'appel QA existant**, avec des critères concrets et des preuves liées au candidat. Un résultat de lint ou une affirmation d'agent ne constitue pas un certificat de qualité.

## Revue proportionnée

Les critères fonctionnels, décisions confirmées et exigences de sécurité restent contrôlés comme auparavant. La QA les complète par six axes :

| Axe | Ce que la revue doit établir |
| --- | --- |
| Architecture | Frontières et dépendances cohérentes ; décision approuvée respectée ; pas de nouvel ADR imposé à une correction locale. |
| Simplicité | Abstractions utiles à un besoin actuel ; pas de découpage dicté par un nombre arbitraire de lignes. |
| Réutilisation | Responsabilités existantes considérées, duplication justifiée ou signalée avec les chemins concernés. |
| Tests | Comportements, limites et régressions pertinents ; exécution appuyée par une preuve finale de tests. |
| Exploitation | Erreurs, effets partiels, migrations, reprise et idempotence lorsque concernés. |
| Interface | États, clavier, responsive et conventions CSS existantes ; inspection du code distinguée d'un essai navigateur. |

Chaque `qualityChecks` contient `axis`, `status`, `evidence`, `paths`, `receiptIds` et `findingIds`. L'explication est bornée à 1 600 caractères. Le contrôleur refuse les axes manquants ou répétés, les fichiers absents du commit de base et du candidat, les références de résultat inconnues et les contradictions avec le verdict. Les références sont des chemins relatifs exacts, sans numéro de ligne ni glob ; les fichiers supprimés peuvent être cités depuis le commit de base.

Pour un changement hors documentation, architecture, simplicité, réutilisation et tests doivent être examinés. L'exploitation devient obligatoire en lane `high`, l'interface lorsqu'elle est déclarée ou détectée dans les fichiers UI usuels. Les autres cas peuvent être `not_applicable` avec une raison. Cette sélection prudente par chemins ne constitue pas une analyse sémantique exhaustive.

Un `tests: pass` doit citer un résultat final réussi de tests unitaires, d'intégration ou navigateur. Une lecture de tests, un lint réussi, un résumé d'Implementer et les checks de sa session ne suffisent pas. L'existence d'une référence est contrôlée ; la pertinence des assertions et la véracité d'une affirmation « ce test échouait avant » restent à apprécier à partir des observations effectivement disponibles. Le framework n'exécute pas automatiquement les nouveaux tests sur l'ancien commit.

`fail` doit référencer un constat `major`, `blocker` ou portant `resolution: "required"`, sur un chemin réel, dont la QA explique le déclencheur et l'impact. Une préférence stylistique seule ne justifie pas `changes_requested`. Un axe, critère, décision ou contrôle de sécurité `unknown` interdit `pass` et arrête la boucle avec `QA_EVIDENCE` : **aucune réparation automatique de code n'est lancée pour une preuve inconnue**. Consulter les exigences manquantes. Un rapport `spec qa` peut compléter les références de revue, jamais remplacer une gate absente. `spec verify` rejoue les gates d’un candidat intégré déjà validé. Une commande ou un `testPaths` absent nécessite une configuration revue et une nouvelle spec ; le candidat arrêté reste conservé dans son worktree. Relancer la spec ne crée pas de réparation automatique. L'opérateur qui a inspecté la preuve manquante peut autoriser exactement une réparation avec `apv2 spec qa-repair SPEC_ID --confirm --note TEXT` : elle exige que chaque contrôle configuré ait déjà prouvé ce candidat, elle est consommée par la réparation qu'elle autorise, et la revue suivante doit toujours conclure sur ses propres preuves.

Ces règles s'appliquent aux rapports des agents et aux imports manuels, puis sont revérifiées à la frontière de revue/livraison. Les corrections de contrat QA restent bornées par `maxOutputRepairs`. Le parcours compact conserve son exemption conditionnelle de QA modèle et ses contrôles finaux : ce lot n'ajoute pas un agent à chaque petite tâche.

## Contrôles et couverture

Chaque gate peut déclarer `covers`, parmi `unit`, `integration`, `browser`, `build`, `lint`, `typecheck`, `security`, `architecture`. Plusieurs labels permettent de décrire un script composite réellement vérifié. Ils ne modifient ni la commande ni ses permissions. En mode evidence, ils participent à la sélection des contrôles exigés par le changement.

La matrice du candidat distingue résultats réussis ou réutilisés, échecs, résultats manquants et gates non sélectionnées. Elle ne crédite que les résultats liés au bon run, candidat, hash de configuration et gate sélectionnée. La validation et le scellement des résultats restent assurés par le moteur existant ; la matrice n'est pas un nouveau vérificateur de signatures. Les résultats en cache restent identifiés par leur origine.

Une catégorie facultative sans preuve reste une **lacune visible**. Une catégorie requise sans preuve bloque avec `QA_EVIDENCE`, avant un appel QA et à nouveau avant revue/livraison. Aucun outil n’est installé automatiquement. Un test unitaire réussi n'atteste pas un parcours navigateur. Une commande composite non renseignée conserve `covers: []`, même si son nom est `check`. Les labels décrivent des commandes revues par l'opérateur ; le contrôleur ne peut pas prouver qu'un script nommé `test` contient des assertions utiles.

La sélection existante par `lanes`, `paths`, dépendances et caractère obligatoire reste le socle. Les exigences ajoutent les gates applicables nécessaires même si leur lane excluait le parcours choisi ; leurs dépendances sont incluses. Une simple exigence de tests comportementaux préfère une gate unitaire disponible sans forcer toutes les suites navigateur. Les changements `high` exécutent toujours toutes les gates configurées. Une gate limitée à un autre périmètre ne peut pas satisfaire une exigence du changement. Si plusieurs interfaces ou frontières changent, les chemins non couverts restent bloquants : une preuve sur un seul module ne suffit pas pour les autres. L'onboarding propose les scripts existants build, intégration et navigateur, avec des labels à revoir avant application. Aucun nouveau outil, téléchargement ou appel modèle n'est nécessaire à cette sélection.

Les résultats sont accessibles dans l'onglet QA, dans `spec show`, dans `REVIEW.md` et `QA.md`, ainsi que dans `evidence.json` à la livraison. La matrice apparaît même lorsqu'aucune QA modèle n'est requise ou encore disponible.

## Exigences adaptées au changement

Ces obligations sont déterminées par le contrôleur, pas par le verdict de l’agent. Elles s’appliquent aussi au parcours compact et aux exécutions directes du runner.

| Changement observé | Preuve obligatoire |
| --- | --- |
| Code, y compris tests | Au moins une gate comportementale : unit, integration ou browser. |
| Source compilée, manifeste de build, ou build existant applicable | Build de production. Un typecheck n’est pas un build. |
| Frontière API/routes/adapters/repositories/database/migrations, SQL ou source à risque élevé | Intégration. |
| Parcours structurant avec du code | Intégration, même si les noms de fichiers sont neutres. |
| Source UI habituelle, dont JS/TS sous ui/components/pages/views/frontend, ou impact UI déclaré | Navigateur. Une QA UI `pass` doit citer cette preuve. |
| Documentation seule | Aucune nouvelle catégorie de tests imposée. Les gates déjà obligatoires restent exécutées. |
| Règle locale `validationRules` | Chaque catégorie déclarée par la règle. |

Les fichiers de tests reconnus n’activent pas à eux seuls les exigences de production/UI. Les détections par chemins sont conservatrices, pas une compréhension sémantique universelle : compléter `validationRules` pour les frontières et chemins propres au projet. La QA inspecte toujours la pertinence des scénarios et des assertions.

Par exemple, pour contrôler les dépendances du domaine avec **une commande existante qui vérifie réellement les imports** :

```json
{
  "validationRules": [
    { "id": "domain-boundaries", "paths": ["src/domain/**"], "requires": ["architecture"] },
    { "id": "custom-client", "paths": ["client/**"], "requires": ["browser"] }
  ],
  "gates": [
    { "id": "boundaries", "command": ["npm", "run", "lint:boundaries"], "covers": ["architecture"], "paths": ["src/**"] }
  ]
}
```

Ce fragment se fusionne avec les autres gates ; il ne crée pas le script `lint:boundaries`. Les règles de dépendance et leur outil restent propres à la stack (par exemple règles d’import du linter du projet). La pipeline impose la preuve de leur exécution et la revue des frontières ; elle n’invente pas une matrice universelle de dépendances autorisées.

## Décisions structurantes et sécurité

La décision courte produite par Product comprend désormais explicitement `constraint`, `simplerAlternative`, `risks`, les alternatives et compromis, et `reconsiderWhen`. Les champs manquants sont refusés. Pas d’agent Architect obligatoire, ni de document demandé pour une correction locale. La pertinence du choix reste une responsabilité de revue ; le schéma ne récompense aucun nombre de couches ou de classes.

Une entrée `negativeTests` peut autoriser explicitement une inspection avec le préfixe `[review] ` dans la spec approuvée. QA renvoie alors `review`, avec les fichiers effectivement inspectés dans `inspectedPaths` (ou `paths` pour les rapports antérieurs), sans reçu de test comportemental, et au moins 40 caractères décrivant son observation. Ce statut ne prouve pas une exécution et ne remplace pas les tests négatifs exigés par le contrôleur. Les anciennes entrées sans ce préfixe restent soumises aux preuves de test : aucune exemption n’est déduite automatiquement de leur formulation.

Chaque scénario déclaré dans `security.requirements[].negativeTests` reçoit un `negativeTestChecks` : identifiant d’exigence, index à partir de zéro, statut, explication, fichiers de test et receipts finaux. Les scénarios omis, répétés, inconnus ou contradictoires sont refusés. Un succès nécessite un fichier encore présent dans le candidat et une gate comportementale réussie dont les `testPaths` revus incluent ce fichier. Un scanner seul ne suffit pas. Exemple de gate exécutant précisément un fichier :

```json
{
  "id": "authorization-tests",
  "command": ["node", "--test", "test/authorization.test.mjs"],
  "covers": ["unit"],
  "testPaths": ["test/authorization.test.mjs"]
}
```

Les mappings `covers` et `testPaths` font partie de la configuration approuvée. La QA doit vérifier que l’assertion attendue existe et n’est pas désactivée. Le contrôleur vérifie la chaîne scénario → fichier → commande → résultat du candidat ; il ne certifie pas sémantiquement toutes les assertions et ne produit pas de rapport universel par assertion pour tous les runners.

## Activation et compatibilité

Les nouvelles configurations proposées par `apv2 init` et l'onboarding activent `workflow.qualityReview: "evidence"`. Une configuration existante sans ce champ garde `legacy` : ses anciens rapports demeurent lisibles et ses obligations ne changent pas silencieusement. Les configurations fournies explicitement à l'onboarding conservent leur choix.

Pour une **nouvelle spec** d'un projet existant, fusionner ce réglage et les labels dans la configuration revue. Exemple illustratif, sans remplacer les autres gates ou propriétés :

```json
{
  "workflow": { "qualityReview": "evidence" },
  "gates": [
    { "id": "test", "command": ["npm", "test"], "covers": ["unit"] },
    { "id": "browser", "command": ["npm", "run", "test:e2e"], "covers": ["browser"],
      "lanes": ["standard", "high"], "paths": ["ui/**", "src/components/**"] }
  ]
}
```

N'ajouter la gate navigateur que si cette commande existe, et adapter les chemins à ses vraies dépendances.

## Validation

Les tests couvrent les références inventées ou périmées, les gates non sélectionnées, le cache, les verdicts contradictoires, l'import manuel, le refus à la livraison, l'arrêt sans réparation pour preuve inconnue et le passage de la grille dans un seul appel QA ciblé. Les fixtures sont des doubles déterministes : elles testent les contrats du contrôleur, pas la compétence d'un modèle à juger une architecture.

L’API du tableau de bord est testée sur un serveur local. Le script `scripts/check-quality-ui.mjs` exécute aussi Chromium sur une fixture : refus d’un parcours compact sans preuve navigateur, exécution d’une vraie gate navigateur, affichage des preuves absentes et présentes, vues desktop/mobile et navigation QA au clavier. Il utilise Playwright/Chromium déjà installés, sans téléchargement. Ces parcours ciblés ne constituent pas un audit complet d’accessibilité.

Les résultats datés sont conservés dans [validation](../validation/VALIDATION.md), notamment ceux des [corrections QA obligatoires](../validation/qa-cleanup-2026-09-19/README.md). Ils décrivent l'état testé, pas automatiquement la version actuelle.

Pour reproduire le contrôle navigateur après compilation :

```sh
APV2_PLAYWRIGHT_MODULE=/chemin/vers/playwright/index.mjs \
APV2_CHROMIUM_EXECUTABLE=/chemin/vers/chromium \
node scripts/check-quality-ui.mjs --output /tmp/apv2-quality-ui
```

Les variables sont facultatives si Playwright et son navigateur sont déjà résolus dans l’environnement. Une dépendance manquante fait échouer le contrôle ; aucun test n’est silencieusement ignoré.


## Reprendre une QA bloquée

Une observation de revue cite des fichiers dans `inspectedPaths` ; les chemins sont contrôlés sur le candidat. Pour compatibilité avec les rapports déjà produits, `paths` peut aussi désigner les fichiers inspectés lorsque le statut est `review`. Elle ne peut pas citer un reçu comportemental comme preuve d’exécution. Un statut `pass` conserve ses obligations de vrais tests et de reçus correspondants.

Une ancienne spec peut être corrigée par `spec criterion` : chaque entrée de `requirements` peut proposer `reviewTestIndexes`, les indices à partir de zéro des cas existants à évaluer par inspection. Le format `negativeTests` de main reste accepté : fournir la liste complète avec uniquement les marqueurs `[review] ` ajoutés, sans la combiner avec `reviewTestIndexes`. La proposition montre le texte antérieur et porte un hash à approuver. L’original, les commits et les tentatives sont conservés ; QA et revue sont invalidées. Le contrôleur refuse de supprimer ainsi la dernière obligation de test négatif lorsqu’il exige une couverture exécutable. Aucun classement automatique d’après la formulation du texte n’est effectué.

Si la QA revendique une exemption non approuvée, `QA_REVIEW_AUTHORIZATION` rend la décision à l’opérateur sans boucle payante de correction. Il faut fournir les preuves de test ou approuver une correction justifiée de la méthode de vérification.

Un rapport retenu reste réutilisable sans appel modèle si le candidat, le contexte, le schéma et les consignes correspondent et que sa validation réussit. Un changement du schéma ou des consignes peut reprendre le rapport comme brouillon, mais impose une réévaluation : ce n’est jamais une preuve automatiquement acceptée. Un changement des obligations ou des reçus invalide cette reprise. Pour une réparation limitée au schéma JSON, le rapport, les obligations et les reçus sont transmis sans renvoyer tout le diff ; la commande permettant de consulter le diff reste disponible.

Après un arrêt budgétaire, une nouvelle QA comparable est refusée avant l’appel si son budget disponible ne dépasse pas le coût déjà consommé sans terminer. Ce coût observé est une borne basse, pas une estimation garantie du prix de la QA. Le modèle, le candidat, le contexte et les consignes doivent correspondre pour appliquer cette règle. Aucun plafond n’est relevé automatiquement.

Avant une reprise depuis un autre checkout, exécuter `node /chemin/du/framework/dist/cli.js runtime`. La sortie indique l’installation, l’empreinte du moteur QA, du contrat et des consignes ; chaque session QA les enregistre aussi dans `qa.runtime`. Un simple numéro de version ou une recherche du mot `review` ne démontre pas quelle correction est exécutée.

## Nettoyage lié au changement

La gravité (`severity`) et l'obligation de correction (`resolution`) sont distinctes. La QA doit marquer `required` un nettoyage confirmé causé par la modification : code devenu inutilisé, commentaire ou documentation devenue fausse. Un constat `minor` avec `resolution: "required"` interdit `pass` et peut déclencher la boucle de réparation existante. Les limites de réparation, les preuves inconnues et les périmètres approuvés continuent de s'appliquer : aucun constat n'est automatiquement abandonné quand une limite est atteinte.

La QA doit vérifier les appelants, points d'entrée du framework, usages dynamiques et contrats publics avant de déclarer un export mort. La qualification reste une appréciation de revue ; le contrôleur impose ensuite la décision déclarée, sans deviner la sémantique du texte. Les constats `major` et `blocker` restent bloquants même s'ils portent `advisory`. Une dette ancienne sans rapport et une préférence cosmétique restent des observations. Le tableau de bord et `QA.md` distinguent « correction requise » et « observation ».

Pour compatibilité, les anciens rapports sans `resolution` gardent `advisory` ; ce changement ne requalifie pas rétroactivement leurs constats ni ne relance une QA déjà enregistrée. Une nouvelle revue suit les instructions actualisées. Le contrôleur refuse un verdict `pass` avec une correction requise à l'import et lors de la vérification avant publication.

L'onboarding recherche les scripts existants `check:dead-code`, `lint:dead-code`, `dead-code`, `deadcode`, puis `knip`, et propose le premier comme gate obligatoire dans toutes les lanes. Les commandes explicitement interactives ou avec `--fix`/`--write` sont exclues. Les scripts restent des propositions à inspecter, pas une garantie d'absence d'effets de bord. En l'absence d'analyseur, une note expose la lacune ; aucun outil n'est installé et aucune configuration approuvée n'est modifiée automatiquement.

Exemple à ajouter à une configuration revue **seulement si le script existe et analyse réellement les usages du projet** :

```json
{
  "gates": [{
    "id": "dead-code",
    "command": ["npm", "run", "check:dead-code"],
    "covers": ["lint"],
    "mandatory": true,
    "resources": ["project-checks"]
  }]
}
```

Les points d'entrée, exports publics et exclusions de l'analyseur doivent être revus. Ce contrôle ne prouve pas la justesse de la documentation ; la revue reste nécessaire. Les projets existants conservent leurs configurations jusqu'à une modification explicitement revue.
