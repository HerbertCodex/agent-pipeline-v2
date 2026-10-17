# Accélérer les lots sans affaiblir la preuve

Statut : **brouillon de spec, à valider par l'opérateur**. Aucune ligne de code avant sa validation. Écrit sur la branche `apv3` (après la PR #139), non commité.
Méthode du dépôt : spec d'abord, validée, puis phases de code en petites PR (section 11), chacune avec ses tests qui refusent et ses tests qui acceptent ([REGLES.md](REGLES.md), section 6).

Le document a quatre parties de fond, indépendantes et livrables séparément :
- **A. Réutiliser les contrôles verts dans le lot** : un contrôle dont les entrées n'ont pas changé est repris avec son reçu d'origine, prouvé par empreintes.
- **B. Reporter les relectures et les dérogations** sur un commit dont le delta ne touche pas leur périmètre ; relecture de delta pour le reste.
- **C. Jouer tôt ce qui échoue tard** : les contrôles rapides que le projet déclare, au stage task.
- **D. Avertir d'une PR mélangée** : fonctionnalité plus changement transversal, avec la suggestion de découper.

## 1. Demande et constat

Projet pilote, PR #262 (« Accueil : la fin devient le talon-réponse », une petite fonctionnalité) : une journée, dont l'essentiel dans la preuve, pas dans le code.

- `apv stack batch 262 --merge --ready --dast --stacks 1,2,3 --wait-ci 40` refait une suite complète d'environ 40 minutes à chaque nouveau commit : `npm ci` de la copie du lot et de chaque copie de pile, `integration` et `browser` (Playwright) répartis sur trois piles Supabase locales, puis le scan ZAP. Le 17 octobre, les suites complètes du dépôt partent à 16 h 41, 17 h 22 et 18 h 11 (`apv gates receipts list`) : 41 et 48 minutes d'écart.
- La suite à `209e963a68fc` a 14 contrôles verts sur 15 (`browser` rouge, `apv gates verify --commit 209e963a68fc`). Le commit suivant ne change qu'un fichier de test et deux images de référence : les 15 contrôles, le scan et les trois `npm ci` sont rejoués.
- La règle `relecture` exige les relectures `securite`, `fidelite` (4 captures) et `rgpd` **au commit exact** : trois séries pour trois commits, dont deux sans aucun changement de code servi. La dérogation `maquette`, que seul l'opérateur tape, est elle aussi liée au commit : retapée à chaque fois.
- Deux échecs n'apparaissent qu'en fin de suite complète : le budget JavaScript des pages de guide (`tests/e2e/integration/client-bundle.e2e.ts` du projet, 86 ko gzip) et un test à captures instable (couleur aléatoire). Les deux auraient pu se voir au stage task en quelques minutes.
- La PR mêlait la fonctionnalité et une harmonisation sur tout le site (environ 30 fichiers au moment des relectures, chemins sensibles compris ; `gh pr view 262` en compte 71 sur 13 commits le 17 octobre au soir) : relectures plus longues, plus de domaines retenus.

Leçon générique : **la preuve est liée au commit, alors que ce qu'elle prouve dépend du contenu.** Un nouveau commit qui ne change rien de ce qu'un contrôle lit, ou rien du périmètre d'une relecture, ne devrait pas en racheter la preuve. Et ce qui peut échouer vite doit tourner tôt.

## 2. État des lieux (code de `apv3` au 17 octobre 2026)

### 2.1 Comment `apv stack batch` construit sa preuve

- `buildLot` (`src/stack/batch.ts:263-281`) crée une branche `apv/lot-<horodatage>` dans un **nouveau worktree** (`worktree add -b`, ligne 265) depuis la tête de la cible, puis fusionne chaque PR en `merge --no-ff` (ligne 224). La tête du lot est donc **toujours un commit neuf** (date du committer comprise), même quand la cible et la tête de la PR n'ont pas bougé : son SHA ne se retrouve jamais d'un lot à l'autre. Son **arbre**, lui, est identique pour les mêmes entrées.
- Avant toute construction, avec `--merge`, les règles sont vérifiées pour chaque tête de PR sans `preuve` ni `instable` (`src/stack/batch.ts:430-438`, appel `checkMergeRules(... skip: ['preuve', 'instable'])` en `src/commands/stack.ts:532`) : une relecture manquante refuse le lot avant la suite.
- La preuve (`prove`, `src/commands/stack.ts:453-494`) lit la configuration **de la cible** (`atCommit(base)`), lance `batch.setup` (`npm ci`) dans le worktree du lot, puis `runGates({ stage: 'full', ... })` (ligne 468) et `verifyGates` à la tête du lot (ligne 478). Avec `--stacks`, `planSpread` et `prepareCopies` (`src/gates/spread.ts:92-110`) créent une copie détachée par pile supplémentaire et y relancent `batch.setup`, **l'une après l'autre** (boucle `for ... await`).
- Un lot prouvé sans `--merge` dit lui-même qu'une fusion relancera tout : « une nouvelle suite tourne sur un nouveau lot » (`src/commands/stack.ts:557`).
- Le lot ne réutilise rien, pour trois raisons cumulées : la tête est un SHA neuf ; la clé de preuve contient ce SHA et le chemin du worktree (section 2.2) ; `runGates` n'a aucun chemin de réutilisation.
- La fusion est contrôlée **par contenu** : l'arbre de la cible avant et après chaque fusion doit être celui du lot (`src/stack/batch.ts:543-610`, `finalTree.identical`). C'est sur ce lien par l'arbre que la partie A s'appuie.

### 2.2 Reçus, `reusedFrom` et `--skip-proven` aujourd'hui

- Le schéma du reçu prévoit le statut `cached` et le champ `reusedFrom` (`src/domain/contracts.ts:252`, `:274`), avec l'invariant « seul un `cached` cite un reçu antérieur » (`:346`). **Aucun code ne produit de reçu `cached`** : `runGates` écrit toujours `reusedFrom: null` (`src/gates/run.ts:621`, `:786`, `:793`). Le champ `cacheTtlMs` (`src/domain/contracts.ts:80-81`, invariant `:372`, décrit dans [CONFIGURATION.md](CONFIGURATION.md) lignes 174 à 194) est un reste de V2 : lu par le schéma, jamais par l'exécution.
- La clé de preuve (`proofKey`, `src/evidence/key.ts`) hache le dépôt, la base, **le commit candidat**, l'empreinte de configuration, l'empreinte d'environnement, **le worktree**, la définition du contrôle, les clés des dépendances et l'exécutable. Elle n'est relue par personne pour réutiliser : elle identifie seulement le reçu.
- Empreintes enregistrées dans chaque reçu : `configHash` = `gatesConfigHash` (`src/gates/run.ts:246-248`, contrôles et `passEnv`), `environmentHash` = `environmentIdentity` (`src/evidence/key.ts`) : identifiant, **valeurs des variables transmises** (donc les ports et adresses de la pile), exécutable et son sha256, version de Node, plateforme, noyau, version de l'outil. **Aucune empreinte des fichiers lus** : le commit en tient lieu.
- `--skip-proven` (`src/commands/gates.ts:355-356`, `:417-427`, `provenFull` en `:221-229`) : tout ou rien, au **même commit** seulement. Si `apv gates verify --commit HEAD` sort à 0 sur un arbre propre, la suite complète n'est pas relancée. Refusé avec `--stage task` ou `--only`. `apv stack batch` ne l'utilise pas, et ne pourrait pas (tête neuve).
- `--stage task --since <commit prouvé>` (`src/gates/since.ts`) : preuve incrémentale d'un tour de corrections, si l'arbre est propre, HEAD descend du commit, la suite complète y est prouvée sans relance et le diff est de **risque faible** (`planReviews`, tests, documentation, maquettes). Elle lance les contrôles de tâche et les commandes ciblées, **jamais une preuve de la suite complète**.
- `skipWhenOnly` (`src/gates/proof-scope.ts`, liste `ALWAYS_REQUIRED` lignes 27 à 45) : une suite complète dont tous les fichiers changés depuis la base **et** la référence sont sans effet (documentation, décisions) écrit un reçu `not_required`, recalculé par `verify`. C'est un précédent de « portée lue à la base, recalculée depuis Git », mais comparé à la cible, jamais à un commit déjà prouvé.

### 2.3 Comment `apv gates verify` et la règle `preuve` jugent un reçu

- `verifyGates` (`src/gates/verify.ts:213-357`) retient les reçus dont `candidateSha === commit` (ligne 233), non ciblés à la stage full (`:324`), à la même `configHash` (`:327`), sur arbre propre (`:329`), et pour chaque contrôle **le plus récent** décide (`:336`). Il recalcule depuis le commit la répétition des tests modifiés (`repeatGap`), la portée (`scopeGap`) et l'audit web (`webGap`).
- `success` (`src/engine/scheduler.ts:10`) compte `cached` comme une réussite. **`verify` ne contrôle ni `reusedFrom`, ni l'existence du reçu d'origine, ni `environmentHash`** : un reçu `cached` écrit à la main passerait. Ce n'est pas pire qu'un reçu `passed` écrit à la main (les reçus ne sont pas signés, [SHIFT-LEFT.md](SHIFT-LEFT.md) section 2, Q8), mais la partie A doit fermer ce point **avant** de produire des reçus `cached` (PR A0).
- La règle `preuve` (`src/rules/check.ts:438-500`) appelle `verifyGates` au commit exact, avec les contrôles de la base gardés (`applyBaseGates`), puis la preuve CI ou la voie réduite sur ordre ([PREUVE-REDUITE.md](PREUVE-REDUITE.md)). Dans le lot, `preuve` et `instable` sont jugées sur la suite du lot.

### 2.4 Comment `relecture`, `captures`, `maquette` et les dérogations sont liées au commit

- Les relectures sont rangées par commit (`<répertoire git commun>/apv/reviews/<commit>/<domaine>/`, `src/rules/reviews.ts`). `recordReview` exige que la copie relue soit **à ce commit**, propre, et que le rapport le cite. `latestReviews(common, sha)` ne lit que le dossier de ce commit, sceau du crochet vérifié.
- Seul report existant : `carriedHeads` (`src/rules/carry.ts`), pour une tête qui **fusionne la cible** avec un diff identique octet pour octet (PR #230). Un commit ordinaire de la branche, même de tests seuls, ne reporte rien ([REGLES.md](REGLES.md), « Un nouveau commit (une correction) demande une nouvelle relecture : c'est voulu »).
- Règle `relecture` : `src/rules/check.ts:534-585` (domaines retenus par `planReviews` depuis la base commune, `securite` toujours, `ALWAYS_REVIEWED`). Règle `captures` : `:587-620`, quatre captures dans la relecture `fidelite` au commit. Règle `maquette` : `:634-647`.
- Dérogations : `waiverFor` (`src/rules/operator.ts:603-632`) cherche dans les messages tapés par l'opérateur « dérogation <règle> <12 caractères du commit au moins> : <raison> » ; le préfixe doit être celui **du commit jugé**. Boucle finale `src/rules/check.ts:649-660`. Une dérogation ne se reporte jamais, même par `carry.ts`.
- Le plan des relectures sait déjà classer un diff quelconque fichier par fichier (`planReviews`, `src/review/plan.ts:565-673`, `keeps` par domaine, risque `faible` ou `eleve`) : appliqué au delta `C..C'`, il dit quel domaine ce delta touche.

### 2.5 Ce que disent déjà PREUVE-REDUITE.md et SHIFT-LEFT.md, et ce qui est codé

- **PREUVE-REDUITE.md** : voie réduite **sur ordre signé seulement**, pour un diff tenu dans une liste fermée de contenu régénéré ; « jamais pour une PR ordinaire ; `apv stack batch` n'accepte jamais la preuve réduite » (section 2). Phases 1 à 3 codées (PR #136, `src/rules/reduced-proof.ts`). Elle ne touche ni aux lots, ni aux relectures. Ce document ne la modifie pas.
- **SHIFT-LEFT.md**, partie II : relecture par tâche et `apv review coverage` avec delta d'intégration (section 7.2), captures par l'outil (section 8), suite d'impact `--stage impact` (section 9), voie des réglages (10.2). Phases validées le 2026-10-04 (section 25). **Codé** : mesure (`apv metrics run`, `apv metrics prs`), files de suites `per-stack`, voie sans code (`src/rules/docs-only.ts`), `--since` (section 2.2 ci-dessus). **Pas codé** : `apv review coverage`, `--stage impact`, voie des réglages, `apv tdd`, captures par l'outil, isolation par worktree.
- Écart avec ce document : SHIFT-LEFT réduit la fin **par tâche** (relire tôt, prouver par impact) ; il garde la suite entière une fois par lot (9.3). Ce document réduit le **rachat** de la preuve d'un commit à l'autre, dans le lot et dans les règles. Les deux se complètent : la partie B reprend l'idée de delta de SHIFT-LEFT 7.2, entre deux commits de la même PR au lieu de tâche à tête.
- Côté projet pilote : `integration` et `browser` sont de stage `full` sans `affected` (`.apv/config.json`), alors que le projet a déjà `npm run test:e2e:changed` (Playwright `--only-changed`). Ce script choisit par graphe d'imports des tests : un composant servi qu'aucun test n'importe, comme une page de guide pour `client-bundle.e2e.ts`, ne sélectionne rien.

## 3. Objectif et limites

Objectif :
1. Un commit qui ne change pas les entrées d'un contrôle ne le relance pas ; la preuve reste au commit fusionné, par un reçu `cached` que `verify` recontrôle depuis Git.
2. Un commit qui ne touche pas le périmètre d'un domaine de relecture ne la rachète pas ; ce qui le touche se relit en delta, borné aux fichiers du delta.
3. Ce qui échoue en fin de suite pour une cause rapide à observer échoue au stage task.
4. Une PR mélangée est signalée avant les relectures.

Garde-fous **inchangés**, et vérifiés par des tests de non-régression (AC-NO-WEAKER) :
- `preuve` : chaque contrôle exigé est prouvé **au commit exact fusionné**, contrôles de la base compris ; un reçu réutilisé n'est qu'une preuve recontrôlée de la même chose sur un contenu identique pour ce contrôle.
- La fusion du lot reste contrôlée par arbre (2.1) ; la configuration des contrôles reste lue à la cible.
- `instable` reste stricte : un `passed_after_retry` n'est jamais réutilisé ni reporté.
- `securite` est relue pour **chaque** PR et pour chaque delta de code ; aucun report silencieux de la relecture de sécurité (section 6.3).
- Les captures existent toujours pour le code servi fusionné.
- Une dérogation reste les mots de l'opérateur ; aucun agent ne peut en créer une, ni en étendre une à `preuve` ou `instable`.
- Ce qui définit les exemptions (entrées ignorées, périmètres) se lit **à la base commune**, jamais au candidat : une PR ne s'exempte pas elle-même.
- La voie réduite sur ordre (PREUVE-REDUITE.md) n'est pas étendue aux lots.

## 4. Vocabulaire

| Terme | Sens |
|---|---|
| `C` | commit où un contrôle a réussi, ou où une relecture a été enregistrée |
| `C'` | commit jugé : nouvelle tête de PR, ou tête de lot |
| Entrées d'un contrôle | ce dont son résultat dépend : les fichiers suivis qu'il lit, sa définition, la configuration des contrôles, l'environnement |
| Fichiers ignorés d'un contrôle | globs que le projet déclare, à la base, comme **non lus** par ce contrôle (`reuse.ignore`) ; tout le reste est une entrée |
| Empreinte des entrées | sha256 de la liste triée `(chemin, mode, blob)` des fichiers suivis de l'arbre, moins les fichiers ignorés |
| Reçu d'origine | reçu `passed` (exécuté) dont un reçu `cached` est la reprise |
| Delta | `git diff C..C'` (sans renommages), `C` ancêtre de `C'` |
| Périmètre d'un domaine | les fichiers dont `planReviews`, appliqué au delta, retient ce domaine |
| Contrôle tôt | commande rapide qu'un contrôle `full` déclare pour le stage task (`early`), jamais une preuve du contrôle |

## 5. Partie A. Réutilisation des contrôles verts

### 5.1 Problème

Le lot rejoue chaque contrôle à chaque commit, alors que la plupart des contrôles lisent exactement les mêmes fichiers. Sur #262, le dernier commit n'a changé que des fichiers lus par `browser` ; les 14 autres contrôles, les deux `npm ci` des copies de pile et le scan ont été rejoués pour rien. Un lot relancé sur le même arbre (PR et cible inchangées, ou lot prouvé puis fusionné) rejoue tout aussi.

### 5.2 Comportement attendu

**A1. Réutilisation à arbre identique (par défaut).** Avant de lancer un contrôle, `runGates` cherche (copie locale puis magasin partagé, intact) le reçu le plus récent de ce contrôle dont **l'arbre** du commit est identique à celui de `C'`, à la même `configHash`, à la même identité d'environnement de réutilisation (5.4), réussi au premier passage, arbre propre, non ciblé. S'il le trouve, et si aucun reçu plus récent du même contrôle sur un arbre identique n'est un échec, il écrit un reçu `cached` à `C'` au lieu de lancer la commande. Cas couverts : lot relancé, lot prouvé puis fusionné, tête de PR qui contient déjà la cible et dont la suite complète est prouvée (l'arbre du lot est alors celui de la PR).

**A2. Réutilisation à entrées identiques (déclarée).** Un contrôle qui déclare, à la base, les fichiers qu'il ne lit pas :

```json
{ "id": "integration", "stage": "full", "command": ["npm", "run", "test:integration"],
  "reuse": { "ignore": ["tests/e2e/browser/**", "tests/e2e/**/*-snapshots/**", "docs/**", ".apv/state/**", "**/*.md"],
             "maxAgeMs": 172800000 } }
```

est repris quand l'empreinte de ses entrées est la même à `C` et à `C'`. Forme par **exclusion** volontaire : un fichier ou un dossier nouveau est une entrée tant que personne ne l'a déclaré sans effet. Jamais ignorables, quoi que dise la configuration (refus du chargeur) : la configuration des contrôles, les manifestes et verrous de dépendances, la configuration de build, de test et d'exécution, la CI, les migrations, `scripts/**`, `.env*` (liste `ALWAYS_REQUIRED` de `src/gates/proof-scope.ts` moins les dossiers de tests), et les propres `testPaths` et `repeatChanged.paths` du contrôle.

**A3. Ce qui n'est jamais repris** :
- un contrôle sans `reuse` hors arbre identique (A1 seulement) ;
- un contrôle `reuse: false` ; par défaut ceux qui lisent un état extérieur au dépôt : une commande qui lance `apv web audit` ou `apv dast`, et tout contrôle que le projet déclare tel (exemple pilote : `security-audit-ci`, dont la base d'avis change avec le temps) ;
- un reçu d'origine `passed_after_retry`, `cached` (pas de chaîne : `reusedFrom` cite toujours un reçu exécuté), `dirty`, `targeted`, plus vieux que `reuse.maxAgeMs` (24 h par défaut, l'âge ne se renouvelle jamais par une reprise) ;
- un contrôle dont un reçu **plus récent** sur la même empreinte d'entrées a échoué (même règle que `verify` : un échec plus récent l'emporte) ;
- tout contrôle quand l'opérateur ou le chef demandent le rejeu : `--replay <id>,<id>` ou `--replay all` (`apv gates run`, `apv stack batch`).

**A4. Le lot ne prépare que les copies utiles.** Les copies de pile ne sont créées et préparées (`batch.setup`) que pour les piles qui reçoivent au moins un contrôle à exécuter. Si aucun contrôle n'est à exécuter dans la copie du lot, `batch.setup` n'y tourne pas non plus.

**A5. Scan dynamique repris.** `--dast` enregistre un relevé dans le magasin partagé, avec le manifeste sha256 des reçus (commit, arbre, empreinte des réglages `review.dast` de la cible, résultat, chemin du rapport). Un lot dont l'arbre ne diffère du dernier scan réussi que par des fichiers de risque `faible` (classement de `planReviews`, celui de `--since` : tests, documentation hors dossiers servis, maquettes) et aux mêmes réglages reprend le scan, dit « scan repris de `<commit>` (delta sans code servi : N fichiers) ». Tout autre delta relance ZAP.

Sortie : chaque contrôle repris est une ligne « réutilisé » (libellé déjà prévu, `src/commands/gates.ts:152`) avec le commit et l'exécution d'origine, et la raison (« arbre identique » ou « entrées identiques : N fichiers changés, tous ignorés par ce contrôle »).

### 5.3 Ce que porte le reçu `cached`

Un reçu ordinaire à `C'` (`candidateSha = C'`, `runId` de l'exécution courante), `status: "cached"`, `exitCode: 0`, les empreintes de flux du reçu d'origine, `reusedFrom` = identifiant du reçu d'origine, plus :

```json
"reuse": { "fromRun": "<exécution>", "fromCommit": "<C>", "basis": "tree" | "inputs",
           "inputsDigest": "<sha256>", "ignoreDigest": "<sha256 des globs lus à la base>",
           "environment": "<identité de réutilisation>", "changed": 3, "files": ["..."] }
```

### 5.4 Identité d'environnement de réutilisation

`environmentHash` contient les valeurs des variables de la pile (ports, adresses), différentes d'une pile à l'autre : telle quelle, elle interdirait toute reprise entre piles. L'identité de réutilisation est `environmentIdentity` calculée avec les variables venues du fichier d'environnement de la pile **remplacées par l'identité de la pile** :
- la déclaration de la pile (section `stacks`, sans son `envFile`), et la sortie de sa commande d'empreinte si le projet en déclare une (`stacks[].fingerprint`, par exemple les digests des images Docker et la version de la CLI Supabase) ;
- sans commande d'empreinte : identifiant de pile égal exigé (pas de reprise d'une pile à l'autre).

Le reste est inchangé : exécutable et son sha256, Node, plateforme, noyau, version de l'outil, autres variables transmises.

### 5.5 Comment `apv gates verify` le prouve

Pour un reçu `cached`, `verify` ne lui fait jamais confiance et recontrôle tout depuis Git et le magasin :
1. Le reçu d'origine existe (copie locale ou magasin partagé **intact**, manifeste sha256 de `src/gates/store.ts`), même `gateId`, `status: "passed"`, `dirty: false`, non ciblé, même `configHash` que la configuration vérifiée, âge sous `reuse.maxAgeMs` lu à la base.
2. `basis: "tree"` : `rev-parse C^{tree}` égal à `rev-parse C'^{tree}`. `basis: "inputs"` : l'empreinte des entrées, **recalculée** à `C` et à `C'` avec les globs `reuse.ignore` lus **à la base commune** de `C'` et de sa cible, est la même des deux côtés et égale à `inputsDigest`. Des globs changés par la PR ne servent jamais.
3. L'identité de réutilisation du reçu est celle enregistrée dans le reçu d'origine (identité recalculée à l'exécution ; verify ne peut pas la mesurer après coup, comme aujourd'hui pour `environmentHash`, et compare les deux valeurs écrites).
4. Aucun reçu du contrôle plus récent que l'origine, sur la même empreinte, n'est un échec.
5. `repeatChanged`, `skipWhenOnly`, audit web : recalculés à `C'` comme aujourd'hui. Pour `repeatChanged`, les fichiers de test à répéter à `C'` doivent être parmi ceux répétés par l'origine, avec le même blob (impliqué par 2, ces chemins sont des entrées), sinon état `unrepeated`.
6. Sinon : état nouveau `reuse` (« reçu réutilisé non prouvant : <raison> »), qui refuse comme `missing`.

Dès la PR A0, avant tout reçu `cached` produit par l'outil : un reçu `cached` qui ne passe pas 1 à 4 ne prouve rien (aujourd'hui il passerait, section 2.3).

### 5.6 Cas limites

| Cas | Comportement |
|---|---|
| La cible a avancé (fusion de `main` dans la PR, ou lot construit sur une cible plus récente) | empreinte recalculée sur le nouvel arbre ; un fichier d'entrée changé par la cible fait rejouer. Pour `integration` et `browser`, presque toute fusion de code la change : rejoués |
| Test instable | origine `passed_after_retry` jamais reprise ; un échec plus récent sur les mêmes entrées interdit la reprise ; `--replay` pour un rejeu exigé |
| Rejeu exigé par un relecteur ou l'opérateur | `--replay <id>` ; l'exécution le note, le reçu est exécuté |
| Contrôle sans `reuse` | repris seulement à arbre identique (A1) ; sinon toujours rejoué |
| Contrôle qui lit un état extérieur | `reuse: false` (défaut pour `apv web audit` et `apv dast`) ; toujours rejoué |
| Configuration des contrôles changée | `configHash` différente : rien n'est repris ; une PR qui change `reuse` est déjà prouvée seule (`configDrift`, `src/commands/stack.ts:425-435`) |
| Contrôle avec dépendances | repris seulement si chacune de ses dépendances est reprise ou exécutée verte dans la même exécution, et sa clé de dépendances recalculée |
| Reçu d'origine retiré par la rétention | pas de reprise ; un reçu `cached` dont l'origine a disparu ne prouve plus rien (`verify` le dit) |
| Arbre sale | aucune reprise (une suite complète y est déjà refusée) |

### 5.7 Risques et garde-fous

- **Déclaration `ignore` trop large** (un contrôle lit un fichier déclaré non lu) : forme par exclusion, liste jamais ignorable imposée par le chargeur, déclaration lue à la base, donc ajoutée par une PR de configuration seule, relue (`securite` retient la configuration) et prouvée en entier. Tout élargissement d'`ignore` passe par cette voie, comme un changement de contrôle.
- **Reçu forgé** : même niveau de garantie qu'un reçu `passed` aujourd'hui, et `verify` recontrôle l'origine et les empreintes depuis Git (5.5). A0 ferme le cas actuel où un `cached` passerait sans origine.
- **Résultat dépendant du temps ou du réseau** : `reuse: false` et `maxAgeMs`.
- **La preuve reste liée à ce qui part en production** : le reçu est écrit à `C'`, le commit fusionné ; l'empreinte prouve que tout ce que le contrôle lit est identique au contenu où il a réussi ; la fusion reste contrôlée par arbre.

### 5.8 Critères d'acceptation

- **AC-REUSE-A0** : un reçu `cached` sans origine, avec une origine `passed_after_retry`, `dirty`, d'une autre `configHash`, trop vieille ou absente du magasin, fait sortir `apv gates verify` en 1 avec la raison.
- **AC-REUSE-TREE** : deux lots successifs des mêmes PR sur la même cible : le second écrit 15 reçus `cached` (`basis: tree`) sauf `reuse: false`, aucun `batch.setup` dans les copies de pile, `verify` à 0.
- **AC-REUSE-INPUTS** : un commit qui ne change que `tests/e2e/browser/x.e2e.ts` et deux images sous `*-snapshots/` : `integration` repris (`basis: inputs`), `browser` exécuté ; le même commit avec en plus `src/lib/x.ts` : les deux exécutés.
- **AC-REUSE-NEVER-IGNORE** : `reuse.ignore` qui couvre `package-lock.json`, `.apv/config.json`, une migration ou un `testPaths` du contrôle est refusé par le chargeur.
- **AC-REUSE-BASE** : une PR qui élargit `reuse.ignore` ne s'en sert pas pour sa propre preuve (globs lus à la base).
- **AC-REUSE-LATEST-FAIL** : origine verte puis échec plus récent sur la même empreinte : rejoué.
- **AC-REUSE-STACK** : sans `stacks[].fingerprint`, une origine sur la pile 2 n'est pas reprise pour un contrôle assigné à la pile 3 ; avec une empreinte égale, elle l'est.
- **AC-REUSE-REPLAY** : `--replay browser` exécute `browser` même repris possible.
- **AC-REUSE-DAST** : delta de tests seuls depuis le dernier scan réussi : scan repris ; un fichier sous `src/` : ZAP relancé.

### 5.9 Gain estimé sur #262

Estimation, pas une mesure (la mesure viendra de `apv metrics prs`) : sur le lot qui suit le commit « un test et deux images », `browser` reste exécuté, `integration`, les 13 contrôles de tâche et le scan sont repris, une seule copie de pile est préparée au lieu de trois. `browser` reste le plus long : de 40 à 48 minutes à environ 25 à 35 minutes (gagnés : ZAP, deux `npm ci` séquentiels, la part d'`integration` qui dépasse `browser`). Hors #262, un lot prouvé puis fusionné, ou relancé à l'identique, passe de 40 minutes à une ou deux.

## 6. Partie B. Report des relectures et des dérogations

### 6.1 Problème

Une relecture enregistrée à `C` ne vaut que pour `C`. Un commit qui ne change qu'un test et deux images de référence rachète les relectures `fidelite` (quatre captures d'un code servi inchangé), `rgpd` et `securite`, et l'opérateur retape sa dérogation `maquette`.

### 6.2 Comportement attendu pour `fidelite`, `donnees`, `rgpd` et `captures`

À `C'`, pour un domaine `D` retenu par le plan de la PR et sans relecture à `C'`, la règle `relecture` cherche la relecture la plus récente de `D` à un ancêtre `C` de `C'` (premier parent, depuis la base commune, dix commits au plus, fusions de la cible suivies par `carry.ts`). Elle est **reportée** quand :
1. elle est utilisable à `C` (scellée, fichiers intacts, aucun constat critique ni haut) et aucune relecture de `D` à un commit entre `C` et `C'` n'est bloquante ;
2. `planReviews({ base: C, head: C' })`, réglages lus **à la base commune de la PR**, ne retient pas `D` pour le delta ;
3. pour `fidelite` en plus : `touchesNoScreen(repo, C, C')` (`src/rules/check.ts:276`) ne donne aucune raison ; les captures de `C` valent alors pour `C'` (le code servi qu'elles montrent est inchangé), et la règle `captures` le dit (« captures jointes à `C`, reportées : delta sans écran, N fichiers »).

La sortie dit, domaine par domaine : « relecture reportée de `<C>` : delta hors périmètre (N fichiers : tests, images de référence) ». La relecture de la tête l'emporte toujours ; un constat critique ou haut à n'importe quel commit de la chaîne bloque, comme dans `carry.ts`.

### 6.3 `securite` : relecture de delta, jamais de report silencieux

La relecture de sécurité n'est pas reportée sans être relue, même pour un delta de tests : un test de sécurité affaibli ou retiré est un risque réel. À la place, une **relecture de delta**, bornée aux fichiers du delta :

```
apv review record --commit <C'> --domain securite --delta-from <C> --report <fichier> --critical 0 --high 0 ...
```

Elle est acceptée à `C'` quand une relecture `securite` utilisable existe à `C` (ou une chaîne de deltas qui y remonte, cinq au plus), que `C` est un ancêtre de `C'`, que le rapport cite les deux commits et que la liste des fichiers enregistrée est celle du delta recalculé. Le relecteur lit le diff, pas toute la PR : 5 à 10 minutes au lieu de 20 à 30. La même relecture de delta existe pour les autres domaines quand le delta touche leur périmètre ; pour `fidelite`, elle porte alors les quatre captures à `C'` des écrans touchés.

### 6.4 Dérogations reportées

Une dérogation de l'opérateur tapée pour `C` vaut pour `C'` quand le delta ne touche pas le périmètre de la règle :

| Dérogation | Reportée quand le delta `C..C'` |
|---|---|
| `maquette` | ne touche aucun écran (`isScreen`), ni le dossier des maquettes, ni le registre des décisions |
| `relecture:fidelite`, `captures` | remplit les conditions de 6.2 pour `fidelite` |
| `relecture:donnees`, `relecture:rgpd` | ne retient pas ce domaine (6.2, point 2) |
| `controles` | ne touche pas `.apv/config.json` ni `pipeline.v2.json` |
| `relecture:securite`, `relecture` entière | **jamais** (question Q2) |
| `preuve`, `instable` | **jamais** |

La sortie cite les mots de l'opérateur, leur date, leur commit, et la raison du report. Une dérogation au gabarit (« <ta raison> ») n'est pas plus reportée qu'elle n'est acceptée.

### 6.5 Risques et garde-fous

- Le périmètre est calculé par le classement par chemin déjà utilisé pour `--since` et le plan des relectures, lu à la base : une PR ne peut pas déclarer ses propres fichiers sans effet.
- `securite` reste relue à chaque delta (6.3) ; les captures restent celles d'un code servi identique.
- Les relectures restent écrites par leur agent seul et scellées par le crochet ; rien ne change à l'ancrage ([REGLES.md](REGLES.md), section 3).
- Un rebase ne reporte rien (`C` doit être un ancêtre de `C'`).

### 6.6 Critères d'acceptation

- **AC-CARRY-FID** : relecture `fidelite` avec 4 captures à `C`, delta d'un test et de deux images : `relecture` et `captures` ok à `C'`, « reportée » ; delta qui touche `src/lib/composant.svelte` : refusé, relecture de delta demandée.
- **AC-CARRY-RGPD** : delta avec une ligne qui contient un terme RGPD dans un test : `rgpd` non reporté.
- **AC-CARRY-SEC** : aucune relecture `securite` à `C'` : refus, même pour un delta de tests seuls ; relecture de delta enregistrée : ok ; delta enregistré qui ne correspond plus au diff recalculé : refus.
- **AC-CARRY-BLOCK** : relecture bloquante à un commit intermédiaire : refus à `C'`.
- **AC-CARRY-WAIVER** : dérogation `maquette` pour `C`, delta sans écran : reportée ; delta avec un `+page.svelte` : refus ; dérogation `preuve` pour `C` : jamais reportée.
- **AC-CARRY-REBASE** : `C` non ancêtre de `C'` : rien n'est reporté.

### 6.7 Gain estimé sur #262

Deux séries de relectures sur trois évitées pour `fidelite` et `rgpd` (environ 20 à 30 minutes de relecteur chacune, captures comprises), `securite` réduite à deux relectures de delta (environ 5 à 10 minutes au lieu de 20 à 30), deux dérogations `maquette` non retapées. Ordre de grandeur : 1 h à 1 h 30 de relectures et deux allers-retours avec l'opérateur.

## 7. Partie C. Jouer tôt ce qui échoue tard

### 7.1 Problème

Le budget JavaScript des guides et un test à captures instable n'échouent qu'au bout d'une suite de 40 minutes. Le stage task sait déjà lancer la variante ciblée d'un contrôle `full` (`affected`, `src/gates/run.ts:239-243`), mais le projet pilote ne la déclare pas, et une sélection par graphe d'imports des tests ne trouve ni un budget de taille ni une capture d'un écran qu'aucun test n'importe.

### 7.2 Comportement attendu

Nouveau champ d'un contrôle `full` : `early`, liste de commandes rapides que **le projet déclare**, lancées au stage task (et avec `--since`) :

```json
{ "id": "integration", "stage": "full", "affected": ["npm", "run", "test:e2e:changed", "--", "{{baseSha}}", "--project=integration"],
  "early": [
    { "id": "budget-js", "when": ["src/**", "static/**", "package.json", "package-lock.json", "vite.config.*", "svelte.config.*"],
      "dependsOn": ["build"], "command": ["node", "scripts/e2e/bundle-budget.mjs"], "timeoutMs": 120000 } ] },
{ "id": "browser", "stage": "full", "affected": ["npm", "run", "test:e2e:changed", "--", "{{baseSha}}", "--project=browser"],
  "early": [
    { "id": "captures-accueil", "when": ["src/routes/(public)/+page.svelte", "src/lib/home/**"],
      "command": ["npx", "playwright", "test", "tests/e2e/browser/accueil-captures.e2e.ts", "--repeat-each=3"], "lock": { "resource": "e2e" } } ] }
```

- `when` : globs lus **à la base** ; la commande tourne si un fichier changé depuis `{{baseSha}}` y répond, toujours sans `when`. Hors `when`, reçu `not_required` de stage task (jamais pour la suite complète).
- `dependsOn` : contrôles de tâche dont elle a besoin (ici `build`, déjà lancé au stage task, dont elle lit la sortie).
- Reçus `targeted: true` avec `early: "<id>"` : **jamais une preuve du contrôle `full`**, exactement comme `affected` aujourd'hui. Un échec rend le stage task rouge, avec « échec tôt de `integration` (budget-js) : la suite complète échouerait ».
- `--repeat-each` ou `repeatChanged` dans la commande tôt attrapent une instabilité avant la suite.
- `apv onboard --dry-run` propose `affected` quand le projet a un script du type `test:e2e:changed`, et rappelle de déclarer les contrôles tôt.
- L'implementer et l'intégrateur les lancent déjà sans rien changer à leur consigne (`apv gates run --stage task`). Le chef les relance avant chaque `apv stack batch` (sa liste de [RUN.md](RUN.md), section 4, « Contrôles »).

### 7.3 Travail côté projet pilote (PR du projet, après celle d'APV)

- déclarer `affected` pour `integration` et `browser` (zéro code APV, possible dès maintenant) ;
- extraire le budget de `client-bundle.e2e.ts` en un script qui lit `.svelte-kit/output` après `npm run build` (quelques secondes), garder le test complet dans `integration` ;
- déclarer en `early` les tests à captures des écrans fréquemment touchés, avec `--repeat-each=3`.

### 7.4 Risques et garde-fous

- Aucun : un contrôle tôt ajoute un contrôle, n'en retire aucun ; la suite complète reste exigée au commit fusionné.
- Coût : borné par `timeoutMs` et par `when` ; un contrôle tôt qui dépasse 5 minutes est signalé (« trop lent pour le stage task »).

### 7.5 Critères d'acceptation

- **AC-EARLY-RUN** : diff qui touche `src/routes/guides/x.svelte` : `budget-js` tourne au stage task ; diff de `docs/` seul : `not_required`.
- **AC-EARLY-NOPROOF** : un reçu `early` vert ne prouve jamais `integration` à la stage full (`verify` à 1 sans reçu complet).
- **AC-EARLY-BASE** : `when` d'une PR qui le réduit n'est pas appliqué à cette PR.
- **AC-EARLY-RED** : budget dépassé : stage task en 1 en moins de 3 minutes, message qui nomme le contrôle `full` concerné.

### 7.6 Gain estimé sur #262

Les deux échecs vus au stage task (2 à 5 minutes) au lieu de deux lots rouges : environ 80 à 90 minutes de suites évitées, plus les relectures des commits intermédiaires. C'est le plus gros gain des quatre parties sur cet exemple.

## 8. Partie D. Taille et mélange des PR

### 8.1 Problème

Une PR qui mêle une fonctionnalité et une harmonisation transversale élargit le plan des relectures (plus de domaines, chemins sensibles) et chaque correction rachète tout. Rien ne le signale avant les relectures.

### 8.2 Comportement attendu

`apv review plan`, `apv stack plan` et l'étape de livraison de `apv run next` affichent un **avertissement, jamais un refus**, quand :
- la PR a une spec (branche `apv/<id>`, ou `--spec <id>`) et au moins `rules.prSize.crossCutting` fichiers d'interface (classe `ui` de `planReviews`) **hors** des `allowedPaths` de ses tâches, avec au moins un fichier dans ces chemins (défaut 8) ;
- ou plus de `rules.prSize.maxFiles` fichiers changés (défaut 40), ou plus de `rules.prSize.maxSensitive` chemins sensibles (défaut 3) hors de la portée de la spec.

Texte : « PR mélangée : N fichiers d'interface hors de la portée de la spec `<id>` (liste, 10 au plus) ; relectures retenues : `securite`, `fidelite`, `rgpd` sur M fichiers. Découper : une PR d'harmonisation (ces fichiers) puis la fonctionnalité, ou l'inverse ; chaque correction n'y rachète que sa partie. » Le JSON porte `size: { crossCutting, files, sensitive, suggestion }` pour le corps de la PR.

### 8.3 Risques et garde-fous

Aucun garde-fou touché : un avertissement. Seuils lus à la base. Sans spec, seul le seuil de fichiers s'applique.

### 8.4 Critères d'acceptation

- **AC-SIZE-MIX** : 3 fichiers dans la portée et 12 fichiers `.svelte` hors portée : avertissement avec la liste ; même PR sans fichier dans la portée : avertissement « hors spec » sans suggestion de découpe.
- **AC-SIZE-NEVER-REFUSE** : `apv rules check` reste inchangé avec ou sans avertissement.

### 8.5 Gain estimé sur #262

Indirect : la fonctionnalité seule (quelques fichiers d'accueil) aurait eu des relectures courtes ; l'harmonisation, sans écran nouveau, serait partie à part. Non chiffré.

## 9. Menaces et parades

| Menace | Parade |
|---|---|
| Un contrôle repris alors qu'il lit un fichier changé | `ignore` par exclusion, liste jamais ignorable, lue à la base ; `verify` recalcule l'empreinte depuis Git |
| Un reçu `cached` fabriqué | `verify` exige l'origine intacte dans le magasin et recontrôle les empreintes (A0) |
| Un vert chanceux réutilisé | jamais `passed_after_retry` ; échec plus récent prioritaire ; `maxAgeMs` ; `--replay` |
| Une relecture reportée sur un code qui a changé | delta classé par chemin à la base ; `fidelite` exige aucun écran touché ; `securite` jamais reportée sans relecture de delta |
| Une dérogation étendue au-delà de l'intention de l'opérateur | tableau fermé (6.4), jamais `preuve`, `instable`, `securite` ; sortie qui cite ses mots, sa date et le report |
| Une PR qui s'exempte elle-même | tout réglage d'exemption lu à la base commune |

## 10. Gain total estimé sur #262

| Partie | Ce qui disparaît | Ordre de grandeur |
|---|---|---|
| C | deux lots rouges | 80 à 90 min |
| B | deux séries de relectures `fidelite` et `rgpd`, deux `securite` complètes, deux dérogations retapées | 60 à 90 min, deux allers-retours avec l'opérateur |
| A | le rejeu de 14 contrôles, du scan et de deux `npm ci` après le dernier commit | 10 à 20 min par lot ; 40 min par lot relancé à l'identique |
| D | relectures élargies par l'harmonisation | non chiffré |

Avec C, B et A, #262 aurait demandé une suite complète et une série de relectures, plus des deltas : quelques heures au lieu d'une journée. Estimation à confirmer par `apv metrics prs` sur les PR suivantes.

## 11. Phases de livraison (petites PR, ordonnées par gain)

| Ordre | PR | Contenu | Acceptée quand |
|---|---|---|---|
| 1 | C1 | champ `early` (`when`, `dependsOn`, reçus `early`), sortie, `apv onboard`, CONFIGURATION.md, RUN.md | AC-EARLY-* ; sans `early`, comportement et `configHash` inchangés |
| 1 bis | projet | `affected` et `early` du projet pilote (7.3) | budget dépassé vu au stage task |
| 2 | B1 | report des relectures `fidelite`, `donnees`, `rgpd` et des captures ; relecture de delta (`--delta-from`) pour tous les domaines, `securite` comprise ; REGLES.md | AC-CARRY-FID, -RGPD, -SEC, -BLOCK, -REBASE |
| 3 | B2 | report des dérogations (tableau 6.4), après la réponse de l'opérateur à Q2 | AC-CARRY-WAIVER |
| 4 | A0 | `verify` durci pour `cached` (origine, empreintes, âge), état `reuse` | AC-REUSE-A0 ; aucun reçu `cached` encore produit |
| 5 | A1 | reprise à arbre identique dans `runGates` et le lot, `--replay`, copies préparées seulement si utiles (A4) | AC-REUSE-TREE, -LATEST-FAIL, -REPLAY |
| 6 | A2 | `reuse.ignore`, `maxAgeMs`, `reuse: false`, identité de réutilisation, `stacks[].fingerprint`, chargeur | AC-REUSE-INPUTS, -NEVER-IGNORE, -BASE, -STACK |
| 7 | A3 | reprise du scan dynamique (A5) | AC-REUSE-DAST |
| 8 | D1 | avertissement de PR mélangée, `rules.prSize` | AC-SIZE-* |

Chaque PR : version alpha montée, CHANGELOG, tests qui refusent et tests qui acceptent, relecture `securite` du code (A0, A1, A2, B1 et B2 touchent la preuve et les règles : relecture en Opus).

## 12. Critères communs et scénarios de la personne cible

- **AC-NO-WEAKER** : sans les nouveaux champs, `apv gates verify`, `apv rules check` et `apv stack batch` donnent les mêmes résultats qu'avant sur la suite de tests existante ; aucune règle ne devient plus permissive hors des cas décrits.
- **AC-MIGRATION** : une configuration sans `reuse`, `early` ni `rules.prSize` se charge et se hache comme avant (`configHash` inchangée).

Scénarios (chef de projet APV et opérateur) :
- **AC-USER-1** : Étant donné un lot dont `browser` a échoué sur une capture, quand le chef pousse un commit qui ne change que ce test et ses images et relance le lot, alors seuls `browser` et sa pile sont préparés et rejoués, les autres contrôles et le scan sont « réutilisés » avec leur commit d'origine, et `apv gates verify` sort à 0 à la tête du lot.
- **AC-USER-2** : Étant donné les relectures `fidelite` et `rgpd` enregistrées à `C`, quand le chef pousse `C'` qui ne change qu'un test, alors `apv rules check` dit « relecture reportée de `C` : delta hors périmètre » pour les deux, et demande seulement une relecture de delta `securite`.
- **AC-USER-3** : Étant donné la dérogation `maquette` tapée par l'opérateur pour `C`, quand `C'` ne touche aucun écran, alors l'opérateur ne la retape pas et la sortie cite ses mots, leur date et le report.
- **AC-USER-4** : Étant donné une page de guide qui dépasse son budget JavaScript, quand l'implementer lance `apv gates run --stage task`, alors le contrôle tôt `budget-js` échoue en moins de 3 minutes et nomme `integration` comme la suite qui échouerait.
- **AC-USER-5** : Étant donné une PR de fonctionnalité qui modifie aussi 12 composants hors de sa spec, quand le chef lance `apv review plan`, alors il voit l'avertissement de PR mélangée et la découpe proposée, et rien n'est refusé.

## 13. Questions ouvertes pour l'opérateur

| # | Question | Recommandation |
|---|---|---|
| Q1 | La reprise à arbre identique (A1) est-elle active par défaut pour tous les contrôles, ou seulement pour ceux qui la déclarent ? | Par défaut : un arbre identique, la même configuration et le même environnement, c'est exactement ce qui serait rejoué ; `reuse: false` pour les contrôles qui lisent le réseau ou le temps (audit de dépendances, audit web, scan). |
| Q2 | Une dérogation tapée pour un commit vaut-elle pour le commit suivant quand le delta ne touche pas son périmètre (tableau 6.4) ? | Oui pour `maquette`, `captures`, `controles` et les relectures `fidelite`, `donnees`, `rgpd` ; jamais pour `securite`, `preuve` et `instable`, qui restent à retaper par commit. |
| Q3 | La relecture `securite` peut-elle être reportée sans relecture quand le delta n'a que des tests et de la documentation ? | Non : relecture de delta obligatoire (5 à 10 minutes), parce qu'un test de sécurité affaibli est un vrai risque ; c'est le garde-fou qu'on garde entier. |
| Q4 | Seuils de l'avertissement de PR mélangée : 8 fichiers d'interface hors spec, 40 fichiers, 3 chemins sensibles hors spec ? | Oui pour commencer, avertissement seulement ; à revoir après un mois de `apv metrics prs`. |

## Décisions de l'opérateur (17 octobre 2026, au soir)

1. Reprise des contrôles verts quand l'arbre est identique : **oui**, sauf pour les contrôles qui lisent le réseau ou le temps (audit des dépendances, audit web, scan dynamique), déclarés `reuse: false` et toujours rejoués.
2. Report des dérogations sur un commit dont le delta ne touche pas leur périmètre : **oui** pour `maquette`, `captures`, `controles` et les relectures `fidelite`, `donnees`, `rgpd` ; **jamais** pour `securite`, `preuve` et `instable`.
3. Relecture `securite` sur un delta qui ne change que des tests : **pas de report sans relire** ; une relecture du delta reste obligatoire.
4. PR qui mélange une feature et un changement transversal : **refus** (et non simple avertissement). La partie D devient une règle `taille` de `apv rules check`, refusée au-delà des seuils (8 fichiers d'interface hors de la portée de la spec, 40 fichiers en tout, 3 chemins sensibles), levée seulement par une dérogation de l'opérateur (« dérogation taille <sha12> : <raison> ») ; seuils dans `.apv/config.json`, revus après un mois de `apv metrics prs`.
