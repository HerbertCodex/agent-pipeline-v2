---
name: tdd
description: Design focused regression tests for features and fixes; distinguish observed failures, characterization and unexecuted tests.
license: MIT
metadata:
  version: "2.0.0-alpha.3"
  origin: "HerbertCodex/agent-pipeline; adapted for V2"
---

# tdd

## Pipeline contract

This skill provides engineering advice, not mandatory policy or execution permission. The approved spec, role boundaries and configured gates take precedence. Never add approval steps, create new agents, change scope or weaken a gate because of this guide. Examples in references use particular languages; translate their principles to the host stack. Load only references useful for this task. Do not claim a command ran without an observed result.

## Apply

For a bug, write a test that isolates the wrong behavior. For a feature, express an observable acceptance criterion. Verify a failure is relevant: missing infrastructure is not evidence that the intended assertion fails. Implement the smallest coherent change, then inspect the actual runner results and regression coverage.

Do not require a separate Test Writer agent or multiple administrative commits. This V2 does not guarantee a recorded pre-implementation red run. When the provider cannot execute commands, write tests and let the deterministic runner run them; explicitly distinguish the proposed regression test from an observed red/green cycle. Do not rerun an identical receipt merely to satisfy a ritual.

For existing behavior, characterization tests may start green. Prefer behavior-level tests; mock external boundaries, not the implementation being tested. Include negative and boundary cases when the criterion requires them. Test names explain behavior, not internal method names.

## References on demand

[Cycle](references/cycle.md), [language transposition](references/language-transposition.md), [test types](references/test-types.md), [writing tests](references/writing-tests.md), [mocking](references/mocking.md), [review checklist](assets/test-checklist.md).
