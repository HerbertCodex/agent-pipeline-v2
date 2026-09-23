# Compétences du plugin APV3

Chaque dossier contient un `SKILL.md` (frontmatter `name`, `description`, et pour les commandes `argument-hint`, `allowed-tools`, `disable-model-invocation` quand la commande a des effets). Le plugin s'appelant `apv`, une compétence se charge par l'outil Skill sous le nom `apv:<dossier>` et une commande se tape `/apv:<dossier>`. Guide du plugin : [docs/PLUGIN.md](../docs/PLUGIN.md).

## Commandes

| Commande | Rôle | Réservée à l'opérateur |
|---|---|---|
| `init` | prépare `.apv/` d'un nouveau projet (`apv init`, contrôles détectés, consigne commune, registre) | oui |
| `spec` | fait rédiger et valider une spec (`apv spec new`, agent `product`, `apv spec validate`) | non |
| `run` | exécute une spec jusqu'à la PR brouillon, pilotée par l'état `apv run` ([docs/RUN.md](../docs/RUN.md)) | oui |
| `review` | revues indépendantes en parallèle sur copies détachées, constats consolidés | non |
| `stack` | fusionne une pile de PR (`apv stack plan`, puis `apv stack merge`) sur ordre explicite | oui |
| `design` | boucle de maquette par artefact jusqu'à la validation de l'opérateur | non |
| `preview` | met à jour et annonce l'aperçu vivant | non |
| `status`, `quota`, `resume` | état du projet, relevé de quota, reprise après coupure | non |
| `onboard` | migration d'un projet V2 (phase 4) | oui |

Une commande « réservée à l'opérateur » porte `disable-model-invocation: true` : Claude ne la charge pas de lui-même.

## Méthode

- `chef-de-projet` : la méthode complète du chef de projet et ses références (planification, consigne commune, intégration et revues, livraison et pile de PR, quota et sauvegarde, reprise et environnement, journal).
- `design-artefact` : la boucle de maquette, résumée pour les rôles.
- `rgpd` : grille du DPO, registres, modèles de textes sans promesse risquée.
- `architecture-donnees` : règles du modèle de données (spécification, section 13 bis), exemples SQL et tests.

## Compétences héritées de V2

`clean-code`, `design-patterns`, `refactoring`, `security`, `tdd`, `ui-design` sont adaptées de l'archive V1 fournie par l'utilisateur (`agent-pipeline-main.zip`, version déclarée 0.6.3 ; projet d'origine HerbertCodex/agent-pipeline, licence MIT), révisées pour V2, avec leurs références et listes de vérification. Ce n'est pas une copie octet pour octet de l'étiquette 0.6.3. `manifest.json` garde leur routage V2 (rôles, types de projet, mots-clés, références) ; il ne concerne que ces six compétences. Détails : [docs/SKILLS.md](../docs/SKILLS.md).

Aucune compétence n'exécute de script, n'accorde de permission ni ne crée d'agent par elle-même : les commandes appellent l'outil `apv` et lancent les agents du plugin par les outils de Claude Code.
