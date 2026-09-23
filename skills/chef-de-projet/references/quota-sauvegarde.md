# Quota et sauvegarde

Dans ce document, `apv` désigne l'outil du plugin (voir `SKILL.md`).

## 1. Relever
- `apv quota` relève les fenêtres d'usage (session de 5 h et semaine, pourcentage utilisé, heure de remise à zéro) et les journalise dans `.apv/state/quota.log`, un objet JSON par ligne (fichier lu par le hook de démarrage de session, ignoré par Git grâce à `.apv/.gitignore` que l'outil génère). Il s'appuie sur `claude -p "/usage"`, qui répond sans appel de modèle (incident 27 : la ligne d'état ne s'exécute pas dans l'extension VS Code).
- Quand : avant chaque vague, toutes les 10 à 15 minutes pendant l'exécution, avant une revue coûteuse, et à la reprise.
- Le relevé est un repère, jamais un plafond : aucun budget en dollars, aucun arrêt « budget épuisé » (ce sont ces blocages qui ont arrêté la première spec du projet pilote).

## 2. Doser
- Mesure la consommation de chaque vague (points de pourcentage par agent et par type de tâche) et note-la au journal du pipeline (`.apv/journal-pipeline.md`), pas dans `.apv/state/quota.log` qui ne contient que les relevés de l'outil (une ligne JSON chacun) : c'est le repère des vagues suivantes.
- Nombre d'agents simultanés = ce que le quota restant permet jusqu'à la prochaine remise à zéro, avec une marge. Regarde les deux fenêtres ; la plus contraignante décide. Une fenêtre de 5 h presque pleine qui se remet à zéro dans quelques minutes justifie d'attendre plutôt que de sauvegarder.
- Mode économe : une revue combinée au lieu de deux, captures limitées aux écrans modifiés, moins d'agents en parallèle, pas de relecture redondante (incident 26 : 98 % du quota hebdomadaire atteint avec 6 à 9 agents et des revues doubles).

## 3. Seuils
| Utilisé | Action |
|---|---|
| 70 % | Ralentir : moins d'agents, mode économe, relevés plus fréquents. |
| 85 % | Finir les tâches en cours, ne rien lancer de nouveau. |
| 95 % | Sauvegarder (section 4), mettre en pause, prévenir l'opérateur avec l'heure de reprise. |

## 4. Procédure de sauvegarde
1. **Arrêt propre des agents** : demande à chaque agent actif (`SendMessage`) de commiter son état en `wip: <tâche> <ce qui reste>` et de rendre la main ; à défaut de réponse, arrête-le (`TaskStop`) puis commite toi-même l'état de son worktree en `wip`.
2. **Commits** : aucun travail non commité ne reste dans un worktree. Jamais de secret dans un wip.
3. **Push** : pousse toutes les branches concernées (sans force).
4. **Notes de reprise** : `.apv/state/resume.md`, commité et poussé :
   - date, quota relevé et heure de remise à zéro ;
   - pile des branches et PR (base vers sommet, commits) ;
   - pour chaque tâche : branche, dernier commit, état (fait, vert, wip non vérifié), identifiant de l'agent, consigne de reprise en une phrase ;
   - revues interrompues à relancer ;
   - ordre de reprise ;
   - environnement à relancer (Docker, piles, aperçu, commandes exactes).
5. **Journal** : une entrée dans `.apv/journal-pipeline.md`.
6. **Opérateur** : message court, dans sa langue : ce qui est sauvegardé, ce qui reste, quand reprendre, commande `/apv:resume`.

## 5. Règle absolue
Un commit « wip » déjà poussé n'est jamais réécrit (ni `amend`, ni `reset`, ni `rebase`) : on empile des commits propres par-dessus. Incident 29 : deux agents ont réécrit leur wip poussé, leurs branches distantes ne pouvaient plus être mises à jour sans force-push.
