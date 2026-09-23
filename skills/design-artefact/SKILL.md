---
name: design-artefact
description: "Boucle de maquette avec l'opérateur : le designer produit une maquette HTML, le chef de projet la publie en artefact et relaie les retours, on itère jusqu'à une validation explicite, puis la maquette validée est versionnée comme référence (chemin, empreinte, décision au registre) et n'est plus jamais refaite automatiquement. À utiliser pour un nouvel écran, un nouvel état ou une nouvelle direction visuelle, et pour savoir quoi faire quand une maquette validée existe déjà."
---

# Design par artefact

La maquette se fait avec l'opérateur, comme sur le projet pilote : on lui montre, il réagit, on corrige, jusqu'à ce qu'il valide. Ensuite, elle ne bouge plus : c'est la référence absolue des implementers et de la revue de fidélité.

## 1. Avant d'ouvrir une boucle
- Une maquette validée couvre déjà l'écran ? Alors **pas de boucle** : les implementers codent depuis la référence. Refaire une maquette validée a coûté 30 à 60 minutes par spec au projet pilote et créé un risque d'écart (incident 22).
- On ouvre une boucle seulement pour un écran ou un état absent de la référence, une nouvelle direction visuelle, ou une demande explicite de l'opérateur.

## 2. La boucle
1. **Brief au designer** (agent `apv:designer`) : écran et états à couvrir, contraintes (spec, registre), système existant (jetons, composants de la maquette validée), public et langue.
2. **Version n** : le designer écrit `docs/design/brouillons/<ecran>-v<n>.html` (ou le dossier fixé par `.apv/config`), autonome, avec tous les états, les deux thèmes, mobile et bureau, textes réels. Il vérifie ses captures avant de remettre.
3. **Publication** : le chef de projet publie la version en artefact (outil Artifact quand il est disponible ; sinon, fichier servi en local avec son adresse, ou captures) et la montre à l'opérateur avec deux ou trois points précis à regarder.
4. **Retours** : cités mot pour mot au designer, qui produit la version n+1 (reprise du même agent par `SendMessage`, pour garder le contexte). Chaque version est un nouveau fichier ; aucune n'est écrasée.
5. **Validation** : seulement sur un accord explicite (« je valide », « c'est bon, on garde »). « Je valide sauf … » n'est pas une validation : la boucle continue sur les points cités. Pendant la boucle, le reste du travail avance si le quota le permet.

## 3. Verser la référence
1. Copie à l'identique de la version validée vers `docs/design/<ecran>-maquette-validee.html` (ou le chemin du projet).
2. Empreinte : `sha256sum <fichier>`.
3. Décision au registre : chemin, empreinte, date, citation de la validation de l'opérateur.
4. Commit dédié (« design : maquette validée <écran> »).
5. Les brouillons restent comme historique ; seule la référence fait foi.

## 4. Après
- Le fichier validé n'est jamais modifié. Une évolution validée plus tard produit un nouveau fichier et une nouvelle entrée au registre.
- Les implementers reproduisent la référence (structure, espacements, couleurs, typographies, états, thèmes, largeurs) et en copient les textes mot pour mot.
- La revue `qa-fidelite` compare l'application à la référence (captures 390 et 1280, clair et sombre, comparaison programmatique des textes).
- Un écart nécessaire (accessibilité, contraste, cible tactile) est signalé à l'opérateur comme « écart assumé » ; il décide. Quand c'est possible, on garde le rendu de la maquette et on corrige sans le changer (par exemple une zone cliquable invisible de 44 px).

## 5. Qualité d'une maquette
Tous les états (vide, chargement, erreur, succès), thèmes clair et sombre, 390 et 1280 px, focus visible, contrastes (4,5:1 texte, 3:1 interface), cibles tactiles de 44 px, `prefers-reduced-motion`, textes définitifs sans tiret cadratin ni demi-cadratin, aucune promesse absolue ou risquée, noms fictifs, identité de l'éditeur jamais inventée.
