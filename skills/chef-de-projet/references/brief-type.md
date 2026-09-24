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
1. `apv gates run --stage task --base <base>` : les contrôles rapides déclarés dans `.apv/config.json` (<par exemple : typage, lint, analyseur du framework, code mort, tests unitaires, build>). Les contrôles `"stage": "full"` (<par exemple : suite navigateur complète>) sont « réservés à la suite complète » : tu ne les lances pas ; le chef de projet les passe sur la tête intégrée de chaque vague.
   <si le contrôle navigateur déclare `affected` : l'étape 1 lance déjà les tests concernés par tes changements (ligne « ciblé ») ; un reçu ciblé ne prouve jamais la suite complète>
2. Tes tests navigateur seulement (si le contrôle navigateur n'a pas de commande `affected`) : `apv lock run e2e -- <commande du projet, par exemple npx playwright test> <fichiers e2e que tu as créés ou modifiés>`. Aucun fichier e2e touché : rien à lancer. Jamais la suite navigateur entière.
3. Test instable : répéter seulement le test en cause (`<fichier>:<ligne>` ou `-g "<titre>"`), `--repeat-each` borné à 20 au plus, sous `apv lock run e2e` ; jamais un fichier entier répété sous le verrou. Cause la plus fréquente : un clic pendant une animation ; attendre l'état stable, pas un délai fixe.
<projet à interface : tests navigateur en mouvement réduit par défaut (Playwright : `use: { reducedMotion: 'reduce' }`) ; seuls les tests d'animation gardent leur réglage>
<projet sans contrôle marqué full : `apv gates run --stage task` exécute tout, suite navigateur comprise ; projet sans contrôle déclaré : liste exacte des commandes>
Services : <pile locale, ports, variables à charger>. Ne jamais arrêter un service partagé.
Ressources partagées : toujours sous bail, une commande à la fois : `apv lock run <ressource> -- <commande>`.
Les tests « live » font leur propre remise à zéro et créent leurs propres utilisateurs.
Un contrôle rouge hors de ta tâche : corrige si trivial, sinon signale-le précisément ; ne le masque jamais.

## Git
- Ne réécris JAMAIS un commit déjà poussé : empile des commits propres.
- Travaille uniquement dans ton worktree, sur ta branche. Commits atomiques en <langue>, terminés par : `<ligne de co-auteur du projet>`.
- Ne pousse pas, ne fusionne pas, ne force jamais, ne modifie pas la branche principale. Aucun secret, aucun `.env`.

## Rapport final (moins de 300 mots)
Fichiers principaux, commits (hash), résultat de CHAQUE contrôle (commande, vert ou rouge, nombre de tests ; contrôles réservés à la suite complète nommés comme tels, contrôles ciblés nommés « ciblé » ; fichiers e2e lancés), critères couverts et comment, écarts à la maquette ou à la spec et pourquoi, points ouverts.
```
