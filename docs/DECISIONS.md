# Decision Ledger, ambiguïtés et cohérence sémantique

> **Écrit pour V2.** APV3 reprend le registre des décisions et sa validation (`apv ledger`, [outil apv](CLI.md)) ; les passages sur Product et le contrôleur décrivent V2.

## Pourquoi

Un JSON conforme au schéma ne garantit pas qu'une proposition respecte les décisions produit. Agent Pipeline V2 alpha.7 rend donc les décisions explicites de l'opérateur autoritatives et distingue une décision réellement confirmée d'une formulation encore ambiguë.

Le but est d'éviter deux dérives :

1. perdre ou réécrire une décision explicite entre deux tours ;
2. transformer une phrase ambiguë en règle métier sans demander de clarification.

## Ledger

Le fichier `.agent-pipeline/DECISIONS.json` est la représentation machine ; `.agent-pipeline/DECISIONS.md` est la vue humaine. Une décision contient notamment :

- un identifiant ;
- un sujet ;
- une valeur ;
- un niveau d'application ;
- un statut ;
- une source ;
- une citation source ;
- éventuellement les décisions qu'elle remplace.

Niveaux d'application :

- `bootstrap` : nécessaire pour créer un socle cohérent maintenant ;
- `product` : décision métier que Product doit transformer en critères d'acceptation ;
- `deferred` : décision volontairement remise à plus tard, qui ne bloque pas le socle.

Statuts :

- `confirmed` : une seule interprétation matérielle est retenue explicitement ;
- `proposed` : suggestion dérivée, non autoritative ;
- `ambiguous` : plusieurs interprétations matérielles restent plausibles ;
- `deferred` : décision explicitement reportée.

Une décision opérateur `confirmed` ou `ambiguous` exige une citation littérale provenant de la demande/refinement correspondant.

## Ambiguïté de première classe

Une formulation ambiguë n'est jamais convertie en `confirmed` uniquement parce qu'un modèle pense avoir compris l'intention.

Une décision `ambiguous` doit contenir :

- la citation source exacte ;
- une valeur neutre/non résolue ;
- `clarificationQuestion` ;
- au moins deux `interpretations` plausibles.

Le contrôleur possède en plus un tripwire déterministe pour une classe de formulations à haut risque : approbation/validation suivie d'une exception, par exemple :

```text
je valide le MVP et le hors MVP; sauf le multi-sites
```

ou :

```text
I approve the scope except multi-site
```

Ce type de phrase ne peut pas être converti directement en inclusion ou exclusion confirmée. Le sous-rôle doit la conserver comme `ambiguous`, ou la proposition est rejetée avant approbation.

Ce tripwire est volontairement conservateur et ne prétend pas résoudre tout le langage naturel. Une seconde revue sémantique indépendante reste chargée d'identifier les autres ambiguïtés matérielles.

## Où l'ambiguïté bloque

Une ambiguïté `bootstrap` bloque uniquement lorsqu'elle empêche réellement de créer un socle technique cohérent. Sa question doit apparaître dans `proposal.questions`.

Une ambiguïté `product` doit apparaître dans `proposal.productQuestions`. Elle ne bloque pas un bootstrap neutre si le scaffold ne choisit aucune des interprétations à la place de l'opérateur.

Une question d'hébergement production, de CI, d'email transactionnel ou un détail reproductible comme la génération d'un lockfile ne doit pas devenir un blocage humain sans contrainte réelle dans la demande.

## Bootstrap refine

Le cadrage d'un nouveau projet continue sur le même document :

```bash
apv2 bootstrap --repo "$APP" --provider codex --review-mode solo --request "<besoin initial>"
apv2 bootstrap refine PLAN_ID --request "<réponse ou précision>"
```

Les décisions opérateur `confirmed` et `ambiguous` des révisions précédentes sont préservées.

Pour modifier une décision `confirmed`, une nouvelle décision opérateur doit explicitement `supersede` l'ancienne et citer la nouvelle réponse.

Pour résoudre une décision `ambiguous`, la nouvelle décision doit également `supersede` l'entrée ambiguë et citer la clarification ultérieure de l'opérateur. Le modèle ne peut pas simplement faire disparaître l'ambiguïté.

## Revue sémantique du bootstrap

Après la proposition Setup, le fournisseur configuré est invoqué séparément comme reviewer de cohérence. Il reçoit la demande littérale, le ledger, l'architecture et tous les fichiers proposés. Il ne doit pas faire confiance à la couverture auto-déclarée par Setup.

Le reviewer doit :

- évaluer chaque décision `confirmed` ;
- préserver explicitement chaque décision `ambiguous` comme ambiguë ;
- refuser une ambiguïté `bootstrap` non résolue ;
- accepter éventuellement une ambiguïté `product` si le scaffold reste neutre ;
- signaler les décisions explicites oubliées ;
- signaler les contradictions entre demande, architecture et fichiers.

Le hash du bootstrap n'est généré que si cette revue est cohérente avec ces invariants.

## Product : résolution explicite

Une spec possède `decisionCoverage` et `decisionResolutions`.

Chaque décision `product` confirmée doit être reliée à un ou plusieurs critères d'acceptation.

Une décision `product` ambiguë non résolue doit rester une question Product. Sa `clarificationQuestion` enregistrée dans le ledger doit être reproduite dans `spec.questions`.

Lorsque l'opérateur répond, Product peut créer une `decisionResolution` contenant :

- l'identifiant de la décision ambiguë ;
- la valeur résolue ;
- une citation exacte de la réponse opérateur accumulée dans la spec ;
- une justification.

La spec ne peut pas être approuvée tant qu'une ambiguïté Product reste non résolue. Une résolution doit également être reliée à des critères d'acceptation via `decisionCoverage`.

Cela permet par exemple de conserver :

```text
D-MULTISITE = ambiguous
```

pendant le bootstrap, puis après une réponse explicite :

```text
"Le multi-site reste hors MVP."
```

la spec enregistre une résolution opérateur et la vérifie comme une exigence réelle.

## Implementer

Pour chaque tâche, le contrôleur transmet :

- les décisions Product déjà confirmées qui concernent ses critères ;
- les ambiguïtés Product résolues dans la spec qui concernent ses critères.

Implementer doit conserver ces contrats et ne pas les remplacer par une approximation, un placeholder ou une convention plus pratique.

## QA

QA possède `decisionChecks`.

Chaque décision Product confirmée **et chaque ambiguïté Product résolue** doit être évaluée explicitement. Un verdict global `pass` est impossible si un check requis manque, vaut `fail` ou `unknown`.

## Garantie et limite

La pipeline ne prétend pas fournir une preuve mathématique de compréhension du langage naturel. La revue sémantique utilise toujours un modèle et peut se tromper.

Les garanties déterministes d'alpha.7 sont néanmoins plus fortes :

- certaines formulations d'exception à haut risque sont bloquées structurellement si elles sont déclarées `confirmed` ;
- une ambiguïté déclarée ne peut pas être présentée comme satisfaite ;
- une ambiguïté bootstrap ne peut pas passer silencieusement ;
- une ambiguïté Product ne peut pas être approuvée sans résolution opérateur citée ;
- une décision résolue est propagée jusqu'à Implementer et QA ;
- une décision confirmée ne peut pas être modifiée sans remplacement explicite.
