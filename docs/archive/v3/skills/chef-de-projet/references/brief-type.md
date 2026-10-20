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
- **Lire la carte de l'architecture en premier** (`docs/carte-architecture.md`) : couches, arborescence commentée, conventions de la pile, points d'entrée. Un nouveau fichier de code va dans le sous-dossier de sa fonctionnalité, jamais dans un dossier à plat (le contrôle `structure` le refuse) ; un dossier, une route principale ou un point d'entrée créé reçoit son rôle en une ligne dans le bloc « Rôles » de la carte, dans la même tâche. Les parties générées de la carte ne se modifient pas à la main.
- **Réutiliser avant de créer.** Lire ensuite la carte du code `.apv/code-map.md` avant de créer un composant, un module ou une route, puis chercher son équivalent dans les dossiers de composants partagés (<par exemple src/lib/components/**, primitives dans src/lib/components/ui/**>). Réutiliser l'existant ou l'étendre de façon générique (paramètre, variante) ; jamais de copie propre à une fonctionnalité ; un élément utilisé par deux fonctionnalités devient partagé et paramétrable, et ses copies sont retirées dans le même changement. Tout nouveau composant d'interface est justifié dans le rapport ; ce que le changement rend inutile est retiré dans le même changement.
- Éléments natifs réservés aux composants partagés : <select, dialog, datalist, et leur composant : par exemple `<select>` -> Select.svelte>. Primitives de la feuille globale (<par exemple src/app.css : .btn, .input, .panel>) utilisées telles quelles, jamais redéfinies dans un style local : une variante manquante s'ajoute à la primitive ou au composant partagé.
- Valeurs insécables en <langue> : heures, dates, montants, nombres et unités avec une espace insécable (`&nbsp;`, `\u00a0`) ou fine insécable (`\u202f`) : « 14 h 47 », « 12 € », « 30 septembre ».
- La carte du code se lit, elle ne se commite jamais dans une tâche : l'intégration la régénère une fois par vague (`apv map`) ; `apv scope check` la signale hors périmètre.
- Styles propres à un composant dans son bloc ; styles partagés au strict nécessaire, dans une section commentée au nom de la tâche.
- Accessibilité : focus visible, rôles et libellés, `prefers-reduced-motion`, contrastes.
- <projet web qui déclare la section `web`> Qualité web des pages publiques : `<title>` et meta description présents et uniques, canonical absolu vers la page, `lang`, JSON-LD valide et fidèle au contenu visible, images dimensionnées, image principale jamais en `loading="lazy"`, polices préchargées sans décalage. Le contrôle `apv web audit` de la suite complète le mesure (Lighthouse médian, seuils de `web.thresholds`) : jamais de Lighthouse lancé à la main, jamais un seuil baissé (compétence `apv:web-qualite`).

## Contrôles obligatoires avant de rendre la main (tous verts)
1. `apv gates run --stage task --base <base>` : les contrôles rapides déclarés dans `.apv/config.json` (<par exemple : typage, lint, analyseur du framework, code mort, tests unitaires, build>, et `reuse` : blocs copiés, éléments natifs réservés, primitives redéfinies ; `code-map`, carte du code à jour, est réservé à la suite complète). Un contrôle `reuse` rouge se corrige en réutilisant ou en factorisant, jamais en baissant sa gravité ni en élargissant `reuse.ignore`. Les contrôles `"stage": "full"` (<par exemple : suite navigateur complète>) sont « réservés à la suite complète » : tu ne les lances pas ; le chef de projet les passe sur la tête intégrée de chaque vague.
   <si le contrôle navigateur déclare `affected` : l'étape 1 lance déjà les tests concernés par tes changements (ligne « ciblé ») ; un reçu ciblé ne prouve jamais la suite complète>
2. Tes tests navigateur seulement (si le contrôle navigateur n'a pas de commande `affected`) : `apv lock run e2e -- <commande du projet, par exemple npx playwright test> <fichiers e2e que tu as créés ou modifiés>`. Aucun fichier e2e touché : rien à lancer. Jamais la suite navigateur entière.
3. Test instable : répéter seulement le test en cause (`<fichier>:<ligne>` ou `-g "<titre>"`), `--repeat-each` borné à 20 au plus, sous `apv lock run e2e` ; jamais un fichier entier répété sous le verrou. Cause la plus fréquente : un clic pendant une animation ; attendre l'état stable, pas un délai fixe.
4. Tests e2e stables par construction : attendre un fait observable (réponse réseau, élément, état, par une assertion qui réessaie), jamais une durée fixe (`waitForTimeout`, `setTimeout`, `sleep`, délai arbitraire raccourci) ; l'horloge contrôlée (`page.clock`) pour ce qui dépend du temps ; des données propres à chaque test (noms uniques par test et par répétition), jamais partagées entre tests. <si un contrôle déclare `repeatChanged` : `apv gates run --base <base>` répète tes fichiers de test modifiés ; « échoue X fois sur N » se corrige dans le test, jamais par une relance>
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
Fichiers principaux, commits (hash), réutilisation (pour chaque composant, module ou route créé ou modifié : l'entrée de `.apv/code-map.md` réutilisée ou étendue, ou pourquoi aucune ne convenait ; ce qui a été retiré), placement (chaque fichier de code créé, son dossier et pourquoi), résultat de CHAQUE contrôle (commande, vert ou rouge, nombre de tests ; contrôles réservés à la suite complète nommés comme tels, contrôles ciblés nommés « ciblé » ; fichiers e2e lancés), critères couverts et comment, écarts à la maquette ou à la spec et pourquoi, points ouverts.

## Niveau de confiance (chaque affirmation importante du rapport)
Tâche faite, critère couvert, cause trouvée, défaut corrigé, choix fait seul : chacun porte son niveau et ce qui le fonde.
- `prouve` : preuve reproductible jointe (commande exacte et sa sortie, test qui échoue avant et passe après, capture).
- `probable` : lecture du code ou raisonnement vérifiable, sans exécution (chemins et lignes cités).
- `suppose` : hypothèse (sur quoi elle repose, ce qui la prouverait).

Sans preuve ni justification, l'affirmation est refusée. Dans le doute, le niveau inférieur. Une correction n'est `prouve` que si le défaut a été reproduit avant ; une cause observée ailleurs (production, rapport) et non reproduite laisse la correction au mieux `probable`, même si tes tests passent. Rapport structuré (workflow) : champs `confidence` (`prouve`, `probable`, `suppose`) et `evidence` (texte, jamais vide).
```
