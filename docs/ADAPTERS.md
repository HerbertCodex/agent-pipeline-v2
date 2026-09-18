# Adaptateurs et compatibilité

Deux adaptateurs natifs sont livrés : **codex** et **claude**. **command** est une interface d'extension, pas une compatibilité automatique avec tous les fournisseurs. Le fournisseur de l'assistant d'éditeur et ceux des rôles de la pipeline sont distincts.

Pour choisir explicitement les profils au démarrage, réserver un modèle à QA, vérifier la compatibilité ou remplacer un identifiant retiré : [gestion des modèles](MODELS.md). Les contrôles réels de compatibilité consomment du quota et ne constituent pas une mesure de qualité.

`agent` configure l'Implementer ; `roles.product` et `roles.qa` héritent de lui si leur valeur est `null`. Le mode Design utilise `roles.design`, sinon Product, sinon `agent`. Les profils `quick`/`deep` et les règles `modelRouting` sélectionnent modèle et effort : voir [la configuration](CONFIGURATION.md#parcours-profils-et-checks-en-session).

## Claude Code CLI

Configuration minimale de l'agent :

```json
{
  "type": "claude",
  "passEnv": ["HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  "maxTurns": 200,
  "maxBudgetUsd": null
}
```

Les variables sont transmises seulement si elles existent ; la configuration contient leurs noms, jamais leurs valeurs. L'installation et l'authentification relèvent de l'opérateur. `command` peut contenir uniquement le chemin de l'exécutable natif. `model` vide utilise le défaut du CLI ; renseigner un modèle pour rendre une comparaison reproductible.

L'adaptateur utilise `--print`, `--output-format json` et `--json-schema`. Il extrait `structured_output` d'une enveloppe `type=result`, `subtype=success`, `is_error=false`. Un refus de permission, une erreur fournisseur, du texte libre, une sortie tronquée ou des champs de verdict interdits ne deviennent pas un succès.

| Rôle | Outils demandés |
| --- | --- |
| Setup, Product, Design, QA | `Read,Glob,Grep` |
| Implementer | `Read,Glob,Grep,Edit,Write` |
| Implementer avec `feedback.gateIds` configuré | Les outils précédents et `mcp__pipeline__run_check` du runner local |

Bash, outils web et sous-agents sont exclus. MCP est désactivé sauf le serveur de feedback configuré par le contrôleur. `--permission-mode dontAsk` et les permissions explicites évitent une attente interactive, sans flag de contournement global. Les scripts du projet sont exécutés par le runner, y compris ceux demandés pendant la session.

Les settings utilisateur/projet et les slash-commands natives sont désactivés pour ces appels. La session demande `disableAllHooks`, mais des hooks imposés par une politique administrée peuvent rester actifs. Ces options ne constituent pas une sandbox OS ni une preuve d'isolation des secrets ; vérifier leur compatibilité avec le CLI installé.

`maxTurns` (1–200, défaut 200) et `maxBudgetUsd` (`null` ou 0,01–1 000 $, défaut `null`) sont des limites **par appel Claude**. Même avec `maxBudgetUsd: null`, le budget restant de la spec peut borner l'appel. Une limite fournisseur peut arrêter la session avant sa réponse finale. Les checkpoints et fichiers déjà produits restent récupérables selon l'étape, pas le raisonnement interne du modèle. Voir [les budgets](CONFIGURATION.md#limites-de-temps-de-tours-et-de-coût).

Les contrats CLI sont testés avec des doublures. Des appels Claude réels ont aussi été effectués sur de petits cas jetables : [calibration conservée](../validation/short-loop-2026-09-18/CALIBRATION.md). Ils ne valident ni toute la sécurité du fournisseur ni la qualité d'une application complète.

## Codex CLI

L'Implementer utilise une invocation `exec --json --sandbox workspace-write` avec stdin, `--output-schema` et `--output-last-message`. Setup/Product/Design/QA utilisent `--sandbox read-only`. Le fichier final est borné en taille et ne peut pas être un lien symbolique. Aucun flag de bypass global n'est ajouté.

L'adaptateur accepte un chemin d'exécutable unique, `model` et `effort`. Les arguments libres supplémentaires sont refusés. Si le feedback est configuré, le contrôleur fournit l'outil local `run_check` à l'Implementer ; les rôles de lecture ne le reçoivent pas.

L'installation et l'authentification appartiennent à l'opérateur. Les noms `HOME`, `CODEX_HOME` et `CODEX_API_KEY` peuvent être ajoutés à `passEnv` ; leur présence ne garantit pas une authentification correcte. Les gates n'héritent pas automatiquement des variables propres au fournisseur.

Les tests vérifient les flags, le schéma, stdin, la sortie structurée et une modification Git avec un faux exécutable. Aucun pilote Codex réel n'est attesté pour les lots 2 et 3. Les tokens éventuellement publiés sont enregistrés ; un coût monétaire absent reste inconnu, sans estimation de facture implicite.

## Adaptateur command

Un programme configuré reçoit sur stdin le protocole `agent-pipeline/v2`, dans le worktree de la tentative : tâche, critères, périmètre, base Git, contraintes, contexte sélectionné, `guidance` et diagnostics précédents. Le wrapper doit utiliser les consignes transmises.

Il termine avec le code zéro et écrit exactement un objet JSON sur stdout :

```json
{ "summary": "Résumé non vide du changement effectué." }
```

Les logs vont sur stderr. Les champs supplémentaires comme `passed`, `approved` ou `proofs` sont refusés ; Git et le runner observent les modifications et produisent les preuves. Si le feedback est activé, le paquet fournit la connexion locale et son jeton de session au wrapper ; ce jeton ne doit pas être journalisé.

```json
{
  "type": "command",
  "command": ["/chemin/worker-executable"],
  "timeoutMs": 1800000,
  "passEnv": []
}
```

Les rôles de lecture utilisent `agent-pipeline/lifecycle-v2` avec `role`, `workspace`, `baseSha`, `guidance`, `context` et `outputSchema`. Le wrapper retourne le JSON demandé par ce schéma : configuration Setup, spec ou bref Product, architecture, design, QA, ou correction. Le schéma transmis fait autorité sur la forme attendue ; Product n'utilise plus systématiquement un seul contrat de sortie. Les rôles de lecture ne doivent pas exécuter les scripts projet ni installer des dépendances.

Les programmes `examples/demo-agent.mjs` et `examples/lifecycle-worker.mjs` sont des fixtures déterministes, pas des fournisseurs IA génériques. Ce protocole ne fournit aucune sandbox.

## Contexte, réparations et preuves

- Les nouvelles tâches reçoivent un contexte sélectionné avec les omissions comptabilisées. Le dépôt reste consultable par l'agent.
- Les checks en session permettent une boucle test/correction immédiate. Le runner limite IDs, appels et durée ; ces diagnostics ne remplacent jamais les reçus de validation finale.
- Une réparation externe conserve le worktree, le contexte utile et les diagnostics. Les appels natifs repartent sans identifiant de thread fournisseur.
- Une sortie de rôle décodée est conservée avant validation. Les corrections natives peuvent utiliser des patches contrôlés ; le document complet est revalidé ensuite. `spec plan-resume` reprend les checkpoints compatibles, notamment une spec acceptée avant un échec de Design.
- QA garde une session indépendante, le diff complet et toutes les obligations. `limits.maxQaDiffBytes` vaut 512 Kio par défaut ; un dépassement bloque au lieu de tronquer silencieusement.

Les schémas de transport sont normalisés par `src/adapters/structured-schema.ts` ; les contraintes retirées pour la compatibilité fournisseur restent vérifiées par le parseur runtime complet. Le journal `invocation.started/finished` distingue coûts connus, inconnus et appels sans résultat, même lorsqu'une sortie est rejetée.

Les contenus du dépôt et des commandes restent des données potentiellement hostiles. Les consignes ne remplacent pas l'isolation d'exécution et la séparation des secrets. Voir [la frontière de confiance](SECURITY.md), [les pilotes](PROVIDER-PILOT.md) et [les sources consultées](SOURCES.md).
