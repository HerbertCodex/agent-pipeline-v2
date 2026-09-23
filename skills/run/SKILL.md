---
name: run
description: "Exécute une spec validée de bout en bout, pilotée par l'état apv run : modèle de données présenté à l'opérateur, plan de l'architecte, vague des fondations, vagues d'implementers en parallèle dans leurs worktrees (workflow apv:vague ou outil Agent), apv scope check par tâche, intégration, revues indépendantes (/apv:review), corrections, contrôles relancés par le chef de projet, push et PR brouillon, aperçu. Reprend toujours par apv run next quand l'état existe. Ne fusionne ni ne déploie jamais."
argument-hint: "<identifiant ou fichier de spec> [--base <branche>]"
disable-model-invocation: true
allowed-tools: Read Glob Grep Write Edit Skill Agent SendMessage TaskStop Workflow Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js run*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spec validate*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js scope check*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js gates run*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js quota*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js lock*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js db check*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js design list*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js design check*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js preview*) Bash(apv run*) Bash(apv spec validate*) Bash(apv scope check*) Bash(apv gates run*) Bash(apv quota*) Bash(apv status*) Bash(apv lock*) Bash(apv db check*) Bash(apv design list*) Bash(apv design check*) Bash(apv preview*) Bash(git status*) Bash(git log*) Bash(git diff*) Bash(git show*) Bash(git branch*) Bash(git rev-parse*) Bash(git switch*) Bash(git worktree*) Bash(git merge --ff-only*) Bash(git fetch*) Bash(git add .apv*) Bash(git commit*) Bash(git push -u origin apv/*) Bash(gh pr create --draft*) Bash(gh pr view*) Bash(gh pr list*) Bash(docker info*) Bash(docker ps*) Bash(ss -ltnp*)
---

# /apv:run

Tu es le chef de projet. Tu exécutes la spec `$ARGUMENTS` jusqu'à une PR brouillon, en autonomie, avec de vrais sous-agents, et tu tiens l'état d'exécution à jour à chaque transition. La méthode complète est dans la compétence `chef-de-projet` (charge-la avec l'outil Skill si elle n'est pas déjà chargée) ; ce document est la procédure.

Dans ce document, `apv` désigne `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` (ou `apv` s'il est sur le PATH), `<id>` l'identifiant de la spec et `<spec>` son fichier `.apv/specs/<id>.json`.

## Règles qui ne se discutent pas
- **Jamais de fusion** dans la branche principale ni dans une autre PR, **jamais de déploiement**, jamais de force-push, jamais de réécriture d'un commit poussé. Les seules fusions de ce document sont les avances rapides locales (`git merge --ff-only`) de la branche de la spec et les fusions de l'intégrateur dans sa branche d'intégration. La pile de PR se fusionne par `/apv:stack`, sur ordre de l'opérateur.
- **Les commandes `apv run` se lancent depuis le checkout principal du dépôt** (ou avec `--repo <checkout principal>`) : l'outil prend la racine du worktree courant, et un état écrit depuis le worktree d'une tâche serait perdu.
- **L'état d'exécution s'écrit par l'outil seulement** (`apv run start`, `apv run set`) ; jamais d'édition à la main de `.apv/state/run-<id>.json`. Si l'outil refuse une transition, lis son message et corrige l'ordre de tes actions ; ne force rien.
- **Un rapport d'agent est une affirmation** ; tes contrôles relancés sont la preuve. Aucune sortie masquée d'une commande qui écrit sur un service externe (incident 30).
- Aucune question à l'opérateur avant la fin, sauf une décision qui lui revient (produit, design, comptes, identité, fusion, déploiement) : note-la, avance sur le reste, pose-la groupée.

## 0. Reprise d'abord
1. `apv run status` : liste des exécutions.
2. **Si l'état de `<id>` existe**, ne lance jamais `apv run start` : `apv run next <id>` (lis-le en entier, `--json` si tu le traites), puis va à la section 9 (Reprise). Tout le reste de ce document se lit à partir de l'étape que `apv run next` désigne.
3. Sinon, section 1.

## 1. Démarrer
1. `apv spec validate <spec>` : `VALID` obligatoire (sinon `/apv:spec`). Une spec validée par l'opérateur s'exécute telle quelle.
2. Environnement : `apv status`, `docker info` si les contrôles en dépendent, `apv lock status` (baux orphelins), arbre de travail propre (`git status`).
3. Quota : `apv quota` (section 8).
4. Base : la branche principale, ou la branche de la spec précédente non fusionnée pour une pile (`apv/<id-précédent>`).
5. `apv run start <spec> --base <base>` : l'outil revalide la spec, calcule les vagues (couches des dépendances) et marque les fondations (tâches dont au moins deux autres dépendent directement) et crée l'état, avec la branche de la spec `apv/<id>`. `apv run status <id>` : montre les vagues, avec « fondations (un seul agent) : … » et « en parallèle : … » dans chaque vague qui a des fondations.
6. Branche de la spec : `git switch -c apv/<id> <base>` (ou `git switch apv/<id>` si elle existe). Commite dessus ce que la spec apporte et que la base n'a pas (`<spec>`, `.apv/state/demande-<id>.md`) : les worktrees des agents partent de cette branche et doivent y lire la spec.

## 2. Modèle de données (étape `data-model`)
- La spec ne touche pas la base : `apv run set <id> data-model skipped --note "<raison>"`.
- Sinon : `apv run set <id> data-model running`, puis agent `apv:architecte-donnees` en mode conception (spec, modèle existant, migrations, rapports de `/apv:spec`) qui écrit `.apv/data-model.md`.
- Présente le modèle à l'opérateur **avant tout code** : entités, relations, règles de suppression, isolation, écritures uniques, index, en quelques lignes, et le fichier. S'il relit, attends ses remarques ; s'il a délégué, continue et reporte ses remarques ultérieures en corrections. Un choix qui relève du produit (donnée conservée, durée) est une question.
- Commite `.apv/data-model.md` sur `apv/<id>`, puis `apv run set <id> data-model done --commit <sha>`.

## 3. Plan (étape `plan`)
1. `apv run set <id> plan running`.
2. Agent `apv:architecte` : spec, vagues calculées par l'outil (`apv run status <id> --json`), modèle de données, maquettes, contrôles, nombre d'agents simultanés que le quota permet. Il écrit `.apv/state/plan-<id>.md` et une note par vague parallèle, `.apv/state/notes-<id>-vague-<n>.md`.
3. Relis le plan (références `planification.md` de la compétence `chef-de-projet`) : fondations complètes, un propriétaire par fichier, tâches autonomes, ressources sous bail, une seule tâche de migrations par vague.
4. Le plan suit les vagues de l'outil. S'il conclut que le graphe de la spec doit changer (une fondation manquante, une dépendance oubliée) **et qu'aucune tâche n'a démarré** : product corrige la spec, `apv spec validate`, puis tu recrées l'état (retire `.apv/state/run-<id>.json`, seule exception à la règle de l'état et seulement tant qu'aucune tâche n'a démarré, puis `apv run start` de nouveau) et tu le notes au journal. Une fois une tâche démarrée, le graphe ne change plus : l'écart passe en note de vague.
5. Commite plan et notes sur `apv/<id>` (les implementers les lisent dans leur worktree), puis `apv run set <id> plan done --commit <sha>`.

## 4. Tâches et vagues
Règle unique : une tâche se lance **dès qu'elle est prête**, pas vague par vague. Elle est prête quand ses dépendances sont `done` et que le commit de chacune est intégré dans `apv/<id>` (la base de l'exécution tant que cette branche n'existe pas). Les vagues de l'outil (couches des dépendances) servent au plan et aux notes ; elles ne rythment pas les lancements. Répète, jusqu'à ce que toutes les tâches soient faites :

1. **Tâches prêtes** : `apv run next <id>`. Lance toutes celles qu'il donne prêtes, quelle que soit leur vague : les fondations prêtes à un seul agent, les autres en parallèle. Celles « en attente d'intégration » attendent que tu intègres la dépendance nommée (section 5). `apv run set … running` refuse une tâche dont une dépendance n'est pas intégrée ; `--force-unintegrated --note "<raison>"` seulement sur une décision écrite (fichiers disjoints, point d'accroche minimal), que l'outil journalise.
2. **Quota** : `apv quota`, puis dose (section 8). Avec moins d'agents que de tâches prêtes, lance les plus utiles d'abord (ordre du plan).
3. **Base exacte** : `git rev-parse apv/<id>` (le commit que tu donnes aux agents).
4. **Branche de chaque tâche** : celle que `apv run next` indique, sinon `apv/<id>-<tâche>`.
5. **Lancement** :
   - **Une seule tâche** (les fondations prêtes, confiées à un seul agent ; une correction isolée) : outil Agent, `subagent_type: "apv:implementer"`, `run_in_background: true`, avec le message de lancement ci-dessous.
   - **Plusieurs tâches** : le workflow du plugin `apv:vague` (outil Workflow, `name: "apv:vague"`, ou `scriptPath` = chemin absolu de `workflows/vague.js` du plugin si le nom n'est pas trouvé) avec `args` en objet JSON :
     ```json
     { "specId": "<id>", "specFile": ".apv/specs/<id>.json", "base": "apv/<id>", "baseCommit": "<sha>", "wave": 1,
       "brief": ".apv/brief.md", "notes": ".apv/state/notes-<id>-vague-1.md", "context": "<consigne commune de la vague, facultative>",
       "tasks": [ { "id": "T2", "branch": "apv/<id>-T2" }, { "id": "T3", "branch": "apv/<id>-T3", "resume": "<consigne de reprise, facultative>" } ] }
     ```
     Il lance un `apv:implementer` par tâche, chacun dans son worktree, avec la même consigne que le message ci-dessous, et rend un rapport structuré par tâche. Il ne touche pas à l'état : c'est toi qui le tiens.
   - **Sans outil Workflow** (désactivé, version trop ancienne, refus) : plusieurs appels à l'outil Agent **dans un même message**, un par tâche, chacun `subagent_type: "apv:implementer"`, `run_in_background: true`. C'est aussi le bon choix quand tu veux pouvoir parler à chaque agent (`SendMessage`) pendant la vague.
6. **Juste après le lancement**, pour chaque tâche : `apv run set <id> task:<tâche> running --branch <branche> --base <baseCommit> --agent <identifiant>` (`--base` : le commit de départ exact de la tâche, sans lequel `apv run next` mesurerait « aucun commit après la base » depuis la base de l'exécution) (identifiant de l'agent, ou `workflow:<runId>` pour une vague lancée par workflow). Note aussi le `runId` du workflow dans `.apv/state/resume.md`.
7. **Pendant le travail des agents** : relevé de quota toutes les 10 à 15 minutes, préparation de la suite (notes de la vague suivante, revue du plan de la spec suivante). Tu ne codes pas à la place des agents.
8. **À chaque rapport** (ou au rapport du workflow) :
   - vérifie la branche : `git log --oneline <base>..<branche>`, fichiers touchés ;
   - **`apv scope check --spec <spec> --task <tâche> --base <baseCommit> --repo <worktree>`**, relancé par toi à la fin de chaque tâche. Un fichier hors périmètre est accepté seulement s'il est minimal et justifié dans le rapport (note-le) ; sinon la tâche repart avec la consigne de le retirer ;
   - tâche finie et vérifiée : `apv run set <id> task:<tâche> done --commit <sha> --worktree <chemin>` ;
   - tâche en échec ou rapport absent : `apv run set <id> task:<tâche> failed --note "<cause>"`, puis relance (section 9) ou décision écrite au journal.

### Message de lancement d'un implementer (outil Agent)
L'agent ne voit pas ta conversation : le message contient tout.
```
Tu codes la tâche <tâche> de la spec .apv/specs/<id>.json (identifiant <id>), vague <n>.
Base : branche apv/<id>, commit <sha>. Ta branche : <branche>.
Démarrage : ton worktree part de la branche par défaut. Tant qu'il est propre :
si la branche <branche> existe déjà, git switch <branche> ; sinon git switch -c <branche> <sha>.
Vérifie git log -1. Écris le marqueur .apv/state/task.json : {"spec": ".apv/specs/<id>.json", "task": "<tâche>"}.
Sources : la tâche dans la spec, la consigne commune .apv/brief.md, les notes .apv/state/notes-<id>-vague-<n>.md,
les maquettes validées (apv design list), .apv/data-model.md et le registre quand la tâche les concerne.
Fin : tous les contrôles de la consigne au vert (apv gates run), ressources sous bail (apv lock run),
tout commité, puis apv scope check --spec .apv/specs/<id>.json --task <tâche> --base <sha>.
Ne pousse pas, ne fusionne pas, ne réécris aucun commit.
Rapport (moins de 300 mots) : branche, sha complet de HEAD, chemin du worktree (pwd), chaque contrôle
(commande, vert ou rouge, nombre de tests), résultat du scope check et fichiers hors périmètre,
critères couverts, écarts et pourquoi, points ouverts.
```

## 5. Intégration (étape `integration`)
Dès qu'une tâche, ou un lot de tâches finies, est vérifiée (section 4, étape 8), sans attendre la fin de sa vague : c'est l'intégration qui rend prêtes les tâches qui en dépendent (`apv run next` les fait passer de « en attente d'intégration » à « prêtes »). À la première intégration : `apv run set <id> integration running --note "intégration 1"`.
- **Une seule tâche à intégrer** : relance toi-même les contrôles dans son worktree (`apv gates run --repo <worktree>`), puis, sur `apv/<id>` : `git merge --ff-only <branche>`. Si `apv/<id>` a avancé depuis la base de la tâche (une autre intégration entre-temps), l'avance rapide est refusée : passe par l'intégrateur.
- **Plusieurs tâches** : agent `apv:integrateur` : branche de la spec, liste ordonnée des branches (ordre du plan), plan et notes. Il crée `apv/<id>-integration-<n>` depuis `apv/<id>`, fusionne, unifie les doublons, garde tous les tests, relance tous les contrôles. Tu vérifies son rapport, tu relances les contrôles au moindre doute, puis `git merge --ff-only apv/<id>-integration-<n>` sur `apv/<id>`.
- Worktrees des tâches intégrées : `git worktree remove <chemin>` une fois leur branche intégrée et leur arbre propre ; les branches restent (jamais réécrites).
- Une fois toutes les tâches intégrées : `apv run set <id> integration done --commit <tête de apv/<id>>`.

## 6. Revues (étape `reviews`)
`apv run set <id> reviews running`, puis `/apv:review <id>` (compétence `review`, outil Skill) sur la tête de `apv/<id>` : quatre revues en parallèle, en lecture seule, chacune sur sa copie détachée du même commit, constats consolidés et dédoublonnés, `apv run set <id> review:<domaine> …` pour chaque domaine. Puis `apv run set <id> reviews done`.

## 7. Corrections (étape `fixes`), puis livraison (étape `delivery`)
**Corrections**
1. Décide chaque constat par écrit dans `.apv/state/corrections-<id>.md` (identifiants S, F, D, R, T ; gravité ; décision précise ou écart assumé justifié). Critiques et élevés toujours corrigés ; un faux positif se prouve.
2. Aucun constat à corriger : `apv run set <id> fixes skipped --note "<raison>"`.
3. Sinon `apv run set <id> fixes running` : une passe par domaine (serveur et données, interface), chacune confiée à un `apv:implementer` sur `apv/<id>-fix-<domaine>` depuis la tête de `apv/<id>`, avec le fichier de corrections comme cahier des charges ; en parallèle quand les fichiers ne se recouvrent pas. Intégration comme en section 5. Nouvelle revue ciblée (`/apv:review <id> <domaine>`) quand la correction est lourde. Puis `apv run set <id> fixes done --commit <sha>`.

**Livraison**
1. `apv run set <id> delivery running`.
2. Tes contrôles, sur la tête exacte de `apv/<id>`, dans un worktree propre (`git worktree add --detach <dossier> apv/<id>`, dépendances installées) : `apv gates run --repo <dossier>`, `apv db check` si la base a changé, `apv design check` si le projet a des maquettes validées. Un rouge bloque la PR. Note les nombres de tests.
3. `git push -u origin apv/<id>`, sortie lue.
4. `gh pr create --draft --base <base> --head apv/<id> --title "<titre>" --body "<corps>"`, **sans masquer la sortie**, puis `gh pr view <n> --json number,baseRefName,headRefName,isDraft,url` : base et statut brouillon vérifiés. Corps : résumé, critères couverts, preuves (contrôles et nombres de tests, revues, ZAP), écarts assumés à valider, points qui demandent l'opérateur, base de la pile.
5. Aperçu : si `.apv/config.json` a une section `preview`, `/apv:preview apv/<id>` (`apv preview update apv/<id>`, vérification, annonce).
6. `apv run set <id> delivery done --note "PR #<n> <url>"`, `.apv/state/resume.md` à jour, journal du pipeline complété (bilan de la spec, consommation de quota par vague).
7. Remise à l'opérateur : lien de la PR et sa base, preuves, écarts assumés, décisions qui l'attendent, aperçu. Pas de fusion : la pile se fusionne par `/apv:stack`, sur son ordre.

## 8. Quota
`apv quota` avant chaque vague, avant les revues et toutes les 10 à 15 minutes pendant l'exécution. La consommation observée par vague est un repère, jamais un plafond ; note-la au journal.

| Niveau (fenêtre la plus contraignante) | Action |
|---|---|
| `ok` (moins de 70 %) | parallélisme normal, dosé par les vagues précédentes |
| `slow_down` (70 %) | moins d'agents par vague, revues en mode économe |
| `finish_only` (85 %) | finir les tâches en cours, ne rien lancer de nouveau |
| `save_now` (95 %) | sauvegarde : demande à chaque agent actif (`SendMessage`) de commiter son état en `wip: <tâche> <ce qui reste>` et de rendre la main ; à défaut, arrête-le (`TaskStop`, ou l'arrêt du workflow) et commite toi-même le wip de son worktree ; pousse les branches (sans force) ; écris `.apv/state/resume.md` (commité et poussé) avec le `runId` du workflow s'il y en a un ; préviens l'opérateur avec l'heure de remise à zéro |

Un workflow qui atteint la limite d'usage se met en pause de lui-même et repart après la remise à zéro (Claude Code 2.1.271 ou plus récent, session interactive) ; la sauvegarde reste de mise si la remise à zéro est lointaine. Détails : `references/quota-sauvegarde.md` de la compétence `chef-de-projet`.

## 9. Reprise
Toujours `apv run next <id>` d'abord ; il dit l'étape courante, les tâches prêtes, les tâches `running` à reprendre (branche, worktree, agent, dernier commit), celles « à relancer » et les revues à lancer. Environnement d'abord si la machine a redémarré (`/apv:resume` : Docker, piles, verrous, orphelins).
- **Tâche `running` dont l'agent vit encore** dans cette session : `SendMessage` à son identifiant.
- **Workflow interrompu dans cette session** : relance avec `resumeFromRunId` (le `runId` noté) ; les agents terminés rendent leur résultat enregistré, les autres repartent. Dans une nouvelle session, le workflow ne se reprend pas : on passe par les tâches ci-dessous.
- **Tâche `running` avec worktree et commits** (agent perdu) : si le worktree a des modifications non commitées, commite-les en `wip` (`git -C <worktree> add -A` puis `git -C <worktree> commit -m "wip: <tâche> reprise"`), retire le worktree (`git worktree remove <worktree>`) pour libérer la branche, puis relance un implementer (même message, la consigne de démarrage lui fait faire `git switch <branche>`) avec « termine <tâche> à partir du wip <sha>, vérifie tout, tous les contrôles ».
- **Tâche « à relancer »** (worktree disparu ou aucun commit après la base) : relance normale ; si la branche existe déjà, l'agent la reprend telle quelle.
- **Étape interrompue** (plan, intégration, revues, corrections, livraison) : reprends-la à son début, avec ce qui est déjà commité ; une revue interrompue se relance entière.
- Ne réécris jamais un commit déjà poussé pendant une reprise : on empile des commits propres. Note l'interruption au journal du pipeline et mets `.apv/state/resume.md` à jour.

Réponds à l'opérateur dans sa langue, en phrases courtes, sans tiret cadratin ni demi-cadratin.
