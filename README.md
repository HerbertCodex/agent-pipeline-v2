<div align="center">

# Agent Pipeline V3

**Un chef de projet Claude Code, de vrais sous-agents, des garde-fous qui ont fait leurs preuves.**

[![Version](https://img.shields.io/badge/alpha-3.0.0--alpha.3-a8461a?style=flat-square)](docs/PLUGIN.md)
[![CI](https://github.com/HerbertCodex/agent-pipeline-v2/actions/workflows/ci.yml/badge.svg)](https://github.com/HerbertCodex/agent-pipeline-v2/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.16-2d6e45?style=flat-square)](package.json)
[![License](https://img.shields.io/badge/licence-MIT-55514a?style=flat-square)](LICENSE)

</div>

---

APV3 est un plugin Claude Code. L'opérateur délègue ; la session principale devient chef de projet : elle fait rédiger la spec, concevoir les données, coder les tâches en parallèle dans des worktrees, intégrer, faire relire par des revues indépendantes (sécurité, fidélité à la maquette, données, RGPD), puis ouvre des PR brouillon. Elle ne rappelle l'opérateur que pour ce qui lui revient, ou à la fin.

## Ce que contient le plugin

- **10 sous-agents** : `product`, `architecte`, `architecte-donnees`, `designer`, `critique-design`, `implementer`, `integrateur`, `qa-securite`, `qa-fidelite`, `dpo`.
- **La méthode du chef de projet** (compétence `chef-de-projet`) : vagues parallèles précédées des fondations, verrous à bail, suivi du quota et sauvegarde, reprise après coupure, pile de PR, journal du pipeline.
- **Des commandes** `/apv:init`, `/apv:spec`, `/apv:run`, `/apv:review`, `/apv:stack`, `/apv:design`, `/apv:preview`, `/apv:status`, `/apv:quota`, `/apv:resume` et `/apv:onboard` (reprise d'un projet V2 ou existant), et deux **workflows** de vagues parallèles (`apv:vague`, `apv:revues`).
- **Des hooks** : contexte de reprise au démarrage, exécutions non livrées comprises ; blocage du force-push, de la fusion et du déploiement hors commande dédiée, et des écritures GitHub à sortie masquée.
- **L'outil `apv`** (TypeScript, sans dépendance) : validation des specs, registre des décisions, contrôles, périmètre, verrous, contrôle du modèle de données, quota. L'exécutable `bin/apv` le rend appelable par `apv` dans les commandes Bash de Claude Code.

## Démarrer

```
/plugin marketplace add HerbertCodex/agent-pipeline-v2@apv3
/plugin install apv@herbertcodex-apv
```

Puis suivez [START-HERE.md](START-HERE.md). Détails : [docs/PLUGIN.md](docs/PLUGIN.md). Outil `apv` : [docs/CLI.md](docs/CLI.md). Spécification : [docs/APV3-SPEC.md](docs/APV3-SPEC.md).

## Développer

```bash
npm ci --ignore-scripts
npm test
```

## Ancienne version (V2)

Le CLI `apv2` (dernière version 2.0.0-alpha.8, contrôleur qui enchaîne les rôles) reste disponible sur la branche `main` jusqu'à la fusion d'APV3. Son guide de démarrage est archivé dans [docs/v2/START-HERE.md](docs/v2/START-HERE.md) et son historique dans le [CHANGELOG](CHANGELOG.md).

---

**Statut : alpha, phases 1 à 3 faites (socle, design et aperçu, exécution) ; phase 4 en cours (`/apv:onboard` disponible, projet pilote sous APV3 à venir).** Usage local sur des dépôts de confiance ; les hooks sont des garde-fous, pas une sandbox. [Licence MIT](LICENSE)
