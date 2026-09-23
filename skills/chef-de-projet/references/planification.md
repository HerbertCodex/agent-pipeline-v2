# De la spec au plan

Dans ce document, `apv` désigne l'outil du plugin (voir `SKILL.md`).

## 1. Partir de la spec
- La spec (`.apv/specs/<id>.json`) est le cahier des charges : tâches, `allowedPaths`, critères d'acceptation, plan de sécurité. Elle est validée par `apv spec validate <fichier>`, qui recalcule le minimum de sécurité depuis le dépôt (même minimum qu'au lancement).
- Si l'opérateur fournit spec et maquette, on exécute : pas de nouvelle planification Product, Architecture ou Design (incident 23 : plus de 3 h de planification sans une ligne de code).
- Si la spec touche aux données : `.apv/data-model.md` d'abord (agent `architecte-donnees`), présenté à l'opérateur.

## 2. Graphe et vagues
L'agent `architecte` produit `.apv/state/plan-<spec>.md`. Tu le relis avec ces questions :
- **Fondations** : chaque module utilisé par deux tâches ou plus (types, messages, listes d'options, validation, primitives d'interface, classes de style, dépôts d'accès aux données, chargement de la mise en page) est-il dans la vague 0, écrite par un seul agent ? (incident 24 : trois tâches avaient chacune écrit leur module d'actions de statut.)
- **Propriété** : aucun fichier possédé par deux tâches parallèles ; les fichiers communs sont modifiés en ajout, au minimum, et listés dans les rapports.
- **Autonomie** : chaque tâche passe ses contrôles seule.
- **Ressources** : ports, base, remise à zéro, navigateur de test : isolés par agent quand c'est possible, sinon sous bail `apv lock run`.
- **Migrations** : une seule tâche par vague en crée, ou des horodatages réservés.

## 3. Branches et worktrees
- Nommage : `spec/<n>-<slug>` pour la branche de la spec, `spec/<n>-t<k>` pour une tâche (ou la convention du projet).
- La branche de la spec part de la bonne base : `main`, ou la branche de la spec précédente pour une pile (voir `livraison-pile.md`).
- Chaque implementer travaille dans son worktree (`isolation: worktree`). Comme ce worktree part de la branche par défaut, la consigne lui fait créer sa branche depuis la base exacte : `git switch -c spec/<n>-t<k> <base>`. Alternative : `worktree.baseRef: "head"` dans `.claude/settings.json` du projet.
- Dépendances dans un worktree neuf : `npm ci` (ou l'équivalent), ou un lien vers `node_modules` du dépôt principal si le fichier de verrouillage est identique.
- Pour reprendre à la main un travail dans un worktree précis : `git worktree add <dossier> <branche>`, puis lancer l'agent sans isolement en lui donnant le dossier.

## 4. La consigne commune (brief)
Un fichier par projet, versionné dans `.apv/brief.md`, partagé par tous les implementers (modèle : `brief-type.md`). Il contient ce qui ne change pas d'une tâche à l'autre : sources de vérité, règles de code du projet, liste exacte des contrôles, verrous, environnement (piles locales, variables à charger), Git, format du rapport. Mets-le à jour quand une leçon tombe (par exemple une règle de verrou), jamais en cours de vague sans prévenir les agents actifs.

## 5. Les notes de vague
Un fichier par vague parallèle, `.apv/state/notes-<spec>-vague-<n>.md` : base exacte (branche et commit), API disponible avec ses vrais noms, points d'extension, fichiers possédés par tâche, règle des fichiers communs, conduite quand une dépendance n'est pas encore fusionnée (ne pas attendre, point d'accroche minimal, le signaler), pièges connus de l'environnement.

## 6. Lancer la vague
1. Relevé de quota ; nombre d'agents choisi en conséquence (repère : la consommation observée sur les vagues précédentes).
2. Un message de lancement par tâche : spec et tâche, base, branche, chemins de la consigne et des notes, contrôles, ressources sous bail, format du rapport.
3. Agents en arrière-plan ; tu surveilles, tu relèves le quota toutes les 10 à 15 minutes, tu prépares la suite (revue du plan de la spec suivante, rédaction de spec en parallèle si le quota le permet).
4. À chaque retour : lis le rapport, vérifie la branche (`git log`, fichiers touchés, `apv scope check <tâche>`), note les points ouverts.
