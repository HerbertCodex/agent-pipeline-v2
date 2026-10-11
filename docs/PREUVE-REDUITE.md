# Preuve réduite pour les fusions sur ordre signé

Statut : **proposition corrigée après la relecture sécurité, section 14 tranchée par le chef de projet** (toutes les recommandations suivies). Branche `feat/preuve-reduite-publication`, depuis `apv3` (3d68b97, après la PR #135).
Méthode du dépôt : spec d'abord, validée, puis phases de code (section 12), chacune avec ses tests qui refusent et ses tests qui acceptent ([REGLES.md](REGLES.md), section 6).

Décision de l'opérateur (projet pilote, 11 octobre 2026) : « je suis ta reco », sur la recommandation d'une preuve réduite pour les PR de publication fusionnées sur ordre signé, au lieu de la suite complète.

Relecture sécurité indépendante de la spec (Opus, commit d385f99) : 2 constats élevés (E1, E2), 4 moyens (M1 à M4), 6 faibles (F1 à F6), 3 informations (I1 à I3). Tous sont intégrés ci-dessous ; la section 15 dit où.

## 1. Demande et constat

Projet pilote, publication d'un article sur ordre signé ([REGLES.md](REGLES.md), section 3 ter) :

- la PR de publication ne change que quatre fichiers servis, tous dans `rules.operatorOrders.paths.publication` (le texte du guide, le catalogue, le registre, le type des identifiants de guides) ; la PR d'article ne change que la proposition signée (`paths.article`) ;
- APV fait déjà vérifier ce contenu par la commande du projet lancée depuis une copie propre de la base de confiance (`verify.publication`) ; jusqu'ici, l'outil ne voyait que son code de sortie (relecture, E2) ;
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
- **la déclaration retire des contrôles : c'est la seule de la section `rules` qui le fasse** ([REGLES.md](REGLES.md), section 5). Elle se déclare dans `.apv/config.json` par une PR ordinaire, relue et prouvée en entier, et **tout ajout ou élargissement exige une décision de l'opérateur ancrée**, que `apv rules check` vérifie sur cette PR (section 4.3, constat E1) ;
- aucune promesse : la preuve réduite prouve moins que la suite complète, et ce document dit quoi (section 6).

## 3. Vocabulaire

| Terme | Sens |
|---|---|
| Suite complète | tous les contrôles de la configuration (`apv gates run --stage full`), prouvés au commit exact par des reçus locaux ou par `rules.ciProof` |
| Preuve CI | le check run du job que déclare `rules.ciProof`, accepté aux conditions de [REGLES.md](REGLES.md) (« Preuve par la CI ») |
| Preuve réduite | le check run du job que déclare `rules.operatorOrders.reducedProof`, accepté aux conditions de la section 5 |
| Voie réduite | le cas où la règle `preuve` accepte la preuve réduite ; « non retenue » sinon, avec les raisons |
| `T` | la base de confiance de la fusion sur ordre (REGLES.md, section 3 ter), fixée pour tout le lancement |
| `M` | la tête de la cible au moment de l'étape, sur laquelle APV fusionne |
| `H` | la tête vérifiée de la PR de l'étape (publication, ou commit signé de l'article) |
| `B` | la base commune de la PR de l'étape : `M` pour la publication (H descend de M), la base commune de `M` et de `H` pour l'article |

## 4. Déclaration : `rules.operatorOrders.reducedProof`

La déclaration vit **sous `rules.operatorOrders`**, pas sous `rules.ciProof` (Q1) :

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
| `paths.publication`, `paths.article` | au moins une étape | la liste fermée des chemins pour lesquels la preuve réduite suffit, à l'étape dite ; chaque motif est **exactement** un motif de `rules.operatorOrders.paths` de la même étape, sans `*`, `?` ni `**` (chemins littéraux, `{slug}` seul remplacé) |
| `protectedPaths` | non | fichiers qui produisent la preuve réduite, ajoutés aux défauts de `CI_PROTECTED_DEFAULTS` (jamais moins) : tests ciblés, scripts propres au job |
| `artifact` | non | artefact des reçus du job, pour la mesure seulement, jamais lu par la règle |

### 4.1 Refusé par le chargeur (configuration invalide)

- `gates` et `waives` qui se recoupent ; un identifiant de `gates` ou de `waives` absent des contrôles déclarés (`gates` de la configuration) ;
- un contrôle de `waives` qu'APV exige, **reconnu par sa commande** comme la règle `controles` le fait (`runsCommand` de `src/rules/required.ts`, constat F1) : un contrôle dont la commande lance `apv reuse check`, `apv map --check`, `apv structure check` ou la commande d'un contrôle de `rules.requiredGates`, quel que soit son identifiant ; et tout identifiant `reuse`, `code-map`, `structure` ou de `rules.requiredGates`. Rapides et sans pile, ils ne se lèvent jamais ;
- `workflow` ou `name` égal à celui de `rules.ciProof` (une preuve ne doit jamais se lire pour l'autre) ;
- `rules.operatorOrders.paths` absent ; une étape de `reducedProof.paths` dont un motif n'est pas, caractère pour caractère, un motif de `rules.operatorOrders.paths` de la même étape ; un motif avec `*`, `?` ou `**` (constat F3 : chemins littéraux, seul `{slug}` est remplacé) ; aucune étape, ou une étape sans motif ;
- un motif de `protectedPaths` qui couvrirait un chemin de `paths` (un fichier de contenu ne peut pas être à la fois ce que la preuve teste et ce qui la produit).

### 4.2 `apv status`

`apv status` dit la déclaration sur la ligne « Ordres signés » : workflow, job, nom du check run, contrôles prouvés, contrôles levés, chemins par étape. Sans `reducedProof`, la ligne est celle d'aujourd'hui.

### 4.3 Ajout ou élargissement : décision de l'opérateur ancrée (constat E1)

`waives` retire des contrôles de la règle `preuve`, et `.apv/config.json` s'écrit par une PR qu'un agent prépare. La règle générique de [REGLES.md](REGLES.md) (section 3) s'applique : la validation humaine qui permet de retirer un contrôle est ancrée hors de portée de l'agent.

`apv rules check` (et donc `apv stack merge`, `apv stack batch --merge`, qui l'appellent) compare `rules.operatorOrders.reducedProof` de la base commune et de la tête de la PR. La déclaration est **élargie** quand, à la tête :

- elle apparaît (absente de la base) ;
- `workflow`, `job` ou `name` change ;
- `gates`, `waives`, ou un motif de `paths.<étape>` s'ajoute (une étape ajoutée comprise) ;
- un motif de `protectedPaths` disparaît.

Retirer la déclaration, retirer un contrôle de `gates` ou de `waives`, un motif de `paths`, ajouter un motif à `protectedPaths` ou changer `covers` ou `artifact` ne l'élargit pas.

Élargie, la règle `preuve` est refusée (« déclaration de preuve réduite élargie sans décision de l'opérateur ancrée ») tant que la tête ne porte pas, dans `.apv/DECISIONS.json`, **une décision absente de la base**, de source `operator`, au statut `confirmed`, dont la citation (`sourceQuote`) :

- figure mot pour mot dans les messages que l'opérateur a tapés (journal signé par la clé d'ancrage, `anchoredQuote` de `src/rules/operator.ts`, comme une maquette validée) ;
- contient l'**empreinte de la déclaration de la tête** : les 12 premiers caractères de l'empreinte SHA-256 de `reducedProof` sous sa forme canonique, que le refus affiche. La décision vaut donc pour cette déclaration-là, jamais pour une déclaration élargie plus tard avec une ancienne phrase.

Le refus dit la phrase à faire taper par l'opérateur (« Je valide la preuve réduite <empreinte> pour les fusions sur ordre. ») et la décision à verser. Sans décision, la seule autre voie est la dérogation tapée par l'opérateur sur la règle `preuve` de ce commit (`dérogation preuve <commit> : <raison>`), qui lève toute la règle pour ce commit : elle reste possible, la décision ancrée est la voie normale. Une décision écrite par un agent seul, une citation absente du journal, ou une citation sans l'empreinte ne comptent pas. Ce contrôle tient même quand la règle `preuve` est jugée sur un lot (`apv stack batch`) : il ne dépend pas des reçus.

## 5. Conditions d'acceptation

La règle `preuve` accepte la preuve réduite **seulement si toutes** ces conditions tiennent ; si une manque, la voie réduite n'est pas retenue, la sortie dit pourquoi, et la règle exige la suite complète comme aujourd'hui (reçus locaux ou `rules.ciProof`). Jamais de repli silencieux, jamais d'acceptation partielle.

### 5.1 Fusion sur ordre signé seulement

- `checkMergeRules` reçoit un contexte de voie réduite (`orderLane`) que **seul** `mergeOnOrder` construit, à chaque étape et à chaque nouvel essai après une cible qui a bougé. Il porte : la référence de l'ordre, l'étape, `T`, `M`, `H`, le slug signé, la déclaration lue à `T`, `rules.ciProof` lue à `T`, le fait que la configuration de `M` a la même empreinte que celle de `T`, et le résultat de la vérification du projet (`verify.publication`) de **ce même essai**, avec le `H` et le `M` pour lesquels elle a tourné.
- `checkMergeRules` n'accepte le contexte que pour le commit et la cible qu'il porte (constat F4) : `commit` différent de `H`, ou cible différente de `M` : voie non retenue (« contexte de voie réduite d'un autre commit ou d'une autre cible »). Une vérification du projet faite pour un autre `H` ou un autre `M` (cible qui a bougé, menace M10) : voie non retenue.
- Aucune option de ligne de commande ne le construit : `apv rules check`, `apv stack plan`, `apv stack merge` sans `--order` et `apv stack batch` ne l'ont jamais. Quand la base déclare `reducedProof` et que la règle `preuve` refuse, ils ajoutent seulement, à titre d'information, « voie réduite possible sur ordre signé seulement (apv stack merge --order) » si le diff tiendrait dans la liste (`{slug}` lu comme un seul segment).
- Le contexte n'est jamais lu dans l'environnement, un fichier ou un argument : c'est un objet passé en mémoire de `mergeOnOrder` à `orderRules`, puis à `checkMergeRules`.

### 5.2 Déclaration lue à la base de confiance

- `reducedProof` est lu à `T`, jamais à `H`, à `M` ni à `B`. Une déclaration ajoutée ou élargie par la PR est ignorée, et la fusion sur ordre la refuse déjà (`.apv/` est sur la liste de refus fixe).
- Si `M` diffère de `T`, sa configuration doit avoir la même empreinte (`fingerprint` : `rules.operatorOrders`, `rules.ciProof`, `batch.setup`, variables). Après une poussée refusée, une empreinte différente refuse l'ordre (`config`, comme aujourd'hui) ; au premier essai d'une étape (étape article reprise plus tard, cible qui a avancé), une empreinte différente rend la voie non retenue : la suite complète est exigée.

### 5.3 Diff entièrement dans la liste, après régénération vérifiée

- Diff lu comme l'étape le lit déjà (`git diff --raw -z --no-renames --no-abbrev`, de `B` à `H`) : **chaque** chemin changé répond à un motif de `reducedProof.paths.<étape>` (avec `{slug}` remplacé par le slug signé), **ajouté ou modifié seulement** (constat F2 : une suppression, un renommage, qui se lit comme une suppression, un changement de type font sortir de la voie), en mode `100644` seulement.
- Un seul chemin hors de cette liste, même permis par `rules.operatorOrders.paths` : voie réduite non retenue, suite complète exigée, le chemin nommé.
- La vérification du projet a réussi dans le même essai, au même `H` et au même `M`.
- **Étape publication, régénération observable par l'outil (constat E2).** En cas de succès, la dernière ligne de la sortie de la commande du projet est un objet JSON :

  ```json
  {"ok": true, "regenerated": [{"path": "content/catalog.ts", "blob": "<identifiant du blob>"}], "shape": "literal"}
  ```

  `regenerated` : chaque fichier que le générateur de `T` a régénéré depuis la proposition signée, avec l'identifiant Git du blob produit (`git hash-object`, 40 ou 64 caractères hexadécimaux). **Chaque chemin du diff de l'étape doit y figurer avec le blob qu'il a à `H`** ; sinon la voie n'est pas retenue (« contenu non régénéré par la commande du projet : <chemin> »). Une ligne absente ou illisible, un chemin en double, plus de 200 entrées : voie non retenue. La commande du projet garde sa liberté : sans cette ligne, la fusion sur ordre fonctionne comme aujourd'hui, avec la suite complète.
- **Étape publication, forme vérifiée sans exécuter `H` (constat M4).** `shape` vaut `"literal"` : la commande du projet, lancée depuis `T`, a vérifié par l'arbre syntaxique (jamais en important le fichier) que chaque fichier régénéré ne contient que des données littérales, aucun appel, import (autre que de type), ni expression calculée. Absent ou autre valeur : voie non retenue. Le test de forme du job réduit reste, en second filet : il tourne dans le job qui importe le contenu, donc il ne suffit pas seul.
- **Étape article** : le blob de la proposition est celui que l'ordre signe (vérifié par la commande du projet) ; `regenerated` et `shape` ne sont pas exigés.

### 5.4 Le check run : mêmes garanties que `rules.ciProof`, plus strictes

Le check run du job déclaré est lu comme `verifyCiProof` le lit aujourd'hui (même code, réglages construits depuis `reducedProof`) :

- application GitHub Actions (slug `github-actions` **et** identifiant 15368), au commit exact `H`, conclu en `success`, lu par l'API des check runs avec `gh` lui-même (jamais `APV_GH`) ;
- exécution du workflow déclaré (identifiant résolu en chemin), au même commit, `completed` et `success`, et le check run est un job de cette exécution, de ce nom ; une exécution lancée sur une autre branche au même commit compte (le commit est le même, le workflow aussi) ;
- évènement **`workflow_dispatch` seulement** (Q2). Plus strict que `rules.ciProof`, qui admet aussi `push` : la routine lance la preuve à la main, et un workflow réduit déclenché à chaque poussée consommerait des minutes sans servir ;
- **le check run est toujours exigé** dans la voie, même quand des reçus locaux couvrent tous les contrôles de `gates` : il prouve aussi `covers`, qui seul justifie de lever `waives` ;
- aucun check run du job en échec, annulé, `action_required` ou inachevé au même commit, même si un plus récent est vert ;
- **aucun rouge masqué (constat M2)** : tout check run de `rules.ciProof` (lue à `T`) au commit `H` en échec, annulé, `action_required` ou inachevé, et tout reçu local en échec (`failed`) d'un contrôle de `waives`, écartent la voie (« un rouge observé n'est jamais levé par la voie réduite »). L'API illisible pour cette lecture : voie non retenue ;
- `run_attempt` égal à 1 : sinon la règle `instable` refuse, comme pour la preuve CI.

À l'étape article, la preuve porte sur `H`, c'est-à-dire l'ancienne base de la PR d'article plus la proposition, pas sur l'arbre fusionné (information I1) : elle prouve peu de chose de plus que la vérification du projet (Q5 : pas de faille, peu de valeur prouvée ; mesurée au projet pilote avant toute dispense).

Hors réseau, API illisible, origine hors de github.com : rien n'est accepté.

### 5.5 Workflow et fichiers exécutés protégés, identiques à la base

- Le blob du workflow réduit est **le même à `T`, à `B` et à `H`** (à `M` aussi quand `M` diffère de `T`), et le workflow existe à `T`. Plus strict que `rules.ciProof` (comparé à la seule base commune) : `T` est la seule base où l'outil lit la déclaration.
- **Le texte du workflow, lu à `T`, ne peut tester que le commit de l'exécution (constat M1)**. Refusés, quelle que soit la forme YAML (clé entre guillemets simples ou doubles, clé explicite `? `, flux `{...}`) :
  - toute occurrence du mot `inputs` (entrées de `workflow_dispatch`, `github.event.inputs`, `inputs.x`) ;
  - `vars.` (variables du dépôt, modifiables hors du dépôt) ;
  - toute clé `ref` ou `repository` (sous `actions/checkout` ou ailleurs : un autre commit ou un autre dépôt) ;
  - `continue-on-error` ;
  - `|| true`, `|| :` et `|| exit 0` (un échec masqué).
- **Pas d'annulation par le groupe de concurrence (constat F5)** : toute clé `cancel-in-progress` vaut `false`, et un workflow qui déclare `concurrency` le dit explicitement (`cancel-in-progress: false`). Une annulation au commit signé de l'article serait irrécupérable (le commit signé ne bouge plus).
- Les chemins protégés (défauts de `CI_PROTECTED_DEFAULTS` et `reducedProof.protectedPaths`) sont inchangés de `B` à `H` ; la fermeture des fichiers que le workflow et les scripts de la base nomment ou importent (`laneProblems`, calculée à `B`) aussi, **à une exception près** (5.6). Comme le diff est déjà réduit aux chemins de contenu, ce point revient à vérifier qu'aucun de ces chemins n'est un fichier qui produit la preuve.
- Un import non suivi, une configuration d'alias illisible, une fermeture incomplète : voie réduite non retenue.

### 5.6 Contenu régénéré : seule exception à la fermeture

Le contenu de la PR est, par construction, ce que la preuve teste : un script du job peut l'importer (le catalogue, lu par la vérification des liens ou l'export des guides). `rules.ciProof` refuserait alors la voie (« fichier exécuté par la preuve, modifié depuis la base »).

Dans la voie réduite, un fichier changé atteint par la fermeture est accepté **seulement** s'il répond à `reducedProof.paths.<étape>`, s'il existe déjà à `B` (un fichier **modifié**, atteint par un import), **et** si la vérification du projet du même essai l'a régénéré (5.3, blob de `H` à la publication ; proposition signée à l'article). La sortie le nomme : « contenu régénéré, exécuté par la preuve réduite : <chemin> ». Tout autre fichier de la fermeture reste protégé, et (constat F3) :

- **un fichier ajouté qui masque une résolution** (un chemin qu'un import de la fermeture pourrait désigner selon le chargeur : `x.js` à côté de `x.ts`, `dossier/index.ts` pour un slug `index`) n'est jamais exempté : voie non retenue ;
- **les imports des fichiers exemptés sont recalculés à `H`** (leur texte de `H`, alias de `B`) : un import non suivi, une fermeture incomplète, ou un fichier atteint changé depuis `B` qui n'est pas lui-même du contenu régénéré de l'étape : voie non retenue.

### 5.7 Contrôles requis dans la voie

- `waives` : non requis, dits « levés par la voie réduite (fusion sur ordre) » avec `covers` ; sauf un reçu local en échec (5.4, M2), qui écarte la voie.
- `gates` : reçu local propre d'abord ; sinon, la preuve réduite en tient lieu (5.4 à 5.6), sauf un contrôle à `repeatChanged` dont des fichiers de test changent (impossible dans la voie, les tests n'étant pas dans `paths`, mais la règle de `verifyCiProof` reste).
- Tout autre contrôle de la suite complète : exigé comme aujourd'hui, par reçu local ou par `rules.ciProof`. La routine de publication les lance elle-même quand elle le peut (contrôles sans pile, Q4), ou le projet les met dans `gates`.
- Les contrôles requis se calculent comme aujourd'hui, à la base commune `B` (à l'étape article, l'ancienne base de la PR d'article) ; `waives` est validé à `T` (information I3). Un contrôle ajouté entre `B` et `T` reste exigé à l'étape publication (où `B` est `M`), pas à l'étape article : c'est le comportement actuel de la règle, inchangé par la voie.

### 5.8 Sortie et trace

- `apv rules check` (appelé par `mergeOnOrder`) : « preuve : ok, voie réduite sur ordre <référence>, étape <étape> : N contrôle(s) prouvé(s) (x par reçus locaux, y par le check run « <name> » <id>, exécution <run> (workflow_dispatch)[, z par la CI]) ; levés : <waives> ; couvert : <covers> ; contenu régénéré exécuté par la preuve réduite : <chemins> ». Voie non retenue : chaque raison, sur sa ligne, dans les problèmes de la règle quand elle refuse, en une ligne dans son détail quand la suite complète passe.
- Rapport de `apv stack merge --order` (texte et JSON) : champ `proof` par étape, `full` ou `reduced`, avec le check run réduit (identifiant, exécution, nom) quand il a servi.
- Trace de fusion signée (`onMerged`, `apv/merges/`) : le même champ `proof`, signé avec la trace, pour que `apv audit merges` puisse le montrer.
- **Audit sans trace locale (constat F6, Q8)** : une fusion faite par la routine cloud n'a pas de trace sur le poste de l'opérateur. `apv audit merges` relit alors, pour chaque commit de fusion au pied `Apv-Order` non rapproché, les check runs à la tête fusionnée (second parent) : celui de `reducedProof` et celui de `rules.ciProof` déclarés au premier parent, avec leur conclusion, leur exécution et leur évènement. La mention est informative : le commit reste signalé (« pied Apv-Order non vérifié »), jamais blanchi par un check run vert. Hors réseau (`--offline`) ou API illisible, la sortie le dit.

## 6. Ce que la suite complète prouvait, et que la preuve réduite ne prouve pas

| Élément | Suite complète | Preuve réduite | Pourquoi c'est acceptable, ou ce qu'on garde |
|---|---|---|---|
| Générateur du contenu (gabarit, échappement, forme) | tests unitaires et d'injection, à chaque PR | tests unitaires lancés **en entier** (`gates`) | Le générateur est le code de `T`, déjà fusionné sous la suite complète. Ses tests (injection d'une proposition, texte jamais dans du code généré) tournent encore dans le job réduit, sur le contenu de l'instance. |
| Forme exacte des fichiers servis (#231 du pilote) | tests unitaires | **contrôle par l'arbre syntaxique dans `verify.publication`, depuis `T`, sans exécuter `H`** (5.3, M4), plus les tests unitaires du job | Le contrôle de `verify.publication` ne peut pas être faussé par le contenu : il ne l'exécute jamais. Le test du job reste un second filet ; le projet le protège (`protectedPaths`). |
| Régénération | `verify.publication` (code de sortie) | `verify.publication`, **liste des fichiers régénérés et de leurs blobs relue par l'outil** (E2) | C'est ce qui rend la voie réduite possible : chaque fichier du diff est le blob que le générateur de `T` a produit. |
| Liste fermée des chemins, modes, liste de refus | outil | outil, plus la sous-liste `reducedProof.paths`, sans suppression | Inchangé, plus strict. |
| Typecheck, lint, build | reçus ou CI | job réduit | Inchangé : un catalogue ou un type d'identifiant mal formé casse le typecheck ou le build. |
| Rendu de la page du guide (textes, titres, contrastes, débordement, CSP) | suite navigateur entière | tests de bout en bout des guides contre un aperçu du **build du commit** | Gardé pour les pages que le contenu touche : page du guide, liste des guides, pages qui lisent le catalogue (inventaire en 10.4). |
| Référencement (plan du site, balises, données structurées) | suite navigateur | tests du référencement | Gardé. |
| Captures (390 et 1280 px, clair et sombre) | étape « captures » de la preuve complète | **à garder dans le job réduit** pour la page du guide | La règle `captures` ne change pas : la relecture de fidélité les exige toujours. |
| **Modules serveur qui lisent le contenu** (au pilote : la tâche planifiée des notifications et l'annonce d'un nouveau guide, qui réserve en base et envoie un e-mail) | suite d'intégration (base, fonctions serveur) | **tests unitaires seulement** (le module avec une base simulée) ; l'intégration est levée | **Perte réelle** (constat M3) : un guide qui casse la réservation ou l'e-mail d'annonce ne se voit qu'à l'exécution de la tâche. Ce qu'on garde : la forme littérale (5.3), le typecheck, et les tests unitaires de ces modules, exigés par l'inventaire du projet (10.4). Le premier envoi d'annonce après une publication par la voie réduite se surveille. |
| **Pages d'administration qui lisent le contenu** (au pilote : l'aperçu d'un article, le calibrage) | suite navigateur entière | **non**, sauf si le projet les met dans le job | Perte acceptée : pages réservées à l'opérateur, non publiques, rendues en lecture du catalogue ; l'inventaire (10.4) les nomme et le projet choisit. |
| **Référencement et pagination partagés** (au pilote : les pages publiques du plan du site, la pagination) | suite navigateur | tests du référencement et tests unitaires | Gardé par les tests du référencement du job ; la pagination par ses tests unitaires (`gates`). |
| Suite d'intégration (base, RLS, fonctions serveur) | oui | **non** (`waives`) | Le diff ne touche ni migration, ni requête, ni code serveur autre que des données littérales dont la forme est vérifiée depuis `T` ; la liste de refus fixe écarte la configuration. Voir la ligne des modules serveur ci-dessus pour ce qui est perdu. |
| Autres écrans (compte, parcours) | suite navigateur entière | **non** | Aucun ne lit les fichiers de la liste : c'est ce que vérifie l'inventaire du projet (10.4), sur tous les modules, routes ou non. |
| Scan dynamique ZAP | oui | **non** | En-têtes et CSP viennent de fichiers sur la liste de refus (`hooks.server.*`, `svelte.config.*`, `vercel.json`) : inchangés. Le test de bout en bout du guide vérifie l'absence d'erreur CSP. |
| Liens des sources | étape de la routine | étape de la routine | **Hors du job** (Q3) : un site tiers lent rendrait le check run rouge, et un échec au commit exact bloque ce commit pour toujours. |

Risque restant, dit franchement : un comportement propre à ce contenu, dans un module que seule la suite entière exécutait (la tâche planifiée, une page d'administration), que les tests unitaires ne voient pas. Le filet est l'inventaire de **tous** les modules qui importent les fichiers de la liste (section 10.4), tenu par un test du projet qui fait échouer la suite complète, donc la PR qui ajoute un lecteur sans le classer ; et la relecture sécurité de `H`, toujours exigée.

## 7. Menaces et parades

| # | Menace | Parade | Test négatif |
|---|---|---|---|
| M1 | Faire passer du code par la voie réduite (un `.ts` de contenu qui appelle, importe ou exécute) | Liste fermée sous-ensemble des chemins permis ; liste de refus fixe ; mode 100644 ; chaque chemin du diff dans `regenerated` avec le blob de `H` (E2) ; forme littérale vérifiée par `verify.publication` depuis `T` (M4) ; imports des fichiers exemptés recalculés à `H` (F3) ; relecture sécurité de `H` | fichier du diff absent de `regenerated`, ou d'un autre blob : voie non retenue ; `shape` absent : voie non retenue ; fichier exempté qui importe un paquet non déclaré à `H` : voie non retenue |
| M2 | Workflow réduit modifié par la PR, ou différent entre `T`, `B` et `H` | Blob comparé à `T`, `B`, `H` (et `M`) ; `.github/` sur la liste de refus de l'ordre | workflow changé à `H` ; workflow différent entre `T` et `B` (étape article) ; workflow changé sur la cible entre `T` et `M` |
| M3 | Déclaration ajoutée ou élargie dans la PR elle-même | Lue à `T` seulement ; `.apv/` refusé par l'ordre ; empreinte de `T` | `reducedProof` présent à `H` et absent à `T` : suite complète exigée |
| M4 | PR qui sort de la liste (un fichier de plus, même permis par `operatorOrders.paths`) | Chaque chemin du diff dans `reducedProof.paths` ; ajout ou modification seulement (F2) | un fichier permis mais hors de la sous-liste : voie non retenue, fichier nommé ; une suppression dans la liste : voie non retenue |
| M5 | Fichiers exécutés par le job réduit modifiables (scripts, tests ciblés, configuration de Playwright, `package.json`) | Défauts de `CI_PROTECTED_DEFAULTS`, `protectedPaths`, fermeture calculée à `B` ; exception limitée au contenu régénéré modifié | fichier ajouté qui masque un fichier exécuté (`x.js` à côté de `x.ts`) : voie non retenue |
| M6 | Preuve réduite utilisée pour une PR ordinaire | Contexte construit seulement par `mergeOnOrder` | `apv rules check` avec un check run réduit vert : suite complète exigée |
| M7 | Check run d'un autre commit, d'une autre application, d'un autre workflow du même nom | Conditions de `verifyCiProof` | check run d'une application homonyme ; job « Preuve de publication » d'un autre workflow |
| M8 | Évènement ou workflow qui teste un autre commit | `workflow_dispatch` seulement ; texte du workflow de `T` sans `inputs`, `vars.`, clé `ref` ni `repository` (M1 de la relecture) | exécution `push` ; `inputs` sous chacune de ses formes (`inputs:`, `"inputs":`, `'inputs':`, `? inputs`, `github.event.inputs`) ; `vars.` ; `ref:` sous `actions/checkout` |
| M9 | Vert après un rouge (relance, nouvelle exécution), rouge masqué | Un échec, une annulation ou une exécution en cours au commit bloque ; `run_attempt` 1 ; rouge de `rules.ciProof` à `H` ou reçu local en échec d'un contrôle levé : voie écartée (M2 de la relecture) ; `continue-on-error` et `|| true` refusés | échec puis succès au même commit ; succès en tentative 2 ; « Preuve complète » en échec à `H` ; reçu local `failed` de `integration` ; `continue-on-error: true` dans le workflow |
| M10 | Vérification du projet d'un autre essai (cible qui a bougé entre la vérification et la règle) | Contexte lié à `H` et `M` de l'essai, refait à chaque essai ; `checkMergeRules` compare commit et cible au contexte (F4) | vérification pour un autre `M` : voie non retenue ; contexte passé pour un autre commit : voie non retenue |
| M11 | Déclaration qui lève trop (`waives` couvrant `reuse`, `structure`, ou leur commande sous un autre nom) | Chargeur, contrôles reconnus par leur commande (F1) | `waives` avec un contrôle exigé par APV, ou un contrôle `lint-maison` dont la commande est `apv reuse check` : configuration invalide |
| M12 | Confusion entre preuve complète et réduite | `workflow` et `name` distincts imposés | même nom que `rules.ciProof` : configuration invalide |
| M13 | Déclaration élargie par une PR qu'un agent fait fusionner (E1) | Décision de l'opérateur ancrée, citation qui porte l'empreinte de la déclaration, vérifiée par `apv rules check` (4.3) | PR qui ajoute `reducedProof` sans décision, avec une décision non ancrée, avec une citation ancrée sans l'empreinte : `preuve` refusée ; même PR dans un lot : refusée |
| M14 | Preuve réduite rendue impossible par une annulation (disponibilité, F5) | `cancel-in-progress: false` exigé ; la routine vérifie qu'aucune exécution n'est en cours au commit avant d'en relancer une (10.5) | `cancel-in-progress: true`, ou `concurrency` sans `cancel-in-progress: false` : voie non retenue |

Limites acceptées, comme pour `rules.ciProof` : le code que la suite exécute (ici le contenu régénéré) pourrait fausser un job inchangé ; la régénération vérifiée, la forme littérale contrôlée depuis `T` et le recalcul des imports à `H` le réduisent à des données littérales. La protection de branche absente d'un dépôt privé gratuit (REGLES.md, section 3 bis) n'est pas compensée ici. Dans la routine cloud, l'agent contrôle `PATH` et peut donc imiter `gh` (information I2) : c'est la limite de [REGLES.md](REGLES.md), section 3 bis (l'outil garantit sur le compte où travaillent les agents, pas contre un agent déterminé) ; l'audit des fusions relit les check runs depuis le poste de l'opérateur (5.8, F6). Non vérifié par la relecture, à confirmer à l'essai à blanc : le comportement réel de GitHub sur les clés YAML entre guillemets (refusées ici quoi qu'il en soit), `workflow_dispatch` lancé sur une étiquette, le cache des actions.

## 8. Tests de l'outil

Négatifs (chacun refuse la voie réduite, la suite complète reste exigée, ou la configuration est invalide) : M1 à M14 ci-dessus, plus :

- vérification du projet en échec ou non lancée dans l'essai ;
- slug illisible pour `{slug}` ;
- diff avec une suppression (F2), un renommage, un lien symbolique ou un exécutable ;
- contrôle hors de `gates` et de `waives` sans reçu local : refus qui le nomme ;
- check run en cours, annulé par un groupe de concurrence, `action_required` ;
- API indisponible ou hors réseau ;
- motif de `reducedProof.paths` qui n'est pas un motif de `operatorOrders.paths`, motif `**`, `*` ou `?` (F3), `protectedPaths` qui couvre un chemin de contenu ;
- configuration de `M` d'une autre empreinte que `T` au premier essai d'une étape ;
- E2 : sortie de la commande sans `regenerated`, avec un chemin du diff absent, avec un autre blob, avec un chemin en double ;
- M4 : `shape` absent ;
- M1 : `"inputs":`, `'inputs':`, `? inputs`, `github.event.inputs`, `vars.`, `ref:` sous `actions/checkout`, `continue-on-error`, `|| true` ;
- M2 : check run de `rules.ciProof` en échec, annulé, en cours à `H` ; reçu local `failed` d'un contrôle de `waives` ;
- F1 : `waives` qui nomme un contrôle dont la commande est celle d'un contrôle exigé ;
- F4 : contexte passé avec un autre commit, une autre cible ;
- F5 : `cancel-in-progress: true`, `concurrency` sans `cancel-in-progress: false` ;
- E1 : ajout sans décision, décision non ancrée, citation sans l'empreinte, élargissement de `paths` ou de `waives` ; refus aussi dans un lot.

Positifs :

- étape publication : diff des sortes de fichiers de la liste, régénération vérifiée avec les blobs, check run réduit vert, contrôles hors `gates` et `waives` prouvés en local : `preuve` ok, sortie complète (5.8) ;
- étape article : seule la proposition, check run réduit vert au commit signé ;
- exécution lancée sur une autre branche au même commit : acceptée ;
- contenu importé par un script du job (5.6) : accepté et nommé ;
- reçus locaux propres pour certains contrôles de `gates` : ils passent d'abord ; le check run reste exigé ;
- E1 : décision ancrée qui porte l'empreinte : `preuve` jugée comme d'habitude ; déclaration rétrécie : aucune décision exigée ;
- fusion sur ordre de bout en bout : publication et article fusionnés par la voie réduite, `proof: reduced` dans le rapport et la trace ; audit qui relit le check run (F6) ;
- projet sans `reducedProof` : comportement identique à aujourd'hui (suite de tests existante verte).

## 9. Changements de l'outil (description, pas de code)

| Fichier | Changement |
|---|---|
| `src/orders/config.ts` | `reducedProof` dans `operatorOrdersSchema` ; contrôles du chargeur (4.1) avec la configuration des contrôles pour `gates` et `waives` (commandes comprises, F1) ; empreinte de la déclaration et élargissement (4.3) ; ligne de `apv status` |
| `src/orders/verify-command.ts` | lecture de la dernière ligne de la commande du projet en cas de succès : `regenerated` et `shape` (E2, M4) |
| `src/orders/paths.ts` | lecture du diff brut avec le blob de chaque chemin (partagée par la fusion et la règle) |
| `src/rules/ci-proof.ts` | `verifyCiProof` paramétrée : évènements admis, check run toujours exigé, fichiers de contenu exemptés de la fermeture (vide par défaut : `rules.ciProof` inchangée), fichiers ajoutés qui masquent jamais exemptés, imports recalculés à `H` ; lecture des check runs d'un nom pour M2 et l'audit (F6) |
| `src/rules/reduced-proof.ts` (nouveau) | conditions 5.1 à 5.6 de la voie, contrôles du texte du workflow (M1, F5), décision ancrée (4.3) |
| `src/rules/check.ts` | `RulesInput.orderLane` (facultatif) ; dans la voie, contrôles requis moins `waives`, puis reçus locaux, preuve réduite, `rules.ciProof` ; décision ancrée sur un élargissement, même dans un lot ; sortie de la section 5.8 ; ligne d'information hors de la voie |
| `src/commands/stack-order.ts` | `orderRules` passe le contexte reçu de `mergeOnOrder` et rend la preuve retenue ; rapport texte |
| `src/orders/merge.ts` | construit le contexte après la vérification du projet, à chaque essai ; champ `proof` du rapport et de la trace |
| `src/rules/merges.ts`, `src/commands/audit.ts` | champ `proof` de la trace signée ; relecture des check runs pour un pied `Apv-Order` sans trace (F6) |
| `docs/REGLES.md`, `docs/CONFIGURATION.md`, `docs/CLI.md`, `CHANGELOG.md` | règle, champ, sortie, évolution ; REGLES section 5 : `reducedProof` est la seule déclaration qui retire, sous décision ancrée (E1) |

## 10. Travail côté projet (PR du projet, après celle d'APV)

Décrit ici, livré par une PR du projet pilote une fois la version d'APV publiée et le plugin mis à jour.

### 10.1 Workflow `preuve-publication.yml`

- `on: workflow_dispatch` seul, **sans aucune occurrence du mot `inputs`** ; `permissions: contents: read` ; aucun secret, aucune variable `vars.` ; `actions/checkout` sans `ref` ni `repository` ; aucun `continue-on-error` ni `|| true` ; actions épinglées par commit, les mêmes que `preuve.yml` ; groupe de concurrence propre (`preuve-publication-${{ github.event_name }}-${{ github.ref_name }}`) avec `cancel-in-progress: false`, qui n'annule jamais `preuve.yml`.
- Un job `preuve-publication`, nom « Preuve de publication », `timeout-minutes: 20`, chaque étape avec sa limite.
- Étapes : installation (`npm ci`) ; typecheck (`npm run check`) ; lint (`npm run lint`) ; tests unitaires (`npm run test`, dont la forme exacte du contenu, l'injection, et les tests unitaires des modules serveur de l'inventaire 10.4) ; build ; contrôles sans pile de la suite (code mort, bonnes pratiques Svelte, `diff-check`) ; Chromium de Playwright ; tests de bout en bout des guides et du référencement (`guides.e2e.ts`, `referencement.e2e.ts`) contre un aperçu du build du commit servi dans le job ; captures de la page du guide (390 et 1280 px, clair et sombre) ; reçus en artefact.
- **Aucun service distant** : l'aperçu est celui du job, jamais un déploiement Vercel (un déploiement d'aperçu n'est pas lié au commit par l'outil, et chaque poussée en crée un sur l'offre Hobby).
- Vérification des liens : **hors du job**, à l'étape 5 de la routine comme aujourd'hui (Q3).

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

### 10.3 Déclaration et décision

Sous `rules.operatorOrders` de `.apv/config.json` : `reducedProof` avec `workflow` `.github/workflows/preuve-publication.yml`, `job` `preuve-publication`, `name` « Preuve de publication » ; `gates` : les contrôles que le job lance en entier (`check`, `lint`, `test`, `build`, `articles-build`, `dead-code`, `svelte`, `diff-check`, selon la mesure) ; `waives` : `integration`, `browser` ; `paths` : les quatre motifs de `paths.publication` et celui de `paths.article`, recopiés ; `protectedPaths` : les tests ciblés (`tests/e2e/browser/guides.e2e.ts`, `tests/e2e/browser/referencement.e2e.ts`, `tests/articles-content-shape.test.ts`, `tests/support/content-shape.ts`) et les scripts propres au job.

La PR de configuration porte la décision de l'opérateur ancrée (4.3) : l'opérateur tape dans sa session la phrase que donne `apv rules check` avec l'empreinte de la déclaration, et la décision versée dans `.apv/DECISIONS.json` la cite mot pour mot.

Les contrôles `reuse`, `code-map`, `structure` et `tests` (outil `apv`) restent hors du job : la routine les lance en local, sans pile (Q4).

La commande `verify.publication` du projet (`scripts/articles/order.mjs`) écrit, en cas de succès, la ligne de la section 5.3 : `regenerated` avec le blob de chaque fichier servi régénéré (elle les régénère déjà tous les quatre) et `shape: "literal"` après un contrôle par l'arbre syntaxique de TypeScript, depuis la copie de `T`, sans importer le contenu de `H`.

### 10.4 Tests du projet

- `tests/ci-workflow.test.ts` étendu : le workflow réduit n'a que `workflow_dispatch`, aucune occurrence de `inputs`, aucun secret ni `vars.`, aucun `ref` ni `repository`, ni `continue-on-error` ni `|| true`, `cancel-in-progress: false` ; il lance les tests de forme du contenu et les tests des guides ; ses actions sont épinglées.
- **Inventaire de tous les modules qui importent les fichiers de la liste** (constat M3), routes ou non, directement ou par un module intermédiaire : un test du projet calcule la fermeture inverse des imports du catalogue, du registre, du type des guides et des textes, et exige que chaque module trouvé soit classé dans une liste tenue par le projet : « testé dans le job réduit » (avec le test qui le couvre) ou « perte acceptée » (avec la raison, relue). Un module nouveau non classé fait échouer la suite complète, donc la PR qui l'ajoute. Au projet pilote, sur `origin/main` le 11 octobre 2026 :

  | Module | Sorte | Classement attendu |
  |---|---|---|
  | `src/routes/guides/+page.server.ts`, `+page.svelte` ; `src/routes/guides/[slug]/+page.server.ts`, `+page.svelte` | pages publiques des guides | testé dans le job (bout en bout, captures) |
  | `src/lib/seo/pages.ts`, `src/lib/seo/guides-json-ld.ts`, `src/lib/server/seo/public-pages.ts` | référencement | testé dans le job (référencement, tests unitaires) |
  | `src/lib/shared/pagination.ts` | partagé | tests unitaires du job |
  | `src/lib/server/notifications/cron-tick.ts`, `src/lib/server/notifications/guide-announcement.ts` | tâche planifiée, réservation en base et e-mail | tests unitaires du job ; intégration levée : perte acceptée, à surveiller au premier envoi (section 6) |
  | `src/routes/admin/articles/[numero]/apercu/+page.server.ts`, `src/routes/admin/calibrage/+page.server.ts` | administration | perte acceptée ou test ajouté au job, au choix du projet |
  | `src/lib/server/guides/notice.ts` | serveur des guides | tests unitaires du job |
  | `src/lib/server/articles/*.ts` (`check`, `export`, `order`, `proposal`, `publish`), `scripts/articles/publish.mjs`, `scripts/guides/export.mjs`, `scripts/guides/links.mjs`, `scripts/e2e/ci-stack.mjs` | générateur, vérification, scripts | code de `T` ; tests unitaires du job ; les scripts exécutés par le job sont protégés (5.5) |

### 10.5 Procédure de publication

`docs/redaction/publication-automatique.md`, étape 6 : **avant de lancer**, vérifier qu'aucune exécution du workflow réduit n'est en cours ni en file pour ce commit (`gh run list --workflow preuve-publication.yml --commit <sha>`) ; si une exécution existe, l'attendre au lieu d'en relancer une (F5) ; sinon `gh workflow run preuve-publication.yml --ref publication/<slug>` puis, pour l'étape article, sur la branche de l'article ; une attente par check run (15 minutes environ) ; la preuve complète `preuve.yml` reste la voie de repli quand APV dit la voie réduite non retenue. Règles d'autorisation de la routine : ajouter `gh workflow run preuve-publication.yml` et `gh run list`.

Limites à dire dans la procédure : `workflow_dispatch` lance le workflow tel qu'il est **sur la branche** ; une PR d'article ouverte avant l'arrivée du workflow sur `main` ne l'a pas, et son commit signé ne peut plus bouger. Pour ces articles, la preuve complète reste exigée à l'étape article, ou une nouvelle décision après mise à jour de la branche (Q6, à dire dans REPRISE.md). Un rouge, une annulation ou un délai dépassé sur le commit signé de l'article est irrécupérable par la voie réduite : il faut la preuve complète, ou une nouvelle décision de l'opérateur (nouveau commit signé).

## 11. Option de secours : runner auto-hébergé sur le poste de l'opérateur

Le check run « Preuve complète » peut tourner sur un runner auto-hébergé (`runs-on: [self-hosted, apv-preuve]`) installé sur le poste de l'opérateur. APV n'a rien à changer : le check run vient toujours de l'application GitHub Actions, et `rules.ciProof` l'accepte aux mêmes conditions.

Limites :

- **poste allumé** et Docker démarré pendant la preuve ; une exécution en attente d'un runner hors ligne échoue après 24 heures ;
- **sécurité** : tout compte qui peut pousser une branche (agents compris) peut faire exécuter du code sur le poste par un workflow ; Docker rend le compte du runner équivalent à l'administrateur de la machine, donc capable de lire la clé d'ancrage. À ne faire que dans une machine virtuelle ou une distribution WSL séparée, sous un compte dédié sans accès au dossier de l'opérateur, en runner éphémère (`--ephemeral`), réservé aux évènements `workflow_dispatch` ;
- **coût** : les minutes d'un runner auto-hébergé ne comptent pas dans les 2000 minutes aujourd'hui ; GitHub a annoncé fin 2025 une redevance par minute pour ces runners sur les dépôts privés, puis l'a repoussée. À vérifier sur la page de facturation avant d'en dépendre ;
- **confiance** : APV ne distingue pas un runner hébergé d'un runner auto-hébergé. Un runner sur le compte où travaillent les agents serait une preuve écrite par ceux qu'elle juge (REGLES.md, section 3 bis).

Recommandation (Q9) : ne pas la préparer maintenant ; la garder pour une preuve complète rare (changement du générateur, PR de configuration), pas pour chaque article, et seulement dans une machine virtuelle dédiée.

## 12. Phases de livraison

| Phase | Contenu | Acceptée quand |
|---|---|---|
| 1. Déclaration | schéma, chargeur (4.1, F1, F3), décision ancrée vérifiée par `apv rules check` (4.3, E1), ligne de `apv status`, CONFIGURATION.md, REGLES section 5 | chaque refus du chargeur et chaque cas de l'élargissement ont leur test ; un projet sans `reducedProof` ne voit aucun changement |
| 2. Règle | `verifyCiProof` paramétrée, `orderLane` dans `checkMergeRules` (F4), conditions 5.3 à 5.7 (E2, M1, M2, M4, F2, F3, F5), sortie | M1 à M14 refusés, cas positifs acceptés, `rules.ciProof` inchangée (tests existants verts) |
| 3. Fusion sur ordre | sortie de la commande du projet lue (E2, M4), contexte construit par `mergeOnOrder`, rapport et trace, audit qui relit le check run (F6), REGLES.md section 3 ter, CHANGELOG | essai complet en dépôt de test : publication et article fusionnés avec la preuve réduite ; mêmes cas avec un fichier hors liste : suite complète exigée |
| 4. Projet pilote | PR du projet (section 10) | essai à blanc de la routine avec un article fictif ; temps mesuré du job ; un article réel publié par la voie réduite |

Les phases 1 à 3 tiennent dans une seule PR d'APV (#136), avec une relecture sécurité du code avant fusion ; la phase 4 vient après la publication de la version d'APV.

## 13. Critères d'acceptation

- **AC-RP-DECL** : `reducedProof` invalide dans chacun des cas de la section 4.1 fait refuser la configuration, avec le champ et la raison.
- **AC-RP-ANCHOR** : une PR qui ajoute ou élargit `reducedProof` sans décision de l'opérateur ancrée qui porte l'empreinte de la déclaration fait refuser `preuve`, même dans un lot ; avec elle, la règle est jugée comme d'habitude ; une déclaration rétrécie n'exige rien.
- **AC-RP-ORDER-ONLY** : avec un check run réduit vert au commit, `apv rules check`, `apv stack merge` sans `--order` et `apv stack batch` exigent la suite complète.
- **AC-RP-BASE** : une déclaration présente à `H` et absente de `T` n'a aucun effet ; une configuration différente entre `T` et `M` refuse l'ordre après une poussée refusée (`config`), et rend la voie non retenue au premier essai d'une étape.
- **AC-RP-PATHS** : un seul fichier hors de `reducedProof.paths`, même permis par `operatorOrders.paths`, ou une suppression, fait exiger la suite complète, avec ce fichier dans la sortie.
- **AC-RP-VERIFY** : sans vérification réussie du projet dans le même essai, pour le même `H` et le même `M`, ou, à la publication, sans `regenerated` qui couvre chaque fichier du diff avec son blob et sans `shape: "literal"`, la voie n'est pas retenue.
- **AC-RP-CHECKRUN** : chaque condition de la section 5.4 a son test négatif ; seul `workflow_dispatch` est admis ; un rouge de `rules.ciProof` à `H` ou un reçu local en échec d'un contrôle levé écarte la voie.
- **AC-RP-WORKFLOW** : chaque forme refusée du texte du workflow (5.5) a son test négatif.
- **AC-RP-PROTECTED** : un fichier protégé, ou de la fermeture hors contenu régénéré modifié, changé de `B` à `H`, un fichier ajouté qui masque une résolution, et un workflow différent entre `T`, `B` et `H`, font sortir de la voie.
- **AC-RP-GATES** : un contrôle hors de `gates` et de `waives` sans reçu local fait refuser `preuve` en le nommant.
- **AC-RP-AUDIT** : `apv audit merges` dit, pour une fusion sur ordre sans trace locale, le check run lu à la tête fusionnée, sans jamais la compter comme tracée.
- **AC-RP-NO-WEAKER** : sans `reducedProof`, ou hors d'une fusion sur ordre, aucune règle ne change (suite de tests existante verte).

Scénarios de la personne cible (routine de publication, chef de projet, opérateur) :

- **AC-USER-1** : Étant donné un ordre signé et une PR de publication régénérée à l'identique, quand la routine lance la preuve réduite puis `apv stack merge --order`, alors la publication et l'article sont fusionnés avec moins de 40 minutes de GitHub Actions, et la sortie dit « voie réduite » avec les contrôles levés.
- **AC-USER-2** : Étant donné une PR de publication qui change aussi une feuille de style, quand la routine lance `apv stack merge --order`, alors APV refuse avant toute fusion, nomme la feuille, et la note d'arrêt dit que la suite complète est exigée.
- **AC-USER-3** : Étant donné un agent qui modifie le workflow réduit dans une PR ordinaire, quand cette PR est relue et fusionnée sous les règles normales, alors les ordres en cours dont la base de confiance précède ce changement voient leur voie réduite refusée (« workflow différent à la base de confiance »).
- **AC-USER-4** : Étant donné une preuve réduite rouge parce que le texte du guide déborde sur téléphone, quand l'opérateur demande des changements dans l'admin, alors la nouvelle PR de publication a un nouveau commit et se prouve de nouveau, sans rien débloquer à la main.
- **AC-USER-5** : Étant donné un agent qui ouvre une PR ajoutant `waives: ["integration"]`, quand le chef de projet lance `apv rules check`, alors `preuve` est refusée avec l'empreinte de la déclaration et la phrase que l'opérateur doit taper lui-même.

## 14. Questions ouvertes pour le chef de projet : tranchées

Le chef de projet a suivi toutes les recommandations (11 octobre 2026).

| # | Question | Recommandation | Réponse |
|---|---|---|---|
| Q1 | Nom et place de la déclaration : `rules.operatorOrders.reducedProof`, ou `rules.ciProof.reduced` ? | `operatorOrders.reducedProof` : voie réservée à l'ordre, empreinte de `T` sans code de plus, sous-liste vérifiée au même endroit. | décidé : recommandation suivie (avec la décision ancrée de E1, section 4.3) |
| Q2 | Admettre aussi l'évènement `push` sur la branche de publication, comme `rules.ciProof` ? | Non : `workflow_dispatch` seul, la routine lance la preuve et aucune minute ne part à chaque poussée. | décidé : recommandation suivie |
| Q3 | Vérification des liens dans le job réduit, ou à l'étape 5 de la routine ? | Routine : un site tiers en panne rendrait le commit improuvable pour toujours (un échec au commit n'est jamais masqué). | décidé : recommandation suivie |
| Q4 | Les contrôles de l'outil `apv` (`reuse`, `code-map`, `structure`, `tests`) : en local dans la routine, ou installés dans le job ? | En local : rapides, sans pile, et la routine a déjà `apv`. | décidé : recommandation suivie |
| Q5 | L'étape article mérite-t-elle une preuve réduite à part, ou une dispense propre (la proposition n'est jamais servie) ? | Preuve réduite au début, mesurée ; une dispense demanderait une autre spec et un autre raisonnement de sécurité. | décidé : recommandation suivie (I1 dit ce qu'elle prouve, 5.4) |
| Q6 | Les PR d'article déjà ouvertes, sans le workflow réduit sur leur branche ? | Preuve complète pour elles, ou nouvelle décision de l'opérateur après mise à jour de la branche. Les dire dans REPRISE.md. | décidé : recommandation suivie |
| Q7 | Les pages du guide se rendent-elles sans pile Supabase dans le job (variables publiques factices) ? | À vérifier par le projet avant la PR ; sinon démarrer une pile minimale (environ 3 minutes), toujours sous 15 minutes au total. | décidé : recommandation suivie |
| Q8 | Une marque dans le message du commit de fusion (`Apv-Proof: reduced`) pour l'audit ? | Pas dans cette version : le message est comparé à l'identique pour la consommation de l'ordre. La trace signée et le rapport suffisent ; l'audit relit le check run à la tête pour une fusion sans trace locale (F6). | décidé : recommandation suivie, avec F6 |
| Q9 | Runner auto-hébergé (section 11) : à préparer maintenant ? | Non : seulement si la preuve réduite ne suffit pas, et dans une machine virtuelle dédiée. | décidé : recommandation suivie |

## 15. Constats de la relecture sécurité et leur traitement

| Constat | Gravité | Traitement dans cette spec |
|---|---|---|
| E1 : droit de lever des contrôles non ancré | élevé | 2, 4.3, M13, AC-RP-ANCHOR, AC-USER-5 ; REGLES section 5 |
| E2 : régénération non observable par l'outil | élevé | 5.3 (`regenerated`), 5.6, M1, AC-RP-VERIFY |
| M1 : détection des `inputs` contournable | moyen | 5.5 (texte du workflow), M8, AC-RP-WORKFLOW, 10.1 |
| M2 : rouge observé masqué par la voie | moyen | 5.4, 5.7, M9, AC-RP-CHECKRUN |
| M3 : perte sous-estimée | moyen | 6 (lignes des modules serveur, de l'administration, du référencement), 10.4 (inventaire) |
| M4 : test de forme circulaire | moyen | 5.3 (`shape`), 6, 10.3 |
| F1 : `waives` filtré par identifiant | faible | 4.1, M11 |
| F2 : suppressions | faible | 5.3 (ajout ou modification seulement), M4, 8 |
| F3 : jokers, fichier qui masque, imports à `H` | faible, conseil | 4.1, 5.6, M5 |
| F4 : contexte lié à `H`, `M`, `T` | faible, conseil | 5.1, M10 |
| F5 : disponibilité | faible, conseil | 5.5, M14, 10.1, 10.5 |
| F6 : audit sans trace locale | faible, conseil | 5.8, AC-RP-AUDIT |
| I1, I2, I3 | information | 5.4, 7 (limites), 5.7 |
