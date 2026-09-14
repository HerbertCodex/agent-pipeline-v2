# Frontière de confiance et limites de sécurité

## Usage autorisé par la conception actuelle

Cette alpha est un runner **local de confiance**, mono-opérateur. Elle n'est pas un service capable d'exécuter du code hostile de façon sûre. `executionMode: "local-trusted"` est un prérequis explicite, pas une option de sandbox.

Un worktree Git sépare des fichiers et un HEAD ; il partage des métadonnées Git avec le dépôt principal et ne limite ni le réseau ni tous les accès du processus. Un programme exécuté sous le même utilisateur peut en principe accéder à son système de fichiers, à ses configurations et au store. Placer SQLite hors du dépôt supprime le couplage administratif avec Git, pas cette autorité de l'OS.

Ne pas utiliser ce runner directement sur des PR externes non fiables, sur une machine contenant des secrets de production ou comme serveur multi-utilisateur. L'adaptateur Codex demande un niveau de sandbox au fournisseur, mais le moteur n'en atteste pas l'efficacité et les gates/setup ne sont pas automatiquement placés dans ce sandbox.

## Protections réellement implémentées

Les commandes sont des argv d'un profil approuvé, sans shell implicite. La configuration est lue avant l'agent, conservée et hachée. Les champs JSON inconnus sont refusés. Les transitions, preuves et approbations ne proviennent pas du verdict de l'agent.

Le moteur observe le diff complet entre la base et le candidat, contrôle le scope et recalcule les obligations avant export. Les suppressions et renommages ne peuvent pas cacher le chemin initial. Des chemins sensibles forcent le mode élevé. Les sous-modules et symlinks suivis sont refusés dans cette alpha.

Un validateur neuf évite de copier les dépendances ou les artefacts mutables de l'agent. Les modifications suivies et fichiers non ignorés produits par un contrôle invalident la validation. Une sortie ignorée peut toutefois être produite légitimement par les outils ; sa sûreté et ses dépendances restent la responsabilité du profil. Il n'y a pas d'empreinte universelle de tous les fichiers de l'OS.

Les scripts Git sont lancés avec les hooks désactivés pour les opérations gérées par le contrôleur. Cela ne désactive pas tous les filtres Git ou tous les programmes qu'un agent local de confiance pourrait décider de lancer. Le noyau n'utilise pas de scanner SAST maison et ne reprend pas le mécanisme de suppression en commentaire de la V1 : un vrai scanner doit être configuré comme contrôle.

## Store, preuves et revue

Le répertoire de store est créé avec des permissions restrictives et le fichier SQLite avec le mode `0600`. Les paramètres SQL sont liés. Les versions d'état et les verrous interprocessus évitent les écritures concurrentes accidentelles. Ni ces permissions ni un hash SHA-256 ne protègent contre un programme malveillant ayant la même identité OS.

Les reçus sont validés structurellement et confrontés à l'observation persistée avant leur scellement et leur utilisation en revue. Le cache est local, non signé, désactivé par défaut et conservateur. Un administrateur du store peut modifier ses données : il n'y a pas d'attestation cryptographique d'un runner distant.

Les reviewers sont des noms fournis localement. Le seuil de deux noms distincts en mode élevé est un mécanisme de workflow, **pas une preuve qu'il existe deux personnes indépendantes**. Une intégration entreprise doit remplacer cette déclaration par des identités authentifiées et des approbations de forge vérifiées.

## Secrets et diagnostics

Les variables d'environnement sont transmises par liste blanche. Les valeurs de variables aux noms évocateurs de secrets sont masquées dans les diagnostics connus. Ce masquage n'est pas un outil DLP général : un outil peut écrire des données confidentielles ou des secrets inconnus du runner. Les diagnostics, événements et exports doivent rester dans un emplacement de confiance.

Le moteur ne stocke pas par défaut les sorties complètes réussies des commandes, mais leurs hashes et durées. Les descriptions de tâches et résumés sont persistés : ne pas y introduire de secrets inutiles. Le fichier d'authentification du fournisseur ne doit pas être committé ni joint à un rapport.

## Processus et crashes

Sur POSIX, les enfants lancés sont placés dans leur propre groupe. Timeout, annulation et sortie du processus principal arrêtent les descendants ordinaires de ce groupe. Cela ne capture pas un programme hostile qui s'en échappe avec `setsid()`, ni toutes les courses possibles entre création d'un enfant et persistance de son PID.

Après SIGKILL du contrôleur, la récupération refuse un PID connu encore actif. Les zombies Linux ne sont pas considérés comme des processus capables de continuer à écrire. Un PID réutilisé et vivant bloque de façon conservatrice la récupération. L'opérateur doit confirmer l'arrêt de tous les travaux précédents ; aucune garantie d'exécution exactement une fois n'est annoncée.

Les contrôles et étapes de setup doivent être idempotents et sans publication irréversible. Les effets distants, déploiements et migrations actives d'une base partagée ne sont pas des gates ordinaires appropriées à ce runner.

## Ce qui est requis avant une exécution hostile ou partagée

Prévoir une isolation OS/conteneur/VM effectivement testée, un contrôleur séparé des workers, des montages et réseaux limités, une séparation des secrets du fournisseur et des commandes de dépôt, des identités authentifiées et une provenance vérifiable des artefacts. Les recettes de production, PostgreSQL et workers distants sont hors du périmètre de cette livraison. Le connecteur GitHub décrit ci-dessous est local et ne fournit pas de SSO.

SQLite et les exécutables dépendent des versions de Node, Git et des outils installés. Utiliser des versions maintenues et corrigées ; l'absence de dépendances npm de production n'est pas une absence de surface d'attaque. Aucun audit de sécurité externe ou test de pénétration n'a été effectué.

## Product, QA et publication (alpha.2)

Setup/Product/QA sont invités à travailler en lecture seule. Codex reçoit `--sandbox read-only`, tandis que le protocole command ne fournit pas une isolation OS. Le contrôleur vérifie le HEAD et la propreté de leur worktree après sortie ; ce contrôle détecte certaines écritures, pas un accès réseau ou système malveillant. Un workspace altéré n'est pas adopté et reste inspectable.

Les accords de plan/spec/candidat sont distincts. L'appelant local peut néanmoins fournir lui-même un nom de reviewer : l'authenticité d'une permission dépend du workflow humain et de l'OS. Le prompt demande de respecter ce consentement mais ne remplace pas une authentification.

`spec publish` exige deux consentements explicites et un dépôt github.com nommé. Les URL fetch/push doivent correspondre, la branche distante ne doit pas pointer vers un autre candidat et la base doit être celle approuvée. L'adaptateur ne force-pousse, ne fusionne et ne déploie jamais. Il utilise les autorisations Git/gh déjà installées ; il ne connaît pas les règles d'organisation et ne remplace pas les protections de branche. Son test utilise un transport simulé, pas un compte réel.

Les paquets de livraison contiennent critères, observations et diagnostics : les conserver dans un emplacement autorisé. Les destinations redirigeant vers le dépôt/store via un parent symbolique sont refusées. Les empreintes ne sont pas des signatures ; l'utilisateur OS qui contrôle le store reste une autorité de confiance.

## Rôles, skills et Claude (alpha.3)

Les instructions canoniques sont chargées depuis le package de confiance, non depuis un fichier qu'un Implementer peut éditer. Les copies dans le projet sont diagnostiquées par inspect mais ne remplacent pas le runtime. Les fichiers de skills ne sont pas exécutables, leurs références sont bornées à du Markdown et les chemins/symlinks de package sont vérifiés. Ce n'est pas une signature d'éditeur ni une sandbox contre un compte local malveillant.

Claude reçoit une liste restreinte d'outils, sans Bash/MCP/outils web/sous-agents, avec un mode non interactif qui refuse les outils non autorisés. Aucune permission globale de contournement n'est ajoutée. Les fichiers/outils du fournisseur, son authentification et ses politiques administrées ne sont pas certifiés par des tests avec doublure. Les guides locaux, tokens de session et extensions personnelles doivent rester dans la frontière de confiance du déploiement.

Un skill ne peut pas accorder de permissions, modifier une spec ou supprimer un gate. L'audit enregistre l'injection et ses empreintes, pas la compréhension par le modèle. Une instruction de TDD ne signifie pas que la V2 atteste systématiquement un test rouge avant modification. L'Implementer Claude écrit les tests, le runner les exécute ; le rapport doit refléter cette distinction.

Les hooks administrés de Claude peuvent rester actifs malgré la demande `disableAllHooks` de la session. Le moteur ne désactive pas une politique d’organisation. Le déploiement doit examiner ces hooks, les paramètres administrés et le périmètre réel des outils avant un pilote.

## Alpha.5 — scope fluide et previews

L'auto-extension de scope ne s'applique qu'aux **nouveaux** fichiers qui correspondent à une enveloppe `allowedNewPaths`, sous un plafond `maxNewFiles`, et jamais aux chemins classés sensibles. Les fichiers existants restent soumis au scope strict. Les écarts structurels passent par un amendement explicite lié au candidat exact.

Les maquettes UI générées par le contrôleur sont des HTML/CSS statiques : scripts, handlers inline, URLs JavaScript, embeds et ressources distantes sont refusés ; une CSP restrictive est injectée. Elles servent à la revue, pas à l'exécution de code applicatif.

Le review workspace visible est placé à côté du projet pour être ouvrable par l'éditeur. Il contient un worktree Git immuable du candidat ; les secrets et dépendances non suivis du dépôt ne sont pas copiés par ce mécanisme.

## Alpha.8 — OWASP-aware security routing

Alpha.8 ajoute une couche de routage déterministe vers la **OWASP Cheat Sheet Series**. Cette couche ne remplace ni un scanner, ni un audit, ni un test de pénétration et ne constitue pas une déclaration de conformité OWASP.

Le contrôleur construit un `SecurityContext` à partir de la demande, du type de projet et des chemins pertinents. Il peut identifier des surfaces telles que l'authentification, les sessions, l'autorisation, les données sensibles, les uploads, les requêtes sortantes, la persistance, les secrets, les API, l'UI web, CI/CD, les dépendances, les agents IA et MCP. Les sujets OWASP applicables sont ensuite transmis à Product.

Product ne peut pas supprimer silencieusement un sujet routé : chaque sujet doit être relié à une exigence de sécurité vérifiable et à un ou plusieurs critères d'acceptation. Pour les frontières sensibles, un threat model borné devient obligatoire. Pour les comportements exposés, des tests négatifs/adversariaux explicites sont exigés.

Le niveau d'assurance peut être relevé par le contexte de sécurité. Authentification, autorisation, données sensibles, uploads, requêtes sortantes, multi-tenant, secrets, agents/MCP, changements de dépendances et CI/CD forcent actuellement `high`. Cette classification peut produire des faux positifs ou manquer des synonymes : elle constitue un minimum déterministe, pas une analyse sémantique parfaite.

Onboarding découvre uniquement les scanners/contrôles de sécurité **déjà configurés** dans le projet. Il ne télécharge pas et n'invente pas un scanner. Un résultat vert de SAST/SCA/secret scanning reste une preuve bornée à cet outil et à cette exécution.

Le contenu du dépôt, les issues/PR, logs, pages récupérées et descriptions d'outils/MCP sont explicitement marqués comme données non fiables dans les contrats des agents. Ils ne peuvent pas accorder de permissions, demander des secrets ou remplacer la politique du contrôleur. Cette défense réduit le risque de prompt injection indirecte mais ne transforme pas le runner local en sandbox hostile.

Voir `docs/OWASP-SECURITY.md` pour le catalogue et le flux Product → Implementer → QA.
