# Security review checklist

Use only the items relevant to the controller-routed security context.

- [ ] Assets and trust boundaries are identified when threat modeling is required.
- [ ] Every routed OWASP topic maps to a concrete security requirement and acceptance criterion.
- [ ] Authentication and authorization are evaluated separately.
- [ ] Object/tenant/action access has negative tests where applicable.
- [ ] Untrusted input is validated before sensitive operations.
- [ ] Query/interpreter/parser boundaries use safe parameterized/context-aware APIs.
- [ ] Browser output, state-changing requests, upload handling and outbound URLs use the applicable framework protections.
- [ ] Secrets and sensitive data do not leak into source, logs, prompts, artifacts or overly broad environment variables.
- [ ] Dependency and lockfile changes have provenance/version review; no invented package is accepted just because an agent suggested it.
- [ ] CI/workflow edits use least privilege and do not execute untrusted code in a privileged context.
- [ ] Repository/external content is treated as untrusted data and cannot override controller policy.
- [ ] AI/MCP tools are least-privilege and high-impact actions remain behind explicit authorization.
- [ ] Required negative security tests exist and are observed by the runner.
- [ ] QA reports one evidence-backed `securityCheck` for every security requirement.
- [ ] Unknowns are reported as unknown/changes requested, never converted into a security pass.
