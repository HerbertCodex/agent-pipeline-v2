# Verrous à bail : `apv lock`

`apv lock` protège les ressources partagées entre agents (base de test locale, ports, navigateur de test, fichiers communs). Il remplace le verrou `flock` sans bail utilisé sur Toujours rien (incidents 24, 25 et 28 de `docs/RETOUR-TOUJOURS-RIEN.md`) : un verrou gardé 40 min par un agent qui attendait un fichier, puis un verrou gardé environ 4 h par une boucle d'une session interrompue.

## Usage recommandé : `run`

```sh
apv lock run supabase-db --ttl 15m --wait 30m -- npm run db:reset
apv lock run e2e --label agent-t4 -- npx playwright test
```

`run` prend le verrou, lance la commande, renouvelle le bail pendant qu'elle tourne et libère le verrou à la sortie, que la commande réussisse, échoue, soit introuvable ou reçoive SIGINT, SIGTERM ou SIGHUP (le signal est transmis à la commande, puis SIGKILL après 10 s). Le code de sortie est celui de la commande (128 + numéro du signal en cas d'interruption, 127 si la commande ne peut pas être lancée, 75 si le verrou n'a pas été obtenu dans le délai `--wait`).

Le verrou ne vit que le temps d'une commande : c'est la règle qui évite l'incident 25. Mettre le verrou dans les scripts npm eux-mêmes (`"test:e2e": "apv lock run e2e -- playwright test"`) plutôt que dans la discipline des agents.

## Autres sous-commandes

- `apv lock acquire <ressource> [--ttl 900] [--wait 1800] [--label L] [--purpose P] [--pid N] [--json]` : prend le verrou et rend la main. Affiche le jeton. Sans `--pid`, seul le bail protège le verrou (aucun renouvellement) : l'outil Bash de Claude Code lance chaque commande dans un shell éphémère, dont le pid mourrait aussitôt. `--pid $$` lie le verrou à un shell qui reste vivant.
- `apv lock release <ressource> [--token T]` : seul le propriétaire libère, prouvé par le jeton (`--token` ou variable `APV_LOCK_TOKEN`) ou par le même pid sur la même machine. `--force --reason "..."` libère le verrou d'un autre ; la raison est journalisée.
- `apv lock status [ressource] [--json]` : détenteur, pid, machine, objet, âge, dernier battement, échéance, état (tenu ou périmé) et file d'attente.

Durées : secondes (`900`) ou avec unité (`90s`, `15m`, `2h`). Codes de sortie : 0 succès, 1 refus ou erreur, 2 usage, 75 délai d'attente dépassé.

## Stockage

Un dossier, par défaut `${XDG_STATE_HOME:-~/.local/state}/apv/locks/`, remplacé par `APV_LOCK_DIR` ou `--dir`. Pour chaque ressource (nom assaini : caractères hors `A-Za-z0-9._-` remplacés par `_`, 120 caractères au plus) :

- `<ressource>.lock` : l'enregistrement JSON `{ version, resource, owner: { pid, host, label }, token, acquiredAt, expiresAt, heartbeatAt, ttlSeconds, purpose }` ;
- `<ressource>.queue/` : un fichier par agent en attente ;
- `<ressource>.mutex/` : section critique très courte (quelques millisecondes) ;
- `events.log` : journal JSONL des prises, libérations, reprises, libérations forcées et attentes retirées (rotation à 1 Mo).

## Garanties

- **Acquisition atomique** : création exclusive du fichier (`open` avec l'option `wx`). Un seul processus gagne.
- **Bail** : `expiresAt = maintenant + ttl`. `run` renouvelle le bail tous les tiers de ttl (entre 200 ms et 60 s) ; un verrou dont le détenteur est bloqué sans renouveler expire tout seul.
- **Propriétaire vérifié** : un verrou est périmé si son bail est dépassé, ou s'il appartient à la même machine et que son pid n'existe plus (`process.kill(pid, 0)`). Un verrou périmé est repris par le prochain demandeur et la reprise est journalisée (`takeover`, avec la raison et l'ancien enregistrement) et affichée.
- **Pas de vol de verrou** : toute suppression ou réécriture d'un verrou existant (reprise, renouvellement, libération) se fait dans la section critique, après avoir relu le fichier et vérifié qu'il est toujours celui qu'on a jugé (contenu identique, ou jeton). Un verrou tout juste créé ne peut donc pas être supprimé par un processus qui avait jugé périmé son prédécesseur.
- **Fichier en cours d'écriture** : entre la création exclusive et l'écriture de l'enregistrement, le fichier peut être vide. Il est respecté pendant 10 s, puis considéré comme corrompu et repris.
- **Réentrance** : `run` ajoute la ressource à `APV_LOCK_HELD` (liste séparée par des virgules) dans l'environnement de la commande. Un `apv lock run` imbriqué sur la même ressource lance directement sa commande, sans attendre un verrou déjà tenu par son parent (le blocage imbriqué observé sur le projet). Si la variable mentionne un verrou qui n'est plus tenu, il est repris normalement.

## File d'attente et limites d'équité

Chaque demandeur dépose un ticket horodaté à la microseconde dans `<ressource>.queue/` et le rafraîchit à chaque interrogation (intervalle de 500 ms, aléa de plus ou moins 50 %, réglable par `APV_LOCK_POLL_MS`). Seul le premier ticket vivant tente de prendre le verrou ; les autres attendent et affichent le détenteur et leur position quand elle change (et au moins toutes les 30 s). Les tickets d'un processus mort (même machine) ou qui ne sont plus rafraîchis depuis 15 s sont retirés et journalisés.

Limites connues :
- L'ordre repose sur l'horloge murale : deux demandes arrivées à la même microseconde, ou venant de machines dont les horloges divergent (dossier partagé en réseau), sont départagées arbitrairement.
- Un ticket en tête dont le processus est suspendu (machine en veille) bloque la file jusqu'à 15 s avant d'être retiré ; à son réveil, l'agent reprend en fin de file.
- Un appel `LockStore.tryAcquire` direct (sans file) peut doubler la file : les commandes `acquire` et `run` passent toujours par la file.
- La vérification du pid n'a de sens que sur la même machine : pour un verrou posé depuis une autre machine, seul le bail compte.
- Un pid réutilisé par le système après la mort du détenteur fait paraître le verrou vivant jusqu'à l'expiration du bail.
- La section critique cassée après 10 s (processus tué pendant les quelques millisecondes où il la tient) laisse une fenêtre de course théorique.
- Deux noms de ressource qui donnent le même nom assaini partagent le verrou (sens sûr).

## Aucun plafond imposé à la commande

`run` ne coupe pas une commande longue : tant qu'elle tourne, le bail est renouvelé. C'est voulu (pas de limite qui bloque sans raison). Un détenteur mort, lui, perd le verrou immédiatement (pid) ou à l'expiration du bail.
