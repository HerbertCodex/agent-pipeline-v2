# Démarrer avec Agent Pipeline V3

APV3 transforme votre session Claude Code en chef de projet. Vous décidez du produit, du design et des effets externes (fusion, déploiement, comptes) ; le chef de projet orchestre les sous-agents et vous rappelle à la fin.

## 1. Installer le plugin

```
/plugin marketplace add HerbertCodex/agent-pipeline-v2@apv3
/plugin install apv@herbertcodex-apv
```

Vérifiez : `/apv:status` doit répondre. Détails et mise à jour : [docs/PLUGIN.md](docs/PLUGIN.md).

## 2. Déléguer

Dans le dépôt de votre application, collez et complétez :

```
Charge la compétence apv:chef-de-projet et applique-la.
Projet : <URL ou chemin du dépôt, en une phrase ce qu'il fait>.
Objectif : <spec à livrer, ou demande>.
Références : <spec validée, maquette validée, registre des décisions, s'ils existent>.
Délégation : pas de questions avant la fin, sauf ce qui m'appartient (produit, design,
comptes, identité, fusion, déploiement). Branches poussées et PR brouillon autorisées ;
jamais de fusion, de force-push ni de déploiement sans mon ordre.
Relève le quota avant chaque vague (/apv:quota) et sauvegarde avant la limite.
```

Ou pas à pas, avec les commandes :

1. `/apv:init` : prépare `.apv/` (contrôles du dépôt, consigne commune, registre), une fois par projet.
2. `/apv:design` : maquette validée pour chaque écran nouveau.
3. `/apv:spec <demande>` : spec rédigée et validée.
4. `/apv:run <spec>` : exécution jusqu'à la PR brouillon (vagues parallèles, revues, corrections, aperçu). Déroulé : [docs/RUN.md](docs/RUN.md).
5. `/apv:stack <pr...>` : fusion de la pile de PR, seulement quand vous l'ordonnez.

## 3. Suivre et reprendre

- `/apv:status` : où en est-on (specs, exécutions, branches, PR, verrous, quota, aperçu).
- `/apv:quota` : fenêtres d'usage et dosage des agents.
- `/apv:resume` : après une coupure (session fermée, machine redémarrée, pause de quota), puis `/apv:run <spec>` reprend l'exécution où elle s'était arrêtée.
- `/apv:review` : revues indépendantes d'une branche.

## 4. Ce qui arrive par phases

Phase 4 : `/apv:onboard` est disponible (reprise d'un projet V2 ou existant : `apv onboard --dry-run`, puis `apv onboard`) ; le reste de la phase (projet pilote sous APV3, revue du DPO) est en cours.

## Ancienne version (V2)

Pour le CLI `apv2` (version 2.0.0-alpha.8), utilisez la branche `main` jusqu'à la fusion d'APV3 et son guide archivé : [docs/v2/START-HERE.md](docs/v2/START-HERE.md).
