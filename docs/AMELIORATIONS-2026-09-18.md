# Améliorations de la pipeline — 18 septembre 2026

Ce document décrit l'implémentation qui suit [l'audit](AUDIT-2026-09-18.md). Les mesures de l'audit restent celles de l'ancienne version ; elles ne constituent pas un benchmark de ces changements.

## Ce qui change

| Problème | Comportement ajouté |
| --- | --- |
| Coûts invisibles sur les échecs et réparations | Journal `invocation.started/finished` pour Implementer, Product, Design, QA et bootstrap. Coût connu, coût inconnu et appel sans résultat sont distincts. Modèle demandé, modèles déclarés quand disponibles, effort, tokens et durée sont conservés. |
| Plafond local de 5 $ divergent des réglages | Les profils fournisseurs utilisent les mêmes défauts que le schéma. Le plafond global connu de la spec contraint chaque appel Claude, y compris les réparations et QA. Les pilotes gardent leurs propres limites explicites. |
| Product réécrit tout après un rejet | La sortie décodée est conservée avant validation. La correction reçoit le résultat précédent et le chemin de l'erreur ; les fournisseurs natifs peuvent modifier des champs par patches. Le document complet est ensuite revalidé. |
| Échec de Design après une longue spec | Un checkpoint de spec valide est enregistré avant Design. `plan-resume` réutilise cette spec ; les checkpoints de rôle sont liés au SHA et au hash du contexte. |
| Délais recommençant à chaque correction | Un rôle et ses réparations partagent une échéance. Product et Design consomment désormais le temps total de la spec ; une récupération comptabilise prudemment l'intervalle du crash. |
| Agent occupant tout le temps disponible | `validationReserveMs` réserve du temps aux checks ; le timeout effectif tient compte des budgets restants du run et de la spec. |
| Agent incapable de voir ses tests | Outil MCP local `run_check(gateId)` optionnel, avec commandes figées, quotas, annulation et diagnostics bornés. L'agent peut corriger pendant la même session. Les receipts finaux restent produits dans la validation indépendante. |
| Même cérémonie pour chaque tâche | Mode compact explicite pour une petite tâche déjà cadrée. Une spec complète reste nécessaire pour les changements structurels, sensibles ou trop larges. |
| Maquette coûteuse pour une retouche | `uiImpact=minor` reprend les conventions existantes sans nouvelle maquette complète. `major` conserve le parcours Design. |
| Fausses modifications de dépendances/CI | Le contexte de sécurité du projet est séparé du changement demandé. Les exclusions sont prises en compte pour les signaux CI/dépendances ; les chemins effectivement proposés restent des signaux forts. |
| Modèle choisi implicitement | `model` et `effort` par rôle, rôle Design configurable et `modelRouting` explicite par fournisseur, rôle et lane. Aucun classement arbitraire des modèles ni montée en gamme silencieuse. |
| Qualité réduite au prompt | Onboarding découvre aussi les scripts build, intégration et navigateur existants. Les rôles et skills demandent des preuves observées, des tests de comportement et des abstractions justifiées. |
| Pas de comparaison reproductible | Six petits cas d'ingénierie, exécution volontaire, rapports incluant les échecs, p50/p95, temps de planification et coût connu par réussite. Une grille de revue humaine accompagne les résultats. |

## Lot 2 — Boucle courte et conventions CSS

La numérotation retenue ici est celle de la demande : **« Faire travailler les agents avec une boucle plus courte »**. Le précédent bilan ne couvrait que la reprise Product et BEM ; il ne constituait pas la fin de ce lot. Les parcours, les contrats et les contextes sont désormais explicités ci-dessous.

| Demande | Parcours effectif |
| --- | --- |
| Correction locale déjà cadrée | `spec compact` → implémentation → contrôles → revue humaine configurée. Aucun appel Product ; pas de QA modèle si le diff reste local et non sensible. |
| Fonctionnalité courante | Product court → implémentation et checks en session si configurés → contrôles finaux → QA ciblée indépendante → revue. |
| Migration, auth ou changement structurant | Exploration ciblée et décision d'architecture → plan → implémentation → contrôles de niveau `high` → QA complète indépendante → revue. |

L'onboarding neuf et `apv2 init` proposent `workflow.planningMode: "adaptive"`. Le tableau de bord propose ces parcours. Les configurations antérieures conservent le mode `legacy` si le champ est absent ; `spec draft --pathway auto|standard|structural` active les nouveaux parcours pour le nouveau brouillon. `standard` est une préférence : les signaux sensibles peuvent imposer `structural`. Le parcours compact exige une tâche et des chemins précis ; il refuse les changements structurels ou sensibles connus. Son exemption de QA est réévaluée sur le diff final et n'est pas appliquée en mode `regulated`.

Le contrat Product court borne la sortie : trois tâches cohérentes au maximum, douze critères observables, un problème de 1 200 caractères et des descriptions de tâches de 2 000 caractères. Le contrôleur restaure les lanes. Les exigences de sécurité et la couverture des décisions confirmées restent vérifiées. Une demande qui ne tient pas dans ce contrat doit être clarifiée ou passer au parcours structurant, pas perdre ses contraintes.

Une décision d'architecture contient les alternatives, les compromis, les conditions de réexamen et les fichiers inspectés. Elle précède le plan, est enregistrée, entre dans le hash d'approbation et accompagne l'implémentation ainsi que la QA. Ses références doivent exister au commit de base ; leur présence ne prouve pas à elle seule la qualité de l'analyse. Une reprise réutilise les checkpoints compatibles.

Le contexte des nouvelles tâches sélectionne les fichiers et déclarations pertinents, avec des comptes explicites de ce qui est omis. L'agent garde l'accès au dépôt pour chercher plus loin. Une réparation conserve ce contexte, ses modifications et les diagnostics actuels. La QA ciblée reçoit **tout le diff, tous les critères et toutes les obligations**, mais pas les longues descriptions de planification ni les sorties réussies des commandes. Les vérifications structurelles gardent le contexte QA complet. Les événements `agent.context_reused` et `qa.context_selected` rendent ces choix observables.

Les profils explicites `roleProfiles` sélectionnent `quick` pour les lanes `fast/standard` et `deep` pour `high`, par rôle et fournisseur. Un `modelRouting` précis reste prioritaire, puis les amendements opérationnels autorisés. Les profils modifient modèle et effort, jamais les permissions, commandes ou plafonds. Les modèles ne sont pas choisis implicitement par leur nom : le protocole de comparaison et ses résultats figurent plus bas.

**État du complément : parcours implémentés et cas sensible débloqué par la calibration.** Le réglage retenu est Sonnet 5 / `low` pour les tâches ordinaires et Sonnet 5 / `medium` pour la lane `high`. Le [rapport de calibration](../validation/short-loop-2026-09-18/CALIBRATION.md) conserve les résultats et les limites ; le [premier pilote](../validation/short-loop-2026-09-18/REPORT.md) reste disponible avec ses échecs. Ce petit pilote ne prouve pas la qualité générale d'un modèle sur toute application.

```json
{
  "workflow": { "planningMode": "adaptive" },
  "roleProfiles": [{
    "provider": "claude", "role": "implementer",
    "quick": { "model": "MODELE_RAPIDE_EPINGLE", "effort": "low" },
    "deep": { "model": "MODELE_APPROFONDI_EPINGLE", "effort": "high" }
  }]
}
```

Ajouter une entrée pour chaque rôle à piloter (`product`, `design`, `implementer`, `qa`). `feedback.gateIds` reste l'autorisation explicite des checks en session : activer les IDs réellement configurés, comme décrit ci-dessous.

- Product conserve une sortie JSON décodée avant validation. Une correction reçoit le document précédent, une erreur structurée et le schéma du document à réparer, en plus du contrat des patches. Les fournisseurs natifs répondent par patches. Un document complet envoyé à la place du patch demandé est refusé sans écraser le checkpoint. Le résultat complet passe de nouveau le schéma et les validations métier.
- Les patches peuvent modifier, ajouter ou supprimer un élément de tableau ; les indices, les parents et les accès aux prototypes restent contrôlés. Le diagnostic Product rassemble les topics, surfaces et mappings de sécurité manquants dans une seule erreur pour éviter une succession de réparations élémentaires.
- Chaque rejet de sortie est enregistré dans `role.output_rejected`, y compris le dernier : code, chemin lorsque disponible, message borné, empreinte du document conservé et indication d'une nouvelle tentative automatique.
- La reprise exige le même rôle, mode, SHA, contexte, schéma et digest des consignes. Une spec Product valide est enregistrée avant Design ; `spec plan-resume` peut reprendre après un échec de Design sans rappeler Product. Les sorties jamais reçues ne sont pas récupérables.
- Les signaux de sécurité distinguent les exclusions et le contexte du projet des modifications demandées ; les chemins effectivement proposés restent des signaux forts. Les validations des décisions confirmées et les approbations restent actives après réparation.
- Product/Design, Implementer, QA et le skill `ui-design` suivent la même règle : **BEM par défaut pour les nouvelles classes de composants en CSS global**, sauf convention existante ou décision confirmée différente. CSS Modules, styles encapsulés, frameworks utilitaires et utilitaires documentés gardent leur convention. La checklist ne contient plus l'instruction contradictoire « BEM not used ».

Le framework utilise maintenant Stylelint, épinglé en dépendance de développement,
pour vérifier `ui/**/*.css` via `npm run lint:css`, inclus dans `npm run check`.
Le profil réutilisable est [examples/stylelint-bem.config.mjs](../examples/stylelint-bem.config.mjs).
Il accepte `block`, `block__element`, `block--modifier`, `block__element--modifier`
en minuscules kebab-case. Les tests vérifient notamment les sélecteurs imbriqués,
les chaînes qui ressemblent à des classes et le refus de `.card__body__label`.

Pour un projet qui adopte BEM, intégrer le profil à sa configuration Stylelint,
conserver ses autres règles et exposer un script couvrant uniquement son CSS global
source, par exemple `stylelint "src/styles/**/*.css" --max-warnings 0`. Nommer le
script `lint:css` ou `lint:styles` : l'onboarding le propose comme gate existante
sur les lanes `standard` et `high`. Pour une configuration déjà installée, ajouter
la gate à `gates` dans le cadre de la mise à jour de configuration du projet :

```json
{
  "id": "lint-css",
  "command": ["npm", "run", "lint:css"],
  "lanes": ["standard", "high"],
  "resources": ["project-checks"]
}
```

La [règle Stylelint](https://stylelint.io/user-guide/rules/selector-class-pattern/)
contrôle le nommage des sélecteurs de classe. Elle ne prouve ni l'appartenance
sémantique d'un élément à son bloc, ni la présence de la classe de base dans le
markup : ces points sont explicitement confiés à la revue QA. Les fichiers exclus
et les classes uniquement présentes dans HTML/JS ne sont pas vérifiés par ce lint.
La présence d'un script CSS seule ne prouve pas qu'il active BEM. Aucun outil ni
nouvelle gate ne sont installés automatiquement dans les projets existants.

## Utilisation

Une tâche compacte utilise le contrat `Task` existant : titre, description, critères d'acceptation et chemins précis. Elle produit une spec à approuver normalement, sans appel Product. Les décisions du projet restent vérifiées ; si elles exigent une couverture que ce raccourci ne peut exprimer, utiliser une spec standard.

```sh
apv2 spec compact --repo /chemin/projet --request "Corriger le calcul de pagination" --file task.json
apv2 spec approve SPEC_ID --hash HASH --approve
apv2 spec run SPEC_ID
```

Le tableau de bord propose aussi « Tâche compacte » lors de la création. Les petites tâches de code gardent la lane `standard` et ses gates ; le raccourci réduit la planification et la QA modèle lorsque le diff observé le permet, pas les contrôles déterministes.

Pour reprendre une rédaction arrêtée sans reformuler la demande :

```sh
apv2 spec plan-resume SPEC_ID
```

Une sortie finale jamais reçue ne peut pas être reconstruite. Les checkpoints conservent les objets déjà reçus et les specs acceptées avant Design ; ils ne sont pas une sauvegarde du raisonnement interne du fournisseur. Un crash exige toujours la récupération des processus avant reprise.

Pour ajuster les moyens d'une spec sans changer son périmètre approuvé, préparer par exemple `limits.json` :

```json
{
  "maxSpecCostUsd": 15,
  "maxActiveMs": 1800000,
  "agent": { "maxBudgetUsd": 8, "timeoutMs": 600000, "effort": "medium" }
}
```

```sh
apv2 spec budget SPEC_ID --file limits.json --approve --note "Allocation pour terminer le travail conservé"
apv2 spec plan-resume SPEC_ID
```

Ces valeurs sont des plafonds **totaux**, travail déjà consommé compris, et des exemples, pas des performances promises. Le tableau de bord propose « Ajuster les limites ». L'amendement est audité ; il ne permet de modifier ni commandes, ni credentials, ni gates, ni périmètre. Un run déjà épuisé peut nécessiter une nouvelle tentative explicite. L'ancien `--accept-cost` reste un dépassement sans plafond global : préférer une allocation chiffrée.

Un budget reste utile pour arrêter une boucle qui dérive. Le réglage conseillé est un plafond global par spec, réparti entre ses appels, accompagné de limites de temps et de tours. Un plafond arbitraire de 5 $ sur chaque appel ne doit pas servir à calibrer toutes les tâches : mesurer les parcours, raccourcir Product et reprendre le travail conservé permet de distinguer une allocation insuffisante d'une boucle inefficace. Retirer toutes les limites ne résout pas cette deuxième cause.

## Checks pendant la session

Activer seulement des checks existants, indépendants et sans placeholder de commit :

```json
{
  "feedback": { "gateIds": ["typecheck", "test"], "maxCalls": 4, "maxTotalMs": 120000 },
  "validationReserveMs": 60000
}
```

Ce bloc complète `pipeline.v2.json` ; les IDs doivent exister dans `gates`. Les anciens projets n'obtiennent pas automatiquement un nouvel accès aux outils : `feedback.gateIds` est vide par défaut. Les checks s'exécutent sur les edits courants, sans les variables d'environnement propres au fournisseur. Ils peuvent produire les artefacts habituels des scripts du projet. C'est toujours le mode **local-trusted**, pas un sandbox contre un dépôt hostile ou un autre processus du même utilisateur.

Le contrôleur expose une seule commande métier, `run_check`, sur une adresse de boucle locale avec un jeton de session. Aucun argv fourni par le modèle n'est exécuté. Les appels concurrents, IDs inconnus, arguments supplémentaires et quotas dépassés sont refusés. Les processus sont suivis et annulés à la fin de la session. Le résultat n'est jamais une receipt réutilisable.

La session de l'Implementer conserve ainsi le contexte de sa boucle test/correction. Les réparations externes restent bornées et reçoivent les diagnostics précédents ; cette version ne reprend pas aveuglément une conversation native interrompue.

## Modèles et skills

`agent` configure l'Implementer ; `roles.product`, `roles.design` et `roles.qa` peuvent le remplacer. Design hérite de Product lorsque non configuré. Pour choisir dès l'onboarding :

```sh
apv2 onboard --repo /chemin/projet --provider claude --model MODELE_CHOISI --effort medium
```

Les règles suivantes illustrent un routage explicite, à compléter avec les identifiants de modèles disponibles sur le compte :

```json
{
  "modelRouting": [
    { "provider": "claude", "role": "product", "lane": "standard", "model": "MODELE_PRODUCT", "effort": "medium" },
    { "provider": "claude", "role": "implementer", "lane": "high", "model": "MODELE_IMPLEMENTATION", "effort": "high" }
  ]
}
```

Le routage utilise la lane connue avant l'appel ; l'analyse du diff continue d'escalader le risque et les gates. L'amendement opérationnel d'une spec prime sur ce routage. Un modèle vide continue d'utiliser le choix par défaut du CLI : il faut renseigner les modèles pour une comparaison reproductible.

Les skills existants sont conservés. `clean-code`, `tdd`, `design-patterns` et `ui-design` ont été précisés pour les preuves de tests, les retouches UI et les décisions d'architecture proportionnées. Une abstraction doit résoudre un problème actuel ; un petit changement ne nécessite pas une hiérarchie de patterns. Leur injection reste tracée mais ne prouve pas que le modèle a suivi chaque conseil. Les changements du catalogue ne réécrivent pas les copies documentaires déjà installées dans les projets ; le runtime utilise les assets du framework.

## Évaluation et limites

```sh
npm run evaluate
# Affiche les cas ; aucun appel de modèle ni création de dépôt.

npm run evaluate -- --provider claude --model MODELE_CHOISI --effort medium \
  --label candidat --repetitions 3 --budget-usd 5 --output /tmp/eval-candidat --execute
```

Les cas couvrent un bug de borne, une petite fonctionnalité, une frontière asynchrone, une retouche HTML, une autorisation multi-tenant et une évolution de contrat de données. `--planning fixture` isole l'exécution de la génération Product ; le mode par défaut mesure Product aussi. `--config` permet une autre configuration revue. Comparer les mêmes cas et répétitions, avec des configurations nommées ; le rapport n'élimine pas les tentatives échouées. Les approbations sont explicitement simulées sur ces dépôts jetables. Rien n'est publié.

La gate par défaut du pilote lance `node --test` : elle découvre l'oracle fixe et les tests de régression ajoutés. L'ancien argv qui vise seulement `test/acceptance.mjs` reste accepté pour reproduire les premiers essais, mais ne prouve pas l'exécution des autres tests. Les mesures du 18 septembre conservent cette limite initiale ; elles n'ont pas été réécrites après correction du banc d'essai.

Ces petits cas ne prouvent pas la qualité d'architecture d'une application complète. Le cas UI inspecte le markup, pas un navigateur. Une revue de code et des cas représentatifs du projet restent nécessaires avant de conclure qu'un modèle fournit du code de qualité senior ou qu'une feature tient dans une durée donnée.

`--pathway auto` mesure les nouveaux parcours. `--cases-file CAS.json` permet des cas spécifiques au projet (`id`, `category`, `path` sous `src/` en `.mjs`, `request`, `before`, `checks`, et éventuellement `pathway: "compact"`). Ce fichier est du code de test de confiance : la commande `--execute` lance ses assertions dans des dépôts jetables. Le dépôt réel n'est pas exécuté ni modifié.

`--total-budget-usd` borne la campagne par les coûts déclarés et réduit le budget de chaque spec au montant restant. Un coût inconnu ou une limite de session fournisseur suspend les cas suivants ; une indisponibilité ne sert pas à classer la qualité d'un modèle. La commande suivante compare deux rapports contenant les mêmes cas, les mêmes checks et le même nombre de répétitions :

```sh
node scripts/compare-evaluations.mjs RAPPORT_RAPIDE.json RAPPORT_APPROFONDI.json
```

Le rapport conserve les échecs, coûts, délais, appels, volumes de contexte et modèles observés. Il refuse les comparaisons de périmètres différents et ne recommande aucun profil à partir d'une campagne incomplète. Le classement sur checks automatisés reste provisoire jusqu'à revue du code ; il ne réécrit aucune configuration.

Le coût Codex reste inconnu si le CLI ne publie que des tokens. Un plafond exprimé en dollars ne constitue alors pas une garantie de dépense ; temps et tours restent bornés. Les coûts Claude sont déclarés par le fournisseur, peuvent dépasser légèrement le plafond au dernier tour et ne remplacent pas une facture. L'historique antérieur au journal n'est récupérable qu'à hauteur des traces déjà présentes.

Compatibilité des arguments consultée dans la [référence Claude Code](https://code.claude.com/docs/en/cli-reference), la [configuration MCP Claude](https://code.claude.com/docs/en/mcp) et la [référence de configuration Codex](https://developers.openai.com/codex/config-reference). Les CLI locaux exposent les options attendues. La validation initiale utilisait des doubles ; la comparaison Claude réelle du complément au lot 2 est consignée séparément avec ses coûts et ses limites. Aucun pilote Codex réel n'a été exécuté pour ce complément.

Les changements sont dans le framework. La configuration et l'historique de `~/ed/project-test` n'ont pas été modifiés automatiquement.

## Comparaison réelle des profils

Dans le premier pilote, Sonnet 5 / `low` termine le cas compact en **12 s / 0,072 $** et la fonctionnalité courante en **69 s / 0,319 $**. Le cas sensible bloquait sur un profil qui traitait les exclusions de login/base de données comme des fonctionnalités en périmètre. Opus 5 / `high` rencontrait aussi un plafond de budget en QA et un timeout Product. Les [mesures initiales](../validation/short-loop-2026-09-18/REPORT.md) sont conservées.

Après correction du périmètre, **Sonnet 5 / medium termine le cas sensible en 4 min 21 s pour 0,777 $**, architecture, plan, implémentation, contrôles et QA indépendante compris, sur une machine fortement chargée. La lane reste `high`, avec modèle de menace et tests négatifs. Product a besoin d'une réparation d'IDs du registre ; le diagnostic et les consignes de cette distinction sont désormais explicites. Le code produit reste une fonction pure de sept lignes, sans abstraction spéculative. Voir la [calibration et la revue](../validation/short-loop-2026-09-18/CALIBRATION.md).

Le [fragment de profils retenu](../examples/claude-short-loop.profiles.json) configure les quatre rôles Claude : `quick` = Sonnet 5 / low, `deep` = Sonnet 5 / medium. Fusionner `roleProfiles` et `workflow.planningMode` avec la configuration existante, en conservant ses gates, commandes, permissions et limites. Les `modelRouting` explicites restent prioritaires. Le rôle Design n'a pas été mesuré par ces cas backend. Les trois types de parcours ont réussi au cours d'essais distincts ; il ne s'agit pas d'une campagne homogène avec plusieurs répétitions sur la dernière version.

Coût cumulé : **5,82 $ déclarés, plus un ancien appel au coût final inconnu**, dont **1,56 $** restent réservés. Le total connu ou réservé est **7,38 $**, dans l'enveloppe de 8 $ prévue ; ce n'est pas une facture finale. [Bilan actualisé](../validation/short-loop-2026-09-18/calibration-spending.json).

## Validation de cette implémentation

Validation initiale : **404 tests réussis, aucun échec**, compilation et vérification TypeScript incluses. Résultats conservés : [résumé machine](../validation/improvements-2026-09-18/summary.json), [journal des tests](../validation/improvements-2026-09-18/check.log) et [contrôle du paquet](../validation/improvements-2026-09-18/package.json).

Validation intermédiaire de la reprise Product et BEM : `npm run check` passait avec **411 tests réussis sur 411**, vérification TypeScript, compilation et lint CSS inclus. Le skill `ui-design` passait aussi sa validation de métadonnées. Le paquet avait été installé hors ligne dans un répertoire temporaire : CLI, quatre rôles, six skills, tests de contrats fournisseurs/bootstrap, cycle de vie et serveur du tableau de bord vérifiés. Le profil Stylelint et sa configuration étaient présents dans l'archive. Cette étape n'incluait aucun appel réel de modèle. Preuves historiques : [résumé intermédiaire](../validation/lot2-2026-09-18/summary.json), [journal complet](../validation/lot2-2026-09-18/check.log), [tests CSS](../validation/lot2-2026-09-18/css-checks.log) et [contrôle du paquet](../validation/lot2-2026-09-18/package.json).

Validation du complément avant calibration : **422 tests sur 422**, typage, compilation et lint CSS réussis. Les tests couvrent notamment la revue finale du compact, les obligations conservées en QA ciblée, la liaison de l'architecture à l'approbation, les contextes sélectionnés/réutilisés, les profils par rôle, les patches de tableaux, le diagnostic groupé de sécurité et le refus d'un candidat dont les régressions ajoutées échouent. Preuves historiques : [résumé](../validation/short-loop-2026-09-18/summary.json), [journal complet](../validation/short-loop-2026-09-18/check.log), [réparations et sécurité](../validation/short-loop-2026-09-18/repair-security-check.log), [banc d'essai](../validation/short-loop-2026-09-18/evaluation-smoke.log).

Validation finale après calibration : **425 tests sur 425**, typage, compilation et lint CSS réussis. Les nouveaux tests distinguent les exclusions de périmètre des exigences négatives de sécurité et vérifient que les chemins réels de login/session/mot de passe/migration restent prioritaires. [Résumé actualisé](../validation/short-loop-2026-09-18/calibration-summary.json) et [journal final](../validation/short-loop-2026-09-18/calibration-check.log).

L'archive du code final après calibration passe aussi son [installation et contrôle hors ligne](../validation/short-loop-2026-09-18/calibration-package.json) : CLI, quatre rôles, six skills, contrats fournisseurs, bootstrap, tableau de bord et démonstration du cycle de vie.
