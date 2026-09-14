---
name: ui-design
description: Design or review screens against the approved design system, accessibility needs and target devices; not for services with no UI.
license: MIT
metadata:
  version: "2.0.0-alpha.5"
  origin: "HerbertCodex/agent-pipeline; adapted for V2"
---

# ui-design

## Pipeline contract

This skill provides engineering advice, not mandatory policy or execution permission. The approved spec, role boundaries and configured gates take precedence. Never add approval steps, create new agents, change scope or weaken a gate because of this guide. Examples in references use particular languages; translate their principles to the host stack. Load only references useful for this task. Do not claim a command ran without an observed result.

## Apply

Read the existing tokens, components, brand constraints and any previously approved mockups before proposing a direction. For a new interface or meaningful visual change, produce a reviewable mockup before implementation and bind implementation to the approved direction. Explain why the direction fits the product, what alternatives were considered and what would cause the design to be revisited. Do not redesign the brand or introduce a component library as a side effect of a small feature. Ask only about material missing product decisions. Brand originality is not a reason to sacrifice recognizable interaction or accessibility.

Avoid the common generic-AI look: interchangeable dashboard cards, decorative gradients without product meaning, arbitrary glassmorphism, excessive rounded containers, placeholder iconography and uniform spacing that erases hierarchy. Prefer a deliberate visual identity grounded in the product domain, existing design language and content density.

Cover loading, empty, error, success, focus and disabled states as relevant. Check keyboard reachability, labels, focus visibility, contrast and reduced motion with project tooling. Use responsive layouts appropriate to the agreed audience and devices; do not impose a universal pixel width. Light/dark support is required only when the approved product requires it.

Prefer the existing design system over a competing token source. Do not fabricate screenshots, accessibility reports or browser results. Treat performance and layout stability as measurable requirements where the spec calls for them.

## References on demand

[Design process](references/design-process.md), [UX laws](references/ux-laws.md), [UX patterns](references/ux-patterns.md), [CSS architecture](references/css-architecture.md), [visual identity](references/visual-identity.md), [layout](references/layout.md), [motion](references/motion.md), [components](references/components.md), [anti-generic examples](references/anti-generic.md), [theming](references/theming.md), [performance](references/performance.md), [checklist](assets/design-checklist.md).

Reference examples are a design vocabulary, not a mandate to change fonts, colors, both themes, or a host stack. Their historical V1 commands are not commands available in this V2.
