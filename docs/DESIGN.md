# Design par artefact et maquettes validées

La maquette se fait **avec l'opérateur**, jusqu'à ce qu'il la valide ; ensuite elle devient la **référence absolue** du projet (spécification, principe 3). C'est la méthode qui a fonctionné sur le projet pilote « Toujours rien » : une page publiée en artefact, des retours, des corrections republiées au même lien, puis « je valide » et la maquette versée dans `docs/design/`. APV2 refaisait au contraire une maquette à chaque spec (incident 22 : 30 à 60 minutes perdues par spec, et un risque d'écart avec la maquette validée).

Quatre pièces :

| Pièce | Rôle |
|---|---|
| `/apv:design` | la boucle suivie par le chef de projet (compétence `skills/design/SKILL.md`) |
| agent `apv:designer` | propose les directions, écrit les versions de la maquette et remplit la grille de critique ; ne code pas l'application, ne valide rien |
| agent `apv:critique-design` | critique notée de chaque version avant présentation (grille `skills/design-artefact/references/grille-critique.md`) ; lecture seule |
| `apv design register \| list \| check` | verse la maquette validée, la retrouve, détecte une dérive ([CLI.md](CLI.md#apv-design)) |

## 1. Quand ouvrir une boucle

Seulement pour un écran, un état ou une direction visuelle **absents** des maquettes validées, ou sur demande de l'opérateur. Avant tout :

```bash
apv design list --screen agenda   # une maquette validée couvre-t-elle cet écran ?
apv design check                  # les références sont-elles intactes ?
```

Un écran couvert se code depuis la référence, sans nouvelle maquette.

Pour seulement juger une maquette existante (brouillon, maquette validée), sans boucle ni modification : `/apv:design critique <chemin>`, qui lance `apv:critique-design` et rend la décision du barème, la synthèse notée et les corrections priorisées.

## 2. La boucle

1. **Point de départ** : la marque (logo, palette, typographies, ton), les jetons et composants des maquettes validées, le registre des décisions, la spec de l'écran et la personne cible (une phrase : qui, situation, ce qu'elle sait, ce qu'elle veut).
2. **Direction avant détails** (nouveau produit, nouvel écran majeur, nouvelle direction visuelle) : 2 ou 3 directions distinctes sur `docs/design/brouillons/<nom>-directions.html`, chacune avec un nom, une phrase d'intention, une planche de jetons et un écran clé ; l'opérateur choisit avant tout détail. Pour l'évolution d'un écran existant, la continuité prime : pas de nouvelle direction.
3. **Page** : le designer écrit `docs/design/brouillons/<nom>.html`, toujours au même chemin, et garde une copie par version (`<nom>-v<n>.html`). HTML autonome, tous les états, thèmes clair et sombre, 390 et 1280 px, textes réels et définitifs, animations réelles. Son rapport contient la grille de critique remplie et la fiche d'animation.
4. **Critique** : `apv:critique-design` prend les captures, applique la grille (empreintes génériques, signature, typographie, couleur, rythme, états, animations, test des 5 secondes, textes, accessibilité) et rend un rapport noté. Un critère `bloquant` ou 3 empreintes génériques ou plus : retour au designer. Deux tours de critique au plus, puis la version est montrée avec les points ouverts.
5. **Publication** : le chef de projet charge la compétence `artifact-design` (exigée par l'outil Artifact), publie la page avec l'outil `Artifact` et note l'adresse dans `.apv/state/design-<nom>.md` ; il montre la page avec le rapport du critique joint.
6. **Retours** : un changement à la fois, captures vérifiées, puis republication **à la même adresse**. L'opérateur garde un seul lien du début à la fin.
7. **Validation** : uniquement par les mots explicites de l'opérateur (« je valide », « c'est bon, on garde »). Le chef de projet ne déclare jamais une maquette validée ; « je valide sauf … » relance la boucle sur les réserves.

## 3. Verser la maquette validée

```bash
apv design register docs/design/brouillons/agenda.html --name agenda --title "Agenda" \
    --screens "agenda,calendrier" --quote "je valide l'agenda" --artifact https://claude.ai/…
```

L'outil :
- copie le fichier vers `docs/design/agenda-validee.html` (dossier réglable, voir plus bas) ;
- calcule son sha256 ;
- inscrit au registre la décision `maquette-agenda-validee` : confirmée, source opérateur, citation exacte, enforcement `product`, valeur avec le chemin, l'empreinte, les écrans et l'adresse de l'artefact ;
- affiche les fichiers à commiter. Rien n'est commité à sa place.

Il **refuse** une citation vide ou une validation avec réserve : le pipeline n'invente jamais une approbation. Il refuse aussi d'écrire dans un registre qui a des modifications non commitées.

Puis :

```bash
git add -- docs/design/agenda-validee.html .apv/DECISIONS.json .apv/DECISIONS.md
git commit -m "design: maquette validée agenda" -- docs/design/agenda-validee.html .apv/DECISIONS.json .apv/DECISIONS.md
apv design check
```

La version versée est exactement celle que l'opérateur a vue en dernier : aucune retouche après sa validation.

## 4. Après le versement

- **Implementers** : reproduisent la référence (structure, espacements, couleurs, typographies, états, thèmes, largeurs) et en reprennent les textes mot pour mot.
- **Revue de fidélité** (`apv:qa-fidelite`) : trouve la référence d'un écran par `apv design list --screen <écran>`, puis compare captures (390 et 1280 px, clair et sombre) et textes (comparaison programmatique), et applique sur l'application réelle les sections D (états), E (animations, mouvement réduit) et F (test des 5 secondes) de la grille de critique.
- **Contrôle** : `apv design check` sort en `1` si un fichier validé a été modifié ou supprimé sans nouvel enregistrement. Le chef de projet le lance avant chaque PR ; un projet dont la machine a `apv` sur le PATH peut aussi le déclarer comme contrôle :
  ```json
  { "gates": [{ "id": "design", "command": ["apv", "design", "check"], "readOnly": true }] }
  ```
- **Évolution** : une nouvelle version validée par l'opérateur se verse de nouveau avec `apv design register --name agenda`. Le fichier est remplacé, la décision `maquette-agenda-validee-v2` remplace l'ancienne au registre (`supersedes`) et l'historique Git garde la version précédente.
- **Écart nécessaire** (accessibilité, contraste, cible tactile) : présenté à l'opérateur comme « écart assumé » ; il décide.

## 5. Leçons du projet pilote

- Aucune information au seul survol : aussi au focus clavier, et visible au toucher.
- Densité et rendu « pro » : listes serrées, hiérarchie typographique nette, pas de vide inutile.
- Codes couleur cohérents : une couleur, un sens, partout (statut par pastilles, couleur d'action pour ce qui est à faire, le reste neutre).
- Aucun tiret cadratin ni demi-cadratin dans les textes.
- Aucune promesse risquée (gratuité, données, publicité, délais, support).
- Noms fictifs pour les entreprises et les personnes de démonstration ; identité de l'éditeur jamais inventée.
- Mode sombre conçu, pas inversé : surfaces en paliers, accents réajustés pour le contraste.

## 6. Configuration

Section facultative de `.apv/config.json` :

```json
{ "design": { "dir": "docs/design" } }
```

`dir` est un dossier relatif au dépôt, sans espace, qui ne sort pas du dépôt. Il ne change que la destination des prochains versements : les maquettes déjà versées restent à l'emplacement enregistré au registre.

## 7. Projet existant

Une décision de maquette écrite avant l'outil (par exemple `maquette-appli-validee` du projet pilote, sans empreinte) apparaît dans `apv design list` avec l'état `sans empreinte` et n'est pas vérifiable par `apv design check`. Pour la rattacher, versez le fichier validé avec la **citation d'origine** de l'opérateur, recopiée telle quelle depuis le champ `sourceQuote` de la décision V2 (jamais une citation reformulée ou inventée) :

```bash
apv design register docs/design/appli-maquette-validee.html --name appli --quote "je valide les maquettes"
```

La nouvelle décision `maquette-appli-validee-v2` remplace l'ancienne et porte désormais le chemin (`docs/design/appli-validee.html`) et l'empreinte.

**Noms des fichiers du projet pilote.** « Toujours rien » a versé ses maquettes sous la forme `docs/design/<nom>-maquette-validee.html` (`appli-maquette-validee.html`, `accueil-maquette-validee.html`) ; l'outil les nomme `<nom>-validee.html`. La migration, une fois par maquette, dans une branche dédiée :

1. `apv design register docs/design/<nom>-maquette-validee.html --name <nom> --quote "<sourceQuote de maquette-<nom>-validee>"` : le contenu est copié à l'identique vers `docs/design/<nom>-validee.html`, l'empreinte est celle du fichier d'origine.
2. Remplacer les renvois à l'ancien nom (specs, `AGENTS.md`, `docs/design/README.md`, tests de fidélité) par le nouveau, puis `git rm docs/design/<nom>-maquette-validee.html` : un seul fichier de référence par maquette.
3. Un seul commit avec le nouveau fichier, le registre (JSON et Markdown), les renvois mis à jour et la suppression ; `apv design check` doit sortir en `0`.

Une maquette dont la décision V2 ne cite aucun fichier versé (par exemple une copie « à verser par une spec ») se verse de la même façon, depuis la copie figée que l'opérateur a validée, avec sa citation d'origine.
