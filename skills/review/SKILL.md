---
name: review
description: "Relectures indépendantes APV4 d'une branche avant PR, proportionnées au risque : seulement les domaines que apv review plan exige (aucun aux niveaux 0 et 1 ; securite au niveau 2 ; plus donnees ou rgpd au niveau 3 ; fidelite si un écran sous maquette change), en parallèle et en lecture seule sur copies détachées du même commit, constats consolidés, un seul tour de corrections puis relecture du delta. Audit de concurrence sur demande seulement."
argument-hint: "[spec ou branche] [securite fidelite donnees rgpd concurrence]"
allowed-tools: Read Glob Grep Write Edit Agent SendMessage Workflow Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js run*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js quota*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js lock status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js design list*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js review plan*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js review show*) Bash(apv review show*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js dast run*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js wait*) Bash(apv run*) Bash(apv quota*) Bash(apv status*) Bash(apv lock status*) Bash(apv design list*) Bash(apv review plan*) Bash(apv dast run*) Bash(apv wait*) Bash(git rev-parse*) Bash(git log*) Bash(git diff*) Bash(git status*) Bash(git worktree add --detach*) Bash(git worktree list*) Bash(git worktree remove*) Bash(ss -ltnp*)
---

# /apv:review

Tu es le chef de projet. Tu fais relire **un** commit par les regards que le risque exige, et eux seuls, en lecture seule, chacun sur sa copie. Tu ne corriges rien ici.

`apv` désigne `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` (ou `apv` sur le PATH). Arguments : `$ARGUMENTS`.

## 1. Cible et plan
1. Cible : un identifiant de spec (branche `apv/<id>`), une branche, ou la branche courante. Commit exact : `git rev-parse <branche>`.
2. Plan : `apv review plan --base <base de la PR> --head <commit> --json`. Il donne le **niveau** (0 à 3) et les domaines **exigés**.
3. **Niveau 0 ou 1 sans domaine exigé : aucune relecture.** Dis-le et arrête-toi là.
4. Tu lances les domaines exigés, et eux seuls. Un domaine cité en argument ou demandé par l'opérateur se force (`--force <domaine>`). Si tu crois qu'un risque échappe au plan, force un seul domaine et écris pourquoi.

| Domaine | Agent | Exigé quand |
|---|---|---|
| `securite` | `apv:qa-securite` | niveaux 2 et 3 |
| `donnees` | `apv:architecte-donnees` (revue) | migration, schéma, requête (niveau 3) |
| `rgpd` | `apv:dpo` | données personnelles, prestataire, page légale (niveau 3) |
| `fidelite` | `apv:qa-fidelite` | un écran couvert par une maquette validée change |
| `concurrence` | `apv:architecte-donnees` (audit) | sur demande seulement, sur tout le code |

## 2. Copies et scan
- Une copie détachée par domaine, dans ton dossier de session : `git worktree add --detach <dossier de session>/<id>-<domaine>-<sha court> <commit>` (chemin absolu).
- Ports libres et ressources sous bail (`apv lock run`) pour chaque revue qui lance l'application.
- Scan dynamique, seulement si le projet déclare `review.dast` et au niveau 2 et plus : copie détachée, `apv dast run --repo <copie> --out <dossier> --commit <commit>` en arrière-plan, `apv wait --file <dossier>/summary.json`, puis le dossier va à la revue sécurité.

## 3. Lancer en parallèle
- Workflow `apv:revues` (outil Workflow, ou `scriptPath` vers `workflows/revues.js` du plugin), `args` :
  ```json
  { "commit": "<sha>", "branch": "<branche>", "specFile": ".apv/specs/<id>.json",
    "common": "<écarts validés, maquettes, compte de test, reçus de la suite sur ce commit>",
    "dast": "<dossier du scan, facultatif>", "dastMissing": "<raison sans scan>",
    "skipped": [ { "domain": "rgpd", "reason": "<raison de apv review plan>" } ],
    "reviews": [ { "domain": "securite", "copy": "<copie>", "context": "<ports, ressources>" } ] }
  ```
- Sans Workflow, ou pour un seul domaine : un appel à l'outil Agent par domaine, tous dans le même message, en arrière-plan.
- Dans une exécution : `apv run set <id> review:<domaine> running`, puis `done --findings <n>`, ou `skipped --note "<raison de l'outil>"`.

## 4. Consolider
1. Chaque rapport porte sur le bon commit, et sa copie n'a aucun fichier suivi modifié.
2. Une seule liste sans doublon, dans `.apv/state/revues-<id>-<sha court>.md` : constat, domaine, gravité, requis ou conseil, emplacement, confiance, preuve.
3. Faible, info et conseil : une ligne chacun dans `.apv/state/suivi-constats.md`, **sans passe de corrections**.
4. Chaque relecteur enregistre lui-même sa relecture (`apv review record`) ; vérifie par `apv review show --commit <sha>`.
5. Après **le** tour de corrections : relecture du **delta seul** par chaque domaine dont le delta touche le périmètre (`--delta-from <commit relu>`). Un delta hors du périmètre d'un domaine garde sa relecture (`apv rules check` le dit).

## 5. Nettoyer et rendre compte
- `git worktree remove <copie>` pour chaque copie (revues et scan).
- Compte rendu court : niveau, commit, domaines relus ou sautés (raison de l'outil), constats critiques et hauts en une ligne chacun avec leur confiance, ce qui n'a pas été vérifié.

Rien n'est inventé : une attaque ou une capture non faite est « non vérifiée ». Langue de l'opérateur, sans tiret cadratin.
