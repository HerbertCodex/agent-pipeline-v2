# Verrous, reprise après coupure, environnement, aperçu vivant

Dans ce document, `apv` désigne l'outil du plugin (voir `SKILL.md`).

## 1. Verrous à bail
- `apv lock run <ressource> -- <commande>` : prend le bail, exécute la commande, rend le bail. Une commande par bail.
- `apv lock status` : baux en cours, propriétaire (pid), échéance, file d'attente.
- `apv lock acquire|release <ressource>` : réservé aux cas où une suite de commandes doit tenir la ressource ; le bail expire de toute façon.
- Ressources typiques : base locale de test, remise à zéro de la base, ports fixes des tests navigateur, pile de l'aperçu.
- Règles : jamais de verrou tenu en attendant autre chose (incident 25 : 40 minutes) ; jamais de verrou sans échéance (incident 28 : un verrou et un serveur orphelins pendant 4 h après une pause). Les scripts du projet qui prennent déjà le verrou eux-mêmes restent la meilleure option (le verrou ne dépend alors plus de la discipline des agents).

## 2. Reprise après coupure (`/apv:resume`)
Dans l'ordre :
1. **État** : lis `.apv/state/resume.md`, le plan et les notes de vague en cours, la fin de `.apv/state/journal.log` et de `.apv/journal-pipeline.md`.
2. **Docker** : `docker info`. S'il ne répond pas, relance-le (sous WSL avec Docker Desktop, en lançant l'exécutable Windows de Docker Desktop depuis WSL ; ailleurs, le service du système) et attends qu'il réponde.
3. **Piles locales** : pour chaque pile déclarée par le projet (tests, aperçu), vérifie son état (par exemple `npx supabase status` dans son dossier) et relance-la avec la commande et la version épinglées du projet. Ne touche jamais une pile qui n'appartient pas au projet.
4. **Orphelins** : `apv lock status` (baux expirés ou propriétaires morts), processus qui occupent les ports des tests ou de l'aperçu (`ss -ltnp`). Arrête seulement ce que le projet a lancé.
5. **Git** : `git worktree list`, branches locales et distantes, commits non poussés, travail non commité dans les worktrees.
6. **Agents** : pour chaque tâche non terminée, reprends l'agent par `SendMessage` s'il vit encore, sinon relance un `implementer` sur sa branche avec « termine <tâche> à partir du wip <hash>, vérifie tout, tous les contrôles ». Relance les revues interrompues.
7. **Quota** : `apv quota`, puis choisis le nombre d'agents.
8. Mets `.apv/state/resume.md` à jour avec ce qui a été relancé, et note l'incident au journal.

## 3. Aperçu vivant
- Environnement permanent, séparé des tests : sa propre base (jamais remise à zéro par les tests), des données de démonstration réalistes, un compte de démo.
- Le projet décrit comment le construire dans `.apv/config` (build, migrations, graine de données, port). `apv preview update <branche>` (phase 2) le met à jour ; d'ici là, le script du projet.
- À chaque livraison (tâche intégrée, spec en PR) : mise à jour, puis annonce à l'opérateur de l'adresse, de la branche affichée, du compte de démo et de ce qui a changé.
- Après un redémarrage de la machine : Docker, pile de l'aperçu, puis mise à jour.
