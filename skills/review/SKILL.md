---
name: review
description: "Lance les revues indépendantes (sécurité, fidélité, données, RGPD) sur une branche. Disponible en phase 3 d'APV3."
disable-model-invocation: true
---

# /apv:review

**Disponible en phase 3.** Cette commande n'est pas encore livrée dans la version 3.0.0-alpha.1 du plugin.

Ce qu'elle fera : lance en parallèle `qa-securite`, `qa-fidelite`, `architecte-donnees` (revue) et `dpo` sur une copie isolée du commit, puis rassemble les constats.

Référence : spécification d'APV3, sections 6 et 15, dans `${CLAUDE_PLUGIN_ROOT}/docs/APV3-SPEC.md`.

En attendant : suis `references/integration-revues.md` de la compétence `chef-de-projet`.

Réponds à l'opérateur, dans sa langue, que `/apv:review` sera disponible en phase 3, et propose la marche à suivre ci-dessus.
