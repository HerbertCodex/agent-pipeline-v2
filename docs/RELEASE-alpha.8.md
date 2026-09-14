# Agent Pipeline V2 2.0.0-alpha.8

Alpha.8 ajoute une couche de sécurité OWASP-aware au workflow déterministe sans transformer les modèles ou scanners en autorités.

## Nouveautés

- `SecurityProfile` et `SecurityContext` déterministes ;
- catalogue OWASP Cheat Sheet borné et URLs officielles ;
- threat modeling conditionnel ;
- exigences sécurité liées aux critères d'acceptation ;
- tests négatifs/adversariaux obligatoires lorsque le contexte l'exige ;
- minimum de risque sécurité qui peut relever une tâche/spec jusqu'à `high` ;
- découverte de scripts de sécurité existants pendant onboarding ;
- supply-chain / CI / dépendances comme surfaces sensibles ;
- policy explicite contre l'indirect prompt injection via dépôt, docs, logs, issues/PR et outils/MCP ;
- `securityChecks` QA obligatoires ;
- schémas publics `security-context` et `security-plan` ;
- workflow GitHub Actions livré avec permissions minimales et actions épinglées à des commits.

## Ce que cette release ne prétend pas

Alpha.8 ne certifie pas la conformité OWASP, n'embarque pas de scanner SAST/SCA universel, n'effectue pas de pentest et n'isole pas du code hostile. Elle reste un runner local de confiance. Les outils de sécurité réellement configurés dans le projet peuvent devenir des gates ; leur résultat reste une preuve bornée.

Voir `OWASP-SECURITY.md`, `SECURITY.md`, `SOURCES.md` et `validation/VALIDATION.md`.
