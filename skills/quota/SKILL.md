---
name: quota
description: "Relève les fenêtres d'usage de l'opérateur (session de 5 h et semaine, heure de remise à zéro), les journalise et recalibre le nombre d'agents parallèles selon les seuils 70, 85 et 95 %. À utiliser avant chaque vague d'agents, toutes les 10 à 15 minutes pendant une exécution, à la reprise, et quand l'opérateur demande où en est son quota."
allowed-tools: Read Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js quota*) Bash(apv quota*)
---

# /apv:quota

1. Lance le relevé, sortie lue en entier :
   `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js quota`
   (ou `apv quota`). Il interroge `claude -p "/usage"`, qui répond sans appel de modèle, et journalise dans `.apv/state/quota.log`.
2. Si la sous-commande n'est pas disponible : lance `claude -p "/usage"` depuis un dossier hors du dépôt (par exemple `/tmp`), garde les lignes « Current session » et « Current week », et ajoute à `.apv/state/quota.log` une ligne JSON au même format que l'outil : `{"at": "<date ISO>", "session": {"percent": <n>, "resets": "<texte>"}, "week": {"percent": <n>, "resets": "<texte>"}, "percent": <le plus haut>, "level": "ok|slow_down|finish_only|save_now"}`.
3. Explique à l'opérateur, dans sa langue et en quelques lignes : pourcentage utilisé de chaque fenêtre, heure de remise à zéro, fenêtre la plus contraignante.
4. Recalibre, en précisant ce que tu fais :
   | Utilisé (fenêtre la plus contraignante) | Action |
   |---|---|
   | moins de 70 % | parallélisme normal, dosé par la consommation observée des vagues précédentes |
   | 70 % | ralentir : moins d'agents, mode économe (revue combinée, captures des seuls écrans modifiés) |
   | 85 % | finir les tâches en cours, ne rien lancer de nouveau |
   | 95 % | procédure de sauvegarde (compétence `chef-de-projet`, `references/quota-sauvegarde.md`), pause, message à l'opérateur |
   Une fenêtre de 5 h presque pleine qui se remet à zéro dans quelques minutes justifie d'attendre plutôt que de sauvegarder.
5. Le relevé est un repère, jamais un plafond en dollars ni un arrêt automatique. Note la consommation de la dernière vague (points de pourcentage) pour doser la suivante. Aucun tiret cadratin ni demi-cadratin dans ta réponse.
