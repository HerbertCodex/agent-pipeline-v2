---
name: preview
description: "Met à jour l'aperçu vivant sur une branche et l'annonce à l'opérateur. Disponible en phase 2 d'APV3."
disable-model-invocation: true
---

# /apv:preview

**Disponible en phase 2.** Cette commande n'est pas encore livrée dans la version 3.0.0-alpha.1 du plugin.

Ce qu'elle fera : reconstruit l'aperçu vivant (base dédiée, données de démonstration, compte de démo) sur une branche avec `apv preview update <branche>`, puis annonce l'adresse, la branche et ce qui a changé.

Référence : spécification d'APV3, sections 6 et 15, dans `${CLAUDE_PLUGIN_ROOT}/docs/APV3-SPEC.md`.

En attendant : utilise le script d'aperçu du projet et annonce l'adresse, la branche et ce qui a changé (`references/reprise-environnement.md` de la compétence `chef-de-projet`).

Réponds à l'opérateur, dans sa langue, que `/apv:preview` sera disponible en phase 2, et propose la marche à suivre ci-dessus.
