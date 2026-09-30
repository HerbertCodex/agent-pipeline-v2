# Réutilisation des éléments existants et carte du code

Règle de l'opérateur : on utilise les éléments existants ; ce qui sert à plusieurs fonctionnalités devient modulable ; pas de code mort, inutile ou répété ; du code propre, modulable et maintenable.

Constat du projet pilote (30 septembre 2026), rendu générique : un implementer a construit une administration avec sa propre coquille (barre latérale non repliable, barre d'onglets, toasts, icônes) alors que l'application avait déjà ses composants partagés de barre latérale, de barre d'onglets, de barre du haut et de toast ; il a écrit des `<select>` natifs à côté d'un composant partagé de liste déroulante ; des heures se coupaient en fin de ligne (« 14 / h 47 »). Aucune étape ne l'a arrêté : la consigne ne demandait pas de réutiliser, le contrôle de code mort ne voit pas le code copié, les relectures ne demandaient pas « ce composant existe-t-il déjà ? », et aucun agent ne recevait de carte du code.

APV3 y répond à quatre endroits, pour toute pile :

| Où | Quoi |
|---|---|
| Consigne | `agents/implementer.md`, le modèle de consigne commune (`.apv/brief.md`), l'architecte, les compétences `clean-code`, `refactoring`, `ui-design` et `design` : lire la carte du code avant de créer, réutiliser ou étendre de façon générique, jamais de copie par fonctionnalité, partager ce que deux fonctionnalités utilisent, retirer ce que le changement rend inutile, valeurs typographiques insécables. Le rapport d'un implementer cite l'entrée de la carte réutilisée ou justifie l'ajout (champ `reuse` du workflow `apv:vague`, refusé s'il manque). |
| Carte du code | `apv map` écrit `.apv/code-map.md` ; le contrôle `code-map` (`apv map --check`) échoue quand elle ne correspond plus au code. |
| Contrôle automatique | `apv reuse check` (contrôle `reuse`) : éléments natifs réservés, primitives de style redéfinies, blocs copiés, composants homonymes, valeurs typographiques sécables. |
| Relecture | point obligatoire de la revue `fidelite` (`agents/qa-fidelite.md`, workflow `apv:revues`, `/apv:review`) : « pour chaque nouveau composant ou bloc d'interface, quel composant existant aurait dû servir ? », gravité `eleve` quand un équivalent partagé existe et n'est pas utilisé. |

`apv init` et `apv onboard` déclarent les deux contrôles (`code-map` pour tout projet, `reuse` pour un projet web), détectent la section `reuse` et écrivent la première carte.

## 1. La carte du code (`apv map`)

```
apv map [--check] [--repo <chemin>] [--json]
```

La carte est construite depuis l'inventaire du dépôt (`src/knowledge/inventory.ts`, le même que celui de `apv spec validate`), sur l'arbre de travail : fichiers suivis présents et fichiers non suivis non ignorés, jamais les fichiers ignorés. Elle est déterministe (tri par octets, aucun identifiant de commit, aucune date), sans modèle, et bornée pour rester lisible par un agent : sections par dossier, 40 entrées par dossier, `map.maxEntries` (400) en tout ; ce qui dépasse est compté, jamais listé (`apv map --json` donne tout).

| Section | Contenu |
|---|---|
| Composants partagés | composants des dossiers `reuse.shared` : rôle en une ligne (commentaire `@component` ou premier commentaire du fichier), props (Svelte `$props()` et `export let`, Vue `defineProps`, Astro `Astro.props`, React paramètres ou `XxxProps`), variantes (unions de chaînes d'une prop : `variant (primary / ghost)`), où ils sont utilisés (nombre de fichiers, trois exemples) |
| Modules partagés | modules hors des dossiers de routes qui exportent quelque chose ou sont importés : rôle, exports (fonctions suivies de `()`), utilisateurs |
| Routes | routeurs à fichiers (SvelteKit `routes/**/+page`, Remix `app/routes`, Next.js `app/**/page` et `pages/`, Nuxt et Astro `pages/`) et routes déclarées dans le code (`app.get('/x')`, `@router.post("/x")`...) |
| Propre à une fonctionnalité | composants hors des dossiers partagés, modules des dossiers de routes, avec les **doublons possibles** (règle des noms, section 2.4) |

Un composant « utilisé nulle part » est un candidat au retrait. Les usages sont lus dans les imports ECMAScript (statiques, dynamiques, `require`), y compris par un fichier d'index qui réexporte, et Python ; les chemins relatifs sont résolus exactement, les alias (`$lib/`, `@/`, `~/`, `#`) par suffixe. Les tests ne comptent pas comme usage.

`apv map` écrit la carte si elle a changé ; `apv map --check` la compare seulement et sort en `1` si elle est absente ou périmée, avec les lignes attendues et celles qui ne le sont plus. **À commiter avec le code qu'elle décrit** : un changement qui ajoute, déplace ou retire un composant, un module, une route ou un import d'un élément partagé la rend périmée. Un conflit de fusion sur la carte ne se résout jamais à la main : `apv map` après la fusion.

## 2. Le contrôle `apv reuse check`

```
apv reuse check [--base <ref>] [--all] [--repo <chemin>] [--json]
```

### 2.1 Nouveau ou existant

Ce que le changement ajoute (lignes ajoutées ou modifiées, fichiers créés, depuis la base commune de la base et de HEAD, arbre de travail compris) est **nouveau** ; le reste est **existant**. Seul un constat nouveau de gravité `error` est bloquant (sortie `1`) ; un constat existant est signalé sans bloquer, pour qu'un projet qui a un historique adopte le contrôle sans tout nettoyer d'abord. La base est `--base <ref>` (tout commit), sinon `reuse.reference` (la branche où vont les PR, `origin/main` par exemple, résolue par sa ref complète comme `skipWhenOnly.reference` : introuvable ou ambiguë, refus `REUSE_BASE`, sortie `1`, « récupérez-la (git fetch) »). Sans l'une ni l'autre, tout compte comme nouveau.

Sortie : `0` aucun constat bloquant, `1` au moins un, une configuration invalide ou une référence introuvable, `2` appel incorrect. Texte : une section par règle (gravité, nombre de nouveaux et d'existants, puis chaque constat nouveau et les 5 premiers existants ; `--all` les liste tous). JSON : `ok`, `base` (`source` : `option`, `reference` ou `none` ; `ref` ; `mergeBase`), `analyzedFiles`, `rules` (par règle : `severity`, `active`, `note`, `new`, `existing`), `findings` (`rule`, `severity`, `isNew`, `blocking`, `path`, `line`, `endLine`, `other`, `message`), `primitives`.

### 2.2 Règles

| Règle | Défaut | Constat |
|---|---|---|
| `native` | `error` | élément natif réservé (`select`, `dialog`, `datalist` par défaut) écrit dans un fichier d'interface (`.svelte`, `.vue`, `.tsx`, `.jsx`, `.astro`, `.html`, `.hbs`, `.erb`, `.ejs`, `.njk`, `.twig`, `.liquid`, `.mdx`) hors de `native.allowedPaths` ; le message nomme le composant partagé à utiliser |
| `styles` | `error` | primitive de la feuille globale redéfinie dans un style local |
| `duplicates` | `error` | bloc copié (paires `fichier:lignes`) |
| `names` | `warning` | nouveau composant dont le nom ou le rôle doublonne un composant partagé |
| `typography` | `warning` | heure, date, montant, nombre et unité séparés par une espace sécable, dans une langue qui l'interdit |

Chaque règle se règle en `off`, `warning` ou `error` (`reuse.severity`). Les chemins de `reuse.ignore` et les dossiers ignorés par défaut (dépendances, sorties de build, dossiers qui commencent par un point, `docs/**` où vivent les maquettes, fichiers minifiés ou générés, `*.d.ts`, le dossier `design.dir`) sont laissés de côté par toutes les règles ; les tests aussi (sauf pour la carte, qui les compte à part).

### 2.3 Éléments natifs réservés (`native`)

`native.elements` associe à chaque élément réservé le composant partagé qui le remplace : `{ "select": "src/lib/components/ui/Select.svelte", "dialog": null }`. Un sélecteur est un nom d'élément en minuscules (`select`) ou un élément et une valeur d'attribut (`input[type=date]`, qui reconnaît aussi `type={'date'}`). `null` : l'outil cherche dans la carte un composant partagé du même rôle (liste déroulante pour `select` et `datalist`, dialogue pour `dialog`) et le nomme ; sinon le message demande d'en créer un, paramétrable, dans les dossiers partagés. Seules les balises en minuscules comptent (`<Select>` est un composant), commentaires exclus. `native.allowedPaths` (par défaut `shared`) : là où ces éléments restent permis, les primitives qui les enveloppent.

### 2.4 Primitives de style (`styles`)

Les **primitives** sont les classes qui ouvrent une règle de premier niveau de la feuille globale (`.btn`, `.btn--primary`, `.input` ; dans `@media`, `@layer`, `@supports` compris ; `@utility nom` de Tailwind 4 aussi), plus `styles.selectors` (`.pill--*` pour un préfixe), moins `styles.except`. Feuille globale : `styles.sources`, sinon celles de la liste par défaut présentes dans le dépôt (`src/app.css`, `src/app.scss`, `src/styles/global.css`, `app/globals.css`, `styles/globals.css`...), plus les feuilles du dépôt qu'elles importent par un chemin relatif (`@import './styles/buttons.css'`). Sans feuille ni sélecteur, la règle est inactive et le dit.

Les styles locaux lus : les blocs `<style>` des fichiers d'interface et les feuilles de style hors des sources et de `styles.allowedPaths` (par défaut `shared`). Règle, simple et vérifiable à la main :
- le sélecteur est d'abord déballé (`:global(.btn)`, `:deep(.btn)`, `::v-deep`, `:is()`, `:where()` deviennent `.btn`) et les règles imbriquées aplaties (`.card { .btn {} }` donne `.card .btn`, `&.x` donne `.card.x`) ;
- une primitive dans le **premier composé** du sélecteur (`.btn`, `.btn:hover`, `.btn.mine`) est une **redéfinition** : constat ;
- une primitive seulement après un combinateur, sous une classe du composant (`.panel .btn`, `.own > .input`), est un **ajustement imbriqué** : constat aussi, sauf si `styles.nested` vaut `"allow"`.

Une variante manquante s'ajoute à la primitive (feuille globale) ou au composant partagé, jamais par une copie locale.

### 2.5 Code dupliqué (`duplicates`)

Détecteur de clones exacts par jetons, écrit dans l'outil : la méthode de jscpd (fenêtres de `minTokens` jetons comparées par empreinte roulante de Rabin-Karp, puis étendues tant que les deux copies restent égales), sans dépendance. Raisons de ce choix plutôt que jscpd (libre, MIT) : l'outil `apv` n'a aucune dépendance d'exécution et ne télécharge rien pendant une preuve ; le détecteur lit le contenu d'un fichier à la base commune (`git show`) pour dire si un bloc était déjà copié, ce qu'un outil externe ne fait pas ; le résultat est le même sur toutes les piles et toutes les machines.

- Jetons : identifiants, nombres, chaînes (une chaîne entre guillemets s'arrête en fin de ligne, un gabarit peut en couvrir plusieurs) et chaque autre caractère ; espaces et commentaires ignorés (`//`, `/* */`, `<!-- -->`, `#` pour Python, Ruby, YAML...). Les instructions `import` et `export ... from` (ECMAScript, Python) sont effacées : deux pages qui importent les mêmes composants ne sont pas une copie.
- Seuils : `duplicates.minTokens` (50) et `duplicates.minLines` (5, sur chacune des deux copies), comme jscpd par défaut. Une copie est ramenée aux lignes qu'elle couvre entièrement.
- Fichiers : code, balisage et styles (`duplicates.paths` pour restreindre), tests exclus, `duplicates.ignore` en plus.
- **Nouveau** : un bloc dont l'une des copies contient une ligne ajoutée ou modifiée par le changement, sauf si la même suite de jetons existait déjà dans les deux fichiers à la base commune (un bloc seulement déplacé, ou raccourci, reste existant). Modifier les deux copies d'un bloc déjà dupliqué en fait un bloc nouveau : c'est le moment de le factoriser.
- Sortie : `fichier:début-fin` de la copie, `other` pour l'autre, nombre de lignes et de jetons. Un bloc copié trois fois donne deux paires, chacune avec la première copie.

### 2.6 Composants homonymes ou redondants (`names`)

S'appuie sur la carte du code (section 1). Pour chaque composant **créé** par le changement (tous sans base), comparé à chaque composant partagé, par une règle que chacun peut refaire à la main :
- **même nom** : les mêmes mots (`admin/Toast.svelte` et `ui/Toast.svelte`) ;
- **nom construit sur lui** : le nom partagé commence ou termine l'autre (`AdminToast` et `Toast`, `SelectField` et `Select`) ;
- **même rôle** : les deux noms finissent par un mot de la même famille de rôles (`Snackbar` et `Toast`, `AdminLayout` et `AppShell`), ou le nouveau est une coquille (`shell`, `layout`, `frame`...) à côté d'une barre latérale, d'une barre du haut ou d'une barre d'onglets partagées.

Les mots d'un nom viennent de sa casse (`AdminToast` : admin, toast) ; les mots de position finaux (`Container`, `Wrapper`, `Provider`, `List`, `Item`...) sont retirés avant de lire le rôle ; un mot composé se lit joint (`TabBar` : `tabbar`). Familles par défaut : coquille, barre latérale, barre du haut, barre d'onglets, toast, dialogue, tiroir, liste déroulante, sélecteur de date, menu, bulle, bouton, icône, champ, case à cocher, onglets, carte, badge, tableau, pagination, indicateur de chargement, squelette, alerte, avatar, fil d'Ariane, accordéon, état vide (`src/reuse/config.ts`) ; `names.roles` en ajoute ou en retire. **Composition** : un composant qui importe le composant partagé, ou que celui-ci importe, s'appuie sur lui : pas de constat. Un constat par composant, qui liste tous les partagés concernés. Avertissement par défaut : la règle invite à regarder, elle ne prouve pas une copie.

### 2.7 Valeurs typographiques (`typography`)

Actif seulement pour une langue qui l'exige (`typography.locale`, détectée par `apv init` et `apv onboard` depuis le `lang` du document) : le français (`fr`, `fr-CA`...). Motifs : heure (`14 h 47`, `{h} h {m}`, `${h} h ${m}`), date (`30 septembre`), nombre et unité ou devise (`12 €`, `50 %`, `3 km`, `5 min`, `2 Go`), séparateur de milliers (`1 000`), séparés par une espace ordinaire (U+0020). Lus : les lignes de balisage des fichiers d'interface (hors `<script>` et `<style>`), et dans le code (scripts, `.ts`, `.js`, JSX, fichiers JSON de traduction sous `locales/`, `i18n/`, `messages/`, `lang/`) les seules chaînes et le texte JSX. Seules les lignes ajoutées ou modifiées sont examinées. Correction : espace insécable (U+00A0, `&nbsp;`, ` `) ou fine insécable (U+202F, `&#8239;`, ` `).

## 3. Configuration

Sections facultatives de `.apv/config.json`, validées par le chargeur commun (`apv status` signale une valeur invalide) :

```json
{
  "reuse": {
    "reference": "origin/main",
    "shared": ["src/lib/components/**"],
    "ignore": ["src/lib/legacy/**"],
    "native": {
      "elements": { "select": "src/lib/components/ui/Select.svelte", "dialog": "src/lib/components/ui/Dialog.svelte", "datalist": null, "input[type=date]": null },
      "allowedPaths": ["src/lib/components/ui/**"]
    },
    "styles": { "sources": ["src/app.css"], "selectors": [".pill--*"], "except": [".sr-only"], "allowedPaths": ["src/lib/components/ui/**"], "nested": "refuse" },
    "duplicates": { "minLines": 5, "minTokens": 50, "ignore": ["src/lib/generated/**"] },
    "names": { "roles": { "feed": ["feed", "timeline"], "badge": null } },
    "typography": { "locale": "fr" },
    "severity": { "names": "warning", "typography": "warning" }
  },
  "map": { "file": ".apv/code-map.md", "ignore": ["scripts/**"], "maxEntries": 400 }
}
```

- `reference` : branche de référence (lettres, chiffres, `.`, `_`, `/`, `-`). Absente : `--base`, sinon tout compte comme nouveau.
- `shared` : motifs (`*`, `**`, `?`, `{a,b}`) des dossiers de composants partagés ; défaut `**/components/**`, `**/ui/**`, `**/shared/**`, `**/common/**`.
- `ignore`, `native.allowedPaths`, `styles.sources`, `styles.allowedPaths`, `duplicates.paths`, `duplicates.ignore`, `map.ignore` : motifs relatifs au dépôt (un chemin absolu ou qui sort du dépôt est refusé).
- `native.elements` : 50 éléments au plus ; valeur `null` ou chemin du composant partagé.
- `styles.selectors`, `styles.except` : classes (`.btn`) ou préfixes (`.btn--*`).
- `duplicates.minLines` de 2 à 1000, `minTokens` de 10 à 10000.
- `names.roles` : familles en kebab-case, mots en minuscules sans séparateur ; `null` retire une famille par défaut.
- `typography.locale` : étiquette de langue (`fr`, `fr-CA`).
- `severity` : `off`, `warning` ou `error`, pour toutes les règles ou par règle.
- `map.file` : chemin `.md` relatif (défaut `.apv/code-map.md`) ; `map.maxEntries` de 20 à 5000.

## 4. Intégration à la preuve

`apv init` et `apv onboard` ajoutent, quand ils créent la configuration :

```json
{ "id": "reuse", "command": ["apv", "reuse", "check"], "covers": ["architecture"], "stage": "task", "readOnly": true, "mandatory": true },
{ "id": "code-map", "command": ["apv", "map", "--check"], "covers": ["architecture"], "stage": "task", "readOnly": true, "mandatory": true }
```

Étape `task` : ils tournent après chaque tâche et dans la suite complète (qui exécute aussi les contrôles de tâche), avec leurs reçus comme les autres (`apv gates run`, `apv gates verify`). Lecture seule : ils tournent en parallèle des autres. `apv` doit être sur le `PATH` (plugin activé, ou `npm link`), sinon `["node", "<chemin du plugin>/dist/cli.js", "reuse", "check"]`. Le contrôle `reuse` ne prend pas `{{baseSha}}` : il compte depuis `reuse.reference`, ce qui n'oblige pas `apv gates run` à recevoir `--base`.

Un contrôle `reuse` rouge se corrige en réutilisant ou en factorisant ; jamais en baissant une gravité, en élargissant `reuse.ignore` ou `allowedPaths`, ni en retirant le contrôle : ces changements de `.apv/config.json` sont des décisions de l'opérateur.

## 5. Adopter sur un projet existant

1. `apv onboard --dry-run`, puis `apv onboard` : la section `reuse` détectée (dossiers partagés : les plus hauts dossiers `components`, `ui`, `shared`, `common`, `widgets`, `primitives`... qui contiennent des composants, hors des dossiers de routes ; dossier des primitives `ui` ou `primitives` pour les éléments natifs ; composant qui remplace chaque élément réservé ; langue ; branche de référence `origin/HEAD`, sinon `origin/main` ou `origin/master`, sinon la branche courante), les deux contrôles, la carte du code, et la liste de ce qui est **déjà** dupliqué ou refait (20 premiers constats, blocs copiés d'abord ; `apv reuse check --all` pour tout).
2. Relire avec l'opérateur `shared`, `native.elements`, `reference` (compétence `/apv:onboard`, étape 4 bis). Sans `reference`, tout le code existant compte comme nouveau.
3. Commiter `.apv/` (configuration et carte). Les constats existants ne bloquent pas ; les résorber est une spec de rangement à part, décidée par l'opérateur. Chaque PR suivante ne peut plus en ajouter.

Un projet qui a déjà `.apv/config.json` ne reçoit rien automatiquement (aucun fichier n'est jamais écrasé) : ajouter les deux contrôles et la section à la main, puis `apv map`.

## 6. Limites connues

- Clones exacts seulement (espaces et commentaires ignorés) : une copie dont on a renommé les identifiants n'est pas vue ; la règle des noms et la relecture restent le filet.
- Un bloc rendu identique par une simple suppression de lignes n'est pas compté comme nouveau.
- La règle des noms repose sur des mots anglais usuels des noms de composants ; des noms dans une autre langue demandent `names.roles`.
- Les styles écrits en JavaScript (CSS-in-JS) ne sont pas analysés par la règle `styles` ; leurs copies restent vues par `duplicates`.
- Les usages de la carte ne sont calculés que pour les imports ECMAScript et Python.
- La typographie ne connaît que le français.
- Tout le dépôt est analysé à chaque passage (quelques secondes pour quelques milliers de fichiers) ; `duplicates.paths` le restreint si besoin.
