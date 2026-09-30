# Arborescence et carte de l'architecture

Règle de l'opérateur : l'arborescence suit des conventions qui existent déjà, pour qu'un nouveau développeur, humain ou agent, s'y retrouve vite ; un dossier trop plein se range sur un plan validé, jamais en douce ; une carte de l'architecture courte dit où va quoi.

Constat du projet pilote (« Toujours rien », SvelteKit, 30 septembre 2026), rendu générique : `src/lib/applications/` contenait 27 fichiers de code à plat (seuil 12), `src/lib/guides/` 34, `src/lib/home/` 28, `src/lib/components/applications/` 30, `src/lib/shared/` 20. `apv structure check` ne donnait qu'un avertissement (« sans préfixe commun ni rôle reconnu : découpage à décider avec l'opérateur »), sans aucun déplacement proposé ; le contrôle ne bloquait rien, et aucun agent n'était chargé de proposer une réorganisation. La carte du code listait composants et modules, sans vue d'ensemble.

APV3 y répond à cinq endroits, pour toute pile :

| Où | Quoi |
|---|---|
| Découpage proposé | `apv structure check` découpe un dossier à plat par usage, même sans préfixe commun (section 1). |
| Cliquet | le contrôle `structure` (`apv structure check --base {{baseSha}}`, étape tâche, obligatoire) refuse un fichier de code ajouté à un dossier à plat et nomme le sous-dossier où le mettre (section 2). |
| Carte de l'architecture | `docs/carte-architecture.md` : une page, lue en premier ; parties générées par `apv map`, parties écrites jamais réécrites ; le contrôle refuse un nouveau dossier, une route principale ou un point d'entrée non décrit, un lien cassé (section 3). |
| Profils de pile | les conventions citées par les propositions et la carte, avec les liens de la documentation officielle (section 4). |
| Rôles | compétence `apv:structure`, architecte, consigne des implementers et des relecteurs, champ `placement` du rapport de vague, `apv init` et `apv onboard` (section 5). |

## 1. Découpage d'un dossier à plat

Un dossier a plus de `structure.maxFlatFiles` fichiers de code directement (12 par défaut ; un fichier et ses compagnons `x.ts`, `x.svelte.ts`, `x.d.ts` comptent pour un, ses tests à part, ils le suivent). Les règles de noms passent d'abord (`stray-file`, `repeated-prefix`, `mixed-roles`, noms composés qui s'enchaînent) ; ce qu'elles ne placent pas est découpé par usage, à partir du graphe des imports de la carte du code (`src/knowledge/code-map.ts` : imports ES, alias `$lib/`, `@/`, `~/`, barils `index`, Python), sans modèle, sans lire autre chose que les fichiers du dépôt.

1. **Socle** : un fichier que le quart du dossier importe au moins (trois fichiers au minimum), ou le modèle du domaine par son nom (`model`, `types`, `schema`, `constants`, importé par un fichier du dossier), reste à la racine : c'est le point d'entrée du domaine, et le déplacer réécrirait la plupart des imports.
2. **Description de chaque fichier** : qui l'importe (dossier du fichier qui l'importe, ou route servie, par ses deux premiers segments), les fichiers qui l'importent (deux fichiers importés par le même fichier se rapprochent), ses liens d'import avec les autres fichiers du dossier (dans les deux sens), les mots de son nom et de ses exports. Poids : ce que tous les fichiers partagent ne dit rien (fréquence inverse).
3. **Ancres** : les sous-dossiers existants du dossier, et ceux du même domaine ailleurs (`components/applications/sheet/` pour `lib/applications/`), sont décrits de la même façon (qui les utilise, leurs fichiers qui importent le fichier ou qu'il importe) et attirent les fichiers utilisés comme eux : même découpage partout. Les dossiers de routes ne servent jamais d'ancre (ce sont des segments d'URL), ni les noms génériques (`components`, `ui`, `shared`, `server`...). Deux passes : un dossier de composants suit aussi le découpage proposé pour le dossier de modules de même nom (le code métier décide, les composants suivent ; jamais l'inverse, jamais un nom tiré d'un composant). Hors du dossier, une ancre exige un lien d'import réel.
4. **Groupes** : similarité cosinus des descriptions, liaison moyenne, la paire la plus proche d'abord (égalités départagées par les chemins), seuil 0,2, jamais plus de `maxFlatFiles` fichiers par groupe, une ancre par groupe. Un fichier seul ne rejoint une ancre que si elle représente la moitié de son usage.
5. **Nom** : sous-dossier existant, sinon même découpage que le dossier miroir, sinon le vocabulaire du projet par ordre de score : module principal du groupe (celui qui a le plus de liens dans le groupe, puis celui qui importe les autres, puis le plus utilisé), mot commun à plusieurs fichiers (avec les mots qui le suivent : `first-visit`), domaine déclaré (`structure.domains`), dossier ou route qui représente au moins 60 % de l'usage (jamais pour un dossier de briques partagées, `ui`, `shared`, `utils` : un groupe s'y nomme par ce que sont ses fichiers). Jamais un nom générique, le nom du dossier lui-même, ni celui d'un fichier qui reste à la racine.

6. **Racine sous le seuil** : tant que la racine (socle, points d'entrée, fichiers non placés) dépasse `maxFlatFiles`, le fichier non placé le plus proche d'un groupe (similarité moyenne au-dessus de 0,05, groupe sous le seuil) le rejoint, et le groupe le dit (« rattaché au groupe le plus proche »). Ce qui ne ressemble à aucun groupe reste « à décider avec l'opérateur ».

Chaque groupe dit pourquoi : d'où vient son nom, qui l'utilise (trois contextes au plus), ses liens d'import ; et quelle convention il suit (profil de la pile, section 4). Le plan (`ancien -> nouveau`) déplace tests et compagnons avec leur fichier, retire du nom ce que le dossier dit déjà (`quick-add-draft.ts` -> `quick-add/draft.ts`), garde le nom des composants, n'écrase jamais un fichier. Il n'est **jamais appliqué** par l'outil. Le calcul est déterministe : mêmes fichiers et même graphe, mêmes groupes, dans le même ordre, quel que soit l'ordre des entrées.

Ce que l'outil ne sait pas : il ne lit pas l'intention (deux fichiers utilisés au même endroit pour des raisons différentes seront rapprochés), un fichier sans importeur ni lien reste « à décider avec l'opérateur », un nom tiré d'un mot faible est à revoir. La compétence `apv:structure` dit comment juger une proposition avant de la montrer.

## 2. Cliquet : rien ne s'ajoute à un dossier à plat

`apv structure check --base <ref>` compare le changement (arbre de travail : fichiers suivis et non suivis non ignorés) à la base commune de `<ref>` et HEAD, avec la **configuration de la base** : un changement qui relève `maxFlatFiles`, élargit `ignore` ou baisse une gravité est jugé avec l'ancienne, et le changement de la section `structure` est signalé (bloquant quand le changement touche aussi du code : c'est une PR de configuration à part, décidée par l'opérateur). Le contrôle déclaré passe `{{baseSha}}`, la base du passage, qui fait partie de la clé de preuve de chaque reçu.

| Constat | Bloquant quand | Existant (signalé sans bloquer) |
|---|---|---|
| `flat-growth` | un fichier de code (nouveau nom de fichier principal) arrive dans un dossier qui a plus de `maxFlatFiles` fichiers de code : dossier déjà à plat, ou qu'il fait passer au-dessus du seuil ; le message nomme le sous-dossier du découpage proposé (ou la règle de noms qui le place), sinon renvoie au découpage à décider | le dossier à plat lui-même (`flat-folder`) |
| `architecture-map` | un dossier de premier ou deuxième niveau, une route principale ou un point d'entrée que la base n'avait pas, sans rôle dans la carte ; un lien de la carte que le changement casse ; la carte supprimée | ce qui existait à la base sans rôle, un lien déjà cassé |
| constats d'analyse de gravité `error` | le constat porte sur un fichier que le changement crée ou déplace | les autres |

Toujours acceptés : un fichier renommé dans son dossier, un fichier qui descend d'un dossier à plat dans l'un de ses sous-dossiers, et donc tout rangement qui réduit un dossier à plat. Un nouveau sous-dossier doit toutefois être décrit dans la carte quand il est de premier ou deuxième niveau. `flat-growth` et `architecture-map` ont la gravité `error` par défaut (`structure.severity`), les constats d'analyse `warning`.

Sans `--base`, rien n'est comparé : analyse des fichiers suivis, carte signalée sans bloquer, comme avant.

## 3. Carte de l'architecture

Fichier court et versionné, `structure.architectureMap` (par défaut `docs/carte-architecture.md`), à lire en premier par les agents et les développeurs, puis la carte du code. Écrit par `apv init`, `apv onboard` et `apv structure map` quand il manque ; ses parties générées sont réécrites par `apv map` (à chaque intégration, avec la carte du code) et `apv structure map` ; `apv map --check` et `apv structure map --check` échouent quand elles ne correspondent plus au code.

| Partie | Nature | Contenu |
|---|---|---|
| En bref | écrite | ce que fait le projet, pour qui |
| Couches et flux | écrite (brouillon généré à la création) | schéma mermaid : navigateur, routes, code partagé, code serveur, base (dossier de migrations), services externes (dépendances connues : Supabase, Stripe, Resend, Sentry...), tâches planifiées (`vercel.json` avec `crons`, workflows avec `schedule`) |
| Arborescence | générée | dossiers de premier et deuxième niveau, et ceux des deux niveaux sous les ancres de la pile (`src/lib` pour SvelteKit), jamais les dossiers de routes : rôle (écrit, sinon rôle connu de la pile, sinon « à décrire »), convention suivie avec le lien de sa documentation, dossier à plat et sous-dossiers proposés |
| Points d'entrée | générée | fichiers appelés par la pile (hooks, layouts racine et de section, middleware, `app.html`, validateurs de paramètres), crons, dossiers de migrations ; routes principales (premier segment de l'URL) |
| Règles transverses | écrite (brouillon) | où sont les règles de sécurité, d'accès, de données, de tests (liens détectés : consigne commune, `docs/*securite*`, `CLAUDE.md`...) |
| Pour aller plus loin | générée | README, `docs/architecture.md`, carte du code, consigne commune, registre, specs, maquettes validées, autres documents de `docs/`, conventions de la pile |
| Rôles | écrite | une ligne par dossier, route principale et point d'entrée : `` - `src/lib/applications/` : code métier des candidatures ``. Un motif `*` décrit plusieurs dossiers (`` `src/lib/components/*/` ``). « à décrire » ne compte pas |

Les parties écrites sont entre marqueurs `<!-- apv:ecrit:<nom> -->` et `<!-- /apv:ecrit:<nom> -->` ; l'outil ne les réécrit jamais (une partie absente est ajoutée en fin de fichier avec son brouillon, rien n'est remplacé). Les parties générées sont entre `<!-- apv:genere:<nom> -->` : ne pas les modifier à la main. Le texte hors marqueurs est conservé.

La carte du code (`.apv/code-map.md`) a une section « Dossiers » : le chemin de la carte de l'architecture, et chaque dossier à plat avec ses sous-dossiers proposés, pour qu'un agent qui crée un fichier sache où ne pas le mettre.

## 4. Profils de pile

`src/structure/profiles.ts` : pile détectée par les dépendances et les fichiers marqueurs, ou imposée par `structure.profile`. Chaque profil nomme ses ancres (dossiers dont la carte décrit deux niveaux), ses dossiers de routes, ses dossiers et fichiers connus avec leur rôle, ses points d'entrée et ses conventions, chacune avec le lien de sa documentation officielle.

| Profil | Conventions (documentation) |
|---|---|
| `sveltekit` | [structure d'un projet](https://svelte.dev/docs/kit/project-structure) (routes et fichiers colocalisés, `src/params`, `hooks`), [`$lib`](https://svelte.dev/docs/kit/$lib), [`$lib/server`](https://svelte.dev/docs/kit/server-only-modules) (code serveur uniquement), [hooks](https://svelte.dev/docs/kit/hooks) ; composants génériques dans `components/ui`, de fonctionnalité dans `components/<fonctionnalité>` |
| `nextjs` | [structure d'un projet](https://nextjs.org/docs/app/getting-started/project-structure) (colocalisation, dossiers privés, groupes de routes) |
| `nuxt` | [dossiers reconnus](https://nuxt.com/docs/guide/directory-structure) |
| `astro` | [structure d'un projet](https://docs.astro.build/en/basics/project-structure/) |
| `angular` | [guide de style](https://angular.dev/style-guide) (zones fonctionnelles) |
| `vue` | [guide de style](https://vuejs.org/style-guide/) |
| `react` | [regrouper par fonctionnalité ou par route](https://legacy.reactjs.org/docs/faq-structure.html) |
| `python` | [structure d'un projet](https://docs.python-guide.org/writing/structure/), [applications Django](https://docs.djangoproject.com/en/stable/intro/reusable-apps/) |
| `go` | [organisation d'un module](https://go.dev/doc/modules/layout) |
| `generic` | dossiers par fonctionnalité |

Conventions communes : `feature-folders` (un sous-dossier par fonctionnalité, nommé avec le vocabulaire du projet), `mirror` (même découpage que les composants du domaine), `feature-core` (le socle du domaine à sa racine).

## 5. Rôles et cycle

- **Compétence `apv:structure`** : relire les constats, juger le découpage (un développeur de la pile s'y retrouverait-il sans explication ?), préparer un plan de rangement (spec à part, validée par l'opérateur), tenir la carte de l'architecture.
- **Architecte** (`agents/architecte.md`, règle 10) : lit la carte de l'architecture, place chaque fichier créé hors des dossiers à plat (sous-dossier proposé), prévoit le rôle de chaque nouveau dossier ; prépare le plan de rangement d'un dossier existant sans l'appliquer.
- **Implementers et relecteurs** : lisent la carte de l'architecture en premier, puis la carte du code (consigne `agents/implementer.md`, modèle de consigne commune, workflows `apv:vague` et `apv:revues`). Le rapport de chaque tâche porte le champ `placement` (fichier de code créé, dossier, raison), refusé s'il manque ; la revue `fidelite` lance `apv structure check --base` et relève placement et carte.
- **Chef de projet** : relit `placement` et les constats au rapport de vague ; l'intégration régénère les deux cartes (`apv map`).
- **`apv init` et `apv onboard`** : ajoutent le contrôle `structure` pour tout projet (étape tâche, obligatoire, `--base {{baseSha}}`), écrivent la carte de l'architecture si elle manque et listent les dossiers à plat déjà présents avec leurs sous-dossiers proposés.
