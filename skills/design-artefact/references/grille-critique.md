# Grille de critique du design

Grille notée, valable pour toute stack et tout type d'interface (application, outil interne, site). Les noms de produits, polices, couleurs et bibliothèques cités (Tailwind, Inter, Playwright…) sont des **exemples** marqués comme tels : la règle est le critère, jamais l'outil. Elle condense les références de la compétence `apv:ui-design` (`anti-generic.md`, `motion.md`, `visual-identity.md`, `design-process.md`, `ux-laws.md`) en critères vérifiables.

Qui l'applique :
- `apv:designer` la remplit lui-même dans chaque rapport de version (auto-évaluation, preuves comprises) ;
- `apv:critique-design` l'applique en entier sur la maquette, de façon indépendante, avant toute présentation à l'opérateur ;
- `apv:qa-fidelite` applique les sections D (états), E (animations) et F (test des 5 secondes) sur l'application réelle.

« Beau » ne se décrète pas : chaque critère ci-dessous se tranche sur une **preuve observée**. Une impression sans preuve n'est pas un constat.

## 0. Mode d'emploi

### Notes
Chaque critère reçoit une note parmi trois :
- `conforme` : le critère est rempli, preuve à l'appui ;
- `à revoir` : défaut réel mais qui ne trompe ni ne bloque la personne cible ; il entre dans la liste des corrections ;
- `bloquant` : la personne cible comprend mal, ne peut pas agir, est exclue (accessibilité) ou voit une interface interchangeable.

Un critère qui n'a pas pu être vérifié est noté `non vérifié`, avec la raison (par exemple : pas de navigateur, cible non décrite). `non vérifié` n'est jamais `conforme`.

### Preuve
Chaque note, `conforme` compris, cite sa preuve :
- une **capture** : fichier et zone (`accueil-390-sombre.png`, bandeau du haut) ;
- ou un **élément cité** : texte exact entre guillemets, sélecteur CSS, jeton (`--accent`), valeur mesurée (contraste 3,1:1, durée 450 ms).

### Captures de référence
Chaque écran et chaque état du sélecteur de la maquette, à **390 × 844** et **1280 × 800**, en thème **clair** et **sombre** ; plus une capture du **premier écran seul** (sans défilement) pour le test des 5 secondes, et une passe en mouvement réduit pour la section E.

### Ordre
1. **F d'abord** : le test des 5 secondes se fait sur les captures seules, avant de lire le code, le brief ou le rapport du designer. Une fois qu'on sait à quoi sert l'écran, le test ne mesure plus rien.
2. Puis A, B, C, G et H sur les captures et le code, enfin D et E par le sélecteur d'états et le CSS.

### Barème de décision
- **Retour au designer** si au moins un critère est `bloquant`, **ou** si 3 empreintes génériques ou plus sont cochées en section A.
- Sinon la maquette est **présentable** ; les `à revoir` forment la liste des corrections, priorisée, sept au plus.

## A. Empreintes génériques

Ce qui fait dire « encore une interface faite par une IA ». Coche chaque empreinte observée, **avec sa preuve**. **3 empreintes cochées ou plus : on refait la direction, pas des retouches** (note `bloquant`). Une ou deux : `à revoir`, sauf si le brief de marque la justifie par la phrase « je l'ai choisie parce que le produit est ___ et cet élément communique ___ » ; une justification qui irait à n'importe quel produit ne compte pas.

Gabarit de site produit :
- [ ] A1. Fond blanc ou gris très clair par défaut, sans teinte choisie (exemples : `#f9fafb`, `#f3f4f6`), ou blanc et noir purs (`#fff`, `#000`).
- [ ] A2. Couleur principale d'un cadriciel ou d'une bibliothèque laissée telle quelle (exemples : bleu `#3B82F6`, violet `#8B5CF6`, émeraude `#10B981` de Tailwind ; thème par défaut d'une bibliothèque de composants).
- [ ] A3. Une seule police par défaut (exemples : Inter, Roboto, `system-ui`) sans police d'affichage ni contraste de graisses.
- [ ] A4. Le même conteneur centré pour toutes les sections (exemple : `max-w-7xl mx-auto px-4`), aucune variation de rythme.
- [ ] A5. En-tête centré : titre, sous-titre, deux boutons ; il irait à n'importe quel produit.
- [ ] A6. Trois cartes égales icône, titre, texte, quelle que soit la structure du contenu (égal, séquentiel ou hiérarchique).
- [ ] A7. Gabarits de page par défaut : tarifs en trois cartes avec badge « le plus populaire », bandeau d'appel coloré, pied de page en quatre colonnes de liens.

Tableau de bord et application :
- [ ] A8. Rangée de cartes de statistiques interchangeables (icône, grand nombre, pourcentage en vert) qui n'aide à aucune décision.
- [ ] A9. Conteneurs arrondis et ombrés partout, espacement uniforme qui efface la hiérarchie : tout a le même poids.
- [ ] A10. Icônes de remplissage : le même jeu générique posé sur chaque titre ou chaque bouton, émojis en guise d'icônes, illustrations de banque d'images.
- [ ] A11. Textes passe-partout qui iraient à n'importe quel produit (exemples : « Bienvenue sur votre tableau de bord », « Tout en un seul endroit », « Boostez votre productivité »).

« Premium sombre et halo » (le second cliché, celui des interfaces qui ont voulu échapper au premier) :
- [ ] A12. Fond presque noir teinté d'une seule couleur, choisi sans raison de marque.
- [ ] A13. Police d'affichage de la courte liste habituelle (exemples : Syne, Space Grotesk, Clash Display) sans justification.
- [ ] A14. Halos (`box-shadow: 0 0 Npx` couleur d'accent) sur boutons, cartes, champs ou focus.
- [ ] A15. Dégradé décoratif sans sens produit : orbe flou derrière l'en-tête, texte en dégradé, fond violet vers bleu.
- [ ] A16. Verre dépoli (`backdrop-filter`) sur la barre ou les cartes, sans besoin de lisibilité.

Mouvement :
- [ ] A17. `transition: all` avec la courbe `ease` par défaut partout, ou la même animation d'entrée (fondu et glissement) sur chaque bloc.

Dans le rapport : un tableau `Empreinte | Cochée | Preuve | Justification éventuelle`.

## B. Signature

Au moins **3 éléments que seul ce produit possède**, tirés du monde du sujet : ses matières, son vocabulaire, ses objets, ses gestes, ses rituels. Chacun est **nommé**, **localisé** (écran, zone) et **rattaché** à ce monde.

Test de substitution : remplace le nom du produit par celui d'un concurrent d'un autre domaine. Si l'élément convient toujours, ce n'est pas une signature.

Exemples (pour montrer le niveau attendu, jamais à recopier) :
- Exemple, cave à vin personnelle : fiches au grain et au cadre d'étiquette, fenêtre de garde dessinée comme une frise « à attendre, à boire, à passer », vocabulaire du caviste plutôt que du stock.
- Exemple, planning de chantier : retards signalés par une bande hachurée de signalisation, numéros de lot dans une typographie de plaque, jours de pluie marqués sur la frise.
- Exemple, suivi de lecture : progression en marque-page qui dépasse du bord de la fiche, citations composées dans une typographie de livre, « pages lues » plutôt que « progression ».
- Exemple, gestion de cabinet vétérinaire : silhouettes d'espèces comme repères de liste, courbe de poids en carnet de santé, ton qui parle de l'animal par son nom.

Règles :
- Une signature sert la compréhension ou le plaisir ; elle ne gêne jamais la lecture, le contraste ni l'accessibilité.
- **Un élément mémorable par écran** (celui qu'on retient après deux secondes) ; deux se font concurrence.
- Note : moins de 3 éléments pour un nouveau produit ou une nouvelle direction : `bloquant`. Pour l'évolution d'un écran existant, la signature validée est reprise ; la perdre est `à revoir`.

## C. Typographie, couleur, espace et rythme

### Typographie
- **Échelle** : 5 à 7 tailles d'une échelle déclarée en jetons (exemple : rapport 1,25), aucune taille hors échelle dans le CSS.
- **Contraste de graisses** : au moins deux graisses nettement distinctes (exemple : 400 et 650 ou plus) ; sur une capture floutée, le titre de l'écran se lit en premier.
- **Police d'affichage justifiée** par la phrase « choisie parce que le produit est ___ et elle communique ___ » ; les deux polices appartiennent au même monde visuel. Une police par défaut garde sa place si elle est choisie et justifiée, jamais par défaut.
- Texte courant lisible : au moins 16 px sur mobile, interligne de 1,4 à 1,6, lignes de 45 à 75 caractères au bureau ; chiffres tabulaires dans les colonnes de nombres.

### Couleur
- **Neutres choisis** : une rampe de gris teintée vers la couleur d'ancrage, surfaces en paliers, jamais `#000` ni `#fff` purs.
- **Accent réservé à un rôle** nommé (action principale, ou élément mémorable), sur 10 % de la surface au plus ; deux accents au plus.
- **Une couleur, un sens**, partout (statut, action, alerte) ; aucune information portée par la seule couleur.
- **Mode sombre conçu, pas inversé** : surfaces en paliers, accents réajustés pour le contraste, ombres remplacées par des bordures ou des surfaces plus claires.

### Espace et rythme
- **Échelle d'espacement** (exemple : base 4 ou 8 px, 5 à 7 pas), aucune valeur isolée.
- **Proximité** : l'écart entre deux groupes est nettement plus grand que l'écart dans un groupe ; les groupes se lisent sans cadre.
- **Densité adaptée à l'usage** : un outil de travail quotidien est serré (listes compactes, hiérarchie nette), une page de lecture respire. Du vide qui ne sert rien est un défaut, comme l'entassement.
- **Une action principale par écran**, isolée visuellement (loi de Von Restorff), au plus une secondaire de même niveau (loi de Hick) ; sur mobile, dans la moitié basse atteignable au pouce (loi de Fitts).
- **Test du flou** : sur la capture floutée, les trois premières zones vues sont, dans l'ordre, celles que l'écran veut faire voir.

## D. États

Chaque état applicable existe dans la maquette (sélecteur d'états) et dans l'application, à chaque largeur et dans chaque thème. Un état applicable absent : `bloquant`.

| État | Exigence |
|---|---|
| Vide | dit pourquoi c'est vide et propose la première action ; c'est souvent le premier écran que voit la cible, il porte le ton du produit |
| Chargement | squelette à la forme du contenu (pas un indicateur tournant seul) quand l'attente dépasse environ 300 ms ; aucun saut de mise en page à l'arrivée des données |
| Erreur | ce qui s'est passé, comment corriger, saisie conservée ; erreur de champ reliée au champ, focus sur la première erreur |
| Succès | confirmation visible à l'endroit de l'action, puis la suite possible ; jamais un écran qui finit sur « Terminé » sans suite |
| Désactivé | lisible (contraste suffisant), avec la raison visible ou annoncée ; jamais un bouton gris sans explication |
| Focus | visible sur chaque élément interactif, contraste de 3:1 au moins, jamais retiré sans remplacement |

## E. Animations

Le mouvement se justifie comme un texte : chaque animation a un **rôle**, sinon elle est retirée.

### Fiche d'animation
Une ligne par mouvement de la maquette, tenue par le designer et vérifiée par le critique :

| Mouvement | Déclencheur | Rôle | Durée | Courbe | Mouvement réduit |
|---|---|---|---|---|---|
| Exemple : ligne ajoutée à la liste | enregistrement réussi | continuité | 220 ms | `--ease-out` | apparition sans déplacement, fondu de 100 ms |
| Exemple : bouton pressé | appui | retour d'action | 90 ms | `--ease-out` | changement de fond sans échelle |

Rôles admis, et eux seuls :
- **retour d'action** : l'interface répond au geste (appui, envoi, bascule) ;
- **orientation** : dire où l'on est ou d'où vient un élément (panneau qui glisse depuis son déclencheur) ;
- **continuité** : relier un état A à un état B pour qu'on ne perde pas l'objet des yeux (ligne qui change de colonne) ;
- **plaisir** : un moment de pic mérité (première réussite, objectif atteint), rare, jamais sur un geste répété cent fois par jour.

Règles :
- **Animation sans rôle : refusée**, à retirer (`à revoir`, `bloquant` si elle retarde une tâche fréquente).
- **Chaque action importante a un retour visible** (enregistrer, envoyer, supprimer, changer un statut, glisser-déposer) : état pressé immédiat, puis résultat visible en moins de 400 ms (mise à jour optimiste, message, pastille qui change). Le retour n'a pas besoin d'être animé, il doit être visible. Action importante sans retour : `bloquant`.
- **Durées** : de 100 à 200 ms pour un retour d'action, de 200 à 300 ms pour un élément qui change, 400 ms au plus pour un panneau ou un changement de page ; la sortie est plus courte que l'entrée.
- **Courbes** : décélération pour ce qui entre, accélération pour ce qui sort, jamais `linear` sauf progression continue ; deux courbes et trois durées au plus, en jetons.
- **Propriétés** : `transform` et `opacity` ; jamais `width`, `height`, `top` ni `left` ; jamais `transition: all`.
- **Mouvement réduit** : chaque ligne de la fiche a sa variante sous `prefers-reduced-motion: reduce` (supprimée ou remplacée par un fondu court) ; aucune information portée par le seul mouvement.
- **Interdits** : défilement détourné, boucle sur du contenu, animation au seul survol sur mobile, plus d'une dizaine d'éléments animés en même temps, entrée en cascade sur chaque liste par défaut.
- Dans la maquette, les animations existent réellement en CSS (une animation seulement décrite ne se vérifie pas) et se déclenchent depuis le sélecteur d'états ou un bouton « rejouer ».

## F. Test des 5 secondes

La personne cible voit l'écran cinq secondes : comprend-elle ce que c'est, pour qui, et quoi faire ? Une interface soignée qui est mal comprise a échoué.

### Personne cible
Décrite en une phrase par la spec ou par l'opérateur : qui, dans quelle situation, ce qu'elle sait, ce qu'elle veut. Sans description : note `non vérifié`, et le chef de projet la demande. Jamais une cible inventée.

### Protocole
1. Avant de lire le code, le brief ou le rapport du designer, regarde la capture du **premier écran seul** (mobile, puis bureau), comme la personne cible, pressée.
2. Réponds par ses mots à trois questions : **à quoi sert cet écran** (et le produit), **pour qui**, **que ferais-je en premier**.
3. Compare à l'intention de la spec.
4. Cherche les **lectures erronées plausibles** : au moins deux contre-lectures qu'une personne pressée pourrait faire (rôle inversé, autre public, autre objet, autre action). Pour chacune, cite ce qui, dans le premier écran, l'exclut **explicitement** (titre, phrase, exemple de donnée, action).
5. **Échec** (`bloquant`) si une réponse diffère de l'intention, ou si une contre-lecture plausible n'est exclue par rien de visible.

**Exemple observé (anonymisé)** : une application de suivi de candidatures, faite pour les chercheurs d'emploi, a été prise par un testeur pour un outil de recrutement destiné aux entreprises. L'écran montrait des candidatures, des statuts et des noms d'entreprises, mais rien ne disait « vos candidatures, à vous qui cherchez un emploi » : la lecture inverse n'était exclue par rien. Corrections typiques : titre et sous-titre du point de vue de l'utilisateur (« Vos candidatures »), état vide qui s'adresse à la cible, verbes de son côté (« J'ai postulé », pas « Nouveau candidat »), données d'exemple du bon côté.

Autres contre-lectures fréquentes (exemples) : place de marché lue par l'acheteur comme un outil pour vendeurs ; application de suivi pour patients lue comme un outil de soignant ; budget personnel lu comme un logiciel comptable d'entreprise ; outil interne lu comme un site public.

Dans le rapport : un tableau `Écran | Largeur | À quoi sert | Pour qui | Quoi d'abord | Attendu | Contre-lectures et ce qui les exclut | Note`.

Limite honnête : un agent simule la personne cible, ce n'est pas un test utilisateur. Quand l'opérateur le peut, un vrai test de 5 secondes avec une personne de la cible vaut mieux ; son résultat prime.

## G. Textes

- **Du point de vue de l'utilisateur** : « Vos candidatures », pas « Gestion des candidatures » ; ce qu'il obtient, pas ce que fait le système.
- **Boutons qui disent ce qui va se passer** : « Enregistrer la dépense », pas « Valider » ni « Soumettre ».
- **Aucun jargon interne** : pas de nom de table, de code de statut, de module, d'identifiant technique ni de terme d'équipe (exemples : « entité », « synchronisation », « workflow », « slug ») là où l'utilisateur a son propre mot.
- Un même objet a le même nom partout ; les erreurs disent quoi faire, en langage courant.
- Langue de l'opérateur ; aucun tiret cadratin ni demi-cadratin ; aucune promesse absolue ou risquée ; noms fictifs ; identité de l'éditeur jamais inventée.
- Preuve : le texte cité mot pour mot et sa proposition de remplacement.

## H. Accessibilité minimale

- Contrastes : 4,5:1 pour le texte, 3:1 pour les éléments d'interface et les graphiques, dans les deux thèmes, mesurés sur les jetons.
- Focus visible, ordre de tabulation logique ; nom accessible de chaque bouton, lien, champ et icône ; étiquette visible pour chaque champ (un texte indicatif n'est pas une étiquette).
- Cibles tactiles de 44 px sur mobile ; aucun défilement horizontal à 390 px.
- Aucune information au seul survol ni par la seule couleur ; `lang` du document ; titres dans l'ordre.
- `prefers-reduced-motion` respecté (section E).

Un défaut qui exclut une partie de la cible (contraste insuffisant du texte principal, action inaccessible au clavier) est `bloquant`.

## Rapport

1. En-tête : maquette (chemin, version, sha256 court), tour de critique (`1/2` ou `2/2`), personne cible, dossier des captures, outil de capture (ou « aucun navigateur : critique sur le code »).
2. Synthèse : un tableau `Section | Note | Preuve principale`, de A à H, puis la **décision** selon le barème (retour au designer ou présentable) et le nombre d'empreintes cochées.
3. Détail par section, avec les tableaux demandés en A, E et F.
4. **Corrections priorisées**, sept au plus : d'abord les `bloquant`, puis la compréhension (F, G), puis les empreintes (A) et la signature (B), puis le reste. Chacune : quoi, où, critère, et comment vérifier que c'est corrigé.
