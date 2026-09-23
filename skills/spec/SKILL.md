---
name: spec
description: "Rédige et valide une spec APV (outil apv spec validate, minimum de sécurité recalculé). Disponible en phase 3 d'APV3."
disable-model-invocation: true
---

# /apv:spec

**Disponible en phase 3.** Cette commande n'est pas encore livrée dans la version 3.0.0-alpha.2 du plugin.

Ce qu'elle fera : lance l'agent `product`, puis `apv spec validate` jusqu'à `VALID` et présente la spec à l'opérateur.

Référence : spécification d'APV3, sections 6 et 15, dans `${CLAUDE_PLUGIN_ROOT}/docs/APV3-SPEC.md`.

En attendant : lance l'agent `apv:product` à la main, puis `apv spec validate <fichier>`.

Réponds à l'opérateur, dans sa langue, que `/apv:spec` sera disponible en phase 3, et propose la marche à suivre ci-dessus.
