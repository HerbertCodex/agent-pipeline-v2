---
name: rgpd
description: "Grille RGPD du DPO d'APV : registre des traitements (finalité, base légale, données, durées, destinataires, droits), registre des sous-traitants vérifié sur les DPA officiels (entité exacte, pays, mécanisme de transfert), confrontation des pages légales au code réel (cookies, tables, export, suppression), modèles de textes sans promesse risquée. À utiliser par l'agent dpo et par le chef de projet dès qu'une spec touche des données personnelles, un prestataire, un traceur ou une page légale."
---

# RGPD dans APV

Ce n'est pas un avis juridique. C'est une méthode pour que les textes publiés disent vrai sur ce que fait le code, et pour signaler à l'éditeur ce qui lui revient.

## 1. Quand
1. **À la spec** : chaque nouveau traitement a sa ligne au registre avant le code.
2. **À chaque nouveau prestataire ou traceur** : registre des sous-traitants mis à jour, sources officielles citées.
3. **Avant chaque livraison** : pages légales confrontées au code (section 4).

## 2. Registre des traitements (`.apv/rgpd/registre-traitements.md`)
Pour chaque traitement : finalité ; base légale (contrat, consentement, intérêt légitime avec sa mise en balance, obligation légale) ; catégories de personnes ; données collectées (tables et colonnes réelles) ; source ; destinataires et sous-traitants ; transferts hors UE ; durée de conservation et mécanisme qui l'applique (purge, suppression différée) ; mesures de sécurité (RLS, chiffrement en transit, accès) ; exercice des droits (accès et portabilité par l'export, rectification, effacement par la suppression de compte, opposition).

## 3. Registre des sous-traitants (`.apv/rgpd/sous-traitants.md`)
Une fiche par prestataire, remplie **depuis ses documents officiels consultés maintenant** (DPA, page des sous-traitants ultérieurs, conditions), jamais de mémoire :
- entité contractante exacte et pays ;
- rôle (sous-traitant, responsable conjoint) et services utilisés ;
- données concernées ;
- région d'hébergement effectivement choisie par le projet (vérifiée dans la configuration du projet, pas supposée) ;
- mécanisme de transfert hors UE prévu par le DPA : clauses contractuelles types, décision d'adéquation, Data Privacy Framework ; on écrit celui que le document prévoit ;
- sources : URL, titre du document, date de consultation.

Leçon du projet pilote : la première version citait le Data Privacy Framework pour Vercel et Supabase alors que leurs DPA reposaient sur les clauses contractuelles types, et « Supabase Inc. » alors que l'entité contractante était Supabase Pte. Ltd. (Singapour). Chaque point se vérifie séparément ; ce qui n'est pas vérifiable est marqué « à vérifier par l'éditeur ».

## 4. Pages légales contre code réel
| Page | À confronter à |
|---|---|
| Cookies | cookies réellement posés (nom exact, finalité, durée, strictement nécessaire ou non), stockage local, absence de traceur tiers ; bannière et consentement si un cookie non nécessaire existe |
| Confidentialité | tables et colonnes de données personnelles, finalités, durées réellement appliquées, sous-traitants et régions, e-mails envoyés, journaux |
| Export (portabilité) | contenu réel de l'export comparé aux tables de l'utilisateur |
| Suppression de compte | effets réels : lignes supprimées en cascade, fichiers de stockage, messages, jetons, e-mails prévus annulés ; ce qui est conservé et pourquoi |
| Mentions légales | identité de l'éditeur et de l'hébergeur |

Méthode : chercher dans le code les appels qui posent des cookies ou écrivent le stockage local, lire les migrations (tables, colonnes, `on delete`), lire les tâches de purge, lancer l'export et la suppression sur un compte de test et comparer. Chaque écart est un constat.

## 5. Ce qui revient à l'éditeur
Identité (nom, adresse, numéro d'immatriculation, directeur de publication, contact), choix de base légale discutable, durée de conservation des sauvegardes, relecture juridique, registre de preuve des demandes d'exercice de droits. On laisse les champs visibles à compléter ; on ne les invente jamais.

## 6. Textes sans promesse risquée
- Écrire ce qui est vrai et vérifiable : « nous hébergeons les données dans l'Union européenne (région <x> de <prestataire>) », pas « vos données ne quittent jamais l'Europe » si un sous-traitant ultérieur peut y accéder.
- Éviter les absolus : « jamais », « aucune donnée », « 100 % sécurisé », « garanti » ; pas de promesse de disponibilité, de délai de support ou de prix que le projet ne peut pas tenir.
- Aucun tiret cadratin ni demi-cadratin. Langue claire, phrases courtes.

Modèles de fiches et de clauses : `references/modeles.md`.
