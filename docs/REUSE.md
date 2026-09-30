# Réutilisation des éléments existants et carte du code

Règle de l'opérateur : on utilise les éléments existants ; ce qui sert à plusieurs fonctionnalités devient modulable ; pas de code mort, inutile ou répété ; du code propre, modulable et maintenable.

Constat du projet pilote (30 septembre 2026), rendu générique : un implementer a construit une administration avec sa propre coquille (barre latérale non repliable, barre d'onglets, toasts, icônes) alors que l'application avait déjà ses composants partagés de barre latérale, de barre d'onglets, de barre du haut et de toast ; il a écrit des `<select>` natifs à côté d'un composant partagé de liste déroulante ; des heures se coupaient en fin de ligne (« 14 / h 47 »). Aucune étape ne l'a arrêté : la consigne ne demandait pas de réutiliser, le contrôle de code mort ne voit pas le code copié, les relectures ne demandaient pas « ce composant existe-t-il déjà ? », et aucun agent ne recevait de carte du code.

APV3 y répond à quatre endroits, pour toute pile :

| Où | Quoi |
|---|---|
| Consigne | `agents/implementer.md`, le modèle de consigne commune (`.apv/brief.md`), l'architecte, les compétences `clean-code`, `refactoring`, `ui-design` et `design` : lire la carte du code avant de créer, réutiliser ou étendre de façon générique, jamais de copie par fonctionnalité, partager ce que deux fonctionnalités utilisent, retirer ce que le changement rend inutile, valeurs typographiques insécables. Le rapport d'un implementer cite l'entrée de la carte réutilisée ou justifie l'ajout (champ `reuse` du workflow `apv:vague`, refusé s'il manque). |
| Carte du code | `apv map` écrit `.apv/code-map.md` ; le contrôle `code-map` (`apv map --check`, suite complète) échoue quand elle ne correspond plus au code. L'intégration la régénère une fois par vague ; les tâches ne la commitent pas. |
| Contrôle automatique | `apv reuse check` (contrôle `reuse`) : éléments natifs réservés, primitives de style redéfinies, blocs copiés, composants homonymes, valeurs typographiques sécables. |
| Relecture | point obligatoire de la revue `fidelite` (`agents/qa-fidelite.md`, workflow `apv:revues`, `/apv:review`) : « pour chaque nouveau composant ou bloc d'interface, quel composant existant aurait dû servir ? », gravité `eleve` quand un équivalent partagé existe et n'est pas utilisé. |

`apv init` et `apv onboard` déclarent les deux contrôles (`code-map` pour tout projet, `reuse` pour un projet web), détectent la section `reuse` et écrivent la première carte. L'arborescence (dossiers à plat, carte de l'architecture, contrôle `structure`) a son guide : [STRUCTURE.md](STRUCTURE.md).

## 1. La carte du code (`apv map`)

```
apv map [--check] [--repo <chemin>] [--json]
```

La carte est construite depuis l'inventaire du dépôt (`src/knowledge/inventory.ts`, le même que celui de `apv spec validate`), sur l'arbre de travail : fichiers suivis présents et fichiers non suivis non ignorés, jamais les fichiers ignorés. Elle est déterministe (tri par octets, aucun identifiant de commit, aucune date), sans modèle, et bornée pour rester lisible par un agent à chaque tâche : sections par dossier, 40 entrées par dossier, `map.maxEntries` (400) en tout, et `map.maxBytes` (32 Ko). Chaque section reçoit d'abord un dixième des octets, puis le reste va par priorité : les composants génériques (dossiers de primitives, composants partagés nommés par leur seul rôle) d'abord, puis les modules partagés, les routes, les autres composants partagés, ce qui est propre à une fonctionnalité. Les dossiers laissés de côté sont nommés avec leur nombre d'entrées (`apv map --json` donne tout). Un dépôt au-delà de la limite de l'inventaire (50 000 fichiers) reçoit une carte partielle, qui le dit, jamais un échec. Les fichiers non suivis y figurent sans résumé (un fichier non commité peut contenir ce que personne n'a décidé de publier), et un résumé masque ce qui ressemble à un secret (clés d'API, jetons, longues chaînes aléatoires).

| Section | Contenu |
|---|---|
| Composants génériques, puis autres composants partagés | composants des dossiers `reuse.shared` (les génériques à part : dossiers de primitives, ou nom qui n'est que leur rôle) : rôle en une ligne (commentaire `@component` ou premier commentaire du fichier), props (Svelte `$props()` et `export let`, Vue `defineProps`, Astro `Astro.props`, React paramètres ou `XxxProps`), variantes (unions de chaînes d'une prop : `variant (primary / ghost)`), où ils sont utilisés (nombre de fichiers, deux exemples) |
| Modules partagés | modules hors des dossiers de routes qui exportent quelque chose ou sont importés : rôle, exports (six au plus, fonctions suivies de `()`), utilisateurs (nombre, un exemple) |
| Routes | routeurs à fichiers (SvelteKit `routes/**/+page`, Remix `app/routes`, Next.js `app/**/page` et `pages/`, Nuxt et Astro `pages/`) et routes déclarées dans le code (`app.get('/x')`, `@router.post("/x")`...) |
| Propre à une fonctionnalité | composants hors des dossiers partagés, modules des dossiers de routes, avec les **doublons possibles** (règle des noms, section 2.6) |

Un composant « utilisé nulle part » est un candidat au retrait. Les usages sont lus dans les imports ECMAScript (statiques, dynamiques, `require`), y compris par un fichier d'index qui réexporte, et Python ; les chemins relatifs sont résolus exactement, les alias (`$lib/`, `@/`, `~/`, `#`) par suffixe ; les modules du framework (`$app/`, `$env/`, `virtual:`) ne sont jamais des fichiers du projet. Les tests ne comptent pas comme usage.

`apv map` écrit la carte si elle a changé, atomiquement (fichier temporaire créé en exclusivité, puis renommé) ; `apv map --check` la compare seulement et sort en `1` si elle est absente ou périmée, avec les lignes attendues et celles qui ne le sont plus. Aucun élément du chemin de la carte ne peut être un lien symbolique, et elle reste dans le dépôt une fois résolue (refus `MAP_PATH`) : une carte liée vers un fichier extérieur n'est jamais lue dans la sortie ni écrasée.

**Qui la régénère.** Un changement qui ajoute, déplace ou retire un composant, un module, une route, ou qui **ajoute un import** d'un élément partagé (son nombre d'utilisateurs change), rend la carte périmée. Les tâches ne la commitent pas : des tâches parallèles se disputeraient le même fichier. L'intégration (l'intégrateur, ou le chef de projet pour une tâche seule) lance `apv map` une fois sur la tête intégrée et commite la carte à part ; le contrôle `code-map` est à l'étape `full`, il vérifie la carte de la suite complète. `apv scope check` signale une carte commitée par une tâche, avec la commande qui la retire. Un conflit de fusion sur la carte ne se résout jamais à la main : `apv map` après la fusion. Une tâche qui a besoin de la carte à jour pour elle-même lance `apv map` en local, sans commit.

## 2. Le contrôle `apv reuse check`

```
apv reuse check [--base <ref>] [--all] [--repo <chemin>] [--json]
```

### 2.1 Nouveau ou existant

Ce que le changement ajoute (lignes ajoutées ou modifiées, fichiers créés, depuis la base commune de la base et de HEAD, arbre de travail compris) est **nouveau** ; le reste est **existant**. Seul un constat nouveau de gravité `error` est bloquant (sortie `1`) ; un constat existant est signalé sans bloquer, pour qu'un projet qui a un historique adopte le contrôle sans tout nettoyer d'abord. La base est `--base <ref>` (tout commit ; le contrôle déclaré passe `{{baseSha}}`, la base du passage, qui entre dans la clé de preuve de chaque reçu : une ref de suivi déplacée par `git update-ref` ne rend jamais une copie « existante »), sinon `reuse.reference` (la branche où vont les PR, `origin/main` par exemple, résolue par sa ref complète comme `skipWhenOnly.reference` : introuvable ou ambiguë, refus `REUSE_BASE`, sortie `1`, « récupérez-la (git fetch) »). Sans l'une ni l'autre, tout compte comme nouveau. Sans base commune (clone superficiel, historiques sans lien) : refus `REUSE_BASE`, « git fetch --unshallow ».

Sortie : `0` aucun constat bloquant, `1` au moins un, une configuration invalide ou une référence introuvable, `2` appel incorrect. Texte : une section par règle (gravité, nombre de nouveaux et d'existants, puis chaque constat nouveau et les 5 premiers existants ; `--all` les liste tous). JSON : `ok`, `base` (`source` : `option`, `reference` ou `none` ; `ref` ; `mergeBase`), `analyzedFiles`, `rules` (par règle : `severity`, `active`, `note`, `new`, `existing`), `findings` (`rule`, `severity`, `isNew`, `blocking`, `path`, `line`, `endLine`, `other`, `message`), `primitives`, `generated` (`count`, `files`).

### 2.2 Règles

| Règle | Défaut | Constat |
|---|---|---|
| `native` | `error` | élément natif réservé (`select`, `dialog`, `datalist` par défaut) écrit dans un fichier d'interface (`.svelte`, `.vue`, `.tsx`, `.jsx`, `.astro`, `.html`, `.hbs`, `.erb`, `.ejs`, `.njk`, `.twig`, `.liquid`, `.mdx`) hors de `native.allowedPaths` ; le message nomme le composant partagé à utiliser |
| `styles` | `error` | primitive de la feuille globale redéfinie dans un style local, ou retouchée sous une classe du composant ailleurs que dans sa mise en page |
| `duplicates` | `error` | bloc copié (paires `fichier:lignes`) ; styles seuls copiés entre deux composants de fonctionnalités : `warning` (`duplicates.styles`) |
| `names` | `warning` ; `error` pour un composant générique refait | nouveau composant dont le nom ou le rôle doublonne un composant partagé ; bloquant quand il refait, sans le composer, un composant partagé générique de la structure ou du socle (coquille, barre latérale, barre d'onglets, barre du haut, toast, liste déroulante, dialogue, sélecteur de date, pagination, onglets, icône) |
| `typography` | `warning` | heure, date, montant, nombre et unité séparés par une espace sécable, dans une langue qui l'interdit |

Chaque règle se règle en `off`, `warning` ou `error` (`reuse.severity`). Les chemins de `reuse.ignore` et les chemins ignorés par défaut sont laissés de côté par toutes les règles, **pour les fichiers qui existaient déjà à la base** (section 2.8) : dépendances (`node_modules/`), dossiers d'outils connus où qu'ils soient (`.git/`, `.svelte-kit/`, `.next/`, `.nuxt/`, `.vercel/`, `.github/`, `.apv/`...), sorties de build et code importé (`dist/`, `build/`, `coverage/`, `vendor/`) **à la racine du dépôt et à la racine de chaque paquet** (dossier qui a un `package.json`) seulement, `docs/**` où vivent les maquettes, fichiers minifiés, `*.d.ts`, le dossier `design.dir`. Un dossier caché quelconque, ou un `vendor/`, un `build/` sous `src/`, est analysé. Les fichiers de code, d'interface et de style ainsi écartés sont listés dans le rapport (`excluded`), jamais écartés en silence : ceux du changement tous (`changed`), les autres par leur total et les 20 premiers (`existing`). Les tests aussi sont laissés de côté (sauf pour la carte, qui les compte à part).

**Fichiers générés.** Un fichier écrit par un outil (types de base de données, clients d'API, schémas) répète des blocs par construction : les types Supabase (`database.types.ts`) ont des blocs `Insert` et `Update` identiques pour chaque table. Il est reconnu par son nom (`*.generated.*`, `*.gen.*`, `generated/`, `__generated__/`, `database.types.*`, `supabase.types.*` ; un `*.types.ts` écrit à la main reste analysé) ou par ses 600 premiers caractères (`@generated`, « do not edit », « auto-generated », « this file was generated », « code generated by … do not edit », « généré automatiquement », « fichier généré … ne pas modifier » ; une simple mention d'une génération ne suffit pas), **seulement si le fichier était déjà généré à la base** (même nom, ou même mention) : un fichier créé par le changement sous un nom de fichier généré (`shell.gen.css`, `src/lib/generated/format2.ts`), ou une mention ajoutée par le changement, est un constat bloquant, et le fichier reste analysé (ni un nom ni un commentaire ne sortent une copie du contrôle). Un vrai fichier généré nouveau se déclare dans `reuse.generated` (motifs de chemin), avec l'accord de l'opérateur : il est alors accepté et listé. Un fichier d'interface (`.svelte`, `.vue`, `.tsx`, `.jsx`, `.astro`, `.html`...) n'est jamais considéré comme généré. Sans base, la mention est prise telle quelle (reprise d'un projet), laissé de côté par toutes les règles et listé à part dans le rapport (`generated`), jamais compté.

### 2.3 Éléments natifs réservés (`native`)

(Voir aussi la section 2.8 : aucun fichier du changement n'échappe au contrôle par son chemin.)

`native.elements` associe à chaque élément réservé le composant partagé qui le remplace : `{ "select": "src/lib/components/ui/Select.svelte", "dialog": null }`. Un sélecteur est un nom d'élément en minuscules (`select`) ou un élément et une valeur d'attribut (`input[type=date]`, qui reconnaît aussi `type={'date'}`). `null` : l'outil cherche dans la carte un composant partagé du même rôle (liste déroulante pour `select` et `datalist`, dialogue pour `dialog`) et le nomme ; sinon le message demande d'en créer un, paramétrable, dans les dossiers partagés. Le composant proposé est toujours **générique** (son nom n'est que son rôle : `Select`, `Dialog`, `Dropdown`), celui des dossiers de primitives d'abord (`ui/Select` plutôt que `Dropdown`), jamais un composant propre à une fonctionnalité (`AddDeviceDialog`) ; sans composant générique, aucun n'est proposé. Seules les balises en minuscules du balisage comptent (`<Select>` est un composant) : commentaires, blocs `<script>` et, dans un fichier JSX, commentaires et chaînes qui ne sont pas des valeurs d'attribut sont exclus. `native.allowedPaths` (par défaut les composants partagés génériques : `**/components/ui/**`, `**/ui/**`, `**/primitives/**`, `**/design-system/**`, `**/shared/**`, `**/common/**`, jamais le dossier `components` d'une fonctionnalité) : là où ces éléments restent permis, les primitives qui les enveloppent. Le composant qui remplace un élément n'est jamais signalé pour lui-même.

### 2.4 Primitives de style (`styles`)

Les **primitives** sont les classes de base des règles de premier niveau de la feuille globale : la première classe du premier composé (`.btn`, `.btn--primary`, `.input` ; `.btn.active` et `.btn:hover` donnent `btn` seulement ; dans `@media`, `@layer`, `@supports` compris ; `@utility nom` de Tailwind 4 aussi). Une règle du document, d'un thème ou d'un état (`:root`, `html`, `body`, `[data-theme]`, `.dark`, `.light`, `.theme-*`, `.active`, `.open`, `.disabled`, `.is-*`, `.has-*`...) ou sans classe (`a:hover`) n'en donne aucune ; plus `styles.selectors` (`.pill--*` pour un préfixe), moins `styles.except`. Feuille globale : `styles.sources`, sinon celles de la liste par défaut présentes dans le dépôt (`src/app.css`, `src/app.scss`, `src/styles/global.css`, `app/globals.css`, `styles/globals.css`...), plus les feuilles du dépôt qu'elles importent par un chemin relatif (`@import './styles/buttons.css'`). Sans feuille ni sélecteur, la règle est inactive et le dit.

Les styles locaux lus : les blocs `<style>` des fichiers d'interface et les feuilles de style hors des sources et de `styles.allowedPaths` (par défaut les mêmes composants génériques que `native.allowedPaths`). Règle, simple et vérifiable à la main :
- le sélecteur est d'abord déballé (`:global(.btn)`, `:deep(.btn)`, `::v-deep`, `:is()`, `:where()` deviennent `.btn`) et les règles imbriquées aplaties (`.card { .btn {} }` donne `.card .btn`, `&.x` donne `.card.x`) ;
- une primitive dans le **premier composé** du sélecteur (`.btn`, `.btn:hover`, `.btn.mine`) est une **redéfinition** : constat ;
- une primitive seulement après un combinateur, sous une classe du composant (`.panel .btn`, `.own > .input`), est un **ajustement imbriqué**. Avec `styles.nested: "layout"` (défaut), il est accepté s'il ne déclare que de la mise en page (marges, largeur, hauteur minimale, `white-space`, alignement, ordre, placement dans une grille ou un flex, position, `display`) et refusé s'il touche l'apparence (couleur, fond, bordure, rayon, hauteur, marges internes, police, ombre...) ; `"refuse"` les refuse tous, `"allow"` les accepte tous.

Une variante manquante s'ajoute à la primitive (feuille globale) ou au composant partagé, jamais par une copie locale.

### 2.5 Code dupliqué (`duplicates`)

Détecteur de clones exacts par jetons, écrit dans l'outil : la méthode de jscpd (fenêtres de `minTokens` jetons comparées par empreinte roulante de Rabin-Karp, puis étendues tant que les deux copies restent égales), sans dépendance. Raisons de ce choix plutôt que jscpd (libre, MIT) : l'outil `apv` n'a aucune dépendance d'exécution et ne télécharge rien pendant une preuve ; le détecteur lit le contenu d'un fichier à la base commune (`git show`) pour dire si un bloc était déjà copié, ce qu'un outil externe ne fait pas ; le résultat est le même sur toutes les piles et toutes les machines.

- Jetons : identifiants, nombres, chaînes (une chaîne entre guillemets s'arrête en fin de ligne, un gabarit peut en couvrir plusieurs) et chaque autre caractère ; espaces et commentaires ignorés (`//`, `/* */`, `<!-- -->`, `#` pour Python, Ruby, YAML...). Les instructions `import` et `export ... from` (ECMAScript, Python) sont effacées : deux pages qui importent les mêmes composants ne sont pas une copie.
- Seuils : `duplicates.minTokens` (50) et `duplicates.minLines` (5, sur chacune des deux copies), comme jscpd par défaut. Une copie est ramenée aux lignes qu'elle couvre entièrement. Un opérateur (`=>`, `===`) compte pour un jeton.
- **Styles copiés** : une copie dont les deux côtés sont des styles (feuilles de style, blocs `<style>`) **d'un composant partagé générique** (dossier des primitives, ou composant partagé dont le nom n'est que son rôle : `Sidebar`, `ToastRegion`) refait l'apparence de ce composant : gravité des copies de code, bloquante. Entre deux composants propres à des fonctionnalités, elle prend `duplicates.styles`, `warning` par défaut : des déclarations répétées (`display: flex; align-items: center`) y sont souvent légitimes, et la règle `styles` bloque déjà la redéfinition d'une primitive ; `"error"` la rend bloquante. Une copie qui couvre aussi le balisage ou le script reste un bloc de code, bloquant.
- Fichiers : code, balisage et styles (`duplicates.paths` pour restreindre), tests exclus, `duplicates.ignore` en plus.
- **Nouveau** : un bloc dont l'une des copies contient une ligne ajoutée ou modifiée par le changement, sauf si la même suite de jetons existait déjà dans les deux fichiers à la base commune (un bloc seulement déplacé, ou raccourci, reste existant). Modifier les deux copies d'un bloc déjà dupliqué en fait un bloc nouveau : c'est le moment de le factoriser.
- Sortie : `fichier:début-fin` de la copie, `other` pour l'autre, nombre de lignes et de jetons. Le constat porte sur le côté que le changement ajoute ou modifie, jamais sur l'original. Un bloc copié trois fois donne deux paires, chacune avec la première copie.

### 2.6 Composants homonymes ou redondants (`names`)

S'appuie sur la carte du code (section 1). Pour chaque composant **créé** par le changement (tous sans base), comparé à chaque composant partagé, par une règle que chacun peut refaire à la main :
- **même nom** : les mêmes mots (`admin/Toast.svelte` et `ui/Toast.svelte`) ;
- **nom construit sur lui** : le nom partagé commence ou termine l'autre (`AdminToast` et `Toast`, `SelectField` et `Select`) ;
- **même rôle** : le composant partagé est générique (son nom n'est que son rôle, `Toast`, `AppShell`, `TabBar`, `ToastRegion`) et le nouveau finit par un mot de la même famille (`Snackbar` et `Toast`, `AdminLayout` et `AppShell`), ou le nouveau est une coquille (`shell`, `layout`, `frame`...) à côté d'une barre latérale, d'une barre du haut ou d'une barre d'onglets partagées. Deux composants spécifiques d'une même famille (`AddDeviceDialog`, `ConfirmDialog`) font des choses différentes : pas de constat.

Les mots d'un nom viennent de sa casse (`AdminToast` : admin, toast) ; les mots de position finaux (`Container`, `Wrapper`, `Provider`, `List`, `Item`...) sont retirés avant de lire le rôle ; un mot composé se lit joint (`TabBar` : `tabbar`). Familles par défaut : coquille, barre latérale, barre du haut, barre d'onglets, toast, dialogue, tiroir, liste déroulante, sélecteur de date, menu, bulle, bouton, icône, champ, case à cocher, onglets, carte, badge, tableau, pagination, indicateur de chargement, squelette, alerte, avatar, fil d'Ariane, accordéon, état vide (`src/reuse/config.ts`) ; `names.roles` en ajoute ou en retire. **Composition** : un composant qui importe le composant partagé, ou que celui-ci importe, s'appuie sur lui : pas de constat ; une partie (`MenuItem` et `Menu`, seuls des mots de position diffèrent) non plus. Un constat par composant, qui liste tous les partagés concernés.

**Gravité.** Un nouveau composant de la **même famille exacte** qu'un composant partagé **générique** (son nom n'est que son rôle) de la structure ou du socle (`names.strong`, par défaut `shell`, `sidebar`, `tabbar`, `topbar`, `toast`, `select`, `dialog`, `datepicker`, `pagination`, `tabs`, `icon`), qui ne le compose pas, est une copie de l'interface : gravité `names.strongSeverity`, `error` par défaut (`AdminToast` à côté de `ToastRegion`, `AdminSelect` à côté de `Select`, `DeviceModal` à côté de `Dialog`). La composition se suit d'import en import (cinq étapes au plus) : un dialogue qui importe une confirmation bâtie sur le dialogue partagé passe. Une coquille ou une mise en page face à la barre latérale, la barre d'onglets ou la barre du haut (famille large), et une partie nommée d'après un composant (`SidebarSection`, `DialogFooter`), restent des avertissements : `AdminShell` bloque par la copie des styles de `Sidebar` (section 2.5), pas par son nom. Les autres ressemblances (composant spécifique, famille hors de la liste, nom construit sur un composant non générique) gardent `severity.names`, `warning` par défaut : elles invitent à regarder, elles ne prouvent pas une copie.

### 2.7 Valeurs typographiques (`typography`)

Actif seulement pour une langue qui l'exige (`typography.locale`, détectée par `apv init` et `apv onboard` depuis le `lang` du document) : le français (`fr`, `fr-CA`...). Motifs : heure (`14 h 47`, `{h} h {m}`, `${h} h ${m}`), date (`30 septembre`), nombre et unité ou devise (`12 €`, `50 %`, `3 km`, `5 min`, `2 Go`), séparateur de milliers (`1 000`), séparés par une espace ordinaire (U+0020). Lus : les lignes de balisage des fichiers d'interface (hors `<script>`, `<style>`, commentaires, dessins `<svg>` et attributs de géométrie comme `d`, `points`, `viewBox`), et dans le code (scripts, `.ts`, `.js`, JSX, fichiers JSON de traduction sous `locales/`, `i18n/`, `messages/`, `lang/`) les seules chaînes et le texte JSX. Seules les lignes ajoutées ou modifiées sont examinées. Correction : espace insécable (U+00A0, `&nbsp;`, `\u00a0`) ou fine insécable (U+202F, `&#8239;`, `\u202f`).

### 2.8 Échec fermé : aucun fichier du changement ne sort du contrôle sans déclaration

Les relectures ont trouvé des chemins de sortie l'un après l'autre (nom de fichier généré, dossier `vendor/`, dossier d'outil, `docs/`, faux `package.json`, octet nul, fichier trop gros, liste tronquée). Le contrôle suit donc un principe d'échec fermé, règle `coverage`, toujours `error` (aucune gravité ne l'abaisse) :

0. **Le changement ne réécrit jamais ce qui le juge.** Les sections `reuse`, `map` et `design.dir` sont lues dans la configuration de la **base** (`.apv/config.json` au commit de la base commune), comme la portée des preuves le fait déjà. Si le changement les modifie, ou s'il retire ou modifie les contrôles `reuse` et `code-map`, ou retire un contrôle obligatoire (ou le rend facultatif), le contrôle le signale : constat bloquant quand le changement touche aussi du code (la configuration se change dans une PR de configuration à part, décision de l'opérateur), avertissement pour une PR qui ne change que la configuration. Un projet qui adopte APV (pas de configuration à la base) n'a pas de constat.
1. Tout fichier **créé, modifié ou déplacé** par le changement, suivi par Git, est soumis à la couverture stricte s'il est un **composant** (`.svelte`, `.vue`, `.tsx`, `.jsx`, `.astro`, et les extensions que déclare le framework, `extensions` de `svelte.config.js`, par exemple `.svx`), où qu'il soit ; ou un fichier de code, d'interface ou de style **dans un dossier de sources** (`src/`, `app/`, `lib/`, `pages/`, `components/`, `routes/`, `server/`, et ces dossiers sous `packages/*/` et `apps/*/`) **ou chargé par l'application** (graphe suivi de fichier en fichier, cinq étapes : imports ES, `import.meta.glob` et `globEager`, `require.context`, `@import` et `url()` des feuilles de style) ; et tout fichier de code ou de style **créé ou modifié dans `vendor/`, `dist/`, `build/` ou `coverage/`**, sans exception pour ce qui y était déjà. Seules exceptions : un motif de `reuse.ignore` ou de `reuse.generated` **déclaré** dans la configuration de la base (jamais par défaut), une maquette validée enregistrée au registre **de la base** (empreinte conforme), ou un fichier déjà exclu à la base sous le même chemin. Un script de CI (`.github/`) ou une page de documentation qui n'est pas un composant n'est pas soumis à la couverture stricte : écarté s'il est dans une exclusion par défaut, et listé.
2. Les exclusions par défaut (dépendances, dossiers d'outils, sorties de build, `vendor/`, `docs/`) ne valent que pour les fichiers qui existaient à la base. Un fichier de la couverture stricte que le changement crée ou déplace là est analysé **et** produit un constat bloquant : « fichier dans un dossier exclu par défaut : le déclarer dans reuse.ignore ou le déplacer ».
3. Un fichier du changement qu'on ne peut pas lire comme texte (octet nul, plus de 2 Mo, encodage autre que l'UTF-8) produit un constat bloquant, jamais un saut silencieux.
4. Un `package.json` ajouté par le changement ne crée pas de racine de paquet pour ce changement (ses `dist/` et `build/` restent analysés).
5. La liste des fichiers écartés n'est jamais tronquée pour les fichiers du changement (`excluded.changed`, sortie texte comprise), avec la raison de chacun (`excluded.why`) : « déclaré dans reuse.ignore », « déjà exclu à la base au même chemin », « maquette validée du registre de la base », « écarté : ni composant, ni source, ni importé par l'application ». Seuls les fichiers existants sont résumés (total et 20 premiers). Une PR qui change la configuration n'est « de configuration seule » que si elle ne touche aucun fichier de code, d'interface ou de style, même écarté.
6. Un fichier du changement qui importe un fichier d'une extension que le contrôle ne lit pas (ni code, ni interface, ni style, ni donnée connue) produit un avertissement : déclarer l'extension au framework.
7. Un **lien symbolique** ou un **sous-module** ajouté par le changement (mode 120000 ou 160000, commité, indexé ou non suivi) produit un constat bloquant, sauf déclaration dans `reuse.ignore` de la base : son contenu n'est jamais lu ici.

**Contrôles de la base** (3.0.0-alpha.10) : `apv gates run` et `apv gates verify` lisent aussi la liste des contrôles de la base ; un contrôle `reuse` ou `code-map` retiré par le candidat reste exigé avec sa définition de base ([CLI.md](CLI.md#contrôles-de-la-base)).

Un nouveau fichier `.svelte`, quel que soit son chemin (`node_modules/`, `dist/`, `.github/`, `docs/`, `generated/`...), est donc analysé ou bloque.

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
    "styles": { "sources": ["src/app.css"], "selectors": [".pill--*"], "except": [".sr-only"], "allowedPaths": ["src/lib/components/ui/**"], "nested": "layout" },
    "duplicates": { "minLines": 5, "minTokens": 50, "styles": "warning", "ignore": ["src/lib/legacy/**"] },
    "names": { "roles": { "feed": ["feed", "timeline"], "badge": null } },
    "typography": { "locale": "fr" },
    "severity": { "names": "warning", "typography": "warning" }
  },
  "map": { "file": ".apv/code-map.md", "ignore": ["scripts/**"], "maxEntries": 400, "maxBytes": 32768 }
}
```

- `reference` : branche de référence (lettres, chiffres, `.`, `_`, `/`, `-`). Absente : `--base`, sinon tout compte comme nouveau.
- `generated` : motifs des fichiers écrits par un outil, acceptés comme générés même quand le changement les crée ; jamais un fichier d'interface.
- `ignore` : seule façon, avec `generated`, de sortir du contrôle un fichier que le changement crée ou modifie (section 2.8).
- `shared` : motifs (`*`, `**`, `?`, `{a,b}`) des dossiers de composants partagés ; défaut `**/components/**`, `**/ui/**`, `**/shared/**`, `**/common/**`.
- `ignore`, `native.allowedPaths`, `styles.sources`, `styles.allowedPaths`, `duplicates.paths`, `duplicates.ignore`, `map.ignore` : motifs relatifs au dépôt (un chemin absolu ou qui sort du dépôt est refusé).
- `native.elements` : 50 éléments au plus ; valeur `null` ou chemin du composant partagé.
- `styles.selectors`, `styles.except` : classes (`.btn`) ou préfixes (`.btn--*`).
- `duplicates.minLines` de 2 à 1000, `minTokens` de 10 à 10000, `styles` (`off`, `warning`, `error`) pour les copies de styles seuls.
- `styles.nested` : `layout` (défaut), `refuse` ou `allow`.
- `names.roles` : familles en kebab-case, mots en minuscules sans séparateur ; `null` retire une famille par défaut. `names.strong` : familles dont le composant générique ne se refait jamais ; `names.strongSeverity` (`error` par défaut).
- `typography.locale` : étiquette de langue (`fr`, `fr-CA`).
- `severity` : `off`, `warning` ou `error`, pour toutes les règles ou par règle.
- `map.file` : chemin `.md` relatif (défaut `.apv/code-map.md`) ; `map.maxEntries` de 20 à 5000 ; `map.maxBytes` de 4096 à 1 000 000 (défaut 32 768).

## 4. Intégration à la preuve

`apv init` et `apv onboard` ajoutent, quand ils créent la configuration :

```json
{ "id": "reuse", "command": ["apv", "reuse", "check", "--base", "{{baseSha}}"], "covers": ["architecture"], "stage": "task", "readOnly": true, "mandatory": true },
{ "id": "code-map", "command": ["apv", "map", "--check"], "covers": ["architecture"], "stage": "full", "readOnly": true, "mandatory": true }
```

`reuse` est à l'étape `task` : il tourne après chaque tâche et dans la suite complète (qui exécute aussi les contrôles de tâche), avec ses reçus comme les autres (`apv gates run`, `apv gates verify`). Il compte ce qui est nouveau depuis `{{baseSha}}`, la base du passage : `apv gates run` exige donc `--base` (ce que font déjà `/apv:run`, l'implementer et la livraison), et la base entre dans la clé de preuve. `code-map` est à l'étape `full` : la carte n'est régénérée qu'à l'intégration, et la suite complète la vérifie. Les deux sont en lecture seule.

`apv` doit être sur le `PATH` (plugin activé, son exécutable `bin/apv`, ou `npm link`) : `apv init` et `apv onboard` le vérifient et avertissent sinon (`reuse.apvOnPath` en JSON) ; la forme `["node", "<chemin du plugin>/dist/cli.js", "reuse", "check", "--base", "{{baseSha}}"]` marche partout mais inscrit un chemin propre à la machine dans la configuration.

Un contrôle `reuse` rouge se corrige en réutilisant ou en factorisant ; jamais en baissant une gravité, en élargissant `reuse.ignore` ou `allowedPaths`, ni en retirant le contrôle : ces changements de `.apv/config.json` sont des décisions de l'opérateur.

## 5. Adopter sur un projet existant

1. `apv onboard --dry-run`, puis `apv onboard` : la section `reuse` détectée (dossiers partagés : les plus hauts dossiers `components`, `ui`, `shared`, `common`, `widgets`, `primitives`... qui contiennent des composants, hors des dossiers de routes ; dossier des primitives `ui` ou `primitives`, seul chemin permis aux éléments natifs et aux primitives de style ; composant générique qui remplace chaque élément réservé ; langue ; branche de référence `origin/HEAD`, sinon `origin/main` ou `origin/master`, jamais la branche courante : sans dépôt distant, à déclarer), les deux contrôles, la carte du code, et la liste de ce qui est **déjà** dupliqué ou refait (20 premiers constats, blocs copiés d'abord ; `apv reuse check --all` pour tout).
2. Relire avec l'opérateur `shared`, `native.elements`, `reference` (compétence `/apv:onboard`, étape 4 bis). Le contrôle déclaré compte depuis la base de chaque passage (`{{baseSha}}`) ; `reference` sert à `apv reuse check` lancé à la main sans `--base` (sans elle, tout y compte comme nouveau).
3. Commiter `.apv/` (configuration et carte). Les constats existants ne bloquent pas ; les résorber est une spec de rangement à part, décidée par l'opérateur. Chaque PR suivante ne peut plus en ajouter.

Un projet qui a déjà `.apv/config.json` ne reçoit rien automatiquement (aucun fichier n'est jamais écrasé) : ajouter les deux contrôles et la section à la main, puis `apv map`.

## 6. Limites connues

- Clones exacts seulement (espaces et commentaires ignorés) : une copie dont on a renommé les identifiants n'est pas vue ; la règle des noms et la relecture restent le filet.
- Un bloc rendu identique par une simple suppression de lignes n'est pas compté comme nouveau.
- La règle des noms repose sur des mots anglais usuels des noms de composants ; des noms dans une autre langue demandent `names.roles`.
- Les styles écrits en JavaScript (CSS-in-JS) ne sont pas analysés par la règle `styles` ; leurs copies restent vues par `duplicates`.
- Les usages de la carte ne sont calculés que pour les imports ECMAScript et Python. La requête d'un import (`./a.css?inline`, `./icon.svg?raw`, `?url`) est retirée avant de le résoudre.
- Un import à chemin **calculé** (`import(\`./pages/${name}.ts\`)`, `require(base + nom)`, un chemin lu dans une variable ou une configuration) ne se résout pas sans exécuter le code : le fichier qu'il charge n'est tenu par la couverture stricte que s'il est un composant, dans un dossier de sources, ou chargé autrement (import statique, `import.meta.glob`, `require.context`). Un tel fichier hors de ces cas, dans une exclusion par défaut, est écarté et listé (« ni composant, ni source, ni importé ») ; le déclarer ou le déplacer sous les sources le fait tenir.
- La typographie ne connaît que le français.
- Tout le dépôt est analysé à chaque passage (quelques secondes pour quelques milliers de fichiers) ; `duplicates.paths` le restreint si besoin.
- Un fichier généré qui ne le dit ni par son nom ni par ses premières lignes est analysé comme du code : l'ajouter à `reuse.ignore`, avec l'accord de l'opérateur.
- La règle `styles` ne lit pas les classes appliquées par `@apply` : un ajustement qui en contient compte comme une retouche de l'apparence, refusée en mode `layout`.
