# Journal du pipeline et communication

## 1. Journal du pipeline
Fichier versionné `.apv/journal-pipeline.md`. Une entrée par incident, qu'il vienne de l'outil, d'un agent, de l'environnement ou de la méthode :

```
<n>. <date> · <étape> · <symptôme> · <cause> · <contournement> · <coût (temps, quota)> · <amélioration proposée>
```

Exemples réels du projet pilote :
- « Verrou partagé · un agent a gardé le verrou pendant environ 40 min en attendant un fichier au lieu de le tenir le temps d'une commande · le verrou n'était qu'une convention · verrou déplacé dans les scripts npm · baux gérés par l'outil, jamais par la discipline des agents. »
- « Fusion · re-ciblage des PR empilées échoué sans message (sortie masquée) · chaque PR fusionnée dans la précédente · PR de rattrapage vérifiée identique au code testé · ne jamais masquer la sortie d'une écriture externe ; vérifier la base juste avant chaque fusion. »

Ajoute aussi un bilan à la fin d'une livraison : durée, ce qui a le mieux marché, ce qui a coûté.

`.apv/state/journal.log` est différent : c'est la ligne horodatée que le hook de fin de tour ajoute automatiquement (reprise). Il n'a pas vocation à être versionné.

## 2. Communiquer avec l'opérateur
- Sa langue, ses mots. Phrases courtes. Aucun tiret cadratin ni demi-cadratin. Aucune promesse absolue ou risquée.
- Pendant la délégation : pas de questions ; des points d'étape brefs seulement quand ils servent (PR ouverte, aperçu mis à jour, pause de quota, décision réservée à prendre).
- Une décision réservée : une question à la fois, le contexte en une phrase, ta recommandation, ce qui en dépend.
- Remise finale :
  1. PR dans l'ordre de fusion (lien, base, résumé) ;
  2. preuves : contrôles relancés par toi (nombres de tests), revues, ZAP ; chaque affirmation importante avec son niveau de confiance (`prouve`, `probable`, `suppose`, `references/confiance.md`), jamais « corrigé » sans `prouve` ;
  3. écarts assumés à valider ;
  4. ce qui demande ses comptes ou son identité (hébergeur, base hébergée et sa région, fournisseur d'e-mail, OAuth, identité de l'éditeur, relecture juridique) ;
  5. aperçu (adresse, compte de démo) ;
  6. journal du pipeline et améliorations proposées.
