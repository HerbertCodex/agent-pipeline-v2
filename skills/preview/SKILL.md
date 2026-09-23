---
name: preview
description: "Met à jour l'aperçu vivant du projet sur une branche avec apv preview update, vérifie qu'il répond, puis l'annonce à l'opérateur (adresse, branche, ce qui a changé, compte de démo). À utiliser après chaque spec ou PR livrée, quand l'opérateur veut voir l'application, et après une reprise (redémarrage, coupure de session)."
argument-hint: "[branche] | status | stop | logs"
allowed-tools: Read Glob Grep Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js preview*) Bash(apv preview*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js lock status*) Bash(apv lock status*) Bash(git log*) Bash(git branch*) Bash(git status*) Bash(gh pr view*) Bash(gh pr list*) Bash(curl -sS -o /dev/null -w*) Bash(ss -ltnp*) Bash(docker ps*)
---

# /apv:preview

L'aperçu vivant est l'application qui tourne en permanence pour l'opérateur (spécification, section 12) : environnement séparé des tests, sa propre base jamais remise à zéro par les tests, des données de démonstration réalistes et un compte de démo. Il montre une branche à la fois.

Dans ce document, `apv` désigne `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` (ou `apv` s'il est sur le PATH). Arguments reçus : `$ARGUMENTS`.

## 1. Quand le mettre à jour
- **Après chaque livraison** : spec terminée, PR brouillon ouverte ou mise à jour. L'aperçu montre la tête de la pile livrée.
- **Sur demande de l'opérateur** (« montre-moi », « mets l'aperçu sur … »).
- **Après une reprise** : redémarrage de la machine, coupure de session, pause de quota. Vérifie d'abord l'environnement (Docker, pile de l'aperçu), puis mets à jour.
- Pas pendant une vague : un aperçu à moitié construit n'apprend rien à l'opérateur.

## 2. Commandes
Configuration : section `preview` de `.apv/config.json` (dossier de la copie, étapes installation, migrations, build, graine, commande de service, port, adresse annoncée). Détails : `${CLAUDE_PLUGIN_ROOT}/docs/PREVIEW.md`.

| Commande | Effet |
|---|---|
| `apv preview update [branche]` | reconstruit l'aperçu sur la branche (par défaut celle de la configuration), puis attend qu'il réponde |
| `apv preview status` | branche et commit servis, adresse, état du serveur |
| `apv preview logs` | journal du serveur et de la dernière mise à jour, valeurs du fichier d'environnement masquées ; ne recopie jamais `.apv/state/preview.log` lui-même, qui n'est pas masqué |
| `apv preview stop` | arrête l'aperçu **de ce projet** |

Déroulé :
1. Choisis la branche : l'argument, sinon la tête de la pile livrée, sinon la branche de la configuration. Elle doit être poussée ou commitée : l'aperçu montre un commit, jamais un arbre de travail en cours.
2. `apv preview update <branche>`, sortie lue en entier. Un échec (installation, migration, build, graine, santé) se lit dans `apv preview logs` ; corrige la cause ou signale-la, ne masque jamais la sortie.
3. Vérifie toi-même qu'il répond : `apv preview status`, et une requête sur l'adresse (`curl -sS -o /dev/null -w "%{http_code}" <adresse>`).
4. Si la sous-commande `preview` n'existe pas dans la version installée, utilise le script d'aperçu du projet (`references/reprise-environnement.md` de la compétence `chef-de-projet`) et annonce de la même façon.

## 3. Ne jamais toucher aux autres projets
- `apv preview stop` n'arrête que l'aperçu de ce projet. N'arrête jamais un processus, un conteneur ou une pile que ce projet n'a pas lancé, même s'il occupe le port voulu.
- Port déjà pris : identifie le propriétaire (`ss -ltnp`, `docker ps`). S'il appartient à ce projet, `apv preview stop` puis `update`. Sinon, dis-le à l'opérateur et propose un autre port dans la configuration ; ne le tue pas.
- La base de l'aperçu n'est jamais celle des tests ni une base hébergée : aucune écriture en production.

## 4. Annonce à l'opérateur
Dans sa langue, en quelques lignes, sans tiret cadratin ni demi-cadratin :
- **adresse** de l'aperçu ;
- **branche et commit** affichés (et la PR correspondante) ;
- **ce qui a changé** depuis la dernière annonce, en termes visibles pour lui (écrans, parcours) ;
- **compte de démo** : identifiant et mot de passe de démonstration déclarés par le projet (graine), jamais un vrai compte ni un secret de l'environnement ; s'il n'y en a pas, dis comment en créer un ;
- ce qui ne marche pas encore sur l'aperçu, s'il y a lieu.

N'annonce pas un aperçu que tu n'as pas vu répondre.
