---
name: design-artefact
description: "Boucle de maquette avec l'opérateur : le designer produit une maquette HTML, le chef de projet la publie en artefact et relaie les retours, on itère jusqu'à une validation explicite, puis la maquette validée est versionnée comme référence (chemin, empreinte, décision au registre) et n'est plus jamais refaite automatiquement. À utiliser pour un nouvel écran, un nouvel état ou une nouvelle direction visuelle, et pour savoir quoi faire quand une maquette validée existe déjà."
---

# Design par artefact

La maquette se fait avec l'opérateur, comme sur le projet pilote : on lui montre, il réagit, on corrige, jusqu'à ce qu'il valide. Ensuite, elle ne bouge plus : c'est la référence absolue des implementers et de la revue de fidélité.

Le chef de projet mène la boucle avec la commande `/apv:design` (publication par l'outil Artifact, versement par `apv design register`). Ce document en est le résumé pour le designer et les autres rôles.

## 1. Avant d'ouvrir une boucle
- Une maquette validée couvre déjà l'écran (`apv design list --screen <écran>`) ? Alors **pas de boucle** : les implementers codent depuis la référence. Refaire une maquette validée a coûté 30 à 60 minutes par spec au projet pilote et créé un risque d'écart (incident 22).
- On ouvre une boucle seulement pour un écran ou un état absent de la référence, une nouvelle direction visuelle, ou une demande explicite de l'opérateur.

## 2. La boucle
1. **Brief au designer** (agent `apv:designer`) : écran et états à couvrir, contraintes (spec, registre), système existant (jetons, composants de la maquette validée), public et langue.
2. **Version n** : le designer écrit le brouillon publié `docs/design/brouillons/<ecran>.html` (toujours le même chemin) et sa copie `docs/design/brouillons/<ecran>-v<n>.html`, autonome, avec tous les états, les deux thèmes, mobile et bureau, textes réels. Il vérifie ses captures avant de remettre.
3. **Publication** : le chef de projet charge la compétence `artifact-design`, publie le brouillon avec l'outil Artifact et republie chaque version **à la même adresse** (sinon, fichier servi en local avec son adresse, ou captures). Il la montre à l'opérateur avec deux ou trois points précis à regarder.
4. **Retours** : cités mot pour mot au designer, un changement à la fois, qui produit la version n+1 (reprise du même agent par `SendMessage`, pour garder le contexte). Chaque version garde sa copie `-v<n>` ; aucune n'est écrasée.
5. **Validation** : seulement sur un accord explicite (« je valide », « c'est bon, on garde »). « Je valide sauf … » n'est pas une validation : la boucle continue sur les points cités. Pendant la boucle, le reste du travail avance si le quota le permet.

## 3. Verser la référence
1. Seulement après les mots explicites de l'opérateur, sur la version exacte qu'il a vue en dernier :
   `apv design register <brouillon> --name <ecran> --quote "<ses mots exacts>" [--title "…"] [--screens a,b] [--artifact <adresse>]`.
2. L'outil copie le fichier vers `docs/design/<ecran>-validee.html` (dossier fixé par `design.dir` dans `.apv/config.json`), calcule son sha256 et inscrit au registre la décision `maquette-<ecran>-validee` : confirmée, source opérateur, citation exacte, chemin et empreinte. Sans citation, ou avec une validation sous réserve, il refuse : le pipeline n'invente jamais une approbation.
3. Commit dédié des fichiers qu'il affiche (« design: maquette validée <écran> »), puis `apv design check`.
4. Les brouillons restent comme historique ; seule la référence fait foi.

## 4. Après
- Le fichier validé n'est jamais retouché à la main (`apv design check` le signale). Une évolution validée plus tard est versée de nouveau par `apv design register` : nouvelle empreinte et nouvelle décision `maquette-<ecran>-validee-v<n>` qui remplace l'ancienne ; l'historique Git garde la version précédente.
- Les implementers reproduisent la référence (structure, espacements, couleurs, typographies, états, thèmes, largeurs) et en copient les textes mot pour mot.
- La revue `qa-fidelite` trouve la référence d'un écran par `apv design list --screen <écran>` et compare l'application à ce fichier (captures 390 et 1280, clair et sombre, comparaison programmatique des textes).
- Un écart nécessaire (accessibilité, contraste, cible tactile) est signalé à l'opérateur comme « écart assumé » ; il décide. Quand c'est possible, on garde le rendu de la maquette et on corrige sans le changer (par exemple une zone cliquable invisible de 44 px).

## 5. Qualité d'une maquette
Tous les états (vide, chargement, erreur, succès), thèmes clair et sombre, 390 et 1280 px, focus visible, contrastes (4,5:1 texte, 3:1 interface), cibles tactiles de 44 px, `prefers-reduced-motion`, textes définitifs sans tiret cadratin ni demi-cadratin, aucune promesse absolue ou risquée, noms fictifs, identité de l'éditeur jamais inventée.

Leçons du projet pilote (détail : section 5 de `/apv:design`) : aucune information au seul survol ; densité et rendu « pro » ; une couleur, un sens, partout ; mode sombre conçu, pas inversé.
