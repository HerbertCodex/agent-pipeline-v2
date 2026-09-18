# Choisir les modèles et réserver une revue approfondie à QA

Le choix est explicite par rôle. La pipeline route les tâches courantes vers `quick`, les tâches à risque élevé vers `deep`, et peut réserver à QA un modèle distinct, y compris chez un autre fournisseur. Elle ne déduit pas la qualité d'un modèle de son nom et ne remplace pas automatiquement un identifiant retiré.

## Nouveau projet ou première installation

Copier [model-selection.example.json](../examples/model-selection.example.json) dans `models.json` et remplacer **tous** les identifiants `YOUR_...` par des modèles accessibles avec vos comptes :

```json
{
  "quick": { "provider": "codex", "model": "YOUR_QUICK_MODEL_ID", "effort": "low" },
  "deep": { "provider": "codex", "model": "YOUR_DEEP_MODEL_ID", "effort": "high" },
  "qa": { "provider": "claude", "model": "YOUR_REVIEW_MODEL_ID", "effort": "high" }
}
```

Les trois choix peuvent utiliser Claude ou Codex. `quick` et `deep` doivent partager le fournisseur d'exécution ; QA peut en utiliser un autre. Les identifiants ne sont pas interchangeables entre fournisseurs. Pour QA, choisir le modèle que vous retenez pour la revue la plus exigeante et un effort élevé, puis mesurer sa capacité à détecter de vrais défauts sur vos tâches. Un effort élevé ne garantit pas une meilleure revue.

```bash
# Cible vide : proposition du socle avec deep, revue sémantique avec qa
apv2 bootstrap --repo /chemin/nouveau-projet --models models.json \
  --review-mode solo --request "Description du besoin"

# Dépôt existant : plan d'installation sans appel modèle
apv2 onboard --repo /chemin/projet --models models.json --review-mode solo
```

`onboard --assist` utilise `deep` pour Setup. Le choix de l'opérateur est réappliqué après sa réponse : Setup ne peut pas le remplacer. Le bootstrap conserve ce choix dans son hash d'approbation et dans le plan d'onboarding qui suit. Les approbations et commandes `apply` restent celles du [cycle de vie](LIFECYCLE.md).

`--models` remplace les options `--provider`, `--agent`, `--config`, `--model` et `--effort` pour cette installation. Il ne migre pas une configuration déjà installée. Sans cette option, les anciens parcours restent disponibles ; un modèle vide utilise toujours le défaut du CLI.

## Routage et QA indépendante

La sélection produit `roles`, `roleProfiles` et `workflow.qaProfile: "deep"` dans `pipeline.v2.json` :

| Rôle | Fast / standard | High |
| --- | --- | --- |
| Product, Design, Implementer | `quick` | `deep` |
| QA, lorsqu'elle est requise | `qa` | `qa` |
| Setup assisté et socle du bootstrap | `deep` | `deep` |
| Revue sémantique du bootstrap | `qa` | `qa` |

Le parcours compact peut toujours dispenser de QA modèle lorsque ses conditions sont réunies. Les preuves déterministes restent obligatoires. Une QA plus exigeante ne crée pas un agent Architect obligatoire et ne rallonge pas le parcours par une revue supplémentaire.

Pour un projet existant, renseigner `roles.qa` (type, modèle, effort et `passEnv` du fournisseur), puis `workflow.qaProfile: "deep"`. Si une entrée QA existe dans `roleProfiles` ou `modelRouting`, la mettre également à jour : une règle `high` exacte prime sur le profil `deep`, qui prime sur `roles.qa`. Le défaut historique `qaProfile: "lane"` conserve le routage selon le risque de la tâche. Les amendements explicites par rôle priment ensuite.

```bash
apv2 models --config /chemin/projet/pipeline.v2.json
apv2 inspect --repo /chemin/projet
```

Ces commandes affichent les choix et leur origine, sans appel payant. `spec show` et le volet « Modèles choisis par rôle » du tableau de bord incluent les amendements opérationnels. Le plan indique une politique, pas la preuve qu'un modèle a déjà été exécuté : les événements d'invocation enregistrent les appels réels.

## Contrôle de compatibilité et coût

Les agents choisis avec `--models` ou `--model` activent `preflight: "probe"`. Sur une configuration existante, ce champ s'active séparément dans `agent` et les rôles natifs explicites ; son défaut est `"off"`. L'adaptateur `command` ne prend pas en charge ce contrôle.

Avant l'appel projet, le contrôleur vérifie l'exécutable et sa version, puis demande une petite réponse structurée fixe. Il utilise un répertoire temporaire distinct et **n'inclut aucun contenu du projet dans le prompt de contrôle**. Claude reçoit une liste d'outils vide ; Codex fonctionne en mode `read-only`. Cela ne constitue pas une nouvelle sandbox OS : l'installation, les hooks et la configuration du CLI restent sous la responsabilité de l'opérateur.

Ce contrôle consomme du quota : au maximum 60 secondes, 3 tours et 0,25 $ par contrôle Claude, réduits par les limites restantes. Codex ne fournit pas ici de plafond monétaire par appel ; les coûts non publiés restent inconnus. Les dépenses déclarées des contrôles réussis **et échoués** entrent dans le journal et dans le budget de la spec. Le temps réservé aux validations est conservé.

Un succès est réutilisé pendant 15 minutes pour la même combinaison fournisseur/modèle/effort/exécutable/environnement, dans la même instance du contrôleur. Un nouveau processus refait le contrôle. Ce cache court n'atteste pas la disponibilité future ; un changement d'authentification hors environnement peut ne pas être détecté avant l'appel suivant. L'appel projet reste contrôlé pour les erreurs de modèle et d'authentification.

Pour tester explicitement tous les choix distincts avant de démarrer une spec :

```bash
apv2 models check --config pipeline.v2.json            # aperçu hors ligne
apv2 models check --config pipeline.v2.json --execute  # appels réels facturables
```

Un succès atteste une réponse structurée avec le CLI et le compte actuels. Il ne vérifie pas la qualité du code, tous les outils du fournisseur, ni le respect futur des critères QA. Les noms et efforts doivent être vérifiés avec le CLI installé ; les alias peuvent évoluer, contrairement à un identifiant de version lorsqu'un fournisseur en propose. Voir la [configuration des modèles Claude Code](https://code.claude.com/docs/en/model-config) et la [configuration Codex](https://developers.openai.com/codex/config-basic/).

## Modèle retiré ou renommé

La pipeline distingue les diagnostics `MODEL_UNAVAILABLE`, `MODEL_AUTH` et `MODEL_EFFORT` lorsqu'ils sont identifiables. Une indisponibilité peut aussi être un défaut d'accès du compte. Les erreurs de quota ne deviennent pas un motif de sélection automatique d'un modèle moins cher.

Préparer un nouveau fichier, puis relire le changement et vérifier sa compatibilité :

```bash
apv2 models replace --config pipeline.v2.json --provider codex \
  --from ANCIEN_ID --to NOUVEL_ID --output pipeline.next.json
apv2 models check --config pipeline.next.json --execute
```

La commande remplace seulement les correspondances exactes du fournisseur dans `agent`, `roles`, `roleProfiles` et `modelRouting`. Elle refuse d'écraser un fichier et ne modifie pas les permissions ni les contrôles. Après revue, adopter cette configuration pour les **nouvelles specs**. Aucun catalogue dynamique ni classement universel des modèles n'est intégré.

Une spec déjà créée conserve sa configuration. Pour changer seulement son modèle QA, préparer `qa-model.json` :

```json
{ "roles": { "qa": { "model": "NOUVEL_ID_QA", "effort": "high" } } }
```

```bash
apv2 spec budget SPEC_ID --file qa-model.json --approve --note "Migration explicite du modèle QA"
apv2 spec show SPEC_ID
```

Reprendre ensuite l'action indiquée par la spec. Les rôles autorisés sont `product`, `design`, `implementer`, `qa` ; les champs modifiables sont modèle, effort, tours, délai et plafond d'appel. Un amendement global `agent.model`/`agent.effort` conserve le choix d'une QA dédiée. Changer de fournisseur, de permissions ou de commandes exige une revue de configuration, pas un amendement de budget.

Les fichiers `claude-short-loop.profiles.json` et les rapports de calibration conservent les choix mesurés à leur date. Ils ne sont pas une recommandation actuelle pour QA ni les valeurs par défaut d'un nouveau projet.
