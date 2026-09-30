# Règles du chef de projet

Demande de l'opérateur : « Il faut que la pipeline soit mise à jour et que les règles soient rigides. Toi, tu as ta mémoire, mais dans un nouveau projet on n'aura pas ça, donc le chef de projet peut laisser passer ça. »

Ce document est la source unique des règles : chaque règle vient d'un incident réel du projet pilote, rendu générique. Pour chacune : la règle, pourquoi, et qui la vérifie. **Outil** : `apv` refuse, aucune option ne lève le refus. **Chef de projet** : elle demande un jugement ; la compétence `apv:chef-de-projet` et les agents la portent, l'outil ne peut pas la prouver. Le guide de démarrage d'un projet ([DEMARRER-UN-PROJET.md](DEMARRER-UN-PROJET.md)) en donne la liste courte.

## 1. Ce que l'outil vérifie avant toute fusion

`apv rules check --commit <tête> --target origin/<cible>` les vérifie ; `apv stack merge` les vérifie juste avant chaque fusion et s'arrête au premier refus, `apv stack plan` les liste, `apv stack batch --merge` les vérifie pour chaque PR avant de construire le lot. Tout se lit à la base commune de la PR et de sa cible (configuration, maquettes déjà fusionnées) : une PR ne change pas ses propres règles.

| Règle | Refusé quand | Pourquoi |
|---|---|---|
| `preuve` | la suite complète n'est pas prouvée au commit exact de la tête, contrôles de la base compris (`apv gates verify`) | un vert annoncé par un agent n'est pas une preuve ; au projet pilote, deux PR vertes chacune de leur côté ont cassé la branche principale une fois fusionnées |
| `instable` | un contrôle n'a réussi qu'après la relance de ses tests en échec (`passed_after_retry`) | un test qui ne passe qu'à la relance cache souvent une course ou une attente dans le produit ; zéro relance acceptée à la fusion |
| `relecture` | un domaine que `apv review plan` retient pour le diff (sécurité toujours ; fidélité, données, RGPD selon les fichiers) n'a pas de relecture enregistrée **à ce commit**, par l'agent relecteur du domaine, sans constat critique ni haut | une revue annoncée n'est pas une revue faite ; une correction après revue change le code relu ; un constat critique ou haut ne se fusionne pas |
| `captures` | un changement d'interface (fidélité retenue) n'a pas, dans sa relecture de fidélité, les captures ordinateur et téléphone, thème clair et sombre (`rules.captures`) | un écran se juge à l'œil, dans les deux largeurs et les deux thèmes, pas sur la foi d'un rapport |
| `controles` | un projet web ne déclare pas, obligatoires, les contrôles `reuse` (`apv reuse check`), `code-map` (`apv map --check`) et `structure` (`apv structure check`), ni ceux de `rules.requiredGates` | au projet pilote, une administration a recréé sa coquille, ses listes déroulantes et ses toasts à côté des composants partagés, et aucune étape ne l'a arrêtée |
| `maquette` | un écran ajouté ou modifié (page, mise en page ou page d'erreur d'un routeur connu, ou `rules.screens`) n'est couvert par aucune maquette validée par l'opérateur | la maquette validée par l'opérateur est la référence absolue ; un écran codé sans elle se refait |

Une maquette couvre un écran quand sa décision (`maquette-<nom>-validee`, confirmée, source opérateur) a une portée (`scope.paths`) qui contient le fichier, ou quand son nom ou l'un de ses écrans (`Écrans : ...`) nomme la route (`/admin/articles` répond à `admin-articles`, `admin` et `articles`). Elle compte si elle est déjà sur la branche cible, ou si la PR l'apporte et que la citation de l'opérateur (`sourceQuote`) figure mot pour mot dans ses messages de la session (section 3). Pour une maquette qui couvre plusieurs écrans, déclarer sa portée : `apv design register ... --scope 'src/routes/(app)/**'`.

Chaque refus dit ce qui manque et quoi faire, dans l'ordre, par exemple :

```
- relecture (relecture enregistrée à ce commit, sans constat critique ni haut) : REFUSÉ : relectures demandées par le diff : securite, fidelite
    securite : aucune relecture enregistrée à 1a59cf7db7f9
    à faire : Relecture securite par apv:qa-securite sur une copie détachée à 1a59cf7db7f9 ; l'agent l'enregistre lui-même (apv review record ...).
    à faire : Sans correction, seul l'opérateur peut lever ce refus, en tapant lui-même dans la session : « dérogation relecture 1a59cf7db7f9 : <ta raison> ».
```

### Relectures enregistrées

```
apv review record --commit <sha> --domain <securite|fidelite|donnees|rgpd> --reviewer apv:<agent> --report <fichier>
                  --critical <n> --high <n> --medium <n> --low <n> [--capture <desktop|phone|tablet>:<light|dark>:<fichier>]...
apv review show --commit <sha>
```

L'agent relecteur l'appelle lui-même à la fin de sa relecture, depuis sa copie détachée : la tête de la copie doit être le commit, ses fichiers suivis inchangés ; le rapport complet (200 octets au moins) cite le commit ; chaque capture est une vraie image (PNG, JPEG ou WebP, 1 Ko au moins), jamais la même image deux fois. Rapport et captures sont copiés sous leur empreinte dans `<répertoire git commun>/apv/reviews/<commit>/<domaine>/`, jamais versionnés ; un fichier modifié après coup rend la relecture inutilisable. La dernière relecture d'un domaine à un commit fait foi. Un nouveau commit (une correction) demande une nouvelle relecture : c'est voulu.

| Domaine | Seul agent qui l'enregistre |
|---|---|
| `securite` | `apv:qa-securite` |
| `fidelite` | `apv:qa-fidelite` (avec les captures) |
| `donnees` | `apv:architecte-donnees` (mode revue) |
| `rgpd` | `apv:dpo` |

## 2. Les autres garde-fous de l'outil

| Règle | Comment l'outil la tient |
|---|---|
| Une seule suite complète à la fois | file des suites de la machine (`suite.queue`) : une suite attend son tour, jamais deux en même temps |
| Aucun e2e d'agent pendant une preuve | `apv gates run --stage full` refuse de démarrer, sans rien lancer, quand un port de la suite (`suite.ports`) est tenu par une autre copie, le checkout principal ou un outil, ou quand le verrou d'une pile déclarée (`stacks`) est tenu ; le message dit quoi attendre ou arrêter (`apv procs list`, `apv procs stop --port <p>`) |
| Alerte quand un contrôle approche de son délai | un reçu à 85 % ou plus du délai de son contrôle porte `nearTimeout` ; `apv gates run` et `apv gates verify` l'affichent (« délai presque atteint ») : augmenter `timeoutMs` avant qu'un délai dépassé ne casse une preuve. Un délai n'est pas un garde-fou de sécurité : l'ajuster à la durée mesurée est permis |
| Seul le chef de projet fusionne | le crochet Bash refuse `gh pr merge`, `apv stack merge` et `apv stack batch --merge` dans un sous-agent, même avec `APV_ALLOW_MERGE=1` |
| Une relecture n'est jamais écrite par qui a écrit le code | le crochet Bash ne laisse lancer `apv review record` qu'à l'agent relecteur du domaine, sous son propre nom : ni l'implementer, ni l'intégrateur, ni la session principale |
| Contrôles lus à la base | `apv gates run` et `verify` gardent chaque contrôle de la base dans sa définition de la base (docs/CONFIGURATION.md) |
| Un seul composant par type d'élément | `apv reuse check` refuse un élément natif réservé (`<select>`, `<dialog>`...) hors des composants partagés, une primitive de style redéfinie, un bloc copié ; signale un composant homonyme d'un composant partagé ([REUSE.md](REUSE.md)) |
| Jamais de force-push, de fusion hors commande, de déploiement manuel, de sortie masquée d'une écriture GitHub, d'arrêt du parent de la session, de `pkill -f`, de Docker sur une pile sans son verrou, d'écriture sur une base distante | crochet Bash du plugin ([PLUGIN.md](PLUGIN.md)) |

## 3. Ancrage : ce qu'un agent ne peut pas écrire

Règle générique : **toute validation humaine lue dans un endroit que l'agent peut écrire (un fichier du dépôt, GitHub, une base) est ancrée dans une trace qu'il ne peut pas écrire.** Incident d'origine : un statut « validé » lu sur une étiquette GitHub, alors que l'agent publie avec le compte de l'opérateur ; il pouvait se valider lui-même.

APV3 l'applique à ses propres validations :

- **Journal de l'opérateur.** Le crochet `UserPromptSubmit` du plugin garde ce que l'opérateur tape dans le compositeur interactif (`source: user`), jamais un message de sous-agent, d'une session non interactive (`claude -p`, SDK) ni d'un réveil programmé, dans `<répertoire git commun>/apv/operator/messages.jsonl` : hors de tout worktree, jamais versionné, jamais envoyé ailleurs. Une maquette apportée par une PR compte si sa citation y figure ; une dérogation n'existe que là.
- **Dérogation.** Sans correction, seul l'opérateur lève un refus, en tapant lui-même dans la session : `dérogation <règle> <12 premiers caractères du commit au moins> : <raison>`. Une dérogation vaut pour une règle et un commit ; sans raison, elle ne compte pas. Aucune option de l'outil, aucune variable d'environnement, aucune décision écrite dans `.apv/DECISIONS.json` par un agent ne lève un refus. `apv stack merge` affiche chaque dérogation utilisée.
- **Magasins fermés.** Le crochet Bash refuse toute commande qui nomme `apv/operator` ou `apv/reviews`, et le crochet d'écriture refuse `Write` et `Edit` dessous : on lit par `apv review show` et `apv rules check`.

Limites, dites franchement : ce sont des garde-fous, pas une sandbox. Un script écrit ailleurs puis lancé, une commande sous une forme que le crochet ne reconnaît pas, ou un processus lancé hors de Claude Code peuvent écrire ces fichiers ; l'outil compare des textes et ne décide jamais que des mots valent une validation ; les reçus et les relectures sont locaux à la machine où tourne le chef de projet (la fusion s'y fait aussi). Le champ `source` des crochets existe depuis les versions récentes de Claude Code : sans lui, rien n'est gardé, et seules comptent les maquettes déjà fusionnées. Côté GitHub, protéger la branche principale (PR obligatoire, pas de poussée directe) reste un réglage de l'opérateur.

## 4. Ce qui reste au chef de projet

| Règle | Pourquoi | Comment le chef de projet la vérifie |
|---|---|---|
| Rôle product : cohérence entre les écrans, maquettes qui partent de l'existant | sans cohérence, chaque écran devient un produit à part ; une maquette qui ignore l'existant se refait | la maquette part d'une capture de l'écran actuel et des composants partagés ; `apv:critique-design` la note avant l'opérateur ; `apv:product` relit la cohérence des parcours |
| Captures regardées avant fusion | l'outil prouve qu'elles existent, pas qu'on les a regardées | `apv:qa-fidelite` les compare à la maquette et le dit dans son rapport ; le chef de projet ouvre au moins celles des écrans changés |
| Maquette validée par l'opérateur avant tout écran nouveau ou changé | l'outil vérifie la couverture ; la validation est un acte humain | boucle `/apv:design`, validation par les mots de l'opérateur, versement par `apv design register` avec sa portée |
| Un seul composant par type d'élément, étendu plutôt que recopié | `apv reuse check` ne voit pas tout (un composant nouveau au nom différent) | consigne des implementers ; la relecture fidélité répond à « quel composant existant aurait dû servir ? » |
| Arborescence selon des conventions reconnues | `apv structure check` signale, n'applique jamais | plan de rangement proposé par l'architecte, validé par l'opérateur avant tout déplacement |
| Test instable examiné comme un bug possible du produit | l'outil refuse la fusion ; la cause demande une enquête | reproduire seul (`--repeat-each` 20 au plus), chercher d'abord une course ou une attente côté produit, puis côté test ; jamais relancer jusqu'au vert |
| Aucune promesse absolue ; textes humains et sourcés | une promesse (données, prix, publicité, support) peut se retourner contre le projet ; un texte qui sonne généré fait fuir | relecture `apv:product` (et `apv:dpo` pour les textes légaux) ; toute affirmation chiffrée a sa source vérifiée |
| Toute validation humaine d'une fonctionnalité du projet ancrée | la section 3 couvre APV3, pas les fonctionnalités du projet | point de la relecture sécurité : une validation lue sur un système que l'agent peut écrire est un constat haut |
| Serveurs arrêtés après usage | des serveurs d'aperçu et des piles oubliés occupent la machine et les ports | la suite complète arrête ce qu'elle a lancé ; `apv procs list` en fin de tâche, `apv procs stop`, `apv stacks idle-stop` ; jamais `kill` du parent |
| Vitesse sans retirer un garde-fou | accélérer ne doit jamais coûter une preuve | on réduit les suites complètes redondantes (`run.fullSuite`, preuve partagée), jamais un contrôle, une revue ou une règle |
| Une leçon devient une capacité générique | la mémoire du chef de projet ne suit pas dans un nouveau projet | section 6 |

## 5. Configuration : section `rules`

Facultative, lue à la base. Elle ajoute, elle ne retire jamais une règle :

```json
"rules": {
  "captures": { "viewports": ["desktop", "phone"], "themes": ["light", "dark"] },
  "requiredGates": [{ "id": "a11y", "command": ["npm", "run", "check:a11y"] }],
  "screens": ["src/views/**/*.vue"]
}
```

`captures.themes: ["light"]` seulement pour un projet sans thème sombre ; `tablet` s'ajoute aux largeurs. `requiredGates` : contrôles qu'un projet exige en plus de `reuse`, `code-map` et `structure` (reconnus par le début de leur commande). `screens` : fichiers d'écran que l'outil ne reconnaît pas seul. Une nouvelle capacité d'APV (par exemple une carte d'architecture vérifiée) s'ajoute à la liste des contrôles requis dans `src/rules/required.ts`.

`apv init` et `apv onboard` déclarent `reuse`, `structure` et `code-map` pour un projet web ; sur une configuration existante, ils listent les contrôles requis qui manquent, sans la modifier.

## 6. Une leçon devient une capacité

1. L'incident va dans le journal du pipeline du projet (`.apv/journal-pipeline.md`) : symptôme, cause, coût.
2. On l'écrit comme une règle générique, sans rien de propre au projet.
3. Si l'outil peut la vérifier, elle devient une règle de `apv rules check` ou un garde-fou d'un crochet, avec un test qui refuse et un test qui accepte ; sinon, elle va ici (section 4), dans la compétence du chef de projet et chez les agents concernés.
4. Elle entre dans ce document, puis dans le CHANGELOG.
