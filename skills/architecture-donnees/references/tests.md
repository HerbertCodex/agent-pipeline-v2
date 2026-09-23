# Tests exigés pour les données

Tests exécutés contre la vraie base locale (jamais une fausse base), qui échouent si le service manque (jamais de saut). Ressources partagées sous bail : `apv lock run <ressource> -- <commande>`.

## Écritures uniques et concurrence
- **Double clic simulé** sur chaque action qui écrit (navigateur) : un seul enregistrement créé, un seul envoi, bouton en état « en cours » pendant la requête.
- **Deux requêtes identiques simultanées** au serveur, même clé d'idempotence : une seule ligne, la seconde réponse renvoie le résultat de la première.
- **Clés différentes sur une ressource unique** (un seul brouillon ouvert, un seul envoi par période) : une seule réussit, l'autre reçoit un refus propre.
- **Deux mises à jour concurrentes de la même ligne** (versions identiques) : la seconde reçoit un conflit, aucune donnée perdue, la valeur actuelle est affichée.
- **Invariant sous charge** (quota, « déjà fait ») : N appels parallèles, l'invariant tient.

## Transactions et compensation
- Échec provoqué à chaque étape d'une écriture multiple : aucune écriture partielle.
- Étape externe (stockage, e-mail) : l'échec de la suite annule l'étape faite (compensation), ou la reprise ne duplique rien (idempotence).

## Isolation (RLS)
- Deux utilisateurs A et B : B ne lit, ne modifie, ne supprime aucune ligne de A, ni par l'application ni par l'API directe avec son jeton.
- Colonnes réservées : mise à jour directe refusée.
- Valeurs hors plage : insertion directe refusée par la contrainte, et la validation serveur donne la même borne.

## Performance
- Nombre de requêtes par chargement de page mesuré et borné (pas de N+1).
- `EXPLAIN` des requêtes principales sur un volume réaliste : pas de parcours séquentiel d'une table utilisateur au-delà du seuil fixé dans le modèle.
- Données de page : aucune colonne non affichée n'est envoyée au navigateur.

## Migrations
- Rejouées depuis une base vide.
- Appliquées sur une base qui contient déjà des données (reprise sans perte).
