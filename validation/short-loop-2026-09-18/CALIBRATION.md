# Calibration après les blocages du pilote

**Le cas sensible qui bloquait passe désormais de bout en bout**, avec Sonnet 5 et l'effort `medium` : architecture, plan, implémentation, contrôles et QA indépendante. Le résultat reste un candidat en attente de revue humaine, pas une publication.

## Causes corrigées

Le contrôleur interprétait « Do not implement login, a database, or a new authentication scheme » comme une demande de login, de session et de base de données. Il interprétait aussi `auth` dans un chemin et le mot générique `repository` comme des fonctionnalités à traiter. Product devait donc satisfaire un profil qui contredisait le périmètre demandé.

`securityScopeText` distingue maintenant les exclusions explicites de modification des obligations négatives : « ne pas ajouter un login » exclut ce travail, tandis que « ne jamais contourner l'authentification » conserve l'exigence. Les clauses ambiguës restent conservatrices. Les chemins réels de login, session, mot de passe et migration constituent des signaux indépendants et ne sont pas effacés par les exclusions du texte.

Le garde d'autorisation conserve **la lane `high`, le modèle de menace, les tests négatifs et la QA complète**. Son minimum comprend autorisation, validation d'entrée, journalisation/frontière avec l'appelant et modèle de menace. Il n'exige plus de construire des mécanismes de login ou de persistance qui ne font pas partie du changement.

Les consignes Product précisent comment couvrir plusieurs topics dans une exigence cohérente, sans multiplier les fonctionnalités. Le plan ne peut toujours pas supprimer les obligations détectées. Les diagnostics d'architecture nomment les références de fichiers invalides. Une confusion restante entre décisions locales et IDs du registre a nécessité une réparation dans l'essai ; les consignes et le diagnostic indiquent désormais explicitement que des décisions locales ne créent pas d'IDs du registre.

La gate du nouvel essai exécute `node --test`, qui couvre l'oracle fixe et les éventuels tests ajoutés. Le banc d'essai possède un test local prouvant qu'un oracle vert ne masque pas une régression ajoutée qui échoue.

## Résultat observé

Même demande, même module initial, même oracle fonctionnel que le cas `borrower-guard` du premier pilote. Nouveau dépôt jetable, aucun checkpoint réutilisé pour éviter de masquer les coûts de planification. Les changements portent sur le contrôleur, les consignes, la gate et l'effort du modèle : il ne s'agit donc pas d'une expérience isolant l'effet du modèle seul.

| Phase | Appels | Temps des processus | Coût déclaré |
| --- | ---: | ---: | ---: |
| Décision d'architecture | 1 | 22 s | 0,113 $ |
| Product, dont une réparation d'IDs | 2 | 154 s | 0,396 $ |
| Implémentation | 1 | 39 s | 0,131 $ |
| QA indépendante | 1 | 39 s | 0,137 $ |
| Ensemble avec orchestration et contrôles | **5** | **261 s** | **0,777 $** |

La machine a connu une forte charge simultanée, avec une charge moyenne d'environ 50 et plusieurs processus Chromium actifs en parallèle. Le temps est une observation locale, pas un objectif de latence garanti. Le coût de cet essai est entièrement déclaré ; aucun nouvel appel au coût inconnu.

L'Implementer a utilisé le check contrôlé pendant sa session. Les contrôles finaux passent et la QA rend `pass`. Le diff contient une fonction de sept lignes, sans nouvelle dépendance, classe, registre de permissions ou mécanisme d'authentification. Une revue locale complémentaire vérifie aussi l'entier sûr maximal, les IDs négatifs et enveloppés, ainsi que les variantes de casse et les rôles enveloppés : tout passe.

Preuves : [rapport natif](calibrated-sensitive.report.json), [observations](calibrated-sensitive.observations.json), [diff](calibrated-sensitive/borrower-guard.diff), [architecture, spec, QA et receipts](calibrated-sensitive/borrower-guard.plan.json), [événements](calibrated-sensitive/borrower-guard.events.json), [sondes complémentaires](calibrated-sensitive/extra-review.json).

## Réglage retenu

Le [fragment de configuration réutilisable](../../examples/claude-short-loop.profiles.json) définit explicitement les profils Claude pour Product, Design, Implementer et QA :

- `quick` : **Sonnet 5, effort `low`**, pour les lanes `fast` et `standard` ; les deux cas ordinaires du premier pilote avaient terminé en 12 et 69 secondes.
- `deep` : **Sonnet 5, effort `medium`**, pour la lane `high` ; c'est le réglage qui termine le cas sensible corrigé.

Fusionner les entrées `roleProfiles` et le champ `workflow.planningMode` dans la configuration existante, en conservant ses commandes, gates, permissions et limites. Un `modelRouting` explicite reste prioritaire. Ce fragment n'installe pas Claude et ne change pas les rôles configurés avec un autre fournisseur. `~/ed/project-test` n'a pas été reconfiguré automatiquement.

Le rôle Design n'a pas été mesuré par ces trois cas backend ; son réglage suit Product et reste à éprouver sur une vraie tâche UI. Opus `high` n'est pas retenu par défaut sur ce pilote. Les trois types de parcours ont maintenant été exercés avec succès sur ces petites adaptations, **au cours d'essais distincts**, et non lors d'un nouveau benchmark homogène de trois cas sur la dernière version. Plusieurs répétitions et des cas plus larges restent nécessaires pour une estimation statistique des coûts/délais ou une affirmation générale sur la qualité du code.

## Budget cumulé

Après ce complément : **5,8192396 $ déclarés** et **1,56 $ toujours réservés** pour l'ancien appel Opus interrompu, soit **7,3792396 $ connus ou réservés** sur les 8 $ autorisés. La réserve n'est pas une facture ; un plafond fournisseur peut dépasser légèrement au dernier tour. Aucun autre appel payant lancé après ce succès. Le [bilan actualisé](calibration-spending.json) conserve la référence au journal précédent.

## Validation du framework

`npm run check` passe avec **425 tests sur 425**, typage, compilation et lint CSS inclus. Le paquet passe également son installation hors ligne, le chargement des quatre rôles et six skills, les contrats fournisseurs/bootstrap, le cycle de vie et le serveur du tableau de bord. Preuves : [résumé](calibration-summary.json), [journal](calibration-check.log), [contrôle du paquet](calibration-package.json).
