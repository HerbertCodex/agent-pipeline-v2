# Adaptateurs et compatibilité

Deux adaptateurs natifs sont livrés : **codex** et **claude**. **command** reste une interface d'extension, pas une compatibilité automatique avec tous les fournisseurs. Le fournisseur de votre assistant d'éditeur et celui des exécutants sont distincts.

## Claude Code CLI (alpha.3)

Configuration minimale : `{"type":"claude","passEnv":["HOME","CLAUDE_CONFIG_DIR","ANTHROPIC_API_KEY","CLAUDE_CODE_OAUTH_TOKEN"],"maxTurns":32,"maxBudgetUsd":5}`. Les variables n'ont pas à toutes exister ; elles ne contiennent jamais de valeurs dans la configuration. L'installation et l'authentification de Claude relèvent de l'opérateur. `command` peut contenir uniquement le chemin de l'exécutable natif. `model` est facultatif ; aucun nom de modèle n'est fixé par défaut.

L'adaptateur utilise le mode non interactif `--print`, l'entrée texte, `--output-format json` et `--json-schema`. Il extrait exclusivement `structured_output` d'une enveloppe `type=result`, `subtype=success`, `is_error=false`. Une erreur, un dépassement de budget, des refus de permission signalés, une sortie tronquée, du texte libre ou des champs de preuve interdits ne deviennent jamais un succès.

Setup/Product/QA : `Read,Glob,Grep`. Implementer : les mêmes plus `Edit,Write`. Les outils shell, web, sous-agents et MCP ne sont pas demandés ; les MCP sont explicitement exclus. `--permission-mode dontAsk` et une liste explicite de permissions empêchent une demande interactive de suspendre le processus. **Aucun flag de contournement global n'est utilisé.** Les scripts du projet sont exécutés uniquement par le runner configuré.

Les sources de settings utilisateur/projet sont désactivées pour ces appels ; la désactivation des hooks est demandée par configuration de session et les slash-commands natives ne sont pas chargées. Des hooks imposés par une politique administrée peuvent rester actifs : la session ne les neutralise pas. Les politiques administrées du fournisseur restent applicables. Cela ne constitue ni une sandbox OS ni une preuve d'isolation de fichiers/secrets. La compatibilité de ces options doit être vérifiée avec la version CLI réellement installée.

`maxTurns` (1–200, défaut 32) et `maxBudgetUsd` (null ou 0.01–1000) concernent Claude. Le plafond de coût passe au fournisseur ; le moteur ne vérifie pas une facture ni la tarification d'un abonnement. Le timeout du moteur demeure actif. Ces deux champs n'ajoutent pas de budget fournisseur aux autres adaptateurs.

Les skills du pipeline sont injectés par `guidance`, indépendamment de la découverte native. QA reçoit le diff complet calculé par le contrôleur, limité à 512 Kio ; dépassement = blocage explicite, pas revue partielle silencieuse.

**Tests annoncés :** sorties, paramètres, refus, changement Git réel et cycle Product → implémentation → QA → correction avec une doublure CLI. **Non exécuté :** appel authentifié Claude, mesure de coût ou sécurité du fournisseur. Le même niveau de preuve contractuelle s'applique à Codex. Voir [le pilote réel](PROVIDER-PILOT.md).


## Adaptateur command

Un programme configuré par l'opérateur reçoit sur stdin un JSON de protocole `agent-pipeline/v2`. Le champ additionnel `guidance` transmet les instructions du rôle et les skills sélectionnés ; le wrapper doit les utiliser. Il est lancé dans le worktree de la tentative. Le paquet contient la tâche, les critères, le scope prévu, le commit de base, les contraintes et les diagnostics du cycle précédent.

Il doit terminer avec un code zéro et écrire **exactement** un objet JSON sur stdout :

```json
{ "summary": "Résumé non vide du changement effectué." }
```

Les logs libres doivent aller sur stderr. Les champs supplémentaires tels que `passed`, `approved` ou `proofs` sont refusés : un worker ne choisit pas son verdict. Ses changements sont observés ensuite par Git et par le runner de contrôles.

Exemple de configuration :

```json
{
  "type": "command",
  "command": ["/chemin/worker-executable"],
  "timeoutMs": 900000,
  "passEnv": []
}
```

Ce protocole permet d'ajouter un moteur sans imposer son SDK au domaine. Il n'ajoute pas de sandbox. Le worker de `examples/demo-agent.mjs` est un programme déterministe limité à la fixture `DEMO-ADD` ; ce n'est pas un fournisseur IA générique.

## Adaptateur Codex CLI

L'adaptateur compose une invocation non interactive avec stdin, `--sandbox workspace-write`, `--output-schema` et `--output-last-message`. Il peut recevoir un chemin d'exécutable unique et un champ `model`. Les arguments libres supplémentaires sont refusés plutôt qu'ignorés. Le fichier final est borné en taille et ne peut pas être un lien symbolique.

La politique d'authentification et l'installation de Codex appartiennent à l'opérateur. L'exemple transmet les noms `HOME`, `CODEX_HOME`, `CODEX_API_KEY` uniquement à l'agent si ces variables existent. Leur présence ne garantit pas qu'une authentification correcte soit configurée. Les contrôles n'héritent pas automatiquement de ces variables.

Les options proviennent de la documentation officielle du mode non interactif, consultée pour cette livraison :

```text
https://developers.openai.com/codex/noninteractive/
```

**Validation effectuée :** contrat CLI avec un faux exécutable vérifiant les flags, le JSON Schema, stdin et le fichier final, puis écrivant une vraie modification Git. **Non effectuée :** appel authentifié à Codex, test d'un modèle, validation du sandbox fournisseur ou mesure des coûts. Il faut vérifier la compatibilité avec la version exacte de Codex retenue par l'équipe avant de lui donner un dépôt réel.

## Sessions et réparations

Le worktree de réalisation est conservé. Un nouvel appel du programme reçoit les diagnostics d'échec et voit le code déjà produit. Cette alpha ne réutilise pas un identifiant de thread du fournisseur et ne prétend pas conserver son contexte conversationnel. Ajouter la reprise de session derrière cette interface est une amélioration identifiée, indépendante de la machine à états.

Les sorties du dépôt et des commandes sont des données potentiellement hostiles. Le paquet de contraintes ne constitue pas une défense suffisante contre l'injection de prompt : l'isolation d'exécution, les permissions et la séparation des secrets doivent être assurées par le déploiement.

## Rôles Setup, Product et QA (alpha.2)

Le protocole de rôle est `agent-pipeline/lifecycle-v2`, distinct du protocole d'implémentation. Il fournit `role`, `workspace`, `baseSha`, `instructions`, `context` et `outputSchema` sur stdin. Le programme command retourne un unique JSON conforme au rôle sur stdout ; les logs vont sur stderr. Le programme doit s'abstenir d'installer des dépendances ou d'exécuter les scripts projet pendant ces rôles de lecture.

Product répond par la spec exportée dans `spec.schema.json`, QA par `qa.schema.json`, Setup par un objet config/questions/notes. Pour Codex et Claude, les profils sont choisis via `roles.product`/`roles.qa`, avec héritage de `agent` pour null. Le fichier d'exemple `examples/lifecycle-worker.mjs` implémente les deux protocoles uniquement pour une fixture déterministe ; ce n'est pas une IA. Un exécutable existant d'un autre fournisseur n'est pas compatible automatiquement sans ce raccordement.

Pour Codex, Setup/Product/QA utilisent une nouvelle invocation `exec --sandbox read-only` avec fichiers de schéma et sortie. L'Implementer utilise workspace-write. L'intégration ne garantit pas que le fournisseur autorisera un accès réseau ou une opération spécifique ; calibrer la politique sans utiliser de bypass global.

La fonction commune `adapters/structured-schema.ts` normalise les schémas de transport en forme/type/enum, propriétés requises et objets fermés. Les défauts, `allOf` et bornes avancées ne sont pas envoyés au fournisseur. Les schémas runtime complets continuent à rejeter chaînes vides/interdites, NUL, nombres hors bornes et données incohérentes. Cette séparation évite une incompatibilité du format provider sans assouplir l'acceptation finale.

Les tests incluent un faux exécutable Codex pour Product et pour l'Implementer, les flags, les sorties et les schémas. Aucun appel authentifié Product/QA/Codex n'est revendiqué. Les reviews de modèle et de forge nécessitent un pilote réel avant confiance en production.
