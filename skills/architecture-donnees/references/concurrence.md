# Conditions de course : grille de revue

Grille générique, valable pour toute stack et tout stockage. Les noms de produits cités (PostgreSQL, MySQL, SQLite, Redis, DynamoDB, MongoDB, Django, Rails, Prisma, Go, Java, Supabase, SvelteKit, Playwright…) sont des **exemples** marqués comme tels : la règle est la famille et le mécanisme, jamais l'outil. Utilisée par `apv:architecte-donnees` (conception, revue, audit ciblé `/apv:review <cible> concurrence`) et par `apv:qa-securite` pour les familles qui sont aussi des failles.

## 1. Vocabulaire
- **Condition de course** : le résultat dépend de l'ordre, non maîtrisé, dans lequel deux exécutions (requêtes, processus, fils, onglets, tâches planifiées, suites de tests) atteignent une ressource partagée.
- **Section critique** : la suite d'opérations qui doit s'exécuter sans qu'une autre exécution touche la même ressource entre le début et la fin (typiquement : lire, décider, écrire).
- **Lecture-modification-écriture non atomique** : lire une valeur, calculer la nouvelle dans l'application, l'écrire. Entre la lecture et l'écriture, une autre exécution peut écrire : une des deux mises à jour est perdue.
- **Exclusion mutuelle (mutex)** : une seule exécution à la fois dans la section critique. Un mutex en mémoire ne protège **qu'un seul processus** : dès qu'il y a plusieurs instances, fils de travail, conteneurs ou fonctions sans serveur, il ne protège rien. Le verrou doit vivre là où vit la ressource (base, stockage, fichier, service de verrous).
- **Sémaphore** : au plus N exécutions à la fois (pool, débit vers une API externe). Réparti entre processus, c'est un compteur tenu par le stockage avec décrément conditionnel.
- **Opération atomique** : faite en une seule étape indivisible par le stockage (incrément, mise à jour conditionnelle, insertion refusée par une contrainte, création exclusive de fichier, renommage). C'est la protection préférée : pas de verrou à tenir, pas d'ordre à respecter.
- **Ordonnancement** : l'ordre réel d'exécution n'est jamais garanti par l'ordre d'écriture du code, ni par l'ordre d'envoi des requêtes, ni par des horloges différentes. Tout ordre dont dépend la justesse est fixé par un mécanisme (séquence, numéro de version, file, verrou), jamais supposé.
- **Isolation** : ce qu'une transaction voit des autres. Le niveau par défaut de la plupart des bases SQL (lecture validée) **n'empêche pas** la mise à jour perdue d'une lecture-modification-écriture faite dans l'application.

## 2. Principe de décision
Pour chaque écriture, par ordre de préférence :
1. **Rendre l'opération atomique dans le stockage** : la nouvelle valeur calculée par le stockage (`set x = x + 1`), ou une écriture conditionnelle (`where state = 'pending'`, version attendue), ou une contrainte qui refuse le doublon.
2. **Sinon, sérialiser au bon endroit** : verrou de ligne dans une transaction courte, verrou consultatif de transaction, niveau d'isolation sérialisable avec reprise, verrou de fichier ; jamais un mutex en mémoire pour une ressource partagée entre processus.
3. **Rendre la répétition sans effet** (idempotence) quand l'opération peut être rejouée : clé d'idempotence réservée avant l'effet, état final posé au lieu d'un incrément.
4. **Écrire la décision** dans `.apv/data-model.md` (section « Écritures ») : famille, invariant protégé, mécanisme, test qui le prouve.

Une protection seulement dans l'interface (bouton désactivé) n'est jamais suffisante : elle réduit la fréquence, elle ne supprime pas la course (deux onglets, requête rejouée, client modifié).

## 3. Mécanismes par type de stockage (vue générale)
| Besoin | Base SQL | Clé-valeur ou document | Fichiers |
|---|---|---|---|
| Incrément ou décrément sûr | `update t set n = n + 1 where id = $1` ; décrément borné `… set stock = stock - $2 where id = $1 and stock >= $2` (zéro ligne = refus) | incrément atomique natif (exemples : Redis `INCR`, DynamoDB `ADD`, MongoDB `$inc`) avec condition de borne | pas d'incrément sûr sans verrou : fichier verrouillé (`flock` ou équivalent) le temps de lire et réécrire |
| Écrire seulement si l'état attendu est toujours là | `update … where id = $1 and state = 'pending'` ou `and version = $2`, nombre de lignes touchées vérifié | écriture conditionnelle (exemples : DynamoDB `ConditionExpression`, MongoDB filtre sur la version, Redis `WATCH`/`MULTI` ou script atomique) | écriture dans un fichier temporaire puis renommage atomique, après vérification d'une version ou d'une empreinte sous verrou |
| Refuser un doublon | contrainte `unique` (clé naturelle, clé d'idempotence), `insert … on conflict do nothing` ou équivalent (exemples : `on duplicate key` de MySQL, `merge`) | création seulement si absent (exemples : Redis `SET … NX`, DynamoDB `attribute_not_exists`, index unique MongoDB) | création exclusive (`O_CREAT` avec `O_EXCL`, ou `wx` selon le langage) |
| Section critique de lecture puis écriture | transaction courte avec `select … for update` (verrou de ligne), ou verrou consultatif de transaction (exemple PostgreSQL : `pg_advisory_xact_lock`), ou isolation sérialisable **avec reprise** de l'erreur de sérialisation | transaction optimiste avec reprise, ou verrou à bail (clé posée avec expiration et identifiant du détenteur, libérée seulement par lui) | verrou de fichier, ou fichier de verrou créé de façon exclusive avec bail et identifiant du détenteur |
| Réserver du travail entre plusieurs consommateurs | `update … set claimed_by = $1 where id = (select id … for update skip locked limit 1)` ou équivalent | retrait atomique d'une file (exemples : `LMOVE` de Redis, file gérée avec délai de visibilité) | renommage atomique du fichier de travail vers un dossier « en cours » |

Précisions générales :
- **Isolation SQL** : en lecture validée, deux transactions peuvent lire la même valeur puis écrire chacune la sienne. Les niveaux plus stricts ne protègent pas de la même façon selon la base (exemple : en lecture répétable, PostgreSQL signale l'écriture concurrente par une erreur à reprendre, MySQL InnoDB non, sa lecture simple n'est pas verrouillante). Ne jamais compter sur un niveau sans test ; sérialisable exige une boucle de reprise bornée.
- **Base à écrivain unique** (exemple : SQLite) : ouvrir la transaction en écriture dès le début (exemple : `BEGIN IMMEDIATE`) si elle lit puis écrit, sinon l'erreur « base occupée » arrive au pire moment.
- **ORM** : une méthode qui lit l'objet, change un champ et appelle `save()` est une lecture-modification-écriture. Préférer l'expression calculée par la base (exemples : `F()` de Django, `increment` de Prisma, `update_counters` de Rails) ou le verrou explicite (exemples : `select_for_update`, `lock!`, `with_for_update`). Un « trouver ou créer » d'ORM n'est sûr qu'adossé à une contrainte d'unicité.
- **Mémoire d'un seul processus** : mutex, primitives atomiques ou canal (exemples : `sync.Mutex` en Go, `AtomicInteger` en Java, `threading.Lock` en Python). En JavaScript, un seul fil n'empêche pas la course : chaque `await` rend la main et une autre exécution peut passer entre la lecture et l'écriture.
- **Règles de verrouillage** (rappel de la compétence) : transaction courte, aucun appel réseau sous verrou, ordre fixe et écrit, délais d'attente réglés, verrou de transaction plutôt que de session, bail avec expiration pour tout verrou hors base.

## 4. Familles
Pour chaque famille : **Motif à chercher** (ce qui la trahit dans le code), **Question à trancher**, **Corrections acceptables**, **Preuve attendue** (un test qui échoue sur la version non protégée, et passe après la correction).

### 4.1 Lecture-modification-écriture côté application
- **Motif à chercher** : une lecture suivie d'une écriture de la même donnée avec une valeur calculée dans l'application : `count + 1`, `+=`, `balance - amount`, `status = next(status)`, `list.push` puis sauvegarde du document entier ; `find` ou `get` puis `save()` ; un `await` entre la lecture et l'écriture ; un document ou un fichier JSON relu, modifié puis réécrit en entier.
- **Question à trancher** : deux exécutions simultanées de ce chemin peuvent-elles perdre une mise à jour ou casser un invariant (compteur, solde négatif, stock, statut qui recule) ?
- **Corrections acceptables** : calcul fait par le stockage en une instruction ; mise à jour conditionnelle avec vérification du nombre de lignes touchées ; section critique sous verrou de ligne ou verrou de transaction ; pour un document ou un fichier, écriture conditionnelle sur la version ou verrou de fichier plus renommage atomique.
- **Preuve attendue** : deux exécutions forcées à s'entrelacer (deux connexions pilotées pas à pas : les deux lisent, puis les deux écrivent ; ou une pause injectée entre lecture et écriture) ; avant la correction, la valeur finale est fausse (une mise à jour perdue, solde négatif) ; après, elle est juste ou la seconde reçoit un refus propre. En complément, N appels parallèles et l'invariant vérifié à la fin.

### 4.2 Double soumission et rejeu
- **Motif à chercher** : action qui crée ou déclenche quelque chose (commande, message, invitation, paiement) sans clé d'idempotence ni clé naturelle unique ; bouton sans état « en cours » ; formulaire renvoyé par le retour arrière ou le rechargement ; client HTTP ou file de messages qui réessaie automatiquement ; lien à usage unique (réinitialisation, invitation, bon de réduction) marqué « utilisé » par une écriture séparée de la vérification.
- **Question à trancher** : que se passe-t-il si la même requête arrive deux fois, en même temps ou à dix minutes d'intervalle ? Le second effet doit-il être refusé, ou rendre le résultat du premier ?
- **Corrections acceptables** : les trois niveaux de la compétence (interface : bouton en cours et clics suivants ignorés ; serveur : clé d'idempotence générée à l'affichage, stockée avec une contrainte d'unicité, la seconde requête rend le résultat de la première ; stockage : unicité des clés naturelles) ; jeton à usage unique consommé par une écriture conditionnelle (`… set used_at = now() where token = $1 and used_at is null`, une ligne touchée = accepté).
- **Preuve attendue** : double clic simulé dans le navigateur (un seul enregistrement) ; deux requêtes identiques simultanées, même clé (une ligne, même réponse) ; la même requête rejouée plus tard (aucun second effet) ; un jeton à usage unique présenté deux fois en parallèle (une seule réussite).

### 4.3 Mises à jour concurrentes du même enregistrement
- **Motif à chercher** : formulaire de modification qui renvoie tout l'enregistrement sans version ; `update … where id = $1` sans condition sur la version ou la date de modification ; synchronisation hors ligne ou entre appareils qui écrase à l'arrivée ; deux onglets ouverts sur le même objet.
- **Question à trancher** : le « dernier écrit gagne » est-il acceptable pour ce champ (préférence d'affichage) ou fait-il perdre en silence le travail d'un autre onglet, appareil ou utilisateur ?
- **Corrections acceptables** : verrou optimiste (version envoyée avec le formulaire, `where id = $1 and version = $2`, zéro ligne = conflit affiché avec la valeur actuelle, rien d'écrasé) ; mise à jour limitée aux champs modifiés quand ils sont indépendants ; « dernier écrit gagne » assumé et écrit dans le modèle quand la perte est sans conséquence ; fusion explicite pour les données synchronisées.
- **Preuve attendue** : deux mises à jour concurrentes partant de la même version : la seconde reçoit un conflit, la première valeur est intacte, l'interface montre la valeur actuelle.

### 4.4 Vérifier puis agir (TOCTOU)
- **Motif à chercher** : un contrôle suivi d'une action dans une autre instruction ou une autre transaction : `if (!exists) insert`, `if (count < quota) insert`, `if (user.canEdit(doc)) update(doc)` avec des droits relus séparément, `if (file.exists) open`, vérification d'un solde puis débit, « déjà fait ? » puis action.
- **Question à trancher** : l'état vérifié peut-il changer entre la vérification et l'action (autre requête, droit retiré, quota atteint par un appel parallèle, fichier remplacé) ? C'est aussi une faille quand le contrôle porte sur des droits ou un quota (voir `apv:qa-securite`).
- **Corrections acceptables** : faire porter le contrôle **par l'écriture elle-même** (contrainte d'unicité, `insert … select … where (select count(*) …) < $quota` sous verrou, mise à jour conditionnelle) ; vérification et action dans la même transaction sous verrou de la ligne parente ou verrou de transaction ; droits vérifiés dans la requête qui écrit (filtre sur le propriétaire, politique de sécurité au niveau des lignes) ; pour les fichiers, ouvrir puis vérifier le descripteur obtenu, jamais vérifier le chemin puis ouvrir.
- **Preuve attendue** : N appels parallèles au plafond du quota : exactement le plafond réussit ; droit retiré entre la lecture de la page et l'envoi : l'écriture est refusée ; deux créations parallèles d'un objet unique : une seule réussit.

### 4.5 Tâches planifiées qui se chevauchent
- **Motif à chercher** : tâche périodique (cron, minuterie, file) qui lit « les éléments à traiter » puis les traite sans les réserver ; plusieurs instances de l'application qui lancent chacune la même tâche ; exécution plus longue que l'intervalle ; reprise après échec qui retraite tout.
- **Question à trancher** : deux exécutions de la tâche (chevauchement ou instances multiples) peuvent-elles traiter le même élément deux fois, ou une exécution tuée en cours laisser un élément bloqué ?
- **Corrections acceptables** : réservation atomique avant traitement (statut posé par mise à jour conditionnelle, ou prélèvement avec saut des lignes verrouillées), avec échéance de réservation pour récupérer un élément abandonné ; verrou consultatif ou verrou à bail pour une tâche qui doit être unique ; traitement idempotent (clé par élément et par période) pour que la reprise ne duplique rien.
- **Preuve attendue** : deux exécutions de la tâche lancées en même temps sur le même lot : chaque élément traité une seule fois ; une exécution interrompue au milieu puis relancée : aucun élément perdu ni doublé.

### 4.6 Effets externes et clé d'idempotence
- **Motif à chercher** : e-mail, paiement, appel d'API, envoi de fichier vers un stockage objet, déclenché dans la requête ou la tâche avant ou après une écriture locale, sans clé d'idempotence ni réservation ; appel réseau fait pendant qu'un verrou ou une transaction est ouvert ; nouvel essai automatique d'un appel non idempotent.
- **Question à trancher** : si la requête ou la tâche est rejouée, ou échoue après l'effet externe, l'effet est-il fait deux fois, ou fait sans trace locale ?
- **Corrections acceptables** : réserver avant d'agir (ligne « envoi prévu » avec clé unique, puis effet, puis marquage « fait ») ; transmettre une clé d'idempotence au prestataire quand il l'accepte (exemple : en-tête de clé d'idempotence d'un prestataire de paiement) ; boîte d'envoi transactionnelle (l'intention est écrite dans la même transaction que la donnée, un expéditeur unique l'exécute) ; compensation documentée si l'étape suivante échoue ; jamais d'appel réseau sous verrou.
- **Preuve attendue** : faux prestataire local qui compte les appels : la même action rejouée ou lancée deux fois en parallèle produit un seul appel ; échec provoqué après l'effet : la reprise ne le refait pas, ou la compensation l'annule.

### 4.7 Caches et états « prêts » qui mentent
- **Motif à chercher** : attente d'un service fondée sur un indicateur de vie (port ouvert, `/health` à 200, processus lancé) plutôt que sur l'état réellement requis ; cache (schéma, configuration, droits, données) relu après une migration ou une modification sans invalidation ; valeur mise en cache calculée à partir d'une lecture déjà périmée et réécrite après une invalidation (cache qui ressuscite l'ancienne valeur) ; indicateur « prêt » posé avant la fin de l'initialisation.
- **Question à trancher** : qu'est-ce qui prouve que l'état attendu est effectivement servi (nouvelle colonne visible, nouvelle configuration active), et pas seulement que le service répond ?
- **Corrections acceptables** : attendre une preuve de l'état requis (requête qui utilise la nouvelle colonne, version de schéma lue) avec délai borné ; rechargement explicite du cache après chaque migration ou modification ; invalidation après l'écriture, et écriture dans le cache conditionnée à la version lue ; « prêt » posé en dernier.
- **Preuve attendue** : test qui migre puis interroge immédiatement la nouvelle structure par le même chemin que l'application : il échoue (erreur de colonne inconnue, ancienne valeur) sans le rechargement ou l'attente de l'état, passe avec.
- **Exemple observé (anonymisé)** : un cache de schéma d'une API répondait « prêt » juste après une migration mais servait encore l'ancien schéma ; les tests échouaient au hasard sur une colonne « inexistante ».

### 4.8 Ordre des opérations asynchrones dans l'interface
- **Motif à chercher** : état appliqué après une attente sans vérifier qu'il est toujours d'actualité : `await fetch(…)` puis mise à jour de la liste, du focus, de la navigation ou d'un champ ; recherche au fil de la frappe dont une réponse ancienne arrive après une récente ; focus donné, défilement ou sélection faits après une opération lente ; effet de composant qui écrit après le démontage.
- **Question à trancher** : si l'utilisateur agit pendant l'attente (tape, change de page, relance une recherche), l'application écrase-t-elle son action avec un état devenu faux ?
- **Corrections acceptables** : annuler la requête précédente (signal d'annulation) ou ignorer une réponse dont le numéro de requête n'est plus le dernier ; ne pas déplacer le focus si l'élément actif a changé depuis le début de l'attente, ou le donner de façon synchrone avant l'attente ; formulaire en état « en cours » qui bloque les saisies concernées ; nettoyage des effets au démontage.
- **Preuve attendue** : test de navigateur qui retarde la réponse du réseau (interception de la route, exemple : `page.route` de Playwright ; ou horloge simulée dans un test de composant), agit pendant l'attente, puis vérifie que la saisie, le focus ou la liste affichée correspondent à la dernière action ; il échoue sans la correction.
- **Exemple observé (anonymisé)** : le focus était donné à un champ après une opération asynchrone lente ; la saisie déjà commencée par l'utilisateur (et par le test) finissait dans le mauvais champ.

### 4.9 Ressources partagées des tests et de l'outillage
- **Motif à chercher** : plusieurs suites, commandes ou agents qui remettent à zéro, peuplent ou démarrent la même ressource (base locale, conteneur, port fixe, dossier temporaire au nom fixe, navigateur de test, fichier de sortie) ; un verrou différent selon la commande (deux noms, deux fichiers de verrou, un script protégé et un autre non) ; tests qui dépendent de l'ordre d'exécution ou d'un identifiant fixe partagé.
- **Question à trancher** : existe-t-il un seul chemin d'accès à chaque ressource partagée, protégé par un seul verrou, et ce verrou est-il exigé par la ressource (le script refuse de tourner sans lui) plutôt que conseillé ?
- **Corrections acceptables** : une seule porte d'entrée par ressource (un script qui prend le verrou puis lance la commande, toutes les suites passent par lui) ; un seul nom de verrou par ressource, documenté (exemple : `apv lock run <ressource> -- <commande>`) ; le script de remise à zéro qui refuse de s'exécuter sans le verrou ; données de test isolées par suite (schéma, préfixe ou identifiants uniques) ; ports et dossiers alloués dynamiquement.
- **Preuve attendue** : deux suites lancées en même temps par leurs commandes habituelles : la seconde attend la première (journal du verrou) et les deux passent ; lancer la remise à zéro sans le verrou échoue avec un message clair.
- **Exemple observé (anonymisé)** : deux suites de tests utilisaient la même base locale, chacune protégée par un verrou différent ; chacune se croyait seule et remettait la base à zéro sous l'autre.

### 4.10 Horloges et ordonnancement entre processus
- **Motif à chercher** : ordre, ancienneté ou expiration calculés en comparant des horodatages venus de processus, machines ou horloges différents ; horloge monotone propre à un processus (exemples : `performance.now()`, `process.hrtime`, `System.nanoTime`) comparée entre processus ; « dernier écrit gagne » arbitré par l'heure du client ; égalité d'horodatage non départagée ; bail expiré calculé par une horloge et vérifié par une autre.
- **Question à trancher** : l'ordre ou l'expiration dépend-il d'horloges qui ne sont pas la même ? Que se passe-t-il si deux événements ont le même horodatage, ou si une horloge recule ?
- **Corrections acceptables** : faire délivrer l'ordre par la ressource partagée elle-même (séquence de la base, numéro de ticket atomique, version incrémentée par le stockage) ; si une horloge est indispensable, une seule horloge commune (l'heure du stockage, par exemple `now()` de la base, ou l'horloge murale de la même machine) et un départage déterministe (identifiant) en cas d'égalité ; horloge monotone réservée aux durées mesurées dans un même processus ; bail vérifié par l'horloge qui l'a posé, avec marge.
- **Preuve attendue** : test avec horloge injectée qui décale un processus (ou deux demandeurs créés dans un ordre connu avec des origines d'horloge différentes) : le premier demandeur passe le premier ; deux horodatages égaux donnent toujours le même ordre.
- **Exemple observé (anonymisé)** : une file d'attente de verrous triait les demandeurs par un horodatage issu d'une horloge estimée par processus ; un second demandeur pouvait passer devant le premier.

## 5. Preuve : ce qui compte
- Le test **échoue sur la version non protégée** : le rapport dit comment on l'a constaté (commit d'avant la correction, protection retirée localement, sortie de l'échec). Un test qui passait déjà avant ne prouve rien.
- L'entrelacement est **forcé** (deux connexions pilotées, barrière, pause injectée, réponse retardée, horloge simulée) ; « lancer 100 fois et espérer » est un complément, jamais la seule preuve.
- Le test tourne contre le vrai stockage local (jamais une fausse base pour une preuve de concurrence), sous le verrou de la ressource partagée.
- Une protection sans test est « non prouvée » ; un chemin sans protection ni justification écrite est « non conforme ».

## 6. Audit ciblé (`/apv:review <cible> concurrence`)
Lecture seule, sur une copie détachée du commit. Sur un projet existant, l'audit porte sur tout le code, pas seulement sur le diff.
1. **Inventaire** : chercher les motifs de la section 4 dans tout le code suivi (serveur, tâches, scripts, interface, tests, outillage). Exemples de recherches, à adapter au langage : écritures (`update`, `save`, `insert`, `set`, `write`, `put`) proches d'une lecture de la même entité ; `+= `, `+ 1`, `- amount` ; `if (!…) create` ; `await` entre une lecture et une écriture ; tâches planifiées ; appels sortants (e-mail, paiement, `fetch`, client HTTP) ; `focus(`, mises à jour d'état après `await` ; scripts de remise à zéro, fichiers de verrou, ports fixes ; horodatages comparés (`Date.now`, `now()`, `performance.now`, `hrtime`).
2. **Pour chaque chemin trouvé** : famille, invariant en jeu, protection en place (ou « aucune »), statut **conforme**, **non conforme** ou **inconnu**, preuve (test existant qui échoue sans la protection, ou raison pour laquelle aucune n'existe).
3. **Constats** : un chemin non conforme est un constat (gravité selon l'impact : argent, droits, perte de données, doublon visible, gêne), avec la correction acceptable et le test attendu ; « inconnu » dit ce qui manque pour trancher.
4. **Rapport** : l'inventaire complet, même les chemins conformes, sous la forme :

| Emplacement | Famille | Invariant | Protection | Statut | Preuve |
|---|---|---|---|---|---|
| `chemin:ligne` | 4.1 à 4.10 | ce qui ne doit pas casser | mécanisme, ou « aucune » | conforme, non conforme, inconnu | test (nom et échec constaté avant), ou ce qui manque |
