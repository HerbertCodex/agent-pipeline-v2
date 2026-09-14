> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Safe Refactoring Process

> **Note:** Examples use TypeScript. Apply the same refactoring principles in your project's language.

---

### The golden rule: tests first
Have tests covering the code you're refactoring. Write characterization tests for code
with complex or unclear behavior — simple renames and extractions may not need them.
A refactoring that breaks behavior without a test catching it is a silent regression.

```ts
// Before touching anything — verify tests pass
// $ npm test → all green

// If tests don't exist for this code — write characterization tests first
// Characterization tests document what the code CURRENTLY does (even if wrong)
test('processOrder returns the correct total for a premium user', async () => {
  const result = await processOrder(premiumUser, items)
  expect(result.total).toBe(90) // capture current behavior before refactoring
})
```

---

### One step at a time
Each refactoring step must be independently safe. Run tests after every change.
If a test fails — undo that single step immediately. Do not pile more changes on top.

```
✅ Safe sequence
1. Rename variable `d` → `discountRate`    → run tests → green ✓
2. Extract `calculateTotal()`              → run tests → green ✓
3. Extract `validateStock()`               → run tests → green ✓
4. Replace magic number with constant      → run tests → green ✓

❌ Risky sequence
1. Rename 5 variables
2. Extract 3 functions
3. Move 2 methods
→ run tests → red — impossible to know which step broke it
```

**How to undo safely:**
- If you just committed the step → `git revert` that commit.
- If you have uncommitted changes → `git stash` or `git checkout -- <files>`.
- If you used an IDE refactoring that failed → use the IDE's undo (Ctrl/Cmd+Z) immediately.
- Never try to "fix forward" until you know why the test failed — the safest path is to get back to green first.

---

### Commit after each safe step
Commit after each safe step or group of related steps — keep commits atomic and revertible.

```bash
git commit -m "refactor: rename d → discountRate"
git commit -m "refactor: extract calculateTotal()"
git commit -m "refactor: extract validateStock()"
git commit -m "refactor: replace magic number with BULK_DISCOUNT_RATE"
```

This makes it trivial to revert a single step without losing all progress.

---

### Separate refactoring from feature work
Never mix a refactoring with a behavior change in the same commit.
It makes code review impossible and bugs untraceable.

```bash
# ✅ Separate commits
git commit -m "refactor: extract calculateTotal() from placeOrder()"
git commit -m "feat: add bulk discount for orders over $1000"

# ❌ Mixed — reviewer can't tell what changed behavior vs what was cleaned up
git commit -m "clean up order logic and add bulk discount"
```

---

### The Mikado Method — for large refactorings
When a refactoring requires touching many files, use the Mikado Method
to avoid getting stuck in a half-refactored state.

```
1. Define the goal: "Extract OrderCalculator from OrderService"
2. Try to make the change naively
3. Note what breaks (compilation errors, failing tests)
4. Revert all changes (git checkout .)
5. Fix the prerequisite first (e.g. "introduce OrderCalculator interface")
6. Commit the prerequisite
7. Try the goal again → repeat until done
```

```
Goal: Extract OrderCalculator
  └─ Prerequisite: introduce OrderCalculator interface
       └─ Prerequisite: move calculateTotal() to Order entity
            └─ Prerequisite: write tests for calculateTotal()  ← start here
```

Work bottom-up — each step is safe and independently committed.

---

### Know when to stop
Refactoring has diminishing returns. Stop when:

- The code communicates its intent clearly
- A new developer could understand it without asking questions
- The next feature can be added without fighting the structure

Don't stop too early:
- "It works" is not the same as "it's clean"
- If you hesitate to touch a function, it's not clean enough yet

Don't over-refactor:
- Perfect is the enemy of good
- If the abstraction is more complex than the problem — simplify
- Code that won't be touched again doesn't need to be perfect