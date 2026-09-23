---
name: design
description: "Boucle de maquette par artefact avec l'opérateur : partir de la marque et des maquettes validées, publier la page avec l'outil Artifact, appliquer ses retours un par un en republiant à la même adresse, attendre sa validation explicite, puis verser la maquette avec apv design register (citation exacte, empreinte, décision au registre) et la commiter. À utiliser pour un écran, un état ou une direction visuelle absents des maquettes validées, ou quand l'opérateur demande de revoir une maquette."
argument-hint: "[nom de l'écran ou de la maquette]"
allowed-tools: Read Glob Grep Write Edit Skill Agent SendMessage Artifact Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js design*) Bash(apv design*) Bash(git status*) Bash(git log*) Bash(git diff*) Bash(git add*) Bash(git commit*) Bash(sha256sum*)
---

# /apv:design

Tu es le chef de projet. Tu mènes la boucle de maquette avec l'opérateur, comme sur le projet pilote : tu lui montres une page publiée, il réagit, tu corriges, tu republies, jusqu'à ce qu'il dise qu'il valide. Ensuite la maquette est versée dans le dépôt et devient la **référence absolue** : les implementers la reproduisent mot pour mot, la revue de fidélité compare l'application à ce fichier.

Dans ce document, `apv` désigne `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` (ou `apv` s'il est sur le PATH). Sujet demandé : `$ARGUMENTS`.

## 1. Avant d'ouvrir une boucle
1. `apv design list` (et `apv design list --screen <écran>`) : une maquette validée couvre déjà l'écran ? Alors **pas de boucle** : on code depuis la référence (incident 22 : refaire une maquette validée a coûté 30 à 60 minutes par spec et créé des écarts). On ouvre une boucle seulement pour un écran ou un état absent, une nouvelle direction visuelle, ou une demande explicite de l'opérateur.
2. `apv design check` : si une référence a dérivé (fichier modifié sans nouvel enregistrement), signale-le à l'opérateur avant tout ; la référence est la version enregistrée (`git log -- <fichier>`).
3. Rassemble le point de départ : la marque (logo, palette, typographies, ton), les jetons et composants des maquettes validées, le registre des décisions (palette, textes validés, écarts assumés), la spec de l'écran. Une nouvelle direction visuelle ou une nouvelle palette est une décision de l'opérateur, jamais la tienne.

## 2. Produire la page
- Confie la version au sous-agent `apv:designer` (brief : écran, états, contraintes, système existant, public, langue, chemin du brouillon), ou écris-la toi-même pour un petit changement. Le brouillon publié garde toujours le même chemin, `docs/design/brouillons/<nom>.html` ; chaque version est aussi copiée en `docs/design/brouillons/<nom>-v<n>.html`, jamais écrasée.
- **Charge la compétence `artifact-design` avant d'écrire ou de publier la page** : l'outil Artifact l'exige (contrat de page : titre, jetons de couleur sur `:root`, mode sombre, bibliothèques autorisées, largeur mobile). La marque du projet prime sur ses choix esthétiques par défaut.
- Exigences de la page, vérifiées sur des captures avant chaque publication :
  - thèmes **clair et sombre**, le sombre conçu à part (section 5) ;
  - **390 px et 1280 px** sans défilement horizontal ;
  - tous les états (vide, chargement, erreur, succès, dialogues, menus), avec un sélecteur d'écran ou d'état en haut si la maquette en couvre plusieurs ;
  - textes réels et définitifs dans la langue de l'opérateur, car ils seront repris mot pour mot ;
  - focus visible, contrastes 4,5:1 (texte) et 3:1 (interface) dans les deux thèmes, cibles tactiles de 44 px, `prefers-reduced-motion`.

## 3. Publier et itérer
1. **Publication** : outil `Artifact`, `file_path` = le brouillon. Note l'adresse obtenue et le numéro de version dans `.apv/state/design-<nom>.md`. Montre la page à l'opérateur avec deux ou trois points précis à regarder.
2. **Retours** : cite ses mots exacts. Traite **un changement à la fois** : applique-le, vérifie les captures, garde la copie `-v<n>`, puis **republie à la même adresse** (même `file_path` dans la session ; après une reprise, passe aussi `url` avec l'adresse notée). Jamais une nouvelle adresse par version : l'opérateur garde un seul lien.
3. Quand plusieurs retours arrivent ensemble, fais-en une liste numérotée, applique-les dans l'ordre et dis lesquels sont faits à chaque republication.
4. Pendant la boucle, le reste du travail avance si le quota le permet.

## 4. Validation et versement
- **Tu ne déclares jamais une maquette validée.** Seuls les mots explicites de l'opérateur valident (« je valide », « c'est bon, on garde »). Un « j'aime bien », un silence ou « je valide sauf … » ne valident rien : la boucle continue sur les réserves.
- La version versée est exactement celle que l'opérateur a vue en dernier. Aucune retouche après validation, même d'un espace : sinon ce n'est plus ce qu'il a validé.
- Verse-la :
  ```
  apv design register docs/design/brouillons/<nom>.html --name <nom> --title "<titre>" \
      --screens <écran1>,<écran2> --quote "<ses mots exacts>" --artifact <adresse de l'artefact>
  ```
  L'outil copie le fichier vers `docs/design/<nom>-validee.html` (dossier réglable par `design.dir` dans `.apv/config.json`), calcule le sha256 et inscrit la décision `maquette-<nom>-validee` (confirmée, source opérateur, citation exacte). Il refuse une citation vide ou une validation avec réserve. Un nouveau versement d'une maquette déjà versée ajoute `maquette-<nom>-validee-v<n>`, qui remplace l'ancienne décision.
- Commite exactement les fichiers affichés par l'outil (maquette, registre JSON et Markdown), dans un commit dédié `design: maquette validée <nom>`. Les brouillons suivent la règle du projet (commités comme historique, ou laissés hors du dépôt).
- `apv design check` doit sortir en `0`.
- Annonce à l'opérateur : fichier, empreinte courte, décision, commit, et la suite (les écrans concernés seront codés depuis cette référence).

## 5. Leçons du projet pilote
- **Aucune information au seul survol.** Ce qui apparaît au survol (action de ligne, infobulle, détail) existe aussi au focus clavier et reste accessible au toucher (sur mobile : toujours visible).
- **Densité et rendu « pro ».** Un outil sobre (références citées par l'opérateur : Linear, Notion) : listes serrées, hiérarchie typographique nette, espacements réguliers, pas de vide inutile (« trop d'espace » a coûté une itération). Leviers dans l'ordre : typographie, hiérarchie et densité, finition, palette.
- **Codes couleur cohérents.** Une couleur a un seul sens, partout : le statut par pastilles, la couleur d'action pour ce qui est à faire, le reste neutre. Pas d'effet « sapin de Noël ». Même bouton principal partout. Texte sur fond pâle avec des jetons d'encre dédiés qui tiennent 4,5:1.
- **Aucun tiret cadratin ni demi-cadratin** dans les textes de la page.
- **Aucune promesse risquée** : rien d'absolu sur la gratuité, les données, la publicité, les délais ou le support (« gratuit pendant la bêta », pas « gratuit pour toujours »).
- **Noms fictifs** pour les entreprises, les personnes et les adresses de démonstration ; identité de l'éditeur jamais inventée (champ à compléter laissé visible).
- **Mode sombre conçu, pas inversé** : surfaces en paliers, couleurs d'accent réajustées pour le contraste, ombres remplacées par des bordures ou des surfaces plus claires, illustrations vérifiées sur fond sombre.
- La référence est absolue : un écart nécessaire plus tard (accessibilité, contraste) est présenté à l'opérateur comme « écart assumé », et il décide.

## 6. Sans outil Artifact
Si l'outil Artifact n'est pas disponible, sers le brouillon en local et donne l'adresse, ou envoie les captures 390 et 1280 en clair et en sombre. Le reste de la boucle ne change pas.

Réponds à l'opérateur dans sa langue, en phrases courtes, sans tiret cadratin ni demi-cadratin.
