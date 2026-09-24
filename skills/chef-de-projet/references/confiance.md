# Confiance calibrée et escalade

Dans ce document, `apv` désigne l'outil du plugin (voir `SKILL.md`).

Un agent qui écrit « corrigé » ou « cause trouvée » ne dit pas à quel point il en est sûr. Exemple observé (anonymisé) : un correctif a été livré pour un défaut vu en production alors que la cause observée n'avait jamais été reproduite ; ses tests passaient, mais ils ne prouvaient pas que le défaut de production avait disparu. D'où trois niveaux communs à tous les rapports, et des seuils au-delà desquels le chef de projet agit seul, en dessous desquels il vérifie ou remonte à l'opérateur.

## 1. Les trois niveaux
Chaque affirmation importante d'un rapport (constat de revue, cause trouvée, correction, décision prise seul, note d'une grille) porte son niveau et ce qui le fonde :

| Niveau | Veut dire | Exige |
|---|---|---|
| `prouve` | quelqu'un d'autre peut rejouer la preuve et voir la même chose | la preuve reproductible jointe : test qui échoue avant et passe après, commande exacte et sa sortie, requête et réponse, capture (fichier et zone), source officielle citée (adresse, date, extrait) |
| `probable` | le code a été lu ou le raisonnement se vérifie, mais rien n'a été exécuté | la justification vérifiable : chemins et lignes lus, enchaînement du raisonnement, ce qu'une exécution devrait montrer |
| `suppose` | hypothèse | sur quoi elle repose et ce qui la prouverait ou l'infirmerait |

Règles :
- Pas de niveau, un niveau inconnu, ou une preuve ou justification vide : l'affirmation est refusée. Les workflows du plugin refusent le rapport entier (`refused`) ; un rapport libre se redemande à l'agent.
- Dans le doute, le niveau inférieur. Une preuve qui ne porte pas sur l'affirmation (des tests verts qui ne touchent pas le défaut) ne la rend pas `prouve`.
- **Correction** : `prouve` seulement si le défaut a été reproduit avant (test rouge, requête qui réussit à tort) et ne l'est plus après. Si la cause observée ailleurs (production, rapport d'utilisateur) n'a pas pu être reproduite, la correction est au mieux `probable` pour cette cause, même quand ses propres tests passent.
- **Cause trouvée** : `prouve` si une expérience la fait apparaître et disparaître (retirer la cause supprime le symptôme), `probable` sur lecture du code, `suppose` sinon.
- Les niveaux ne remplacent pas les preuves du pipeline : un vert annoncé par un agent reste une affirmation, ta suite complète et `apv gates verify --commit <tête>` restent la preuve.

## 2. Seuils d'escalade du chef de projet
| Niveau reçu | Tu peux agir seul | Avant d'agir |
|---|---|---|
| `prouve` | intégrer, livrer en PR brouillon, fusionner sur ordre de l'opérateur, lui annoncer « corrigé » | vérifier que la preuve porte bien sur l'affirmation (relis-la, rejoue-la si elle est bon marché) |
| `probable` | rien de ce qui précède | une vérification qui la fait passer à `prouve` : un test ou une exécution, lancé par toi ou demandé à l'agent (`SendMessage`, passe de correction qui commence par le test qui reproduit). Impossible à vérifier : traite-la comme `suppose` |
| `suppose` | continuer le travail local et réversible (branche, test d'investigation, journal) | la remonter à l'opérateur **avant** toute action sur la production, toute fusion et toute annonce « corrigé », avec ce qui la prouverait |

Les workflows le préparent : `escalation.verify` liste les résultats `probable` à vérifier, `escalation.operator` les résultats `suppose`. Un constat fusionné par `apv:revues` garde la preuve la plus forte de ses membres.

Tes propres décisions prises seul (écart assumé, faux positif écarté, choix d'architecture noté au journal) portent aussi leur niveau. Un faux positif ne s'écarte qu'en `prouve` (un test ou une démonstration), jamais d'une phrase.

## 3. Dire le niveau à l'opérateur
Chaque affirmation importante d'un compte rendu (point d'étape, corps de PR, remise finale, rapport de fusion) dit son niveau, entre parenthèses, avec sa preuve en quelques mots :
- « Défaut de tri corrigé (prouve : test `liste.spec.ts:42` rouge avant, vert après ; suite complète verte, reçu `<dossier>`). »
- « Cause de l'erreur en production : probablement l'expiration du jeton (probable : lecture de `auth.ts:88`, non reproduite en local). Le correctif est prêt ; je ne l'annonce pas corrigé tant que la cause n'est pas reproduite. »
- « Hypothèse : la lenteur vient de la base hébergée (suppose : à confirmer par les journaux de l'hébergeur, que je ne peux pas lire). »

Jamais « corrigé » sans `prouve`. Une PR qui contient une affirmation `probable` non vérifiée ou `suppose` le dit dans son corps, dans la section des points qui demandent l'opérateur.
