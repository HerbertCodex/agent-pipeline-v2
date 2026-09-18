# Skills

## Catalogue et origine

Les six familles `clean-code`, `design-patterns`, `refactoring`, `security`, `tdd`, `ui-design` sont adaptées de l'archive V1 fournie. Les six `SKILL.md` ont été révisés pour la V2 ; 42 documents de référence/checklists sont fournis comme exemples techniques, sous MIT. Leur présence ne porte pas automatiquement les contrôles métier V1.

Chaque SKILL.md expose les métadonnées Agent Skills `name`, `description`, `license` et `metadata`. Le manifeste `skills/manifest.json` contient le routage propre au pipeline : rôles, types de projets, mots-clés, liste bornée de références Markdown. Le loader n'est pas un interpréteur YAML général ni un installateur de scripts tiers.

## Configuration explicite

```json
"skills": {
  "enabled": ["clean-code", "design-patterns", "refactoring", "security", "tdd", "ui-design"],
  "projectType": "fullstack",
  "maxContextBytes": 16000
}
```

Ce bloc se place dans `pipeline.v2.json`, puis est revu et committé. Types acceptés : `unknown`, `backend`, `frontend`, `mobile`, `fullstack`, `library`. L'onboarding déduit certains projets frontend depuis les manifests et fichiers connus ; les autres restent `unknown`. L'opérateur ou Setup doit confirmer le type de projet, sans inventer sa stack. `enabled: []` désactive les conseils, **pas les gates**. Une configuration alpha.2 sans ce bloc conserve ce comportement désactivé ; aucune activation cachée.

`clean-code`, `security` et `tdd` s'appliquent aux rôles déclarés. `design-patterns` et `refactoring` ajoutent un filtre lexical sur le texte de la tâche ou du contexte. `ui-design` nécessite un type frontend/mobile/fullstack et un mot-clé d'interface. Setup ne reçoit aucun de ces six skills de développement. Cette heuristique est expliquée et inspectable ; elle n'est pas un classificateur sémantique parfait, et ne porte aucune règle obligatoire.

```bash
apv2 skills list
apv2 skills show security
apv2 skills resolve --config /chemin/projet/pipeline.v2.json --role qa --request "Revoir les permissions de cet endpoint"
apv2 inspect --repo /chemin/projet
```

## Chargement, budget et audit

Le contrôleur injecte les SKILL.md sélectionnés dans `guidance.skills`. Il charge les instructions du rôle depuis `roles/*.md`. Les fichiers complets de référence ne sont pas injectés dans le prompt ; ils sont copiés lors de l'installation approuvée et les chemins relatifs sont indiqués. Un rôle ne doit lire que les ressources utiles.

La limite `maxContextBytes` couvre les corps SKILL.md en UTF-8, pas le prompt entier ni un nombre de tokens. Si un skill ne tient pas, il est omis entièrement avec la raison `context-budget`, jamais tronqué. L'ordre est celui du manifeste. Les autres raisons sont `disabled`, `role`, `project-type`, `task`.

Les événements `agent.guidance` et `role.started.guidance` enregistrent les skills injectés, leurs empreintes de contenu et de bundle, celle du rôle et les exclusions. Ce journal prouve ce que le contrôleur a transmis, **pas ce que le modèle a compris**, ni les références qu'il a effectivement lues. Les copies installées sont inspectées pour détecter la dérive ; le package reste la source runtime. Ne mettre à jour le package qu'entre deux specs.

## Fournisseurs et sécurité

La sélection/injection est la même pour Codex, Claude et command. Un wrapper command doit réellement utiliser `guidance`, sinon sa disponibilité ne signifie pas qu'il exploite ces instructions. Les ressources suivent le format Agent Skills, mais la pipeline ne les enregistre pas implicitement comme slash-commands natives ni comme agents de l'éditeur.

Pour Claude, la découverte native de slash-commands est désactivée dans les invocations contrôlées : c'est le pipeline qui injecte les compétences choisies. Les skills personnels que votre assistant principal utilise sont distincts et ne sont pas attestés par ce journal.

Aucun script de skill n'est exécuté automatiquement. Les instructions, références, conventions et heuristiques n'accordent ni réseau, ni shell, ni secret, ni approbation. Un skill ne peut pas alléger un gate. Les changements de skills, rôles, `.agent-pipeline`, `.agents`, `.claude`, AGENTS.md ou CLAUDE.md déclenchent l'assurance renforcée.

## UI design avant le code

Sur une spec frontend/mobile/fullstack nécessitant une proposition design, `ui-design` intervient pendant cette phase Product. Une retouche UI déclarée `minor` réutilise les conventions existantes sans nouvelle maquette ; un impact `major` conserve la phase Design. Le résultat doit être reviewable avant implémentation : direction visuelle, hiérarchie, écrans, états, responsive, décisions et anti-patterns à éviter. Le skill demande explicitement d'éviter les interfaces génériques de type tableau de bord IA lorsqu'elles ne sont pas justifiées par le produit.

## Skill security et OWASP

Le skill `security` est désormais OWASP-aware. Il inclut un routeur documentaire (`references/owasp-routing.md`) et une référence dédiée aux agents IA / prompt injection (`references/ai-agent-security.md`). Les références complètes ne sont pas injectées systématiquement dans le contexte : seules les instructions courtes du skill le sont, tandis que les fichiers de référence sont installés dans `.agent-pipeline/skills/security/` pour consultation ciblée.

Le skill ne crée ni politique, ni autorisation, ni verdict de conformité. Le `SecurityContext` calculé par le moteur, la spec approuvée et les gates observés restent autoritatifs.

## Conventions CSS et preuves

`ui-design` demande BEM par défaut pour les nouvelles classes de composants en CSS global, sauf convention existante ou décision confirmée différente. CSS Modules, styles encapsulés et frameworks utilitaires conservent leurs conventions. Le framework contrôle son propre CSS avec `npm run lint:css` ; le [profil Stylelint réutilisable](../examples/stylelint-bem.config.mjs) ne s'installe pas automatiquement dans les projets.

Les skills guident les choix ; le mode `workflow.qualityReview: "evidence"` exige séparément les preuves exécutées et la revue structurée. Une instruction de test ou de design pattern n'est pas une preuve de conformité. Voir [les critères de qualité](LOT-3-QUALITE.md).
