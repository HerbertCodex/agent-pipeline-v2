# Intégration, revues et corrections

Dans ce document, `apv` désigne l'outil du plugin (voir `SKILL.md`).

## 1. Intégration d'une vague
Sous `/apv:run`, l'étape `integration` de l'état se tient par `apv run set <id> integration …` ; la branche d'intégration est `apv/<id>-integration-<n>`. Une vague d'une seule tâche s'intègre par avance rapide directe après ta suite complète.

1. Toutes les tâches de la vague sont rentrées (ou tu décides d'intégrer celles qui sont prêtes et de relancer les autres).
2. Lance `integrateur` avec : branche de la spec, liste ordonnée des branches de tâches, plan et notes de vague.
3. Il crée `<spec>-integration-<n>` depuis la branche de la spec, fusionne dans l'ordre, unifie les doublons, garde tous les tests, relance les contrôles de tâche (`apv gates run --stage task`) et les fichiers e2e que ses résolutions touchent.
4. Tu vérifies son rapport, puis **la suite complète, une fois, sur la tête intégrée** (arbre propre, dans le worktree de l'intégrateur ou une copie détachée) : `apv gates run --stage full --repo <worktree>`, puis `apv gates verify --commit <tête> --repo <worktree>`, qui doit sortir en `0`. Alors seulement tu avances la branche de la spec en avance rapide (`git merge --ff-only <spec>-integration-<n>` depuis la branche de la spec) et tu ouvres la vague suivante.
5. **Suite complète rouge** : rien n'avance, la vague n'est pas acceptée. Tu ouvres une passe de corrections (section 4) sur la branche d'intégration, avec les diagnostics des reçus comme cahier des charges, puis la suite complète et `apv gates verify` de nouveau sur la nouvelle tête. Un échec n'est jamais ignoré ni relancé jusqu'à ce qu'il passe par chance : un test instable est un constat (section 5).
6. Les branches de tâches restent telles quelles (jamais réécrites).

## 2. Revues indépendantes
Commande : `/apv:review <id>` (workflow du plugin `apv:revues`, ou l'outil Agent avec un appel par domaine dans un même message). Après intégration et avant la PR, quatre revues en parallèle, en lecture seule, chacune sur sa copie détachée du même commit (`git worktree add --detach`), avec `apv run set <id> review:<domaine> …` (`securite`, `fidelite`, `donnees`, `rgpd`) quand une exécution existe :

| Agent | Quand | Ce qu'il rend |
|---|---|---|
| `qa-securite` | toujours pour un point d'entrée serveur, des données ou une authentification | attaques à deux utilisateurs, API directe, en-têtes, secrets, ZAP, constats prouvés |
| `qa-fidelite` | dès que l'interface change | captures 390 et 1280, clair et sombre, écarts de textes, grille d'accessibilité |
| `architecte-donnees` (revue) | dès qu'une migration ou une requête change | grille 13 bis, sortie de `apv db check`, `EXPLAIN` |
| `dpo` | données personnelles, prestataire, traceur, pages légales | écarts entre pages légales et code, sous-traitants vérifiés |

Les constats sont consolidés et dédoublonnés dans `.apv/state/revues-<id>-<sha court>.md`, sans en écarter aucun. Donne à chacun : commit exact, copie détachée, port libre, ressources à prendre sous bail, écarts déjà validés par l'opérateur, et les reçus de la suite complète qui vient de passer sur ce commit (dossier `.apv/receipts/<exécution>/`, sortie de `apv gates verify --commit <commit>`) : les revues ne relancent pas la suite navigateur, sauf besoin précis de leur domaine. Mode économe si le quota est serré : revue combinée ou captures limitées aux écrans modifiés, et dis-le dans la PR.

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
