> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

### Critical — block delivery if any fail
- [ ] Every function has a single, clear responsibility
- [ ] No magic numbers or unexplained string literals
- [ ] No dead code (unused functions, variables, imports)
- [ ] No deep nesting (> 3 levels) — use guard clauses
- [ ] Error handling on every external call (DB, API, file I/O)
- [ ] No O(n²) algorithms when a more efficient approach exists
- [ ] No queries or I/O operations inside loops
- [ ] No synchronous blocking in async code paths

## Code Review Checklist

---

### Immutability & Async
- [ ] Function parameters are not mutated without clear intent — prefer returning new values
- [ ] [JavaScript/TypeScript] `async/await` used consistently, no mixing with `.then()`
- [ ] [JavaScript/TypeScript] No floating promises — every async call is awaited or explicitly fire-and-forget
- [ ] [JavaScript/TypeScript] Independent async calls run in parallel with `Promise.all`

### Error handling
- [ ] No raw strings thrown — typed errors/exceptions used
- [ ] Errors are never silently swallowed (empty catch blocks)
- [ ] Unexpected errors are re-thrown after logging
- [ ] [TypeScript] Expected failures use `Result` type or are clearly documented

### Null / undefined
- [ ] No non-null assertion operators: TypeScript `!`, Kotlin `!!`, Swift `!`, C# `!` (null-forgiving), Rust `.unwrap()` — use guard clauses or explicit checks instead
- [ ] Optional chaining `?.` used where value may be absent
- [ ] Nullish coalescing `??` used instead of `||` for default values
- [ ] Functions don't return `null` without a typed contract — prefer `Result`, empty array, or a thrown error
- [ ] [TypeScript] `strictNullChecks` enabled in `tsconfig.json`

### [TypeScript / typed languages only]
Skip this section if the project is untyped (plain JavaScript, Python without type hints, Ruby, PHP without types, etc.).

- [ ] No `any` — `unknown` used for untyped external data
- [ ] External data (API, user input) validated with a schema library (zod, valibot)
- [ ] No bare `as` casts to override inference — prefer assertion functions (`asserts x is T`) or type guards (`x is T`)
- [ ] No `// @ts-ignore` without a documented reason
- [ ] Switch over a union uses exhaustiveness checking (`never` default) so missing cases are compile errors
- [ ] No weak types (interfaces where every property is optional)

---

### Naming
- [ ] Names reveal intention — no `d`, `tmp`, `data`, `obj`
- [ ] No unexplained abbreviations (common abbreviations like `id`, `url`, `api`, `ctx`, `err`, `db`, `cfg`, `req`, `res` are acceptable — follow your language's conventions)
- [ ] Booleans prefixed with `is` / `has` / `can` / `should`
- [ ] Functions named with verb + noun (`getUserById`, not `user`)
- [ ] Constants in `UPPER_SNAKE_CASE` (or follow your language's convention)
- [ ] No noise words (`UserData`, `UserObject` → `User`)

---

### Documentation
- [ ] Public functions have a docstring when the signature alone doesn't convey the full contract (edge cases, nulls, side effects, valid ranges)
- [ ] Docstring covers: summary, params, return value, exceptions, side effects — only when they add info the types/names don't already give
- [ ] Comments explain WHY, not WHAT
- [ ] No commented-out dead code left behind
- [ ] No AI boilerplate comments: no `// End of function`, `// TODO: review later`, `// Main logic`, `// This function is now complete`, or section dividers
- [ ] No comments that summarize code — if a block needs a label, extract it into a named function

---

### Functions
- [ ] Each function has a single responsibility
- [ ] Functions are focused on one task — split when sections need explaining comments
- [ ] Functions with many parameters (4+) group them into an object/struct
- [ ] No magic numbers — named constants used
- [ ] No duplicated logic — extracted into a shared function (DRY)
- [ ] CQS respected — a function either acts or returns, not both
- [ ] Tell Don't Ask — objects own their own decisions

---

### Design
- [ ] No code written for hypothetical future needs (YAGNI)
- [ ] No unnecessary abstractions or indirection (KISS)
- [ ] No deep inheritance chains — composition preferred
- [ ] Modules are cohesive — things that change together live together
- [ ] Coupling is minimal — modules don't reach into each other's internals
- [ ] Dependencies that need testability/flexibility are injected (Dependency Inversion)
- [ ] Interfaces are narrow — no class implements methods it doesn't use

---

### Robustness
- [ ] Inputs validated at system boundaries (API, user input, external data)
- [ ] Errors thrown early with clear, actionable messages (Fail Fast)
- [ ] No hidden side effects in query methods
- [ ] No premature optimization — complexity justified by a profiled bottleneck

---

### General
- [ ] Code is left cleaner than it was found (Boy Scout Rule)
- [ ] No debug logs or temporary code committed
- [ ] New behavior is covered by tests