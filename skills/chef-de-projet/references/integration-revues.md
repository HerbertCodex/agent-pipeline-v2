# Intégration, revues et corrections

Dans ce document, `apv` désigne l'outil du plugin (voir `SKILL.md`).

## 1. Intégration d'une vague
Sous `/apv:run`, l'étape `integration` de l'état se tient par `apv run set <id> integration …` ; la branche d'intégration est `apv/<id>-integration-<n>`. Une vague d'une seule tâche s'intègre par avance rapide directe après ta vérification.

1. Toutes les tâches de la vague sont rentrées (ou tu décides d'intégrer celles qui sont prêtes et de relancer les autres).
2. Lance `integrateur` avec : branche de la spec, liste ordonnée des branches de tâches, plan et notes de vague.
3. Il crée `<spec>-integration-<n>` depuis la branche de la spec, fusionne dans l'ordre, unifie les doublons, garde tous les tests, relance les contrôles de tâche (`apv gates run --stage task`) et les fichiers e2e que ses résolutions touchent.
4. Tu vérifies son rapport (sa tête relue par `git rev-parse <spec>-integration-<n>`, jamais le sha du rapport tel quel), puis tu relances toi-même, sur la tête intégrée (arbre propre, dans le worktree de l'intégrateur ou une copie détachée), la vérification que l'étape demande (`apv run next` la donne ; réglage `run.fullSuite` de `.apv/config.json`) :
   - **intégration intermédiaire**, avec `"final"` (défaut) : `apv gates run --stage task --base <base ciblée> --repo <worktree>`, puis `apv gates verify --commit <tête> --stage task --base <base ciblée> --repo <worktree>` à `0` ; la base ciblée est le dernier commit prouvé par la suite complète (la base de l'exécution tant qu'aucune n'est passée), si bien que les tests ciblés couvrent tous les changements depuis ;
   - **dernière intégration** (toutes les tâches intégrées), ou chaque intégration avec `"each-integration"` : **la suite complète, une fois, sur la tête intégrée** : `apv gates run --stage full --run <id> --repo <worktree>`, puis `apv gates verify --commit <tête> --repo <worktree>`, qui doit sortir en `0` ; garde ce worktree et ses reçus pour les revues et la livraison.
   Alors seulement tu avances la branche de la spec en avance rapide (`git merge --ff-only <spec>-integration-<n>` depuis la branche de la spec) et tu ouvres la vague suivante.
5. **Suite complète rouge**, ou contrôle de tâche ou ciblé rouge : rien n'avance, la vague n'est pas acceptée ; tu ouvres une passe de corrections, jamais ignorée (section 4), sur la branche d'intégration, avec les diagnostics des reçus comme cahier des charges, puis la même vérification de nouveau sur la nouvelle tête. Un échec n'est jamais ignoré ni relancé jusqu'à ce qu'il passe par chance : un test instable est un constat (section 5).
6. Les branches de tâches restent telles quelles (jamais réécrites).

## 2. Revues indépendantes
Commande : `/apv:review <id>` (workflow du plugin `apv:revues`, ou l'outil Agent avec un appel par domaine dans un même message). Après intégration et avant la PR, les revues que le diff demande (`apv review plan --base <base> --head <commit>` : `securite` toujours, les autres seulement sur preuve qu'elles ont quelque chose à relire ; `--force <domaine>` en garde un), en parallèle, en lecture seule, chacune sur sa copie détachée du même commit (`git worktree add --detach`), avec `apv run set <id> review:<domaine> …` (`securite`, `fidelite`, `donnees`, `rgpd` ; un domaine sauté avec `skipped --note "<raison de l'outil>"`) quand une exécution existe :

| Agent | Quand | Ce qu'il rend |
|---|---|---|
| `qa-securite` | toujours, sans exception | attaques à deux utilisateurs, API directe, en-têtes, secrets, lecture du rapport du scan dynamique (ZAP) lancé par toi, constats prouvés |
| `qa-fidelite` | l'interface ou une maquette validée change de contenu | captures 390 et 1280, clair et sombre, écarts de textes, grille d'accessibilité |
| `architecte-donnees` (revue) | une migration, un schéma, une requête ou un dépôt change | grille 13 bis, sortie de `apv db check`, `EXPLAIN` |
| `dpo` | migration, données personnelles, export, prestataire, traceur, pages légales | écarts entre pages légales et code, sous-traitants vérifiés |

Copies détachées dans ton dossier de session (ou sous un chemin que l'outil donne), jamais à côté du dépôt, retirées par `git worktree remove` à la fin. **Scan dynamique** : les agents de revue n'ont pas le droit de lancer Docker ; si le projet déclare `review.dast`, tu lances toi-même `apv dast run --repo <copie> --out <dossier de session>/dast-<sha court> --commit <commit>` avant les revues (verrou `review.dast.resource` pris par l'outil ; attente d'un long scan par `apv wait --file <dossier>/summary.json`), et le dossier des rapports va à `qa-securite`, qui les lit ; sans scan déclaré ou abouti, la raison lui est donnée et le scan est « non vérifié » dans la PR (compétence `review`, section 3 bis).

Les constats sont consolidés et dédoublonnés dans `.apv/state/revues-<id>-<sha court>.md`, sans en écarter aucun. Donne à chacun : commit exact, copie détachée, port libre, ressources à prendre sous bail, écarts déjà validés par l'opérateur, et les reçus de la suite complète qui vient de passer sur ce commit (dossier `.apv/receipts/<exécution>/`, sortie de `apv gates verify --commit <commit>`) : les revues ne relancent pas la suite navigateur, sauf besoin précis de leur domaine. Mode économe si le quota est serré : revue combinée ou captures limitées aux écrans modifiés, et dis-le dans la PR.

## 3. Décider les constats
Tu décides chaque constat, par écrit, dans `.apv/state/corrections-<spec>.md`, sur le modèle qui a servi au projet pilote :
- un identifiant par constat (S1 pour la sécurité, F1 pour la fidélité, D1 pour les données, R1 pour le RGPD, T1 pour le banc de test) ;
- la gravité ;
- le niveau de confiance du constat (`prouve`, `probable`, `suppose`, `references/confiance.md`) : un constat `probable` se prouve d'abord (la passe de correction commence par le test qui le reproduit) ; un constat `suppose` critique ou élevé se prouve ou remonte à l'opérateur avant toute fusion ;
- la décision précise (quoi faire, où, avec quelle migration, quel test prouve la correction) ;
- ou l'acceptation justifiée (« écart assumé »), à inscrire dans la PR et à soumettre à l'opérateur s'il touche au produit ou au design.
Les critiques et élevés sont toujours corrigés. Un faux positif se prouve (test ou démonstration), il ne s'écarte pas d'une phrase : l'écarter est une décision prise seul, qui exige `prouve`.

## 4. Passes de correction
- Une passe par domaine (serveur et données, interface), confiée à un `implementer` avec le fichier de corrections comme cahier des charges.
- Chaque correction revient avec son niveau : `prouve` exige le test qui échouait avant la correction et passe après. Une correction `probable` ou `suppose` n'est pas annoncée « corrigée » (seuils de `references/confiance.md`). Le niveau de la passe se note dans l'état : `apv run set <id> fixes done --commit <sha relu> --confidence <niveau le plus bas des corrections>`.
- En parallèle quand les fichiers ne se recouvrent pas ; sinon en séquence.
- Puis intégration si besoin : avec `"final"`, au niveau tâche (contrôles de tâche et tests ciblés depuis la tête revue, `apv gates verify --commit <tête> --stage task --base <tête revue>` à `0`, et le test qui prouve chaque correction vu vert) ; la suite complète vient une fois, à la livraison. Avec `"each-integration"`, suite complète à chaque passe. Nouvelle revue ciblée du domaine corrigé quand la correction est lourde (sécurité surtout) ; ses reçus sont alors ceux du niveau tâche, dits comme tels.
- Un gel de périmètre de la spec (fichier interdit) peut être levé par toi pour une correction de sécurité : écris-le dans le fichier de corrections.

## 5. Banc de test partagé
Les problèmes de banc (verrou, remise à zéro, dates calculées au chargement du module, attentes fixes, tests sautés) sont des constats comme les autres : un test qui peut être sauté n'est pas une preuve. Les tests « live » échouent (jamais de saut) quand le service manque.
