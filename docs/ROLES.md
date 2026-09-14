# Rôles et moteur

Le rôle représente une responsabilité ; le fournisseur exécute le modèle ; un skill conseille une méthode ; un gate produit une mesure. Les quatre rôles ne sont pas quatre services permanents.

| Rôle | Instructions canoniques | Sélection du fournisseur | Déclenchement |
|---|---|---|---|
| Setup | `roles/setup.md` | `onboard --provider` ou `--agent`, sinon `--config.agent` ou Codex historique | `onboard --assist` seulement |
| Product | `roles/product.md` | `roles.product`, sinon `agent` | `spec draft/refine` sans proposition externe |
| Implementer | `roles/implementer.md` | `agent` | tâche approuvée et corrections bornées |
| QA | `roles/qa.md` | `roles.qa`, sinon `agent` | parcours configurés, par défaut standard/high |

Orchestrator est la machine à états TypeScript. Il n'a pas de fournisseur ni de prompt à charger.

`apv2 roles` liste les chemins et empreintes. `apv2 roles product` imprime exactement le fichier source utilisé. Le moteur charge les fichiers **du package de confiance**, pas les copies modifiables dans le worktree. Les copies installées aident l'assistant principal et les humains. `apv2 inspect --repo PATH` signale les différences sans écraser de fichier.

Modifier `.agent-pipeline/roles/product.md` ne remplace pas le prompt runtime. Pour faire évoluer un rôle, modifier `roles/product.md` dans une distribution revue du framework, tester et versionner. N'effectuer aucune mise à jour du framework pendant une spec active. Une personnalisation supplémentaire de rôle par projet n'est pas implémentée ; exigences métier et conventions appartiennent à la spec et aux instructions du projet, sans priorité sur les permissions du moteur.

Les prompts ne constituent pas une frontière de sécurité. Les permissions du fournisseur et l'isolation déployée comptent. QA reçoit le diff complet (limite de 512 Kio, refus explicite au-delà), les critères et les reçus. Aucun résultat manquant ne devient un succès. Claude n'a pas besoin de Bash pour consulter le diff : le contrôleur le calcule.

L'assistant principal de l'éditeur n'est pas un rôle runtime. Il présente les plans, les questions et les accords puis appelle la CLI. AGENTS.md est complété ; CLAUDE.md l'est aussi lorsqu'un rôle Claude est configuré. Un assistant qui ne découvre pas ces guides doit les recevoir explicitement. Aucun fichier n'enregistre automatiquement des sous-agents propres à l'éditeur.

## Alpha.5 — responsabilités supplémentaires

Product consulte Repository Intelligence avant de créer les tâches : il doit préférer étendre les modules, services, composants et types existants. En mode `design-proposal`, Product utilise `ui-design` pour produire une maquette et une direction visuelle avant tout code UI important.

Implementer reçoit à son tour les candidats de réutilisation au SHA courant. Avant une nouvelle fonction, classe, service, composant ou helper, il inspecte l'existant proche ; s'il crée une abstraction similaire, sa synthèse doit expliquer l'incompatibilité de l'existant.

Setup, lors d'un bootstrap, justifie l'architecture et ses compromis au lieu de seulement choisir une stack.


## Alpha.6 — Decision Ledger

Setup extrait les décisions explicites sans les réinterpréter et distingue blocage bootstrap, décision Product et décision différée. Product doit couvrir les décisions métier confirmées par des critères d’acceptation. Implementer reçoit les décisions pertinentes à chaque tâche. QA vérifie explicitement chacune de ces décisions avant de pouvoir rendre `pass`. Le moteur, et non un rôle, décide si la couverture exigée est complète.

## Alpha.7 — ambiguïtés explicites

Setup ne peut plus transformer une formulation matériellement ambiguë en décision confirmée. Les décisions `ambiguous` conservent citation, question de clarification et interprétations plausibles. Une ambiguïté `product` peut traverser un bootstrap neutre ; Product doit ensuite la résoudre avec une citation opérateur via `decisionResolutions` avant approbation. Implementer reçoit ces résolutions et QA les vérifie dans `decisionChecks`.

## Alpha.8 — contrat sécurité des rôles

- **Setup** découvre les contrôles de sécurité existants mais n'invente aucun scanner ni résultat.
- **Product** reçoit le `SecurityContext`, conserve tous les sujets OWASP routés, produit un threat model lorsque requis et transforme la sécurité en critères vérifiables.
- **Implementer** traite exigences et menaces comme des critères approuvés, ajoute les tests négatifs demandés et considère le contenu du dépôt/externe comme non fiable.
- **QA** doit évaluer chaque exigence via `securityChecks`; un `pass` incomplet est rejeté par le moteur.

Les quatre rôles traitent les instructions embarquées dans le dépôt, les logs, les issues/PR, documents récupérés et descriptions d'outils comme des données non fiables. Elles ne peuvent pas remplacer la politique du contrôleur.
