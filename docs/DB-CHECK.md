# Contrôle du modèle de données : `apv db check`

`apv db check` lit les migrations SQL dans l'ordre, reconstruit le schéma final (tables, colonnes, clés étrangères, index, RLS, politiques, fonctions, types) et vérifie les règles de la section 13 bis de `docs/APV3-SPEC.md`. Il lit aussi le code de l'application pour y trouver les `select *`. Aucune dépendance : un analyseur lexical léger suffit, sans base de données.

```sh
apv db check              # tableau lisible, code 1 s'il reste une erreur
apv db check --json       # sortie machine (summary, findings, suppressed, live, model)
apv db check --live       # ajoute les contrôles en direct (APV_PSQL, ou APV_DB_URL et psql)
apv db check --config chemin/config.json --root dossier
```

Codes de sortie : 0 aucune erreur (des avertissements sont possibles), 1 au moins une erreur, 2 usage.

## Configuration

Champ `db` de `.apv/config.json` (tous les champs sont facultatifs ; un champ inconnu ou mal typé est une erreur `config.invalid`, jamais ignoré) :

```json
{
  "db": {
    "migrations": "supabase/migrations/*.sql",
    "code": ["src/**/*.ts", "src/**/*.js", "src/**/*.svelte"],
    "codeExclude": ["**/*.test.*", "**/*.spec.*"],
    "allowFrench": [],
    "rlsTables": [],
    "exceptions": [
      { "rule": "code.select_star", "target": "src/lib/server/user-data.ts", "reason": "export RGPD : toutes les colonnes de l'utilisateur, voulu" }
    ],
    "explain": [
      { "name": "liste des candidatures", "sql": "select id, company from public.applications where user_id = '00000000-0000-0000-0000-000000000000' and deleted_at is null order by created_at desc limit 50" }
    ],
    "seqScanRows": 10000,
    "supabaseDefaults": true,
    "liveSchemas": ["public"]
  }
}
```

Les valeurs ci-dessus sont les valeurs par défaut (sauf `exceptions` et `explain`, vides par défaut). Les migrations sont appliquées dans l'ordre des noms de fichiers (horodatage Supabase). Si aucune migration n'est trouvée, c'est une erreur `config.no_migrations`.

**Exceptions** : `rule` et `target` acceptent des motifs (`*`, `**`, `{a,b}`) ; `reason` est obligatoire. Une exception retire le constat du compte des erreurs, mais il reste listé avec sa raison (sortie lisible et JSON). La cible de chaque constat est affichée : il suffit de la recopier.

## Règles

Chaque constat porte un identifiant, une sévérité et un emplacement `fichier:ligne` (la ligne où l'objet a été créé, ou renommé en dernier).

| Règle | Sévérité | Cible | Ce qui est vérifié |
|---|---|---|---|
| `naming.english_snake_case` | erreur | `schema.table`, `schema.table.colonne`, `schema.fonction`, `schema.type` | Identifiant en `snake_case` ASCII et sans mot français courant (dictionnaire interne, accents, pluriels et expressions comme `rendez_vous`, `cree_le`, `date_envoi`). `allowFrench` accepte des mots ou des identifiants entiers. |
| `fk.index` | erreur, ou avertissement | `schema.table.contrainte` | Chaque clé étrangère a un index dont les premières colonnes sont exactement ses colonnes (dans n'importe quel ordre). Un index partiel compte seulement si sa condition se limite à `<colonne de la clé> is not null` (les recherches de la clé, `colonne = $1`, l'impliquent) ; toute autre condition (par exemple `deleted_at is null`) écarte des lignes et ne sert pas aux vérifications de la clé. Même règle en direct (`live.fk_index`). Si seule la première colonne d'une clé composite est indexée en tête, c'est un avertissement. |
| `rls.enabled_forced` | erreur, ou avertissement | `schema.table` | Toute table du schéma `public` qui a une colonne `user_id` (ou listée dans `rlsTables`) a RLS activée, forcée et au moins une politique. Une autre table de `public` sans RLS activée donne un avertissement (exposée par l'API de Supabase). |
| `policy.too_broad` | avertissement | `schema.table.politique` | `using (true)` ou `with check (true)` pour `public`, `anon` ou `authenticated` (rôle `public` quand `to` est absent). |
| `definer.search_path` | erreur | `schema.fonction` | Toute fonction `security definer` fixe `search_path` à `''`, `pg_catalog` ou `pg_catalog, pg_temp`, dans sa définition ou par `alter function`. |
| `definer.execute_grant` | erreur | `schema.fonction` | Aucune fonction `security definer` (hors déclencheurs) exécutable par `public` ou `anon` : droit accordé explicitement, ou droit par défaut jamais retiré. Postgres accorde `execute` à `public` sur toute nouvelle fonction ; Supabase l'accorde en plus à `anon`, `authenticated` et `service_role` dans le schéma `public` (`supabaseDefaults: false` pour un Postgres sans Supabase). |
| `code.select_star` | erreur | chemin du fichier | `select('*')`, un `*` dans la liste (`'id, events(*)'`), `.select()` sans argument (supabase-js renvoie alors toutes les colonnes) et `select *` dans une chaîne SQL. `select('*', { count: 'exact', head: true })` ne lit aucune ligne et est accepté. |
| `redundancy.user_id_guard` | avertissement | `schema.enfant.contrainte` | Une table enfant avec `user_id` et une clé étrangère vers un parent qui a aussi `user_id` doit porter la clé composite `(parent_id, user_id)` vers `(id, user_id)`, ou une exception déclarée. |
| `idempotency.create_tables` | avertissement | `schema.table` | Une table de création (colonnes `user_id` et `created_at`) a une contrainte unique contenant `idempotency_key`, ou une autre clé naturelle unique (clé unique qui ne contient pas `id`), ou une exception déclarée. |
| `parse.unreadable` | erreur | fichier | Migration illisible (chaîne ou corps `$$` non fermé) : ses objets ne sont pas contrôlés. |
| `parse.statement` | avertissement | fichier | Instruction de schéma dont la forme n'a pas été comprise. |
| `config.invalid`, `config.no_migrations` | erreur | `config` | Configuration invalide ou aucune migration trouvée. |

Les règles de nommage, de RLS et d'index portent sur le schéma **final** : une migration ancienne qui a créé `candidatures` n'est plus signalée une fois la table renommée par une migration suivante (les migrations sont en avant seulement, on ne réécrit pas l'historique).

## Contrôles en direct (`--live`)

`apv db check --live` interroge la base, en lecture seule, par l'un de ces deux moyens :
- `APV_PSQL` : une commande psql complète, qui porte sa connexion ; l'outil y ajoute ses options (`-X -q -A -t -v ON_ERROR_STOP=1 -f -`) et envoie le SQL sur l'entrée standard. Pour une pile Supabase locale : `APV_PSQL="docker exec -i supabase_db_<projet> psql -U postgres -d postgres"`. La commande est découpée comme par un shell (blancs, guillemets simples et doubles, barre oblique inverse), sans aucune expansion ;
- sinon `APV_DB_URL` avec `psql` dans le `PATH`.

Chaque script commence par `set default_transaction_read_only = on` : aucune écriture n'est possible, même par une requête de `db.explain` mal écrite. Contrôles :
- `live.fk_index` : clés étrangères sans index couvrant, lues dans `pg_catalog` (même règle de sévérité que `fk.index`) ;
- `live.rls` : état réel de RLS (activée, forcée, nombre de politiques) des tables utilisateur ;
- `live.explain_seq_scan` : `EXPLAIN (FORMAT JSON, VERBOSE)` de chaque requête de `db.explain`, dans une transaction en lecture seule ; un parcours séquentiel sur une table de plus de `seqScanRows` lignes estimées (`pg_class.reltuples`) est une erreur. Les requêtes paramétrées doivent recevoir des valeurs littérales (EXPLAIN ne lie pas `$1`).

L'adresse est décomposée en variables `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE` : le mot de passe n'apparaît jamais dans la liste des processus, et il est masqué dans les messages d'erreur. Avec `APV_PSQL`, `APV_DB_URL` est facultatif (s'il est défini, il passe par les mêmes variables, que `docker exec` ne transmet pas). Si aucun moyen n'est utilisable, le rapport le dit (`live.skipped`, avertissement, et une ligne « Contrôles en direct : ignorés »). Une erreur de `psql` est une erreur `live.error` : rien n'échoue en silence.

## Limites connues

- Analyse lexicale légère, pas une grammaire complète : le DDL exécuté dynamiquement (dans un bloc `do $$ ... $$`, une fonction ou `execute format(...)`) n'est pas vu. `create table ... as select` et `partition of` sont connus sans leurs colonnes.
- `alter default privileges` n'est pas modélisé : les droits par défaut sont ceux de Postgres et de Supabase (option `supabaseDefaults`).
- Les surcharges de fonctions sont distinguées par nombre d'arguments ; `grant ... on function f` sans signature vise toutes les fonctions de ce nom.
- Une colonne d'index écrite sous forme d'expression (`lower(email)`) est gardée comme `(expression)` et ne couvre pas une clé étrangère.
- La recherche des `select *` est textuelle : un commentaire qui contient `select *` est signalé (le corriger, ou déclarer une exception).
