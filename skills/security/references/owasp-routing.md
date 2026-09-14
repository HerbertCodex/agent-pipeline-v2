# OWASP-aware routing

Agent Pipeline V2 alpha.8 does not inject the entire OWASP Cheat Sheet Series into every task. The controller detects security surfaces and routes a bounded set of topics into Product, Implementer and QA.

The canonical URLs live in `src/security/owasp.ts`. Product must translate routed topics into project-specific requirements and tests; it must not copy generic advice as unverifiable acceptance criteria.

Typical mappings:

- authentication/passwords → Authentication, Password Storage, Session Management;
- authorization/multi-tenant → Authorization;
- browser UI → XSS and Content Security Policy; authenticated state-changing UI also considers CSRF;
- API → REST Security plus Input Validation;
- persistent/query/parser boundaries → Input Validation and Injection Prevention;
- file upload/import → File Upload;
- server-side outbound URLs/integrations → SSRF Prevention;
- secrets/PII → Secrets Management, Data Protection and safe Logging;
- dependency/lockfile changes → Software Supply Chain Security;
- `.github/workflows` / CI/CD → GitHub Actions Security and supply-chain review;
- AI agents / tool calling → AI Agent Security, LLM Prompt Injection Prevention and Secure Coding with AI;
- MCP → MCP Security in addition to the AI-agent topics.

When material trust boundaries are present the controller also routes Threat Modeling. This is a structured review aid, not a mathematical proof of security.

Official index: https://cheatsheetseries.owasp.org/index.html
