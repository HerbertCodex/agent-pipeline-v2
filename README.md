<div align="center">

# Agent Pipeline V3

**Un chef de projet Claude Code, de vrais sous-agents, des règles que l'outil fait respecter.**

[![Version](https://img.shields.io/badge/alpha-3.0.0--alpha.19-a8461a?style=flat-square)](docs/PLUGIN.md)
[![CI](https://github.com/HerbertCodex/agent-pipeline-v2/actions/workflows/ci.yml/badge.svg)](https://github.com/HerbertCodex/agent-pipeline-v2/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.16-2d6e45?style=flat-square)](package.json)
[![License](https://img.shields.io/badge/licence-MIT-55514a?style=flat-square)](LICENSE)

</div>

---

APV3 est un plugin Claude Code. La session principale devient chef de projet : elle fait écrire la spec, valider les maquettes par l'opérateur, coder les tâches en parallèle par des sous-agents (chacun dans sa copie du dépôt), relire par des agents indépendants (sécurité, fidélité à la maquette, données, RGPD), prouver par les contrôles, puis ouvre des PR. L'outil `apv` qui l'accompagne refuse de fusionner ce qui n'est pas prouvé, relu et validé ([règles du chef de projet](docs/REGLES.md)).

- **11 sous-agents** : `product`, `architecte`, `architecte-donnees`, `designer`, `critique-design`, `implementer`, `integrateur`, `qa-securite`, `qa-fidelite`, `dpo`, `auditeur-web`.
- **La méthode du chef de projet** (compétence `apv:chef-de-projet`), des commandes `/apv:...`, deux workflows de vagues parallèles, des crochets qui bloquent les gestes dangereux.
- **L'outil `apv`** (TypeScript, sans dépendance) : specs, registre des décisions, contrôles et preuves, règles avant fusion, relectures enregistrées, verrous, carte du code, réutilisation, arborescence.

Démarrer un nouveau projet, pour l'opérateur et pour le chef de projet : **[docs/DEMARRER-UN-PROJET.md](docs/DEMARRER-UN-PROJET.md)**.

## Installer

Prérequis : Claude Code, Git, Node.js 22.16 ou plus récent, `gh` connecté à GitHub ; Docker pour les piles de test locales.

Dans Claude Code :

```
/plugin marketplace add HerbertCodex/agent-pipeline-v2@apv3
/plugin install apv@herbertcodex-apv
```

ou dans un terminal : `claude plugin marketplace add HerbertCodex/agent-pipeline-v2@apv3` puis `claude plugin install apv@herbertcodex-apv`.

Le plugin livre l'outil compilé et son exécutable `bin/apv`. Dans Claude Code, `apv` est sur le PATH des commandes Bash. Pour ton terminal, fais un lien : `ln -s "<dossier du plugin>/bin/apv" ~/.local/bin/apv` (le dossier est le `installPath` de `apv@herbertcodex-apv` dans `~/.claude/plugins/installed_plugins.json`), puis vérifie : `apv --version`.

## Redémarrer : nouvelle machine, ou clé d'ancrage perdue

Sans plugin actif, un projet sous APV tourne **sans ses crochets** : pas de sceau des relectures, pas de journal de l'opérateur, pas de garde-fous. Ses agents n'ont plus ni les compétences `/apv:*` ni les agents `apv:*`, et aucune fusion ne passe les règles. Fais ces étapes **dans ton terminal**, dans l'ordre, avant d'ouvrir une session dans un projet.

1. **Le pipeline et son plugin.** Avec une marketplace locale, le plugin suit la copie que tu as sur la machine :
   ```
   git clone https://github.com/HerbertCodex/agent-pipeline-v2 ~/agent-pipeline-v2 && git -C ~/agent-pipeline-v2 switch apv3
   claude plugin marketplace add ~/agent-pipeline-v2
   claude plugin install apv@herbertcodex-apv
   ```
   Fais-le dans un terminal : l'extension VS Code n'a pas `/plugin`. Ouvre ensuite une **nouvelle** session, car une session déjà ouverte ne charge pas le plugin. Mets aussi `apv` sur le PATH (lien ci-dessus) et connecte `gh` (`gh auth status`).
2. **La clé d'ancrage, avant la première session.** Elle signe le journal de l'opérateur, les sceaux des relectures et les traces de fusion. Elle vit hors de tout dépôt, dans `~/.apv-ancrage/cle-ancrage`, où `~` est le dossier de ton compte : l'outil le lit dans la base des comptes, jamais dans `HOME`. Le shell, lui, développe `~` depuis `HOME` : vérifie d'abord que `echo ~` et `getent passwd "$USER" | cut -d: -f6` (sur macOS : `dscl . -read "/Users/$USER" NFSHomeDirectory`) donnent le même dossier. Les agents ne doivent pas y toucher, et les crochets refusent les commandes qui la nomment : chaque commande sur la clé se tape dans ton terminal.
   - **Sauvegarder**, dès qu'elle existe (`apv status` le rappelle la première semaine) : `base64 -w0 ~/.apv-ancrage/cle-ancrage` (sur macOS : `base64 -i ~/.apv-ancrage/cle-ancrage`), puis range la sortie dans ton gestionnaire de mots de passe.
   - **Restaurer**, sur une nouvelle machine, avant d'écrire le moindre message dans une session : `mkdir -p ~/.apv-ancrage && chmod 700 ~/.apv-ancrage && (umask 077; trap 'stty echo' EXIT INT; stty -echo; base64 -d > ~/.apv-ancrage/cle-ancrage)`, colle la sauvegarde (l'écho revient même après un Ctrl-C), puis Entrée et Ctrl-D, et enfin `chmod 400 ~/.apv-ancrage/cle-ancrage`. La clé ne passe ainsi ni par l'historique du shell ni par l'écran, et le fichier n'est jamais lisible par les autres comptes. Sans clé, le premier message de l'opérateur en crée une nouvelle dans tout projet qui n'a encore rien de signé. C'est le cas d'un clone neuf : ses magasins (`<répertoire git commun>/apv/`) restent sur l'ancienne machine, car Git ne les pousse pas. La restauration doit donc passer avant.
   - **Garder l'historique**, au besoin : copie les magasins `<répertoire git commun>/apv/` de chaque projet depuis l'ancienne machine, dans ton terminal, avec `rsync -a` (qui garde leurs droits 0600 et 0700). Supprime-les ensuite de l'ancienne machine : le journal de l'opérateur qu'ils contiennent n'y serait plus purgé. Sans ces magasins, les relectures des PR ouvertes se refont, et `apv audit merges` ne connaît plus les fusions passées.
   - **Clé perdue sans sauvegarde** : plus rien de signé n'est accepté dans les projets qui gardent son empreinte. Cela vaut pour les validations citées depuis le journal, les relectures scellées et les traces de fusion. La clé ne se recrée jamais en silence. Dernier recours, dans ton terminal, pour chaque projet concerné :
     1. supprime le journal de l'opérateur, `rm -rf "$(git rev-parse --git-common-dir)/apv/operator"`. Sans la clé, il ne sert plus à rien, et une archive échapperait à sa purge à 90 jours ;
     2. si tu veux garder une trace, archive seulement les relectures et les traces de fusion : `mkdir -p -m 700 ~/apv-archive-<projet> && mv "$(git rev-parse --git-common-dir)/apv/reviews" "$(git rev-parse --git-common-dir)/apv/merges" ~/apv-archive-<projet>/`, et supprime l'archive dès qu'elle ne sert plus ;
     3. supprime le reste des magasins : `rm -rf "$(git rev-parse --git-common-dir)/apv"`. Il contient ce que l'outil refait de lui-même : reçus des contrôles, verrous, lots, copies de travail, piles, carte, aperçu, réutilisation et arborescence. Les preuves seront à relancer.

     Une nouvelle clé se crée alors au premier message. Il faut ensuite refaire les relectures des PR ouvertes et retaper les validations, et l'audit des fusions repart de zéro. Sauvegarde aussitôt la nouvelle clé.
3. **Vérifier**, dans chaque projet : `apv status` (ou `/apv:status` dans la session) doit montrer :
   - `Plugin : apv@herbertcodex-apv <version>`, sans « ATTENTION » (plugin absent ou désactivé : la ligne donne la commande à lancer) ;
   - aucune ligne « règles de fusion que le plugin installé ne connaît pas ». Si elle apparaît, mets le plugin à jour avec la commande qu'elle donne ;
   - après un premier message tapé dans la session, `Journal de l'opérateur : 1 message(s) …` et aucune « ATTENTION » sur la clé.
4. **Mettre à jour le pipeline** : d'abord `git -C ~/agent-pipeline-v2 fetch`, puis `apv status`. La ligne « Mise à jour à venir » liste les nouvelles règles de fusion et ce qu'elles exigent (plugin, clé, relecteurs). Réunis ces conditions avant la mise à jour, puis mets à jour l'outil et le plugin ensemble : `git -C ~/agent-pipeline-v2 pull`, puis `claude plugin marketplace update herbertcodex-apv && claude plugin update apv@herbertcodex-apv`, puis une nouvelle session. Une mise à jour de l'outil seul applique les nouvelles règles avant que les crochets sachent les remplir, et les fusions se bloquent (projet pilote, nuit du 2 au 3 octobre 2026).

**Une PR du pipeline se travaille depuis une session ouverte dans le dépôt du pipeline**, jamais depuis la session d'un projet. Depuis une autre session, les crochets refusent d'exécuter le code du plugin, et, avec un plugin antérieur à la correction du sceau (PR #105), une relecture enregistrée là-bas se scelle dans le dépôt de la session au lieu de celui de la PR.

## Démarrer un projet

Depuis la racine du dépôt (Git, dépôt distant `origin`) :

| Étape | Commande |
|---|---|
| Projet neuf | `apv init` (ou `/apv:init`) |
| Projet existant | `apv onboard --dry-run` pour voir le plan, puis `apv onboard` (ou `/apv:onboard`) |
| Vérifier | `apv status`, `apv ledger validate`, puis, `.apv/` arrivé sur la branche principale (par une PR, ou poussé par l'opérateur : les agents ne poussent jamais sur elle), `apv gates run --stage task --base origin/main` |

Créé sans jamais écraser un fichier existant :

- `.apv/config.json` : les contrôles (`structure` et `code-map` toujours ; `reuse` pour un projet web ; pour un projet existant, aussi ceux détectés dans `package.json`, `Makefile` ou `pyproject.toml`) ;
- `.apv/DECISIONS.json` : le registre des décisions de l'opérateur ;
- `.apv/code-map.md` : la carte du code, lue par les agents avant de créer quoi que ce soit ;
- `docs/carte-architecture.md` : la carte de l'architecture (partie générée remplie, partie écrite à compléter avec l'opérateur), vérifiée par le contrôle `structure` ;
- `.apv/brief.md` : la consigne commune des implementers ; `.apv/specs/` et `.apv/state/`.

Sur une configuration existante, l'outil liste les contrôles que les règles exigent et qui lui manquent. Protège la branche principale sur GitHub (PR obligatoire, pas de force-push) si ton plan l'offre ; sinon, `apv audit merges` montre après coup ce qui est passé hors de l'outil ([règles](docs/REGLES.md), section 3 bis). Ensuite, colle dans la session la phrase de départ de [docs/DEMARRER-UN-PROJET.md](docs/DEMARRER-UN-PROJET.md).

## Le cycle d'une fonctionnalité

1. **Spec** : `/apv:spec <demande>`, puis `apv spec validate <fichier>` jusqu'à `VALID`.
2. **Maquette validée** : `/apv:design` ; l'opérateur valide par ses mots dans la session, `apv design register` la verse avec sa portée.
3. **Implémentation** : `/apv:run <spec>` : fondations, tâches en parallèle, intégration ; `apv gates run --stage task` à chaque tâche.
4. **Relecture** : `/apv:review` ; chaque relecteur enregistre sa relecture au commit relu (`apv review record`, captures comprises pour la fidélité).
5. **Preuve** : `apv gates run --stage full --base origin/main`, puis `apv gates verify --commit <tête>`.
6. **Fusion** : `apv rules check --commit <tête> --target origin/main`, puis `/apv:stack <pr...>` (`APV_ALLOW_MERGE=1 apv stack merge`), sur ordre de l'opérateur ou par sa délégation écrite. La fusion est refusée sans preuve complète au commit, avec un test réussi seulement à la relance, sans relecture enregistrée sans constat critique ni haut, sans les captures de la relecture de fidélité (sauf projet sans écran), sans les contrôles de base d'un projet web, ou sans maquette validée pour un écran.

## Commandes principales

| Commande | Rôle |
|---|---|
| `/apv:init`, `/apv:onboard` | préparer un projet neuf ou existant |
| `/apv:spec`, `/apv:design`, `/apv:run`, `/apv:review`, `/apv:stack` | le cycle ci-dessus |
| `/apv:status`, `/apv:resume`, `/apv:quota`, `/apv:preview` | état, reprise après coupure, quota, aperçu vivant |
| `apv gates run`, `apv gates verify` | contrôles et preuve au commit exact |
| `apv rules check` | règles vérifiées avant toute fusion |
| `apv audit merges` | fusions et poussées arrivées sur la branche principale sans `apv stack merge` |
| `apv review plan`, `apv review record`, `apv review show` | domaines de revue, relectures enregistrées |
| `apv reuse check`, `apv map`, `apv structure check` | réutilisation, carte du code, arborescence |
| `apv help <commande>` | aide de chaque commande |

## Documentation

- [Démarrer un projet](docs/DEMARRER-UN-PROJET.md) et [règles du chef de projet](docs/REGLES.md)
- [Plugin](docs/PLUGIN.md) : agents, compétences, crochets, mise à jour
- [Outil apv](docs/CLI.md), [configuration](docs/CONFIGURATION.md), [exécution d'une spec](docs/RUN.md)
- [Arborescence](docs/STRUCTURE.md), [réutilisation](docs/REUSE.md), [design](docs/DESIGN.md), [décisions](docs/DECISIONS.md), [sécurité](docs/SECURITY.md)
- [Toute la documentation](docs/README.md), [spécification](docs/APV3-SPEC.md), [évolutions](CHANGELOG.md)

**Mise à jour vers 3.0.0-alpha.11**, sur un projet déjà sous APV : lancez `apv map` une fois après la mise à jour et commitez `.apv/code-map.md` (et la carte de l'architecture si elle existe) dans une PR à part : la carte du code gagne une section « Dossiers », et le contrôle `code-map` la dit périmée « par la mise à jour d'APV » jusque-là. Pour le contrôle `structure` et la carte de l'architecture sur un projet existant : `apv structure map`, puis le contrôle à ajouter à `.apv/config.json` ([docs/STRUCTURE.md](docs/STRUCTURE.md)).

## Maquettes validées

Une maquette validée par l'opérateur est versée par `apv design register` : copie dans `docs/design/`, empreinte sha256 et décision au registre avec sa citation exacte ; `apv design check` détecte toute retouche. Un projet qui a beaucoup de maquettes les range par groupe (`docs/design/admin/`, `docs/design/produit/`) en déclarant `design.groups` (motifs sur le nom) et `design.defaultGroup` dans `.apv/config.json` ; `apv design organize` range celles déjà versées (`git mv`, chemin réécrit dans leur décision, empreinte vérifiée, fichiers qui citent l'ancien chemin listés). Détails : [docs/DESIGN.md](docs/DESIGN.md#6-configuration) et [`apv design`](docs/CLI.md#apv-design).

## Développer

```bash
npm ci --ignore-scripts
npm run check
```

---

**Statut : alpha.** Usage local sur des dépôts de confiance : les crochets du plugin sont des garde-fous, pas une sandbox. Le CLI `apv2` (V2) reste sur la branche `main` ([docs/v2/START-HERE.md](docs/v2/START-HERE.md)). [Licence MIT](LICENSE)
