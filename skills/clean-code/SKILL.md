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

Do not mechanically enforce arbitrary line limits or rewrite adjacent modules for cleanliness. Do not build a speculative abstraction for a single caller. Measure hot paths before optimizing; prefer bounded work, batching and pagination over unbounded reads.

Reuse before creating. Before writing a UI component, a module or a route, read the project's code map (`.apv/code-map.md`, written by `apv map`) and search the shared component folders (`reuse.shared`). Reuse the existing element, or extend it generically (a parameter, a variant, a slot); never copy it for one feature. An element used by two features becomes shared and parameterized, and its copies are removed in the same change. Native elements the project reserves to its shared components (`reuse.native`: `select`, `dialog`, `datalist` by default) and the primitive classes of its global stylesheet are used as they are, never rebuilt nor restyled locally. Keep typographic values (hours, dates, amounts, number and unit) unbreakable in languages that require it (French: non-breaking or narrow non-breaking space). `apv reuse check` enforces this on what a change adds; its findings are fixed by reusing or factoring, never by lowering a severity or widening `reuse.ignore`.

Remove code made unused by the change and update documentation made false by it, after checking callers, entry points and public compatibility. Keep cleanup within approved scope and report necessary out-of-scope corrections. Distinguish small required corrections from advisory pre-existing debt; a minor severity is not permission to retain a confirmed change-related defect.

## References on demand

- Naming: [naming](references/naming.md).
- Function responsibilities and documentation: [functions](references/functions.md).
- Error and null handling: [robustness](references/robustness.md).
- Interfaces and dependencies: [interfaces](references/interfaces.md), [coupling](references/solid-and-coupling.md).
- Review of a completed change: [checklist](assets/review-checklist.md).

## Review evidence
Judge the diff by reuse first: for every new component, module or block, which existing element should have served (code map, shared folders)? A shared equivalent that exists and is not used is a high-severity finding. Then by understandable domain names, localized responsibilities, explicit error paths, preserved invariants and tests of public behavior. Prefer existing project conventions. Avoid arbitrary line limits or abstraction counts. Include configured build/lint results when available; do not invent an unconfigured quality check.
