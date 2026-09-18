# Performance : protocole et interprétation

## But

Réduire le travail de coordination qui n'ajoute pas d'information utile, sans convertir une absence de preuve en succès. Les mécanismes présents sont les parcours adaptatifs, les contextes sélectionnés, les checks en session, les réparations bornées, le choix des contrôles, leur parallélisme et la réutilisation conservatrice des reçus et checkpoints.

Le TypeScript n'est pas la cause directe de ces économies. Les opérations de modèle, de setup, de Git et de contrôle restent des opérations réelles.

## Deux expériences distinctes

`node scripts/demo.mjs` exécute un parcours complet sur une petite fixture : échec initial des vrais tests, édition déterministe, trois contrôles, revalidation avec cache, avis simulé et patch. Il n'utilise ni un modèle ni une revue humaine. Le setup de cette fixture est vide. Il faut lire ses résultats comme une validation du chemin logiciel, pas comme une durée de réalisation d'une fonctionnalité.

```bash
node scripts/bench.mjs --repetitions 5 --output /tmp/apv2-bench.json
```

Le benchmark utilise les mêmes quatre commandes réelles Node dans les deux modes : trois timers indépendants de 180 ms déclarés `readOnly: true` et un timer de 50 ms dépendant de deux parents. Il compare une concurrence de 1 et de 3, alterne l'ordre des modes et conserve chaque mesure. **Ces délais sont artificiels.** Le résultat démontre l'effet de l'ordonnancement sur ce graphe, pas un gain général de la V2 sur la V1 ou sur une session IA.

Les résultats historiques de la livraison initiale alpha.8 sont dans `validation/alpha.8/scheduler-bench.json`, `validation/alpha.8/demo.json` et `validation/VALIDATION.md`. Ce sont des observations locales, non des objectifs contractuels.

## Durées

`activeMs` compte les sessions actives de la tentative, y compris les reprises, mais pas l'attente humaine. `preparationMs`, `agentMs` et `validationMs` sont des durées murales de phases non superposées. La durée de création préalable du run, les avis et l'export sont hors de ce compteur. `controllerExclusiveMs` est le reste non négatif après soustraction des phases.

Une durée de reçu couvre sa préparation d'identité, son lookup et sa commande éventuelle. Des reçus parallèles se chevauchent : ne pas additionner leurs durées pour obtenir le délai total. Le benchmark conserve séparément la somme des durées de processus pour montrer cette différence.

Lors d'un crash, la fenêtre jusqu'à récupération est imputée conservativement au budget ; cette valeur n'est plus une mesure pure du CPU ou du travail utile. Le journal des invocations conserve séparément les tokens et coûts publiés par le fournisseur. Il n'estime ni les valeurs absentes ni le temps interne de raisonnement. La planification apparaît dans `planningMs` et consomme le budget actif de spec.

## Limites de latence encore présentes

Chaque nouvelle validation matérialise un worktree propre et rejoue le setup. Les grosses installations restent donc coûteuses. L'empreinte des exécutables est calculée et peut dominer une fixture minuscule ; les identités identiques sont mutualisées dans une validation, pas réutilisées indéfiniment sur simple mtime.

Le cache n'effectue pas de réutilisation entre commits différents et ne restaure pas d'artefacts. Les checks en session évitent certains rappels du modèle ; les réparations externes relancent l'adaptateur sans thread fournisseur persistant, en conservant le contexte utile, le worktree et les diagnostics. Le mode standard attend encore un avis local ; une future intégration doit réutiliser la revue de PR de l'équipe pour éviter une étape administrative supplémentaire.

## Prochaine mesure utile sur un vrai projet

Comparer sur des copies isolées les mêmes tâches et commits : V1 corrigée, agent unique avec la CI habituelle, puis V2. Distinguer cache froid et chaud, setup, modèle, outils, contrôles, revue et reprises. Mesurer le temps jusqu'au changement accepté, les défauts échappés et les interventions, pas seulement le temps jusqu'à un premier diff.

Les objectifs proposés dans la note d'architecture antérieure, dont un p95 de surcharge réduit, ne sont pas déclarés atteints sur une charge d'entreprise par ce benchmark local.

## Coût du cycle de spec

Product intervient au cadrage et aux raffinements, pas à chaque transition ni tâche. Les résultats de contrôles sont capturés par le runner. Une spec à une tâche peut réutiliser ses reçus si toutes les conditions d'identité, de plan et de fraîcheur sont satisfaites ; sinon l'intégration rejoue les contrôles. Les tâches multiples ont une validation d'ensemble supplémentaire : ce coût est volontaire pour détecter les régressions d'intégration. Une seule revue humaine du candidat intégré est demandée selon le risque, et non une revue répétée pour chaque sous-tâche.

QA suit `qaLanes` en mode legacy ; les parcours adaptatifs standard/structural l'exigent, alors que compact peut l'éviter selon le diff réel et le mode de revue. Elle lit les reçus existants. Une demande de correction déclenche une boucle bornée, pas une re-spécification Product automatique. Les sessions fournisseur ne sont pas reprises par ID ; un nouvel appel reçoit le contexte conservé et les diagnostics utiles à la réparation. Les caches de preuves restent conservateurs, locaux et principalement utiles pour revalider un même candidat. Il n'y a pas de cache d'artefacts ou d'installation généralisé.

L'onboarding verrouille les ressources des scripts détectés de manière conservative. Le parallélisme du moteur n'accélère pas un profil qui sérialise volontairement ces contrôles ; le calibrer avant retrait des verrous. Les installations et worktrees ne sont pas rendus gratuits par TypeScript.

La durée de `demo-lifecycle.mjs` inclut des acteurs déterministes très petits. Elle vérifie le chemin fonctionnel, pas la qualité/rapidité d'un modèle sur un vrai projet. Cette démonstration ne mesure ni coût/token d'un modèle, ni gain multiplicatif, ni objectif p95 ou benchmark V1/V2 d'entreprise. Les données de validation indiquent séparément ce qui a été mesuré.

## Sélection de skills

La sélection ne crée pas de nœud de workflow ni d’appel au modèle. Un microbenchmark local alpha.8 de 100 résolutions en processus, avec le catalogue et ses empreintes, mesure une médiane de 1,94 ms et un p95 de 2,93 ms (`validation/alpha.8/guidance-bench.json`). Ce scénario exclut démarrage du processus, appels aux modèles, worktrees, setup et gates ; il ne mesure pas l’accélération d’une tâche. Les textes courts injectés ajoutent des octets au contexte : le budget `maxContextBytes` limite ces corps de skills, pas les tokens totaux ni le coût du fournisseur.

## Coût de la conception

Repository Intelligence ajoute un scan local borné par SHA avant Product et les tâches Implementer ; il évite des appels de modèle supplémentaires pour sélectionner des helpers. Un impact UI `major` ajoute une proposition design avant implémentation. Une retouche `minor` réutilise les conventions existantes sans nouvel appel Design. Le parcours structural ajoute une décision d'architecture conditionnelle ; il n'impose pas un Architect permanent.

## Mesures des parcours courts

Le [premier pilote Claude](../validation/short-loop-2026-09-18/REPORT.md) et la [calibration suivante](../validation/short-loop-2026-09-18/CALIBRATION.md) conservent les réussites, les échecs et les limites de petits cas jetables. Des tokens, coûts déclarés, appels et délais sont donc disponibles pour ces essais ; ils ne prouvent pas un gain général sur une fonctionnalité complète. La grille de qualité du lot 3 n'a pas encore fait l'objet d'une calibration payante.

`npm run evaluate` décrit les cas sans appeler de modèle. Une campagne avec `--execute` consomme le quota ; comparer les mêmes cas, checks et répétitions avec `scripts/compare-evaluations.mjs`. Un résultat incomplet ou un coût inconnu doit rester visible. Le [guide des améliorations](AMELIORATIONS-2026-09-18.md#évaluation-et-limites) détaille les commandes et les limites du banc d'essai.
