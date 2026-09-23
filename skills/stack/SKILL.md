---
name: stack
description: "Fusionne une pile de PR dans l'ordre (re-cible, vérifie chaque base, fusionne, s'arrête à la première anomalie), uniquement sur ordre explicite de l'opérateur. Disponible en phase 3 d'APV3."
disable-model-invocation: true
---

# /apv:stack

**Disponible en phase 3.** Cette commande n'est pas encore livrée dans la version 3.0.0-alpha.2 du plugin.

Ce qu'elle fera : re-cible, vérifie la base de chaque PR juste avant de la fusionner, fusionne dans l'ordre et s'arrête à la première anomalie, sans jamais masquer une sortie (incident 30).

Référence : spécification d'APV3, sections 6 et 15, dans `${CLAUDE_PLUGIN_ROOT}/docs/APV3-SPEC.md`.

En attendant, et seulement sur ordre explicite de l'opérateur : suis la procédure de `references/livraison-pile.md` (compétence `chef-de-projet`), une PR à la fois.

Réponds à l'opérateur, dans sa langue, que `/apv:stack` sera disponible en phase 3, et propose la marche à suivre ci-dessus.
