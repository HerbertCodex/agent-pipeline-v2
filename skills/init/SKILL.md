---
name: init
description: "Nouveau projet APV : registre des décisions, configuration .apv/, agents et compétences pour le projet. Disponible en phase 3 d'APV3."
disable-model-invocation: true
---

# /apv:init

**Disponible en phase 3.** Cette commande n'est pas encore livrée dans la version 3.0.0-alpha.1 du plugin.

Ce qu'elle fera : crée le dossier `.apv/` (configuration, registre des décisions, `brief.md`, `state/`), propose un commit.

Référence : spécification d'APV3, sections 6 et 15, dans `${CLAUDE_PLUGIN_ROOT}/docs/APV3-SPEC.md`.

La commande ne figure pas au tableau des phases de la spec ; elle est rattachée à la phase 3 parce que `/apv:run` en dépend. En attendant : crée `.apv/` à la main (configuration, registre, `brief.md` à partir de `references/brief-type.md` de la compétence `chef-de-projet`, dossier `state/`, et `.apv/.gitignore` avec `state/*.log`, `state/task.json` et `receipts/` ; `apv quota` le crée ou le complète de lui-même).

Réponds à l'opérateur, dans sa langue, que `/apv:init` sera disponible en phase 3, et propose la marche à suivre ci-dessus.
