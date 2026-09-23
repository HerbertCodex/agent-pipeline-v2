---
name: design
description: "Boucle de maquette par artefact avec l'opérateur jusqu'à validation, puis versionnement de la maquette validée. Disponible en phase 2 d'APV3."
disable-model-invocation: true
---

# /apv:design

**Disponible en phase 2.** Cette commande n'est pas encore livrée dans la version 3.0.0-alpha.1 du plugin.

Ce qu'elle fera : lance l'agent `designer`, publie chaque version en artefact, itère jusqu'à la validation explicite de l'opérateur, puis verse la maquette validée comme référence.

Référence : spécification d'APV3, sections 6 et 15, dans `${CLAUDE_PLUGIN_ROOT}/docs/APV3-SPEC.md`.

En attendant : suis la compétence `design-artefact` à la main avec l'agent `apv:designer`.

Réponds à l'opérateur, dans sa langue, que `/apv:design` sera disponible en phase 2, et propose la marche à suivre ci-dessus.
