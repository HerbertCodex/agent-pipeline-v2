# Confiance calibrée et escalade

Les agents écrivaient « corrigé » ou « cause trouvée » sans dire à quel point ils en étaient sûrs. Exemple observé (anonymisé) : un correctif a été livré pour un défaut vu en production alors que la cause observée n'avait jamais été reproduite ; ses tests passaient, mais ils ne prouvaient pas que le défaut de production avait disparu.

APV3 reprend une idée publiée par [typesafe.ai](https://typesafe.ai/) (décisions typées, confiance calibrée, un seuil au-dessus duquel on agit et en dessous duquel on remonte à un humain), sans utiliser leur modèle : les niveaux sont déclarés par les agents, justifiés par une preuve, contrôlés par les workflows et appliqués par le chef de projet.

## Niveaux
Tous les rapports d'agents (constats de revue, causes trouvées, corrections, décisions prises seul, notes de la grille de critique) donnent pour chaque affirmation importante un niveau et ce qui le fonde.

| Niveau | Veut dire | Exige |
|---|---|---|
| `prouve` | quelqu'un d'autre peut rejouer la preuve | preuve reproductible jointe : test qui échoue avant et passe après, commande et sortie, requête et réponse, capture, source officielle citée |
| `probable` | code lu ou raisonnement vérifiable, rien d'exécuté | justification : chemins et lignes lus, raisonnement |
| `suppose` | hypothèse | ce sur quoi elle repose et ce qui la prouverait |

Dans le doute, le niveau inférieur. Une correction n'est `prouve` que si le défaut a été reproduit avant ; une cause observée ailleurs et non reproduite laisse la correction au mieux `probable`, même si ses tests passent.

## Seuils du chef de projet
- `prouve` : il agit seul (intégrer, livrer, fusionner sur ordre de l'opérateur, lui déclarer « corrigé »).
- `probable` : une vérification d'abord (un test ou une exécution) qui la fait passer à `prouve`.
- `suppose` : remontée à l'opérateur avant toute action sur la production, toute fusion et toute annonce « corrigé ».

Les comptes rendus à l'opérateur (points d'étape, PR, remise finale, fusion par `/apv:stack`) disent le niveau de chaque affirmation importante. Méthode complète : `skills/chef-de-projet/references/confiance.md`.

## Dans les workflows
| Workflow | Où | Champs obligatoires |
|---|---|---|
| `apv:vague` | chaque rapport de tâche | `confidence` (`prouve`, `probable`, `suppose`) et `evidence` (texte non vide) |
| `apv:revues` | chaque constat de `findings` | `confidence` et `evidence` |
| `apv:revues`, domaine `concurrence` | chaque chemin de l'inventaire `paths` | `confidence` et `proof` (la preuve du statut) |

Un rapport sans niveau, avec un niveau inconnu, ou dont la preuve est vide est refusé : il va dans `refused` (avec la raison et le rapport reçu, pour le redemander à l'agent) et n'est jamais compté. Le résultat contient `escalation` : `verify` (résultats ou constats `probable`, à vérifier avant d'agir) et `operator` (`suppose`, à remonter). Un constat fusionné par le dédoublonnage garde la preuve la plus forte de ses membres.

Sans outil Workflow, les agents lancés par l'outil Agent rendent un rapport libre avec les mêmes niveaux ; le chef de projet applique les mêmes refus.
