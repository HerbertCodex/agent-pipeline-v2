# Architecture

## Un monolithe modulaire

`domain` définit les contrats et erreurs. `policy` calcule les obligations sur le diff réel. `execution` gère Git, argv, environnement, limites et groupes de processus. `engine` exécute les tentatives, les contrôles et leurs réparations bornées. `evidence` produit et réutilise les reçus. `persistence` conserve l'état SQLite et les événements. `adapters` isole les moteurs d'agents. `lifecycle` ajoute installation, Product, specs, QA, livraison et GitHub. La CLI les compose ; aucun agent Orchestrator ne décide des transitions mécaniques.

## Deux niveaux d'état

Un run reste le mécanisme de tâche alpha.1. Une spec est un document versionné qui référence des runs, un candidat courant, une approbation de périmètre, une QA, des avis humains et éventuellement une livraison/publication. Le store conserve le code source séparément de l'état opérationnel. Une transition ne demande plus un commit du store Git.

La migration SQLite user_version 1 → 2 crée les tables documents, document_events, document_leases et document_children, en conservant les runs. Des mises à jour optimistes et baux par document empêchent les collisions accidentelles. Les événements accompagnent les écritures dans les transactions SQLite. Ce n'est ni un bus distribué, ni une promesse exactly-once sur des effets distants.

## Flux de contrôle

Le contrôleur expose une seule invocation d'exécution par spec à la fois. Plusieurs documents peuvent être inspectés ; l'exécution d'un run est limitée par le verrou global du store. Les tâches de réalisation ne sont pas exécutées en parallèle. Le graphe des contrôles dispose de dépendances et ressources exclusives ; seule cette concurrence est orchestrée.

Product/QA utilisent des worktrees frais, sans les modifications non contrôlées ni la conversation privée de l'Implementer. Le code appelle la CLI fournisseur ; il ne conserve pas encore les identifiants de threads. Les réparations voient le workspace et les diagnostics, pas une garantie de reprise de mémoire du modèle.

## Frontières de contrat

Les schémas TypeScript servent au parsing runtime et à l'export JSON Schema. Le transport Structured Outputs du fournisseur utilise un sous-ensemble de forme/type/enum, sans `allOf` ni defaults. Les contraintes retirées du format de transport restent imposées après réponse par le parseur complet. Les accords sont liés aux empreintes et les sorties d'agents ne deviennent pas des reçus du runner.

`Pipeline.assertValidated` permet à la composition de réutiliser des preuves intermédiaires ; il n'est pas une méthode d'approbation humaine ou d'export. Les limites de scope, fraîcheur, identité du candidat et schéma des preuves restent actives. Les chemins de politique, y compris `.agent-pipeline/**`, forcent le parcours renforcé.

## Reprise et effets externes

Un pointeur d'activité est conservé avant l'exécution, les processus enfants sont journalisés, et la reprise exige l'arrêt des processus connus. Un SIGKILL réel est couvert par les tests. Il existe toujours des fenêtres d'incertitude entre OS, SQLite et services distants ; la réponse est une récupération explicite et conservative, pas un redémarrage implicite de code à effets de bord.

La publication conserve une intention puis réconcilie Git et la forge. La branche cible ayant changé depuis la base approuvée bloque une nouvelle publication. Le manifeste local est atomiquement renommé dans sa destination après écriture. L'installation de plusieurs fichiers source possède un rollback sur exception capturée, mais pas de transaction atomique OS/SQLite en cas d'arrêt machine.

## Extension

Ajouter un moteur via le protocole command, un profil via la configuration déclarative et un connecteur de livraison derrière les vérifications existantes. Une exécution distante ou multi-utilisateur exige un autre modèle de confiance, des identités et une attestation des preuves ; ne pas simplement exposer la CLI par HTTP.

## Alpha.5 — mémoire d'architecture et intelligence du dépôt

Le bootstrap persiste `.agent-pipeline/ARCHITECTURE.md`. Il ne s'agit pas d'une règle immuable : chaque décision contient les raisons qui la soutiennent et des déclencheurs explicites de reconsidération.

Repository Intelligence est recalculé sur le SHA Git utilisé par Product ou par la tâche Implementer. Le contrôleur transmet un résumé borné de manifests, documents architecturaux, fichiers pertinents et symboles candidats. Cette séparation garde la recherche déterministe et auditée tout en évitant de demander au modèle de redécouvrir aveuglément le dépôt à chaque appel.

Pour les specs UI, la proposition design est un artefact de planification distinct, produit par Product avec `ui-design`. Elle est liée au hash d'approbation mais n'ajoute pas un cinquième rôle permanent.

## Inventaire du dépôt — indépendant de la stack

`ARCHITECTURE.md` documente l'intention (décisions, raisons, compromis). Il n'est écrit automatiquement qu'au bootstrap et ne sert pas d'inventaire. Ce qui existe réellement est calculé à chaque appel, sans modèle, par `src/knowledge/inventory.ts` sur le SHA exact :

- **Profils de langage déclaratifs** (`src/knowledge/languages.ts`) : extension de fichier, préfiltre `git grep` et grammaire de déclaration par ligne, avec une règle de surface publique (`marker`, `capitalized`, `not-underscore`, `unless-hidden`, `always`). Les profils intégrés couvrent des *langages* (ECMAScript, Python, Go, Rust, Java, Kotlin, C#, Ruby, PHP), jamais un framework.
- **Repli générique** : tout fichier texte d'une autre technologie (gabarits, composants, feuilles de style, DSL…) devient une *unité de fichier* nommée d'après son fichier. Aucune technologie n'est invisible et aucune n'exige de cas particulier dans le contrôleur. Documentation, données, configuration, assets et binaires sont exclus.
- **Profils projet** : `knowledge.languages` dans `pipeline.v2.json` ajoute ou remplace un profil, par exemple pour transformer une technologie interne en déclarations nommées.
- **Usage** : Product et Implementer reçoivent `repositoryIntelligence.inventory` (toute la surface publique bornée) en plus des `reuseCandidates` lexicaux, dont le classement découpe les identifiants (`borrowBook` → `borrow book`). QA reçoit `inventoryDelta` (ajouts, retraits et `possibleDuplicates` par nom normalisé entre base et candidat). Le review workspace contient `INVENTORY.md` et une section « Public surface changes ». `apv2 inventory --repo PATH` l'expose aux humains.

Limites : l'analyse est lexicale, ligne par ligne ; elle ne résout ni les ré-exports ni les déclarations multilignes exotiques, et un nom proche n'est qu'une invite de revue. Un test verrouille l'absence de nom de framework dans le code d'indexation.
