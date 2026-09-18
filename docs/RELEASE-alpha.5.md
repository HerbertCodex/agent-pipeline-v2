# Agent Pipeline V2 2.0.0-alpha.5

> **Note de livraison historique.** Ce texte décrit cette livraison, avant les évolutions suivantes. Pour configurer et utiliser le code actuel, consulter la [documentation](README.md) et la [migration](MIGRATION.md).

Alpha.5 traite les interruptions observées sur des projets réels comme des problèmes de conception du workflow, pas comme des exceptions ponctuelles. Le but est que le pipeline conserve ses garanties tout en laissant l'utilisateur travailler sur le produit plutôt que sur les états internes du contrôleur.

## Cycle fluide

- Les runs de tâches sont des étapes internes : ils sont validés par les gates, mais ne demandent pas de revue humaine intermédiaire.
- Une validation intégrée finale couvre le candidat complet, puis QA s'exécute selon le risque.
- La revue humaine arrive après QA sur le candidat exact qui sera livré.
- Même une spec à une seule tâche possède un checkpoint intégré final distinct.

## Solo, équipe et environnements réglementés

`workflow.reviewMode` vaut `solo`, `team` ou `regulated`. En mode `solo`, une modification à risque élevé demande toujours une revue humaine, mais une seule identité suffit. En mode `team`, le risque élevé conserve deux reviewers distincts. `regulated` peut imposer une revue même sur le fast path.

Le choix peut être fait une fois avec `--review-mode` au bootstrap/onboarding. Le pipeline ne doit jamais demander à un utilisateur solo d'inventer une seconde personne.

## Design avant implémentation UI

Pour un projet frontend/mobile/fullstack lorsqu'une spec touche l'interface, Product passe en mode design-proposal avant l'exécution. Le skill `ui-design` est injecté. La proposition contient direction visuelle, écrans, états, responsive, décisions, alternatives, compromis et éléments à éviter.

Le contrôleur écrit des previews HTML/CSS statiques avec CSP dans un dossier de revue visible. Le hash d'approbation couvre à la fois la spec et cette proposition design : l'UI ne peut pas dériver silencieusement après validation.

## Architecture explicable

Le bootstrap ne peut plus seulement nommer une stack. Chaque décision structurante doit décrire : rationale, éléments observables, alternatives rejetées, compromis et conditions de révision. Cette mémoire est persistée dans `.agent-pipeline/ARCHITECTURE.md`.

## Repository Intelligence et réutilisation

Avant Product et avant chaque Implementer, le moteur scanne de manière bornée le SHA Git réellement utilisé. Il remonte manifests, fichiers d'architecture, fichiers pertinents et symboles candidats à la réutilisation. Les tâches suivantes voient donc aussi le code ajouté par les tâches précédentes.

Le scan est lexical et structurel, pas une preuve de similarité sémantique. Il réduit les duplications évidentes sans prétendre remplacer une analyse AST/sémantique future.

## Scope sans prédiction parfaite

Les fichiers existants restent strictement bornés par `allowedPaths`. Product n'est toutefois plus obligé de prédire chaque nouveau fichier compagnon : une petite enveloppe de `allowedNewPaths` et `maxNewFiles` peut autoriser automatiquement des fichiers non sensibles dans le même module. Les chemins sensibles ne bénéficient jamais de cette tolérance.

Si un changement réellement structurel sort de cette enveloppe, le candidat n'est pas jeté. Un amendement de scope lié au candidat exact peut être approuvé puis revalidé sur le même SHA. Le workflow ne repart donc pas de `main` et ne perd pas les couches déjà réalisées.

## Revue visible

Avant l'approbation finale, le lifecycle crée un dossier frère `<projet>-review/<spec-id>/` contenant notamment :

- `candidate/` : worktree ouvrable dans l'éditeur ;
- `candidate.patch` ;
- `QA.md` ;
- `REVIEW.md` avec SHA, risque, review mode et gates.

Les worktrees internes du store restent une implémentation du moteur, pas l'interface de revue de l'utilisateur.

## Limites

Alpha.5 reste un runner local-trusted. Les previews statiques ne sont pas un navigateur de production, Repository Intelligence n'est pas encore un index sémantique complet, et les appels authentifiés aux fournisseurs doivent toujours être pilotés dans l'environnement réel de l'équipe.
