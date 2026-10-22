# Une seule suite complète, à la mise en ligne (4.0.0-alpha.6)

Origine : projet pilote Toujours rien, 20 octobre 2026 (alpha.5, « une suite complète par PR »), puis décision de l'opérateur du
22 octobre 2026 : « Une seule suite complète, à la mise en ligne sur main ; plus de suite de branche à reprendre. » Capacité
générique d'APV, pas un correctif propre au projet. Règle de la refonte APV4 : enlever plutôt qu'ajouter.

## Constat

L'alpha.5 demandait une suite complète sur chaque branche (`apv gates run --stage full --fresh-copy`) pour que la mise en ligne la
reprenne. Elle ne la reprenait que dans le même environnement (même `PATH`, même `LANG`, même pile, même copie) : sinon tout était
relancé, et la PR avait payé deux suites. Trop de réglages (`normalizeEnv`, crédit de répétition, copie neuve de branche) pour un
gain fragile, et une PR qui attendait sa propre suite avant de fusionner.

## Le flux

1. **PR** : contrôles de tâche (`apv gates run --stage task --base <base>`), tests ciblés (`affected`), relectures du niveau de
   risque. La règle `preuve` de `apv rules check` et de `apv stack merge` (section `release` déclarée, mode léger) se contente de la
   preuve de tâche au commit exact. Aucune suite complète sur la branche.
2. **Fusion** sur ordre de l'opérateur, comme avant.
3. **Mise en ligne** : `APV_ALLOW_MERGE=1 apv release auto` (cron), sur la tête de `main`, lance **la** suite complète, une fois,
   dans la copie neuve de l'arbre (`<répertoire git commun>/apv/fresh/<arbre>`, préparée par `batch.setup`), avec la répétition de
   **chaque** test modifié depuis la production. Verte, la branche de production avance en avance rapide ; rouge, elle ne bouge pas.

## Ce qui est retiré (alpha.5 vers alpha.6)

- `apv gates run --stage full --fresh-copy` (appel incorrect désormais). La copie neuve de la mise en ligne reste, seule.
- `stacks[].normalizeEnv` : le chargeur refuse la clé et dit « normalizeEnv retiré en alpha.6 : supprimer la clé ».
- Le crédit de répétition (`repeat.credited`, `src/gates/repeat-credit.ts`) : sans suite de branche, aucun test n'a été répété avant.
  Un reçu d'alpha.5 qui porte `repeat.credited` n'est plus lisible : il est ignoré et la suite se relance.

## Ce qui reste

- **Reprise à arbre identique** dans la mise en ligne : un contrôle dont un reçu vert du même arbre se vérifie (premier passage,
  arbre propre, même configuration, même environnement, moins de 20 h, aucun échec plus récent) n'est pas relancé. Utile seulement
  pour une mise en ligne relancée au même arbre (panne du push, migration confirmée après coup). Le journal (`reused`) dit
  quel reçu a été repris.
- **`identityParts`** : chaque reçu exécuté porte une empreinte par partie de son identité ; quand rien n'est repris, la sortie
  nomme ce qui diffère (« différent de <exécution> : variable(s) PATH, LANG »). Jamais des valeurs.
- **Jugement des tests instables** (partie 3, inchangé).
- Jamais de publication sans suite verte au même arbre (exécutée ou reprise et vérifiée) ; reçus vérifiés depuis Git et le magasin
  partagé ; contrôles de la production gardés ; confirmation des migrations par l'opérateur ; fusion et mise en ligne sur ordre
  (`APV_ALLOW_MERGE=1`) ; une suite rouge n'est jamais relancée au même commit.

## 3. Un test instable sans rapport ne bloque plus la production

Un contrôle réussi seulement après la relance de ses tests en échec (`passed_after_retry`) à la mise en ligne : chaque test relancé
est jugé. Il est **sans rapport** quand :

- son nom donne son fichier (un chemin du commit, ou le seul fichier dont il est la fin : `a.spec.ts:12:5 › …`) ;
- ce fichier n'est ni ajouté ni modifié depuis la production ;
- il n'est pas dans la liste des tests concernés par le changement : la commande `affectedList` du contrôle, **lue à la
  production**, lancée dans la copie neuve avec `{{baseSha}}` = la production (même calcul que `affected`, voir la partie 4 pour
  des tests e2e) ; tout chemin du commit dans sa sortie compte.

Alors la mise en ligne continue, et le test est écrit comme **constat** : sortie, journal (`stack.log`, champ `unstable` : contrôle,
test, fichiers, « échoue 1 fois sur 2 passages », exécution) et suivi (`.apv/state/suivi-constats.md`, section « Tests instables à
la mise en ligne »), pour une correction à part.

Restent bloquants : un test ajouté ou modifié, ou concerné par le changement ; un nom sans fichier, un contrôle sans
`affectedList` à la production (une PR ne s'en sert jamais pour elle-même), une liste en échec ; tout échec que la relance n'a pas
guéri ; toute répétition en échec ; toute migration non confirmée (`release.migrations`) ; une preuve instable et incomplète
(jamais relancée au même commit).

Limite : `retryFailed.testPattern` doit nommer **chaque** test en échec de la première passe ; un test qu'il ne nomme pas n'est pas
jugé. Relire le motif avec le format du rapporteur (Playwright `list` ou `line`).

### 3.1 Dérogation de l'opérateur à la mise en ligne (4.0.0-alpha.7)

Ce qui bloque ci-dessus sur un contrôle **vert à la relance** (`passed_after_retry`), seul l'opérateur le lève, en tapant lui-même
la phrase de la fusion pour le **commit exact publié** : `dérogation instable <12 premiers caractères du commit au moins> : <raison>`
(décision du 22 octobre 2026, PR #291 du projet pilote). Lue dans le journal signé de l'opérateur, comme à la fusion (`waiverFor`) ;
la passe suivante du cron publie sans nouveau commit. Chaque test est écrit comme constat avec la date et la raison (sortie, journal
`stack.log` champ `waived`, suivi). La phrase est la ligne entière : un refus, une question ou une citation qui la contient ne vaut rien ; clé d'ancrage absente ou refusée : le refus le dit. Pour un autre commit, sans raison ou au gabarit : rien. Jamais un échec non guéri, une répétition
en échec, une migration non confirmée, une preuve incomplète, ni une copie occupée.

## 4. Tests ciblés et e2e : ce que le graphe d'imports ne voit pas

Demande du projet pilote. `--only-changed` (Playwright, Vitest `--changed`) suit les **imports** : un test est concerné s'il importe,
de proche en proche, un fichier changé. Il ne voit pas :

- **l'application servie** : une route, un composant, une migration, une configuration que le serveur de test charge et que le test
  n'importe jamais (il l'atteint par le navigateur ou par HTTP) ;
- **les fichiers lus sans import** : `readFileSync`, `fetch` d'un fichier statique, contenu Markdown, fixtures chargées par chemin ;
- **les modules que la configuration Playwright importe** pour ses serveurs (`playwright.config.ts`, `webServer`, `globalSetup`) :
  ils ne sont dans le graphe d'aucun test.

**Règle modèle** pour `affected` et `affectedList` :

| Ce qui change depuis la base | Tests lancés |
|---|---|
| Seulement du code qui n'agit que par import : tests hors support, tests unitaires, modules importés par eux | le graphe d'imports (`--only-changed`) |
| L'application servie (routes, composants, styles, migrations, configuration du serveur ou de Playwright, fichiers lus sans import) | au minimum les tests qui vérifient **ce qui est servi** : captures d'écran, budget JavaScript du bundle ; et sinon (pas de tels tests, doute) tous les tests |

Le graphe ne réduit donc la liste que dans la première ligne ; dès que l'application servie change, il n'est plus un filtre sûr.

Cette règle se met dans **un script du projet**, appelé par les deux commandes pour que le calcul soit le même, `affectedList`
ajoutant `--list` :

```json
"affected":     ["npm", "run", "test:e2e:changed", "--", "{{baseSha}}", "--project=browser"],
"affectedList": ["npm", "run", "test:e2e:changed", "--", "{{baseSha}}", "--project=browser", "--list"]
```

`test:e2e:changed` lit `git diff --name-only <base>...HEAD`. Si un fichier servi en fait partie (`src/routes/**`, `src/lib/**`,
`supabase/migrations/**`, `static/**`, `svelte.config.*`, `vite.config.*`, `playwright.config.*` et ce qu'elle importe), il lance
`playwright test <captures> <budget>` (ou tous les tests si cette liste ne suffit pas). Sinon : `playwright test --only-changed=<base>`.
Un `affectedList` réduit à `--only-changed {{baseSha}}` seul serait trompeur pour des tests e2e : un test de captures instable
passerait pour « sans rapport » alors que le changement touchait l'application servie, sans que le graphe le voie.

## 5. Audit des dépendances : hors du chemin bloquant de chaque suite

Un audit (`npm audit`, `pnpm audit`, `osv-scanner`…) lit le réseau : une panne du registre ne doit pas bloquer toutes les PR et
toutes les mises en ligne. Il est donc **requis seulement quand les dépendances changent**, et complété par un audit quotidien à part.

**`skipWhenOnly` ne le permet pas.** Il dispense un contrôle quand **tous** les fichiers changés sont « sans effet » (`paths`, moins
`except`) ; `package.json`, les verrous (`ALWAYS_REQUIRED`) et tout fichier de code le rendent requis, et le chargeur refuse un
`paths` qui couvre du code source (`src/**`, `**`). C'est la dispense d'une PR de documentation, pas l'inverse. Il est de plus
refusé sur une commande qui lance `apv web audit`.

**Configuration proposée** (avec ce qui existe : `{{baseSha}}`, `reuse: false`) : un contrôle de stage task dont la commande décide
elle-même, d'après la base, s'il y a quelque chose à auditer.

```json
{
  "id": "audit-dependances",
  "stage": "task",
  "command": ["node", "scripts/audit-si-dependances.mjs", "{{baseSha}}"],
  "covers": ["security"],
  "reuse": false,
  "timeoutMs": 300000
}
```

```js
// scripts/audit-si-dependances.mjs <base> : audit seulement si les dépendances ont changé depuis la base.
import { execFileSync, spawnSync } from 'node:child_process';
const changed = execFileSync('git', ['diff', '--name-only', `${process.argv[2]}...HEAD`], { encoding: 'utf8' }).split('\n');
if (!changed.some(f => /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(f))) {
  console.log('Dépendances inchangées depuis la base : audit non requis.');
  process.exit(0);
}
process.exit(spawnSync('npm', ['audit', '--audit-level=high'], { stdio: 'inherit' }).status ?? 1);
```

Il marche aux trois endroits : aux **contrôles de tâche** (`--base origin/main` : le diff se compte depuis la base commune), à la
**mise en ligne** (`apv release auto` passe la production comme base : l'audit tourne si les dépendances ont changé depuis elle,
même par plusieurs PR) et à la vérification des reçus (`apv gates verify --stage task`). `reuse: false` parce qu'un audit caché dans
un script n'est pas reconnu comme audit réseau : sans lui, un reçu vert du même arbre serait repris malgré une nouvelle alerte. Si le
registre est en panne alors que les dépendances changent, le contrôle échoue : c'est voulu, et c'est le seul cas.

**Audit quotidien à part** (cron du projet, hors APV) : `npm audit --json` sur `main`, jamais bloquant ; chaque alerte haute ou
critique est écrite une fois (dédoublonnée par identifiant d'avis) dans `.apv/state/suivi-constats.md`, sous un titre « Alertes de
dépendances », que le chef de projet lit à chaque reprise. Ce fichier est local, jamais publié ; une alerte nouvelle se corrige par
une PR de dépendances, qui passe alors par le contrôle ci-dessus.

## Critères d'acceptation et tests

`test/une-suite-par-pr.test.mjs` : deux PR fusionnées, une suite à la mise en ligne qui répète tous les tests modifiés (aucun
crédit) ; une PR sans suite de branche publiée par `apv release auto` ; appels retirés (`--fresh-copy` refusé, `normalizeEnv` avec son
message) ; jugement des tests instables (constat écrit ; refus : test concerné, `affectedList` absent à la production ou ajouté par le
changement, nom sans fichier, test modifié, répétition 1 fois sur 5) ; migration en attente ; chargeur (`affectedList`) ; `pathsIn` ;
contrôle d'audit conditionnel aux contrôles de tâche et à la mise en ligne. `test/release.test.mjs` : reprise au même environnement,
relance dans un autre (variable nommée).

## Côté projet

1. Monter APV en 4.0.0-alpha.6 ; retirer `normalizeEnv` de `.apv/config.json` ; ne plus lancer `--fresh-copy`.
2. Chaque PR : contrôles de tâche, tests ciblés, relectures du niveau de risque, puis fusion sur ordre.
3. Le cron garde `APV_ALLOW_MERGE=1 apv release auto`.
4. `affectedList` n'agit qu'une fois présent **à la production** : la première mise en ligne après son ajout juge encore tout test
   instable bloquant.
5. Écrire `test:e2e:changed` selon la partie 4, et remplacer l'audit des dépendances de la suite complète par le contrôle de la
   partie 5 plus l'audit quotidien.
