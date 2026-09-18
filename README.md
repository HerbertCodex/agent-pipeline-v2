<div align="center">

Les changements issus de l’audit du 18 septembre (coûts, reprises, parcours compact/standard/structurant, checks en session, modèles et skills) sont décrits dans [le guide des améliorations](docs/AMELIORATIONS-2026-09-18.md).

# Agent Pipeline V2

### Des agents de développement, sans abandonner le contrôle du workflow.

**Besoin → profil réel du projet → architecture expliquée → spec/design approuvés → code vérifié → candidat relisible → livraison explicite**

<br>

[![Version](https://img.shields.io/badge/version-2.0.0--alpha.8-7c3aed?style=for-the-badge)](#ce-que-change-alpha8)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.16-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](#installation-du-framework)
[![TypeScript](https://img.shields.io/badge/TypeScript-local%20engine-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](#architecture-du-workflow)
[![License](https://img.shields.io/badge/license-MIT-111827?style=for-the-badge)](#documentation)

<br>

**Local-first · deterministic orchestration · stack-agnostic · evidence-driven**

</div>

---

## Pourquoi Agent Pipeline V2 ?

Agent Pipeline V2 est un moteur local TypeScript pour piloter des agents de développement **sans confier l’état du workflow au modèle**.

| Couche | Responsabilité |
|---|---|
| **Product** | cadre le besoin, les critères et les décisions produit |
| **Implementer** | modifie le code et ajoute les tests |
| **QA** | relit le candidat selon le niveau de risque |
| **Orchestrator** | applique les transitions, worktrees, preuves, gates et accords humains |

> **Version : `2.0.0-alpha.8`**  
> Usage local sur des dépôts de confiance. Adaptateurs natifs **Codex CLI** et **Claude Code CLI**, plus un protocole générique `command`.

Ce projet n’est **ni une sandbox OS**, **ni une plateforme multi-utilisateur**, **ni un service de déploiement**.

---

## Tableau de bord

```bash
node "$FRAMEWORK/dist/cli.js" ui            # port 4711 par défaut, --port N pour un autre
```

La commande affiche une adresse `http://127.0.0.1:4711/?token=…` : ouvrez-la **complète**, le jeton ne sert qu'une fois et ne doit pas être partagé. La console montre :

- **les projets** du magasin, avec leurs specs actives et les décisions en attente ;
- **ce qui attend votre décision** : spec à approuver, questions Product, amendement, candidat à relire, blocage ;
- **le détail d'une spec** : étape du cycle, périmètre, critères et verdict QA, tâches avec tentatives et contrôles, maquettes, amendements, tests impactés ;
- **l'activité des agents en direct** et les opérations lancées depuis la page.

Les actions de la CLI y sont disponibles (brouillon, affinage, approbation, exécution, revalidation, nouvelle tentative, amendements, revue, synchronisation, rejet, nettoyage) avec les mêmes garanties : hash ou SHA exact, note obligatoire, identité Git du dépôt comme relecteur. La purge de l'historique reste au terminal. Serveur local sans dépendance, lié à `127.0.0.1`. Détails et garanties de sécurité : [docs/LIFECYCLE.md](docs/LIFECYCLE.md#tableau-de-bord).

## En un coup d’œil

```text
demande utilisateur
        │
        ▼
Project Profile + Decision Ledger
        │
        ▼
Product ────────► Design si nécessaire
        │
        ▼
approbation du bundle exact
        │
        ▼
Implementer → gates → candidat courant
        │
        ▼
QA → réparation bornée si nécessaire
        │
        ▼
review workspace visible
        │
        ▼
revue humaine finale
        │
        ▼
deliver / branch / PR avec consentement
```

### Principes

- **Le modèle propose ; le moteur décide des transitions.**
- **Les décisions de l’opérateur sont persistées et traçables.**
- **La stack influence le contexte, pas les garanties fondamentales.**
- **Les tâches intermédiaires n’imposent pas de micro-revues humaines.**
- **Le code final doit être facilement ouvrable et relisible.**
- **Aucun push, merge ou déploiement implicite.**

---

## Ce que change alpha.8

Alpha.8 conserve le workflow stack-agnostic et le Decision Ledger d’alpha.7, puis ajoute une **couche de sécurité OWASP-aware déterministe** qui suit la spec jusqu’à QA.

### OWASP-aware SecurityProfile

Le contrôleur détecte des **surfaces de sécurité**, pas des frameworks : authentification, autorisation, sessions, données sensibles, uploads, requêtes sortantes, persistance, secrets, API, UI web, CI/CD, dépendances, agents IA et MCP.

Il route ensuite uniquement les sujets OWASP Cheat Sheet applicables, par exemple :

```text
feature / diff / project profile
           │
           ▼
     SecurityProfile
           │
           ▼
 OWASP applicability routing
           │
   ┌───────┼────────┐
   ▼       ▼        ▼
Product  Implementer  QA
```

Ce routage est **une aide d’ingénierie, pas une certification OWASP**.

### Threat modeling + critères de sécurité

Pour une surface sensible, Product doit produire un threat model borné : assets, trust boundaries, menaces, mitigations et critères d’acceptation associés. Chaque sujet OWASP routé doit être couvert par une exigence de sécurité vérifiable.

Lorsque le contexte l’exige, la spec doit aussi prévoir des **tests négatifs/adversariaux**. Une spec ne peut pas être approuvée si Product supprime un sujet routé, réduit une surface détectée ou omet le threat model obligatoire.

### Supply chain, CI et scanners existants

Les changements de dépendances, lockfiles et workflows CI/CD relèvent le niveau d’assurance. Onboarding peut promouvoir les scripts de sécurité **déjà configurés** (`security:*`, `audit:*`, `sast*`, `semgrep*`, `gitleaks*`, `trivy*`, etc.) en gates `standard/high`.

Il n’invente ni n’installe silencieusement un scanner. Un résultat vert reste une preuve bornée à cet outil et à cette exécution.

### Agents IA et prompt injection

Le dépôt, les commentaires, issues/PR, logs, documents récupérés et descriptions d’outils/MCP sont explicitement traités comme **données non fiables**. Ils ne peuvent pas remplacer la politique du contrôleur, élargir les permissions, demander des secrets ou désactiver des gates.

Alpha.8 route également les guides OWASP **AI Agent Security**, **LLM Prompt Injection Prevention**, **Secure Coding with AI** et **MCP Security** lorsque ces surfaces sont concernées.

### QA sécurité obligatoire

QA doit fournir un `securityChecks` pour chaque exigence approuvée. Le moteur refuse un verdict `pass` si un check est manquant, `unknown` ou `fail`.

### Decision Ledger autoritatif

Les décisions explicites sont persistées dans :

```text
.agent-pipeline/
├── ARCHITECTURE.md
├── DECISIONS.json
└── DECISIONS.md
```

Chaque décision peut contenir :

- un identifiant stable ;
- un sujet ;
- une valeur ;
- son niveau d’application ;
- son statut ;
- sa source ;
- une **citation littérale** de l’opérateur.

Exemple conceptuel :

```json
{
  "id": "D-AUTH",
  "subject": "authentication",
  "value": "email/password",
  "enforcement": "product",
  "status": "confirmed",
  "source": "operator",
  "sourceQuote": "email mot de passe"
}
```

### Ambiguïté comme état de première classe

Une décision ne peut être `confirmed` que lorsqu’elle a **une interprétation matérielle unique**.

Une phrase telle que :

```text
"je valide le MVP et le hors MVP, sauf le multi-site"
```

doit rester `ambiguous` tant que l’opérateur n’a pas clarifié ce qu’il veut réellement dire.

Le moteur impose notamment :

- une question de clarification ;
- des interprétations plausibles ;
- aucune résolution silencieuse ;
- une résolution explicite avant approbation Product si l’ambiguïté est métier.

### Trois classes de décision

| Classe | Signification |
|---|---|
| `bootstrap` | nécessaire pour construire un socle technique cohérent |
| `product` | doit devenir un critère ou une règle métier |
| `deferred` | importante, mais non bloquante maintenant |

Cela évite de bloquer le bootstrap sur des sujets comme l’hébergement de production, la CI ou l’email transactionnel lorsque ces décisions peuvent être prises plus tard.

### Revue sémantique indépendante

Un JSON valide n’est pas automatiquement un bon plan.

Une seconde invocation compare indépendamment :

- la demande littérale ;
- le Decision Ledger ;
- l’architecture ;
- les fichiers proposés ;
- la couverture déclarée.

Si elle détecte une contradiction, un oubli ou un affaiblissement d’une décision confirmée :

```text
hash = ""
plan = non approuvable
```

### Propagation jusqu’à QA

Une décision `product` confirmée doit être :

```text
Decision Ledger
    ↓
Product decisionCoverage
    ↓
critère(s) d’acceptation
    ↓
Implementer
    ↓
QA decisionChecks
```

Un verdict QA `pass` est impossible si une décision confirmée est ignorée, échoue ou reste inconnue.

---

## Depuis alpha.8

Ces évolutions viennent du pilotage d'un vrai projet et sont décrites dans [`CHANGELOG.md`](CHANGELOG.md) (section « Non publié ») :

- **tableau de bord local** `apv2 ui`, multi-projets ;
- **recours en cours d'exécution** : correction d'un critère devenu intenable (`spec criterion`), réparation QA qui peut demander un amendement de périmètre, `spec retry` qui reconstruit la tâche à partir de l'état actuel ;
- **la QA juge la spec effective** : critères corrigés et amendements approuvés compris, plus les résumés des tâches ;
- **maquettes** : continuité visuelle entre incréments, polices et images du dépôt, feuilles de style globales du projet ; la maquette approuvée est transmise à l'Implementer et à la QA ;
- **preuves** : adoption des reçus d'une spec à une tâche au lieu de rejouer les contrôles, sans prolonger leur fraîcheur ;
- **fiabilité des rôles** : réparation bornée d'une sortie hors contrat, diagnostics d'échec centrés sur les échecs, avertissement sur les tests impactés (`impactAdvice`) ;
- **livraison** : PR brouillon avant l'approbation pour lire le code (`publish --for-review`), clôture d'une spec relue sans bundle ;
- **maintenance** : `gc`, `prune`, `decisions plan|apply`.

---

<details>
<summary><strong>Voir aussi les améliorations de fluidité conservées depuis alpha.5</strong></summary>

<br>

- `bootstrap` pour un dossier vide ou un dépôt Git sans commit ;
- profil réel du projet à partir du dépôt ;
- rationale, preuves, alternatives et compromis d’architecture ;
- Repository Intelligence sur le SHA courant ;
- réutilisation avant création de nouvelles abstractions ;
- design avant code lorsque l’interface le justifie ;
- absence de revue humaine intermédiaire par tâche ;
- scope adaptatif pour les nouveaux fichiers compagnons sûrs ;
- continuité du `currentSha` pendant QA/réparations/amendements ;
- review workspace visible à côté du projet ;
- mode `solo` sans reviewer fictif ;
- approbations naturelles via `--approve`.

</details>

---

## Framework ≠ application

Gardez le framework séparé du projet qu’il pilote.

```text
workspace/
├── agent-pipeline-v2/        # framework + CLI
└── mon-application/          # projet réel
```

Une URL GitHub peut servir à retrouver ou cloner un dépôt, mais les commandes `--repo` utilisent un **chemin local**.

---

## Installation du framework

### Prérequis

- Git
- **Node.js ≥ 22.16.0**
- Linux ou macOS
- WSL peut fonctionner, sans garantie distincte dans cette alpha

```bash
git clone https://github.com/HerbertCodex/agent-pipeline-v2.git
cd agent-pipeline-v2

node dist/cli.js --version
node dist/cli.js roles
node dist/cli.js skills list
node dist/cli.js providers
```

Le JavaScript compilé est livré. Aucun paquet public homonyme n’est requis.

---

## Démarrage rapide

### Nouveau projet

Pour un dossier vide ou un dépôt sans commit :

```bash
node "$FRAMEWORK/dist/cli.js" bootstrap \
  --repo "$APP" \
  --provider codex \
  --review-mode solo \
  --request "Créer une application de gestion selon les contraintes décrites"
```

Setup propose, **sans écrire l’application** :

- le type de projet ;
- la stack et les outils ;
- les fichiers initiaux ;
- l’architecture et son rationale ;
- les alternatives et compromis ;
- les décisions extraites de la demande ;
- les questions réellement bloquantes ;
- les questions Product ;
- les décisions différées.

Pour enrichir le même cadrage :

```bash
node "$FRAMEWORK/dist/cli.js" bootstrap refine PLAN_ID \
  --request "Précision ou décision supplémentaire"
```

Après revue du hash :

```bash
node "$FRAMEWORK/dist/cli.js" bootstrap apply PLAN_ID \
  --hash HASH \
  --approve \
  --commit
```

Le contrôleur :

1. écrit les fichiers approuvés ;
2. crée le premier commit ;
3. persiste l’architecture et les décisions ;
4. génère le plan d’onboarding.

> Le bootstrap **n’installe pas les dépendances** et **ne lance pas les scripts du projet**.  
> Ces effets restent derrière `doctor --execute`.

---

## Application existante

Commencez par inspecter le dépôt :

```bash
node "$FRAMEWORK/dist/cli.js" inspect --repo "$APP"
```

Puis préparez l’onboarding :

```bash
node "$FRAMEWORK/dist/cli.js" onboard \
  --repo "$APP" \
  --provider codex \
  --review-mode solo
```

L’onboarding découvre les **contrôles réellement disponibles** au lieu d’imposer une liste fixe.

Selon le projet, cela peut être Maven, Gradle, npm, pnpm, pytest, cargo, `go test`, `dotnet test` ou un outil interne.

---

## Cycle d’une spec

Une fois le projet installé, chaque besoin suit le même parcours. Chaque étape humaine porte sur un hash ou un SHA exact.

```bash
# 1. Product rédige la spec (et la maquette si l’interface change)
apv2 spec draft --repo "$APP" --request-file besoin.txt
apv2 spec show SPEC_ID                       # contenu complet + action suivante
apv2 spec refine SPEC_ID --request "Réponses aux questions"

# 2. Approbation du bundle exact spec + design
apv2 spec approve SPEC_ID --hash HASH --approve --note "Ce que j’ai vérifié"

# 3. Tâches, contrôles, QA et réparations bornées
apv2 spec run SPEC_ID

# 4. Revue humaine du candidat final
apv2 spec review SPEC_ID --sha CANDIDATE_SHA --approve --note "Relu dans le dossier de revue"

# 5. Livraison explicite, puis clôture observée
apv2 spec publish SPEC_ID --repository OWNER/REPO --remote origin --name BRANCHE \
  --target main --confirm-push --confirm-pr
apv2 spec sync SPEC_ID                       # la fusion reste faite par l’humain
```

`apv2 spec list --active` liste les specs en cours ; `apv2 spec reject SPEC_ID --note …` abandonne une spec. Tout ce parcours est aussi disponible dans le [tableau de bord](#tableau-de-bord).

### Recours pendant l’exécution

Une spec est immuable dès que l’exécution commence ; les écarts passent par des recours explicites, chacun approuvé à part.

| Situation | Recours |
|---|---|
| un fichier hors périmètre doit changer | amendement proposé par le contrôleur : `spec amend SPEC_ID --amendment ID --approve` |
| un critère interdit ce que le changement approuvé impose | `spec criterion SPEC_ID --criterion AC_ID --file correction.json`, puis approbation de son hash |
| une tentative a échoué | `spec retry SPEC_ID --confirm` : nouvelle tentative reconstruite à partir de l’état actuel |
| une réparation n’a rien changé (`REPAIR_NO_CHANGE`, `NO_CHANGE`) | lire l’explication de l’agent, puis `retry` ou une spec de suivi |
| la preuve de validation a expiré (`STALE_EVIDENCE`) | `spec verify SPEC_ID`, puis `spec run SPEC_ID` |
| le contrôleur a été arrêté brutalement | `spec recover SPEC_ID --confirm-stopped` après vérification des processus |

`spec show` indique toujours l’action suivante qui lève le blocage en cours. Détails : [docs/LIFECYCLE.md](docs/LIFECYCLE.md).

---

## Project Profile : comprendre avant de modifier

La pipeline construit un profil à partir du dépôt réel :

- frontend / backend / fullstack / mobile / desktop ;
- CLI / service / bibliothèque / plugin / monorepo ;
- langages ;
- frameworks ;
- build system ;
- package manager ;
- tests / lint / typecheck / static analysis ;
- frontières de modules ;
- persistance ;
- API publiques ;
- CI et infrastructure ;
- conventions de fichiers propres à la stack.

Les stacks comme **Spring Boot, Next.js, NestJS, SvelteKit, Angular, Django, FastAPI, Go, Rust, .NET, Flutter ou Android** sont des profils possibles, jamais des règles centrales codées dans le workflow.

---

## Repository Intelligence

Avant Product et avant chaque Implementer, le contrôleur inspecte le **SHA immuable courant**.

Il peut faire remonter :

- manifests et build files ;
- ADR et documents d’architecture ;
- fichiers pertinents ;
- modules/packages ;
- fonctions et méthodes ;
- classes ;
- interfaces et types ;
- services/repositories ;
- composants/hooks ;
- utilitaires ;
- API et modèles ;
- tests ;
- candidats potentiels à la réutilisation.

Ordre attendu :

```text
réutiliser
   ↓
étendre
   ↓
refactorer proprement
   ↓
créer en dernier recours
```

Une abstraction créée par une tâche précédente devient visible pour les suivantes via le `currentSha`.

---

## Architecture du workflow

### Mémoire d’architecture

`.agent-pipeline/ARCHITECTURE.md` documente notamment :

- architecture actuelle ;
- frontières de modules ;
- responsabilités ;
- conventions ;
- rationale ;
- alternatives ;
- compromis ;
- contraintes ;
- conditions de réévaluation.

Cette mémoire guide les agents mais **ne remplace jamais l’inspection du code courant**.

### Design avant code

Le Design Gate dépend de la nature du produit :

| Produit | Artefact attendu |
|---|---|
| Web / mobile / desktop | maquette ou preview consultable |
| CLI / TUI | parcours, commandes, erreurs, aide |
| API / bibliothèque | pas de mockup graphique artificiel |

Lorsqu’il est applicable, `ui-design` doit exploiter l’identité visuelle existante et le design system avant d’inventer de nouveaux patterns.

La pipeline évite par défaut :

- dashboards génériques ;
- grilles répétitives de cards ;
- gradients décoratifs gratuits ;
- glassmorphism arbitraire ;
- pills partout ;
- icônes placeholder ;
- hiérarchie visuelle plate.

Le hash d’approbation lie la **spec + les artefacts de design** concernés.

Les maquettes sont écrites dans `../mon-application-review/<spec-id>/design/` (`INDEX.md` et un aperçu HTML par écran), et :

- **prolongent la direction déjà approuvée** pour le dépôt (`establishedDesign`) : seuls les écrans créés ou modifiés sont maquettés, seul le style nouveau est écrit ;
- **peuvent utiliser les polices et images du dépôt** (`assets`, référencées par `url(asset:ID)`) et **charger ses feuilles de style globales** (`stylesheets`), toujours depuis des fichiers suivis par Git ;
- restent des **documents statiques** : ni script, ni ressource distante, ni gestionnaire d’événement ;
- sont **transmises telles qu’approuvées** à l’Implementer, pour ses seuls écrans, et à la QA, qui signale tout écart visible.

---

## Scope adaptatif

Le scope distingue trois cas.

| Cas | Politique |
|---|---|
| **Fichier existant** | strictement borné par Product |
| **Nouveau fichier compagnon sûr** | peut être accepté automatiquement |
| **Expansion structurelle/sensible** | arrêt + amendement + revalidation |

Un fichier compagnon doit rester :

- dans une frontière architecturale approuvée ;
- cohérent avec les conventions détectées ;
- non sensible ;
- sans nouvelle dépendance externe ;
- sans migration de données ;
- sans changement CI/infrastructure/politique ;
- sans rupture importante de contrat public.

Le moteur raisonne sur des **frontières architecturales**, pas sur une liste de noms de fichiers propre à un framework.

---

## Continuité du candidat

Le `currentSha` représente la continuité de travail de la spec.

Lors d’une réparation, d’une QA, d’un amendement ou d’une tâche suivante, la pipeline repart du candidat courant.

Elle ne doit pas revenir silencieusement à `main` ni réimplémenter des changements déjà validés.

---

## Revue finale visible

Avant de demander une approbation humaine :

```text
../mon-application-review/<spec-id>/
├── candidate/          # worktree ouvrable dans l’éditeur
├── candidate.patch
├── design/             # maquettes approuvées, si l’interface change
├── INVENTORY.md
├── QA.md
└── REVIEW.md
```

`REVIEW.md` présente notamment :

- SHA du candidat ;
- risque ;
- mode de revue ;
- fichiers modifiés ;
- gates ;
- QA ;
- réutilisations ;
- nouvelles abstractions ;
- limitations connues.

En mode solo :

```bash
apv2 spec review SPEC_ID \
  --sha CANDIDATE_SHA \
  --approve
```

La CLI peut utiliser `git config user.name` comme label d’audit local.

---

## Preuves et fiabilité des rôles

- **Réparation bornée** : une réponse d’agent qui viole le contrat du contrôleur (schéma, invariants) est renvoyée au même rôle avec l’erreur exacte, jusqu’à `workflow.maxOutputRepairs` fois. Délai, annulation, refus de permission et échec du fournisseur ne sont jamais réessayés.
- **Diagnostics** : un fournisseur ou un contrôle en échec est rapporté avec son code de sortie, sa durée et un extrait centré sur les lignes d’échec.
- **Tests impactés** : avant l’approbation, `impactAdvice` signale les tests existants qui importent un fichier modifié mais sont rangés dans une tâche ultérieure ou nulle part. C’est un avertissement, jamais un blocage.
- **Adoption de preuve** : pour une spec à une tâche, la validation finale adopte les reçus de la tâche quand tout est identique (commit, base, changements, voie de risque, plan de contrôles, environnement remesuré) et que la preuve est encore fraîche. Sinon, les contrôles sont rejoués et la raison est journalisée. L’approbation humaine reste exigée.

---

## Modes de revue

| Risque | `solo` | `team` | `regulated` |
|---|---:|---:|---:|
| `fast` | 0 | 0 | 1 |
| `standard` | 1 | 1 | 1 |
| `high` | 1 | 2 | 2 |

Le nombre de reviewers ne remplace jamais les gates ou QA.

`solo` signifie simplement qu’un projet à une personne n’est pas bloqué par une séparation de responsabilités impossible.

---

## Rôles

| Rôle | Responsabilité |
|---|---|
| **Setup** | profil, configuration, bootstrap et rationale d’architecture |
| **Product** | spec, critères, décisions, réutilisation et design |
| **Implementer** | code + tests, avec réutilisation de l’existant |
| **QA** | critères, diff, preuves et decision checks |
| **Orchestrator** | moteur TypeScript déterministe ; ce n’est pas un cinquième agent |

Les sources runtime sont dans `roles/*.md`.

---

## Skills

Six skills sont livrés :

```text
clean-code
design-patterns
refactoring
security
tdd
ui-design
```

Ils sont sélectionnés de façon déterministe selon :

- le rôle ;
- le type de projet ;
- la tâche.

Ils conseillent l’agent ; **ils n’autorisent jamais une commande et ne peuvent pas alléger un gate**.

---

## Fournisseurs

| Fournisseur | Support |
|---|---|
| **Codex CLI** | adaptateur natif |
| **Claude Code CLI** | adaptateur natif |
| **command** | protocole JSON compatible wrapper |

La commande `providers` vérifie la présence de l’exécutable, pas l’authentification, le quota ou la sécurité réelle du fournisseur.

---

## Frontières de consentement

La fluidité ne signifie pas consentement implicite.

Les opérations suivantes restent séparées lorsqu’elles ont un effet externe ou potentiellement coûteux :

- appel fournisseur lorsqu’il n’est pas déjà autorisé ;
- installation/exécution via `doctor --execute` ;
- changement structurel ou sensible de scope ;
- revue finale ;
- création de branche ;
- push ;
- création de PR ;
- fusion ;
- déploiement.

**Pas de force push. Pas de merge automatique. Pas de déploiement automatique.**

### Modes de livraison

| Commande | Effet |
|---|---|
| `spec deliver SPEC_ID --output NOUVEAU_DOSSIER` | bundle local avec manifeste d’empreintes |
| `spec branch SPEC_ID --name BRANCHE --confirm` | branche locale sur le candidat exact |
| `spec publish … --confirm-push --confirm-pr` | push et PR brouillon GitHub après la revue |
| `spec publish … --for-review` | PR brouillon **avant** la revue, pour lire le code sur la forge (contrôles valides et QA passée exigés) |
| `spec sync SPEC_ID` | observe la PR ; une fusion avant la revue donne `MERGED_BEFORE_REVIEW` |
| `spec close SPEC_ID --target BRANCHE --sha SHA …` | clôture après une intégration locale faite par l’opérateur |

---

## Maintenance

| Commande | Effet |
|---|---|
| `apv2 gc [--confirm]` | retire les workspaces obsolètes ; simulation par défaut, historique intact |
| `apv2 prune [--id ID] [--older-than JOURS] [--confirm]` | efface définitivement les documents abandonnés de plus de 30 jours ; garde la spec qui porte la direction visuelle en vigueur |
| `apv2 decisions plan --repo PATH --file UPDATE.json` | prévisualise un changement du Decision Ledger et son hash |
| `apv2 decisions apply … --hash HASH --approve --note …` | l’applique si le ledger n’a pas changé |

---

## Validation locale

```bash
npm ci --ignore-scripts
npm run check
npm run demo
npm run demo:lifecycle
npm run check:package
```

Les tests utilisent des doublures déterministes pour les fournisseurs sauf pilote explicite.

Une suite verte ne prouve ni la qualité d’un modèle, ni une conformité entreprise.

---

## Documentation

| Document | Sujet |
|---|---|
| [`START-HERE.md`](START-HERE.md) | prompt initial pour l’assistant |
| [`docs/LIFECYCLE.md`](docs/LIFECYCLE.md) | spec, design, exécution, QA, revue, livraison |
| [`docs/LOT-3-QUALITE.md`](docs/LOT-3-QUALITE.md) | grille QA, preuves de validation et activation pour les nouveaux projets |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | architecture du moteur et Repository Intelligence |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Decision Ledger et cohérence sémantique |
| [`docs/OWASP-SECURITY.md`](docs/OWASP-SECURITY.md) | SecurityProfile, routage OWASP, threat modeling et QA sécurité |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | gates, skills, review mode |
| [`docs/ROLES.md`](docs/ROLES.md) | responsabilités des rôles |
| [`docs/SKILLS.md`](docs/SKILLS.md) | skills et sélection |
| [`docs/SECURITY.md`](docs/SECURITY.md) | garanties et limites |
| [`docs/ADAPTERS.md`](docs/ADAPTERS.md) | adaptateurs Codex, Claude Code et `command` |
| [`docs/PROVIDER-PILOT.md`](docs/PROVIDER-PILOT.md) | essais bornés avec un vrai fournisseur |
| [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) | protocole de mesure et interprétation des durées |
| [`docs/MIGRATION.md`](docs/MIGRATION.md) | migration entre versions alpha |
| [`docs/SOURCES.md`](docs/SOURCES.md) | sources externes consultées |
| [`CHANGELOG.md`](CHANGELOG.md) | historique des versions |

---

<div align="center">

### Agent Pipeline V2

**Le modèle construit. Le moteur garde l’état, les preuves et les frontières.**

`2.0.0-alpha.8` · MIT

</div>
