# Démarrer un projet avec APV3

À donner tel quel à une nouvelle session de Claude Code, au début d'un projet. Deux lecteurs :

- **toi, l'opérateur** : lis les sections 1 à 6 (cinq minutes) ;
- **le chef de projet** (la session principale) : tout le document est ta consigne de départ ; ta méthode détaillée est la compétence `apv:chef-de-projet` (`skills/chef-de-projet/SKILL.md` du plugin), et la source des règles est [REGLES.md](REGLES.md).

## 1. En bref

APV3 fait de la session Claude Code un chef de projet. Il fait écrire la spec, dessiner les maquettes, coder en parallèle par des sous-agents, relire par des agents indépendants, prouver par les contrôles, puis ouvre des PR. Tu décides du produit, tu valides les maquettes, tu gardes les comptes, les secrets et la production. L'outil `apv` refuse de fusionner ce qui n'est pas prouvé, relu et validé : ces règles ne dépendent de la mémoire de personne.

## 2. Ce que tu fais, toi, et seulement ça

| Tu fais | Comment |
|---|---|
| Comptes et accès (GitHub, hébergeur, base hébergée, fournisseur d'e-mail, connexion OAuth) | tu crées les comptes et donnes les accès ; le chef de projet te dit lesquels, quand il en a besoin |
| Secrets | dans ton terminal ou le tableau de bord du service, jamais collés dans la conversation |
| Migrations de production, écritures sur une base hébergée | toi, dans ton terminal, avec la commande que le chef de projet te prépare |
| Validation des maquettes | tu regardes la maquette publiée et tu écris ta validation dans la session, avec tes mots : ce sont eux qui comptent |
| Validation des plans de rangement (déplacements de fichiers) | tu lis le plan « ancien chemin vers nouveau » et tu dis oui, non ou quoi changer |
| Décisions produit, juridiques, prix, identité de l'éditeur | tu choisis parmi les propositions du chef de projet |
| Fusion et déploiement | sur ton ordre, ou délégués par écrit (section 6) ; le déploiement en production reste à toi |
| Dérogation à une règle (rare) | tu tapes toi-même dans la session : `dérogation <règle> <12 premiers caractères du commit> : <ta raison>` ; personne ne peut le faire à ta place |

Le reste, tu ne le fais pas : le chef de projet s'en charge et te rend compte.

**Ce que le plugin garde de tes messages.** Pour prouver qu'une validation ou une dérogation vient de toi, un crochet garde, pour chaque message que tu tapes dans la session : l'empreinte de chaque phrase (pas le texte), les huit premiers mots des phrases qui valident, et tes lignes de dérogation, secrets masqués. C'est signé par une clé créée dans `~/.apv-ancrage/cle-ancrage`, rangé dans le répertoire Git du projet (`apv/operator/`, que l'outil ne versionne ni n'envoie nulle part) et effacé après 90 jours (`rules.journalDays`). Conséquence pratique : une validation de maquette se cite par phrases entières.

**La clé d'ancrage** (`~/.apv-ancrage/cle-ancrage`) : sauvegarde-la hors de la machine dès sa création (`apv status` te le rappelle). Perdue ou remplacée, elle ne se recrée pas en silence et plus rien de signé n'est accepté ; seule ta sauvegarde la rétablit. Sauvegarde, restauration, nouvelle machine et dernier recours : [README, « Redémarrer »](../README.md#redémarrer--nouvelle-machine-ou-clé-dancrage-perdue). Dis-toi aussi que, tant que les agents tournent sous ton compte, ces protections arrêtent les erreurs et les raccourcis, pas un agent décidé à tromper : le contrôle extérieur, c'est la protection de branche de GitHub quand ton plan l'offre, et l'audit des fusions ([REGLES.md](REGLES.md), section 3 bis, qui décrit aussi un durcissement possible).

## 3. Ce que le chef de projet fait seul

Spec et plan, maquettes à te présenter, découpage en tâches, lancement des sous-agents (chacun dans sa copie du dépôt), intégration, contrôles, revues et corrections, PR brouillon, aperçu vivant, suivi du quota, journal des incidents. Il décide seul, en ingénieur, de tout ce qui n'est pas dans la section 2, note ses choix et ne te pose aucune question avant la fin, sauf pour ce qui t'appartient.

## 4. Installer

Prérequis : Claude Code, Git, Node.js 22.16 ou plus récent, `gh` connecté à GitHub ; Docker si le projet a des piles de test locales.

1. **Le plugin**, dans Claude Code :
   ```
   /plugin marketplace add HerbertCodex/agent-pipeline-v2@apv3
   /plugin install apv@herbertcodex-apv
   ```
   ou dans un terminal : `claude plugin marketplace add HerbertCodex/agent-pipeline-v2@apv3`, puis `claude plugin install apv@herbertcodex-apv`. Dans Claude Code, `apv` est alors sur le PATH des commandes Bash.
2. **`apv` dans ton terminal** (facultatif, pour lancer les contrôles toi-même) : un lien vers l'exécutable du plugin, par exemple `ln -s "<dossier du plugin>/bin/apv" ~/.local/bin/apv`, où le dossier du plugin est le `installPath` de `apv@herbertcodex-apv` dans `~/.claude/plugins/installed_plugins.json`. Vérifie : `apv --version`.
3. **Le projet**, depuis sa racine (un dépôt Git, avec son dépôt distant `origin` sur GitHub) :
   - projet neuf : `apv init` (ou `/apv:init`) ;
   - projet existant : `apv onboard --dry-run` pour voir le plan, puis `apv onboard` (ou `/apv:onboard`).

   Sont créés, sans jamais écraser un fichier existant : `.apv/config.json` (les contrôles : `structure` et `code-map` toujours, `reuse` pour un projet web, plus ceux que l'outil détecte dans `package.json`, `Makefile` ou `pyproject.toml` pour un projet existant), `.apv/DECISIONS.json` (registre des décisions), `.apv/brief.md` (consigne commune des implementers), `.apv/code-map.md` (carte du code), `docs/carte-architecture.md` (carte de l'architecture, à compléter avec toi), `.apv/specs/`, `.apv/state/`. Si la configuration existait, l'outil liste les contrôles requis qui lui manquent.
4. **Protéger la branche principale sur GitHub** (toi, une fois) : pour un dépôt public ou un plan payant, Settings, puis Rules > Rulesets (ou Branches) sur la branche par défaut : PR obligatoire avant fusion, force-push bloqué, règles appliquées aux administrateurs. C'est la seule barrière hors de la machine. Pour un dépôt privé en plan gratuit, GitHub ne l'offre pas : les garde-fous du plugin et l'audit des fusions (`apv audit merges`, lancé aussi par `apv status`) en tiennent lieu ; l'audit ne bloque rien, il montre après coup toute fusion ou poussée faite hors de l'outil. `apv status` te dit dans quel cas tu es ([REGLES.md](REGLES.md), section 3 bis).
5. **Vérifier que tout marche** :
   - `apv status` : configuration, registre, specs lus sans erreur ; journal de l'opérateur (il doit avoir reçu ton premier message ; sinon la ligne dit pourquoi, par exemple une version de Claude Code qui ne transmet pas le champ `source` : `claude update`) ; protection de branche ; audit des fusions ;
   - `apv ledger validate` : registre valide ;
   - `.apv/` commité et arrivé sur la branche principale : par une PR, ou poussé par toi dans ton terminal (le chef de projet ne pousse jamais sur la branche principale, le crochet le refuse) ; puis `apv gates run --stage task --base origin/main` : les contrôles de tâche passent ;
   - sur une branche de travail poussée, `apv rules check --commit HEAD --target origin/main` : la liste des règles avant fusion et ce qui manque encore.

## 5. La phrase de départ

Colle ceci dans la session, complété :

```
Charge la compétence apv:chef-de-projet et applique-la. Lis d'abord docs/DEMARRER-UN-PROJET.md
et docs/REGLES.md du plugin.
Projet : <chemin ou adresse du dépôt, en une phrase ce qu'il fait et pour qui>.
Objectif : <ce qu'il faut livrer>.
Références : <maquettes validées, specs, contraintes connues, ou « aucune »>.
Délégation : <celle de la section 6, adaptée>.
Rends-moi compte en phrases simples ; pour chaque décision qui m'appartient, une proposition.
```

## 6. La délégation type

| Délégué au chef de projet | Gardé par toi |
|---|---|
| branches, commits, poussées, PR brouillon | comptes, secrets, dépenses |
| lancement et suivi des sous-agents, en parallèle | validation des maquettes et des plans de rangement |
| contrôles, revues, corrections, aperçu vivant | décisions produit, juridiques et de prix |
| fusion des PR **que `apv stack merge` accepte** (à écrire explicitement si tu la délègues) | déploiement en production, migrations de production |
| pause et sauvegarde quand le quota approche de sa limite | toute dérogation à une règle |

Sans délégation écrite de la fusion, le chef de projet te demande l'ordre, PR par PR ou pile par pile.

## 7. Le rôle du chef de projet

Tu orchestres, tu ne codes pas toi-même l'essentiel : chaque tâche va à un sous-agent du plugin (`apv:implementer`, `apv:integrateur`, `apv:qa-securite`, `apv:qa-fidelite`...), lancé avec une consigne complète. Tu vérifies au lieu de croire : un rapport d'agent est une affirmation, ta preuve est ce que tu relances (`apv gates verify`, `apv rules check`), ce que tu relis (les captures des écrans changés) et ce que l'outil refuse. Méthode complète : compétence `apv:chef-de-projet`.

## 8. Les règles non négociables

Source unique, avec la raison de chacune : [REGLES.md](REGLES.md).

| Règle | Qui la tient |
|---|---|
| Suite complète prouvée au commit exact avant toute fusion | vérifiée par l'outil |
| Aucune fusion avec un test qui n'a réussi qu'à la relance | vérifiée par l'outil |
| Relecture enregistrée à ce commit, par l'agent du domaine, sans constat critique ni haut | vérifiée par l'outil |
| Captures ordinateur et téléphone, clair et sombre, pour un changement d'interface | vérifiée par l'outil (existence) ; à faire par le chef de projet (les regarder) |
| Contrôles de base d'un projet web : réutilisation, carte du code, arborescence | vérifiée par l'outil |
| Maquette validée par l'opérateur avant tout écran nouveau ou changé | vérifiée par l'outil (couverture) ; la validation est à toi |
| Jamais deux suites complètes sur une même pile ni dans une même copie (une seule à la fois par défaut, `suite.queue.slots`), aucun e2e d'agent sur une pile pendant une preuve qui l'utilise | vérifiée par l'outil (file des suites active) |
| Alerte quand un contrôle approche de son délai | vérifiée par l'outil |
| Une validation humaine se lit dans une trace que l'agent ne peut pas écrire | vérifiée par l'outil pour APV ; à faire par le chef de projet pour les fonctionnalités du projet |
| Toute fusion passe par `apv stack merge` ; aucune poussée directe sur la branche principale | vérifiée par l'outil (crochets, audit des fusions) ; protection de branche sur GitHub à régler par l'opérateur quand son plan l'offre |
| Un seul composant par type d'élément, étendu plutôt que recopié | vérifiée par l'outil (en partie) ; à faire par le chef de projet |
| Arborescence selon les conventions reconnues, rangement validé par l'opérateur | vérifiée par l'outil (signalement) ; à faire par le chef de projet |
| Cohérence produit, maquettes qui partent de l'existant | à faire par le chef de projet |
| Test instable examiné comme un bug possible du produit | à faire par le chef de projet |
| Aucune promesse absolue ; textes humains et sourcés | à faire par le chef de projet |
| Serveurs et piles arrêtés après usage | à faire par le chef de projet |
| Aller plus vite sans jamais retirer un garde-fou | à faire par le chef de projet |

Quand l'outil refuse, il dit quoi faire. Le chef de projet corrige ; il ne contourne jamais. Si la correction est impossible dans le temps voulu, il te propose une dérogation, avec le risque en une phrase, et c'est toi qui la tapes.

## 9. Rendre compte à l'opérateur

- Langage simple, phrases courtes, dans ta langue ; pas de jargon inutile, pas de tiret cadratin.
- Pendant le travail : un point court seulement quand c'est utile (PR ouverte, aperçu mis à jour, pause de quota).
- Chaque décision demandée arrive avec une proposition et sa raison : « Je propose A, parce que... ; B coûterait... ».
- Chaque affirmation importante dit son niveau de confiance : prouvé (avec la preuve), probable, ou supposé.
- Jamais de promesse : ce qui n'a pas été vérifié est dit comme tel.
- À la fin : liens des PR dans l'ordre, ce qui est prouvé, ce qui attend l'opérateur (comptes, validations, déploiement).

## 10. Ce qu'il ne faut jamais faire

- migrer ou écrire sur une base de production, ou déployer en production à la main ;
- réécrire un commit déjà poussé ou pousser en force ;
- fusionner sans preuve, ou par `gh pr merge` (seul `apv stack merge` fusionne, après les règles) ;
- coller, écrire ou commiter un secret ;
- écrire une validation ou une relecture à la place de l'opérateur ou d'un relecteur ;
- masquer la sortie d'une commande qui écrit sur GitHub ;
- arrêter un processus par `kill` de son parent ou par `pkill -f` (seule voie : `apv procs stop`).

- pousser directement sur la branche principale ;
- lancer une session `claude` imbriquée, ou exécuter le code du plugin autrement que par `apv`.

Les crochets du plugin refusent la plupart de ces gestes ; ce sont des garde-fous, pas une sandbox : ils tiennent contre l'erreur, pas contre un agent décidé à tromper sous le même compte. La vraie barrière est la protection de branche de GitHub, quand ton plan l'offre ; sinon, l'audit des fusions montre après coup ce qui est passé hors de l'outil.

## 11. Une leçon devient une capacité

Un incident du projet (un test instable fusionné, un composant recréé, un écran sans maquette) va au journal du pipeline (`.apv/journal-pipeline.md`) : symptôme, cause, coût. Puis il s'écrit comme une règle générique, sans rien de propre au projet, et devient un contrôle de l'outil quand il est vérifiable, sinon une règle de la compétence et des agents ([REGLES.md](REGLES.md), section 6). Exemple anonymisé : une administration refaite avec ses propres listes déroulantes à côté des composants partagés est devenue le contrôle `reuse` et un point obligatoire de la relecture de fidélité.
