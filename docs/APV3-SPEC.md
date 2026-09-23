# Agent Pipeline V3 : spécification (3.0.0-alpha)

Statut : proposition à valider par l'opérateur. Branche `apv3` du dépôt `agent-pipeline-v2`.
Sources : retour d'expérience du projet « Toujours rien » (`docs/RETOUR-TOUJOURS-RIEN.md`, 30 incidents et la section « Vision de l'opérateur ») et décisions de l'opérateur du 2026-09-23 (plugin Claude Code, même dépôt, version 3.0.0-alpha).

## 1. Objectif

Livrer une application de bout en bout, vite et proprement, avec les garde-fous qui ont fait leurs preuves : specs structurées, maquettes validées, contrôles, preuves et revues indépendantes. L'opérateur délègue ; le chef de projet (la session Claude principale) orchestre de vrais sous-agents, travaille en autonomie pendant des heures et ne rappelle l'opérateur que pour ce qui lui revient (produit, design, comptes, identité, fusion, déploiement) ou à la fin.

## 2. Principes

1. **Le chef de projet orchestre, le code ne décide pas à sa place.** Plus de contrôleur qui enchaîne des `claude --print` avec des délais : la méthode vit dans une compétence et des commandes, les rôles sont des sous-agents.
2. **Aucune limite bloquante arbitraire.** Pas de budget en dollars, pas de délai de ronde, pas de réparation de sortie structurée. La seule limite est le quota de l'opérateur, suivi et anticipé (section 9).
3. **La maquette validée est la référence absolue.** Le design se fait avec l'opérateur, par artefact, jusqu'à validation ; jamais de re-maquettage automatique.
4. **Parallèle par défaut, avec des verrous qui expirent.** Un espace de travail (worktree) par tâche, les modules partagés d'abord, des ressources partagées sous bail.
5. **Rien de faux.** Aucune approbation, aucun résultat de test, aucune source inventés. Toute affirmation sur un tiers (prestataire, DPA, région) est vérifiée sur une source officielle.
6. **Effets externes sous contrôle de l'opérateur.** Pousser des branches et ouvrir des PR brouillon : oui (délégation). Fusionner, force-push, déployer, écrire en production : jamais sans accord explicite, et jamais en masquant la sortie d'une commande qui écrit sur un service externe.

## 3. Ce qui change par rapport à V2

| V2 | V3 |
|---|---|
| Contrôleur TypeScript qui lance `claude --print` rôle par rôle | Sous-agents Claude Code orchestrés par le chef de projet |
| Product, Architecture, Design re-planifient chaque spec (40 à 60 min) | Spec rédigée une fois, validée, puis exécutée ; le design vient de la maquette validée |
| Chaîne séquentielle de tâches | Graphe de dépendances, vagues parallèles (workflows) |
| Budgets et délais qui arrêtent un rôle en plein travail | Suivi du quota, dosage des vagues, sauvegarde avant la limite |
| Base SQLite des runs, tableau de bord local | État lisible dans le dépôt (`.apv/`) et aperçu vivant de l'application |
| Revue QA unique | Revues indépendantes : sécurité, fidélité, RGPD |

Conservé tel quel ou presque : schéma et validation des specs, registre des décisions, calcul du minimum de sécurité OWASP, vérification des chemins autorisés, planification des contrôles, preuves (reçus), analyse du dépôt, les 6 compétences existantes.

## 4. Forme du plugin

```
agent-pipeline-v2/              (branche apv3, version 3.0.0-alpha)
  .claude-plugin/plugin.json    nom « apv », version, description
  agents/                       sous-agents (section 5)
  skills/                       compétences (section 7), dont les 6 de V2
  commands/                     ou skills invocables : /apv:* (section 6)
  workflows/                    scripts de vagues parallèles (section 8)
  hooks/hooks.json              garde-fous et reprise (section 11)
  tool/                         outil `apv` en TypeScript (section 10)
  docs/                         guides, migration, retour d'expérience
```

Installation : `/plugin install` depuis le dépôt GitHub (ou `--plugin-dir` en local). Le projet cible reçoit un dossier `.apv/` (configuration, registre, specs, état) versionné.

## 5. Sous-agents

Chaque agent est un fichier `agents/<nom>.md` : description, outils autorisés, modèle, isolement. Effort « high » au minimum (à vérifier : si le champ d'effort n'existe pas dans le format d'agent, la consigne est portée par le corps de l'agent et le modèle choisi).

| Agent | Rôle | Isolement | Écrit du code |
|---|---|---|---|
| `product` | Rédige la spec depuis la demande et le registre : tâches, chemins autorisés, critères d'acceptation, plan de sécurité | aucun | non |
| `architecte` | Découpe en graphe de tâches, identifie les modules partagés à écrire d'abord, alloue les ressources | aucun | non |
| `designer` | Produit et itère la maquette en artefact avec l'opérateur ; ne code pas l'application | aucun | non |
| `implementer` | Code UNE tâche dans son worktree, lance tous les contrôles, commite | worktree | oui |
| `integrateur` | Fusionne des branches parallèles, unifie les doublons, relance tous les contrôles | worktree | oui |
| `qa-securite` | Revue en lecture seule : attaques réelles avec deux utilisateurs, ZAP, secrets, OWASP | aucun | non |
| `qa-fidelite` | Revue en lecture seule : captures comparées à la maquette, textes, accessibilité, bonnes pratiques | aucun | non |
| `dpo` | RGPD : données, base légale, durées, sous-traitants et transferts vérifiés sur les DPA officiels, cohérence des pages légales avec le code | aucun | pages légales seulement, sur demande |

Les rôles de V2 (`roles/*.md`) deviennent le corps de ces agents, sans les consignes « le contrôleur attend du JSON ».

## 6. Commandes

| Commande | Effet |
|---|---|
| `/apv:init` | Nouveau projet : registre des décisions, `.apv/config`, installation des agents et compétences dans le projet |
| `/apv:onboard` | Projet existant : analyse du dépôt, contrôles détectés, registre initial |
| `/apv:design` | Boucle de maquette par artefact jusqu'à validation ; versionne la maquette validée |
| `/apv:spec` | Rédige et valide une spec (outil `apv spec validate`, minimum de sécurité recalculé) |
| `/apv:run` | Exécute une spec : vagues parallèles, intégration, revues, corrections, PR brouillon |
| `/apv:review` | Lance les revues indépendantes (sécurité, fidélité, RGPD) sur une branche |
| `/apv:stack` | Fusionne une pile de PR dans l'ordre : re-cible, vérifie, fusionne, s'arrête à la première anomalie ; uniquement sur ordre explicite de l'opérateur |
| `/apv:preview` | Met à jour l'aperçu vivant sur une branche et l'annonce |
| `/apv:quota` | Relève les fenêtres d'usage (5 h, semaine) et recalibre les vagues |
| `/apv:resume` | Reprise après coupure : état `.apv/state`, environnement (Docker, piles), agents à relancer |
| `/apv:status` | Où en est-on : specs, tâches, PR, quota, aperçu |

## 7. Compétences

- `chef-de-projet` : la méthode complète (délégation, vagues, verrous, intégration, revues, PR, reprise, communication avec l'opérateur, règles d'effets externes).
- `design-artefact` : comment itérer une maquette avec l'opérateur et la verser comme référence.
- `rgpd` : grille du DPO, registre des sous-traitants, modèles de textes légaux sans promesse risquée.
- Existantes de V2 : `clean-code`, `design-patterns`, `refactoring`, `security`, `tdd`, `ui-design` (déjà au bon format).
- Par stack, fournies au projet : par exemple les bonnes pratiques Svelte 5 et le correcteur officiel (leçon 16 du journal).

## 8. Exécution d'une spec (`/apv:run`)

1. **Plan** : l'architecte transforme les tâches de la spec en graphe ; les modules partagés (types, messages, primitives, dépôts) forment une vague « fondations » écrite par un seul agent.
2. **Vagues** : un workflow lance un `implementer` par tâche prête, chacun dans son worktree, avec la consigne commune du projet (brief) et les notes de vague (points d'extension, fichiers possédés).
3. **Intégration** : l'`integrateur` fusionne les branches de la vague, unifie les doublons, relance tous les contrôles.
4. **Revues** : `qa-securite`, `qa-fidelite`, `dpo` en parallèle, en lecture seule, sur une copie isolée.
5. **Corrections** : une passe par domaine (serveur, interface), en parallèle quand les fichiers ne se recouvrent pas.
6. **Livraison** : le chef de projet relance lui-même tous les contrôles, pousse, ouvre la PR brouillon (empilée si besoin), met à jour l'aperçu.

Chaque étape écrit son état dans `.apv/state/` : une coupure (session, machine, quota) se reprend sans rien perdre.

## 9. Quota

- Relevé par `claude -p "/usage"` (fenêtre de 5 h et semaine, heure de remise à zéro) : avant chaque vague et toutes les 10 à 15 minutes pendant l'exécution.
- La consommation observée par vague sert de **repère** pour doser le parallélisme, jamais de plafond.
- Seuils : 70 % ralentir ; 85 % finir les tâches en cours sans en lancer de nouvelles ; 95 % sauvegarder (arrêt propre des agents, commits « wip », push, notes de reprise) et prévenir l'opérateur.
- Un commit « wip » déjà poussé n'est jamais réécrit : on empile des commits propres.

## 10. Outil `apv` (TypeScript, sans dépendance)

Extrait de V2, sans le contrôleur :
- `apv spec validate <fichier>` : schéma, dépendances, chemins autorisés, minimum de sécurité recalculé depuis le dépôt (fin de l'incident 14 : même minimum qu'au lancement).
- `apv ledger validate|plan|apply` : registre des décisions (toutes les erreurs d'un coup).
- `apv gates run [--only …]` : exécute les contrôles déclarés (graphe, ressources, environnement transmis) et écrit des reçus.
- `apv scope check <tâche>` : fichiers modifiés contre les chemins autorisés.
- `apv lock acquire|release|status <ressource>` : verrous avec bail, propriétaire (pid) vérifié, expiration, file d'attente visible ; remplace le verrou `flock` sans bail (incidents 25 et 28).
- `apv quota` : relevé et journal.
- `apv preview update <branche>` : aperçu vivant (section 12), pilotable par projet.

Tests : les suites V2 des parties conservées (contrats, politique, OWASP, preuves, ordonnanceur, inventaire) sont gardées ; les suites du contrôleur sont retirées.

## 11. Hooks

- `SessionStart` : affiche l'état de reprise (`.apv/state`) et le dernier relevé de quota.
- `PreToolUse` sur Bash : bloque `git push --force`, la fusion et le déploiement hors commande dédiée, et les commandes qui masquent la sortie d'une écriture externe (incident 30).
- `PostToolUse` sur les écritures d'un implementer : rappel des chemins autorisés (vérification stricte par `apv scope check` à la fin de la tâche).
- `Stop` : enregistre l'état de reprise.

## 12. Aperçu vivant

Environnement permanent, séparé des tests (sa propre base, jamais remise à zéro par les tests), données de démonstration réalistes, compte de démo. Mis à jour à chaque livraison, avec l'adresse, la branche affichée et ce qui a changé. Le projet décrit comment le construire (commande de build, migrations, graine de données) dans `.apv/config`.

## 13. RGPD (agent `dpo`)

Consulté à trois moments : à la spec (données, base légale, durées, minimisation), à chaque nouveau prestataire ou traceur (registre des sous-traitants, transferts et garanties vérifiés sur les DPA officiels), avant chaque livraison (pages de confidentialité, cookies et mentions légales cohérentes avec le code réel). Il signale ce qui relève de l'éditeur (identité, relecture juridique) sans l'inventer.

## 14. Migration depuis V2

- Lu tel quel : `pipeline.v2.json` (contrôles, risques, règles de validation, compétences, environnement transmis), `.agent-pipeline/DECISIONS.json`, specs au format V2.
- Ignoré : agents, budgets, délais, profils de modèles, tuning.
- `/apv:onboard` sur un projet V2 crée `.apv/` à partir de ces fichiers et propose un commit.
- Projet pilote : « Toujours rien ».

## 15. Phases et critères d'acceptation

| Phase | Contenu | Accepté quand |
|---|---|---|
| 1. Socle | `plugin.json`, agents, compétence chef-de-projet, `/apv:status`, `/apv:quota`, `/apv:resume`, outil `apv` (spec, ledger, gates, scope, lock), hooks de garde | Le plugin s'installe ; les tests conservés passent ; les verrous expirent ; le hook bloque un force-push |
| 2. Design et aperçu | `/apv:design`, `/apv:preview`, compétence design-artefact | Une maquette itérée et validée est versionnée ; l'aperçu se met à jour sur une branche |
| 3. Exécution | `/apv:spec`, `/apv:run` avec workflows, intégrateur, revues, `/apv:stack` | Une spec réelle est livrée en PR avec vagues parallèles, revues et reprise après interruption simulée |
| 4. RGPD et migration | agent `dpo`, compétence `rgpd`, `/apv:onboard` depuis V2 | « Toujours rien » tourne sous APV3 ; ses pages légales passent la revue du DPO |

Chaque phase est livrée en PR à fusionner par l'opérateur.

## 16. Points ouverts

- Champ d'effort dans le format d'agent (à vérifier sur la documentation officielle au moment de la phase 1).
- Base de test par agent : schémas dédiés ou piles séparées selon la stack (Supabase : une pile par agent coûte cher en mémoire ; alternative : schéma par worktree).
- Hors de Claude Code (Codex, autres fournisseurs) : non couvert par V3 ; V2 reste disponible par ses tags.
