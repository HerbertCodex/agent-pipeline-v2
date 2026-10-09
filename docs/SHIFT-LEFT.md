# Renforcer le début, alléger la fin

Statut : **proposition à valider par l'opérateur**. Aucune ligne de code avant sa validation. Branche `feat/tdd`, depuis `apv3` (3.0.0-alpha.19).
Méthode du dépôt : spec d'abord, validée, puis phases de code en petites PR (section 22).

Le document a trois parties :
- **Partie I, test d'abord** : rouge prouvé par l'outil, testeur distinct, mutation ciblée.
- **Partie II, alléger la fin** : relecture par tâche, fidélité au fil de l'eau, preuve incrémentale, petites PR rapides, mesure du temps.
- **Partie II bis, parallélisme** : données de test isolées par worktree, suites complètes en parallèle, specs découpées en vagues larges, plusieurs specs à la fois.
- **Partie III, commun** : équilibre, coût, champs, agents, règles, migration, phases, critères, questions.

## 1. Demande et constat

Demandes de l'opérateur (2026-10-04) :
- « je veux qu'on suive le principe tdd, mais ça va grandir le temps ? »
- « je pense qu'on doit renforcer le début (test, écriture de code etc.) pour alléger la dernière étape, ça va réduire le temps ; là c'est trop long, une PR même minime demande trop de temps »
- « le but n'est pas de rendre le début plus long, il faut savoir s'équilibrer »
- « il faut aussi paralléliser les tâches, il y a des worktrees pour tout »

Constat sur le projet pilote :
- L'implementer écrit le code et les tests en même temps, dans le même commit. Rien ne prouve qu'un test échouait avant le code, ni qu'il casse si la fonctionnalité casse.
- Le même agent écrit le code et les tests qui le jugent. Il comprend le critère comme il l'a codé.
- La compétence `tdd` actuelle le dit : « This V2 does not guarantee a recorded pre-implementation red run » et « Do not require a separate Test Writer agent ».
- Tout le jugement arrive à la fin : suite complète à la dernière intégration, quatre relectures, corrections, suite complète à la livraison, puis suite du lot à la fusion.
- Le 2026-10-04, sur la spec `fiche-appel`, trois tests d'intégration ont été réajustés après la suite complète : environ 1 h de reprise.
- Les PR #202 et #203 (minimes) ont pris environ 1 h 30 chacune : quatre relectures et une suite complète de 40 minutes.
- Les tâches ont leurs worktrees, mais deux piles de test et un verrou exclusif par pile font passer tests navigateur et suites un par un : jusqu'à 40 minutes d'attente du verrou pendant une suite.

Réponse courte à l'opérateur : le test d'abord coûte un peu par tâche, mais **chaque ajout au début tourne en parallèle d'un travail existant, ou retire à la fin au moins autant qu'il ajoute** (section 16). Ce qui ne tient pas cet équilibre est écarté ou optionnel, et le document le dit. Rien n'est promis : l'outil mesure (section 11) et l'opérateur décide sur les chiffres.

## 2. Objectif et limites

Objectif :
1. **Le test était rouge avant le code**, pour la bonne raison (section 4).
2. **Le test d'acceptation vient d'un autre agent** que celui qui code (section 5).
3. **Le test casse quand la règle casse**, pour les critères à risque (section 6).
4. **La fin ne rejuge que ce qui a changé depuis le jugement de chaque tâche** (sections 7 à 9).
5. **Une PR minime passe en moins de 30 minutes** de prête à fusionnée (section 10).
6. **Les agents et les suites ne s'attendent plus sur une pile de test** quand leurs données sont isolées (sections 12 à 15).

Limites, dites franchement :
- L'outil prouve qu'un test était rouge puis vert, et qu'une mutation choisie le rend rouge. Il ne prouve pas que le test couvre tout le critère. Cela reste un jugement des relecteurs.
- Le testeur ne voit pas le code dans son arbre, et les crochets refusent les formes connues pour le lire ailleurs. Comme le reste de l'ancrage (REGLES.md, section 3 bis), c'est un garde-fou contre les erreurs, pas une barrière contre un agent déterminé.
- Les reçus de contrôles ne sont pas signés aujourd'hui : ils sont validés par leur schéma, leurs empreintes et le manifeste sha256 du magasin partagé. Les nouveaux reçus ont les mêmes garanties, pas davantage (question Q8).
- Aucun garde-fou de sécurité n'est retiré. La suite complète reste exigée au commit exact fusionné (règle `preuve`, jugée sur le lot comme aujourd'hui). La relecture `securite` reste exigée pour toute PR.

## 3. Vocabulaire

| Terme | Sens |
|---|---|
| Commit des tests | Premier commit d'une tâche après sa base. Il ne contient que des fichiers de test (section 4.1). |
| Rouge | Les tests de la tâche, rejoués seuls au commit des tests, échouent. |
| Bonne raison | Échec par une assertion, ou par l'absence d'un élément que la tâche doit créer (section 4.3). |
| Reçu rouge | Reçu `tdd-red` écrit par `apv tdd red`, au format et dans le magasin des reçus de contrôles. |
| Testeur | Nouvel agent `apv:testeur`, qui écrit les tests d'acceptation depuis la spec et la maquette, sans le code. |
| Critère à risque | Critère qui porte le drapeau `risk` : `securite`, `donnees`, `rgpd`, `argent`. |
| Mutation | Changement volontaire et temporaire d'une ligne clé du code, jamais commité. Tuée : un test devient rouge. Survivante : tous restent verts. |
| Relecture de tâche | Relecture enregistrée au commit d'une tâche, sur son diff, dès qu'elle est verte. |
| Delta d'intégration | Fichiers dont le contenu à la tête diffère de celui de tout commit de tâche relu : résolutions de conflit, doublons unifiés, cartes régénérées, corrections. |
| Suite d'impact | Contrôles de tâche, tests ciblés par dépendances et tests modifiés répétés, depuis la cible prouvée (section 9). |
| Chemin critique | La plus longue chaîne de travaux qui se suivent, de la spec validée à la fusion. Un travail en parallèle d'un autre plus long n'y ajoute rien. |

# Partie I. Test d'abord

## 4. Mécanisme 1 : test d'abord, vérifié par l'outil

### 4.1 Séquence d'une tâche

1. L'implementer part de sa base, et fusionne la branche du testeur quand il y en a une (section 5.4).
2. **Commit des tests** : les tests de chaque critère (`acceptanceIds`) et de chaque scénario `AC-USER-n` de la tâche, et ses tests unitaires des règles internes. Aucun fichier de code.
3. `apv tdd red --spec <spec> --task <tâche> --base <base> --commit <commit des tests> --detach`, **en arrière-plan**. L'outil prend une copie détachée du commit des tests, y rejoue ces seuls tests, exige le rouge pour la bonne raison et écrit le reçu. L'implementer commence le code pendant ce temps (section 16 : ce rouge ne doit pas allonger la tâche).
4. Commits du code, jusqu'au vert. Les contrôles de tâche existants (`apv gates run --stage task --base <base>`) ne changent pas.
5. Avant de rendre la main : le reçu rouge existe (`apv wait --file`), `apv tdd check` (contrôle de tâche) et `apv scope check` vérifient la séquence.

Un **fichier de test** répond aux motifs `testsCheck.unit` ou `testsCheck.e2e` (ceux de `apv tests check`), ou à `tdd.testPaths`. Les données de test sous `test/` ou `tests/` en sont aussi. Un fichier de code, de configuration, de migration ou d'interface dans le commit des tests le fait refuser (`TDD_TEST_COMMIT`), fichiers listés.

Exception bornée : un fichier de configuration du lanceur ou une graine de données de test que le rouge exige vont dans un commit précédent, déclaré en `tdd.setup` dans la tâche (section 18.1). Jamais du code de l'application.

### 4.2 Lien entre test et critère

Chaque test nomme son critère dans son titre, entre crochets : `[AC-ENDPOINT]`, `[AC-USER-2]`. Motif réglable (`tdd.criterionPattern`, défaut `\[(AC-[A-Z0-9-]+)\]`). Le titre est le seul endroit lisible par tous les lanceurs, sans annotation propre à une pile.

Pour chaque critère de preuve `test` (section 18.1) : au moins un test qui le nomme, et au moins un de ces tests rouge pour la bonne raison. Critère sans test : `TDD_UNCOVERED`. Critère dont tous les tests passent déjà : `TDD_ALREADY_GREEN` (« le test passait avant le code : il ne prouve rien »), sauf en mode `characterization` (section 4.6).

### 4.3 Rouge pour la bonne raison

L'outil lance les tests par un **lanceur déclaré** (`tdd.runners`, section 18.2), avec une sortie JUnit XML, format commun de Vitest, Jest, Playwright, pytest, `go test` (gotestsum), `cargo nextest`, PHPUnit, Maven et Gradle. Aucun lanceur propre à une pile n'est codé dans l'outil : `apv init` et `apv onboard` proposent des profils (section 21). Les substitutions `{{files}}` et `{{junit}}` sont nouvelles : les contrôles actuels ne substituent qu'un argument entier (`{{baseSha}}`, `{{candidateSha}}`, `{{workspace}}`).

| Cause | Reconnue par | Acceptée |
|---|---|---|
| `assertion` | élément `<failure>` de JUnit, ou motif d'assertion (`AssertionError`, `expect(`, `assert `, `toBe`, `toHaveText`...) | oui |
| `absent` | module, fichier, route ou fonction introuvable **et** absent à la base **et** dans les `allowedPaths` de la tâche | oui, marquée `absent` |
| `syntaxe` | erreur de compilation ou d'analyse du fichier de test | non |
| `collecte` | aucun test trouvé, ou test attendu non trouvé | non |
| `environnement` | port, base, réseau, délai du lanceur, plantage | non : corriger l'environnement, relancer |
| `inconnue` | aucun motif reconnu | non, avec l'extrait du message |

Pourquoi accepter `absent` : quand la tâche crée un module, l'import manque forcément avant le code, et un squelette serait du code dans le commit des tests. Pour du code existant modifié, seule `assertion` compte. Un critère dont tous les rouges sont `absent` est signalé (`absentOnly`) aux relecteurs (question Q2).

Il suffit d'un test rouge pour la bonne raison par critère. Un autre test rouge pour une mauvaise raison fait refuser (`TDD_BAD_RED`) : un test cassé ne se cache pas derrière un bon.

### 4.4 Reçu rouge

Écrit dans le même magasin que les reçus de `apv gates run` (`.apv/receipts/<runId>/`, copié dans le magasin partagé avec son `manifest.json`), validé par schéma comme eux, lisible par `apv gates receipts list` (stage `tdd-red`) :

```
{ kind: "tdd-red", schemaVersion: 1, runId, spec, specSha256, task, base, candidateSha, dirty: false, configHash,
  runner: { id, command, durationMs, exitCode, junitSha256 },
  files: [ { path, blob } ],
  tests: [ { name, file, criteria: ["AC-..."], status: "failed"|"passed"|"skipped", cause, message (borné, secrets masqués) } ],
  criteria: { "<AC>": { tests, red, causes, absentOnly } },
  verdict: "red"|"refused", refusals: [ { code, detail } ], startedAt, durationMs }
```

`verdict` vaut `red` seulement sur un arbre propre, au commit donné, pour une tâche connue de la spec, chaque test lancé reconnu dans le JUnit. Seuls les fichiers de test du commit sont lancés, jamais la suite. Un rouge de tests navigateur passe sous le verrou `e2e`, comme les tests ciblés d'aujourd'hui.

### 4.5 Contrôle `apv tdd check`

```
apv tdd check --spec <fichier> --task <id> --base <ref> [--integration] [--repo <chemin>] [--json]
```

Sans `--spec` ni `--task`, il lit `.apv/state/task.json`. Déclaré comme contrôle de tâche :

```json
{ "id": "tdd", "stage": "task", "command": ["apv", "tdd", "check", "--base", "{{baseSha}}"] }
```

Il lit Git et les reçus, sans lancer de test (moins de 2 s) :
1. Le premier commit après la base est un commit des tests, ou la tâche déclare une exception.
2. Un reçu `tdd-red` au verdict `red` existe pour ce commit, à l'empreinte de configuration actuelle, avec exactement ses fichiers de test (même blob).
3. Chaque critère `test` de la tâche est couvert.
4. À la tête, chaque test du reçu existe, n'est ni sauté (`.skip`, `xit`, `test.fixme`, `@pytest.mark.skip`, `t.Skip`...) ni retiré, ni privé d'une assertion : sinon `TDD_WEAKENED`, sauf contestation tranchée (section 5.5).
5. Les fichiers du testeur ont le blob de leur dernier commit de testeur (section 5.3).

Sortie : `0`, `1` refus (chaque refus avec la marche à suivre), `2` appel incorrect.

Branchements :
- `apv scope check` : nouvelle section `tdd`, sortie `1` quand `apv tdd check` refuserait.
- `apv run set <id> task:<tâche> done` : refus `RUN_TDD` en `enforce` sans reçu rouge, sauf exception déclarée.
- L'intégrateur : `apv tdd check --integration` sur la tête intégrée (tests de chaque tâche gardés, ni sautés ni retirés).
- `apv rules check` : règle `tdd` (section 20).

### 4.6 Exceptions, toujours déclarées

Une tâche sans champ `tdd` est en `red-first` dès que le projet l'active. Exceptions dans la tâche :

| Mode | Pour | Exigé à la place |
|---|---|---|
| `characterization` | refactorisation pure | des tests couvrent les fichiers touchés, passent à la base et à la tête (reçu `tdd-characterization`) ; aucun critère nouveau |
| `none`, `kind` `docs`, `config`, `content` | documentation, configuration, contenu | chaque fichier changé est admis par la voie sans code de la PR #121 (`docsOnlyLane`, sortes `decisions`, `mockups`, `drafts`, `specs`, `journal`, `docs`) ou par la voie des réglages (section 10.2) ; un seul fichier de code fait refuser (`TDD_EXCEPTION`) |
| `none`, `kind` `spike` | exploration jetée | jamais intégrée : `apv run set ... done` la refuse en intégration |

Chaque exception porte `kind` et `reason` (20 caractères au moins). `apv spec validate` refuse une exception sans raison, un `kind` contraire au mode, ou un `none` dont les `allowedPaths` couvrent du code. La voie sans code vit sur la branche `apv3-voie-legere-sans-code`, pas encore fusionnée : la phase 2 en dépend.

## 5. Mécanisme 2 : tests d'acceptation par un testeur distinct

### 5.1 Rôle et quand il tourne

Nouvel agent `apv:testeur` (`agents/testeur.md`, isolement `worktree`, effort `high`). Il écrit les tests d'acceptation des critères `test` et des scénarios `AC-USER`, depuis la spec, la maquette validée (textes mot pour mot, rôles, états), `.apv/data-model.md` et les **contrats publics** du plan (routes, champs, fonctions serveur, codes d'erreur, rôles et libellés accessibles). Il teste par les interfaces publiques. Les tests unitaires des règles internes restent à l'implementer.

Proportionné au risque (section 16) : le testeur ne tourne que pour une spec **à interface** (`experience.uiImpact` différent de `none`) **ou à données** (étape `data-model` non sautée) **ou qui a un critère à risque**. Ailleurs, le mécanisme 1 seul. Périmètre par défaut : scénarios `AC-USER` et critères à risque (question Q1).

### 5.2 Contrats pour le testeur

L'architecte ajoute au plan (`.apv/state/plan-<id>.md`) une section « Contrats pour le testeur » par tâche. Un contrat manque : le testeur le signale, le chef de projet le fait ajouter au plan, jamais deviné.

### 5.3 Fichiers possédés

La spec déclare les chemins du testeur (`tdd.tester.paths`). Aujourd'hui, aucune notion de fichier possédé n'existe dans `src/` : elle est ajoutée.
- `apv scope check` refuse (`TESTER_OWNED`) toute modification d'un fichier du testeur par un commit d'implementer, quels que soient les `allowedPaths`.
- `apv tdd check` exige à la tête le blob du dernier commit de testeur (branche `apv/<id>-tests-*`, trailer `APV-Testeur: <tâche>`).
- L'intégrateur ne les modifie pas. Un conflit sur eux : arrêt et signalement.
- `apv scope check --tester` vérifie que le testeur n'écrit que sous ses chemins.

### 5.4 Calendrier : en parallèle des fondations

1. Étape `plan` terminée, contrats compris.
2. Le chef de projet lance **en même temps** les fondations et le testeur, depuis la tête du plan. Le testeur produit une branche par tâche non fondation : `apv/<id>-tests-<tâche>`, un commit chacune.
3. Quand une tâche devient prête, son implementer part de sa base puis `git merge --no-ff apv/<id>-tests-<tâche>`. Les tests d'une tâche n'entrent jamais dans `apv/<id>` avant son code : ils ne rendent pas rouges les contrôles des autres tâches.
4. Le rouge de la tâche rejoue ensemble les tests du testeur et ceux de l'implementer.

Les fondations partent avant le testeur : elles suivent le mécanisme 1 seul. Le testeur écrit aussi leurs tests d'acceptation (`apv/<id>-tests-fondations`), intégrés avec elles ou juste après, et qui doivent être verts.

Nouvelle étape de l'état d'exécution, entre `plan` et les tâches : `tests` (`apv run set <id> tests running|done|skipped`), ajoutée à la liste `STEPS` de `src/run/state.ts`. `apv run next` ne propose une tâche non fondation qu'avec sa branche de testeur, sauf `tests` à `skipped`.

### 5.5 Test jugé faux

L'implementer ne modifie jamais un test du testeur. S'il le juge faux, il le dit dans son rapport (`contestedTests` : fichier, titre, critère, raison, extrait de la spec ou de la maquette) et continue le reste. Le chef de projet tranche par écrit dans `.apv/state/tests-contestes-<id>.md` :
- **test faux** : un testeur le corrige sur sa branche (trailer `APV-Testeur`, ligne `Contestation : <numéro>`), l'implementer refusionne ;
- **test juste** : l'implementer corrige son code ;
- **critère ambigu** : `apv:product` précise la spec ; une question de produit remonte groupée à l'opérateur.

## 6. Mécanisme 3 : relecture des tests par mutation ciblée

### 6.1 Quels critères

Seulement ceux qui portent `risk`. `apv spec validate` marque d'office `securite` tout critère cité par `security.requirements[].acceptanceIds` ou `security.threatModel.threats[].acceptanceIds`, et avertit (`SPEC_RISK`) quand une description sans drapeau nomme un terme de risque (RLS, isolation, suppression, export, paiement, prix, consentement, jeton, mot de passe).

### 6.2 Qui, quand

Le relecteur du domaine, **pendant la relecture déjà lancée** (relecture de tâche, section 7), sur sa copie détachée :

| Drapeau | Relecteur |
|---|---|
| `securite`, `argent` | `apv:qa-securite` |
| `donnees` | `apv:architecte-donnees` (mode revue) |
| `rgpd` | `apv:dpo` |

Il choisit la ligne clé qui porte la règle (condition RLS, filtre `user_id`, vérification du jeton, calcul du montant, purge) et la casse par `apv tdd mutate`.

### 6.3 Commande `apv tdd mutate`

```
apv tdd mutate --criterion <AC> --file <chemin> --line <n> (--replace <texte> | --preset <nom>)
               [--spec <fichier>] [--repo <copie>] [--json]
```

- Copie détachée, arbre propre, HEAD égal au commit relu.
- Applique la mutation, lance les seuls tests qui nomment le critère, puis **remet le fichier** et vérifie l'arbre propre, quelle que soit l'issue (signal compris).
- Préréglages : `negate-condition`, `drop-filter`, `always-true`, `always-false`, `off-by-one`, `remove-call`.
- Résultat : `killed` (un test rouge par `assertion`), `survived` (tous verts), `invalid` (ne compile pas, ou cause `environnement` : ne compte pas).
- Reçu `tdd-mutation` : commit, critère, fichier, ligne, empreintes de la ligne d'origine et de la mutation (jamais leur texte s'il contient un secret), tests lancés, résultat.

Le crochet Bash permet `apv tdd mutate` aux relecteurs, en lecture seule pour tout le reste.

### 6.4 Règle

- Chaque critère à risque du diff a au moins une mutation `killed` au commit relu, ou à un commit où le fichier muté a le même blob.
- Une mutation `survived` est un constat **bloquant, gravité `eleve`**. Correction : un test plus fort (par le testeur si le test est à lui), puis une mutation tuée.

### 6.5 Outil de mutation de la pile : optionnel

`tdd.mutation.tool` (Stryker pour JS et TS, mutmut, go-mutesting, cargo-mutants), borné aux fichiers du diff qui portent un critère à risque, `maxMinutes` (défaut 15), lancé pendant les relectures. Survivants sur les lignes à risque : constats `moyen` ; ailleurs : `conseil`, en suivi groupé. **Désactivé par défaut** : il ne tient l'équilibre que s'il reste dans le temps des relectures (section 16).

# Partie II. Alléger la fin

## 7. Relecture par tâche

### 7.1 Principe

Chaque tâche verte et vérifiée (scope check, `apv tdd check`, contrôles de tâche au commit exact) est relue **tout de suite**, sur son petit diff, pendant que les tâches suivantes avancent :
1. `apv review plan --base <base de la tâche> --head <commit de la tâche> --json` : domaines retenus pour ce diff, `securite` toujours.
2. Relecteurs lancés en parallèle, en lecture seule, chacun sur sa copie détachée du commit de la tâche (workflow `apv:revues` inchangé, avec `scope: task:<id>`).
3. Chacun enregistre sa relecture à ce commit : `apv review record --commit <commit de la tâche>` (commande et scellement inchangés).
4. Constats critiques et élevés : la tâche repart en correction avant l'intégration. Ses dépendantes attendent, comme pour un contrôle rouge.

Proportionné au risque : une tâche de risque `faible` pour `apv review plan` n'a que `securite`. Les domaines sautés le sont par l'outil, comme aujourd'hui.

### 7.2 À la fin : delta d'intégration et assemblage

Nouvelle commande :

```
apv review coverage --base <ref> --head <ref> [--json]
```

Pour chaque domaine que le plan de la PR retient, elle classe chaque fichier changé :
- **couvert** : son blob à la tête est celui d'un commit de tâche qui a une relecture scellée de ce domaine, sans constat critique ni élevé, et dont le plan retenait ce domaine pour ce fichier ;
- **delta** : sinon (résolution de conflit, doublon unifié, correction, fichier changé après la relecture).

À la fin, il reste :
- une **relecture du delta**, par domaine qui a un fichier en delta, au commit de tête, bornée aux fichiers listés ;
- une **relecture d'assemblage sécurité**, toujours, à la tête : le delta, plus les attaques réelles à deux utilisateurs que les relectures de tâche ont scriptées, rejouées sur l'application intégrée. Pourquoi : deux tâches saines séparément peuvent ouvrir une faille ensemble (une route d'une tâche, le contrôle d'accès d'une autre). Ce garde-fou reste entier, il est seulement borné.

Règle `relecture` de `apv rules check` : un domaine est satisfait quand chaque fichier changé de son domaine est couvert ou relu au delta, et `securite` exige toujours sa relecture d'assemblage au commit exact. Un nouveau commit de correction ne remet en delta que les fichiers qu'il change.

## 8. Fidélité au fil de l'eau

- **Comparaison des textes** par l'implementer, dans sa tâche : `apv design texts --commit <sha> --screens <routes>` compare les textes de la maquette au rendu. Quelques secondes. Reçu `design-texts`.
- **Captures** par l'outil, à la relecture de tâche : `apv design capture --commit <sha> --screens <routes>` prend les quatre réglages (ordinateur et téléphone, clair et sombre) sur une copie détachée et écrit un reçu `design-capture` avec l'empreinte de chaque image. Le chef de projet la lance avec la relecture de tâche, pas l'implementer : elle reste hors du chemin critique (section 16).
- Le relecteur de fidélité de la tâche juge ces captures et ces textes, et les joint à sa relecture (`apv review record --capture`, inchangé). La règle `captures` accepte une image dont l'empreinte est celle d'un reçu `design-capture` au commit relu.
- **À la fin** : captures seulement des écrans touchés par le delta. Un écran est touché quand un de ses fichiers, ou un composant partagé qu'il importe (carte du code), est en delta.

Variante écartée par défaut : captures prises par l'implementer avant son rapport. Elle ajoute 3 à 6 minutes par tâche à interface sur le chemin critique. Elle reste possible (`design.captureBy: "implementer"`) pour un projet sans relecture de tâche.

## 9. Preuve incrémentale

### 9.1 Suite d'impact

```
apv gates run --stage impact --base origin/<cible> [--run <id>]
apv gates verify --commit <tête> --stage impact --base origin/<cible>
```

Elle lance : tous les contrôles de tâche, la commande ciblée `affected` de chaque contrôle `full` depuis la base commune avec la cible, la répétition des tests modifiés (`repeatChanged`) et l'audit web s'il est requis. Ses reçus portent `targeted: true` et `impact` (base, cible prouvée, fichiers, raison). Elle remplace la suite complète **à la dernière intégration et à la livraison**, aux conditions suivantes, toutes recalculées par l'outil depuis le commit :
1. La tête de la cible a une suite complète prouvée (`apv gates verify --commit origin/<cible>` à `0`), à la même empreinte de configuration des contrôles.
2. Chaque tâche de l'exécution a ses reçus de tâche au commit enregistré.
3. Chaque contrôle `full` déclare `affected`. Un contrôle sans `affected` tourne en entier.
4. Aucun reçu `passed_after_retry` dans la suite d'impact.
5. Aucun fichier du diff ne rend la suite entière exigée (section 9.2).

### 9.2 Quand la suite entière reste exigée

Avant les revues et avant la PR, en plus du lot de fusion :
- une migration (`**/migrations/**`, `**/*.sql`) ;
- la configuration des contrôles : `.apv/config.json` (sections `gates`, `environment`, `stacks`, `suite`, `batch`, `tdd`), `pipeline.v2.json` ;
- la configuration de build, de test et d'exécution (`**/*.config.*`, `tsconfig*.json`, `.env*`, `Dockerfile*`, `Makefile`, configuration du lanceur de tests) ;
- les dépendances (manifestes et verrous) et la CI ;
- du **code partagé large** : un fichier importé par au moins `proof.impact.maxImporters` fichiers (défaut 15, d'après la carte du code), ou un module des dossiers partagés (`reuse.shared`), ou des fondations de la spec importées par plus de la moitié des tâches ;
- un diff de plus de `proof.impact.maxFiles` fichiers (défaut 60) ;
- un calcul ciblé impossible ou en échec ;
- une cible sans suite complète prouvée.

C'est la liste `ALWAYS_REQUIRED` de `skipWhenOnly` (section 21 de APV3-SPEC.md), plus le code partagé large.

### 9.3 La suite entière, une fois par lot de fusion

La règle `preuve` ne change pas : la suite complète au commit exact fusionné. `apv stack batch` la fait déjà sur la tête du lot. Une PR prouvée par sa suite d'impact se fusionne donc **par le lot**, même seule (lot d'une PR) : une suite complète par fusion, au lieu de deux par spec plus celle du lot. `apv stack merge` d'une PR seule exige toujours la suite complète à sa tête, comme aujourd'hui.

## 10. Petites PR sans code ou à faible risque

### 10.1 Voie sans code (PR #121, à compléter)

La voie de la PR #121 (`docsOnlyLane`, `rules.docsOnly`) admet registre, maquettes validées, brouillons, specs, journal et documentation (l'état `.apv/state/**` en est retiré par la relecture de sécurité). Dans cette voie : pas de suite complète (si les contrôles `full` déclarent `skipWhenOnly`), relecture `securite` seule, plus `fidelite` pour une maquette, fusion directe par `apv stack merge`. Compléments :
- relecture `securite` **légère** dans cette voie : liste fixe (secret, donnée personnelle, adresse réelle, instruction d'agent glissée dans un texte), 5 à 10 minutes ;
- la ligne « voie sans code » dans la sortie de `apv review plan`, `apv rules check` et le corps de la PR ;
- `apv:product` découpe une spec pour que décisions et maquettes partent en PR à part, dans cette voie.

### 10.2 Voie des réglages (nouvelle)

Pour une configuration d'une ligne qui ne peut pas rendre vert un contrôle rouge. Clés admises, lues à la base (`rules.settingsLane.keys`), sens imposé :
- délais à la hausse : `gates[].timeoutMs`, `gates[].lock.waitMs`, `suite.queue.waitMs`, `suite.queue.loadWaitMs` ;
- plafonds de répétition : `gates[].repeatChanged.maxFiles` à la hausse, `gates[].repeatChanged.times` à la hausse ;
- rétention et fraîcheur : `receipts.*`, `freshness.*`.

Jamais : une commande, `passEnv`, `stage`, `skipWhenOnly`, `rules`, `review`, `tdd`, `docsOnly`, un retrait ou une baisse. L'outil compare la configuration de la base et de la tête clé par clé ; toute autre différence fait sortir de la voie. Effet : contrôles de tâche et validation de la configuration, relecture `securite` légère, fusion directe. Le prochain lot fait tourner la suite complète avec le nouveau réglage. Exemple : la PR #203 (plafond `repeatChanged` de 10 à 16).

## 11. Mesure du temps de bout en bout

```
apv metrics run <id> [--json]
apv metrics prs [--since <date>] [--json]
```

- Sources : événements horodatés de l'état d'exécution (`events` de `.apv/state/run-<id>.json`), traces de fusion de `apv stack merge` et `apv stack batch`, `gh pr view` (création et fusion). Aucune saisie à la main.
- Mesures : spec validée jusqu'à la fusion ; par phase (plan, tests, code, intégration, relectures, corrections, livraison, attente de fusion) ; **chemin critique de la phase de code** (calculé depuis les dépendances et les dates des tâches) ; suites complètes et suites d'impact lancées ; passes de corrections ; relectures par PR ; contestations ; mutations survivantes.
- Base de comparaison : les trois dernières specs et les cinq dernières PR minimes du projet, mesurées avant activation (`apv metrics prs --since` sur l'historique).
- Objectifs à vérifier, pas des promesses : PR de la voie sans code, de prête à fusionnée en **30 minutes** au plus ; PR de la voie des réglages en **40 minutes** au plus ; spec type de 5 tâches : temps de bout en bout **au plus égal** à la base, visé **25 % plus court** ; chemin critique de la phase de code **au plus 10 % plus long**.
- `apv status` affiche les trois derniers chiffres. La phase 6 en fait un bilan pour l'opérateur.

# Partie II bis. Parallélisme

Les tâches ont déjà chacune leur worktree. Le vrai goulot est l'accès aux piles de test : le projet pilote a deux piles Supabase locales, un verrou exclusif par pile, et les tests navigateur des agents comme les suites complètes passent un par un. Un agent attend jusqu'à 40 minutes le verrou d'une pile pendant qu'une suite complète la tient. Cette partie rend l'accès partagé chaque fois que les données le permettent, et garde exclusif ce qui doit l'être.

## 12. Isolation des données de test par worktree

### 12.1 Trois modes, déclarés par pile

Champ `isolation` d'une pile (`stacks[]` de `.apv/config.json`) :

| Mode | Principe | Pour |
|---|---|---|
| `prefix` (défaut proposé) | chaque worktree reçoit un préfixe (`apv-<court>-`) ; ses tests créent leurs utilisateurs et leurs lignes sous ce préfixe ; l'isolation tient par les données et par l'isolation par utilisateur de l'application (RLS) | toute pile, Supabase compris : l'API (PostgREST, Auth) reste branchée sur une seule base |
| `database` | une base par worktree, clonée en quelques secondes depuis une base modèle migrée (`CREATE DATABASE ... TEMPLATE ...`) | Postgres seul, ou un serveur d'application qui prend son adresse de base par variable |
| `schema` | un schéma par worktree (`search_path`) | applications qui le permettent ; rarement avec un service tiers qui fixe ses schémas |

Supabase, dit franchement : son API et son authentification visent une seule base et un seul schéma `auth`. Une base ou un schéma par worktree ne marche donc pas pour les tests navigateur qui passent par l'API. Le mode `prefix` est le seul qui convienne, et il repose sur une règle déjà exigée des tests (« des données propres à chaque test, jamais partagées »).

### 12.2 Commandes

```
apv sandbox acquire --stack <id> [--repo <copie>] [--json]
apv sandbox release [--repo <copie>]
apv sandbox list
apv sandbox gc [--dry-run]
```

- `acquire` attribue au worktree, sous bail (`apv lock`, propriétaire vérifié, expiration) : le préfixe ou la base, et **une plage de ports** (section 12.4). Il écrit les variables dans `.apv/state/sandbox.env` du worktree (ignoré par Git) : `APV_SANDBOX`, `APV_DATA_PREFIX`, `APV_PORT_BASE`, et celles que la pile déclare (`DATABASE_URL` en mode `database`).
- Mode `database` : la commande `create` de la pile clone la base modèle. La base modèle se refait après une migration, sous verrou exclusif.
- `release` lance la commande `drop` de la pile (supprime la base, ou les utilisateurs et lignes du préfixe), puis rend le bail. Une tâche finie, une copie retirée ou un bail expiré libèrent le bac à sable ; `gc` nettoie les orphelins (bail mort, worktree disparu).
- `apv gates run` et `apv lock run e2e` chargent `sandbox.env` quand il existe.

### 12.3 Verrou partagé, verrou exclusif

`apv lock` gagne un mode partagé : `apv lock run e2e --shared -- <commande>`. Plusieurs détenteurs partagés tournent en même temps sur une pile isolée. Restent **exclusifs** (attente que les partagés finissent, priorité à l'exclusif pour ne pas l'affamer) :
- l'application des migrations et la refonte de la base modèle ;
- toute remise à zéro globale (`db reset`, graine globale) ;
- le démarrage, l'arrêt et le redémarrage de la pile (`apv stacks start`, `idle-stop`) ;
- un changement de configuration de l'authentification ou du stockage de la pile ;
- tout contrôle dont la commande remet la base à zéro (champ `lock.exclusive: true`, ou commande reconnue).

Le crochet Bash (section 18.2 de APV3-SPEC.md) accepte une commande de pile modifiante seulement sous le verrou exclusif, comme aujourd'hui.

### 12.4 Un port par worktree

Plage déclarée (`resources.portRange`, par exemple `5200-5399`), découpée en blocs (`resources.portBlock`, défaut 10). `acquire` donne un bloc libre au worktree. Les serveurs de test (aperçu de l'application, serveur web de Playwright) lisent `APV_PORT_BASE` au lieu d'un port fixe. `apv onboard` signale les ports fixes de la configuration de test. `apv procs` connaît les blocs : un port tenu hors du bloc de sa copie est signalé.

### 12.5 Ce qui garde les tests honnêtes

`apv tests check` gagne la règle `globalState` (erreur en mode `prefix`) : vidage de table, `count(*)` ou liste sans filtre de l'utilisateur ou du préfixe, remise à zéro de la base dans un test, adresse e-mail en dur sans le préfixe. Un test qui dépend de l'état global ne peut pas tourner en parallèle d'un autre : il le dit avant de casser.

## 13. Suites complètes en parallèle

- `suite.queue.slots` remplace la file unique : nombre de suites complètes simultanées sur la machine. Défaut : `1` sans isolation (comportement actuel) ; avec isolation, **une par pile** quand la suite remet sa base à zéro au départ, ou plusieurs par pile en mode `database` (bac à sable propre à chaque suite), bornées par `suite.queue.maxLoad`.
- Une suite prend un bac à sable comme un agent (`apv sandbox acquire`), et ses reçus le notent (`sandbox`, `stack`). La preuve ne change pas : même commit, arbre propre, configuration de la base.
- **Correction de `GATE_BUSY`** : aujourd'hui, `apv gates run --stage full --stacks 2` refuse quand le verrou d'**une** pile déclarée est tenu par un autre processus, même une pile que la suite n'utilise pas. Après : seules les piles de `--stacks` (ou celles que les contrôles verrouillent, sans `--stacks`) sont vérifiées, et seuls leurs ports et le bloc de ports de la suite. Un verrou partagé tenu sur une pile isolée ne bloque pas une suite qui le prend en partagé.
- La charge reste surveillée : au-delà de `maxLoad`, une suite attend (borne `loadWaitMs`), car la charge fait naître des tests instables.

## 14. Découpage des specs : chaîne courte, vagues larges

- `apv spec validate` a déjà `SPEC_DEPTH` (chaîne au-delà de 3) et `SPEC_SIZE` (plus de 6 tâches). Nouvel avertissement **`SPEC_WIDTH`** : la longueur du chemin critique dépasse la moitié du nombre de tâches (au-delà de 3 tâches), ou une vague n'a qu'une tâche alors que la suivante en a plusieurs. Le message propose le découpage ci-dessous.
- **Fondation de contrats d'abord** : une petite tâche (cible 10 à 15 minutes) pose types, signatures, routes et fonctions serveur déclarées, messages ; les autres tâches partent dès son intégration. Ces contrats servent aussi au testeur (section 5.2).
- **Une seule fondation par spec** quand c'est possible ; le pilote en avait deux (`FONDATIONS-RECHERCHE`, `FONDATIONS-VOLET`) pour une spec de 5 tâches.
- **Fichiers disjoints dans une vague** : l'architecte attribue un propriétaire par fichier (règle existante) et sépare les tâches par fichier plutôt que par couche.
- `apv run start` et `apv run status` affichent la largeur de chaque vague et la longueur du chemin critique en tâches.

## 15. Plusieurs specs en parallèle par défaut

- Aujourd'hui, une spec de plus se lance à la main (`claude -p "/apv:run <id>"`) et le nombre est borné par les piles libres. Après : le chef de projet lance par défaut autant d'exécutions que de **bacs à sable** disponibles, dans la limite du quota (règles inchangées : `slow_down` à 70 %, une de plus au plus ; rien de nouveau au-delà de 85 %).
- `apv run start` compare les `allowedPaths` de la spec à ceux des exécutions en cours (`src/policy/overlap.ts` existe) : recouvrement, avertissement et proposition d'empiler les specs au lieu de les paralléliser.
- Les migrations restent en série entre specs : une tâche de migration prend le verrou exclusif `migrations` du dépôt, et ses horodatages sont relus à l'intégration (règle existante de l'intégrateur).
- Fusion : les PR prêtes ensemble forment un lot (`apv stack batch`, section 9.3), une suite complète pour toutes.

# Partie III. Commun

## 16. Équilibre

Règle : **chaque mécanisme ajouté au début tourne en parallèle d'un travail existant, hors du chemin critique, ou retire à la fin au moins le temps qu'il ajoute.** Sinon il est écarté ou optionnel.

| Mécanisme | Ajout sur le chemin critique | Retiré à la fin | Réglage proportionné au risque | Verdict |
|---|---|---|---|---|
| Tests écrits d'abord | 0 à 2 min par tâche (un commit de plus ; ce sont les tests d'aujourd'hui, plus tôt) | une partie des passes de corrections après la suite complète | dispensé pour refactorisation pure (`characterization`), documentation et configuration (`none`) | gardé |
| Rouge `apv tdd red` | proche de 0 : en arrière-plan sur une copie, pendant le code ; seule l'attente du reçu à la fin (0 à 1 min) | idem | seuls les tests de la tâche ; `redArgs` raccourcit les délais d'assertion ; jamais la suite | gardé, **en arrière-plan obligatoire** |
| Rouge synchrone avant le code | 1 à 4 min par tâche (tests navigateur) | rien de plus | aucun | **écarté** |
| `apv tdd check` | moins de 2 s | rien | aucun | gardé |
| Testeur | 0 à 10 min une fois par spec (seulement s'il finit après les fondations) | les tests réajustés après coup (1 h le 2026-10-04) | seulement pour une spec à interface, à données ou à critère à risque ; par défaut scénarios `AC-USER` et critères à risque | gardé, **conditionnel** |
| Contestation d'un test | 10 à 20 min chacune sur la tâche concernée | un test faux corrigé avant la suite complète plutôt qu'après | tranchée par écrit, sans relecture de plus | gardé |
| Mutation ciblée | 0 (pendant les relectures de tâche, déjà parallèles) | une passe de corrections tardive sur un critère à risque | seulement les critères `risk` | gardé |
| Outil de mutation de la pile | 0 s'il reste dans `maxMinutes` et dans le temps des relectures ; sinon jusqu'à 15 min | peu | fichiers à risque du diff seulement | **optionnel, désactivé par défaut** |
| Relecture par tâche | la relecture de la dernière tâche seulement (15 à 20 min) ; les autres tournent pendant les tâches suivantes | les relectures finales complètes (30 à 40 min) deviennent delta et assemblage (10 à 20 min) | `securite` seule pour une tâche de risque faible ; domaines choisis par `apv review plan` | gardé |
| Textes comparés par l'implementer | quelques secondes | une partie de la relecture de fidélité finale | tâches à interface seulement | gardé |
| Captures par l'outil à la relecture de tâche | 0 (avec la relecture de tâche) | captures finales limitées aux écrans du delta | tâches à interface seulement | gardé |
| Captures par l'implementer | 3 à 6 min par tâche à interface | idem | aucun | **optionnel** (`design.captureBy`) |
| Suite d'impact | elle **remplace** deux suites complètes (40 min chacune) par deux suites d'impact (10 à 15 min) | 50 à 60 min par spec | suite entière exigée dans les cas de la section 9.2 | gardé |
| Voies sans code et des réglages | négatif : retire une suite complète et trois relectures | 60 à 70 min par PR minime | clés et sortes de fichiers fermées, lues à la base | gardé |
| Mesure | 0 (lecture des événements) | rien, mais elle prouve le reste | aucun | gardé |
| Bac à sable par worktree et verrou partagé | négatif : 1 min pour `acquire`, contre 0 à 40 min d'attente du verrou retirées par vague | les attentes des tâches derrière une suite complète | `prefix` par défaut ; `database` seulement là où la pile le permet ; exclusif gardé pour migrations et remises à zéro | gardé |
| Port par worktree | 0 | les orphelins et conflits de ports (`GATE_BUSY`) | aucun | gardé |
| Suites complètes en parallèle | négatif : la seconde suite n'attend plus la première (40 min) | 0 à 40 min par suite en file | `slots` bornés par les piles et `maxLoad` | gardé |
| Chaîne courte, vagues larges | négatif : une vague de moins sur le chemin critique dans les specs concernées (20 à 40 min) | rien | avertissement seulement (`SPEC_WIDTH`), jamais un refus | gardé |
| Plusieurs specs à la fois | 0 sur le chemin d'une spec ; hausse du débit | rien sur une spec | quota (seuils inchangés), recouvrement de fichiers | gardé |
| Troisième pile Docker | 0 | comme deux suites en parallèle | aucun | **écarté par défaut** : 2 à 3 Go de mémoire de plus pour un gain que l'isolation donne déjà |

Si la mesure de la phase 6 montre un chemin critique de la phase de code plus long de plus de 10 %, ou un temps de bout en bout plus long, le mécanisme fautif repasse en optionnel jusqu'à décision de l'opérateur.

## 17. Coût en temps, avant et après

### 17.1 Repères du projet pilote

- Suite complète : environ 40 minutes. Tâche : 20 à 40 minutes. Spec : 4 à 6 tâches en 2 ou 3 vagues.
- Aujourd'hui : deux suites complètes par spec (dernière intégration, livraison), plus celle du lot à la fusion ; quatre relectures en parallèle à la fin (30 à 40 minutes) ; une passe de corrections coûte 60 à 80 minutes avec sa nouvelle vérification.
- PR minimes #202 et #203 : environ 1 h 30 chacune (quatre relectures et une suite complète de 40 minutes).

### 17.2 PR minime

| Étape | Aujourd'hui (#202, #203) | Après |
|---|---|---|
| Relectures | 4, environ 30 à 40 min | `securite` légère seule (+ `fidelite` pour une maquette) : 5 à 10 min |
| Suite complète | 40 min | aucune dans la PR (voie sans code) ; contrôles de tâche pour la voie des réglages : 1 à 5 min |
| Vérifications, PR, fusion | 10 à 20 min | 5 à 10 min |
| **Total** | **environ 1 h 30** | **environ 15 à 25 min**, objectif 30 min au plus |

### 17.3 Fonctionnalité de 5 tâches en 3 vagues

| Phase | Aujourd'hui | Après |
|---|---|---|
| Modèle de données et plan | 20 à 30 min | 25 à 35 min (contrats pour le testeur dans le plan) |
| Testeur | aucun | en parallèle des fondations : 0 à 10 min sur le chemin critique |
| Code, 3 vagues sur le chemin critique | 60 à 120 min | 63 à 126 min (rouge en arrière-plan ; au plus 10 % de plus, objectif) |
| Relecture de la dernière tâche | aucune | 15 à 20 min (les autres en parallèle des tâches) |
| Intégrations et suite à la dernière intégration | 10 min + 40 min | 10 min + 10 à 15 min (suite d'impact) |
| Relectures finales | 30 à 40 min | 10 à 20 min (delta et assemblage sécurité) |
| Corrections | 30 à 80 min (souvent une passe) | 0 à 40 min (constats trouvés par tâche, plus tôt) |
| Livraison | 40 min (suite complète) | 10 à 15 min (suite d'impact, si la tête a bougé) |
| Fusion par lot | 40 min (suite du lot) | 40 min (inchangée) |
| Attente du verrou de pile (tests navigateur des tâches derrière une suite) | 10 à 60 min sur la spec | 0 à 5 min (bac à sable, verrou partagé) |
| Attente d'une autre suite complète (file unique) | 0 à 40 min | 0 à 5 min (une suite par pile) |
| **Total estimé** | **environ 4 h 40 à 8 h 20** | **environ 3 h à 5 h 40** |

Une spec découpée en vagues plus larges (section 14) retire en plus une vague du chemin critique quand son graphe le permet : 20 à 40 minutes.

Lecture honnête : le gain vient surtout de la fin (suites d'impact, relectures du delta, moins de corrections). Le début gagne 5 à 25 minutes de plus. Dans le pire cas, testeur en retard et contestations, les deux colonnes se rapprochent : c'est pourquoi le critère d'acceptation demande seulement « pas plus long », et vise 25 % de moins. Quota : un agent de plus (le testeur, conditionnel), des relectures plus nombreuses mais plus courtes ; ordre de grandeur constant à +15 %, mesuré en phase 6.

### 17.4 Parallélisme : gain et coût

Gain estimé :
- Attentes du verrou de pile : aujourd'hui jusqu'à 40 minutes par attente, plusieurs fois par spec quand une suite tourne pendant une vague. Après : un agent attend seulement une opération exclusive (migration, remise à zéro), quelques minutes. De 10 à 60 minutes retirées par spec, selon le nombre de suites croisées.
- Suites complètes : deux suites (deux lots, ou un lot et une preuve) tournent en même temps, une par pile ; la seconde gagne jusqu'à 40 minutes.
- Plusieurs specs : le débit monte à peu près avec le nombre de bacs à sable, borné par le quota de l'opérateur. Une spec seule n'en est pas plus rapide.

Coût, sur la machine du pilote :
- Mode `prefix` : aucune pile, aucun conteneur de plus. Quelques lignes par worktree, supprimées à `release`.
- Mode `database` : une base de quelques dizaines à 100 Mo par worktree, clonée en quelques secondes ; aucun conteneur de plus.
- Ce qui pèse vraiment : chaque agent qui lance ses tests navigateur en même temps ajoute un serveur d'aperçu (200 à 400 Mo) et un navigateur par processus de test (300 à 500 Mo). Quatre agents en parallèle : 3 à 4 Go de plus. La charge processeur monte aussi : `suite.queue.maxLoad` et une borne `e2e.maxShared` (défaut : nombre de processeurs divisé par 4) limitent les détenteurs partagés, pour ne pas faire naître de tests instables.
- Une troisième pile Supabase coûterait 2 à 3 Go et 1 à 2 minutes de démarrage : écartée par défaut (section 16).

## 18. Champs de spec et de configuration

### 18.1 Spec (`.apv/specs/*.json`)

Tous facultatifs ; une spec existante reste valide. Le schéma refuse aujourd'hui les propriétés inconnues (`specTaskSchema`, `acceptance[]` de `src/lifecycle/contracts.ts`) : ces champs y sont ajoutés.

Critère :

```json
{ "id": "AC-ISOLATION", "description": "...", "verification": "...", "proof": "test", "risk": ["securite", "donnees"] }
```

- `proof` : `test` (défaut), `review` (fidélité visuelle), `gates` (porté par les contrôles, comme `AC-CONTROLES`), `docs`. Seuls les critères `test` exigent un rouge. Refusé autre que `test` sur un `AC-USER-n` ou un critère cité par le plan de sécurité.
- `risk` : drapeaux de la section 6.

Tâche :

```json
{ "id": "RECHERCHE", "tdd": { "mode": "red-first", "setup": [] } }
{ "id": "DOCS-RGPD", "tdd": { "mode": "none", "kind": "docs", "reason": "Page de confidentialité et registre seulement, aucun code." } }
```

Spec :

```json
"tdd": { "tester": { "enabled": true, "scope": "user-and-risk", "paths": ["tests/acceptance/fiche-appel/**", "e2e/fiche-appel/**"] } }
```

`tester.enabled` est calculé par défaut (section 5.1) ; `scope` vaut `user-and-risk` (défaut) ou `all`.

### 18.2 Configuration (`.apv/config.json`), lue à la base

```json
"tdd": {
  "mode": "enforce",
  "criterionPattern": "\\[(AC-[A-Z0-9-]+)\\]",
  "testPaths": [],
  "runners": [
    { "id": "unit", "match": ["**/*.test.ts"], "command": ["npx", "vitest", "run", "--reporter=junit", "--outputFile={{junit}}", "{{files}}"] },
    { "id": "e2e", "match": ["e2e/**/*.spec.ts"], "lock": { "resource": "e2e" },
      "command": ["npx", "playwright", "test", "--reporter=junit", "{{files}}"], "env": { "PLAYWRIGHT_JUNIT_OUTPUT_NAME": "{{junit}}" },
      "redArgs": ["--retries=0", "--timeout=15000"] }
  ],
  "causes": { "assertion": [], "absent": [], "environment": [] },
  "mutation": { "tool": null, "maxMinutes": 15 }
},
"review": { "perTask": true },
"design": { "captureBy": "reviewer" },
"proof": { "impact": { "enabled": true, "maxImporters": 15, "maxFiles": 60 } },
"rules": { "settingsLane": { "keys": ["gates[].timeoutMs", "gates[].repeatChanged.maxFiles"] } },
"stacks": [ { "id": "1", "lockFile": "...", "isolation": { "mode": "prefix", "create": ["node", "scripts/e2e/sandbox.mjs", "create"], "drop": ["node", "scripts/e2e/sandbox.mjs", "drop"] } } ],
"suite": { "queue": { "slots": "per-stack", "maxLoad": 12 } },
"resources": { "portRange": "5200-5399", "portBlock": 10 },
"e2e": { "maxShared": 4 }
```

- `tdd.mode` : `off`, `warn` (refus affichés, reçus écrits, rien ne bloque), `enforce`. Défaut `off` sur une configuration existante, `enforce` pour `apv init`.
- `runners` : un lanceur par famille de fichiers ; `lock` comme le champ `lock` d'un contrôle ; `redArgs` au seul rouge.
- `causes` : motifs ajoutés aux défauts, jamais retirés.
- `review.perTask`, `design.captureBy`, `proof.impact` et `rules.settingsLane` : section 7 à 10. `rules.settingsLane.keys` ne peut que restreindre la liste fermée de la section 10.2.
- `stacks[].isolation`, `suite.queue.slots` (`1`, un nombre, ou `per-stack`), `resources.portRange`, `resources.portBlock`, `e2e.maxShared` : sections 12 et 13. Sans `isolation`, une pile garde son verrou exclusif actuel.

## 19. Changements aux agents, compétences et workflows

| Fichier | Changement |
|---|---|
| `agents/testeur.md` (nouveau) | rôle de la section 5 ; tests par interfaces publiques ; titres `[AC-...]` ; fait observable attendu, données propres à chaque test ; ses chemins seuls ; rapport : branche par tâche, sorties brutes de `git rev-parse`, contrats manquants, niveau de confiance |
| `agents/implementer.md` | fusion de la branche du testeur ; commit des tests d'abord ; `apv tdd red --detach` en arrière-plan ; fichiers du testeur intouchables ; `contestedTests` ; `apv design texts` pour une tâche à interface ; rapport `tdd` (commit des tests, reçu rouge, causes) ; une correction suit le même ordre |
| `agents/integrateur.md` | fichiers du testeur intacts ; conflit sur eux : arrêt ; `apv tdd check --integration` ; liste des fichiers du delta dans le rapport |
| `agents/architecte.md` | « Contrats pour le testeur » ; chemins du testeur ; branches `apv/<id>-tests-*` |
| `agents/product.md` | `proof` et `risk` par critère ; exceptions `tdd` avec raison ; critères testables de l'extérieur ; décisions et maquettes en PR à part (voie sans code) |
| `agents/qa-securite.md`, `architecte-donnees.md`, `dpo.md` | relecture de tâche ; mutation des critères à risque de leur domaine ; delta ; pour la sécurité, attaques scriptées à la tâche et rejouées à l'assemblage |
| `agents/qa-fidelite.md` | relecture de tâche sur les reçus `design-capture` et `design-texts` ; à la fin, écrans du delta seulement |
| `skills/tdd/SKILL.md` | réécrite : rouge, vert, propre prouvé par l'outil ; bonne raison ; caractérisation ; testeur |
| `skills/run/SKILL.md`, `skills/chef-de-projet` | étape `tests` ; testeur avec les fondations ; relecture de tâche lancée à chaque tâche vérifiée ; suite d'impact à la place des deux suites complètes quand l'outil l'admet ; fusion par lot ; contestations notées |
| `skills/review/SKILL.md` | mode tâche, mode delta, assemblage sécurité, `apv review coverage` |
| `skills/spec/SKILL.md`, `skills/stack` | champs `proof`, `risk`, `tdd` ; voies sans code et des réglages |
| `workflows/vague.js` | en `enforce`, rapport refusé sans `tdd.testCommit` et `tdd.redReceipt` (sauf exception déclarée), à côté des refus existants de `reuse` et `placement` ; `contestedTests` validé quand présent |
| `workflows/revues.js` | `scope` (`task:<id>`, `delta`, `assemblage`), fichiers du delta, critères à risque, reçus rouges et de captures |
| Parallélisme (implementer, intégrateur, chef de projet, compétences `run` et `chef-de-projet`) | `apv sandbox acquire` au démarrage d'une tâche et `release` à la fin ; tests navigateur sous `apv lock run e2e --shared` ; ports lus dans `APV_PORT_BASE` ; jamais de remise à zéro globale hors verrou exclusif ; plusieurs exécutions lancées par défaut selon les bacs à sable et le quota |
| `agents/architecte.md` (découpage) | fondation de contrats d'abord, une seule fondation si possible, vagues larges, fichiers disjoints ; `SPEC_WIDTH` lu et traité dans le plan |
| Modèle de `.apv/brief.md` | test d'abord, titres `[AC-...]`, fichiers du testeur intouchables |
| Crochet Bash | session `apv:testeur` : refus des lectures d'une branche de tâche (`git show`, `git diff`, `git log -p`, `git checkout` de `apv/<id>-<tâche>` hors `-tests-`) ; `apv tdd mutate` permis aux relecteurs |

## 20. Règles ajoutées à REGLES.md

Section 1 (vérifiées par `apv rules check`, configuration lue à la base commune) :

| Règle | Refusé quand | Pourquoi |
|---|---|---|
| `tdd` | `tdd.mode` vaut `enforce` et une tâche d'une spec livrée par la PR n'a ni reçu `tdd-red` valide pour son commit des tests (ancêtre de la tête), ni exception déclarée | un test jamais vu rouge ne prouve pas qu'il teste ; le même agent écrivait code et tests |
| `mutation` | un critère à risque d'une spec livrée n'a pas de mutation `killed` au commit relu, ou a une `survived` sans `killed` plus récente | un test qui reste vert quand la règle casse ne protège rien |
| `relecture` (étendue) | un fichier changé n'est ni couvert par une relecture de tâche de son domaine ni relu au delta ; ou la relecture d'assemblage `securite` manque au commit exact | relire tôt ne dispense pas de relire ce qui a changé après, ni l'assemblage |
| `captures` (étendue) | une capture jointe n'a ni l'empreinte d'un reçu `design-capture` au commit relu, ni la forme exigée aujourd'hui | une capture prise par l'outil se vérifie, une capture jointe à la main non |
| `preuve` | inchangée : suite complète au commit exact fusionné, jugée sur le lot | la suite d'impact ne prouve jamais la suite complète |

Section 2 (autres garde-fous de l'outil) : rouge pour la bonne raison (`apv tdd red`) ; test d'abord (`apv tdd check`, `apv scope check`, `apv run set ... done`) ; fichiers du testeur intouchables (`TESTER_OWNED`) ; testeur sans le code (crochet, garde-fou contre l'erreur) ; mutation jamais commitée (`apv tdd mutate`) ; suite d'impact refusée dans les cas de la section 9.2 ; voie des réglages limitée à une liste fermée ; opérations de pile modifiantes sous verrou exclusif seulement, verrou partagé pour les tests en bac à sable ; un port par worktree, attribué sous bail ; `GATE_BUSY` limité aux piles que la suite utilise ; `globalState` de `apv tests check` en mode `prefix`.

Section 4 (au chef de projet) :

| Règle | Comment il la vérifie |
|---|---|
| Contestation tranchée par écrit, avec sa source | `.apv/state/tests-contestes-<id>.md` ; question de produit groupée à l'opérateur |
| Ligne clé d'une mutation pertinente | justifiée dans le rapport du relecteur, relue par le chef de projet |
| Exception `tdd` justifiée | `apv:product` et l'opérateur à la validation de la spec |
| Critère à risque bien marqué | `apv:product`, `SPEC_RISK`, relecture sécurité |
| Équilibre tenu | `apv metrics run` à chaque spec ; un mécanisme qui allonge le chemin critique de plus de 10 % est signalé à l'opérateur |

## 21. Migration des projets existants

- Sans section `tdd`, `review.perTask`, `proof.impact` : comportement de 3.0.0-alpha.19, aucun refus nouveau.
- `apv onboard` et `apv init` détectent les lanceurs (Vitest, Jest, Playwright, pytest, `go test`), proposent la section `tdd`, et listent les contrôles `full` sans `affected` (la suite d'impact les ferait tourner en entier). Sur une configuration existante, ils affichent sans écrire.
- Specs existantes valides telles quelles ; en `warn`, le chef de projet voit ce qui serait refusé.
- Exécutions en cours : modes relevés au `apv run start` et gardés dans l'état ; une exécution commencée avant finit sans les nouvelles règles.
- Tests existants sans `[AC-...]` : non concernés.
- Mesure : `apv metrics prs --since` calcule la base de comparaison sur l'historique avant toute activation.
- Projet pilote : voies sans code et des réglages d'abord (gain immédiat, risque faible), puis bacs à sable `prefix` et correction de `GATE_BUSY`, puis relecture par tâche et suite d'impact, puis `tdd` en `warn`, puis `enforce` après la phase 6.

## 22. Phases de livraison (petites PR)

Ordre choisi pour l'équilibre : d'abord la mesure, puis ce qui retire du temps (parallélisme, fin allégée), ensuite ce qui en ajoute au début. Le mode `database` des bacs à sable vient avec la phase 0 bis pour les projets Postgres seul.

| Phase | Contenu | Accepté quand |
|---|---|---|
| 0. Mesure | `apv metrics run` et `apv metrics prs`, base de comparaison du pilote | chiffres de bout en bout et chemin critique calculés pour les specs et PR passées, sans saisie |
| 0 bis. Parallélisme | correction de `GATE_BUSY` (piles de `--stacks` seules) ; `apv lock --shared` ; `apv sandbox` en mode `prefix` ; blocs de ports ; `globalState` ; `suite.queue.slots` ; `SPEC_WIDTH` ; plusieurs exécutions par défaut | quatre agents lancent leurs tests navigateur en même temps sur une pile isolée ; une migration attend les détenteurs partagés puis passe seule ; deux suites tournent en même temps sur deux piles ; `--stacks 2` ne refuse plus pour un verrou de la pile 1 |
| 1. Petites PR | fusion de la voie sans code (#121) et compléments ; voie des réglages | une PR de documentation et une PR comme #203 passent sans suite complète avec la seule relecture `securite` légère ; un réglage à la baisse ou une commande changée sortent de la voie |
| 2. Fin allégée | relecture par tâche, `apv review coverage`, delta, assemblage, captures et textes par l'outil, suite d'impact, règles `relecture` et `captures` étendues | un fichier changé après sa relecture de tâche est remis en delta ; une migration exige la suite entière ; la règle `preuve` reste jugée sur le lot |
| 3. Rouge | `apv tdd red` (arrière-plan, copie détachée), lanceurs, JUnit, causes, reçu `tdd-red`, section `tdd` | rouge par assertion accepté, `absent` accepté puis refusé hors périmètre, syntaxe et environnement refusés, seuls les fichiers du commit lancés, sur Vitest, Playwright et pytest |
| 4. Test d'abord | `apv tdd check`, scope check, `run set done`, champs `proof` et `tdd`, exceptions, compétence `tdd`, implementer, `apv:vague` | une tâche sans reçu rouge refusée par les trois commandes ; test sauté après le rouge refusé ; exception `docs` qui touche du code refusée |
| 5. Testeur et mutation | agent `apv:testeur`, chemins possédés, étape `tests`, contestations, crochet ; champ `risk`, `apv tdd mutate`, règles `tdd` et `mutation` | `TESTER_OWNED` ; `apv run next` attend la branche du testeur ; une mutation qui survit bloque la fusion ; arbre propre après un signal pendant la mutation |
| 6. Bilan | deux specs du pilote ; outil de mutation de pile en essai seulement si le temps des relectures le permet | l'opérateur a les chiffres de la section 11 et décide des modes par défaut |

Chaque phase : une PR, version alpha montée, CHANGELOG, tests qui refusent et tests qui acceptent (REGLES.md, section 6).

## 23. Critères d'acceptation de la capacité

- **AC-TDD-RED** : `apv tdd red` ne lance que les fichiers de test du commit, sur une copie détachée, et écrit un reçu `red` seulement si chaque critère `test` a un test rouge pour une cause acceptée.
- **AC-TDD-CAUSES** : chaque cause de la section 4.3 est reconnue sur un exemple réel de Vitest, Jest, Playwright, pytest et `go test`.
- **AC-TDD-ABSENT** : un import manquant n'est accepté que pour un fichier absent à la base et dans les `allowedPaths`.
- **AC-TDD-ORDER** : un premier commit qui contient du code fait refuser `apv tdd check`, `apv scope check` et `apv run set ... done` en `enforce`, et seulement afficher en `warn`.
- **AC-TDD-WEAKEN** : un test du reçu sauté, retiré ou privé d'une assertion fait refuser, sauf commit de testeur cité dans une contestation tranchée.
- **AC-TDD-EXCEPTION** : une tâche `none` de `kind` `docs` qui touche du code est refusée par `apv spec validate` et `apv tdd check`.
- **AC-TESTER-OWNED** : un commit d'implementer sur un fichier du testeur est refusé (`TESTER_OWNED`).
- **AC-TESTER-PARALLEL** : le testeur part avec les fondations ; il ne tourne pas pour une spec sans interface, sans données ni critère à risque.
- **AC-MUTATION** : `apv tdd mutate` laisse l'arbre propre dans tous les cas ; une mutation `survived` fait refuser la règle `mutation`.
- **AC-REVIEW-TASK** : une relecture de tâche couvre un fichier tant que son blob ne change pas ; tout fichier changé ensuite passe au delta ; l'assemblage `securite` est toujours exigé au commit exact.
- **AC-IMPACT** : la suite d'impact remplace la suite complète seulement aux conditions de la section 9.1, et la suite entière est exigée dans chaque cas de la section 9.2 (un test par cas).
- **AC-LANES** : une PR de documentation et une PR de réglage à la hausse passent sans suite complète, avec `securite` seule ; un réglage à la baisse est refusé de la voie.
- **AC-RULES** : les nouvelles règles sont lues à la base commune ; une PR qui passe `tdd.mode` à `off` ou élargit une voie ne s'en dispense pas.
- **AC-NO-WEAKER** : aucune règle existante ne devient plus permissive, hors des voies de la section 10 ; `preuve` reste jugée au commit exact fusionné.
- **AC-MIGRATION** : sans les nouvelles sections et champs, comportement identique à 3.0.0-alpha.19 (suite de tests existante verte).
- **AC-BALANCE** : mesuré par `apv metrics run` sur une spec type (5 tâches, 3 vagues) du projet pilote, le temps de bout en bout **n'augmente pas** par rapport à la base de comparaison, et le chemin critique de la phase de code n'augmente **pas de plus de 10 %**. Sinon, le mécanisme responsable repasse en optionnel avant toute activation par défaut.
- **AC-PAR-SANDBOX** : deux worktrees en mode `prefix` lancent leurs tests navigateur en même temps sur la même pile sans se voir ; `release` supprime les données du préfixe ; `gc` nettoie un bac à sable dont le bail est mort.
- **AC-PAR-EXCLUSIVE** : une migration, une remise à zéro ou un arrêt de pile attendent la fin des détenteurs partagés et refusent d'en laisser entrer de nouveaux pendant l'attente ; le crochet Bash refuse une opération de pile modifiante hors verrou exclusif.
- **AC-PAR-PORTS** : deux worktrees reçoivent des blocs de ports disjoints ; un bloc est rendu à la fin du bail.
- **AC-PAR-SUITES** : avec `slots: "per-stack"` et deux piles, deux suites complètes tournent en même temps et leurs reçus prouvent chacune leur commit ; `apv gates run --stage full --stacks 2` ne refuse pas pour un verrou tenu sur la pile 1.
- **AC-PAR-WIDTH** : `apv spec validate` avertit `SPEC_WIDTH` sur une chaîne de 4 tâches en ligne, et pas sur 1 fondation suivie de 4 tâches parallèles.
- **AC-SMALL-PR** : mesurée par `apv metrics prs`, une PR de la voie sans code passe de prête à fusionnée en 30 minutes au plus sur le projet pilote.

Scénarios de la personne cible (chef de projet APV et opérateur) :

- **AC-USER-1** : Étant donné une tâche en `enforce`, quand l'implementer commite code et tests ensemble, alors `apv scope check` refuse avec « le premier commit de la tâche contient du code » et dit comment refaire l'ordre sans réécrire un commit poussé.
- **AC-USER-2** : Étant donné un test rouge à cause d'une faute de frappe dans son import, quand le rouge tourne, alors l'outil refuse avec la cause, le test et l'extrait du message, et n'écrit aucun reçu `red`.
- **AC-USER-3** : Étant donné un critère `AC-ISOLATION` marqué `securite`, quand le relecteur retire le filtre `user_id` par `apv tdd mutate --preset drop-filter` et que le test reste vert, alors un constat `eleve` bloque la fusion jusqu'à un test plus fort et une mutation tuée.
- **AC-USER-4** : Étant donné une PR qui ne change que le registre et une maquette validée, quand l'opérateur demande sa fusion, alors elle est fusionnée après la seule relecture `securite` légère et la `fidelite` de la maquette, sans suite complète, en moins de 30 minutes.
- **AC-USER-5** : Étant donné une spec de 5 tâches livrée avec ces mécanismes, quand l'opérateur lance `apv metrics run <id>`, alors il voit le temps de bout en bout, le chemin critique de la phase de code et leur écart à la base de comparaison.
- **AC-USER-6** : Étant donné une suite complète qui tourne sur la pile 1, quand trois implementers lancent leurs tests navigateur, alors ils tournent tout de suite dans leurs bacs à sable, sans attendre la fin de la suite.

## 24. Questions ouvertes pour l'opérateur

| # | Question | Recommandation |
|---|---|---|
| Q1 | Le testeur écrit-il tous les critères `test`, ou les scénarios `AC-USER` et les critères à risque ? | `AC-USER` et critères à risque : l'indépendance compte le plus là, pour moins de temps. Élargir après la mesure. |
| Q2 | Accepter un rouge `absent` (module neuf), ou exiger un squelette dans les fondations ? | Accepter, borné au périmètre et signalé : un squelette serait du code avant le rouge. |
| Q3 | Mode par défaut d'un projet existant : `warn` ou `enforce` ? | `warn` sur une spec, puis `enforce` sur les chiffres. Nouveaux projets : `enforce`. |
| Q4 | Une mutation par critère à risque, ou par fichier à risque ? | Par critère : c'est la règle métier qui doit casser le test. |
| Q5 | Le drapeau `argent` va-t-il à `apv:qa-securite` ? | Oui pour l'instant ; un rôle à part seulement si un projet facture. |
| Q6 | L'outil de mutation de la pile (Stryker) : maintenant ou après la mesure ? | Après : il n'est pas sûr de tenir l'équilibre. |
| Q7 | Une correction de constat suit-elle aussi l'ordre test puis code, vérifié par l'outil ? | Oui : la règle « prouve » le demande déjà, l'outil le rend vérifiable sans coût de plus. |
| Q8 | Faut-il sceller les reçus `tdd-red` et `tdd-mutation` par le crochet, comme les relectures, alors que les reçus de contrôles ne le sont pas ? | Non dans un premier temps : mêmes garanties que les reçus de contrôles, et l'outil recontrôle depuis Git. Les sceller si un incident le justifie. |
| Q9 | Une PR seule prouvée par sa suite d'impact se fusionne-t-elle toujours par le lot (lot d'une PR) ? | Oui : c'est la seule façon de garder la règle `preuve` intacte avec une seule suite complète par fusion. |
| Q10 | Ordre des phases : fin allégée (phases 1 et 2) avant le test d'abord (phases 3 à 5) ? | Oui : les gains de la fin financent le coût du début, et la mesure de la phase 0 rend l'équilibre vérifiable dès le départ. |
| Q11 | Mode d'isolation par défaut des piles Supabase : `prefix` ? | Oui : seul mode compatible avec l'API et l'authentification de Supabase, et il s'appuie sur une règle déjà exigée des tests. |
| Q12 | Combien de suites complètes simultanées par défaut ? | Une par pile (`per-stack`), soit deux sur le pilote ; plus seulement en mode `database` et sous `maxLoad`. |
| Q13 | Faut-il une troisième pile Docker ? | Non : l'isolation donne le même gain sans 2 à 3 Go de plus. À revoir si la mesure montre encore des attentes. |

## 25. Décisions de l'opérateur (2026-10-04)

Réponse de l'opérateur : « je suis tes recos a tes questions ».

- Q1 à Q12 : recommandations retenues telles qu'écrites dans la section 24.
- Q13 : une troisième pile Docker est ajoutée tout de suite, à titre provisoire, avec l'arrêt automatique après 20 minutes sans usage (`apv stacks idle-stop --watch`), en attendant l'isolation par worktree de la phase 0 bis. Elle sera retirée si la mesure montre que l'isolation suffit. Contrainte de l'opérateur : ne rien laisser tourner quand rien n'est en cours.
- Spec validée : les phases de la section 22 se livrent dans l'ordre, une PR par phase.
