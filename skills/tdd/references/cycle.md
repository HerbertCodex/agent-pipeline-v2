> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

> **Language-agnostic**: Examples use Jest and TypeScript. Apply the same cycle with your project's test framework and language. For framework equivalents, see `references/language-transposition.md`.

## Red / Green / Refactor cycle

---

### 🔴 Red — write a failing test

Write a test that describes *one* behavior. Run it. It must fail — if it passes
immediately, either the behavior already exists or the test is wrong.

```ts
// Example domain — apply the same cycle to your project's domain
// New feature: password validation
// Start with the simplest case first
test('rejects a password shorter than 8 characters', () => {
  expect(isValidPassword('Ab1')).toBe(false)
})
// Run → ❌ isValidPassword is not defined — expected failure
```

Rules for the Red phase:
- Describe behavior from the caller's perspective, not the implementation
- Start with the simplest, most obvious case
- Don't write multiple tests — one at a time
- Don't touch implementation code yet

---

### 🟢 Green — make it pass with minimal code

Write the least code that makes the test pass. No cleanup. No anticipation.
It's okay if the code is ugly — that's what Refactor is for.

```ts
// Minimal implementation — only handles the one failing test
function isValidPassword(password: string): boolean {
  return password.length >= 8
}
// Run → ✅ passes
```

Rules for the Green phase:
- No premature abstraction (YAGNI)
- No handling of cases not yet covered by a test
- If tempted to add more logic — write a test for it first

---

### 🔵 Refactor — clean up under green

All tests pass. Now improve the code without changing behavior.
Run tests after every change — if one breaks, undo immediately.

```ts
// After several Red/Green cycles, the naive implementation looks like this:
function isValidPassword(password: string): boolean {
  if (password.length < 8) return false
  let hasUpper = false
  for (let i = 0; i < password.length; i++) {
    if (password[i] >= 'A' && password[i] <= 'Z') hasUpper = true
  }
  if (!hasUpper) return false
  let hasDigit = false
  for (let i = 0; i < password.length; i++) {
    if (password[i] >= '0' && password[i] <= '9') hasDigit = true
  }
  if (!hasDigit) return false
  return true
}

// Refactored — same behavior, all tests still green
function isValidPassword(password: string): boolean {
  const hasMinLength = password.length >= 8
  const hasUpperCase = /[A-Z]/.test(password)
  const hasDigit     = /[0-9]/.test(password)
  return hasMinLength && hasUpperCase && hasDigit
}
```

Rules for the Refactor phase:
- Run tests after every change — not just at the end
- Apply clean code principles: naming, SRP, DRY, KISS
- Never add new behavior during refactor — that's a new Red/Green cycle
- If a refactor breaks a test → undo and rethink

---

### Full cycle example — from scratch

```ts
// Cycle 1 — simplest case
test('returns 0 for an empty cart', () => {         // 🔴 Red
  expect(calculateTotal([])).toBe(0)
})
function calculateTotal(items: Item[]): number {    // 🟢 Green
  return 0
}

// Cycle 2 — single item
test('returns the price of a single item', () => {  // 🔴 Red
  expect(calculateTotal([{ price: 10 }])).toBe(10)
})
function calculateTotal(items: Item[]): number {    // 🟢 Green
  return items.reduce((sum, item) => sum + item.price, 0)
}
// 🔵 Refactor — nothing to clean up yet

// Cycle 3 — discount
test('applies a percentage discount', () => {       // 🔴 Red
  expect(calculateTotal([{ price: 100 }], 0.1)).toBe(90)
})
function calculateTotal(                            // 🟢 Green
  items: Item[],
  discountRate = 0
): number {
  const subtotal = items.reduce((sum, item) => sum + item.price, 0)
  return subtotal * (1 - discountRate)
}
// 🔵 Refactor — extract subtotal into a named variable (already done above)
```

Notice: the implementation grew *only* as fast as the tests demanded it.

---

### What if the Red step can't fail?

A test that passes immediately in the Red phase is a warning sign. Treat it as one of:

1. **Behavior already exists** — you are documenting existing behavior, not adding
   new behavior. Convert it to a characterization test and keep it.
2. **Test is not exercising the code** — the function is not imported, the wrong
   module is tested, or the assertion is too weak. Fix the test before writing
   implementation.
3. **Assertion is tautological** — e.g. `expect(true).toBe(true)` or comparing an
   object to itself. Rewrite the assertion to check an actual outcome.

Never move to Green with a test that has never failed.
