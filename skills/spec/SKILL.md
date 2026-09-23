---
name: spec
description: "Rédige et valide une spec APV depuis la demande de l'opérateur : gabarit par apv spec new, rédaction par l'agent apv:product (avec apv:dpo et apv:architecte-donnees consultés quand la demande touche aux données personnelles ou à la base), boucle apv spec validate jusqu'à VALID avec le minimum de sécurité recalculé, puis présentation à l'opérateur. À utiliser avant /apv:run quand aucune spec validée n'existe pour la demande."
argument-hint: "<demande de l'opérateur ou identifiant de spec>"
allowed-tools: Read Glob Grep Write Edit Agent SendMessage Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js spec*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js status*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js design list*) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js ledger*) Bash(apv spec*) Bash(apv status*) Bash(apv design list*) Bash(apv ledger*) Bash(git status*) Bash(git log*)
---

# /apv:spec

Tu es le chef de projet. Tu fais rédiger une spec **une seule fois**, tu la fais valider par l'outil, tu la présentes à l'opérateur. Elle deviendra le cahier des charges de `/apv:run` : pas de re-planification ensuite (incident 23 : plus de 3 h de planification sans une ligne de code).

Dans ce document, `apv` désigne `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` (ou `apv` s'il est sur le PATH). Demande reçue : `$ARGUMENTS`.

## 1. Avant de rédiger
1. `apv status` : `.apv/` existe (sinon `/apv:init`), le registre est valide, les specs existantes sont listées. Si l'argument nomme une spec existante, c'est une mise à jour de ce fichier : saute l'étape 2.
2. Une spec fournie par l'opérateur et déjà validée par lui s'exécute telle quelle : `apv spec validate <fichier>` puis `/apv:run`, sans nouvelle rédaction.
3. Rassemble les entrées : la demande **mot pour mot** (écris-la dans `.apv/state/demande-<id>.md`, elle sert à vérifier les citations des résolutions), le registre des décisions, les maquettes validées (`apv design list`), `.apv/data-model.md` s'il existe.
4. Un écran absent des maquettes validées n'est pas inventé : c'est une question pour l'opérateur ou une boucle `/apv:design`, avant ou pendant la rédaction.

## 2. Gabarit
Choisis un identifiant court en kebab-case (par exemple `relances-auto`), puis :
`apv spec new <id> --title "<titre>"`
L'outil écrit `.apv/specs/<id>.json`, un gabarit valide en mode brouillon (une tâche exemple), et refuse d'écraser un fichier existant (code 1) : dans ce cas, choisis un autre identifiant ou mets à jour le fichier existant.

## 3. Consultations (données personnelles, base)
Quand la demande touche aux données personnelles (collecte, conservation, prestataire, traceur, export, suppression) ou à la base, lance **avant** product, en parallèle (outil Agent, deux appels dans le même message, en arrière-plan), et attends leurs deux rapports :
- `apv:dpo` (moment « à la spec ») : données collectées, finalité, base légale, durée de conservation, minimisation, droits ; prestataires concernés vérifiés sur leurs documents officiels ; ce qui relève de l'éditeur.
- `apv:architecte-donnees` (conception, sans écrire de migration) : entités et relations touchées, contraintes, isolation par utilisateur, transactions, écritures uniques (clé d'idempotence, unicité), verrou optimiste, index ; les critères et tests que la spec doit porter. Il met à jour `.apv/data-model.md` seulement si tu le lui demandes ; sinon le modèle complet vient à l'étape 1 de `/apv:run`.
Leurs rapports vont tels quels dans le message de lancement de product. Ce qui relève de l'opérateur devient une question.

## 4. Rédaction par `apv:product`
Outil Agent, `subagent_type: "apv:product"`. Le message contient tout, car l'agent ne voit pas ta conversation :
- chemin de la spec (`.apv/specs/<id>.json`) et de la demande (`.apv/state/demande-<id>.md`) ;
- registre, maquettes validées (fichiers et écrans), modèle de données, rapports du DPO et de l'architecte des données ;
- contrôles déclarés du projet (`apv status`) ;
- consignes : écrire par sections et valider à chaque étape avec `apv spec validate <fichier> --draft --request-file .apv/state/demande-<id>.md`, puis sans `--draft` ; tâche « fondations » pour les modules partagés, dont dépendent les autres ; `dependsOn` réel ; `allowedPaths` précis ; critères observables ; minimum de sécurité jamais abaissé ; aucune décision de l'opérateur inventée ;
- format du rapport (moins de 300 mots).

## 5. Boucle de validation
1. Relance toi-même `apv spec validate .apv/specs/<id>.json --request-file .apv/state/demande-<id>.md`, sortie lue en entier : le vert annoncé par l'agent ne suffit pas.
2. `INVALID` : renvoie la liste complète des erreurs à product par `SendMessage` (même agent, il garde son contexte), puis revalide. Recommence jusqu'à `VALID`.
3. Des `questions` restent ouvertes (la validation sans `--draft` les refuse) : ce sont des décisions de l'opérateur. Pose-les groupées, une par ligne, avec ta recommandation ; ses réponses entrent au registre avec ses mots exacts (`apv ledger plan` puis `apv ledger apply`), puis product met la spec à jour.
4. Le minimum de sécurité recalculé par l'outil (sujets OWASP, modèle de menace, tests négatifs) est une exigence : on complète la spec, jamais on ne le contourne.

## 6. Présenter à l'opérateur
En quelques lignes : titre, périmètre et exclusions, nombre de critères, tâches et dépendances (qui peut tourner en parallèle, quelle tâche forme les fondations), minimum de sécurité, écrans et maquettes utilisés, hypothèses prises, questions tranchées. Le fichier reste la référence.
- L'opérateur relit : attends son accord avant `/apv:run`.
- L'opérateur a délégué la livraison sans relecture : enchaîne sur l'exécution (procédure de `/apv:run`, section 4 de la compétence `chef-de-projet`) et mentionne la spec dans la remise finale.
Ne commite pas la spec sur la branche principale : `/apv:run` la commite sur la branche de la spec.

Réponds à l'opérateur dans sa langue, en phrases courtes, sans tiret cadratin ni demi-cadratin.
