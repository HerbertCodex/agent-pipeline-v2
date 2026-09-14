# Performance : protocole et interprétation

## But

Réduire le travail de coordination qui n'ajoute pas d'information utile, sans convertir une absence de preuve en succès. Les mécanismes présents sont les transitions en code, un agent principal, une correction bornée, le choix des contrôles, le parallélisme et la réutilisation conservatrice d'un reçu.

Le TypeScript n'est pas la cause directe de ces économies. Les opérations de modèle, de setup, de Git et de contrôle restent des opérations réelles.

## Deux expériences distinctes

`node scripts/demo.mjs` exécute un parcours complet sur une petite fixture : échec initial des vrais tests, édition déterministe, trois contrôles, revalidation avec cache, avis simulé et patch. Il n'utilise ni un modèle ni une revue humaine. Le setup de cette fixture est vide. Il faut lire ses résultats comme une validation du chemin logiciel, pas comme une durée de réalisation d'une fonctionnalité.

```bash
node scripts/bench.mjs --repetitions 5 --output /tmp/apv2-bench.json
```

Le benchmark utilise les mêmes quatre commandes réelles Node dans les deux modes : trois timers indépendants de 180 ms et un timer de 50 ms dépendant de deux parents. Il compare une concurrence de 1 et de 3, alterne l'ordre des modes et conserve chaque mesure. **Ces délais sont artificiels.** Le résultat démontre l'effet de l'ordonnancement sur ce graphe, pas un gain général de la V2 sur la V1 ou sur une session IA.

Les résultats de cette livraison sont dans `validation/alpha.8/scheduler-bench.json`, `validation/alpha.8/demo.json` et `validation/VALIDATION.md`. Ce sont des observations locales, non des objectifs contractuels.

## Durées

`activeMs` compte les sessions actives de la tentative, y compris les reprises, mais pas l'attente humaine. `preparationMs`, `agentMs` et `validationMs` sont des durées murales de phases non superposées. La durée de création préalable du run, les avis et l'export sont hors de ce compteur. `controllerExclusiveMs` est le reste non négatif après soustraction des phases.

Une durée de reçu couvre sa préparation d'identité, son lookup et sa commande éventuelle. Des reçus parallèles se chevauchent : ne pas additionner leurs durées pour obtenir le délai total. Le benchmark conserve séparément la somme des durées de processus pour montrer cette différence.

Lors d'un crash, la fenêtre jusqu'à récupération est imputée conservativement au budget ; cette valeur n'est plus une mesure pure du CPU ou du travail utile. Aucune mesure de tokens, de prix ou de temps interne de raisonnement n'est fournie.

## Limites de latence encore présentes

Chaque nouvelle validation matérialise un worktree propre et rejoue le setup. Les grosses installations restent donc coûteuses. L'empreinte des exécutables est calculée et peut dominer une fixture minuscule ; les identités identiques sont mutualisées dans une validation, pas réutilisées indéfiniment sur simple mtime.

Le cache n'effectue pas de réutilisation entre commits différents et ne restaure pas d'artefacts. Les réparations relancent l'adaptateur sans thread fournisseur persistant. Le mode standard attend encore un avis local ; une future intégration doit réutiliser la revue de PR de l'équipe pour éviter une étape administrative supplémentaire.

## Prochaine mesure utile sur un vrai projet

Comparer sur des copies isolées les mêmes tâches et commits : V1 corrigée, agent unique avec la CI habituelle, puis V2. Distinguer cache froid et chaud, setup, modèle, outils, contrôles, revue et reprises. Mesurer le temps jusqu'au changement accepté, les défauts échappés et les interventions, pas seulement le temps jusqu'à un premier diff.

Les objectifs proposés dans la note d'architecture antérieure, dont un p95 de surcharge réduit, ne sont pas déclarés atteints sur une charge d'entreprise par ce benchmark local.

## Cycle de spec alpha.2

Product intervient au cadrage et aux raffinements, pas à chaque transition ni tâche. Les résultats de contrôles sont capturés par le runner. Une spec à une tâche réutilise sa validation finale au lieu de doubler les commandes. Les tâches multiples ont une validation d'ensemble supplémentaire : ce coût est volontaire pour détecter les régressions d'intégration. Une seule revue humaine du candidat intégré est demandée selon le risque, et non une revue répétée pour chaque sous-tâche.

QA n'intervient par défaut que sur standard/high et lit les reçus existants. Une demande de correction déclenche une boucle bornée, pas une re-spécification Product automatique. Les sessions de fournisseur ne sont pas encore reprises par ID ; un nouvel appel et un nouveau contexte sont utilisés. Les caches de preuves restent conservateurs, locaux et principalement utiles pour revalider un même candidat. Il n'y a pas de cache d'artefacts ou d'installation généralisé.

L'onboarding verrouille les ressources des scripts détectés de manière conservative. Le parallélisme du moteur n'accélère pas un profil qui sérialise volontairement ces contrôles ; le calibrer avant retrait des verrous. Les installations et worktrees ne sont pas rendus gratuits par TypeScript.

La durée de `demo-lifecycle.mjs` inclut des acteurs déterministes très petits. Elle vérifie le chemin fonctionnel, pas la qualité/rapidité d'un modèle sur un vrai projet. Aucun gain multiplicatif, objectif p95 atteint, coût/token ou benchmark V1/V2 entreprise n'est annoncé. Les données de validation indiquent séparément ce qui a été mesuré.

## Sélection de skills

La sélection ne crée pas de nœud de workflow ni d’appel au modèle. Un microbenchmark local alpha.8 de 100 résolutions en processus, avec le catalogue et ses empreintes, mesure une médiane de 1,94 ms et un p95 de 2,93 ms (`validation/alpha.8/guidance-bench.json`). Ce scénario exclut démarrage du processus, appels aux modèles, worktrees, setup et gates ; il ne mesure pas l’accélération d’une tâche. Les textes courts injectés ajoutent des octets au contexte : le budget `maxContextBytes` limite ces corps de skills, pas les tokens totaux ni le coût du fournisseur.

## Alpha.5 — coût des nouvelles garanties

Repository Intelligence ajoute un scan local borné par SHA avant Product et les tâches Implementer ; il évite des appels de modèle supplémentaires pour sélectionner des helpers. Une spec UI ajoute volontairement un appel Product de design avant implémentation. Ce coût est accepté pour réduire les boucles de retouche visuelle et est absent des specs sans impact UI.
