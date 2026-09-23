# Blocages et recours

> **Archive V2.** Ce guide décrit le CLI `apv2` d'Agent Pipeline V2 (dernière version 2.0.0-alpha.8, branche `main`) et son contrôleur, retirés d'APV3. Pour APV3 : [plugin](../PLUGIN.md), [outil apv](../CLI.md), [spécification](../APV3-SPEC.md).

Un refus doit préciser la cause, le travail conservé, l’action possible et ses préconditions. Un refus de sécurité ou une incohérence interne peut imposer un arrêt et un diagnostic : une « porte de sortie » ne signifie pas autoriser une opération invalide.

## Audit reproductible

```bash
npm run audit:errors
node scripts/audit-errors.mjs --json > /tmp/apv2-errors.json
```

Le [scanner](../scripts/audit-errors.mjs) analyse la syntaxe TypeScript de `src/` : appels à `invariant`, constructions de `PipelineError` et champs `code`, y compris les branches conditionnelles. Il ignore les commentaires, `dist/`, les tests et les codes numériques JSON-RPC. Les expressions dynamiques non résolues sont recensées séparément et exigent une justification.

Sur le code issu de la PR #52 (`b26ede0`), le relevé donne **573 appels à invariant, 172 codes émis distincts et 620 occurrences littérales**. Une occurrence de code n’est pas nécessairement un invariant ; elle peut être une branche alternative ou une erreur enregistrée. Ce périmètre ne reproduit donc pas le chiffre de 179 codes.

Dans `LifecycleService.summary`, 16 codes sont comparés explicitement pour choisir `nextAction`. Parmi eux, `TASK_FAILED` n’a pas de site d’émission identifié dans le code courant : cette branche peut encore concerner des données historiques. Les autres conseils dépendent aussi du statut, du travail interrompu et des amendements. `stopAdvice` ajoute des conseils fournisseur. Diviser le nombre de codes par le nombre de commandes ne mesure donc pas la proportion d’impasses.

Le [catalogue](../scripts/error-recovery.json) classe **chaque code** avec :

- l’acteur capable d’agir : opérateur, opérateur sous conditions ou diagnostic mainteneur ;
- l’action envisageable, sans prétendre qu’elle est disponible dans tous les états ;
- les conseils réellement présents ;
- la limite ou le recours manquant.

Le rapport JSON développe les familles en une ligne par code avec tous ses sites source. Il permet notamment d’examiner les multiples usages de `STATE`, `ROLE`, `SCHEMA` ou `DB_CORRUPT`, qui ne représentent pas une cause unique.

## Recours à rendre explicites en priorité

| Codes / situation | Recours actuel et lacune | Condition de réussite à tester |
| --- | --- | --- |
| `GATES_FAILED`, `SETUP` | Après correction de la cause, `spec retry ID --confirm`, puis `spec run ID`. `run` seul laisse une tentative terminale en échec. Le conseil `SETUP` est générique. | La reprise crée une tentative admissible, rejoue les contrôles et conserve l’échec précédent. |
| `STALE_EVIDENCE` | `spec verify ID`, puis `spec run ID`, uniquement si le run final permet encore une revalidation. | Réussite puis échec puis nouvelle réussite restent trois observations distinctes ; l’échec récent ne disparaît pas derrière une ancienne preuve verte. |
| `BUDGET`, `AGENT_TIMEOUT`, `PROVIDER_TURNS` | Un conseil décrit la limite, mais la commande d’amendement/reprise dépend du rôle et du run. Un budget de run épuisé n’est pas identique au budget de spec. | La commande proposée traite la limite effectivement atteinte et ne relance pas une tentative encore interdite. |
| `ROLE_OUTPUT`, `QA_COVERAGE`, `QA_QUALITY`, `QA_SECURITY` | Checkpoints et corrections par champs existent ; les réparations sont bornées. Après leur épuisement, les conseils sont incomplets. | Un rapport conservé peut être corrigé sans refaire les parties valides ; absence de progrès et nouveau défaut sont distingués. |
| `QA_EVIDENCE`, `QA_REJECTED` | Import de QA, amendements et `qa-repair` existent sous conditions. Le conseil qui exige une nouvelle spec pour tout contrôle manquant est trop large depuis l’ajout d’amendements de gates. | Une suggestion est refusée comme indisponible avant de demander à l’opérateur de l’exécuter ; une preuve absente ne devient jamais un succès déclaré. |
| `LOCKED`, `RECOVERY`, `INTERRUPTED`, `UNKNOWN_AGENT_OUTCOME` | Recovery, adoption explicite et retry existent ; la décision dépend des processus vivants et de la phase interrompue. | Aucun bail actif n’est volé, aucun candidat n’est jeté sans décision explicite. |
| `PR_CLOSED`, `PUBLICATION_MISMATCH`, `FORGE_DRIFT` | Refus de divergence de publication sans parcours général de remplacement de l’intention. | Une décision opérateur traite la PR fermée/divergente tout en conservant son historique et la destination autorisée. |
| `STATE`, `EXECUTION`, `WORKFLOW` | Le repli « Resolve CODE » ne définit pas un recours. Certains usages signalent une commande inadaptée, d’autres un défaut interne. | La recommandation dépend de la phase, du run et de sa cause ; elle est testée depuis l’état bloqué jusqu’au résultat attendu. |

Ces priorités décrivent le travail à réaliser ; le catalogue n’ajoute pas ces commandes au runtime.

## Deux constats structurels

**La revalidation modifie le run existant.** `LifecycleService.verify` annule la QA et la livraison avant l’appel au moteur ; `Pipeline.revalidate` réutilise le même identifiant de run et invalide ses approbations et sa date de validation. Les reçus et événements historiques ne sont pas tous supprimés, mais le run courant perd son état vert. La correction à concevoir consiste à créer une tentative de validation distincte et à calculer l’éligibilité à livrer à partir de l’historique pertinent. Conserver une ancienne réussite ne permet pas d’ignorer un échec ultérieur.

**La compatibilité des specs persistées exige un contrat explicite.** Le hash d’approbation inclut indirectement `configHash`, qui protège la configuration approuvée ; les amendements opérationnels existent séparément. Cela ne signifie pas que toute mise à jour invalide toutes les specs. Le correctif #49 normalise les deux côtés de la comparaison des gates avant publication. En revanche, `get` revalide le contenu enregistré avec le validateur courant : une évolution incompatible peut encore refuser une ancienne spec. Il faut tester et versionner ces migrations, pas retirer la protection du hash.

## Empêcher de nouveaux codes sans classification

Le [test de couverture](../test/error-recovery-audit.test.mjs), inclus dans `npm run check`, échoue lorsqu’un code émis n’a pas de classification, qu’une classification devient orpheline ou qu’une nouvelle expression dynamique échappe au relevé. Les tests du scanner couvrent aussi les alias d’import, les codes conditionnels et les erreurs enregistrées.

Pour ajouter un code, déclarer son action ou le motif d’arrêt mainteneur dans le catalogue. Ne pas écrire « relancer » si l’état interdit réellement la relance. Une commande de reprise nouvelle doit également avoir un test comportemental de ses préconditions et de ses effets.

**Limite du garde-fou :** il vérifie la déclaration et la couverture statique, pas l’efficacité du texte ni l’accessibilité des états. Réutiliser un code existant dans une nouvelle situation demande une revue et des tests ; cette classification ne la démontre pas. Le scanner ne couvre pas les erreurs HTTP, les exceptions natives ni tous les modes de construction dynamique possibles. Les transferts de codes existants restent explicitement recensés ; il ne faut pas les considérer comme de nouveaux mécanismes d’émission arbitraire.

Les tests de parcours existants sont notamment dans [workflow-recovery](../test/workflow-recovery.test.mjs), [lifecycle-resilience](../test/lifecycle-resilience.test.mjs), [artifact-lifecycle](../test/artifact-lifecycle.test.mjs) et [gate-amendments](../test/gate-amendments.test.mjs). Ils complètent l’inventaire sans prouver que tous les recours sont couverts.
