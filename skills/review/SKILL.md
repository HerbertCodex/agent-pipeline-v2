---
name: review
description: "Revues indépendantes d'une branche avant PR : qa-securite, qa-fidelite, architecte-donnees (revue) et dpo en parallèle et en lecture seule, chacun sur sa copie détachée du même commit (workflow apv:revues ou outil Agent), puis constats consolidés et dédoublonnés dans .apv/state/, et apv run set review:<domaine> quand une exécution existe. À utiliser après l'intégration d'une spec (étape revues de /apv:run), après une correction lourde, ou quand l'opérateur demande une revue d'une branche."
argument-hint: "[spec ou branche] [securite fidelite donnees rgpd]"
allowed-tools: Read Glob Grep Write Edit Agent SendMessage Workflow Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js run*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js quota*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js lock status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js design list*) Bash(apv run*) Bash(apv quota*) Bash(apv status*) Bash(apv lock status*) Bash(apv design list*) Bash(git rev-parse*) Bash(git log*) Bash(git diff*) Bash(git status*) Bash(git worktree add --detach*) Bash(git worktree list*) Bash(git worktree remove*) Bash(ss -ltnp*)
---

# /apv:review

Tu es le chef de projet. Tu fais relire le même commit par quatre regards indépendants, en lecture seule, chacun sur sa propre copie, puis tu rassembles leurs constats en une liste sans doublon. Tu ne corriges rien ici : les décisions et les corrections viennent ensuite (`/apv:run`, étape des corrections).

Dans ce document, `apv` désigne `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` (ou `apv` s'il est sur le PATH). Arguments reçus : `$ARGUMENTS`.

## 1. Cible
1. L'argument est un identifiant de spec (`.apv/specs/<id>.json`) : la branche est `apv/<id>` ; sinon c'est une branche ; sans argument, la branche courante.
2. Commit exact : `git rev-parse <branche>` (sha complet). Toutes les revues portent sur **ce** commit.
3. Exécution en cours pour cette spec (`apv run status <id>`) : les statuts `review:<domaine>` seront tenus à jour. Sinon, pas d'état à écrire.

## 2. Domaines
| Domaine | Agent | Quand |
|---|---|---|
| `securite` | `apv:qa-securite` | toujours pour un point d'entrée serveur, des données ou une authentification |
| `fidelite` | `apv:qa-fidelite` | dès que l'interface change |
| `donnees` | `apv:architecte-donnees` (mode revue) | dès qu'une migration ou une requête change |
| `rgpd` | `apv:dpo` | données personnelles, prestataire, traceur, pages légales |

Les domaines cités en argument priment ; sinon tu choisis d'après le diff (`git diff --stat <base>..<commit>`). Un domaine écarté, dans une exécution : `apv run set <id> review:<domaine> skipped --note "<raison>"`.

Quota (`apv quota`) : au niveau `slow_down`, mode économe (revue combinée, captures des seuls écrans modifiés) et dis-le dans la PR ; à `finish_only`, pas de nouvelle revue ; à `save_now`, sauvegarde (compétence `chef-de-projet`).

## 3. Copies isolées
Une copie détachée par domaine, hors du dépôt, jamais le worktree d'un autre agent :
`git worktree add --detach <parent du dépôt>/<nom du dépôt>-revues/<id>-<domaine>-<sha court> <commit>`
Donne à chaque revue ses propres ports libres (`ss -ltnp` pour choisir), les ressources partagées à prendre sous bail (`apv lock run <ressource> -- <commande>`), le compte ou la méthode pour créer ses utilisateurs de test, et les écarts déjà validés par l'opérateur (registre).

## 4. Lancer en parallèle
Dans une exécution, avant le lancement : `apv run set <id> review:<domaine> running` pour chaque domaine retenu.
- **Workflow du plugin `apv:revues`** (outil Workflow, `name: "apv:revues"`, ou `scriptPath` = chemin absolu de `workflows/revues.js` du plugin si le nom n'est pas trouvé), `args` en objet JSON :
  ```json
  { "commit": "<sha>", "branch": "apv/<id>", "specFile": ".apv/specs/<id>.json",
    "common": "<écarts assumés du registre, maquettes, compte de test, dossier des rapports ZAP>",
    "reviews": [ { "domain": "securite", "copy": "<copie>", "context": "<ports, ressources sous bail>" },
                 { "domain": "fidelite", "copy": "<copie>", "context": "<port, écrans touchés>" } ] }
  ```
  Il lance un agent par domaine sur sa copie, avec un rapport structuré (gravité critique, eleve, moyen, faible, info ; requis ou conseil ; emplacement ; preuve ; correction attendue ; ce qui n'a pas été vérifié ; nettoyage), puis un passage de dédoublonnage qui ne supprime aucun constat : il rend `findings` (consolidés, avec les identifiants d'origine S, F, D, R) et `raw`.
- **Sans outil Workflow** : un appel à l'outil Agent par domaine, **tous dans le même message**, `run_in_background: true`, avec le type d'agent du tableau et un message qui donne le commit, la copie, la spec, la consigne commune et celle du domaine, le format du rapport ci-dessus et la règle « lecture seule : aucun commit, aucune poussée, aucune écriture sur un service externe ». Le dédoublonnage est alors le tien (section 5).

## 5. Consolider
1. Chaque rapport reçu : vérifie qu'il porte sur le bon commit et que la copie n'a aucun fichier suivi modifié (`git -C <copie> status --porcelain`) ; un écart est lui-même un constat.
2. Une seule liste : un constat par défaut réel. Deux constats de domaines différents qui décrivent le même défaut au même endroit (même cause, même correction) sont fusionnés en gardant tous leurs identifiants et leurs preuves ; deux défauts différents au même endroit restent séparés. Aucun constat n'est écarté à ce stade, même s'il te semble faux : un faux positif se prouve à l'étape des corrections.
3. Écris `.apv/state/revues-<id>-<sha court>.md` : commit, domaines revus et écartés (avec la raison), tableau des constats (identifiants, domaines, gravité, requis ou conseil, emplacement, preuve, correction attendue), ce qui n'a pas été vérifié et pourquoi, nettoyage confirmé par chaque revue.
4. Dans une exécution, pour chaque domaine : `apv run set <id> review:<domaine> done --findings <n> --note "<n> constats, <k> requis"`, ou `failed --note "<cause>"` si le rapport manque (la revue se relance entière).

## 6. Nettoyer et rendre compte
- Retire chaque copie : `git worktree remove <copie>`. S'il refuse à cause de fichiers générés (dépendances, build), vérifie d'abord qu'aucun fichier suivi n'a changé, puis `git worktree remove --force <copie>` ; jamais sur un autre worktree que ces copies.
- Compte rendu (à l'opérateur, ou à `/apv:run`) : commit revu, domaines, nombre de constats par gravité, les critiques et élevés en une ligne chacun, chemin du fichier de consolidation, ce qui n'a pas été vérifié.

Rien n'est inventé : une attaque, une capture ou une mesure que l'agent n'a pas faite est « non vérifiée ». Réponds dans la langue de l'opérateur, sans tiret cadratin ni demi-cadratin.
