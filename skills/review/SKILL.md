---
name: review
description: "Revues indépendantes d'une branche avant PR : domaines proposés par apv review plan d'après le diff (securite toujours ; qa-fidelite, architecte-donnees en revue, dpo seulement s'ils ont quelque chose à relire), en parallèle et en lecture seule, chacun sur sa copie détachée du même commit (workflow apv:revues ou outil Agent), puis constats consolidés et dédoublonnés dans .apv/state/, et apv run set review:<domaine> (sauté avec la raison de l'outil) quand une exécution existe. Domaine facultatif concurrence (jamais par défaut) : audit ciblé des conditions de course d'un projet existant, lançable seul, qui inventorie chaque chemin lecture-modification-écriture avec sa protection et sa preuve. À utiliser après l'intégration d'une spec (étape revues de /apv:run), après une correction lourde, ou quand l'opérateur demande une revue d'une branche."
argument-hint: "[spec ou branche] [securite fidelite donnees rgpd concurrence]"
allowed-tools: Read Glob Grep Write Edit Agent SendMessage Workflow Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js run*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js quota*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js lock status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js design list*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js review plan*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js dast run*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js wait*) Bash(apv run*) Bash(apv quota*) Bash(apv status*) Bash(apv lock status*) Bash(apv design list*) Bash(apv review plan*) Bash(apv dast run*) Bash(apv wait*) Bash(git rev-parse*) Bash(git log*) Bash(git diff*) Bash(git status*) Bash(git worktree add --detach*) Bash(git worktree list*) Bash(git worktree remove*) Bash(ss -ltnp*)
---

# /apv:review

Tu es le chef de projet. Tu fais relire le même commit par des regards indépendants (jusqu'à quatre, ceux que le diff demande), en lecture seule, chacun sur sa propre copie, puis tu rassembles leurs constats en une liste sans doublon. Tu ne corriges rien ici : les décisions et les corrections viennent ensuite (`/apv:run`, étape des corrections).

Dans ce document, `apv` désigne `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` (ou `apv` s'il est sur le PATH). Arguments reçus : `$ARGUMENTS`.

## 1. Cible
1. L'argument est un identifiant de spec (`.apv/specs/<id>.json`) : la branche est `apv/<id>` ; sinon c'est une branche ; sans argument, la branche courante. Un nom de domaine (`securite`, `fidelite`, `donnees`, `rgpd`, `concurrence`) n'est jamais une cible : `/apv:review concurrence` audite la branche courante.
2. Commit exact : `git rev-parse <branche>` (sha complet). Toutes les revues portent sur **ce** commit.
3. Exécution en cours pour cette spec (`apv run status <id>`) : les statuts `review:<domaine>` seront tenus à jour. Sinon, pas d'état à écrire.

## 2. Domaines
| Domaine | Agent | Quand |
|---|---|---|
| `securite` | `apv:qa-securite` | toujours, sans exception (retenue par `apv review plan` quel que soit le diff) |
| `fidelite` | `apv:qa-fidelite` | l'interface ou une maquette validée change de contenu |
| `donnees` | `apv:architecte-donnees` (mode revue) | une migration, un schéma, une requête ou un dépôt change |
| `rgpd` | `apv:dpo` | migration, données personnelles, export, prestataire, traceur, pages légales |
| `concurrence` | `apv:architecte-donnees` (audit de concurrence) | **sur demande seulement** : cité en argument, jamais choisi d'après le diff |

**Plan des revues par l'outil, avant tout lancement** (projet pilote, 25 septembre 2026 : une spec de pur rangement, renommages et imports seulement, est passée par les quatre revues, 40 à 70 minutes, dont trois n'avaient rien à relire) :
`apv review plan --base <base de la PR> --head <commit> --json [--force <domaine>]...`
(base : celle de l'exécution, `apv run status <id>`, sinon la branche principale ; lecture seule, rien n'est écrit)
- L'outil classe chaque fichier du diff (depuis la base commune, renommages détectés) : renommage pur, chemins seuls réécrits (imports, références à un fichier déplacé, imports remis en forme), ou contenu changé ; interface, maquette validée, données, migration ou schéma, données personnelles, texte légal, neutre (tests, documentation, outillage), ou non classé. Chemins et termes : `review.paths`, `review.terms` de `.apv/config.json`, sinon des motifs génériques.
- **`securite` est toujours retenue**, sans exception ; `fidelite` si l'interface ou une maquette validée change de contenu ; `donnees` si une migration, un schéma, une requête ou un dépôt change ; `rgpd` si une migration, des données personnelles, un export, un traceur ou un texte légal changent. Un fichier non classé au contenu changé garde tous les domaines (prudence) : un domaine n'est sauté que sur preuve positive.
- Sortie : `retained` (les domaines à lancer), `skipped` (domaine et raison), `domains[]` (raison et fichiers qui décident, `forced`), `files[]`.
- Tu lances **les domaines retenus, et eux seuls**. Tu ne sautes jamais un domaine retenu, et tu n'inventes pas de raison de sauter : la raison d'un domaine sauté est celle de l'outil, recopiée.
- Les domaines cités en argument, ou demandés par l'opérateur, sont forcés : `--force <domaine>` (répétable) ; `review.always` de la configuration force aussi. Un domaine forcé est retenu même si le diff ne le demandait pas.
- Le plan ne choisit que parmi les quatre premiers, qui restent les domaines par défaut ; `concurrence` n'en fait jamais partie : audit seul (ci-dessous), sans plan.

**Audit ciblé de concurrence** (`/apv:review [branche] concurrence`) : il se lance seul, sur un projet existant, sans spec ni exécution. L'agent suit la grille générique `references/concurrence.md` de la compétence `apv:architecture-donnees` (dix familles, toute stack) sur **tout le code** du commit, pas seulement le diff, en lecture seule. Son rapport contient, en plus des constats, l'inventaire `paths` : chaque chemin lecture-modification-écriture et chaque motif trouvé, avec famille, invariant, protection, statut (conforme, non conforme, inconnu) et preuve. L'état d'exécution ne connaît que les quatre domaines par défaut : pas de `apv run set … review:concurrence` ; dans une exécution, l'audit est cité dans le fichier de consolidation. Un domaine sauté par le plan, dans une exécution : `apv run set <id> review:<domaine> skipped --note "<raison de apv review plan>"` (la note est exigée ; `review:securite` ne peut jamais être noté sauté).

Quota (`apv quota`) : au niveau `slow_down`, mode économe (revue combinée, captures des seuls écrans modifiés) et dis-le dans la PR ; à `finish_only`, pas de nouvelle revue ; à `save_now`, sauvegarde (compétence `chef-de-projet`).

## 3. Copies isolées
Une copie détachée par domaine, jamais le worktree d'un autre agent, dans **ton dossier de session** (le dossier de travail temporaire de la session Claude Code, dit scratchpad : les permissions t'y laissent lancer tes commandes) ou sous un chemin que l'outil te donne, **jamais à côté du dépôt** (projet pilote, septembre 2026 : une copie de livraison créée dans un dossier frère du dépôt, hors des dossiers prévus) :
`git worktree add --detach <dossier de session>/<id>-<domaine>-<sha court> <commit>`
Chemin absolu toujours (le workflow `apv:revues` refuse un chemin relatif). Chaque copie est retirée à la fin (section 6).
Donne à chaque revue ses propres ports libres (`ss -ltnp` pour choisir), les ressources partagées à prendre sous bail (`apv lock run <ressource> -- <commande>`), le compte ou la méthode pour créer ses utilisateurs de test, et les écarts déjà validés par l'opérateur (registre).

**Contrôles déjà passés** : sous `/apv:run`, la suite complète vient de passer sur ce commit à la dernière intégration. Une revue ciblée après corrections porte sur un commit vérifié au niveau tâche seulement (contrôles de tâche et tests ciblés, la suite complète venant à la livraison) : dis-le à la revue, avec ces reçus-là. Cite ses reçus à chaque revue (dossier `.apv/receipts/<exécution>/` et sortie de `apv gates verify --commit <commit>`) : les revues ne relancent ni la suite complète ni Playwright, sauf besoin précis de leur domaine (une attaque ou une capture à produire, un test à écrire pour prouver un constat), et alors seulement les fichiers utiles, sous `apv lock run e2e`. Hors exécution, sans reçus sur ce commit, dis-le à chaque revue : le résultat des contrôles est alors « non vérifié », pas « vert ».

## 3 bis. Scan dynamique, lancé par toi avant les revues
Les agents de revue n'ont pas le droit de lancer Docker : sur le projet pilote, le scan ZAP prévu n'a jamais tourné (quatre livraisons de suite, septembre 2026). Le scan dynamique est donc le tien, avant les revues, quand le projet le déclare :
1. `review.dast` absent de `.apv/config.json` : pas de scan ; la raison pour la revue sécurité est « scan dynamique non déclaré par le projet (review.dast) ».
2. Déclaré : une copie détachée du commit revu pour le scan (`<dossier de session>/<id>-dast-<sha court>`, section 3), puis
   `apv dast run --repo <copie du scan> --out <dossier de session>/dast-<sha court> --commit <commit>`.
   L'outil prend lui-même le verrou `review.dast.resource` (par défaut `dast` ; le projet y nomme sa pile partagée si le scan s'en sert), lance la commande du projet dans la copie, bornée par `review.dast.timeoutMs`, écrit `dast.log`, les rapports et, en dernier, `summary.json`. Tu ne lances jamais Docker ni ZAP toi-même hors de cette commande.
3. Scan plus long qu'un appel Bash (dix minutes) : lance `apv dast run` par l'outil Bash en arrière-plan, puis attends `apv wait --file <dossier>/summary.json` (580 s au plus par appel, relancé tant qu'il répond « Délai dépassé ») ; jamais `sleep` ni boucle shell.
4. Lis `summary.json` : `passed`, le dossier va à la revue sécurité (`dast` du workflow) ; `failed`, `timed_out` ou `lock_timeout`, le dossier y va aussi avec le statut, et la raison (`dastMissing`) dit que le scan n'a pas abouti. Retire ensuite la copie du scan (`git worktree remove`).
Le résultat (statut, nombre d'alertes, « non vérifié » et pourquoi) va dans le fichier de consolidation et dans la PR.

## 4. Lancer en parallèle
Dans une exécution, avant le lancement : `apv run set <id> review:<domaine> running` pour chaque domaine retenu par le plan, et `apv run set <id> review:<domaine> skipped --note "<raison de l'outil>"` pour chaque domaine sauté.
- **Workflow du plugin `apv:revues`** (outil Workflow, `name: "apv:revues"`, ou `scriptPath` = chemin absolu de `workflows/revues.js` du plugin si le nom n'est pas trouvé), `args` en objet JSON :
  ```json
  { "commit": "<sha>", "branch": "apv/<id>", "specFile": ".apv/specs/<id>.json",
    "common": "<écarts assumés du registre, maquettes, compte de test, reçus de la suite complète sur ce commit>",
    "dast": "<dossier des rapports de apv dast run, facultatif>", "dastMissing": "<raison sans rapport : non déclaré, en échec>",
    "skipped": [ { "domain": "rgpd", "reason": "<raison de apv review plan>" } ],
    "reviews": [ { "domain": "securite", "copy": "<copie>", "context": "<ports, ressources sous bail>" },
                 { "domain": "fidelite", "copy": "<copie>", "context": "<port, écrans touchés>" } ] }
  ```
  Audit ciblé seul : `"reviews": [ { "domain": "concurrence", "copy": "<copie>", "context": "<stockages, tâches planifiées, suites de tests et leurs verrous>" } ]`, `specFile` omis s'il n'y a pas de spec. Le résultat garde `reports[].paths` (inventaire).
  `reviews` : les domaines retenus par le plan (`securite` toujours) ; `skipped` : les domaines sautés, avec la raison de l'outil (le workflow refuse `securite` sauté, un domaine à la fois revu et sauté, une raison vide) ; il les rend dans son résultat (`skipped`).
  Il lance un agent par domaine sur sa copie, avec un rapport structuré (gravité critique, eleve, moyen, faible, info ; requis ou conseil ; emplacement ; niveau de confiance `confidence` et preuve `evidence` ; correction attendue ; ce qui n'a pas été vérifié ; nettoyage), puis un passage de dédoublonnage qui ne supprime aucun constat : il rend `findings` (consolidés, avec les identifiants d'origine S, F, D, R, et la preuve la plus forte de leurs membres), `raw`, `refused` (rapports refusés : un constat ou un chemin sans niveau, avec un niveau inconnu ou sans preuve) et `escalation` (`verify` : constats `probable` ; `operator` : constats `suppose`).
- **Sans outil Workflow** : un appel à l'outil Agent par domaine, **tous dans le même message**, en arrière-plan en session interactive et `run_in_background: false` en session non interactive (la session s'arrêterait avec eux ; pas d'outil Workflow non plus), avec le type d'agent du tableau et un message qui donne le commit, la copie, la spec, la consigne commune et celle du domaine, le format du rapport ci-dessus (niveau de confiance compris : `prouve` avec preuve reproductible jointe, `probable` sur lecture du code sans exécution, `suppose` pour une hypothèse, jamais sans preuve ni justification) et la règle « lecture seule : aucun commit, aucune poussée, aucune écriture sur un service externe » ; pour la revue sécurité, le dossier des rapports du scan dynamique (section 3 bis), ou la raison de son absence, et « ne lance pas Docker ». Le dédoublonnage et le refus des constats sans niveau sont alors les tiens (section 5).

## 5. Consolider
1. Chaque rapport reçu : vérifie qu'il porte sur le bon commit et que la copie n'a aucun fichier suivi modifié (`git -C <copie> status --porcelain`) ; un écart est lui-même un constat. Un rapport refusé (`refused`, ou un constat sans niveau ni preuve dans un rapport libre) se redemande à la revue (`SendMessage` si elle vit, sinon elle se relance entière) ; il ne compte pas comme fait.
2. Une seule liste : un constat par défaut réel. Deux constats de domaines différents qui décrivent le même défaut au même endroit (même cause, même correction) sont fusionnés en gardant tous leurs identifiants et leurs preuves ; deux défauts différents au même endroit restent séparés. Aucun constat n'est écarté à ce stade, même s'il te semble faux : un faux positif se prouve à l'étape des corrections.
3. Écris `.apv/state/revues-<id>-<sha court>.md` : commit, plan des revues (commande lancée, domaines retenus et sautés avec la raison de l'outil et les fichiers qui décident, domaines forcés), tableau des constats (identifiants, domaines, gravité, requis ou conseil, emplacement, niveau de confiance, preuve, correction attendue), ce qui n'a pas été vérifié et pourquoi, nettoyage confirmé par chaque revue. Audit de concurrence : ajoute le tableau de l'inventaire (emplacement, famille, invariant, protection, statut, niveau, preuve), chemins conformes compris ; lancé seul hors exécution, le fichier est `.apv/state/audit-concurrence-<sha court>.md`.
4. Dans une exécution, pour chaque domaine : `apv run set <id> review:<domaine> done --findings <n> --note "<n> constats, <k> requis"`, ou `failed --note "<cause>"` si le rapport manque (la revue se relance entière).

## 6. Nettoyer et rendre compte
- Retire chaque copie (revues et scan) : `git worktree remove <copie>`. S'il refuse à cause de fichiers générés (dépendances, build), vérifie d'abord qu'aucun fichier suivi n'a changé, puis `git worktree remove --force <copie>` ; jamais sur un autre worktree que ces copies.
- Compte rendu (à l'opérateur, ou à `/apv:run`) : commit revu, domaines revus et sautés (avec la raison de l'outil), nombre de constats par gravité et par niveau de confiance, les critiques et élevés en une ligne chacun avec leur niveau (`prouve`, `probable`, `suppose`), les constats `suppose` à prouver avant d'agir, pour un audit de concurrence le nombre de chemins inventoriés par statut, chemin du fichier de consolidation, ce qui n'a pas été vérifié.

Rien n'est inventé : une attaque, une capture ou une mesure que l'agent n'a pas faite est « non vérifiée ». Réponds dans la langue de l'opérateur, sans tiret cadratin ni demi-cadratin.
