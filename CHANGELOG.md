# Changelog

## Non publié

- Réparation bornée des sorties de rôle (Setup, revue sémantique, Product, design, QA) : une violation du contrat du contrôleur réinvoque le rôle avec l’erreur exacte, jusqu’à `workflow.maxOutputRepairs` (défaut 1). Délais, annulations, refus de permission et échecs de processus ne sont jamais réessayés.
- Contexte de tâche ciblé : la proposition design associe écrans et tâches (`taskScopes`) ; une tâche ne reçoit que ses écrans, et aucune tâche sans travail visuel ne reçoit le design.
- Product reçoit `executionCapabilities` (outils réels de l’Implementer, setup, gates) et doit transformer les étapes impossibles (installation, lockfile, générateur) en prérequis opérateur.
- `requiresDesign` ne détecte plus l’interface par extensions de frameworks : `uiImpact` déclaré et vocabulaire générique uniquement.
- Nouvelles commandes `apv2 decisions plan|apply` (mise à jour du Decision Ledger liée à un hash, `supersedes` explicite), `apv2 gc [--confirm]` (nettoyage prudent, simulation par défaut) et `apv2 spec list --active`.
- Les commits candidats portent le titre de la tâche, avec un trailer `Agent-Pipeline-Run`.
- Tests de régression rejouant les échecs réels observés (vérification > 3000 caractères, markup refusé, SHA QA erroné, métadonnées de clarification sur une décision confirmée, délai dépassé).
- Ajoute un inventaire déterministe et indépendant de la stack (`src/knowledge/inventory.ts`) : profils de langage déclaratifs (extension, préfiltre, grammaire, règle de surface publique) et repli en unités de fichier pour toute autre technologie texte, sans nom de framework dans le contrôleur (verrouillé par un test).
- `knowledge.languages` dans `pipeline.v2.json` permet d’ajouter ou de remplacer un profil de langage.
- Repository Intelligence transmet `inventory` (toute la surface publique bornée) à Product et Implementer ; `reuseCandidates` découpe les identifiants (camelCase, snake_case, chemins) et monte à 40.
- QA reçoit `inventoryDelta` (ajouts, retraits, `possibleDuplicates`) et doit signaler une réimplémentation injustifiée d’un comportement existant comme constat `major`.
- Le review workspace ajoute `INVENTORY.md` et une section « Public surface changes » dans `REVIEW.md` ; nouvelle commande `apv2 inventory`.
- Product doit inclure le document d’architecture existant dans une tâche lorsqu’une spec change frontières, interfaces publiques, persistance, authentification/autorisation, conventions ou une décision enregistrée.
- Régénère `examples/schemas/config.schema.json` et `task.schema.json`.

## 2.0.0-alpha.8

- Ajoute un `SecurityProfile` / `SecurityContext` déterministe qui route les surfaces sensibles vers un catalogue OWASP Cheat Sheet borné sans prétendre à une conformité OWASP.
- Product doit relier chaque sujet OWASP routé à des exigences de sécurité et critères d’acceptation vérifiables ; une spec ne peut plus supprimer silencieusement un sujet ou réduire une surface détectée.
- Ajoute un threat model conditionnel (assets, trust boundaries, menaces, mitigations, critères) et des tests négatifs/adversariaux obligatoires lorsque les surfaces l’exigent.
- Le contexte de sécurité peut relever la lane minimale jusqu’à `high` pour auth/authorization, données sensibles, uploads, requêtes sortantes, multi-tenant, secrets, CI/CD, dépendances et agents/MCP.
- QA ajoute `securityChecks`; un verdict `pass` est refusé si une exigence sécurité est absente, en échec ou inconnue.
- Onboarding découvre les scripts de sécurité existants (`security:*`, `audit:*`, `sast*`, `semgrep*`, `gitleaks*`, `trivy*`, etc.) sans inventer ou installer un scanner absent.
- Ajoute les sujets OWASP supply-chain, GitHub Actions, AI Agent Security, LLM Prompt Injection Prevention, Secure Coding with AI et MCP Security.
- Renforce le trust model : dépôt, issues/PR, logs, documentation récupérée et descriptions d’outils/MCP sont explicitement des données non fiables dans Product, Implementer, QA, Codex et Claude.
- Lie le hash de spec au `SecurityContext`, expose les schémas `security-context` et `security-plan`, et ajoute `docs/OWASP-SECURITY.md`.
- Durcit le workflow GitHub Actions livré : permissions lecture seule, credentials checkout non persistés, action refs épinglées sur des commits et matrice `fail-fast: false`.
- Conserve le correctif macOS de canonicalisation des racines Git par `realpathSync`.

## 2.0.0-alpha.7

- Ajoute le statut de décision `ambiguous` avec question de clarification et interprétations plausibles ; une ambiguïté n'est plus traitée comme une décision confirmée.
- Ajoute un tripwire déterministe pour les formulations d'approbation avec exception (« je valide … sauf … », « I approve … except … ») afin d'empêcher une inclusion/exclusion silencieuse.
- Une ambiguïté `bootstrap` bloque seulement si elle empêche le socle ; une ambiguïté `product` peut traverser un bootstrap neutre sans déclencher de micro-validation prématurée.
- Ajoute `decisionResolutions` aux specs : Product ne peut résoudre une ambiguïté qu'avec une citation exacte d'une réponse opérateur ultérieure, puis doit la relier à des critères d'acceptation.
- Implementer reçoit les décisions Product résolues et QA doit les contrôler dans `decisionChecks` au même titre que les décisions confirmées.
- Renforce `bootstrap refine` : une décision ambiguë précédente ne peut ni disparaître ni changer de statut sans remplacement explicite (`supersedes`) provenant du dernier refinement.
- Renforce le rôle Setup pour ne pas faire de Product : règles métier, hébergement, CI, email transactionnel et détails outillage différables ne deviennent pas des blockers sans nécessité réelle.
- Diffère la génération du design tant que Product conserve des questions ouvertes, afin de ne pas maquetter une interprétation métier encore non résolue.

## 2.0.0-alpha.6

- Ajoute un **Decision Ledger autoritatif** : les décisions explicites de l’opérateur sont persistées avec identifiant stable, valeur, niveau d’application et citation source.
- Sépare les décisions `bootstrap`, `product` et `deferred` afin que seules les vraies décisions techniques bloquantes arrêtent le scaffolding.
- Ajoute une **revue sémantique indépendante du bootstrap** : une proposition JSON structurellement valide reste non approuvable si elle omet ou contredit une décision confirmée, affaiblit une relation métier, change l’authentification choisie ou revendique des scripts/fonctions non soutenus par les fichiers.
- Ajoute `bootstrap refine PLAN_ID --request ...` pour conserver le même plan et le même ledger pendant le cadrage ; une décision confirmée ne peut être remplacée silencieusement.
- Lie les specs au hash du Decision Ledger. Product doit mapper chaque décision `product` confirmée vers des critères d’acceptation via `decisionCoverage`.
- QA doit produire `decisionChecks` pour toutes les décisions produit confirmées ; un verdict `pass` est impossible si une décision est oubliée, en échec ou inconnue.
- Propagation du ledger jusqu’à Implementer : les décisions pertinentes sont incluses dans le contexte de la tâche afin d’éviter les placeholders ou contrats incompatibles avec le MVP approuvé.
- Exporte les nouveaux schémas `decision-ledger`, `semantic-review` et le contrat bootstrap enrichi.

## 2.0.0-alpha.5

- Rend le cycle fluide par défaut : les tâches intermédiaires n'attendent plus une revue humaine ; la revue se fait sur le candidat intégré final après QA.
- Ajoute `workflow.reviewMode` (`solo`, `team`, `regulated`) et `--review-mode`, choisi une fois au bootstrap/onboarding. Un projet solo n'invente jamais un second reviewer.
- Ajoute une phase design pour les specs UI : Product + `ui-design` produisent une maquette HTML/CSS locale, liée au hash d'approbation de la spec avant tout code UI.
- Ajoute Repository Intelligence : scan borné par SHA des manifests, fichiers d'architecture et symboles réutilisables, fourni à Product et Implementer avant création de nouvelles abstractions.
- Les propositions bootstrap doivent expliquer les décisions d'architecture, preuves, alternatives, compromis et conditions de révision ; le résultat est persisté dans `.agent-pipeline/ARCHITECTURE.md`.
- Ajoute un périmètre fluide : nouveaux fichiers compagnons non sensibles dans le même module peuvent être acceptés automatiquement dans une enveloppe bornée ; les écarts structurants passent par un amendement auditable qui conserve le candidat courant.
- Ajoute un workspace de revue visible à côté du projet avec candidat ouvrable, patch, QA et résumé des gates avant approbation finale.
- Détection SvelteKit améliorée : projet `frontend`, `npm run check`/tests/lint reconnus sans révision manuelle du plan.
- Les approbations lifecycle peuvent utiliser `--approve` : identité d'audit dérivée de Git quand possible et note standard, sans phrase cérémonielle imposée.

## 2.0.0-alpha.4

- Ajoute `bootstrap` pour les dépôts Git sans commit et les dossiers réellement vides.
- Setup propose un manifeste structuré sans toucher au dépôt ; chemins et taille sont bornés.
- `bootstrap apply --commit` exige l’approbation du hash, écrit le socle, crée le premier commit puis génère le plan `onboard`.
- Aucun setup ou test du nouveau projet n’est exécuté pendant le bootstrap ; `doctor --execute` reste une autorisation séparée.


## 2.0.0-alpha.3

- README et START-HERE accessibles depuis un clone/ZIP public, sans artefact de conversation préalable.
- Quatre fichiers Markdown canoniques de rôles, lus réellement par le moteur et partagés avec les guides générés.
- Six skills adaptés de la V1, 40 références, routage déterministe, budget de contexte et empreintes dans les événements.
- Commandes roles, skills list/show/resolve, providers et inspect ; diagnostic des guides modifiés sans écrasement.
- Adaptateur Claude Code natif pour les quatre rôles, JSON structuré validé, outils restreints et budgets configurables ; aucun contournement de permissions.
- Choix onboard --provider ; exemples de profils Codex/Claude et d'un projet utilisant des fournisseurs différents par rôle.
- QA reçoit le vrai diff, refuse un contexte dépassant 512 Kio plutôt que d'ignorer des changements.
- Tests contractuels des deux fournisseurs et cycle complet avec doublures, sans revendication de pilote authentifié.
- Anciennes configs : aucun nouveau skill activé silencieusement ; migration explicite entre specs.


## 2.0.0-alpha.2

Ajout du cycle local de la configuration à l'observation de l'intégration : onboarding déterministe/assisté avec plan haché, préservation d'AGENTS.md, guides de rôles, doctor explicite, Product draft/refine, approbation de spec, graphe de tâches, QA intégrée et réparations bornées. Une tâche unique réutilise ses contrôles ; plusieurs tâches ont une validation d'ensemble et une revue humaine finale.

État documentaire durable et migration SQLite 1 → 2, reprise après crash et enfants journalisés, budgets de spec, retry explicite, invalidation de QA/revues sur revalidation. Livraison patch/preuves/manifeste, branche locale consentie, publication GitHub brouillon à double consentement et réconciliation de merge, sans force push ni fusion/déploiement automatique.

Schémas de transport Codex limités au vocabulaire Structured Outputs supporté ; parsing runtime complet conservé. Démonstration bout en bout CLI avec acteurs déterministes, tests de refus et véritable SIGKILL. Documentation de démarrage par prompt, capacités et limites actualisée. Pas de test fournisseur ou forge authentifié, pas d'annonce de performance sur des tâches réelles.

## 2.0.0-alpha.1

Premier noyau TypeScript de tâches : états, SQLite hors dépôt, worktrees, contrôles en graphe, preuves/cache conservateur, modes fast/standard/high, budgets, réparations, revue locale et patch. Adaptateurs command/Codex ; 155 tests déclarés dans la livraison précédente. Product, specs, onboarding assisté et publication étaient hors périmètre.
