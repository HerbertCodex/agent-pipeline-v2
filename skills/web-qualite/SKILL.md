---
name: web-qualite
description: "Qualité mesurable d'un site livré par APV : quand et comment lancer apv web audit (Lighthouse médian en mobile et bureau sur les pages publiques, seuils de la section web, contrôles de préparation à la recherche et aux IA), lire les rapports, écarter une mesure faussée, prioriser les corrections par gain, sans jamais promettre un classement Google ni une citation par une IA. À utiliser par le chef de projet avant une PR qui touche l'interface publique et après chaque déploiement, par l'agent auditeur-web et par tout implementer qui corrige un constat de qualité web."
---

# Qualité web mesurable

On mesure ce que le projet contrôle : vitesse perçue, stabilité, accessibilité, bonnes pratiques, balises lues par les moteurs et les IA. On ne promet jamais un classement, une indexation, un trafic ni une citation par une IA : ces décisions appartiennent aux moteurs. Un rapport dit « mesuré à … le … », jamais « le site est premier sur … ».

Dans ce document, `apv` désigne `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` (ou `apv` s'il est sur le PATH). Référence complète : `${CLAUDE_PLUGIN_ROOT}/docs/CLI.md` (`apv web audit`) et `${CLAUDE_PLUGIN_ROOT}/docs/CONFIGURATION.md` (« Qualité web : `web` »).

## 1. Pourquoi jamais à la main
Lighthouse lancé dans DevTools mesure l'onglet tel qu'il est : onglet en arrière-plan, extensions, cache, machine chargée. Résultat typique : un faux 0 partout (`NO_FCP`, onglet caché) ou une performance fausse de 20 points. `apv web audit` lance Lighthouse en Chrome sans interface, version épinglée, N passages dont il garde la médiane, sous la file des suites et sous un seuil de charge, et **écarte toute mesure invalide** (erreur Lighthouse, avertissement de mesure, statut HTTP autre que 200, redirection, score absent) au lieu de la compter. Un chiffre qui ne sort pas de cette commande ne sert pas de preuve.

## 2. Quand lancer l'audit
- **PR qui touche l'interface publique** : le contrôle déclaré dans `gates` (par exemple `{ "id": "web", "stage": "full", "command": ["apv", "web", "audit", "--preview", "--base", "origin/main"], "timeoutMs": 2400000 }`) tourne dans la suite complète ; il audite l'aperçu local sur le commit exact, seulement si un fichier qui répond à `web.paths` a changé depuis la base, et l'arrête à la fin. Hors suite : `apv web audit --preview --base <base de la PR>`.
- **Après chaque fusion déployée** : `apv web audit --production` (l'origine `web.productionUrl`, lecture seule) une fois le déploiement en ligne. Résultat noté dans le journal du pipeline et annoncé à l'opérateur avec le lien des rapports.
- **Sur demande de l'opérateur**, ou quand il cite un score obtenu à la main : relance la mesure fiable avant d'en discuter.
- Jamais pendant une vague chargée : la commande attend la file des suites et une charge sous `web.load.max` (sinon `suite.queue.maxLoad`, sinon la moitié des processeurs) ; au-delà de `web.load.waitMs`, elle refuse (`WEB_LOAD`). Un refus pour charge se relance plus tard, il ne se contourne pas en baissant le seuil.

## 3. Lire le résultat
- Tableau : une ligne par page et appareil, médiane des passages valides ; `!` marque un seuil manqué. Sortie `1` dès qu'un seuil manque, qu'une mesure est invalide ou qu'un contrôle de préparation en mode `refuse` échoue.
- « passage N écarté : … » : la raison exacte (par exemple `NO_FCP`, statut 404, redirection). Un passage écarté est refait, au plus N fois de plus ; une page qui reste invalide est un constat à corriger (page absente, redirection non déclarée, erreur de rendu), jamais un score.
- « Principales opportunités » : les trois audits Lighthouse qui coûtent le plus (gain estimé par métrique, octets, points perdus), lus sur le passage médian. Le rapport HTML complet est dans `web.reportsDir` (`.apv/web/<audit>/`, ignoré par Git) avec `summary.json`.
- « Préparation à la recherche et aux IA » : statut 200, robots.txt (page ouverte aux moteurs et aux robots de recherche des IA de `web.robotsAgents`, pas de `noindex`), sitemap déclaré qui liste la page, canonical unique et absolue vers la page, title et description présents et uniques, `lang`, JSON-LD analysable (`@context`, `@type`), hreflang cohérent, `llms.txt` si le projet l'attend. Ces contrôles lisent le HTML servi, celui que lisent les robots qui n'exécutent pas de script.

## 4. Prioriser les corrections
Dans cet ordre, une correction à la fois, chacune prouvée par un nouvel audit :
1. **Mesure invalide et refus de préparation** : une page en 404 ou redirigée, une page publique en `noindex` ou interdite par robots.txt, un canonical faux annulent tout le reste.
2. **Accessibilité sous 100** : chaque audit en échec est un défaut réel pour une personne (contraste, nom accessible, ordre des titres, `lang`).
3. **Métriques de chargement** (LCP, CLS, TBT) : image principale dimensionnée, prioritaire (`fetchpriority="high"`, jamais `loading="lazy"` au-dessus de la ligne de flottaison) et au bon format ; polices préchargées avec `font-display` adapté et dimensions réservées (CLS) ; CSS critique, scripts différés, JavaScript inutilisé retiré ; travail du fil principal réduit.
4. **Bonnes pratiques et SEO** : erreurs de console, en-têtes de sécurité, balises uniques et descriptives, données structurées fidèles au contenu visible.
5. **Navigation par agent** (`agentic-browsing`) : structure sémantique, noms accessibles, formulaires étiquetés : ce qui aide un lecteur d'écran aide un agent.

Règles :
- Un seuil ne se baisse que sur décision de l'opérateur, notée au registre des décisions ; jamais pour faire passer une PR.
- Pas de contenu caché aux personnes et montré aux robots, pas de données structurées qui décrivent autre chose que la page, pas de mots-clés ajoutés pour le robot : ce qui trompe un moteur finit par pénaliser le site.
- Une correction de performance n'est `prouve` qu'avec l'audit avant et après (médianes, même appareil, même charge) ; un seul passage ne prouve rien.
- Textes proposés sans tiret cadratin ni demi-cadratin, sans promesse risquée.

## 5. Ce que l'audit ne dit pas
Il ne mesure ni les données de terrain (visiteurs réels, CrUX), ni la popularité, ni la qualité éditoriale, ni le classement. Il ne lit que l'origine auditée (Lighthouse charge aussi les ressources tierces que la page appelle). Dis-le quand l'opérateur demande « est-ce qu'on sera bien classé ».
