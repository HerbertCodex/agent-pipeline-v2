> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Refactoring Checklist

> **Note:** Examples use TypeScript. Apply the same refactoring principles in your project's language.

---

### Before starting
- [ ] Tests exist for the code being refactored — or characterization tests written first
- [ ] All tests pass before the first change
- [ ] Refactoring is isolated from any behavior change (separate branch or commits)
- [ ] The code to be refactored is understood — no refactoring of code you don't fully grasp

---

### Process
- [ ] One logical transformation at a time (related changes in the same area can be combined)
- [ ] Tests run after every change or group of related changes
- [ ] A failing test triggers an immediate undo — not a fix on top
- [ ] Each safe step or group of related steps committed independently
- [ ] Refactoring commits clearly labeled (`refactor:` prefix)
- [ ] No behavior changes mixed into refactoring commits
- [ ] Parallel Change used when modifying a shared interface with many callers
      (expand → migrate callers one by one → contract)

---

### Code smells addressed
- [ ] No long functions (> ~20 lines) — extracted into named functions
- [ ] No long parameter lists (typically 4+ params) — grouped into parameter objects
- [ ] No duplicated logic — extracted into a shared function (DRY)
- [ ] No God classes — split by responsibility
- [ ] No feature envy — logic moved to the class that owns the data
- [ ] No deep nesting — replaced with guard clauses or extracted helper functions
- [ ] No primitive obsession — Value Objects used for typed concepts
- [ ] No data clumps — grouped into a named object or class
- [ ] No magic numbers — replaced with named constants
- [ ] No commented-out code or unused/dead code — deleted, not commented

---

### Naming
- [ ] All renamed symbols communicate intent — no comment needed to explain them
- [ ] Function names use verb + noun (`calculateTotal`, not `total`)
- [ ] Booleans prefixed with `is` / `has` / `can` / `should`
- [ ] No noise words (`UserData`, `OrderObject` → `User`, `Order`)
- [ ] No AI boilerplate comments, section dividers, or end-of-function markers added during cleanup

---

### After refactoring
- [ ] All tests still pass
- [ ] No new behavior was introduced (diff reviewed for logic changes)
- [ ] The refactored code is easier to understand than before
- [ ] Any `TODO` comments added for known remaining debt include a concrete next action
- [ ] Team notified of significant structural changes (renamed exports, moved files)