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
| Revue QA unique, base de données conçue au fil des tâches | Modèle de données conçu avant le code ; revues indépendantes : sécurité, fidélité, données, RGPD |

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
  src/                          outil `apv` en TypeScript (section 10)
  dist/                         outil compilé, versionné (le plugin s'installe sans étape de build)
  docs/                         guides, migration, retour d'expérience
```

Installation : `/plugin install` depuis le dépôt GitHub (ou `--plugin-dir` en local). Le projet cible reçoit un dossier `.apv/` (configuration, registre, specs, état) versionné.

## 5. Sous-agents

Chaque agent est un fichier `agents/<nom>.md` : description, outils autorisés, modèle, isolement, effort. Effort « high » au minimum, porté par le champ `effort` du frontmatter (accepté par le format d'agent de Claude Code, vérifié en phase 1).

Un agent `isolation: worktree` part de la branche par défaut du dépôt, pas de la base de sa tâche : sa consigne lui fait d'abord créer sa branche depuis la base exacte, `git switch -c <branche> <base>`, dans le worktree encore propre. Alternative par projet : `worktree.baseRef: "head"` dans `.claude/settings.json`, le chef de projet lançant alors l'agent depuis la bonne tête.

| Agent | Rôle | Isolement | Écrit du code |
|---|---|---|---|
| `product` | Rédige la spec depuis la demande et le registre : tâches, chemins autorisés, critères d'acceptation, plan de sécurité | aucun | non |
| `architecte` | Découpe en graphe de tâches, identifie les modules partagés à écrire d'abord, alloue les ressources | aucun | non |
| `designer` | Produit et itère la maquette en artefact avec l'opérateur ; ne code pas l'application | aucun | non |
| `implementer` | Code UNE tâche dans son worktree, lance tous les contrôles, commite | worktree | oui |
| `integrateur` | Fusionne des branches parallèles, unifie les doublons, relance tous les contrôles | worktree | oui |
| `architecte-donnees` | Modélise la base AVANT le code (entités, relations, contraintes, index, RLS), puis revoit chaque migration et chaque requête ajoutée | aucun | migrations et doc du modèle, sur demande |
| `qa-securite` | Revue en lecture seule : attaques réelles avec deux utilisateurs, ZAP, secrets, OWASP | aucun | non |
| `qa-fidelite` | Revue en lecture seule : captures comparées à la maquette, textes, accessibilité, bonnes pratiques | aucun | non |
| `dpo` | RGPD : données, base légale, durées, sous-traitants et transferts vérifiés sur les DPA officiels, cohérence des pages légales avec le code | aucun | pages légales seulement, sur demande |

Les rôles de V2 (`roles/*.md`, archivés dans `docs/v2/roles/`) deviennent le corps de ces agents, sans les consignes « le contrôleur attend du JSON ».

## 6. Commandes

| Commande | Effet |
|---|---|
| `/apv:init` | Nouveau projet : registre des décisions, `.apv/config`, installation des agents et compétences dans le projet (phase 3) |
| `/apv:onboard` | Projet existant : analyse du dépôt, contrôles détectés, registre initial |
| `/apv:design` | Boucle de maquette par artefact jusqu'à validation ; versionne la maquette validée |
| `/apv:spec` | Rédige et valide une spec (outil `apv spec validate`, minimum de sécurité recalculé) |
| `/apv:run` | Exécute une spec : vagues parallèles, intégration, revues, corrections, PR brouillon |
| `/apv:review` | Lance les revues indépendantes (sécurité, fidélité, données, RGPD) sur une branche |
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

1. **Modèle de données** : si la spec touche aux données, l'architecte des données produit ou met à jour `.apv/data-model.md`, présenté à l'opérateur avant tout code.
2. **Plan** : l'architecte transforme les tâches de la spec en graphe ; les vagues sont les couches de dépendances ; une tâche dont au moins deux autres dépendent (types, messages, primitives, dépôts partagés) est une fondation, écrite par un seul agent ; une tâche part dès que ses dépendances sont faites et intégrées dans la branche de la spec, sans attendre la fin de sa vague.
3. **Vagues** : un workflow lance un `implementer` par tâche prête, chacun dans son worktree, avec la consigne commune du projet (brief) et les notes de vague (points d'extension, fichiers possédés).
4. **Intégration** : l'`integrateur` fusionne les branches de la vague, unifie les doublons, relance tous les contrôles.
5. **Revues** : `qa-securite`, `qa-fidelite`, `architecte-donnees`, `dpo` en parallèle, en lecture seule, sur une copie isolée.
6. **Corrections** : une passe par domaine (serveur, interface), en parallèle quand les fichiers ne se recouvrent pas.
7. **Livraison** : le chef de projet relance lui-même tous les contrôles, pousse, ouvre la PR brouillon (empilée si besoin), met à jour l'aperçu.

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
- `apv lock run|acquire|release|status <ressource>` : verrous avec bail, propriétaire (pid) vérifié, expiration, file d'attente visible ; remplace le verrou `flock` sans bail (incidents 25 et 28).
- `apv db check [--live]` : contrôle du modèle de données (section 13 bis) ; `--live` lit la base en lecture seule par `psql` (`APV_DB_URL`, ou la commande `APV_PSQL`).
- `apv quota` : relevé et journal (`.apv/state/quota.log`, un objet JSON par ligne, ignoré par Git via `.apv/.gitignore` généré par l'outil).
- `apv preview update <branche>` : aperçu vivant (section 12), pilotable par projet.

Tests : les suites V2 des parties conservées (contrats, politique, OWASP, preuves, ordonnanceur, inventaire) sont gardées ; les suites du contrôleur sont retirées.

## 11. Hooks

- `SessionStart` : affiche l'état de reprise (`.apv/state`) et le dernier relevé de quota.
- `PreToolUse` sur Bash : bloque `git push --force`, la fusion et le déploiement hors commande dédiée, et les commandes qui masquent la sortie d'une écriture externe (incident 30).
- `PostToolUse` sur les écritures d'un implementer : rappel des chemins autorisés quand une écriture en sort, d'après le marqueur de tâche `.apv/state/task.json` du worktree (vérification stricte par `apv scope check` à la fin de la tâche).
- `Stop` : enregistre l'état de reprise.

## 12. Aperçu vivant

Environnement permanent, séparé des tests (sa propre base, jamais remise à zéro par les tests), données de démonstration réalistes, compte de démo. Mis à jour à chaque livraison, avec l'adresse, la branche affichée et ce qui a changé. Le projet décrit comment le construire (commande de build, migrations, graine de données) dans `.apv/config`.

## 13 bis. Modèle de données et performance (agent `architecte-donnees`)

Leçon du projet pilote : la première version de la base avait des tables et colonnes en français (`candidatures`), des relations ajoutées au fil des tâches et un index qui ne correspondait pas au tri réel de la liste. En V3, la base est conçue avant d'être codée, et vérifiée à chaque livraison.

**Modélisation d'abord**
- Pour chaque spec qui touche aux données, l'architecte des données produit `.apv/data-model.md` : diagramme entités-relations (mermaid), une fiche par table (rôle, colonnes, types, nullabilité, valeurs par défaut, contraintes), cardinalités et règles de suppression (`on delete cascade / restrict / set null`) justifiées, stratégie d'isolation par utilisateur (RLS), index prévus avec la requête qu'ils servent. L'opérateur voit le modèle ; les tâches de code partent de ce modèle validé.
- **Tout en anglais dans le code et la base** : tables, colonnes, types énumérés, fonctions, en `snake_case`, au pluriel pour les tables. Le français reste réservé aux textes affichés. Aucune exception.

**Robustesse**
- Clé primaire UUID, clés étrangères partout où une relation existe, avec une règle de suppression explicite ; clé étrangère composite `(id, user_id)` quand une ligne enfant doit appartenir au même utilisateur que son parent.
- Contraintes en base plutôt que dans l'application seule : `not null`, `check` (valeurs, bornes, plages de dates), `unique`, types énumérés ; la validation côté serveur (zod) reprend les mêmes bornes, testées ensemble.
- RLS activée et forcée sur chaque table utilisateur, politiques avec `(select auth.uid())` ; droits par colonne quand une colonne ne doit pas être modifiée directement ; fonctions `security definer` réservées aux cas justifiés, `search_path` vide, propriétaire vérifié dedans.
- Migrations en avant uniquement, nommées, testées sur des données existantes (reprise sans perte) et vérifiées depuis une base vide.

**Transactions (ACID) et concurrence**
- Toute opération qui écrit à plusieurs endroits s'exécute dans une seule transaction : une fonction SQL, ou une transaction explicite côté serveur. Pas de suite d'appels séparés qui peut s'arrêter au milieu.
- Quand une étape ne peut pas entrer dans la transaction (fichier dans un stockage objet, e-mail, API externe), le modèle documente la compensation (annulation de l'étape déjà faite) ou l'idempotence (réservation avant envoi, clé d'unicité), et un test prouve le comportement en cas d'échec à chaque étape.
- Les invariants qui peuvent être cassés par deux requêtes simultanées (quota, doublon, « déjà fait ») sont protégés en base : contrainte d'unicité, verrou de ligne (`for update`) ou verrou consultatif ; un test lance des appels concurrents.

**Écritures uniques (anti double clic) et cohérence**

Un clic répété, une connexion lente qui renvoie, un retour arrière du navigateur ne doivent jamais créer deux écritures. Trois niveaux, tous obligatoires pour toute action qui écrit :
1. **Interface** : pendant l'envoi, le bouton passe en état « en cours » (`aria-busy`, `aria-disabled`, libellé de chargement) et ignore les clics suivants ; le formulaire n'est soumis qu'une fois.
2. **Serveur (idempotence)** : chaque formulaire de création porte une clé d'idempotence générée à l'affichage (champ caché, UUID) ; la table la stocke avec une contrainte d'unicité `(user_id, idempotency_key)` ; une seconde requête avec la même clé renvoie le résultat de la première au lieu d'écrire. Les actions de mise à jour sont idempotentes par nature (poser une valeur, pas l'incrémenter) ; les actions « faire une fois » (marquer fait, relancer, envoyer) vérifient l'état en base dans la même transaction.
3. **Base** : contraintes d'unicité sur les clés naturelles quand elles existent (un seul envoi par utilisateur, type et période ; un seul brouillon ouvert, etc.), en dernier rempart.

**Mises à jour concurrentes (pas de mise à jour perdue)**
- Deux onglets ou deux appareils qui modifient la même ligne : verrou optimiste par défaut, avec une colonne de version (`version integer` ou `updated_at`) envoyée avec le formulaire et vérifiée dans le `update … where id = … and version = …` ; en cas de conflit, l'utilisateur voit un message clair et la valeur actuelle, rien n'est écrasé en silence.
- Verrou pessimiste (`select … for update`) seulement dans une transaction courte qui lit puis écrit une valeur dont dépend l'invariant (compteur, quota, état).

**Verrous : règles**
- Transactions courtes : aucun appel réseau (e-mail, API, stockage) pendant qu'un verrou de base est tenu.
- Ordre de verrouillage fixe (par exemple toujours la candidature avant ses événements) pour éviter les interblocages ; `lock_timeout` et `statement_timeout` réglés pour qu'une attente anormale échoue proprement au lieu de bloquer.
- Verrous consultatifs (`pg_advisory_xact_lock`) libérés automatiquement en fin de transaction, jamais en mode session.
- Côté pipeline, les ressources partagées (base de test, ports) utilisent les verrous à bail de `apv lock` (expiration, propriétaire vérifié), jamais un verrou sans fin.

**Tests exigés**
- Double clic simulé sur chaque action qui écrit : une seule ligne créée, un seul envoi.
- Deux requêtes identiques envoyées en même temps au serveur (même clé d'idempotence, puis clés différentes sur une ressource unique) : le résultat attendu, sans doublon.
- Deux mises à jour concurrentes de la même ligne : la seconde reçoit un conflit, aucune donnée perdue.
- `apv db check` signale une table de création sans clé d'idempotence ni clé naturelle unique.

**Normalisation**
- Forme normale de Boyce-Codd (BCNF) par défaut, troisième forme normale au minimum.
- Toute redondance est déclarée dans le modèle avec sa raison et son garde-fou : par exemple `user_id` répété dans une table enfant pour la RLS, verrouillé par une clé étrangère composite `(id, user_id)` ; une valeur calculée gardée pour la performance, maintenue par la base (déclencheur ou fonction) et jamais écrite librement par l'application.
- `apv db check` signale une colonne dupliquée entre tables sans garde-fou déclaré.

**Performance et minimisation**
- Chaque requête sélectionne des colonnes nommées, jamais `*`. Chaque chargement de page ne remonte que ce que l'écran affiche ; rien de plus n'est envoyé au navigateur (contrôle du contenu des données de page).
- Un index par clé étrangère et par motif de requête réel (filtre, tri, pagination), vérifié par `EXPLAIN` sur un volume réaliste ; index partiels quand une condition est constante (par exemple lignes non supprimées).
- Pas de requête N+1 : nombre de requêtes par chargement de page mesuré dans les tests et borné ; pagination et limites côté serveur.
- Types adaptés (dates en `date`, horodatages en `timestamptz`, montants en entiers ou `numeric`), pas de JSON fourre-tout pour des données structurées.

**Contrôle automatique : `apv db check`** (contrôle déclaré, bloquant)
- Noms : aucun identifiant de table, colonne, type ou fonction hors anglais `snake_case` (liste de mots français courants refusée).
- Chaque clé étrangère a un index ; chaque table utilisateur a RLS activée et forcée ; aucune politique trop large ; aucune fonction `security definer` sans `search_path` fixé.
- Conseillers de la base quand ils existent (par exemple les « advisors » de sécurité et de performance de Supabase).
- Aucun `select('*')` ni `select *` dans le code serveur.
- `EXPLAIN` des requêtes principales listées dans le modèle : pas de parcours séquentiel sur une table utilisateur au-delà d'un seuil de lignes.

**Revue** : avant chaque livraison, l'architecte des données relit les migrations et les requêtes ajoutées (au même titre que les revues sécurité, fidélité et RGPD), avec une grille qui couvre la modélisation, les transactions, la concurrence, la normalisation, les index et la minimisation.

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
| 1. Socle | `plugin.json`, agents (dont `architecte-donnees`), compétence chef-de-projet, `/apv:status`, `/apv:quota`, `/apv:resume`, outil `apv` (spec, ledger, gates, scope, lock, db check), hooks de garde | Le plugin s'installe ; les tests conservés passent ; les verrous expirent ; le hook bloque un force-push ; `apv db check` refuse une table en français, une clé étrangère sans index et une table sans RLS |
| 2. Design et aperçu | `/apv:design`, `/apv:preview`, compétence design-artefact | Une maquette itérée et validée est versionnée ; l'aperçu se met à jour sur une branche |
| 3. Exécution | `/apv:init`, `/apv:spec`, `/apv:run` avec workflows, intégrateur, revues, `/apv:stack` | Une spec réelle est livrée en PR avec vagues parallèles, revues et reprise après interruption simulée |
| 4. RGPD et migration | agent `dpo`, compétence `rgpd`, `/apv:onboard` depuis V2 | « Toujours rien » tourne sous APV3 ; ses pages légales passent la revue du DPO |

État des phases :
- **Phase 1 : faite** (3.0.0-alpha.1, PR #68).
- **Phase 2 : faite** (3.0.0-alpha.2). `apv design register|list|check` verse une maquette validée par l'opérateur (citation exacte au registre, empreinte sha256) et détecte sa dérive ; `/apv:design` mène la boucle par artefact. `apv preview update|status|stop|logs` et `/apv:preview` mettent l'aperçu à jour sur une branche : essai réel sur « Toujours rien » (pile d'aperçu en 563xx, port 5190), qui remplace le script manuel du projet pilote.
- Phases 3 et 4 : à faire.

Chaque phase est livrée en PR à fusionner par l'opérateur.

## 16. Points ouverts

- ~~Champ d'effort dans le format d'agent~~ : fermé en phase 1, le champ `effort` est accepté dans le frontmatter des agents ; les 9 agents le fixent à `high` au minimum.
- Base de test par agent : schémas dédiés ou piles séparées selon la stack (Supabase : une pile par agent coûte cher en mémoire ; alternative : schéma par worktree).
- Hors de Claude Code (Codex, autres fournisseurs) : non couvert par V3 ; V2 reste disponible par ses tags.
