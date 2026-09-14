---
name: refactoring
description: Restructure existing code without changing observable behavior; use characterization and small bounded changes.
license: MIT
metadata:
  version: "2.0.0-alpha.3"
  origin: "HerbertCodex/agent-pipeline; adapted for V2"
---

# refactoring

## Pipeline contract

This skill provides engineering advice, not mandatory policy or execution permission. The approved spec, role boundaries and configured gates take precedence. Never add approval steps, create new agents, change scope or weaken a gate because of this guide. Examples in references use particular languages; translate their principles to the host stack. Load only references useful for this task. Do not claim a command ran without an observed result.

## Apply

Identify behavior that must remain unchanged, including errors, ordering and side effects. Preserve or add characterization coverage where control flow is poorly understood. Compiler-checked renames may require no new test, but changes in data structures and effects need regression coverage.

Make one coherent transformation at a time. Keep the approved scope; do not opportunistically redesign neighboring modules. Separate intentional feature changes from structural changes. Stop when the stated maintainability problem is resolved, not when every possible smell disappears.

## References on demand

- Diagnosis: [code smells](references/code-smells.md).
- Transformations: [techniques](references/techniques.md).
- Timing and scope: [when to refactor](references/when-to-refactor.md).
- Safe procedure: [safe process](references/safe-process.md).
- Review: [checklist](assets/refactoring-checklist.md).
