---
name: onboard
description: "Projet existant ou projet V2 : analyse du dépôt, contrôles détectés, registre initial, création de .apv/ depuis pipeline.v2.json et .agent-pipeline/DECISIONS.json. Disponible en phase 4 d'APV3."
disable-model-invocation: true
---

# /apv:onboard

**Disponible en phase 4.** Cette commande n'est pas encore livrée dans la version 3.0.0-alpha.1 du plugin.

Ce qu'elle fera : analyse le dépôt, détecte les contrôles, reprend `pipeline.v2.json` et `.agent-pipeline/DECISIONS.json` d'un projet V2, crée `.apv/` et propose un commit (spec, section 14).

Référence : spécification d'APV3, sections 6 et 15, dans `${CLAUDE_PLUGIN_ROOT}/docs/APV3-SPEC.md`.

En attendant : l'outil V2 (version 2.0.0-alpha.8, voir `START-HERE.md`) reste utilisable pour l'analyse, et `.apv/` se crée à la main comme pour `/apv:init`.

Réponds à l'opérateur, dans sa langue, que `/apv:onboard` sera disponible en phase 4, et propose la marche à suivre ci-dessus.
