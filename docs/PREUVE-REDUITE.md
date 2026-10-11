# Preuve réduite pour les fusions sur ordre signé

Statut : **proposition à valider**. Aucune ligne de code avant sa validation. Branche `feat/preuve-reduite-publication`, depuis `apv3` (3d68b97, après la PR #135).
Méthode du dépôt : spec d'abord, validée, puis phases de code en petites PR (section 12), chacune avec ses tests qui refusent et ses tests qui acceptent ([REGLES.md](REGLES.md), section 6).

Décision de l'opérateur (projet pilote, 11 octobre 2026) : « je suis ta reco », sur la recommandation d'une preuve réduite pour les PR de publication fusionnées sur ordre signé, au lieu de la suite complète.

## 1. Demande et constat

Projet pilote, publication d'un article sur ordre signé ([REGLES.md](REGLES.md), section 3 ter) :

- la PR de publication ne change que quatre fichiers servis, tous dans `rules.operatorOrders.paths.publication` (le texte du guide, le catalogue, le registre, le type des identifiants de guides) ; la PR d'article ne change que la proposition signée (`paths.article`) ;
- APV fait déjà régénérer ce contenu octet par octet depuis la proposition signée, par la commande du projet lancée depuis une copie propre de la base de confiance (`verify.publication`) ;
- la règle `preuve` exige pourtant la suite complète au commit exact, en local ou par `rules.ciProof` : le check run « Preuve complète » de `preuve.yml`, lancé en `workflow_dispatch`, prend 80 à 110 minutes sur GitHub Actions ;
- le dépôt est privé, en plan gratuit : 2000 minutes par mois, dont 1812 déjà consommées au 11 octobre, budget de dépassement à 0 $ (bloquant). Il reste 188 minutes, soit une seule preuve complète, et aucune si elle dépasse son temps habituel ;
- la routine de publication tourne dans le cloud, sans Docker ni piles Supabase locales : elle ne peut pas lancer la suite complète elle-même.

Coût actuel d'un article : une preuve complète par étape (publication, puis article), soit 160 à 220 minutes par article. Le budget restant ne couvre même pas un article entier.

Leçon générique : **quand le contenu d'une PR est une fonction déterministe, vérifiée par l'outil, d'une entrée signée, et que le générateur a déjà été prouvé en entier à la base, la suite complète reprouve le générateur à chaque instance.** Ce qui reste à prouver pour l'instance est plus petit : la forme du contenu produit, son rendu, sa compilation, ses tests rapides.

## 2. Objectif et limites

Objectif : permettre à un projet de déclarer, à sa base, une **preuve réduite** acceptée à la place de la suite complète, pour les seules fusions sur ordre signé dont le diff tient dans une liste fermée de chemins de contenu régénéré.

Hors du périmètre, et le resteront :

- **jamais pour une PR ordinaire** : `apv rules check` seul, `apv stack merge` sans `--order`, `apv stack batch` n'acceptent jamais la preuve réduite ;
- aucune autre règle ne change : `relecture` (sécurité comprise), `captures`, `controles` et `maquette` restent jugées comme aujourd'hui, et `instable` reste stricte ;
- aucune dérogation nouvelle : la preuve réduite n'est pas tapée par l'opérateur, elle se déclare dans `.apv/config.json` par une PR ordinaire, relue et prouvée en entier ;
- aucune promesse : la preuve réduite prouve moins que la suite complète, et ce document dit quoi (section 6).

## 3. Vocabulaire

| Terme | Sens |
|---|---|
| Suite complète | tous les contrôles de la configuration (`apv gates run --stage full`), prouvés au commit exact par des reçus locaux ou par `rules.ciProof` |
| Preuve CI | le check run du job que déclare `rules.ciProof`, accepté aux conditions de [REGLES.md](REGLES.md) (« Preuve par la CI ») |
| Preuve réduite | le check run du job que déclare `rules.operatorOrders.reducedProof`, accepté aux conditions de la section 5 |
| Voie réduite | le cas où la règle `preuve` accepte la preuve réduite ; « non retenue » sinon, avec la première raison |
| `T` | la base de confiance de la fusion sur ordre (REGLES.md, section 3 ter), fixée pour tout le lancement |
| `M` | la tête de la cible au moment de l'étape, sur laquelle APV fusionne |
| `H` | la tête vérifiée de la PR de l'étape (publication, ou commit signé de l'article) |
| `B` | la base commune de la PR de l'étape : `M` pour la publication (H descend de M), la base commune de `M` et de `H` pour l'article |

## 4. Déclaration : `rules.operatorOrders.reducedProof`

La déclaration vit **sous `rules.operatorOrders`**, pas sous `rules.ciProof` :

- elle n'a de sens que pour une fusion sur ordre, et sa place le dit ;
- elle entre ainsi dans l'empreinte de la base de confiance (`fingerprint` de `src/orders/merge.ts`) : si la cible bouge pendant le lancement et que sa déclaration diffère de celle de `T`, refus `config`, sans code de plus ;
- le chargeur peut vérifier en un seul endroit que ses chemins sont un sous-ensemble des chemins permis de l'étape.

Exemple générique (les valeurs du projet pilote sont à la section 10) :

```json
"rules": {
  "operatorOrders": {
    "paths": {
      "publication": ["content/guides/{slug}.ts", "content/catalog.ts"],
      "article": ["docs/articles/{slug}/proposition.json"]
    },
    "reducedProof": {
      "workflow": ".github/workflows/preuve-publication.yml",
      "job": "preuve-publication",
      "name": "Preuve de publication",
      "gates": ["check", "lint", "test", "build"],
      "waives": ["integration", "browser"],
      "covers": "typecheck, lint, tests unitaires (forme du contenu comprise), build, tests de bout en bout des pages de guides et du référencement contre un aperçu du commit, captures de la page du guide",
      "paths": {
        "publication": ["content/guides/{slug}.ts", "content/catalog.ts"],
        "article": ["docs/articles/{slug}/proposition.json"]
      },
      "protectedPaths": ["tests/e2e/guides/**", "tests/content-shape.test.ts"],
      "artifact": "apv-recus-publication"
    }
  }
}
```

| Champ | Obligatoire | Sens |
|---|---|---|
| `workflow` | oui | fichier du workflow réduit, sous `.github/workflows/` ; **différent** de `rules.ciProof.workflow` |
| `job` | oui | clé du job (`jobs.<job>`), comme `rules.ciProof.job` |
| `name` | oui | nom de son check run (`name:` du job) ; **différent** de `rules.ciProof.name` |
| `gates` | oui (1 au moins) | contrôles de la configuration que le job lance **en entier**, chacun avec la même commande : le check run en tient lieu de reçu, comme pour `rules.ciProof.gates` |
| `waives` | oui (1 au moins) | contrôles de la suite complète que la voie réduite **ne lance pas** ; non requis dans la voie, et seulement là |
| `covers` | oui | phrase lisible de ce que le job prouve en plus des contrôles de `gates` (tests ciblés, rendu, captures) ; recopiée dans la sortie de la règle, jamais interprétée |
| `paths.publication`, `paths.article` | au moins une étape | la liste fermée des chemins pour lesquels la preuve réduite suffit, à l'étape dite ; chaque motif est **exactement** un motif de `rules.operatorOrders.paths` de la même étape |
| `protectedPaths` | non | fichiers qui produisent la preuve réduite, ajoutés aux défauts de `CI_PROTECTED_DEFAULTS` (jamais moins) : tests ciblés, scripts propres au job |
| `artifact` | non | artefact des reçus du job, pour la mesure seulement, jamais lu par la règle |

Refusé par le chargeur (`operatorOrdersIssues`), configuration invalide :

- `gates` et `waives` qui se recoupent ; un identifiant absent des contrôles déclarés ;
- un contrôle de `waives` qu'APV exige (`reuse`, `code-map`, `structure`, et ceux de `rules.requiredGates`) : rapides et sans pile, ils ne se lèvent jamais ;
- `workflow` ou `name` égal à celui de `rules.ciProof` (une preuve ne doit jamais se lire pour l'autre) ;
- un motif de `paths.<étape>` qui n'est pas, caractère pour caractère, un motif de `rules.operatorOrders.paths.<étape>` ; un motif avec `**` ; une étape sans liste ;
- un motif de `protectedPaths` qui couvrirait un chemin de `paths` (un fichier de contenu ne peut pas être à la fois ce que la preuve teste et ce qui la produit).

`apv status` dit la déclaration sur la ligne « Ordres signés » : workflow, job, contrôles prouvés, contrôles levés, chemins par étape.

## 5. Conditions d'acceptation

La règle `preuve` accepte la preuve réduite **seulement si toutes** ces conditions tiennent ; à la première qui manque, la voie réduite n'est pas retenue, la sortie dit pourquoi, et la règle exige la suite complète comme aujourd'hui (reçus locaux ou `rules.ciProof`). Jamais de repli silencieux, jamais d'acceptation partielle.

### 5.1 Fusion sur ordre signé seulement

- `checkMergeRules` reçoit un contexte de voie réduite (`orderLane`) que **seul** `mergeOnOrder` construit, à chaque étape et à chaque nouvel essai après une cible qui a bougé : étape, `T`, `M`, `H`, slug signé, déclaration lue à `T`, et le fait que la vérification du projet (`verify.publication`) vient de réussir **pour ce `H` et ce `M`** dans ce même essai.
- Aucune option de ligne de commande ne le construit : `apv rules check`, `apv stack plan`, `apv stack merge` sans `--order` et `apv stack batch` ne l'ont jamais. Ils disent seulement, à titre d'information, « voie réduite possible sur ordre signé seulement » quand le diff tiendrait dans la liste.
- Le contexte n'est jamais lu dans l'environnement, un fichier ou un argument : c'est un objet passé en mémoire de `mergeOnOrder` à `orderRules`.

### 5.2 Déclaration lue à la base de confiance

- `reducedProof` est lu à `T`, jamais à `H`, à `M` ni à `B`. Une déclaration ajoutée ou élargie par la PR est ignorée, et la fusion sur ordre la refuse déjà (`.apv/` est sur la liste de refus fixe).
- Si `M` diffère de `T`, `rules.operatorOrders` doit y être identique (empreinte déjà vérifiée après une poussée refusée ; vérifiée aussi au premier essai de l'étape article, où `M` contient la fusion de publication).

### 5.3 Diff entièrement dans la liste, après régénération vérifiée

- Diff lu comme l'étape le lit déjà (`git diff --raw -z --no-renames`, de `B` à `H`) : **chaque** chemin changé, suppressions comprises, répond à un motif de `reducedProof.paths.<étape>` (avec `{slug}` remplacé par le slug signé) ; mode `100644` seulement.
- Un seul chemin hors de cette liste, même permis par `rules.operatorOrders.paths` : voie réduite non retenue, suite complète exigée.
- La vérification du projet a réussi dans le même essai, au même `H` et au même `M` : à la publication, les fichiers servis sont ceux que régénère, octet par octet, le générateur de `T` depuis la proposition signée ; à l'article, le blob de la proposition est celui que l'ordre signe.

### 5.4 Le check run : mêmes garanties que `rules.ciProof`

Le check run du job déclaré est lu comme `verifyCiProof` le lit aujourd'hui (même code, réglages construits depuis `reducedProof`) :

- application GitHub Actions (slug `github-actions` **et** identifiant 15368), au commit exact `H`, conclu en `success`, lu par l'API des check runs avec `gh` lui-même (jamais `APV_GH`) ;
- exécution du workflow déclaré (identifiant résolu en chemin), au même commit, `completed` et `success`, et le check run est un job de cette exécution, de ce nom ;
- évènement **`workflow_dispatch` seulement**, et le workflow de `T` ne déclare aucune entrée (`inputs`). Plus strict que `rules.ciProof`, qui admet aussi `push` : la routine lance la preuve à la main, et un workflow réduit déclenché à chaque poussée consommerait des minutes sans servir ;
- aucun check run du job en échec, annulé, `action_required` ou inachevé au même commit, même si un plus récent est vert ;
- `run_attempt` égal à 1 (règle `instable`).

Hors réseau, API illisible, origine hors de github.com : rien n'est accepté.

### 5.5 Workflow et fichiers exécutés protégés, identiques à la base

- Le blob du workflow réduit est **le même à `T`, à `B` et à `H`** (à `M` aussi quand `M` diffère de `T`). Plus strict que `rules.ciProof` (comparé à la seule base commune) : `T` est la seule base où l'outil lit la déclaration.
- Les chemins protégés (défauts de `CI_PROTECTED_DEFAULTS` et `reducedProof.protectedPaths`) sont inchangés de `B` à `H` ; la fermeture des fichiers que le workflow et les scripts de la base nomment ou importent (`laneProblems`, calculée à `B`) aussi, **à une exception près** (5.6). Comme le diff est déjà réduit aux chemins de contenu, ce point revient à vérifier qu'aucun de ces chemins n'est un fichier qui produit la preuve.
- Un import non suivi, une configuration d'alias illisible, une fermeture incomplète : voie réduite non retenue.

### 5.6 Contenu régénéré : seule exception à la fermeture

Le contenu de la PR est, par construction, ce que la preuve teste : un script du job peut l'importer (le catalogue, lu par la vérification des liens ou l'export des guides). `rules.ciProof` refuserait alors la voie (« fichier exécuté par la preuve, modifié depuis la base »).

Dans la voie réduite, un fichier changé atteint par la fermeture est accepté **seulement** s'il répond à `reducedProof.paths.<étape>` **et** si la vérification du projet du même essai l'a régénéré octet par octet (5.3). La sortie le nomme : « contenu régénéré, exécuté par la preuve réduite : <chemin> ». Tout autre fichier de la fermeture reste protégé.

### 5.7 Contrôles requis dans la voie

- `waives` : non requis, dits « levés par la voie réduite (fusion sur ordre) » avec `covers`.
- `gates` : reçu local propre d'abord ; sinon, la preuve réduite en tient lieu (5.4 à 5.6), sauf un contrôle à `repeatChanged` dont des fichiers de test changent (impossible dans la voie, les tests n'étant pas dans `paths`, mais la règle de `verifyCiProof` reste).
- Tout autre contrôle de la suite complète : exigé comme aujourd'hui, par reçu local ou par `rules.ciProof`. La routine de publication les lance elle-même quand elle le peut (contrôles sans pile), ou le projet les met dans `gates`.

### 5.8 Sortie et trace

- `apv rules check` (appelé par `mergeOnOrder`) : « preuve : ok, voie réduite sur ordre <référence>, étape <étape> : N contrôle(s) prouvé(s) (x par reçus locaux, y par le check run « <name> » <id>, exécution <run> (workflow_dispatch)) ; levés : <waives> ; couvert : <covers> ».
- Rapport de `apv stack merge --order` (texte et JSON) : champ `proof` par étape, `full` ou `reduced`, avec le check run.
- Trace de fusion signée (`onMerged`) : la même mention, pour que `apv audit merges` puisse la montrer.

## 6. Ce que la suite complète prouvait, et que la preuve réduite ne prouve pas

| Élément | Suite complète | Preuve réduite | Pourquoi c'est acceptable, ou ce qu'on garde |
|---|---|---|---|
| Générateur du contenu (gabarit, échappement, forme) | tests unitaires et d'injection, à chaque PR | tests unitaires lancés **en entier** (`gates`) | Le générateur est le code de `T`, déjà fusionné sous la suite complète. Ses tests (injection d'une proposition, texte jamais dans du code généré) tournent encore dans le job réduit, sur le contenu de l'instance. |
| Forme exacte des fichiers servis (#231 du pilote) | tests unitaires | tests unitaires | **À garder dans le job** : c'est le garde qui dit qu'un fichier de contenu ne contient que des données littérales, aucun appel, import ni expression. Le projet le protège (`protectedPaths`). |
| Régénération octet par octet | `verify.publication` | `verify.publication` | Inchangé, avant toute règle. C'est ce qui rend la voie réduite possible. |
| Liste fermée des chemins, modes, liste de refus | outil | outil, plus la sous-liste `reducedProof.paths` | Inchangé, plus strict. |
| Typecheck, lint, build | reçus ou CI | job réduit | Inchangé : un catalogue ou un type d'identifiant mal formé casse le typecheck ou le build. |
| Rendu de la page du guide (textes, titres, contrastes, débordement, CSP) | suite navigateur entière | tests de bout en bout des guides contre un aperçu du **build du commit** | Gardé pour les pages que le contenu touche : page du guide, liste des guides, pages qui lisent le catalogue. Les autres écrans ne lisent pas ces fichiers. |
| Référencement (plan du site, balises, données structurées) | suite navigateur | tests du référencement | Gardé. |
| Captures (390 et 1280 px, clair et sombre) | étape « captures » de la preuve complète | **à garder dans le job réduit** pour la page du guide | La règle `captures` ne change pas : la relecture de fidélité les exige toujours. |
| Suite d'intégration (base, RLS, fonctions serveur) | oui | **non** (`waives`) | Le diff ne touche ni migration, ni requête, ni code serveur autre que des données littérales dont la forme est vérifiée ; la liste de refus fixe écarte la configuration. |
| Autres écrans (compte, administration, parcours) | suite navigateur entière | **non** | Aucun ne lit les fichiers de la liste (à vérifier par le projet : section 10.4). |
| Scan dynamique ZAP | oui | **non** | En-têtes et CSP viennent de fichiers sur la liste de refus (`hooks.server.*`, `svelte.config.*`, `vercel.json`) : inchangés. Le test de bout en bout du guide vérifie l'absence d'erreur CSP. |
| Liens des sources | étape de la routine | étape de la routine | **Hors du job, recommandé** (question Q3) : un site tiers lent rendrait le check run rouge, et un échec au commit exact bloque ce commit pour toujours. |

Risque restant, dit franchement : un comportement propre à ce contenu, hors des pages de guides, que seule la suite entière aurait vu (par exemple un compteur de guides affiché sur un écran que le projet a oublié dans sa liste). Le filet est la liste des pages qui lisent le catalogue, tenue par un test du projet (section 10.4), et la relecture sécurité de `H`, toujours exigée.

## 7. Menaces et parades

| # | Menace | Parade | Test négatif |
|---|---|---|---|
| M1 | Faire passer du code par la voie réduite (un `.ts` de contenu qui appelle, importe ou exécute) | Liste fermée sous-ensemble des chemins permis ; liste de refus fixe ; mode 100644 ; régénération octet par octet par le générateur de `T` depuis la proposition signée (un octet de plus : refus `verify`, avant la règle) ; test de forme dans le job ; relecture sécurité de `H` | diff identique à la régénération plus une ligne : refus `verify` ; contenu régénéré mais test de forme rouge : check run en échec, refus `preuve` |
| M2 | Workflow réduit modifié par la PR, ou différent entre `T`, `B` et `H` | Blob comparé à `T`, `B`, `H` (et `M`) ; `.github/` sur la liste de refus de l'ordre | workflow changé à `H` ; workflow changé sur la cible entre `T` et `M` ; workflow absent de la branche d'article |
| M3 | Déclaration ajoutée ou élargie dans la PR elle-même | Lue à `T` seulement ; `.apv/` refusé par l'ordre ; empreinte de `T` | `reducedProof` présent à `H` et absent à `T` : suite complète exigée ; `paths` élargi à `H` : ignoré |
| M4 | PR qui sort de la liste (un fichier de plus, même permis par `operatorOrders.paths`) | Chaque chemin du diff dans `reducedProof.paths` | un fichier permis mais hors de la sous-liste : voie non retenue, suite complète exigée |
| M5 | Fichiers exécutés par le job réduit modifiables (scripts, tests ciblés, configuration de Playwright, `package.json`) | Défauts de `CI_PROTECTED_DEFAULTS`, `protectedPaths`, fermeture calculée à `B` ; exception limitée au contenu régénéré | script nommé par le workflow changé ; test ciblé changé ; fichier qui masque un fichier exécuté (`x.js` à côté de `x.ts`) |
| M6 | Preuve réduite utilisée pour une PR ordinaire | Contexte construit seulement par `mergeOnOrder` | `apv rules check`, `apv stack merge` sans `--order`, `apv stack batch` avec un check run réduit vert : suite complète exigée |
| M7 | Check run d'un autre commit, d'une autre application, d'un autre workflow du même nom | Conditions de `verifyCiProof` | statut posé par un jeton ; check run d'une application homonyme ; job « Preuve de publication » d'un autre workflow |
| M8 | Évènement qui teste un autre commit | `workflow_dispatch` sans entrée seulement | exécution `push` ou `pull_request` ; workflow de `T` avec `inputs` |
| M9 | Vert après un rouge (relance, nouvelle exécution) | Un échec ou une annulation au commit bloque ; `run_attempt` 1 | échec puis succès au même commit ; succès en tentative 2 |
| M10 | Vérification du projet d'un autre essai (cible qui a bougé entre la vérification et la règle) | Contexte lié à `H` et `M` de l'essai, refait à chaque essai | `M` changé sans nouvelle vérification : voie non retenue |
| M11 | Déclaration qui lève trop (`waives` couvrant `reuse`, `structure`) | Chargeur | `waives` avec un contrôle exigé par APV : configuration invalide |
| M12 | Confusion entre preuve complète et réduite | `workflow` et `name` distincts imposés | même nom que `rules.ciProof` : configuration invalide |

Limites acceptées, comme pour `rules.ciProof` : le code que la suite exécute (ici le contenu régénéré) pourrait fausser un job inchangé ; la régénération et le test de forme le réduisent à des données littérales. La protection de branche absente d'un dépôt privé gratuit (REGLES.md, section 3 bis) n'est pas compensée ici.

## 8. Tests de l'outil

Négatifs (chacun refuse la voie réduite, la suite complète reste exigée, ou la configuration est invalide) : M1 à M12 ci-dessus, plus :

- vérification du projet en échec ou non lancée dans l'essai ;
- slug illisible pour `{slug}` ;
- diff avec une suppression, un renommage, un lien symbolique ou un exécutable ;
- contrôle hors de `gates` et de `waives` sans reçu local : refus qui le nomme ;
- check run en cours, annulé par un groupe de concurrence, `action_required` ;
- API indisponible ou hors réseau ;
- motif de `reducedProof.paths` qui n'est pas un motif de `operatorOrders.paths`, motif `**`, `protectedPaths` qui couvre un chemin de contenu ;
- `rules.operatorOrders` différent entre `T` et `M` à l'étape article.

Positifs :

- étape publication : diff des quatre sortes de fichiers, régénération vérifiée, check run réduit vert, contrôles hors `gates` et `waives` prouvés en local : `preuve` ok, sortie complète (5.8) ;
- étape article : seule la proposition, check run réduit vert au commit signé ;
- contenu importé par un script du job (5.6) : accepté et nommé ;
- reçus locaux propres pour certains contrôles de `gates` : ils passent d'abord ;
- projet sans `reducedProof` : comportement identique à aujourd'hui (suite de tests existante verte).

## 9. Changements de l'outil (description, pas de code)

| Fichier | Changement |
|---|---|
| `src/orders/config.ts` | `reducedProof` dans `operatorOrdersSchema` ; contrôles du chargeur (section 4) dans `operatorOrdersIssues`, avec la configuration des contrôles pour `gates` et `waives` ; ligne de `apv status` |
| `src/rules/ci-proof.ts` | `verifyCiProof` paramétrée par la liste des évènements admis et par une liste de fichiers de contenu exemptés de la fermeture (vide par défaut : `rules.ciProof` inchangée) ; comparaison du blob du workflow à plusieurs commits |
| `src/rules/check.ts` | `RulesInput.orderLane` (facultatif) ; dans la voie, contrôles requis moins `waives`, puis reçus locaux, preuve réduite, `rules.ciProof` ; sortie de la section 5.8 ; ligne d'information hors de la voie |
| `src/commands/stack-order.ts` | `orderRules` passe le contexte reçu de `mergeOnOrder` |
| `src/orders/merge.ts` | construit le contexte après la vérification du projet, à chaque essai ; champ `proof` du rapport et de la trace |
| `docs/REGLES.md`, `docs/CONFIGURATION.md`, `docs/CLI.md`, `CHANGELOG.md` | règle, champ, sortie, évolution |

## 10. Travail côté projet (PR du projet, après celle d'APV)

Décrit ici, livré par une PR du projet pilote une fois la version d'APV publiée et le plugin mis à jour.

### 10.1 Workflow `preuve-publication.yml`

- `on: workflow_dispatch` seul, sans entrée ; `permissions: contents: read` ; aucun secret ; actions épinglées par commit, les mêmes que `preuve.yml` ; groupe de concurrence propre (`preuve-publication-${{ github.event_name }}-${{ github.ref_name }}`), qui n'annule jamais `preuve.yml`.
- Un job `preuve-publication`, nom « Preuve de publication », `timeout-minutes: 20`, chaque étape avec sa limite.
- Étapes : installation (`npm ci`) ; typecheck (`npm run check`) ; lint (`npm run lint`) ; tests unitaires (`npm run test`, dont la forme exacte du contenu et l'injection) ; build ; contrôles sans pile de la suite (code mort, bonnes pratiques Svelte, `diff-check`) ; Chromium de Playwright ; tests de bout en bout des guides et du référencement (`guides.e2e.ts`, `referencement.e2e.ts`) contre un aperçu du build du commit servi dans le job ; captures de la page du guide (390 et 1280 px, clair et sombre) ; reçus en artefact.
- **Aucun service distant** : l'aperçu est celui du job, jamais un déploiement Vercel (un déploiement d'aperçu n'est pas lié au commit par l'outil, et chaque poussée en crée un sur l'offre Hobby).
- Vérification des liens : **hors du job**, à l'étape 5 de la routine comme aujourd'hui (question Q3).

### 10.2 Temps cible : moins de 15 minutes

Repères à mesurer à l'essai à blanc, pas une promesse :

| Étape | Estimation |
|---|---|
| Récupération, Node, cache npm, `npm ci` | 2 à 3 min |
| Typecheck, lint, contrôles sans pile | 3 à 4 min |
| Tests unitaires | 2 à 3 min |
| Build | 1 à 2 min |
| Chromium, aperçu, tests des guides et du référencement, captures | 3 à 5 min |
| Total | 11 à 17 min |

Si l'essai dépasse 15 minutes : sortir du job ce que la routine peut prouver en local (lint, contrôles sans pile), ou limiter les tests de bout en bout au guide du slug. Pour deux étapes par article (publication et article), environ 30 minutes au lieu de 160 à 220 : les 188 minutes restantes couvrent environ six articles ce mois-ci.

### 10.3 Déclaration

Sous `rules.operatorOrders` de `.apv/config.json` : `reducedProof` avec `workflow` `.github/workflows/preuve-publication.yml`, `job` `preuve-publication`, `name` « Preuve de publication » ; `gates` : les contrôles que le job lance en entier (`check`, `lint`, `test`, `build`, `articles-build`, `dead-code`, `svelte`, `diff-check`, selon la mesure) ; `waives` : `integration`, `browser` ; `paths` : les quatre motifs de `paths.publication` et celui de `paths.article`, recopiés ; `protectedPaths` : les tests ciblés (`tests/e2e/browser/guides.e2e.ts`, `tests/e2e/browser/referencement.e2e.ts`, `tests/articles-content-shape.test.ts`, `tests/support/content-shape.ts`) et les scripts propres au job.

Les contrôles `reuse`, `code-map`, `structure` et `tests` (outil `apv`) restent hors du job : la routine les lance en local, sans pile (question Q4).

### 10.4 Tests du projet

- `tests/ci-workflow.test.ts` étendu : le workflow réduit n'a que `workflow_dispatch`, aucune entrée, aucun secret ; il lance les tests de forme du contenu et les tests des guides ; ses actions sont épinglées.
- Un test qui liste les fichiers qui importent le catalogue, le registre ou le type des guides, et vérifie que chaque route concernée a son test de bout en bout dans le job réduit : une page qui lit le catalogue sans test dans le job fait échouer la suite complète, donc la PR qui l'ajoute.

### 10.5 Procédure de publication

`docs/redaction/publication-automatique.md`, étape 6 : `gh workflow run preuve-publication.yml --ref publication/<slug>` puis, pour l'étape article, sur la branche de l'article ; une attente par check run (15 minutes environ) ; la preuve complète `preuve.yml` reste la voie de repli quand APV dit la voie réduite non retenue. Règles d'autorisation de la routine : ajouter `gh workflow run preuve-publication.yml`.

Limite à dire dans la procédure : `workflow_dispatch` lance le workflow tel qu'il est **sur la branche** ; une PR d'article ouverte avant l'arrivée du workflow sur `main` ne l'a pas, et son commit signé ne peut plus bouger. Pour ces articles, la preuve complète reste exigée à l'étape article, ou une nouvelle décision après mise à jour de la branche.

## 11. Option de secours : runner auto-hébergé sur le poste de l'opérateur

Le check run « Preuve complète » peut tourner sur un runner auto-hébergé (`runs-on: [self-hosted, apv-preuve]`) installé sur le poste de l'opérateur. APV n'a rien à changer : le check run vient toujours de l'application GitHub Actions, et `rules.ciProof` l'accepte aux mêmes conditions.

Limites :

- **poste allumé** et Docker démarré pendant la preuve ; une exécution en attente d'un runner hors ligne échoue après 24 heures ;
- **sécurité** : tout compte qui peut pousser une branche (agents compris) peut faire exécuter du code sur le poste par un workflow ; Docker rend le compte du runner équivalent à l'administrateur de la machine, donc capable de lire la clé d'ancrage. À ne faire que dans une machine virtuelle ou une distribution WSL séparée, sous un compte dédié sans accès au dossier de l'opérateur, en runner éphémère (`--ephemeral`), réservé aux évènements `workflow_dispatch` ;
- **coût** : les minutes d'un runner auto-hébergé ne comptent pas dans les 2000 minutes aujourd'hui ; GitHub a annoncé fin 2025 une redevance par minute pour ces runners sur les dépôts privés, puis l'a repoussée. À vérifier sur la page de facturation avant d'en dépendre ;
- **confiance** : APV ne distingue pas un runner hébergé d'un runner auto-hébergé. Un runner sur le compte où travaillent les agents serait une preuve écrite par ceux qu'elle juge (REGLES.md, section 3 bis).

Recommandation : garder cette option pour une preuve complète rare (changement du générateur, PR de configuration), pas pour chaque article.

## 12. Phases de livraison

| Phase | Contenu | Acceptée quand |
|---|---|---|
| 1. Déclaration | schéma, chargeur, ligne de `apv status`, CONFIGURATION.md | chaque refus du chargeur (section 4) a son test ; un projet sans `reducedProof` ne voit aucun changement |
| 2. Règle | `verifyCiProof` paramétrée, `orderLane` dans `checkMergeRules`, sortie | M2 à M12 refusés, cas positifs acceptés, `rules.ciProof` inchangée (tests existants verts) |
| 3. Fusion sur ordre | contexte construit par `mergeOnOrder`, rapport et trace, REGLES.md section 3 ter, CHANGELOG | essai complet en dépôt de test : publication et article fusionnés avec la preuve réduite ; mêmes cas avec un fichier hors liste : suite complète exigée |
| 4. Projet pilote | PR du projet (section 10) | essai à blanc de la routine avec un article fictif ; temps mesuré du job ; un article réel publié par la voie réduite |

Les phases 1 à 3 peuvent tenir dans une seule PR d'APV si la relecture sécurité le permet ; sinon une PR par phase.

## 13. Critères d'acceptation

- **AC-RP-DECL** : `reducedProof` invalide dans chacun des cas de la section 4 fait refuser la configuration, avec le champ et la raison.
- **AC-RP-ORDER-ONLY** : avec un check run réduit vert au commit, `apv rules check`, `apv stack merge` sans `--order` et `apv stack batch` exigent la suite complète.
- **AC-RP-BASE** : une déclaration présente à `H` et absente de `T` n'a aucun effet ; une déclaration différente entre `T` et `M` refuse l'ordre (`config`).
- **AC-RP-PATHS** : un seul fichier hors de `reducedProof.paths`, même permis par `operatorOrders.paths`, fait exiger la suite complète, avec ce fichier dans la sortie.
- **AC-RP-VERIFY** : sans vérification réussie du projet dans le même essai, la voie n'est pas retenue.
- **AC-RP-CHECKRUN** : chaque condition de la section 5.4 a son test négatif ; seul `workflow_dispatch` sans entrée est admis.
- **AC-RP-PROTECTED** : un fichier protégé, ou de la fermeture hors contenu régénéré, changé de `B` à `H`, et un workflow différent entre `T`, `B` et `H`, font sortir de la voie.
- **AC-RP-GATES** : un contrôle hors de `gates` et de `waives` sans reçu local fait refuser `preuve` en le nommant.
- **AC-RP-NO-WEAKER** : sans `reducedProof`, ou hors d'une fusion sur ordre, aucune règle ne change (suite de tests existante verte).

Scénarios de la personne cible (routine de publication, chef de projet, opérateur) :

- **AC-USER-1** : Étant donné un ordre signé et une PR de publication régénérée à l'identique, quand la routine lance la preuve réduite puis `apv stack merge --order`, alors la publication et l'article sont fusionnés avec moins de 40 minutes de GitHub Actions, et la sortie dit « voie réduite » avec les contrôles levés.
- **AC-USER-2** : Étant donné une PR de publication qui change aussi une feuille de style, quand la routine lance `apv stack merge --order`, alors APV refuse avant toute fusion, nomme la feuille, et la note d'arrêt dit que la suite complète est exigée.
- **AC-USER-3** : Étant donné un agent qui modifie le workflow réduit dans une PR ordinaire, quand cette PR est relue et fusionnée sous les règles normales, alors les ordres en cours dont la base de confiance précède ce changement voient leur voie réduite refusée (« workflow différent à la base de confiance »).
- **AC-USER-4** : Étant donné une preuve réduite rouge parce que le texte du guide déborde sur téléphone, quand l'opérateur demande des changements dans l'admin, alors la nouvelle PR de publication a un nouveau commit et se prouve de nouveau, sans rien débloquer à la main.

## 14. Questions ouvertes pour le chef de projet

| # | Question | Recommandation |
|---|---|---|
| Q1 | Nom et place de la déclaration : `rules.operatorOrders.reducedProof`, ou `rules.ciProof.reduced` ? | `operatorOrders.reducedProof` : voie réservée à l'ordre, empreinte de `T` sans code de plus, sous-liste vérifiée au même endroit. |
| Q2 | Admettre aussi l'évènement `push` sur la branche de publication, comme `rules.ciProof` ? | Non : `workflow_dispatch` seul, la routine lance la preuve et aucune minute ne part à chaque poussée. |
| Q3 | Vérification des liens dans le job réduit, ou à l'étape 5 de la routine ? | Routine : un site tiers en panne rendrait le commit improuvable pour toujours (un échec au commit n'est jamais masqué). |
| Q4 | Les contrôles de l'outil `apv` (`reuse`, `code-map`, `structure`, `tests`) : en local dans la routine, ou installés dans le job ? | En local : rapides, sans pile, et la routine a déjà `apv`. |
| Q5 | L'étape article mérite-t-elle une preuve réduite à part, ou une dispense propre (la proposition n'est jamais servie) ? | Preuve réduite au début, mesurée ; une dispense demanderait une autre spec et un autre raisonnement de sécurité. |
| Q6 | Les PR d'article déjà ouvertes, sans le workflow réduit sur leur branche ? | Preuve complète pour elles, ou nouvelle décision de l'opérateur après mise à jour de la branche. Les dire dans REPRISE.md. |
| Q7 | Les pages du guide se rendent-elles sans pile Supabase dans le job (variables publiques factices) ? | À vérifier par le projet avant la PR ; sinon démarrer une pile minimale (environ 3 minutes), toujours sous 15 minutes au total. |
| Q8 | Une marque dans le message du commit de fusion (`Apv-Proof: reduced`) pour l'audit ? | Pas dans cette version : le message est comparé à l'identique pour la consommation de l'ordre. La trace signée et le rapport suffisent ; à revoir avec le rapprochement des pieds `Apv-Order` dans `apv audit merges`. |
| Q9 | Runner auto-hébergé (section 11) : à préparer maintenant ? | Non : seulement si la preuve réduite ne suffit pas, et dans une machine virtuelle dédiée. |
