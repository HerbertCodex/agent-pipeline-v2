> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Design Patterns Checklist

---

### Before applying a pattern
- [ ] There is a concrete problem that justifies this pattern (not applied "just in case")
- [ ] A simpler solution (plain function, plain object) was considered and rejected
- [ ] The pattern name is reflected in the code (`UserFactory`, `PaymentStrategy`, `OrderObserver`)
- [ ] A comment explains which pattern is used and why, if the team may not recognize it
- [ ] No "future-proofing" reason — the pattern solves a current pain point, not a hypothetical one

---

### Creational
- [ ] **Factory**: object creation is centralized — no `new ClassName()` scattered across the codebase
- [ ] **Factory**: adding a new type should require minimal changes — a registry, a config map, or a new factory method
- [ ] **Builder**: `build()` validates that required fields are present before returning the object
- [ ] **Builder**: each builder method returns `this` for fluent chaining
- [ ] **Singleton**: truly only one instance is needed (not just convenient) — DI considered first
- [ ] **Singleton**: module-level instance or DI container preferred over class-level Singleton — adapt to your language's module system

---

### Structural
- [ ] **Adapter**: the adapted class is fully hidden — callers only see your interface
- [ ] **Decorator**: each decorator adds one behavior — multiple decorators compose cleanly
- [ ] **Decorator**: decorators can be composed in any order
- [ ] **Facade**: the subsystem's internal classes are not exposed through the facade
- [ ] **Proxy**: the proxy implements the same interface as the real object
- [ ] **Proxy**: the proxy delegates to the real object — no business logic added

---

### Behavioral
- [ ] **Strategy**: strategies are stateless where possible (easier to test and compose)
- [ ] **Strategy**: the strategy registry is the only place to add/remove a variant
- [ ] **State**: each state handles the actions valid for that state — invalid actions can throw or return a no-op
- [ ] **State**: state transitions happen inside state classes — not in the context object
- [ ] **Observer**: subscribers should generally be independent — if execution order matters, document it explicitly
- [ ] **Observer**: unsubscribe/cleanup is handled to prevent memory leaks
- [ ] **Command**: every `execute()` has a corresponding `undo()` if the domain requires reversibility — undo() is optional
- [ ] **Command**: commands are self-contained — no shared mutable state between them
- [ ] **Chain of Responsibility**: each handler does exactly one thing
- [ ] **Chain of Responsibility**: handlers are stateless and reusable across chains
- [ ] **Chain of Responsibility**: every handler either calls `next()` or terminates explicitly (returns a result, throws an error, or stops processing)
- [ ] **Iterator**: the iterator implements the language's native iterable protocol (e.g., `Symbol.iterator` / `Symbol.asyncIterator` [JavaScript/TypeScript], `__iter__` [Python], `Iterator` trait [Rust])

---

### General
- [ ] No pattern applied without a concrete problem it solves
- [ ] No Singleton used as a substitute for dependency injection
- [ ] No Strategy or Factory with only one variant (use a plain function instead)
- [ ] No Observer with a single subscriber (use a direct function call instead)