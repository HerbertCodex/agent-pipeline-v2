# Changelog


## Unreleased — reliability and efficient feature work

- **Chaque tâche doit laisser les contrôles capables de passer.** Ils s'exécutent après *chaque* tâche, pas seulement à la fin : une tâche qui renomme, scinde ou change la signature d'une déclaration partagée doit mettre à jour ses appelants dans le même candidat, ou garder l'ancienne déclaration utilisable jusqu'à la tâche qui les migre. Product reçoit cette règle dans son rôle et dans `executionCapabilities.rules`. Constaté sur un vrai projet : une tâche a scindé une fonction des prêts en laissant son unique appelant dans une tâche ultérieure ; le build échouait donc forcément, deux tentatives ont échoué à l'identique et aucune réparation ne pouvait corriger dans le périmètre.

- Une spec antérieure au champ `experience` ne fait plus échouer la lecture des specs : le contexte qualité lit ce champ avec la même prudence que le reste du contenu. Constaté sur un vrai magasin — une seule vieille spec renvoyait « Erreur interne » pour **toute** la liste du tableau de bord.

- Add explicit quick/deep/QA model selection for bootstrap and onboarding, including a separate QA provider and a deep QA policy independent of task risk. Preserve operator choices through Setup and approval; expose routing and operational overrides in CLI and dashboard.
- Add opt-in bounded native compatibility probes with cost accounting, short-lived caching, explicit unavailable-model/authentication/effort diagnostics, offline model previews and non-overwriting migration candidates. Per-role operational tuning preserves dedicated QA when the implementation model changes. No automatic model ranking or fallback is introduced.

- Evidence mode now blocks missing applicable build/integration/browser/boundary receipts before QA and delivery, including compact tasks. Required gates override lane filtering within their path scope. Negative security cases map to reviewed test files and final behavioral receipts; structural decisions require explicit constraint, simpler alternative and risks. An offline Chromium acceptance script covers the evidence dashboard.

- Lot 3: add evidence-backed QA axes (architecture, simplicity, reuse, tests, operations, UI), validate file/receipt/finding references and enforce the same checks on manual import and delivery. Unknown quality evidence pauses without automatic code repairs; minor observations alone cannot request changes.
- Label configured gate coverage and expose observed/missing/unselected categories in CLI, dashboard and review/delivery artifacts. New init/onboarding configurations opt into evidence QA; existing configurations retain legacy behavior. No extra QA invocation or automatic tool installation is introduced.

- Integrate provider stop messages with model/token accounting and Codex usage; normalize the dashboard test repository path for macOS.

- Implement the three short-loop paths: explicit compact/standard/structural paths, bounded Product brief, checkpointed architecture decisions bound to approval, focused task context, retained repair context and independent targeted QA. Compact model-QA exemption is rechecked against the observed diff through final review; sensitive changes retain stronger checks.
- Native pilot follow-ups: send the original document schema and explicit patch rules during repair; support bounded array removal/append; report minimum security coverage gaps together; evaluate added regression tests as well as the fixed oracle.
- Calibrate the sensitive path: distinguish explicit scope exclusions from negative security obligations and actual sensitive paths; avoid interpreting repository/auth path prose as new persistence/login scope; preserve high-risk checks. The corrected authorization fixture passes architecture, Product, implementation and independent QA with Sonnet 5 / medium. Ship explicit Sonnet 5 low/medium role-profile settings and retain the earlier failures and cumulative spending evidence.
- Add explicit quick/deep profiles per provider and role, adaptive onboarding and dashboard paths, and matched-case evaluation comparisons with campaign-wide declared budgets and provider-limit stopping.
- Account for failed and repaired provider calls, unknown costs and unfinished invocations; share remaining spec budgets across roles.
- Retain Product/Design checkpoints and patch rejected structured outputs; resume planning and amend operational limits without rewriting functional approval.
- Lot 2: reject full-document responses to native patch repairs and persist terminal structured-output rejection diagnostics. Test checkpoint identity across SHA, context, schema and guidance changes.
- Lot 2: align Product/Design, Implementer, QA and UI skills on global-CSS BEM defaults with existing-stack exceptions. Add a pinned Stylelint development check, reusable naming profile and discovery of existing `lint:css` / `lint:styles` gates.
- Add compact task planning, minor UI reuse, explicit model/effort routing and opt-in in-session checks with independent final validation.
- Detect existing build/integration/browser scripts, refine craftsmanship skills and add a representative, opt-in evaluation harness.
- See [implementation and usage](docs/AMELIORATIONS-2026-09-18.md). Existing project configuration is not migrated automatically.

## Non publié

- **La phrase du fournisseur d'abord.** Un arrêt peut venir du compte, pas de la configuration : la limite de session d'un abonnement termine la session avec `subtype: success` et `is_error: true`, et la seule explication lisible est la phrase du fournisseur. Elle est désormais reprise telle quelle dans le message d'échec, avant les dépenses : « the provider said: "You've hit your session limit · resets 11:50am" ». Constaté sur un vrai run : l'opérateur ne voyait que « spent: 10 turns, 1.31 USD » et pouvait croire à un défaut de la pipeline.

- **Des valeurs par défaut qui avertissent au lieu de couper.** Les bornes livrées jusqu'ici arrêtaient le travail en cours : 32 tours, 5 $ par appel dans l'exemple d'installation, 15 minutes de délai, une seule passe de réparation. Sur un vrai projet, elles ont arrêté trois tours de Product et deux tentatives d'implémentation sans rien produire. Nouvelles valeurs : `agent.maxTurns` 200 (filet anti-boucle), `agent.maxBudgetUsd` null, `agent.timeoutMs` 30 min, `maxRunMs` 45 min (une session d'agent **plus** ses contrôles), `maxRepairAttempts` 3, et surtout `workflow.maxSpecCostUsd` activé par défaut à 25 $ — la seule borne qui avertit : elle s'arrête entre deux tâches, annonce le coût déclaré et attend une autorisation explicite. `apv2 inspect` signale dans `configAdvice` les réglages d'une configuration existante qui coupent le travail, avec la raison de chacun. Les exemples de configuration fournisseur sont alignés.

- **Un tour de rôle raté propose de relancer la rédaction.** Quand Product échoue (délai, refus, sortie invalide), la spec n'a rien à approuver ; l'action suivante proposait pourtant `spec approve --hash NO_VALID_PROPOSAL`. Elle propose désormais `spec refine` avec le code de l'échec, ou l'abandon, et la console affiche « Relancer la rédaction ». Les rôles enregistrent aussi ce que le fournisseur déclare (coût, tours, raison d'arrêt) dans `role.finished`, et un échec de rôle nomme cette raison avant l'extrait de sortie. Constaté sur un vrai projet : un tour de Product tué à 15 minutes, suivi d'une action inutilisable.

- **Voir ce qu'une tentative a coûté, et nommer ce qui l'a arrêtée.** Quand le fournisseur le rapporte, chaque tentative enregistre son coût déclaré, son nombre de tours et sa raison d'arrêt (`agent.usage`). Un échec dit désormais « the provider stopped it at its turn limit (agent.maxTurns); spent: 33 turns, 3.31 USD » avant l'extrait de sortie, au lieu d'un JSON de 2 000 caractères où la phrase utile était noyée. La console affiche le coût par tentative et le total de la spec. Nouveau réglage facultatif `workflow.maxSpecCostUsd` : la spec s'arrête sur `COST_BUDGET` en indiquant ce qui a été dépensé, et l'opérateur autorise explicitement la suite (`spec run --accept-cost`, ou le bouton de la console). Les coûts sont des valeurs **déclarées par le fournisseur**, jamais une facture vérifiée.

- **Des tâches taillées pour une session d'agent.** Product reçoit `executionCapabilities.attempt` — tours du fournisseur, plafond de coût, délai de l'agent, budget du run, passes de réparation — et la consigne de dimensionner chaque tâche pour une seule session, en découpant par surface (une route, un module ou un écran avec ses tests) plutôt que par couche. Une tâche plus grosse qu'une session n'est pas seulement plus lente : le fournisseur s'arrête en cours de route. Avant l'approbation, `sizeAdvice` signale à l'opérateur les tâches qui déclarent plus de huit fichiers ; c'est un avertissement, jamais un blocage. Constaté sur un vrai projet : une tâche de huit fichiers a épuisé deux fois la limite de tours.

- **Réparer tant que ça avance, s'arrêter dès que ça tourne en rond.** `maxRepairAttempts` accepte désormais jusqu'à 5 passes (1 par défaut, inchangé), et une passe qui laisse les contrôles échouer **exactement comme avant** arrête la boucle sur `REPAIR_NO_PROGRESS` sans dépenser les passes restantes. La comparaison porte sur une empreinte du diagnostic débarrassée de ce qui change à chaque exécution (durées, dates, pid, empreintes de commit) ; elle sert uniquement à cette décision, n'est jamais affichée et ne prouve rien. Constaté sur un vrai projet : la première réparation avait corrigé les tests, le contrôle suivant a trouvé une erreur de typage, et l'unique passe autorisée était déjà consommée.

- **Le travail d'un agent arrêté n'est plus jeté.** Un agent qui s'arrête sans rendre son résultat — limite de tours ou de budget du fournisseur, délai, sortie illisible — a déjà écrit des fichiers. La tentative reste désormais *interrompue* et récupérable : l'opérateur inspecte l'espace de travail, puis `spec run --accept-current` enregistre ce travail et le soumet aux contrôles, à la QA et à sa revue, ou `spec retry --confirm` le jette et recommence. Rien n'est adopté sans cette décision explicite, et aucun contrôle n'est allégé. L'action suivante et la console proposent les deux issues. Constaté sur un vrai projet : deux tentatives arrêtées sur « Reached maximum number of turns (32) », chacune après avoir écrit presque tout le code, perdues toutes les deux pour 6 $.

- `apv2 spec retry` transmet à la nouvelle tentative pourquoi la précédente s'est arrêtée : son erreur, le diagnostic des contrôles en échec (borné) et son résumé. La tentative repart de la base approuvée ; sans ce contexte, elle pouvait refaire la même erreur. `GATES_FAILED` propose désormais `spec retry` comme action suivante, et la console affiche le bouton. Constaté sur un vrai projet : une tâche arrêtée sur une erreur de typage dans un test qu'elle avait écrit.

- **Tableau de bord local** : `apv2 ui`. Specs par dépôt avec statut et action suivante, détail complet (critères et verdict QA, tâches, tentatives et contrôles, maquettes, amendements, avertissements), activité des agents **en direct**, opérations lancées et maintenance. Actions de la CLI depuis la page (brouillon, affinage, approbation, exécution, revalidation, nouvelle tentative, amendements, revue, synchronisation, rejet, nettoyage) ; la purge reste au terminal. Sans dépendance, lié à `127.0.0.1`, jeton d'entrée échangé contre un cookie `HttpOnly; SameSite=Strict`, contrôle de l'en-tête `Host`, jeton anti-CSRF et même origine pour toute action, hash exact et note pour toute approbation, maquettes en *sandbox*. Les opérations longues sont des processus CLI séparés qui survivent à la page.

- **Adoption de preuve** (décision de l'opérateur) : pour une spec à une tâche, la validation d'intégration adopte les reçus de la tâche au lieu de rejouer les contrôles, sous conditions strictes (même commit, base, changements, voie, plan de contrôles, préparation, environnement remesuré, preuve fraîche). Les reçus adoptés sont `cached` avec `reusedFrom`, la fraîcheur n'est jamais prolongée, l'approbation humaine reste exigée. Toute différence refuse l'adoption avec sa raison et rejoue les contrôles. L'identité générale des preuves est inchangée.
- **Aperçus de maquette** : `stylesheets` fait charger les feuilles de style globales du projet avant le CSS de la maquette, qui n'écrit plus que ses ajouts. Mêmes garanties que les ressources (suivies au commit de référence, résolues physiquement), `.css` seulement, bornées, et refus de tout texte pouvant fermer l'élément `<style>`. L'effet sur la durée de l'étape reste à mesurer sur un vrai run.
- **`impactAdvice` moins bruyant** : un test non déclaré n'est signalé que s'il importe le fichier par un chemin relatif résolu ; chaque entrée indique sa preuve (`declared-later`, `resolved-import`). Rejoué sur deux vraies specs : 6 alertes pour 2 vraies ruptures deviennent 3 alertes gardant les 2 ; 4 fausses alertes deviennent 1.

- Retire le lien symbolique `node_modules` commité par erreur (PR #22) et ignore désormais `node_modules` quel que soit son type : la règle `node_modules/` ne visait que les dossiers. Un test vérifie que le dépôt ne suit aucun lien symbolique.

- `apv2 spec retry` reconstruit la tâche à partir de l'état actuel (spec effective, amendements approuvés, consigne de réparation en vigueur) au lieu de rejouer la copie figée de la tentative échouée. Constaté sur un vrai projet : après un correctif de la consigne de réparation QA, la relance a rejoué l'ancienne consigne et le correctif ne pouvait pas s'appliquer à la spec pour laquelle il avait été fait.

- La QA reçoit `taskSummaries`, ce que chaque tentative a rapporté : un critère qui demande à l'Implementer de *signaler* quelque chose devient vérifiable, au lieu de rester « inconnu ». Son rôle précise qu'un résumé est une affirmation, jamais une preuve du comportement.
- Une réparation QA sait qu'elle peut toucher, au minimum, un fichier hors périmètre quand un constat l'exige : le contrôleur demande alors un amendement explicite. Elle reçoit aussi les résumés des tâches, et doit dire précisément quand un constat ne se corrige pas dans les fichiers.
- `NO_CHANGE` indique ce que la dernière tentative a expliqué et propose `spec retry` ou une spec de suivi.

Constaté sur la spec de nettoyage d'un vrai projet : la QA a relevé un commentaire devenu faux dans un fichier hors périmètre et n'a pas pu vérifier un critère portant sur les résumés ; la réparation, cantonnée au périmètre, n'a rien changé et la spec s'est arrêtée sur `NO_CHANGE`.

Défauts constatés en bouclant l'incrément 2 d'un vrai projet :

- `apv2 spec publish --for-review` ouvre la PR brouillon **avant** l'approbation, pour lire le candidat sur la forge (contrôles valides et QA passée exigés). Une fusion observée avant la revue ne clôture pas la spec : `MERGED_BEFORE_REVIEW`, puis clôture au `spec sync` suivant la revue.
- `apv2 spec close` accepte une spec **revue** sans bundle de livraison : l'opérateur peut intégrer le candidat lui-même.
- `apv2 prune` ne propose jamais la spec qui porte la direction visuelle que la prochaine maquette prolonge (`kept` dans la simulation).
- Rejeter une spec libère son pointeur de run, et une spec terminale dont le pointeur est resté sans processus vivant redevient collectable par `gc` et `prune`.
- Product reçoit la consigne de ranger un test impacté dans la première tâche qui change ce qu'il compare, et l'opérateur voit `impactAdvice` avant d'approuver : tests existants qui citent un fichier d'une tâche mais sont rangés plus tard ou nulle part. Avertissement lexical, non bloquant.
- La recherche des tests impactés résout les chemins relatifs cités (`../db`) et lit comme du texte les fichiers de test que Git classe comme binaires. Rejouée sur la spec réelle, elle signale désormais les deux tests qui avaient bloqué la première tâche, avec quatre signalements qui n'ont pas cassé.

- Tests : les faux fournisseurs transmettent la requête à leur sous-processus par un fichier temporaire (`test/support/run-worker.cjs`) au lieu de `spawnSync({ input })`. Sur macOS / Node 22.16, ce sous-processus ne voyait parfois jamais la fin de son entrée et restait bloqué, ce qui faisait échouer ou annuler la CI de `main` depuis plusieurs fusions. Le blocage a été localisé grâce à l'instrumentation de la #17 : entrée du faux fournisseur lue, sous-processus lancé, puis `spawnSync … ETIMEDOUT`. Le framework lui-même n'utilise aucun lancement synchrone de processus.

- Les rôles Implementer et QA encadrent les commentaires : documentation des déclarations publiques dans la convention du langage hôte (JSDoc, Javadoc, docstrings, rustdoc…) et notes qui expliquent *pourquoi* ; jamais de preuve ni de journal en commentaire (valeurs calculées, listes de vérifications, historique, identifiants de run). La QA signale ces commentaires comme constat mineur. Constaté sur un vrai projet : un en-tête CSS de trente lignes listait des ratios de contraste calculés, non vérifiés, qui deviennent faux dès qu'une couleur change.

- **La QA juge la spec effective, pas le texte stocké.** Son contexte portait `r.content`, si bien qu'une correction de critère approuvée n'atteignait jamais la QA, et qu'un amendement de périmètre approuvé était signalé comme hors périmètre. Tous les rôles reçoivent maintenant la même vue : critères corrigés, vérifications d'exigences de sécurité corrigées, chemins amendés — plus la liste des amendements approuvés avec leur motif et leur relecteur. Constaté sur le vrai projet juste après la première correction de critère : la QA citait encore l'ancien texte.
- `apv2 spec criterion` peut corriger, dans la même approbation, les **exigences de sécurité qui vérifient ce critère** (`requirements: [{id, verification}]`) : elles portaient la même contrainte intenable. Une exigence qui ne vérifie pas le critère est refusée.
- Une preuve de validation expirée (`STALE_EVIDENCE`) indique désormais `apv2 spec verify` comme action suivante.

- Nouveau recours `apv2 spec criterion` : corriger **un** critère d'acceptation devenu intenable sur une spec en cours d'exécution, en deux temps (proposition avec hash, puis approbation explicite avec motif). Le texte approuvé reste dans le magasin, la correction porte sa propre approbation, et l'évaluation rouvre (QA et dossier de revue invalidés). Constaté en pilotant un vrai projet : un critère promettait qu'un test ne changerait pas, alors que la migration approuvée modifiait ce que ce test compare ; 18 critères sur 19 passaient et la seule issue était de jeter un candidat fini.
- Un fournisseur qui échoue est rapporté avec son code de sortie, sa durée et **sa propre sortie** (stdout compris, extrait centré sur l'échec). Constaté en pilotant un vrai projet : une tâche s'est arrêtée sur `Agent failed: ` — message vide, parce que seul stderr était lu et que le fournisseur avait écrit son refus sur stdout. Même correction pour les rôles.

Corrections issues d'un audit externe qui a rejoué chaque défaut sur l'archive `de9d782`. Une suite verte ne couvrait aucun de ces parcours.

- **La maquette approuvée atteint enfin l'implémentation.** L'Implementer reçoit le markup et la feuille de style que l'opérateur a approuvés (borné : au-delà du budget, il reçoit la description et le chemin de l'aperçu), plus le chemin du fichier d'aperçu de ses écrans. QA reçoit la maquette et doit signaler un écart visible comme constat. Auparavant les deux ne recevaient qu'une paraphrase, et QA rien du tout.
- **Le dossier de revue ne détruit plus les maquettes approuvées.** Il ne reconstruit que ce qui lui appartient (worktree du candidat, patch, REVIEW.md, QA.md, INVENTORY.md) au lieu d'effacer le répertoire parent, qui contient le bundle design. `REVIEW.md` pointe désormais vers les aperçus.
- **Un nouveau candidat remplace la revue précédente au lieu de bloquer la spec.** Après une réparation QA, `r.review` est explicitement invalidé ; `REVIEW_STALE` ne peut plus enfermer une spec dans un blocage définitif.
- **Les documents de revue suivent ce qu'ils décrivent.** L'identité du dossier couvre candidat, spec, design, rapport QA et résultats de gates : un rapport QA remplacé sur le même candidat régénère `QA.md` sans reconstruire le worktree.
- **Une revue sémantique qui échoue ne perd plus la proposition Setup.** Elle est persistée avant la revue, et l'échec est enregistré avec son code et son message au lieu de laisser un document « pending ».
- **Un commit du Decision Ledger ne peut plus emporter le travail indexé de l'opérateur** : le commit porte un pathspec limité aux deux fichiers du ledger.
- **Une ressource de maquette ne peut plus être lue hors du dépôt.** Le chemin est résolu physiquement (un répertoire du dépôt peut être un lien symbolique) et doit être un fichier suivi par Git au commit de référence.
- **L'action suivante d'une spec bloquée lève son blocage** : amendement de périmètre avec son identifiant, `retry`, `recover`, suivi explicite après QA rejetée, au lieu de rejouer `spec run` qui reproduit le même arrêt.
- **La réutilisation d'une validation dépend de la preuve, pas de la revue humaine** : une spec à une tâche réutilise sa validation quand tous les gates configurés sont passés sur le même candidat et qu'aucune approbation n'est perdue. Quand la voie exige des approbations, la validation d'intégration reste exécutée — c'est délibéré.

- Les règles structurelles d'une spec (au moins une tâche, chaque critère rattaché à une tâche) s'appliquent dès qu'une spec est produite sans question, au lieu d'être vérifiées seulement à l'approbation. Constaté en pilotant un vrai projet : un critère de non-régression rattaché à aucune tâche n'était signalé qu'au moment de l'approbation, 16 minutes après le début. Le message nomme désormais les critères orphelins, et `SPEC_COVERAGE` étant réparable, la boucle de réparation corrige le cas en un appel. La règle ne s'applique qu'à une sortie de rôle fraîche : un document déjà stocké reste lisible, quelle que soit la règle ajoutée après lui.
- `git config --get` reçoit `HOME` (et les variables de configuration documentées par Git) : l'identité de l'opérateur vit presque toujours dans le `~/.gitconfig` global, donc le repli sur `user.name` ne fonctionnait jamais et `--reviewer` était obligatoire. Les commandes Git qui écrivent gardent leur environnement minimal.

- `apv2 prune` était documentée et routée dans le cycle de vie, mais absente de la liste de commandes de `cli.ts` : le binaire répondait « Unknown command prune ». Un test vérifie désormais que chaque commande documentée dans l'aide atteint son gestionnaire.

- Continuité visuelle entre incréments : une nouvelle proposition design reçoit la direction déjà approuvée pour le dépôt (`establishedDesign`) et doit l'étendre — ne maquetter que les écrans créés ou modifiés, ne styler que ce qui est nouveau — au lieu de redériver une direction complète. Enregistrée dans `design.reusedFrom` et visible dans `INDEX.md`. Constaté en pilotant un vrai projet : l'étape design coûtait 401 s sur 748 s en redessinant des écrans inchangés.
- Le validateur de maquettes analyse les éléments et leurs attributs, et non le texte affiché : une maquette peut montrer du markup échappé, `src=` ou une URL comme contenu. L'analyse tient compte des guillemets, donc un `>` dans une valeur d'attribut ne masque plus un attribut suivant.
- Une maquette peut utiliser les polices et images du dépôt : `assets` déclare des fichiers (chemin relatif au dépôt), référencés par `url(asset:ID)`, que le contrôleur insère dans l'aperçu en `data:` URI (512 Kio par fichier, 2 Mio au total, pas de SVG ; CSP `font-src data:`). Toute autre forme de `url()` et `@import` restent refusées. Les aperçus peuvent enfin montrer la typographie réelle du projet.
- Nouvelle commande `apv2 prune [--id ID] [--older-than DAYS] [--confirm]` : supprime du magasin les documents abandonnés (specs terminées ou brouillons jamais approuvés, plans jamais appliqués) avec leurs runs, reçus, événements et workspaces. Simulation par défaut, rien de plus récent que 30 jours, et jamais un document verrouillé, actif ou appliqué.

- Diagnostics d’échec centrés sur les échecs : début et fin de la sortie plus les lignes portant un vocabulaire d’échec générique (fail, error, expected, ×…), jusqu’à 16 000 caractères (au lieu des 8 000 derniers caractères, qui masquaient quels tests échouaient). Sortie des gates capturée jusqu’à 1 Mio.
- Une réparation d’Implementer qui ne change rien s’arrête avec `REPAIR_NO_CHANGE` au lieu de relancer les gates sur le même candidat.
- L’Implementer reçoit `repositoryIntelligence.referencingTests` (tests existants qui référencent ses fichiers, marqués `outsideScope`) et doit mettre à jour un test cassé par un changement voulu plutôt que laisser échouer : le contrôleur demande alors un amendement de périmètre explicite. Product doit inclure ces tests quand un contrat partagé change.
- `role.finished` enregistre `timingsMs` (avant lancement, processus, contrôle du workspace, validation).
- Les crochets et parenthèses sont des caractères littéraux dans les chemins et globs (routes dynamiques `[id]`, groupes `(app)`) ; accolades et négation `!` restent refusées. Une erreur `GLOB` dans une réponse de rôle devient réparable. Constaté en pilotant un vrai projet : une spec valide était rejetée et tout le tour Product (7,5 min) perdu.
- Garde déterministe `SPEC_CAPABILITY` : une spec ne peut pas confier un fichier généré par l’outillage (`workflow.generatedPaths`, lockfiles par défaut) à un Implementer sans shell ; appliquée aux propositions Product, importées et à l’approbation.
- Limites configurables `limits.maxTaskContextChars` (défaut 120 000, plafond 400 000) et `limits.maxQaDiffBytes` (défaut 512 Kio, plafond 8 Mio).
- Pilote opt-in `npm run pilot:repair` : prouve avec un vrai fournisseur que la boucle de réparation transmet l’erreur du contrôleur et obtient une réponse corrigée (au plus deux appels).
- Réparation bornée des sorties de rôle (Setup, revue sémantique, Product, design, QA) : une violation du contrat du contrôleur réinvoque le rôle avec l’erreur exacte, jusqu’à `workflow.maxOutputRepairs` (défaut 1). Délais, annulations, refus de permission et échecs de processus ne sont jamais réessayés.
- Contexte de tâche ciblé : la proposition design associe écrans et tâches (`taskScopes`) ; une tâche ne reçoit que ses écrans, et aucune tâche sans travail visuel ne reçoit le design.
- Product reçoit `executionCapabilities` (outils réels de l’Implementer, setup, gates) et doit transformer les étapes impossibles (installation, lockfile, générateur) en prérequis opérateur.
- `requiresDesign` ne détecte plus l’interface par extensions de frameworks : `uiImpact` déclaré et vocabulaire générique uniquement.
- Nouvelles commandes `apv2 decisions plan|apply` (mise à jour du Decision Ledger liée à un hash, `supersedes` explicite), `apv2 gc [--confirm]` (nettoyage prudent, simulation par défaut) et `apv2 spec list --active`.
- Les commits candidats portent le titre de la tâche, avec un trailer `Agent-Pipeline-Run`.
- Tests de régression rejouant les échecs réels observés (vérification > 3000 caractères, markup refusé, SHA QA erroné, métadonnées de clarification sur une décision confirmée, délai dépassé).
- Ajoute un inventaire déterministe et indépendant de la stack (`src/knowledge/inventory.ts`) : profils de langage déclaratifs (extension, préfiltre, grammaire, règle de surface publique) et repli en unités de fichier pour toute autre technologie texte, sans nom de framework dans le contrôleur (verrouillé par un test).
- `knowledge.languages` dans `pipeline.v2.json` permet d’ajouter ou de remplacer un profil de langage.
- Repository Intelligence transmet `inventory` (toute la surface publique bornée) à Product et Implementer ; `reuseCandidates` découpe les identifiants (camelCase, snake_case, chemins) et monte à 40.
- QA reçoit `inventoryDelta` (ajouts, retraits, `possibleDuplicates`) et doit signaler une réimplémentation injustifiée d’un comportement existant comme constat `major`.
- Le review workspace ajoute `INVENTORY.md` et une section « Public surface changes » dans `REVIEW.md` ; nouvelle commande `apv2 inventory`.
- Product doit inclure le document d’architecture existant dans une tâche lorsqu’une spec change frontières, interfaces publiques, persistance, authentification/autorisation, conventions ou une décision enregistrée.
- Régénère `examples/schemas/config.schema.json` et `task.schema.json`.

## 2.0.0-alpha.8

- Ajoute un `SecurityProfile` / `SecurityContext` déterministe qui route les surfaces sensibles vers un catalogue OWASP Cheat Sheet borné sans prétendre à une conformité OWASP.
- Product doit relier chaque sujet OWASP routé à des exigences de sécurité et critères d’acceptation vérifiables ; une spec ne peut plus supprimer silencieusement un sujet ou réduire une surface détectée.
- Ajoute un threat model conditionnel (assets, trust boundaries, menaces, mitigations, critères) et des tests négatifs/adversariaux obligatoires lorsque les surfaces l’exigent.
- Le contexte de sécurité peut relever la lane minimale jusqu’à `high` pour auth/authorization, données sensibles, uploads, requêtes sortantes, multi-tenant, secrets, CI/CD, dépendances et agents/MCP.
- QA ajoute `securityChecks`; un verdict `pass` est refusé si une exigence sécurité est absente, en échec ou inconnue.
- Onboarding découvre les scripts de sécurité existants (`security:*`, `audit:*`, `sast*`, `semgrep*`, `gitleaks*`, `trivy*`, etc.) sans inventer ou installer un scanner absent.
- Ajoute les sujets OWASP supply-chain, GitHub Actions, AI Agent Security, LLM Prompt Injection Prevention, Secure Coding with AI et MCP Security.
- Renforce le trust model : dépôt, issues/PR, logs, documentation récupérée et descriptions d’outils/MCP sont explicitement des données non fiables dans Product, Implementer, QA, Codex et Claude.
- Lie le hash de spec au `SecurityContext`, expose les schémas `security-context` et `security-plan`, et ajoute `docs/OWASP-SECURITY.md`.
- Durcit le workflow GitHub Actions livré : permissions lecture seule, credentials checkout non persistés, action refs épinglées sur des commits et matrice `fail-fast: false`.
- Conserve le correctif macOS de canonicalisation des racines Git par `realpathSync`.

## 2.0.0-alpha.7

- Ajoute le statut de décision `ambiguous` avec question de clarification et interprétations plausibles ; une ambiguïté n'est plus traitée comme une décision confirmée.
- Ajoute un tripwire déterministe pour les formulations d'approbation avec exception (« je valide … sauf … », « I approve … except … ») afin d'empêcher une inclusion/exclusion silencieuse.
- Une ambiguïté `bootstrap` bloque seulement si elle empêche le socle ; une ambiguïté `product` peut traverser un bootstrap neutre sans déclencher de micro-validation prématurée.
- Ajoute `decisionResolutions` aux specs : Product ne peut résoudre une ambiguïté qu'avec une citation exacte d'une réponse opérateur ultérieure, puis doit la relier à des critères d'acceptation.
- Implementer reçoit les décisions Product résolues et QA doit les contrôler dans `decisionChecks` au même titre que les décisions confirmées.
- Renforce `bootstrap refine` : une décision ambiguë précédente ne peut ni disparaître ni changer de statut sans remplacement explicite (`supersedes`) provenant du dernier refinement.
- Renforce le rôle Setup pour ne pas faire de Product : règles métier, hébergement, CI, email transactionnel et détails outillage différables ne deviennent pas des blockers sans nécessité réelle.
- Diffère la génération du design tant que Product conserve des questions ouvertes, afin de ne pas maquetter une interprétation métier encore non résolue.

## 2.0.0-alpha.6

- Ajoute un **Decision Ledger autoritatif** : les décisions explicites de l’opérateur sont persistées avec identifiant stable, valeur, niveau d’application et citation source.
- Sépare les décisions `bootstrap`, `product` et `deferred` afin que seules les vraies décisions techniques bloquantes arrêtent le scaffolding.
- Ajoute une **revue sémantique indépendante du bootstrap** : une proposition JSON structurellement valide reste non approuvable si elle omet ou contredit une décision confirmée, affaiblit une relation métier, change l’authentification choisie ou revendique des scripts/fonctions non soutenus par les fichiers.
- Ajoute `bootstrap refine PLAN_ID --request ...` pour conserver le même plan et le même ledger pendant le cadrage ; une décision confirmée ne peut être remplacée silencieusement.
- Lie les specs au hash du Decision Ledger. Product doit mapper chaque décision `product` confirmée vers des critères d’acceptation via `decisionCoverage`.
- QA doit produire `decisionChecks` pour toutes les décisions produit confirmées ; un verdict `pass` est impossible si une décision est oubliée, en échec ou inconnue.
- Propagation du ledger jusqu’à Implementer : les décisions pertinentes sont incluses dans le contexte de la tâche afin d’éviter les placeholders ou contrats incompatibles avec le MVP approuvé.
- Exporte les nouveaux schémas `decision-ledger`, `semantic-review` et le contrat bootstrap enrichi.

## 2.0.0-alpha.5

- Rend le cycle fluide par défaut : les tâches intermédiaires n'attendent plus une revue humaine ; la revue se fait sur le candidat intégré final après QA.
- Ajoute `workflow.reviewMode` (`solo`, `team`, `regulated`) et `--review-mode`, choisi une fois au bootstrap/onboarding. Un projet solo n'invente jamais un second reviewer.
- Ajoute une phase design pour les specs UI : Product + `ui-design` produisent une maquette HTML/CSS locale, liée au hash d'approbation de la spec avant tout code UI.
- Ajoute Repository Intelligence : scan borné par SHA des manifests, fichiers d'architecture et symboles réutilisables, fourni à Product et Implementer avant création de nouvelles abstractions.
- Les propositions bootstrap doivent expliquer les décisions d'architecture, preuves, alternatives, compromis et conditions de révision ; le résultat est persisté dans `.agent-pipeline/ARCHITECTURE.md`.
- Ajoute un périmètre fluide : nouveaux fichiers compagnons non sensibles dans le même module peuvent être acceptés automatiquement dans une enveloppe bornée ; les écarts structurants passent par un amendement auditable qui conserve le candidat courant.
- Ajoute un workspace de revue visible à côté du projet avec candidat ouvrable, patch, QA et résumé des gates avant approbation finale.
- Détection SvelteKit améliorée : projet `frontend`, `npm run check`/tests/lint reconnus sans révision manuelle du plan.
- Les approbations lifecycle peuvent utiliser `--approve` : identité d'audit dérivée de Git quand possible et note standard, sans phrase cérémonielle imposée.

## 2.0.0-alpha.4

- Ajoute `bootstrap` pour les dépôts Git sans commit et les dossiers réellement vides.
- Setup propose un manifeste structuré sans toucher au dépôt ; chemins et taille sont bornés.
- `bootstrap apply --commit` exige l’approbation du hash, écrit le socle, crée le premier commit puis génère le plan `onboard`.
- Aucun setup ou test du nouveau projet n’est exécuté pendant le bootstrap ; `doctor --execute` reste une autorisation séparée.


## 2.0.0-alpha.3

- README et START-HERE accessibles depuis un clone/ZIP public, sans artefact de conversation préalable.
- Quatre fichiers Markdown canoniques de rôles, lus réellement par le moteur et partagés avec les guides générés.
- Six skills adaptés de la V1, 40 références, routage déterministe, budget de contexte et empreintes dans les événements.
- Commandes roles, skills list/show/resolve, providers et inspect ; diagnostic des guides modifiés sans écrasement.
- Adaptateur Claude Code natif pour les quatre rôles, JSON structuré validé, outils restreints et budgets configurables ; aucun contournement de permissions.
- Choix onboard --provider ; exemples de profils Codex/Claude et d'un projet utilisant des fournisseurs différents par rôle.
- QA reçoit le vrai diff, refuse un contexte dépassant 512 Kio plutôt que d'ignorer des changements.
- Tests contractuels des deux fournisseurs et cycle complet avec doublures, sans revendication de pilote authentifié.
- Anciennes configs : aucun nouveau skill activé silencieusement ; migration explicite entre specs.


## 2.0.0-alpha.2

Ajout du cycle local de la configuration à l'observation de l'intégration : onboarding déterministe/assisté avec plan haché, préservation d'AGENTS.md, guides de rôles, doctor explicite, Product draft/refine, approbation de spec, graphe de tâches, QA intégrée et réparations bornées. Une tâche unique réutilise ses contrôles ; plusieurs tâches ont une validation d'ensemble et une revue humaine finale.

État documentaire durable et migration SQLite 1 → 2, reprise après crash et enfants journalisés, budgets de spec, retry explicite, invalidation de QA/revues sur revalidation. Livraison patch/preuves/manifeste, branche locale consentie, publication GitHub brouillon à double consentement et réconciliation de merge, sans force push ni fusion/déploiement automatique.

Schémas de transport Codex limités au vocabulaire Structured Outputs supporté ; parsing runtime complet conservé. Démonstration bout en bout CLI avec acteurs déterministes, tests de refus et véritable SIGKILL. Documentation de démarrage par prompt, capacités et limites actualisée. Pas de test fournisseur ou forge authentifié, pas d'annonce de performance sur des tâches réelles.

## 2.0.0-alpha.1

Premier noyau TypeScript de tâches : états, SQLite hors dépôt, worktrees, contrôles en graphe, preuves/cache conservateur, modes fast/standard/high, budgets, réparations, revue locale et patch. Adaptateurs command/Codex ; 155 tests déclarés dans la livraison précédente. Product, specs, onboarding assisté et publication étaient hors périmètre.
