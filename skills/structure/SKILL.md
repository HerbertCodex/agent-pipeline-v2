---
name: structure
description: "Arborescence d'un projet sous APV : relire les constats de apv structure check (dossiers à plat découpés par usage, préfixes répétés, rôles mêlés, fichiers égarés, fichiers ajoutés à un dossier à plat, carte de l'architecture incomplète), juger le découpage proposé selon les conventions de la pile, préparer un plan de rangement à faire valider par l'opérateur, tenir la carte de l'architecture. À utiliser par l'architecte quand il place des fichiers, par le chef de projet à l'initialisation, à la reprise d'un projet et au rapport de vague, par les relecteurs qui voient un nouveau dossier, et par tout implementer bloqué par le contrôle structure."
---

# Arborescence et carte de l'architecture

Un nouveau développeur, humain ou agent, doit comprendre où va quoi en cinq minutes, avec des conventions qu'il connaît déjà. L'outil propose, l'opérateur décide, personne ne range en douce.

Dans ce document, `apv` désigne `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` (ou `apv` s'il est sur le PATH). Référence : `${CLAUDE_PLUGIN_ROOT}/docs/STRUCTURE.md`, `${CLAUDE_PLUGIN_ROOT}/docs/CLI.md` (`apv structure check`, `apv structure map`) et `${CLAUDE_PLUGIN_ROOT}/docs/CONFIGURATION.md` (« Arborescence »).

## 1. Ce que l'outil fait, ce qu'il ne fait pas
- `apv structure check [--path <dossier>]` : analyse déterministe. Pour un dossier à plat (plus de `structure.maxFlatFiles` fichiers de code, 12 par défaut), un découpage par usage : le socle (fichiers que tout le dossier importe, ou le modèle par son nom) reste à la racine ; les autres sont groupés par qui les importe (routes, dossiers de composants, fichiers importés ensemble), par liens d'import et par les mots des noms et des exports ; chaque groupe a un nom repris du vocabulaire du projet (sous-dossier existant, même découpage que le dossier miroir `components/<domaine>/`, module principal, mot commun, domaine déclaré), ses raisons et la convention suivie (profil de la pile, avec le lien de sa documentation officielle). Plan `ancien -> nouveau`, tests et fichiers compagnons compris.
- `apv structure check --base {{baseSha}}` (contrôle `structure`, étape tâche, écrit par `apv init` et `apv onboard`) : un fichier de code ajouté à un dossier à plat, ou qui en fait un, bloque et nomme le sous-dossier où le mettre ; un dossier de premier ou deuxième niveau, une route principale ou un point d'entrée ajouté sans rôle dans la carte de l'architecture bloque ; un lien de la carte cassé par le changement bloque. L'existant est signalé sans bloquer. Un déplacement qui vide un dossier à plat dans ses sous-dossiers est toujours accepté. La configuration lue est celle de la base : relever le seuil dans le changement ne sert à rien.
- Le plan n'est **jamais appliqué par l'outil**. Le découpage proposé est un point de départ, pas une décision.

## 2. Juger une proposition (avant de la montrer)
Pour chaque groupe, réponds par écrit :
1. **Un développeur qui connaît la pile s'y retrouverait-il sans explication ?** Le nom dit une fonctionnalité (`checkout`, `sheet`, `quick-add`), pas une technique ni un composant pris au hasard (`event-icon`, `links`). L'outil ne nomme un groupe que par le vocabulaire du projet (dossiers, routes, domaines) ; un groupe « à nommer par l'opérateur » attend un nom de fonctionnalité, jamais celui d'un de ses fichiers. Un dossier de primitives (`components/ui`) ne se découpe pas : liste à plat, ou un dossier par composant.
2. **Même découpage partout ?** Si `components/<domaine>/` a déjà `sheet/` et `quick-add/`, le code métier du domaine suit ces noms. L'inverse aussi : un groupe proposé pour `lib/<domaine>/` s'applique à ses composants.
3. **Le socle reste-t-il lisible ?** Racine = modèle et utilitaires du domaine (`model.ts`, `vocabulary.ts`, `dates.ts`), cinq à huit fichiers au plus.
4. **Convention de la pile respectée ?** Pour SvelteKit : routes et fichiers colocalisés dans `src/routes`, code partagé dans `$lib`, code serveur seulement dans `$lib/server` (jamais importé par le navigateur), composants génériques dans `components/ui`, composants de fonctionnalité dans `components/<fonctionnalité>`. Autres piles : profil de `src/structure/profiles.ts` (Next.js, Nuxt, Astro, Angular, Vue, React, Python, Go).
5. **Fichiers « restent en place »** : propose toi-même leur place, ou dis pourquoi ils restent à la racine.
Corrige les noms ou les groupes quand ta réponse est non, et dis-le : « proposé par l'outil : X ; retenu : Y, parce que … ».

## 3. Préparer un plan de rangement
Un rangement est une **spec à part**, jamais glissé dans une spec de fonctionnalité :
- tableau par dossier : groupe, fichiers, raison, convention, nom retenu et écart avec la proposition de l'outil ;
- une tâche par dossier ou par domaine (tâches parallèles possibles si elles ne touchent pas les mêmes fichiers), `git mv` pour garder l'historique, imports, configuration des outils et documentation mis à jour, **sans changement de comportement** ; tests existants verts avant et après ;
- ordre : le code métier d'abord (`lib/<domaine>`), puis ses composants qui suivent le même découpage ;
- la carte de l'architecture mise à jour dans la même PR (rôle de chaque nouveau dossier).
Montre le plan à l'opérateur et attends sa validation : c'est sa décision (noms, périmètre, moment). Aucune question avant la fin quand la délégation le dit : le plan attend alors dans le rapport.

## 4. Carte de l'architecture
Fichier court et versionné (`structure.architectureMap`, par défaut `docs/carte-architecture.md`), à lire en premier par tous, puis la carte du code `.apv/code-map.md` :
- parties **générées** (arborescence des dossiers de premier et deuxième niveau avec leur convention, points d'entrée, routes principales, liens) : `apv map` ou `apv structure map` les réécrit ; ne les modifie pas à la main ;
- parties **écrites** entre marqueurs `apv:ecrit` (en bref, couches et flux en mermaid, règles transverses, rôles) : jamais réécrites par l'outil. Un rôle tient en une ligne : `- \`src/lib/applications/\` : code métier des candidatures (modèle, relances, fiche)`. Un motif `*` décrit plusieurs dossiers ;
- à l'initialisation ou à la reprise : relis avec l'opérateur le brouillon du schéma des couches et les rôles pré-remplis par la pile, complète les rôles « à décrire » des dossiers que tu comprends (d'après le code, jamais inventés), laisse les autres pour l'opérateur ;
- une tâche qui crée un dossier, une route principale ou un point d'entrée écrit son rôle dans la même tâche : sinon le contrôle `structure` bloque.

## 5. Au rapport de vague et à la relecture
- Rapport de vague : pour chaque tâche, le champ `placement` (chaque fichier de code créé, son dossier et la raison) ; les constats `structure` existants restent des risques listés, les nouveaux sont corrigés avant l'intégration.
- Relecture : un fichier ajouté à un dossier à plat, un nouveau dossier sans rôle, un nom de dossier qui ne suit ni la convention de la pile ni le vocabulaire du projet sont des constats de la revue, avec le sous-dossier ou le rôle attendu.

## Interdits
- Relever `structure.maxFlatFiles`, passer une gravité en `warning` ou élargir `structure.ignore` pour faire passer un changement : décision de l'opérateur, PR de configuration à part.
- Ranger sans plan validé, ou mêler un rangement à une fonctionnalité.
- Écrire un rôle inventé dans la carte : un rôle se lit dans le code, ou se demande.
