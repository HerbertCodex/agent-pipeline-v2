# Validation de la livraison 2.0.0-alpha.8

Date : 2026-09-14.

Cette validation porte sur le moteur alpha.8. Cette version conserve le Decision Ledger, la gestion structurée des ambiguïtés, le workflow fluide alpha.5/alpha.7 et ajoute une couche de sécurité OWASP-aware déterministe : SecurityProfile/SecurityContext, routage de sujets OWASP, threat modeling conditionnel, critères de sécurité, tests négatifs, sécurité supply-chain/CI et contrôles QA sécurité.

## Environnement

- Node.js : v22.16.0
- npm : 10.9.2
- TypeScript : 5.8.3
- plateforme : Linux x86_64
- aucune revendication d'appel authentifié à Codex, Claude ou GitHub
- aucune revendication de résultat GitHub Actions distant pour cet arbre alpha.8 tant qu'il n'a pas été poussé

## Compilation et suite complète

- `npm run typecheck` : réussi ;
- `npm run build` : réussi ;
- `node dist/cli.js --version` : `2.0.0-alpha.8` ;
- `npm run check` : **350/350 tests**, 0 échec, 0 ignoré (suite exécutée sur l'arbre de travail, pas sur une archive publiée).

Log complet : `validation/alpha.8/check.log`.

Les nouveaux scénarios de sécurité couvrent notamment :

1. authentification/mot de passe → routage Authentication, Password Storage, Session Management, Authorization, Data Protection, Logging et Threat Modeling ;
2. API sortante → SSRF, REST Security, Input Validation et Threat Modeling ;
3. AI agent/MCP → AI Agent Security, LLM Prompt Injection Prevention, Secure Coding with AI, MCP Security et Threat Modeling ;
4. une modification ordinaire n'est pas élevée artificiellement au niveau supply-chain uniquement parce qu'un lockfile existe ailleurs dans le dépôt ;
5. Product ne peut pas supprimer un sujet OWASP routé, réduire une surface détectée ou omettre le threat model requis ;
6. QA ne peut pas rendre `pass` sans une évaluation explicite de chaque exigence sécurité ;
7. Product, Implementer et QA traitent le dépôt et les contenus externes comme des données non fiables vis-à-vis des prompt injections ;
8. le correctif macOS des racines Git via `realpathSync` reste couvert par un test d'ancêtre symbolique.

## Démonstrations

- `npm run demo` : état final `ready` ;
- `npm run demo:lifecycle` : version alpha.8, QA `pass`, état final `closed`.

Ces démonstrations utilisent des fixtures déterministes. Elles ne représentent ni un appel réel à un modèle, ni une revue humaine réelle, ni un déploiement.

Sorties : `validation/alpha.8/demo.json` et `validation/alpha.8/demo-lifecycle.json`.

## Mesures locales

- benchmark synthétique du scheduler : `validation/alpha.8/scheduler-bench.json` ;
- sélection déterministe des skills, 100 résolutions : `validation/alpha.8/guidance-bench.json`.

Ces mesures sont locales et ne constituent ni un benchmark de modèle, ni une promesse de latence sur un projet réel.

## Package installable

Le contrôle du tarball alpha.8 propre a été exécuté par installation npm hors ligne dans un préfixe temporaire. Il vérifie notamment :

- version CLI `2.0.0-alpha.8` ;
- 4 rôles ;
- 6 skills ;
- contrats provider/knowledge/bootstrap ;
- lifecycle installé jusqu'à `closed` ;
- aucun appel fournisseur réel.

Le package n'a aucune dépendance npm de production.

## Documentation et schémas

Les schémas publics sont régénérés depuis la CLI, y compris :

- `security-context.schema.json` ;
- `security-plan.schema.json`.

Le contrôle des liens Markdown relatifs est enregistré dans `validation/alpha.8/docs-links.json`.

## OWASP

Alpha.8 utilise la OWASP Cheat Sheet Series comme guidance d'ingénierie routée. Le catalogue inclut notamment Threat Modeling, Authentication, Password Storage, Session Management, Authorization, Input Validation, Injection Prevention, XSS, CSRF, CSP, File Upload, SSRF, REST Security, Data Protection, Secrets Management, Logging, Software Supply Chain Security, GitHub Actions Security, AI Agent Security, LLM Prompt Injection Prevention, Secure Coding with AI et MCP Security.

Cette intégration ne constitue pas une certification OWASP, un pentest, un scanner universel ni une preuve d'absence de vulnérabilités. Les scanners réellement configurés dans le projet restent des gates bornés et leurs résultats sont des preuves partielles.

## Hygiène de release

Les preuves exécutables de la livraison courante sont regroupées sous `validation/alpha.8/`. Les anciennes validations alpha.2 à alpha.7 ne doivent pas être incluses dans l'archive alpha.8 propre ; l'historique reste dans Git, `CHANGELOG.md` et les documents de migration.

## Pilote réel de réparation des sorties (2026-09-15)

- Commande : `node scripts/repair-pilot.mjs --provider claude --output <dossier neuf> --execute`
- Fournisseur : Claude Code `2.1.267`, authentification locale existante, fixture jetable.
- Résultat observé :
  - 2 validations ;
  - 1 événement `role.output_repair` (code `SCHEMA`) ;
  - la seconde réponse contenait le jeton aléatoire `REPAIR-888ee267` cité uniquement dans l'erreur du contrôleur ;
  - `successfulPilot: true` en 16,7 s.
- Limite de preuve : les événements bruts de ce pilote ne sont pas conservés dans `validation/`. Ce paragraphe est un compte rendu, pas une preuve rejouable ; seul un nouveau `npm run pilot:repair` le reproduit.
- Portée : prouve que la boucle de réparation transmet l'erreur au modèle réel et que ce modèle corrige sa réponse, pour ce fournisseur à cette date. Aucune spec réelle, aucun push, merge ou déploiement. Le pilote complet `provider-pilot.mjs` n'a pas été relancé pour ces changements.
