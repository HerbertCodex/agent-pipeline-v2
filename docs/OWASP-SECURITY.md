# OWASP-aware security layer — alpha.8

Agent Pipeline V2 alpha.8 uses the OWASP Cheat Sheet Series as **routed engineering guidance**. It does not claim OWASP certification, complete coverage, penetration testing or absence of vulnerabilities.

## Why routing instead of injecting every cheat sheet

The full OWASP catalog is intentionally not copied into every model context. The deterministic controller derives a bounded `SecurityContext` from the feature request, project type and relevant repository paths, then selects only applicable topic identifiers. Product must convert those identifiers into concrete, verifiable requirements for the current project.

This keeps the security policy stack-agnostic: the controller reasons about surfaces such as authentication, authorization, browser UI, file upload, outbound requests, data sensitivity, CI, dependencies and agent/tool boundaries rather than hard-coding framework names.

## SecurityProfile

The controller can detect these surfaces:

- exposure: `unknown`, `local`, `internal`, `internet`;
- authentication and session state;
- authorization / tenant isolation;
- sensitive data;
- file uploads/imports;
- server-side outbound requests;
- database/persistence;
- secrets;
- API boundaries;
- browser-facing UI;
- CI/CD changes;
- dependency / lockfile changes;
- AI-agent/tool boundaries;
- MCP boundaries.

The detector is deliberately conservative and lexical. It is an applicability router, not a vulnerability scanner.

## Routed OWASP topics

The catalog in `src/security/owasp.ts` currently includes:

- Threat Modeling;
- Authentication;
- Password Storage;
- Session Management;
- Authorization;
- Input Validation;
- Injection Prevention;
- Cross-Site Scripting Prevention;
- CSRF Prevention;
- Content Security Policy;
- File Upload;
- SSRF Prevention;
- REST Security;
- Cryptographic Storage / data protection;
- Secrets Management;
- Logging;
- Software Supply Chain Security;
- GitHub Actions Security;
- AI Agent Security;
- LLM Prompt Injection Prevention;
- Secure Coding with AI;
- MCP Security.

The canonical source URLs are shipped with each topic and exposed through the library API.

## Threat modeling

Security-sensitive trust boundaries cause `requiresThreatModel=true`. Product must then produce a bounded model containing:

- assets;
- trust boundaries;
- threats;
- mitigations;
- acceptance criteria tied to the mitigations;
- assumptions.

Threat categories include STRIDE-style categories plus abuse cases, supply-chain threats and prompt injection. The model is kept inside the approved spec so it evolves with the exact requirement, not as an unaudited side document.

## Security acceptance criteria

For every controller-routed topic Product must create at least one `security.requirements` entry that maps the topic to real acceptance criteria. A spec is rejected if Product silently drops a routed topic, downgrades a detected surface or omits a required threat model.

When `negativeTestsRequired=true`, the plan must also name explicit negative/adversarial tests. Typical examples include unauthorized object access, invalid credentials, forged state-changing requests, malformed input, hostile upload metadata or unsafe outbound destinations. These examples are contextual; the actual tests must match the host stack and approved behavior.

## Risk lane

The deterministic security context can raise the minimum assurance lane:

- no material surface → `fast` is possible;
- ordinary routed guidance → at least `standard`;
- authentication, authorization, sensitive data, uploads, outbound requests, multi-tenant isolation, secrets, AI-agent/MCP, dependency changes or CI/CD → `high`.

The security router can only raise assurance. Product or an agent cannot use it to lower an otherwise required lane.

## Existing scanners and security gates

Onboarding discovers project-owned, non-interactive security scripts such as `security:ci`, `test:security`, `audit:ci`, `sast`, `scan`, `semgrep`, `gitleaks` or `trivy` when they already exist in the project manifest. They become standard/high gates.

Onboarding deliberately does **not** invent a scanner command such as `npm audit`, Semgrep, CodeQL or Trivy when the repository has not configured it. Tool installation, credentials, policies and network access are separate operator decisions.

A passing scanner is evidence for one check. It is never interpreted as proof of security or OWASP compliance.

## Software supply chain

Dependency, lockfile and CI changes are security-sensitive. The pipeline routes supply-chain guidance when those changes are actually in scope, not merely because a repository happens to contain a lockfile. Implementer must not add a package solely because a model hallucinated or suggested a convenient dependency name.

Existing gates and lockfile review remain authoritative. Alpha.8 does not contact vulnerability databases implicitly.

## AI agents, prompt injection and MCP

Repository source, README/ADR text, comments, issues, logs, fetched documents and tool/MCP descriptions are **untrusted task data**. Alpha.8 propagates this trust policy into Product, Implementer, QA, Codex and Claude invocation contexts.

Untrusted text cannot:

- replace controller policy;
- change an approved spec or Decision Ledger;
- grant shell/network/tool permission;
- request secrets;
- disable gates;
- approve a candidate;
- turn model claims into evidence.

Sensitive external actions remain behind explicit consent. This is defense in depth, not a complete prompt-injection proof: providers and local processes still operate inside the local-trusted threat model described in `SECURITY.md`.

## QA security coverage

QA must emit one `securityChecks` result for every approved security requirement. A QA `pass` is rejected by the controller if any required check is missing, `unknown` or `fail`.

QA must inspect actual code, diff, tests and deterministic receipts. It cannot accept a requirement just because code contains words such as `secure`, `auth` or `sanitize`.

In `workflow.qualityReview: "evidence"` mode, QA also provides a `negativeTestChecks` entry for every declared negative scenario. Passing entries must reference existing candidate test files and successful final behavioral receipts whose reviewed `testPaths` cover those files. A scanner receipt or an in-session check alone is insufficient. Missing required evidence blocks with `QA_EVIDENCE` without automatic code repair. An operator who has inspected the missing proof may authorize exactly one repair with `apv2 spec qa-repair SPEC_ID --confirm --note TEXT`, which requires every configured check to have proved this candidate. See [quality and validation](LOT-3-QUALITE.md).

## Primary references

Official OWASP Cheat Sheet Series:

- https://cheatsheetseries.owasp.org/index.html
- https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Software_Supply_Chain_Security_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/GitHub_Actions_Security_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html
