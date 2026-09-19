# Parcours complet et exploitation

Pour les modes abonnement/facturé, les amendements `null`, les diagnostics et les durées : [politique d’exécution](EXECUTION-POLICY.md).

## Responsabilités

Setup propose la configuration sans exécuter les scripts du dépôt. Product clarifie et décompose une demande en spec. Implementer modifie le worktree autorisé et répond par un résumé. Le runner produit les reçus. QA examine le candidat intégré et les critères dans une invocation distincte, en lecture seule. Le moteur décide des transitions. L'opérateur approuve le plan, le périmètre et les changements selon la politique ; aucun résultat de modèle ne tient lieu de cet accord.

Les rôles Product et QA héritent de `config.agent` lorsque `config.roles.product` ou `.qa` vaut null. Ils peuvent utiliser un autre exécutable ou modèle. Ils ne sont pas nécessairement indépendants du point de vue statistique, institutionnel ou de leur identité. Les sessions sont distinctes ; les biais communs à un modèle ne sont pas éliminés.

Le démarrage avec `--models FILE` fixe quick/deep et une QA dédiée. `workflow.qaProfile: "deep"` conserve cette revue approfondie pour toutes les lanes où QA est requise. Les contrôles de compatibilité, la migration et les amendements par rôle sont décrits dans [Modèles](MODELS.md).

## Installation

`onboard` retourne un document persistant de type install, son hash, l'inventaire, la configuration proposée et chaque fichier prévu avec son contenu précédent. Le plan est lié au chemin du dépôt et à sa base. `--assist` ajoute une passe Setup via le moteur configuré. Aucune écriture du projet n'est adoptée depuis le workspace de Setup.

`onboard show ID` permet de relire le plan. `onboard apply ID --hash HASH --reviewer NOM --note RAISON [--commit]` exige que toutes les questions soient résolues et que la base n'ait pas changé. Les liens symboliques et écrasements inattendus sont refusés. Les écritures sont restaurées en cas d'exception capturée ; une interruption machine au milieu des écritures de fichiers nécessite une inspection manuelle. Il n'est pas annoncé de transaction atomique entre SQLite et tous les fichiers du dépôt.

S'il faut changer une proposition, préparer un JSON de configuration revu puis produire un nouveau plan avec `onboard --config`. Aucun plan à questions ouvertes ne peut être forcé par l'agent. Il n'y a pas de commande d'upgrade automatique des fichiers déjà installés.

`doctor --execute` fait les vrais setups et tous les gates dans un worktree neuf de la base, sans appel à l'Implementer. Une sortie rouge est un blocage à traiter, pas un motif pour supprimer le test. Sans cette option, le contrôle est structurel. Doctor ne démontre pas à lui seul la couverture fonctionnelle ni l'efficacité des tests négatifs.

## Choisir le parcours

Les nouvelles configurations `init`/onboarding proposent `workflow.planningMode: "adaptive"`. Une configuration antérieure sans ce champ conserve `legacy`. Sur un nouveau brouillon, `spec draft --pathway auto|standard|structural` active le parcours adaptatif ; les signaux sensibles peuvent renforcer une préférence `standard`.

| Parcours | Entrée et étapes |
| --- | --- |
| Compact | `spec compact --repo PATH --request TEXT --file task.json` : tâche précise, approbation, implémentation, contrôles et revue configurée. |
| Standard | `spec draft` en mode adaptatif : Product court, implémentation, contrôles, QA ciblée indépendante. |
| Structurant | Sélection automatique sur signaux structurants/sensibles, ou `--pathway structural` : exploration et décision d'architecture, plan, implémentation, validation renforcée et QA complète. |

Compact exige un contrat `Task` avec critères et chemins précis, sans appel Product. Il refuse les surfaces structurelles ou sensibles connues. L'exemption de QA modèle est revérifiée sur le diff final et n'existe pas en mode `regulated`. Les contrôles déterministes et les preuves requises par `qualityReview: "evidence"` s'appliquent dans tous les parcours.

## Spec

Le schéma partagé est exporté dans `examples/schemas/spec.schema.json`. Une spec complète contient problème, périmètre, exclusions, critères identifiés et méthodes de vérification, décisions, questions et jusqu'à vingt tâches. Le contrat Product court du parcours standard borne sa réponse à trois tâches et douze critères. Chaque tâche nomme ses critères et ses dépendances. Les critères doivent être couverts, les identifiants uniques et le graphe acyclique avant accord.

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

Le moteur crée un run de validation d'ensemble, sans rappeler l'agent pour reconstruire le code. Une tâche unique peut lui transmettre ses reçus si les identités, la fraîcheur et le plan complet correspondent ; sinon les contrôles sont rejoués. Toutes les gates de la configuration s'appliquent à cette intégration. Le niveau de risque ne peut pas diminuer par simple fusion des tâches.

Le store conserve séparément les tentatives d'implémentation et l'historique des validations d'ensemble. `spec events ID` retourne ces journaux avec une indication de source ; ils ne sont pas présentés comme une horloge globale transactionnelle entre services distants.

## QA

QA reçoit la spec approuvée, le diff intégré, le SHA exact et les reçus du runner. Son rapport doit inclure une assessment par critère (`pass`, `fail`, `unknown`) avec justification. `pass` global est impossible avec un critère inconnu/échoué ou un constat majeur/bloquant. Le schéma contrôle la structure et la cohérence du verdict, pas la véracité des observations du modèle.

En planification `legacy`, QA suit `workflow.qaLanes` (standard/high par défaut). Les parcours adaptatifs standard et structural exigent QA ; compact possède uniquement l'exemption conditionnelle décrite plus haut. Le contrôleur peut demander au même adaptateur une réparation à partir des constats, dans le périmètre approuvé, puis refaire les contrôles et une QA fraîche. `workflow.maxQaRepairs` borne cette boucle. Un manque produit ne doit pas être résolu par une hypothèse silencieuse. Les observations hors périmètre restent des observations.

```bash
# Pour confier la revue à un outil externe, sans désactiver son obligation :
apv2 spec run ID --manual-qa
apv2 spec qa ID --file /rapport-qa.json
apv2 spec run ID --manual-qa
```

En mode `qualityReview: "evidence"`, QA ajoute les six axes de qualité et les références de tests négatifs. Les preuves requises sont vérifiées avant son appel puis avant revue/livraison. Une preuve manquante ou un statut `unknown` bloque avec `QA_EVIDENCE` sans réparation automatique de code. L'opérateur qui a inspecté la preuve manquante peut autoriser exactement une réparation avec `apv2 spec qa-repair SPEC_ID --confirm --note TEXT` : elle exige que chaque contrôle configuré ait déjà prouvé ce candidat, elle est consommée par la réparation qu'elle autorise, et la revue suivante doit toujours conclure sur ses propres preuves. Voir [la grille et les preuves](QUALITY.md).

Le rapport externe est explicitement importé et lié aux preuves présentes. Son auteur n'est pas authentifié par la CLI. Une nouvelle QA invalide les avis humains antérieurs.

## Revue humaine et revalidation

`spec review ID --sha SHA --reviewer NOM --note RAISON` approuve le candidat intégré. Les seuils dépendent de `workflow.reviewMode` : `solo` exige zéro/un/un avis pour fast/standard/high ; `team` zéro/un/deux ; `regulated` un/un/deux. Les deux avis éventuels doivent avoir des libellés distincts. Un agent n'est pas censé inventer ces accords. L'absence de SSO signifie néanmoins que le runner local ne sait pas vérifier cette identité.

`spec verify ID` relance la validation ; elle annule la QA, les avis humains et la livraison précédente. `spec run ID` reprend ensuite la QA et l'attente de revue. Une preuve expirée bloque la livraison ; ne pas modifier les timestamps du store pour l'utiliser.

## Échec, interruption et budget

`spec show` expose `activeRunId`, les processus connus et `error`. Si le contrôleur a été arrêté brutalement, vérifier que lui-même et ses enfants sont effectivement terminés, puis utiliser `spec recover ID --confirm-stopped`. Le budget inclut conservativement l'intervalle de crash ; il ne repart pas de zéro.

Un agent qui s'arrête sans rendre son résultat (limite de tours ou de budget du fournisseur, délai, sortie illisible) laisse une tentative **interrompue**, pas un échec définitif : ses fichiers restent dans l'espace de travail du run, que `spec show` indique. L'opérateur les relit, puis adopte ce travail avec `spec run ID --accept-current` — il est alors enregistré puis soumis aux contrôles, à la QA et à sa revue — ou le jette avec `spec retry ID --confirm`, qui repart de la base approuvée avec le diagnostic de l'arrêt. Rien n'est adopté sans cette décision.

Une tentative d'agent dont l'issue est inconnue n'est pas réexécutée aveuglément. Après inspection du code conservé, `spec run ID --accept-current` autorise son adoption et sa validation, jamais son acceptation sans tests. Une tentative échouée ordinaire demande `spec retry ID --confirm` pour en créer une nouvelle ; l'échec reste dans l'historique. Un dépassement de périmètre ou un timeout ne devient pas une boucle automatique illimitée.

Après `REPAIR_NO_CHANGE`, les diagnostics des contrôles restent attachés au candidat inchangé. `spec retry` les transmet à la nouvelle tentative. Pour les anciens runs dont la liste de reçus a été effacée, le contrôleur retrouve les erreurs persistées de la dernière validation du même candidat. `spec show` expose ces observations dans `failedChecks` ; cette récupération ne constitue jamais une preuve de validation réussie.

Après approbation d'un amendement de périmètre, le candidat conservé est d'abord **revalidé sans réparation automatique**. Si un contrôle échoue, `spec retry ID --confirm` crée une nouvelle tentative avec les diagnostics et la configuration approuvée de la spec, y compris son `maxRepairAttempts`. Le zéro temporaire de la revalidation ne se propage pas à cette tentative. Une limite zéro dans la spec reste applicable.

Une autorisation permanente limitée aux appelants et tests ne signifie pas « tous les fichiers existants ». Avant d'approuver un amendement dans ce cadre, examiner le diff du candidat et les références concernées : chaque ajout doit être nécessaire au changement approuvé. Réutiliser une autorisation déjà donnée lorsqu'elle s'applique ; si le lien n'est pas établi, ne pas l'inférer de `existsSync`, d'un nom de fichier ou du seul résumé de l'agent. Les consignes Product et les avis d'impact aident à préparer ce périmètre sans garantir l'exhaustivité des dépendances.

### Réviser les tâches restantes

Si le découpage est en cause, `spec replan` permet de corriger le plan d'une spec bloquée sur une tâche en échec définitif, sans relancer Product ni refaire les tâches validées. Préparer un fichier conforme à [replan.schema.json](../examples/schemas/replan.schema.json), avec `reason` et `tasks` : copier **toutes les tâches restantes** de `spec show`, puis ajuster leurs descriptions, chemins et dépendances. Les identifiants et critères associés sont conservés ; le niveau de risque peut augmenter, jamais diminuer.

```bash
apv2 spec replan ID --file remaining-tasks.json
# Relire la proposition, notamment les nouveaux chemins, puis son hash exact :
apv2 spec replan ID --amendment AMENDMENT_ID --hash HASH --approve \
  --note "Garder une API compatible jusqu'à la migration des appelants"
apv2 spec run ID
```

La reprise part du dernier commit validé ; le code de la tentative échouée reste consultable dans son run. Les tâches terminées, tentatives, coûts, budgets et amendements approuvés sont conservés. Le plan et l'approbation précédents restent dans l'historique. La validation finale, QA et revue doivent porter sur le nouveau plan et son candidat. Une proposition périmée est refusée.

Cette commande de terminal ne change ni les critères métier, ni l'architecture, ni la maquette, ni les commandes et gates. Elle ne fusionne pas de tâches et n'en supprime pas : pour un découpage trop étroit, élargir explicitement les chemins de la tâche concernée et adapter les consignes des tâches suivantes. Résoudre les amendements de périmètre ou de critère en attente avant de l'utiliser. Une spec publiée ou livrée ne peut pas être révisée ainsi.

Un rôle et ses réparations de sortie partagent une échéance. Product et Design consomment le budget actif de la spec, comme l'exécution et QA ; l'attente humaine en est exclue. Les tokens et coûts publiés sont journalisés, et les valeurs absentes restent inconnues. `workflow.maxSpecCostUsd` est vérifié avant les appels et limite aussi le budget restant de chaque appel Claude. Voir [les limites exactes](CONFIGURATION.md#limites-de-temps-de-tours-et-de-coût).

`spec plan-resume ID` reprend une planification arrêtée avec ses checkpoints compatibles. Il peut éviter de refaire Product si la spec était déjà acceptée avant l'échec de Design. Il ne récupère pas une réponse jamais reçue et ne reprend pas un thread natif du fournisseur.

Pour ajuster une allocation sans modifier le périmètre, préparer un fichier `limits.json`, par exemple `{"maxSpecCostUsd": 30, "maxActiveMs": 5400000}`, puis :

```bash
apv2 spec budget ID --file limits.json --approve --note "Allocation revue pour terminer"
apv2 spec plan-resume ID
```

Les valeurs sont des plafonds totaux, travail déjà consommé compris. Après un arrêt d'exécution, utiliser l'action indiquée par `spec show` plutôt que `plan-resume`. L'amendement peut régler modèle, effort, tours et timeout, ainsi que `maxOutputRepairs` : le nombre de reprises accordées quand un rôle renvoie une sortie malformée — un rapport illisible ne dit rien du candidat, et réessayer sa mise en forme n'abaisse jamais ce qu'il doit prouver. Côté contrôles, seulement ce qui relève de l'exécution : ajouter un contrôle (`gates.add`), déclarer une ressource partagée qui en sérialise plusieurs (`gates.resources`), relever un délai (`gates.timeoutMs`). Il ne peut ni changer une commande, des permissions, le périmètre, ni ce qu'un contrôle prouve (`covers`, `testPaths`, `lanes`, `mandatory`), ni supprimer un contrôle : ces cas exigent une nouvelle spec. Un run épuisé peut exiger une nouvelle tentative. L'ancien `spec run --accept-cost` autorise un dépassement du plafond global pendant cette exécution ; préférer une allocation chiffrée.

Les amendements de gates sont validés ensemble (dépendances et cycles inclus) avant sauvegarde. Ils s’appliquent aux nouvelles tentatives, aux revalidations de périmètre et à l’intégration finale. Un run déjà créé garde sa configuration : utiliser une nouvelle tentative pour lui appliquer les nouveaux réglages. Toute modification des gates invalide la validation finale et la revue ; `spec run` reconstruit les preuves et la QA avant livraison. Les gates ne sont plus amendables après publication ou livraison.

## Tableau de bord

`apv2 ui [--port N]` (port 4711 par défaut) ouvre un tableau de bord local sur le magasin : toutes les specs par dépôt, leur statut, le hash à approuver et l'action suivante ; le détail d'une spec (périmètre, critères avec le verdict QA et les corrections, tâches avec leurs tentatives et leurs contrôles, rapport QA, maquettes, amendements, avertissement sur les tests impactés) ; l'activité des agents en direct ; les opérations lancées et la maintenance.

Le magasin est commun à tous les dépôts. La barre latérale liste les projets, avec pour chacun le nombre de specs actives et de décisions en attente ; choisir un projet restreint l'accueil, la liste et le dépôt proposé pour une nouvelle spec. Ce choix est retenu par le navigateur.

Actions disponibles : nouveau brouillon, affinage ou réponse aux questions, approbation de la spec, exécution, revalidation, nouvelle tentative, approbation d'un amendement de périmètre ou d'une correction de critère, revue du candidat, synchronisation avec la PR, rejet, nettoyage des espaces de travail. La purge de l'historique reste une commande de terminal. Les opérations longues (brouillon, affinage, exécution, revalidation, synchronisation) partent en processus CLI séparés, qui continuent si la page ou le serveur s'arrêtent.

Sécurité :
- écoute sur `127.0.0.1` uniquement ; l'en-tête `Host` doit désigner ce serveur (protection contre le *DNS rebinding*) ;
- l'adresse affichée au démarrage contient un jeton à usage d'entrée, échangé contre un cookie `HttpOnly; SameSite=Strict` puis retiré de la barre d'adresse ; ne la partagez pas ;
- chaque action exige en plus le jeton anti-CSRF de la page et une origine identique ; le corps est borné ;
- une approbation porte sur le hash ou le SHA exact affiché, exige une note, et enregistre comme relecteur l'identité Git du dépôt (`user.name`), préfixée « [tableau de bord] » ;
- les maquettes sont servies en *sandbox* (origine opaque, sans script ni cookie), et seulement les fichiers d'écran de la spec, par leur nom exact ;
- politique de sécurité stricte (`script-src 'self'`, aucun script en ligne) ; tout contenu provenant du magasin est affiché comme texte.

Une spec écrite avant le format actuel, dont l'intégrité ne peut plus être revérifiée, est affichée en lecture seule et signalée comme telle.

## Livraison locale et GitHub

`spec deliver` crée un nouveau répertoire hors source et store. Les hashes du manifeste sont des empreintes d'intégrité, pas des signatures par une autorité distante. Répéter une livraison identique vérifie les fichiers existants au lieu de les écraser.

`spec branch` crée une référence locale au candidat exact avec accord explicite. Le checkout source n'est pas changé. Sans GitHub, l'équipe peut intégrer cette branche dans son processus habituel. La clôture locale observe ensuite :

```bash
apv2 spec close ID --target integration-main --sha SHA_INTEGRE \
  --reviewer NOM --note "Fusion locale examinée"
```

La spec doit avoir été **revue** (`spec review`) ; une livraison préalable n'est plus exigée, puisque l'opérateur peut intégrer le candidat lui-même. La référence doit être une branche locale existante au SHA annoncé et avoir le candidat revu dans son ascendance. Un squash ne conserve pas cette ascendance : ce mode local est conservateur et ne rapproche pas arbitrairement deux patches. La clôture n'est pas une preuve de déploiement ni une garantie que la branche n'a pas introduit un autre défaut lors de l'intégration.

Le connecteur GitHub cible github.com, pas GitHub Enterprise Server/GitLab. `spec publish` exige destination explicite, `--confirm-push` et `--confirm-pr`. Il vérifie les URL fetch/push, la base distante et la tête attendue, ne fait pas de force push, et crée une PR brouillon. Une intention est enregistrée avant les effets externes. Après résultat réseau incertain, une nouvelle invocation recherche la PR existante avant de tenter de la recréer.

Par défaut, `spec publish` exige la revue du candidat. Avec `--for-review`, il ouvre la PR brouillon **avant** l'approbation, pour que l'opérateur lise le code sur la forge : les contrôles doivent être valides et la QA doit être passée sur ce commit exact, seule l'approbation manque encore, et le corps de la PR le signale.

`spec sync` lit l'état GitHub. Une PR fermée sans fusion n'est pas clôturée comme livrée ; une tête étrangère est refusée. Une PR fusionnée au candidat attendu permet une clôture observée, avec SHA de fusion. Si elle est fusionnée avant que la revue soit enregistrée, la spec passe en `MERGED_BEFORE_REVIEW` au lieu d'être clôturée : on enregistre la revue, puis on relance `spec sync`. Les stratégies de merge/squash et la CI sont sous la responsabilité de la forge. Le pipeline n'exécute jamais `gh pr merge` et ne rend pas la PR prête à fusionner automatiquement.

Les tests du connecteur utilisent un transport simulé. Les PR de développement du framework ne constituent pas une validation de ce connecteur par `spec publish`/`spec sync` sur un compte réel.

## Checkpoints humains

Le lifecycle distingue désormais validation machine et décision humaine. Les tâches intermédiaires utilisent `reviewRequired: false`; elles avancent après gates réussis. Une validation intégrée finale est ensuite créée avec `reviewRequired: true`, QA s'exécute selon le parcours et, en mode legacy, `workflow.qaLanes`, puis seulement le candidat final est présenté à l'humain.

Pour une spec UI, `spec draft/refine` peut produire une proposition design avant approbation. Le hash affiché est un bundle spec + design. Aucun Implementer UI ne doit démarrer avec une proposition design requise mais non approuvée.

Les nouveaux fichiers compagnons non sensibles peuvent être admis dans une enveloppe bornée. Un écart structurel crée un amendement au lieu de jeter le candidat. L'amendement revalide le même candidat sur le `currentSha` de la spec.

Avant la revue finale, le contrôleur matérialise un workspace de revue frère du projet avec le candidat complet, le patch et la QA. Utiliser ce dossier pour la revue humaine plutôt que les worktrees internes du store.


## Décisions autoritatives

Le bootstrap produit un Decision Ledger et une revue sémantique indépendante avant qu’un hash approuvable existe. Les questions `product` et `deferred` ne bloquent pas le scaffolding ; seules les questions `bootstrap` et les conflits sémantiques le font. Utiliser `bootstrap refine` pour poursuivre le même cadrage sans perdre les décisions confirmées.

Une spec alpha.6 est liée au hash du ledger. Les décisions `product` confirmées doivent être couvertes par des critères d’acceptation, sont transmises aux tâches concernées et doivent être évaluées dans `qa.decisionChecks`. Voir `docs/DECISIONS.md`.

## Ambiguïté et résolution

Le bootstrap distingue désormais `confirmed` de `ambiguous`. Une formulation approval-with-exception à haut risque ne peut pas être confirmée silencieusement. Une ambiguïté `bootstrap` reste un vrai blocker ; une ambiguïté `product` peut être reportée à Product si le scaffold reste neutre.

Product doit reproduire la question de clarification enregistrée tant que l'ambiguïté n'est pas résolue. Une réponse ultérieure de l'opérateur devient une `decisionResolution` citée et couverte par des critères d'acceptation. La spec ne peut pas être approuvée avec une ambiguïté Product non résolue. Les résolutions sont propagées à Implementer et QA.

## Sécurité dans le lifecycle

Avant Product, le contrôleur calcule un `SecurityContext` déterministe. Le contexte est persisté avec son hash et participe au hash de la spec : une évolution de la surface de sécurité invalide donc l'accord précédent.

Product reçoit ce contexte comme minimum. Les sujets OWASP routés doivent devenir des exigences de sécurité reliées à des critères d'acceptation. Quand requis, Product ajoute un threat model avec assets, frontières de confiance, menaces, mitigations et critères concernés. Les ambiguïtés métier suivent toujours le Decision Ledger ; la sécurité ne donne pas à Product le droit d'inventer une politique utilisateur.

Implementer reçoit uniquement les exigences et menaces liées aux critères de sa tâche. Le niveau de risque de la tâche peut être relevé par le minimum de sécurité. Le candidat final est ensuite évalué par QA, qui doit fournir un `securityChecks` pour chaque exigence de sécurité de la spec.

Un QA `pass` avec une exigence manquante, `unknown` ou `fail` est refusé par le contrôleur. Les receipts de scanners existants peuvent servir d'évidence, mais ne remplacent pas l'inspection du comportement et les tests négatifs requis.

## Fiabilité des rôles et maintenance

### Réparation bornée des sorties

Une sortie de rôle qui viole le contrat du contrôleur n'est plus jetée avec tout le tour :
- schéma ;
- invariants de spec, design, QA ou décisions ;
- sortie structurée absente.

Le même rôle est réinvoqué avec l'erreur structurée (`repair.previousError`), sa sortie décodée lorsqu'elle existe et le schéma à réparer, jusqu'à `workflow.maxOutputRepairs` fois (1 par défaut, 0 pour désactiver ; bootstrap : 1). Les appels natifs peuvent corriger par patches ; le résultat complet est revalidé. Les tentatives partagent l'échéance du rôle et les plafonds restants de la spec. Chaque tentative est journalisée (`role.output_repair`, `bootstrap-*.output_repair`).

Ne sont **jamais** réessayés :
- délai dépassé ;
- annulation ;
- refus de permission ;
- échec du processus fournisseur.

La réparation ne relâche aucun contrôle : une seconde réponse invalide échoue comme avant.

### Continuité visuelle et ressources du dépôt

Quand une spec de ce dépôt a déjà une proposition design approuvée, le contrôleur la transmet à la nouvelle sous `establishedDesign` (direction visuelle, décisions, écrans, ressources) et demande de l'étendre : reprendre les jetons et la grammaire existants, ne maquetter que les écrans créés ou réellement modifiés, et ne mettre dans `css` que ce qui est nouveau. La continuité est visible dans `INDEX.md` et dans `design.reusedFrom`. Changer de direction reste possible, mais doit être déclaré dans `decisions`.

Une maquette est un document statique, jamais un programme :
- le validateur analyse les **éléments** et leurs attributs, pas le texte affiché : une maquette peut montrer du markup échappé, un chemin ou une URL comme contenu ;
- sont refusés les éléments qui chargent quelque chose (`script`, `iframe`, `object`, `embed`, `link`, `meta`, `base`), les attributs de gestionnaire d'événement, `src`/`srcset`, une URL exécutable et un `href`/`action` distant ;
- `stylesheets` déclare les feuilles de style globales du projet (fichiers `.css` suivis par Git au commit de référence, 256 Kio chacune, 512 Kio au total, sans texte pouvant fermer l'élément `<style>`). L'aperçu les charge **avant** le CSS de la maquette, qui ne contient donc que ses ajouts, au lieu de reproduire la feuille existante. Leurs propres `url()` ne se chargent pas dans l'aperçu : les polices passent par `assets`. La liste est reprise par la maquette suivante et transmise à l'Implementer ;
- `url()` n'est accepté que sous la forme `url(asset:ID)`, où `ID` est déclaré dans `assets` avec un chemin relatif au dépôt. Le contrôleur lit ce fichier (police ou image, 512 Kio par fichier, 2 Mio au total ; pas de SVG, qui est un document scriptable) et l'insère dans l'aperçu en `data:` URI. L'aperçu reste un fichier autonome, sans accès réseau, et peut donc montrer la typographie réelle du projet. La proposition stockée conserve la référence, pas les octets.

### Contexte ciblé et capacités

La proposition design associe ses écrans aux tâches (`taskScopes`). Une tâche ne reçoit que la direction commune et ses écrans ; une tâche sans travail visuel ne reçoit pas le design. Une proposition sans `taskScopes` conserve l'ancien comportement.

Product reçoit `executionCapabilities` :
- outils réels de l'Implementer (édition, shell, réseau) ;
- setup du runner ;
- gates.

Une étape que l'Implementer ne peut pas exécuter (installation de dépendance, lockfile, générateur, migration) doit devenir un prérequis opérateur, pas une tâche.

### Validation finale d'une spec à une tâche

Quand la seule tâche a déjà passé tous les contrôles sur le commit final, la validation d'intégration **adopte** ses reçus au lieu de rejouer les contrôles (`integration.adopted`). Chaque reçu adopté est marqué `cached` avec `reusedFrom`, et le run garde la date de validation d'origine : l'adoption ne prolonge jamais la fraîcheur de la preuve. L'exigence d'approbation humaine du run d'intégration est inchangée. L'adoption exige même base, même commit, même ensemble de changements, même voie de risque, même plan de contrôles (commandes, variables, dépendances, sorties), même préparation, une identité d'environnement remesurée identique et une preuve source encore fraîche. Sinon elle est refusée avec sa raison (`integration.adoption_refused`), et les contrôles sont rejoués comme avant.

### Tâches plus grosses qu'une session d'agent

Une passe d'implémentation utilise une session d'agent, bornée par les limites applicables du fournisseur, le timeout et les budgets du run/de la spec, en réservant du temps aux contrôles. Si `feedback.gateIds` est configuré, l'Implementer peut tester et corriger pendant cette session ; les réparations externes éventuelles sont des appels supplémentaires bornés. Product reçoit ces valeurs dans `executionCapabilities.attempt` et doit dimensionner ses tâches en conséquence, en découpant par surface (une route, un module ou un écran avec ses tests) plutôt que par couche. Une tâche trop grosse n'est pas seulement plus lente : le fournisseur s'arrête en cours de route, et la tentative doit être adoptée ou recommencée.

Après Product, `sizeAdvice` liste les tâches qui déclarent plus de huit fichiers, avec leur nombre. C'est un **avertissement pour l'opérateur avant l'approbation, jamais un blocage** : certaines tâches larges sont légitimes.

### Tests existants mal rangés

Après Product, le contrôleur parcourt les tâches dans l'ordre d'exécution et liste dans `impactAdvice` les tests existants qui citent un fichier modifié par une tâche, mais qui sont rangés dans une tâche ultérieure ou dans aucune. Les contrôles rejouant toute la suite après chaque tâche, un tel test fait souvent échouer la tâche précédente et impose un amendement de périmètre. La détection est lexicale : jetons de chemin, et chemins relatifs cités (`../db`, `./index.ts`) résolus depuis le test, y compris dans un fichier que Git classe comme binaire. Chaque entrée indique sa preuve : `declared-later` quand une tâche ultérieure déclare le test (Product a dit qu'il change, seul l'ordre est en cause), `resolved-import` quand aucune tâche ne le déclare mais qu'il importe le fichier par un chemin relatif résolu. Un simple fragment de chemin, qui peut n'être qu'un alias, ne suffit plus pour un test non déclaré. C'est un **avertissement pour l'opérateur, jamais un blocage** : il peut encore signaler des tests que le changement ne cassera pas.

### Corriger un critère devenu intenable

Une spec est immuable dès que l'exécution commence : c'est ce qui rend l'approbation crédible. Mais un critère peut se révéler **impossible à satisfaire**, parce qu'il interdit ce que le changement approuvé impose — par exemple « ce fichier de test ne change pas » alors que la migration approuvée modifie ce qu'il compare. Sans recours, un candidat fini et conforme sur tous les autres critères était perdu.

- `apv2 spec criterion SPEC_ID --criterion AC_ID --file CORRECTION_JSON` propose une correction (`description`, `verification`, `reason`, et éventuellement `requirements: [{id, verification}]`) et affiche son hash. Rien n'est appliqué.
- `apv2 spec criterion SPEC_ID --amendment AMENDMENT_ID --hash HASH --approve --note TEXT` l'applique.

Bornes : uniquement après le début de l'exécution (avant, on affine la spec) ; un seul critère existant, dont seuls le texte et la vérification changent ; les méthodes de vérification d'exigences de sécurité déjà liées à ce critère peuvent être corrigées dans le même amendement. Une entrée de `requirements` peut aussi proposer `reviewTestIndexes: [0]` pour autoriser explicitement la revue du cas négatif existant d’index 0 ; le texte original apparaît dans la proposition et le hash approuvé couvre cette autorisation. Les tests négatifs exigés par le contrôleur restent obligatoires. Ni exigences ajoutées/supprimées, ni modification du périmètre, des tâches, des chemins ou des décisions ; `reason` obligatoire. Le texte approuvé à l'origine reste dans le magasin, la correction porte sa propre approbation, et l'évaluation rouvre : le rapport QA et le dossier de revue sont invalidés, puisqu'ils portaient sur l'ancien critère.

### Maintenance

- `apv2 decisions plan --repo PATH --file UPDATE_JSON` : prévisualise un changement du Decision Ledger et son hash. Une nouvelle décision qui remplace ou résout une entrée existante doit la citer dans `supersedes` ; l'entrée remplacée quitte le ledger actif et reste dans l'historique Git.
- `apv2 decisions apply ... --hash HASH --approve --note TEXT [--commit]` : écrit `DECISIONS.json`/`DECISIONS.md`, si le ledger et le commit de base n'ont pas changé depuis le plan. La CLI n'authentifie pas l'auteur d'une citation.
- `apv2 spec list --active` : masque les specs clôturées ou rejetées. `spec reject` permet d'abandonner une spec en brouillon.
- `apv2 gc` : liste d'abord, sans rien supprimer. Avec `--confirm`, retire :
  - les workspaces des specs clôturées ou rejetées ;
  - les contrôles baseline remplacés par un plus récent ;
  - les runs autonomes échoués ou rejetés ;
  - les review workspaces de specs terminées ;
  - les workspaces de rôle abandonnés depuis plus de 24 h.

  Il ne touche ni à l'historique SQLite, ni aux livraisons, ni aux sources, ni à ce qui appartient à une spec active ou à un processus vivant.

- `apv2 prune [--id DOCUMENT_ID] [--older-than DAYS] [--confirm]` : liste d'abord, sans rien supprimer. Avec `--confirm`, supprime définitivement du magasin les documents abandonnés — specs clôturées ou rejetées, brouillons jamais approuvés, plans `bootstrap`/`onboard` jamais appliqués — avec leurs runs, leurs reçus, leurs événements et leurs workspaces. Par défaut, rien de plus récent que 30 jours n'est proposé ; `--id` cible un document précis sans lever les autres gardes. Un document verrouillé, avec un run actif ou un processus vivant, un plan appliqué et une spec en cours ne sont jamais proposés. Il n'y a pas de sauvegarde : c'est la seule commande qui efface de l'historique, et elle le dit avant de le faire. Elle ne propose jamais, même par `--id`, la spec qui porte la direction visuelle que la prochaine maquette du dépôt prolonge ; la simulation la liste sous `kept`. Une spec rejetée dont le pointeur de run est resté posé, sans processus vivant, redevient collectable.

Les commits candidats portent le titre de la tâche ; l'identifiant du run est dans le trailer `Agent-Pipeline-Run`.
