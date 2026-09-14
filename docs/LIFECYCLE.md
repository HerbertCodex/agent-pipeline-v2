# Parcours complet et exploitation

## Responsabilités

Setup propose la configuration sans exécuter les scripts du dépôt. Product clarifie et décompose une demande en spec. Implementer modifie le worktree autorisé et répond par un résumé. Le runner produit les reçus. QA examine le candidat intégré et les critères dans une invocation distincte, en lecture seule. Le moteur décide des transitions. L'opérateur approuve le plan, le périmètre et les changements selon la politique ; aucun résultat de modèle ne tient lieu de cet accord.

Les rôles Product et QA héritent de `config.agent` lorsque `config.roles.product` ou `.qa` vaut null. Ils peuvent utiliser un autre exécutable ou modèle. Ils ne sont pas nécessairement indépendants du point de vue statistique, institutionnel ou de leur identité. Les sessions sont distinctes ; les biais communs à un modèle ne sont pas éliminés.

## Installation

`onboard` retourne un document persistant de type install, son hash, l'inventaire, la configuration proposée et chaque fichier prévu avec son contenu précédent. Le plan est lié au chemin du dépôt et à sa base. `--assist` ajoute une passe Setup via le moteur configuré. Aucune écriture du projet n'est adoptée depuis le workspace de Setup.

`onboard show ID` permet de relire le plan. `onboard apply ID --hash HASH --reviewer NOM --note RAISON [--commit]` exige que toutes les questions soient résolues et que la base n'ait pas changé. Les liens symboliques et écrasements inattendus sont refusés. Les écritures sont restaurées en cas d'exception capturée ; une interruption machine au milieu des écritures de fichiers nécessite une inspection manuelle. Il n'est pas annoncé de transaction atomique entre SQLite et tous les fichiers du dépôt.

S'il faut changer une proposition, préparer un JSON de configuration revu puis produire un nouveau plan avec `onboard --config`. Aucun plan à questions ouvertes ne peut être forcé par l'agent. Il n'y a pas de commande d'upgrade automatique des fichiers déjà installés.

`doctor --execute` fait les vrais setups et tous les gates dans un worktree neuf de la base, sans appel à l'Implementer. Une sortie rouge est un blocage à traiter, pas un motif pour supprimer le test. Sans cette option, le contrôle est structurel. Doctor ne démontre pas à lui seul la couverture fonctionnelle ni l'efficacité des tests négatifs.

## Spec

Le schéma partagé est exporté dans `examples/schemas/spec.schema.json`. Une spec contient problème, périmètre, exclusions, critères identifiés et méthodes de vérification, décisions, questions et jusqu'à vingt tâches. Chaque tâche nomme ses critères et ses dépendances. Les critères doivent être couverts, les identifiants uniques et le graphe acyclique avant accord.

Le hash approuvé lie le contenu, sa révision, le dépôt, le commit initial et la configuration. Un raffinement incrémente la révision et annule l'accord, même si l'appel Product échoue ensuite. Une fois une tentative créée, l'historique n'est plus réécrit : il faut une spec suivante pour changer le besoin.

```bash
apv2 spec draft --repo /projet --request-file /besoin.txt
apv2 spec show ID --output /spec.md
apv2 spec refine ID --request "Réponses explicites"
apv2 spec approve ID --hash HASH --reviewer NOM --note RAISON
```

Une proposition externe peut être importée avec `--file` lors de draft/refine. Cette possibilité évite d'imposer un second appel Product lorsqu'un outil a déjà produit le contrat, sans contourner sa validation.

## Exécution et intégration

Les tâches s'exécutent dans un ordre topologique déterministe, une à la fois. La base de la tâche suivante est le candidat contrôlé de la précédente. Une dépendance échouée bloque la suite. Les avis humains des étapes intermédiaires sont différés à la revue de l'ensemble ; leurs contrôles ne sont pas supprimés.

Une tâche unique réutilise son run validé en tant que candidat final. Pour plusieurs tâches ou une réparation QA, le moteur crée un run de validation d'ensemble, sans réappeler l'agent pour reconstruire le code. Tous les gates de la configuration s'appliquent à cette intégration. Le niveau de risque ne peut pas diminuer par simple fusion des tâches.

Le store conserve séparément les tentatives d'implémentation et l'historique des validations d'ensemble. `spec events ID` retourne ces journaux avec une indication de source ; ils ne sont pas présentés comme une horloge globale transactionnelle entre services distants.

## QA

QA reçoit la spec approuvée, le diff intégré, le SHA exact et les reçus du runner. Son rapport doit inclure une assessment par critère (`pass`, `fail`, `unknown`) avec justification. `pass` global est impossible avec un critère inconnu/échoué ou un constat majeur/bloquant. Le schéma contrôle la structure et la cohérence du verdict, pas la véracité des observations du modèle.

Par défaut QA s'applique aux modes standard/high. Le contrôleur peut demander au même adaptateur une réparation à partir des constats, dans le périmètre approuvé, puis refaire les contrôles et une QA fraîche. `workflow.maxQaRepairs` borne cette boucle. Un manque produit ne doit pas être résolu par une hypothèse silencieuse. Les observations hors périmètre restent des observations.

```bash
# Pour confier la revue à un outil externe, sans désactiver son obligation :
apv2 spec run ID --manual-qa
apv2 spec qa ID --file /rapport-qa.json
apv2 spec run ID --manual-qa
```

Le rapport externe est explicitement importé et lié aux preuves présentes. Son auteur n'est pas authentifié par la CLI. Une nouvelle QA invalide les avis humains antérieurs.

## Revue humaine et revalidation

`spec review ID --sha SHA --reviewer NOM --note RAISON` approuve le candidat intégré. Standard requiert un libellé, high deux libellés distincts ; fast n'en requiert pas. Un agent n'est pas censé inventer ces accords. L'absence de SSO signifie néanmoins que le runner local ne sait pas vérifier cette identité.

`spec verify ID` relance la validation ; elle annule la QA, les avis humains et la livraison précédente. `spec run ID` reprend ensuite la QA et l'attente de revue. Une preuve expirée bloque la livraison ; ne pas modifier les timestamps du store pour l'utiliser.

## Échec, interruption et budget

`spec show` expose `activeRunId`, les processus connus et `error`. Si le contrôleur a été arrêté brutalement, vérifier que lui-même et ses enfants sont effectivement terminés, puis utiliser `spec recover ID --confirm-stopped`. Le budget inclut conservativement l'intervalle de crash ; il ne repart pas de zéro.

Une tentative d'agent dont l'issue est inconnue n'est pas réexécutée aveuglément. Après inspection du code conservé, `spec run ID --accept-current` autorise son adoption et sa validation, jamais son acceptation sans tests. Une tentative échouée ordinaire demande `spec retry ID --confirm` pour en créer une nouvelle ; l'échec reste dans l'historique. Un dépassement de périmètre ou un timeout ne devient pas une boucle automatique illimitée.

Product possède un timeout par appel et une requête bornée ; la préparation et l'attente humaine sont distinctes du budget actif des tâches/QA. `workflow.maxActiveMs` borne les sessions de workflow, `maxRunMs` les runs, et les processus ont leurs propres timeouts. Ces budgets ne mesurent pas les tokens ni les factures du fournisseur.

## Livraison locale et GitHub

`spec deliver` crée un nouveau répertoire hors source et store. Les hashes du manifeste sont des empreintes d'intégrité, pas des signatures par une autorité distante. Répéter une livraison identique vérifie les fichiers existants au lieu de les écraser.

`spec branch` crée une référence locale au candidat exact avec accord explicite. Le checkout source n'est pas changé. Sans GitHub, l'équipe peut intégrer cette branche dans son processus habituel. La clôture locale observe ensuite :

```bash
apv2 spec close ID --target integration-main --sha SHA_INTEGRE \
  --reviewer NOM --note "Fusion locale examinée"
```

La référence doit être une branche locale existante au SHA annoncé et avoir le candidat livré dans son ascendance. Un squash ne conserve pas cette ascendance : ce mode local est conservateur et ne rapproche pas arbitrairement deux patches. La clôture n'est pas une preuve de déploiement ni une garantie que la branche n'a pas introduit un autre défaut lors de l'intégration.

Le connecteur GitHub cible github.com, pas GitHub Enterprise Server/GitLab. `spec publish` exige destination explicite, `--confirm-push` et `--confirm-pr`. Il vérifie les URL fetch/push, la base distante et la tête attendue, ne fait pas de force push, et crée une PR brouillon. Une intention est enregistrée avant les effets externes. Après résultat réseau incertain, une nouvelle invocation recherche la PR existante avant de tenter de la recréer.

`spec sync` lit l'état GitHub. Une PR fermée sans fusion n'est pas clôturée comme livrée ; une tête étrangère est refusée. Une PR fusionnée au candidat attendu permet une clôture observée, avec SHA de fusion. Les stratégies de merge/squash et la CI sont sous la responsabilité de la forge. Le pipeline n'exécute jamais `gh pr merge` et ne rend pas la PR prête à fusionner automatiquement.

Les tests du connecteur utilisent un transport simulé. Aucun push, création de PR ou merge GitHub authentifié n'a été effectué pour cette livraison.

## Alpha.5 — cycle fluide et checkpoints humains

Le lifecycle distingue désormais validation machine et décision humaine. Les tâches intermédiaires utilisent `reviewRequired: false`; elles avancent après gates réussis. Une validation intégrée finale est ensuite créée avec `reviewRequired: true`, QA s'exécute selon `workflow.qaLanes`, puis seulement le candidat final est présenté à l'humain.

Pour une spec UI, `spec draft/refine` peut produire une proposition design avant approbation. Le hash affiché est un bundle spec + design. Aucun Implementer UI ne doit démarrer avec une proposition design requise mais non approuvée.

Les nouveaux fichiers compagnons non sensibles peuvent être admis dans une enveloppe bornée. Un écart structurel crée un amendement au lieu de jeter le candidat. L'amendement revalide le même candidat sur le `currentSha` de la spec.

Avant la revue finale, le contrôleur matérialise un workspace de revue frère du projet avec le candidat complet, le patch et la QA. Utiliser ce dossier pour la revue humaine plutôt que les worktrees internes du store.


## Alpha.6 — décisions autoritatives

Le bootstrap produit un Decision Ledger et une revue sémantique indépendante avant qu’un hash approuvable existe. Les questions `product` et `deferred` ne bloquent pas le scaffolding ; seules les questions `bootstrap` et les conflits sémantiques le font. Utiliser `bootstrap refine` pour poursuivre le même cadrage sans perdre les décisions confirmées.

Une spec alpha.6 est liée au hash du ledger. Les décisions `product` confirmées doivent être couvertes par des critères d’acceptation, sont transmises aux tâches concernées et doivent être évaluées dans `qa.decisionChecks`. Voir `docs/DECISIONS.md`.

## Alpha.7 — ambiguïté et résolution

Le bootstrap distingue désormais `confirmed` de `ambiguous`. Une formulation approval-with-exception à haut risque ne peut pas être confirmée silencieusement. Une ambiguïté `bootstrap` reste un vrai blocker ; une ambiguïté `product` peut être reportée à Product si le scaffold reste neutre.

Product doit reproduire la question de clarification enregistrée tant que l'ambiguïté n'est pas résolue. Une réponse ultérieure de l'opérateur devient une `decisionResolution` citée et couverte par des critères d'acceptation. La spec ne peut pas être approuvée avec une ambiguïté Product non résolue. Les résolutions sont propagées à Implementer et QA.

## Alpha.8 — sécurité dans le lifecycle

Avant Product, le contrôleur calcule un `SecurityContext` déterministe. Le contexte est persisté avec son hash et participe au hash de la spec : une évolution de la surface de sécurité invalide donc l'accord précédent.

Product reçoit ce contexte comme minimum. Les sujets OWASP routés doivent devenir des exigences de sécurité reliées à des critères d'acceptation. Quand requis, Product ajoute un threat model avec assets, frontières de confiance, menaces, mitigations et critères concernés. Les ambiguïtés métier suivent toujours le Decision Ledger ; la sécurité ne donne pas à Product le droit d'inventer une politique utilisateur.

Implementer reçoit uniquement les exigences et menaces liées aux critères de sa tâche. Le niveau de risque de la tâche peut être relevé par le minimum de sécurité. Le candidat final est ensuite évalué par QA, qui doit fournir un `securityChecks` pour chaque exigence de sécurité de la spec.

Un QA `pass` avec une exigence manquante, `unknown` ou `fail` est refusé par le contrôleur. Les receipts de scanners existants peuvent servir d'évidence, mais ne remplacent pas l'inspection du comportement et les tests négatifs requis.
