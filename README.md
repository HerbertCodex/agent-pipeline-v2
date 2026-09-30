<div align="center">

# Agent Pipeline V3

**Un chef de projet Claude Code, de vrais sous-agents, des règles que l'outil fait respecter.**

[![Version](https://img.shields.io/badge/alpha-3.0.0--alpha.12-a8461a?style=flat-square)](docs/PLUGIN.md)
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
6. **Fusion** : `apv rules check --commit <tête> --target origin/main`, puis `/apv:stack <pr...>` (`APV_ALLOW_MERGE=1 apv stack merge`), sur ordre de l'opérateur ou par sa délégation écrite. La fusion est refusée sans preuve complète au commit, avec un test réussi seulement à la relance, sans relecture enregistrée sans constat critique ni haut, sans les captures d'un changement d'interface, sans les contrôles de base d'un projet web, ou sans maquette validée pour un écran.

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

## Développer

```bash
npm ci --ignore-scripts
npm run check
```

---

**Statut : alpha.** Usage local sur des dépôts de confiance : les crochets du plugin sont des garde-fous, pas une sandbox. Le CLI `apv2` (V2) reste sur la branche `main` ([docs/v2/START-HERE.md](docs/v2/START-HERE.md)). [Licence MIT](LICENSE)
