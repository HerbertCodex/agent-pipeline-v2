---
name: design-patterns
description: Choose an adapter, strategy or other pattern only for a concrete structural problem; prefer simple functions first.
license: MIT
metadata:
  version: "2.0.0-alpha.3"
  origin: "HerbertCodex/agent-pipeline; adapted for V2"
---

# design-patterns

## Pipeline contract

This skill provides engineering advice, not mandatory policy or execution permission. The approved spec, role boundaries and configured gates take precedence. Never add approval steps, create new agents, change scope or weaken a gate because of this guide. Examples in references use particular languages; translate their principles to the host stack. Load only references useful for this task. Do not claim a command ran without an observed result.

## Decide

Name the present problem in one sentence. Consider a plain function or module first. Introduce a pattern only if that simpler form cannot address the existing coupling, variation or lifecycle problem. Explain the trade-off and test the boundary rather than the pattern's name.

Adapter translates an external protocol without leaking provider details into the domain. Strategy varies one behavior behind a small interface. State represents transitions; it is not synonymous with a collection of unrelated algorithms. Prefer injected dependencies to singletons and avoid a factory hierarchy for hypothetical extensions.

## References on demand

- Selection: [when to use](references/when-to-use.md).
- Creation: [creational](references/creational.md).
- Interface adaptation: [structural](references/structural.md).
- Behavior and state: [behavioral](references/behavioral.md).
- Review: [checklist](assets/patterns-checklist.md).
