# Aperçu vivant : `apv preview`

L'aperçu vivant est un environnement permanent du projet, séparé des tests (spécification, section 12) : sa propre base, jamais remise à zéro par les tests, des données de démonstration, une adresse fixe. Le chef de projet le met à jour à chaque livraison (section 8, étape 7) et annonce l'adresse, la branche affichée et ce qui a changé.

`apv preview` remplace le script manuel du projet pilote (`apercu-supabase/update.sh`) par une commande pilotée par la configuration du projet.

```
apv preview update [branche] [--wait 30m] [--repo <chemin>] [--json]
apv preview status [--repo <chemin>] [--json]
apv preview stop [--wait 30m] [--repo <chemin>] [--json]
apv preview logs [--lines 50] [--update] [--repo <chemin>]
```

## Ce que fait `update`

1. Prend le verrou à bail du projet, `preview:<projet>` ([verrous](LOCKS.md)), où `<projet>` est le nom du dossier de l'arbre de travail principal (tous les worktrees d'un projet partagent le même verrou, deux projets ne s'attendent pas),, renouvelé pendant la mise à jour et libéré à la fin, en cas de succès comme d'échec. `--wait` borne l'attente (30 min par défaut) ; au-delà, la commande échoue sans rien toucher.
2. Arrête le serveur d'aperçu en cours, s'il est bien le nôtre (groupe de processus enregistré dans `.apv/state/preview.json`, heure de démarrage vérifiée dans `/proc` sous Linux pour ne jamais tuer un pid réutilisé) : SIGTERM au groupe, puis SIGKILL après 10 s.
3. Vérifie que le port est libre. Un port encore occupé est tenu par un processus qui n'est pas l'aperçu : la commande refuse avec un message clair, **sans jamais l'arrêter**.
4. Copie le commit de la branche par `git archive` dans un dossier neuf. L'arbre de travail n'est jamais utilisé : une modification non commitée n'arrive pas dans l'aperçu.
5. Lance, dans cet ordre et dans ce dossier, les étapes déclarées : `install`, `migrate`, `build`, `seed`. La première qui échoue arrête tout. Chaque étape a un délai maximal (`timeoutSec`, 900 s par défaut) : au-delà, tout son groupe de processus reçoit SIGTERM puis SIGKILL après 5 s, et la mise à jour échoue sur cette étape.
6. Démarre le serveur détaché, dans son propre groupe de processus, sorties vers `.apv/state/preview.log` (droits 600 ; le journal précédent devient `preview.prev.log`), et enregistre `.apv/state/preview.json` (`pid`, `port`, `branch`, `commit`, `startedAt`, `url`...).
7. Interroge le contrôle de santé jusqu'à une réponse 2xx ou 3xx (les redirections ne sont pas suivies), dans le délai `health.timeoutSec`. Un serveur qui meurt ou ne répond pas est arrêté.

En cas de succès :

```
aperçu prêt : http://localhost:5190 (branche main, commit 3f2a9c1)
Changements depuis 8e41d07 : 3 commits
  3f2a9c1 Pages légales : coordonnées des prestataires
  ...
Journal du serveur : /chemin/du/projet/.apv/state/preview.log
```

Les changements viennent de `git log --oneline <commit précédent>..<nouveau>`, limités à 20 lignes (le total est donné). Le commit précédent est celui du dernier aperçu qui a démarré, même s'il a été arrêté depuis. Un retour vers un commit plus ancien ou une autre branche l'annonce aussi : « Retour en arrière : N commits de l'aperçu précédent (abc1234) retirés de l'aperçu. » (`changes.removed` en JSON).

En cas d'échec, la sortie est `1` et le message nomme l'étape (`branche`, `arrêt`, `port`, `copie`, `install`, `migrate`, `build`, `seed`, `serve`, `health`), le code de sortie, les 20 dernières lignes de la commande (valeurs masquées) et le chemin du journal. Après l'échec d'une étape, aucun serveur ne reste : l'ancien a été arrêté à l'étape 2 et le nouveau n'a pas démarré. L'échec est aussi noté dans `preview.json` (`lastFailure`) et affiché par `status`.

## Autres sous-commandes

- `status` : « en marche » quand notre groupe de processus est vivant **et** répond au contrôle de santé ; affiche l'adresse, la branche, le commit, la durée depuis le démarrage et le dernier échec. Sortie `0` en marche, `1` sinon (arrêté, sans réponse ou jamais lancé).
- `stop` : arrête le serveur (tout son groupe), sous le verrou `preview`. L'enregistrement du dernier aperçu est gardé (`pid` à `null`).
- `logs` : dernières lignes du journal du serveur (`--lines`, 50 par défaut) ou, avec `--update`, du journal de la dernière mise à jour (`.apv/state/preview-update.log`). Les valeurs du fichier d'environnement sont masquées à l'affichage.

## Configuration

Section `preview` de `.apv/config.json` :

```json
{
  "preview": {
    "branch": "main",
    "dir": "~/.local/state/apv/preview/mon-projet",
    "envFile": "../apercu/env.status",
    "steps": {
      "install": "npm ci",
      "migrate": "npm run db:reset:apercu",
      "build": ["npm", "run", "build"],
      "seed": "node scripts/seed-demo.mjs"
    },
    "serve": {
      "command": ["node", "build/index.js"],
      "port": 5190,
      "host": "0.0.0.0",
      "env": { "DATABASE_URL": "${DB_URL}", "NODE_ENV": "production" }
    },
    "health": { "path": "/", "timeoutSec": 60 },
    "announce": { "url": "http://localhost:5190" }
  }
}
```

| Champ | Rôle |
| --- | --- |
| `branch` | Branche affichée quand `update` n'en reçoit pas (sinon `main`). |
| `dir` | Dossier de la copie. Par défaut `${XDG_STATE_HOME:-~/.local/state}/apv/preview/<nom du dossier du projet>`. `~/` désigne le dossier personnel, un chemin relatif part du dépôt. |
| `envFile` | Fichier d'environnement chargé pour toutes les étapes et pour le serveur. Même règle de chemin. Ses valeurs ne sont jamais affichées. |
| `steps.install`, `migrate`, `build`, `seed` | Étapes facultatives, lancées dans cet ordre dans la copie. Une commande, ou `{ "command": ..., "timeoutSec": 1800 }` pour changer son délai maximal (900 s par défaut). |
| `serve.command` | Commande du serveur, lancée dans la copie. |
| `serve.port` | Port fixe de l'aperçu (obligatoire). |
| `serve.host` | Adresse d'écoute annoncée ; le contrôle de santé interroge `127.0.0.1` quand elle vaut `0.0.0.0` ou `::`. |
| `serve.env` | Variables ajoutées pour le serveur ; les valeurs peuvent citer `${NOM}` (fichier d'environnement ou environnement). |
| `health.path`, `health.timeoutSec` | Chemin interrogé (`/`) et délai (60 s). |
| `announce.url` | Adresse annoncée (sinon `http://localhost:<port>`). |

### Forme des commandes

Chaque étape et `serve.command` acceptent deux formes :

- **une chaîne** : lancée par `sh -c`. Pipes, `&&`, `cd` et variables du fichier d'environnement (`"$API_URL"`) fonctionnent comme dans un script ;
- **un tableau** : l'argv exact, sans shell. Seul `${NOM}` est remplacé (une variable inconnue est une erreur, `$$` donne un `$`).

Le tableau est à préférer pour une commande simple ; la chaîne sert quand il faut enchaîner ou rediriger.

### Environnement des commandes

Étapes et serveur reçoivent l'environnement de `apv`, puis les variables du fichier d'environnement, puis :

- `APV_REPO` (dépôt), `APV_PREVIEW_DIR` (copie), `APV_PREVIEW_BRANCH`, `APV_PREVIEW_COMMIT`, `APV_PREVIEW_PORT`, `APV_PREVIEW_HOST` (si `serve.host`) ;
- `APV_LOCK_HELD` contenant `preview:<projet>` : un `apv lock run preview:<projet> -- ...` lancé par une étape ne s'attend pas lui-même ;
- pour le serveur seulement : `PORT` (le port de l'aperçu), puis `serve.env`.

### Fichier d'environnement

Format `NOM=valeur` (celui de `supabase status -o env`) : lignes `export NOM=valeur` acceptées, commentaires `#`, valeurs entre guillemets doubles (échappements `\n`, `\"`, `\\`, `\$`), entre apostrophes (littérales) ou nues. Le fichier est lu comme des données : aucune substitution de commande, aucune expansion. Une ligne invalide est signalée par son numéro, jamais par sa valeur.

### Masquage

Dans le journal de mise à jour, les messages d'erreur et la sortie de `logs`, chaque valeur du fichier d'environnement est remplacée par `[masqué:NOM]` quand elle compte 8 caractères ou plus, ou 4 ou plus si son nom ressemble à un secret (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `SALT`, `DB_URL`...). Les valeurs plus courtes (un port, `true`) ne sont pas masquées : elles masqueraient des mots ordinaires. Le masquage se fait ligne par ligne, une valeur n'est jamais coupée entre deux écritures.

Le journal du serveur (`.apv/state/preview.log`) est écrit directement par le serveur détaché : le fichier sur le disque **n'est pas masqué**, seul l'affichage par `apv preview logs` l'est. Masquer à l'écriture demanderait un processus relais vivant aussi longtemps que le serveur, entre lui et le fichier : s'il s'arrêtait, le serveur perdrait sa sortie ou s'arrêterait à son tour (SIGPIPE). Le fichier est donc créé en droits `600` (lisible par son seul propriétaire, droits resserrés à chaque démarrage s'il existait), ignoré par Git (`.apv/.gitignore`), et ne doit pas être copié tel quel dans un ticket ou une PR : passer par `apv preview logs`.

## Sûreté

- **Dossier** : il est vidé à chaque mise à jour, donc refusé s'il est dans le dépôt, s'il contient le dépôt, le dossier personnel ou la racine. `update` y dépose un fichier `.apv-preview` et refuse de vider un dossier non vide qui n'en a pas (dossier choisi par erreur).
- **Port** : jamais de `kill` sur un processus qui n'est pas le nôtre. Le serveur de l'aperçu est reconnu par son groupe de processus et son heure de démarrage, pas par son port ni par un motif de ligne de commande (le script manuel utilisait `pgrep -f`, qui pouvait viser un autre processus).
- **Branche** : un nom qui commence par `-` est refusé avant d'atteindre Git.
- **Verrou** : `update` et `stop` passent par le verrou du projet, `preview:<projet>` : deux agents du même projet qui livrent en même temps se suivent au lieu de se couper l'herbe sous le pied ; les aperçus de deux projets se mettent à jour en parallèle. La durée est bornée étape par étape (`timeoutSec`), pas par le verrou.

Fichiers d'état, tous ignorés par Git : `.apv/state/preview.json`, `preview.log`, `preview.prev.log`, `preview-update.log`.

## Exemple : SvelteKit et Supabase (projet pilote)

Le projet pilote sert son aperçu sur `http://localhost:5190`, avec une pile Supabase locale **séparée** de celle des tests : son propre dossier, son propre `project_id` et tous ses ports en 563xx (API 56321, base 56322, base fantôme 56320, pooler 56329, Studio 56323, Mailpit 56324). Les tests remettent leur base à zéro sans jamais toucher à celle de l'aperçu.

Préparation, une seule fois :

```sh
mkdir -p ~/apercu-supabase && cd ~/apercu-supabase
npx -y supabase@2.117.0 init
# supabase/config.toml : project_id = "mon-projet-apercu", ports en 563xx
npx -y supabase@2.117.0 start
npx -y supabase@2.117.0 status -o env > env.status   # API_URL, PUBLISHABLE_KEY, SECRET_KEY, MAILPIT_URL...
cp /chemin/vers/seed-apercu.mts .                      # graine de démonstration, compte de démo
```

`.apv/config.json` du projet :

```json
{
  "preview": {
    "branch": "main",
    "envFile": "~/apercu-supabase/env.status",
    "steps": {
      "install": "npm ci --silent",
      "migrate": {
        "command": "A=\"$HOME/apercu-supabase\" && rm -rf \"$A/supabase/migrations\" && cp -r supabase/migrations \"$A/supabase/\" && cd \"$A\" && npx -y supabase@2.117.0 db reset --local --no-seed",
        "timeoutSec": 600
      },
      "build": "PUBLIC_SUPABASE_URL=http://localhost:56321 PUBLIC_SUPABASE_PUBLISHABLE_KEY=\"$PUBLISHABLE_KEY\" npm run -s build",
      "seed": "cp \"$HOME/apercu-supabase/seed-apercu.mts\" . && SUPABASE_TEST_URL=\"$API_URL\" SUPABASE_TEST_PUBLISHABLE_KEY=\"$PUBLISHABLE_KEY\" SUPABASE_TEST_SECRET_KEY=\"$SECRET_KEY\" SUPABASE_TEST_MAILPIT_URL=\"$MAILPIT_URL\" npx tsx seed-apercu.mts"
    },
    "serve": {
      "command": ["npx", "vite", "preview", "--port", "5190", "--strictPort", "--host", "0.0.0.0"],
      "port": 5190,
      "host": "0.0.0.0",
      "env": {
        "PUBLIC_SUPABASE_URL": "http://localhost:56321",
        "PUBLIC_SUPABASE_PUBLISHABLE_KEY": "${PUBLISHABLE_KEY}",
        "SUPABASE_SECRET_KEY": "${SECRET_KEY}",
        "CONTACT_IP_SALT": "apercu-local-sel",
        "NODE_ENV": "production"
      }
    },
    "health": { "path": "/", "timeoutSec": 60 },
    "announce": { "url": "http://localhost:5190" }
  }
}
```

Puis, à chaque livraison :

```sh
apv preview update main
apv preview status
```

Remarques :

- `migrate` copie les migrations **du commit affiché** (dans la copie) vers la pile d'aperçu, puis la remet à zéro : la base de l'aperçu suit toujours le schéma de la branche, et la graine recrée les données de démonstration juste après.
- L'aperçu parle à la pile d'aperçu (`http://localhost:56321`, et `API_URL` du fichier d'environnement pour la graine), jamais à celle des tests (553xx dans le projet pilote) ni à la production. L'adresse publique est `localhost`, comme `site_url` et les adresses de retour de la configuration d'authentification de la pile d'aperçu.
- `migrate` a son propre délai (600 s, comme le `timeout 600` du script manuel) ; les autres étapes gardent 900 s.
- Le fichier `env.status` contient des clés : il reste hors du dépôt (`~/apercu-supabase/`) et ses valeurs sont masquées dans tout ce qu'affiche `apv preview`.
- `vite preview` est lancé par `npx` : l'arrêt vise tout le groupe de processus, `npx` et le serveur `vite` qu'il a lancé.

### Essai réel (2026-09-23)

Cette configuration a remplacé le script manuel du projet pilote (`update.sh`) sur la vraie pile d'aperçu, depuis une copie du dépôt : trois mises à jour de 41 à 45 s (installation 6 s, remise à zéro de la base 31 s, build 5 s, graine 2 s), page d'accueil et `/connexion` en 200, connexion du compte de démo par le lien reçu dans Mailpit (56324) jusqu'au tableau de bord, seule la base de l'aperçu redémarrée (celle des tests intacte). Différences avec le script :

- le serveur manuel n'appartenait pas à `apv` : `update` a refusé le port 5190 tant qu'il tournait, il a fallu l'arrêter une fois à la main (le script, lui, tuait tout processus dont la ligne de commande contenait `vite preview --port 5190`) ;
- la sortie des étapes est gardée, masquée, dans `preview-update.log` : le script la jetait (`>/dev/null`, `| tail -1`), ce qui cachait par exemple un rendez-vous de démonstration refusé par une contrainte de la base (`scheduled_events_modality_check`) ;
- l'annonce dit ce qui a changé depuis l'aperçu précédent, et `status` dit si le serveur répond vraiment.

## Limites connues

- Pas de bascule sans coupure : le serveur est arrêté avant la reconstruction (comme le script manuel). Pendant une mise à jour, l'aperçu ne répond pas.
- Une étape bloquée garde le verrou jusqu'à son délai (`timeoutSec`, 900 s par défaut). Interrompre `apv` (Ctrl+C) transmet le signal au groupe de l'étape en cours, puis libère le verrou par la vérification du pid.
- `git archive` respecte `export-ignore` de `.gitattributes` et n'inclut pas les sous-modules.
- Linux, macOS ou WSL2 : `sh`, `tar` et les groupes de processus POSIX sont nécessaires. Sans `/proc` (macOS), un pid réutilisé par le système n'est pas détecté.
