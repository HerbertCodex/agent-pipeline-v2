---
name: clean-code
description: Write and review readable code, clear names, explicit errors and focused interfaces within the approved scope.
license: MIT
metadata:
  version: "2.0.0-alpha.3"
  origin: "HerbertCodex/agent-pipeline; adapted for V2"
---

# clean-code

## Pipeline contract

This skill provides engineering advice, not mandatory policy or execution permission. The approved spec, role boundaries and configured gates take precedence. Never add approval steps, create new agents, change scope or weaken a gate because of this guide. Examples in references use particular languages; translate their principles to the host stack. Load only references useful for this task. Do not claim a command ran without an observed result.

## Apply

Use domain names, cohesive functions and small explicit interfaces. Prefer a straightforward function to speculative abstractions. Explain non-obvious intent, not the syntax. Keep expected failures distinct from infrastructure errors; preserve context and avoid swallowed exceptions. Review partial writes, cancellation and resource cleanup at external boundaries.

Do not mechanically enforce arbitrary line limits or rewrite adjacent modules for cleanliness. Extract duplication only when the shared responsibility is stable. Measure hot paths before optimizing; prefer bounded work, batching and pagination over unbounded reads.

Remove code made unused by the change and update documentation made false by it, after checking callers, entry points and public compatibility. Keep cleanup within approved scope and report necessary out-of-scope corrections. Distinguish small required corrections from advisory pre-existing debt; a minor severity is not permission to retain a confirmed change-related defect.

## References on demand

- Naming: [naming](references/naming.md).
- Function responsibilities and documentation: [functions](references/functions.md).
- Error and null handling: [robustness](references/robustness.md).
- Interfaces and dependencies: [interfaces](references/interfaces.md), [coupling](references/solid-and-coupling.md).
- Review of a completed change: [checklist](assets/review-checklist.md).

## Review evidence
Judge the diff by understandable domain names, localized responsibilities, explicit error paths, preserved invariants and tests of public behavior. Prefer existing project conventions. Avoid arbitrary line limits or abstraction counts. Include configured build/lint results when available; do not invent an unconfigured quality check.
