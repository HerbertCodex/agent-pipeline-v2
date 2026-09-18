# Références des interfaces externes

Historique des sources primaires consultées pour la compatibilité des adaptateurs, à partir du 12 septembre 2026. Les URL et descriptions ci-dessous ne constituent pas une vérification de leur état actuel ; les invocations implémentées sont décrites dans [Adaptateurs](ADAPTERS.md). Leur consultation n'est pas un test d'intégration authentifié.

1. OpenAI, Codex, mode non interactif : `https://developers.openai.com/codex/noninteractive/` (redirige vers `https://learn.chatgpt.com/docs/non-interactive-mode`). Invocation exec, stdin, sandbox et sortie structurée.
2. OpenAI, Structured model outputs : `https://developers.openai.com/api/docs/guides/structured-outputs`. Sous-ensemble JSON Schema, propriétés requises, objets fermés et constructions non supportées telles que allOf.
3. GitHub CLI, gh pr create : `https://cli.github.com/manual/gh_pr_create`. Options head/base/repo, draft, body-file et no-maintainer-edit.
4. GitHub CLI, gh pr view : `https://cli.github.com/manual/gh_pr_view`. Champs JSON de tête/base, état, fusion et dépôt.
5. GitHub CLI, gh pr list : `https://cli.github.com/manual/gh_pr_list`. Réconciliation d'une PR existante à partir de la branche/base avant un nouvel effet de publication.

Sources de vérité de cette livraison : `src/` pour les garanties codées, `test/` pour les scénarios exécutés, `validation/` pour les sorties réellement obtenues. Les fixtures ne représentent pas une évaluation de la qualité d'un modèle ni une mesure de latence d'un projet entreprise.

## Interfaces consultées pour alpha.3

6. Anthropic, Claude Code CLI reference, consulté le 12 septembre 2026 : `https://code.claude.com/docs/en/cli-reference`. Print, outils, permissions, settings, sorties JSON, limites de tours et budget.
7. Anthropic, Run Claude Code programmatically : `https://code.claude.com/docs/en/headless`. Enveloppe JSON et champ structured_output.
8. Anthropic, Settings : `https://code.claude.com/docs/en/configuration`, et Hooks : `https://code.claude.com/docs/en/hooks-guide`. Paramètres de session et disableAllHooks ; les hooks administrés peuvent rester actifs.
9. Anthropic, Skills : `https://code.claude.com/docs/en/skills`. Distinction entre skills portables et découverte propre au fournisseur.
10. Agent Skills, Specification : `https://agentskills.io/specification`. SKILL.md, métadonnées et références chargées progressivement.
11. OpenAI, Skills : `https://developers.openai.com/codex/skills/` (redirection documentaire possible). Le format ne signifie pas que le framework enregistre automatiquement des slash-commands.

Une documentation consultée n'est pas un essai réel de fournisseur. Les métadonnées des tests et les limites sont consignées dans validation/VALIDATION.md.

## OWASP Cheat Sheet Series — alpha.8

Sources primaires consultées pour le routage de sécurité alpha.8, le 14 septembre 2026. Elles fournissent des recommandations ; leur présence dans le package n'est ni une certification ni un audit externe.

12. OWASP Cheat Sheet Series index: `https://cheatsheetseries.owasp.org/index.html`.
13. OWASP Threat Modeling Cheat Sheet: `https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html`.
14. OWASP Authentication Cheat Sheet: `https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html`.
15. OWASP Authorization Cheat Sheet: `https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html`.
16. OWASP Input Validation Cheat Sheet: `https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html`.
17. OWASP Software Supply Chain Security Cheat Sheet: `https://cheatsheetseries.owasp.org/cheatsheets/Software_Supply_Chain_Security_Cheat_Sheet.html`.
18. OWASP GitHub Actions Security Cheat Sheet: `https://cheatsheetseries.owasp.org/cheatsheets/GitHub_Actions_Security_Cheat_Sheet.html`.
19. OWASP AI Agent Security Cheat Sheet: `https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html`.
20. OWASP LLM Prompt Injection Prevention Cheat Sheet: `https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html`.
21. OWASP Secure Coding with AI Cheat Sheet: `https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html`.
22. OWASP MCP Security Cheat Sheet: `https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html`.
