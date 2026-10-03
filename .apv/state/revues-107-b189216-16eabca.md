# Relectures de la PR #107 : commit b189216, puis la pile fusionnée 16eabca

Quatre agents (outil Agent) ont relu b189216 (base apv3), puis 16eabca, la fusion de #106 à 4dc674e.

## Enregistrements
| Domaine | b189216 (critique/haut/moyen/bas) | 16eabca |
|---|---|---|
| securite | 0/0/1/1 | 0/1/3/4 (hérite du haut de 4dc674e) |
| fidelite | 0/0/0/4 | non enregistrée (copie refusée par les permissions de la session) |
| donnees | 0/0/1/4 | non enregistrée (même raison) |
| rgpd | 0/0/1/3 | non enregistrée (même raison) |

Leçon : les relecteurs ne peuvent pas créer une copie de travail hors de leur dossier de session. C'est le chef de projet qui prépare les copies.

## Constats propres à #107 et suite donnée (commit suivant)
- **RGPD B1 / C1 (moyen)** : l'archive du dernier recours emportait le journal de l'opérateur hors de la purge. Désormais, le journal se supprime, et l'archive ne garde que les relectures et les traces de fusion, à supprimer dès qu'elle ne sert plus.
- **Sécurité MOYEN 1 / RGPD B5** : la restauration mettait la clé dans l'historique du shell. Elle passe maintenant par l'entrée standard (Ctrl-D).
- **RGPD B2, B3, B4, C2, C7** : `rsync -a` puis suppression sur l'ancienne machine, formulations non absolues, `~` désigne le dossier du compte.
- **Données B1 et C1 (moyens)** : `apv status` se taisait pour un plugin plus ancien que l'outil à la même version. Il compare maintenant les crochets, agents, compétences et workflows entre le commit d'installation et l'outil (« plus ancien que l'outil »), et signale un commit inconnu. La version passe à 3.0.0-alpha.13.
- **Fidélité 1 / données B4** : « outil » désigne la copie lancée, et la prochaine version se lit dans la marketplace.
- **Données B2** : un fichier illisible est signalé (« état illisible »), et le format 1 est lu.
- **Données B3** : l'entrée retenue est celle de l'utilisateur ou du projet, la clé activée d'abord.
- **Données B5** : git est lancé sans les `GIT_*` de l'appelant, avec GIT_NO_LAZY_FETCH et un délai de 5 s.
- **Données B6** : plafond de 1 Mio, HOME lu dans l'environnement.
- **Données C2** : les commandes `claude plugin` sont à taper dans un terminal, hors de Claude Code.
- **Données C3** : `disableAllHooks` est signalé.
- **Sécurité FAIBLE 2** : le catalogue est nettoyé (ids et besoins en noms simples, textes sans caractère de contrôle).
- **Fidélité 3 et 4** : catalogue précisé et lié aux règles de check.ts par un test.
- **Fidélité 6** : variante macOS de base64.
- Constats hérités de 4dc674e : corrigés dans #106 (aa59c8f), voir revues-106-4dc674e.md.
