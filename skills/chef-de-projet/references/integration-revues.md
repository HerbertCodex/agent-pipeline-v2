# Intégration, revues et corrections

Dans ce document, `apv` désigne l'outil du plugin (voir `SKILL.md`).

## 1. Intégration d'une vague
1. Toutes les tâches de la vague sont rentrées (ou tu décides d'intégrer celles qui sont prêtes et de relancer les autres).
2. Lance `integrateur` avec : branche de la spec, liste ordonnée des branches de tâches, plan et notes de vague.
3. Il crée `<spec>-integration-<n>` depuis la branche de la spec, fusionne dans l'ordre, unifie les doublons, garde tous les tests, relance tous les contrôles.
4. Tu vérifies son rapport, tu relances les contrôles si le moindre doute existe, puis tu avances la branche de la spec en avance rapide : `git merge --ff-only <spec>-integration-<n>` depuis la branche de la spec.
5. Les branches de tâches restent telles quelles (jamais réécrites).

## 2. Revues indépendantes
Après intégration et avant la PR, quatre revues en parallèle, en lecture seule, chacune sur sa copie isolée du même commit :

| Agent | Quand | Ce qu'il rend |
|---|---|---|
| `qa-securite` | toujours pour un point d'entrée serveur, des données ou une authentification | attaques à deux utilisateurs, API directe, en-têtes, secrets, ZAP, constats prouvés |
| `qa-fidelite` | dès que l'interface change | captures 390 et 1280, clair et sombre, écarts de textes, grille d'accessibilité |
| `architecte-donnees` (revue) | dès qu'une migration ou une requête change | grille 13 bis, sortie de `apv db check`, `EXPLAIN` |
| `dpo` | données personnelles, prestataire, traceur, pages légales | écarts entre pages légales et code, sous-traitants vérifiés |

Donne à chacun : commit exact, port libre, ressources à prendre sous bail, écarts déjà validés par l'opérateur. Mode économe si le quota est serré : revue combinée ou captures limitées aux écrans modifiés, et dis-le dans la PR.

## 3. Décider les constats
Tu décides chaque constat, par écrit, dans `.apv/state/corrections-<spec>.md`, sur le modèle qui a servi au projet pilote :
- un identifiant par constat (S1 pour la sécurité, F1 pour la fidélité, D1 pour les données, R1 pour le RGPD, T1 pour le banc de test) ;
- la gravité ;
- la décision précise (quoi faire, où, avec quelle migration, quel test prouve la correction) ;
- ou l'acceptation justifiée (« écart assumé »), à inscrire dans la PR et à soumettre à l'opérateur s'il touche au produit ou au design.
Les critiques et élevés sont toujours corrigés. Un faux positif se prouve (test ou démonstration), il ne s'écarte pas d'une phrase.

## 4. Passes de correction
- Une passe par domaine (serveur et données, interface), confiée à un `implementer` avec le fichier de corrections comme cahier des charges.
- En parallèle quand les fichiers ne se recouvrent pas ; sinon en séquence.
- Puis intégration si besoin, et nouvelle revue ciblée du domaine corrigé quand la correction est lourde (sécurité surtout).
- Un gel de périmètre de la spec (fichier interdit) peut être levé par toi pour une correction de sécurité : écris-le dans le fichier de corrections.

## 5. Banc de test partagé
Les problèmes de banc (verrou, remise à zéro, dates calculées au chargement du module, attentes fixes, tests sautés) sont des constats comme les autres : un test qui peut être sauté n'est pas une preuve. Les tests « live » échouent (jamais de saut) quand le service manque.
