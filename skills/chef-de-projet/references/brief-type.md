# Modèle de consigne commune des implementers

À copier dans `.apv/brief.md` et à adapter au projet. Les passages entre chevrons sont à remplacer. Ce modèle généralise la consigne qui a servi à livrer le projet pilote.

```markdown
# Consigne commune des implementers (<nom du projet>)

Tu codes UNE tâche d'une spec de <nom du projet> (<description en une ligne : public, langue, contraintes>). Le chef de projet t'a confié la tâche, sa base et sa branche. Ne pose aucune question : décide en ingénieur senior et note tes choix dans ton rapport.

## Sources de vérité (dans cet ordre)
1. La tâche et ses critères dans `<chemin de la spec>` (`tasks[].description`, `allowedPaths`, `acceptanceIds`, `acceptance[]`) et la section `security`.
2. Les maquettes validées, référence ABSOLUE : `<chemins>` (liste et empreintes : `apv design list`). Reproduire fidèlement : structure, espacements, couleurs, typographies, états, thèmes clair et sombre, mobile et bureau, textes MOT POUR MOT.
3. Le modèle de données `.apv/data-model.md` et le registre des décisions.
4. Les notes de ta vague : `.apv/state/notes-<id de la spec>-vague-<n>.md` (données par le chef de projet).

## Démarrage
`git switch -c <branche de tâche> <base>` (reprise : si la branche existe déjà, `git switch <branche de tâche>`), puis le marqueur `.apv/state/task.json` (`{"spec": "<chemin de la spec>", "task": "<id>"}`, ignoré par Git, lu par le hook de rappel des chemins autorisés), puis `<installation des dépendances>`.

## Règles de code
- <règles du framework, par exemple Svelte 5 en runes, SvelteKit, form actions avec amélioration progressive, validation serveur>
- Identifiants en anglais, textes d'interface en <langue>. Aucun tiret cadratin ni demi-cadratin dans les textes. Aucune promesse absolue ou risquée. Noms d'entreprises fictifs.
- Aucune nouvelle dépendance sauf si la spec la liste ; versions exactes.
- Respecter `allowedPaths` ; tout fichier hors périmètre est modifié au minimum et signalé.
- Écritures idempotentes (bouton en cours, clé d'idempotence, unicité en base) et verrou optimiste sur les modifications.
- Styles propres à un composant dans son bloc ; styles partagés au strict nécessaire, dans une section commentée au nom de la tâche.
- Accessibilité : focus visible, rôles et libellés, `prefers-reduced-motion`, contrastes.

## Contrôles obligatoires avant de rendre la main (tous verts)
<liste exacte des commandes, par exemple : typage, lint, analyseur du framework, code mort, tests unitaires, build, intégration, navigateur>
Services : <pile locale, ports, variables à charger>. Ne jamais arrêter un service partagé.
Ressources partagées : toujours sous bail, une commande à la fois : `apv lock run <ressource> -- <commande>`.
Les tests « live » font leur propre remise à zéro et créent leurs propres utilisateurs.
Un contrôle rouge hors de ta tâche : corrige si trivial, sinon signale-le précisément ; ne le masque jamais.

## Git
- Ne réécris JAMAIS un commit déjà poussé : empile des commits propres.
- Travaille uniquement dans ton worktree, sur ta branche. Commits atomiques en <langue>, terminés par : `<ligne de co-auteur du projet>`.
- Ne pousse pas, ne fusionne pas, ne force jamais, ne modifie pas la branche principale. Aucun secret, aucun `.env`.

## Rapport final (moins de 300 mots)
Fichiers principaux, commits (hash), résultat de CHAQUE contrôle (commande, vert ou rouge, nombre de tests), critères couverts et comment, écarts à la maquette ou à la spec et pourquoi, points ouverts.
```
