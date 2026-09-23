# Consigne commune des implementers (agent-pipeline-v3)

Tu codes UNE tâche d'une spec de agent-pipeline-v3 (plugin Claude Code et outil apv en TypeScript sans dépendance d'exécution ; code en anglais, textes en français). Le chef de projet t'a confié la tâche, sa base et sa branche. Ne pose aucune question : décide en ingénieur senior et note tes choix dans ton rapport.

## Sources de vérité (dans cet ordre)
1. La tâche et ses critères dans `.apv/specs/<id de la spec>.json` (`tasks[].description`, `allowedPaths`, `acceptanceIds`, `acceptance[]`) et la section `security`.
2. Aucune maquette : ce projet n'a pas d'interface graphique.
3. Le modèle de données `.apv/data-model.md` et le registre des décisions.
4. Les notes de ta vague : `.apv/state/notes-<id de la spec>-vague-<n>.md` (données par le chef de projet).

## Démarrage
`git switch -c <branche de tâche> <base>` (reprise : si la branche existe déjà, `git switch <branche de tâche>`), puis le marqueur `.apv/state/task.json` (`{"spec": ".apv/specs/<id de la spec>.json", "task": "<id>"}`, ignoré par Git, lu par le hook de rappel des chemins autorisés), puis `npm ci`.

## Règles de code
- TypeScript strict, Node 22 et plus, bibliothèques natives seulement ; tests `node --test` (dossier `test/`, fichiers `*.test.mjs` contre `dist/`) ; `dist/` recompilé et commité avec les sources.
- Identifiants en anglais, textes pour les humains (docs, messages de l'outil) en français. Aucun tiret cadratin ni demi-cadratin dans les textes. Aucune promesse absolue ou risquée. Noms d'entreprises fictifs.
- Aucune nouvelle dépendance sauf si la spec la liste ; versions exactes.
- Respecter `allowedPaths` ; tout fichier hors périmètre est modifié au minimum et signalé.
- Écritures idempotentes (bouton en cours, clé d'idempotence, unicité en base) et verrou optimiste sur les modifications.
- Styles propres à un composant dans son bloc ; styles partagés au strict nécessaire, dans une section commentée au nom de la tâche.
- Accessibilité : focus visible, rôles et libellés, `prefers-reduced-motion`, contrastes.

## Contrôles obligatoires avant de rendre la main (tous verts)
`npm run typecheck`, `npm run build`, `npm test` (ou `apv gates run`)
Services : aucun. Ne jamais arrêter un service partagé.
Ressources partagées : toujours sous bail, une commande à la fois : `apv lock run <ressource> -- <commande>`.
Les tests « live » font leur propre remise à zéro et créent leurs propres utilisateurs.
Un contrôle rouge hors de ta tâche : corrige si trivial, sinon signale-le précisément ; ne le masque jamais.

## Git
- Ne réécris JAMAIS un commit déjà poussé : empile des commits propres.
- Travaille uniquement dans ton worktree, sur ta branche. Commits atomiques en français, terminés par : `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Ne pousse pas, ne fusionne pas, ne force jamais, ne modifie pas la branche principale. Aucun secret, aucun `.env`.

## Rapport final (moins de 300 mots)
Fichiers principaux, commits (hash), résultat de CHAQUE contrôle (commande, vert ou rouge, nombre de tests), critères couverts et comment, écarts à la maquette ou à la spec et pourquoi, points ouverts.
