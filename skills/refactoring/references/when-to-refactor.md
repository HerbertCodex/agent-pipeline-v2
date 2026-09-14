> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## When to Refactor

> **Note:** Examples use TypeScript. Apply the same refactoring principles in your project's language.

---

### The Rule of Three (Don Knuth)
- First time: just do it
- Second time: note the duplication but proceed
- Third time: refactor

```ts
// First occurrence — write it
function getActiveUsers() {
  return users.filter(u => u.isActive && !u.isDeleted)
}

// Second occurrence — acceptable
function getActiveAdmins() {
  return users.filter(u => u.isActive && !u.isDeleted && u.role === 'admin')
}

// Third occurrence — extract the common filter
function isActiveUser(u: User): boolean {
  return u.isActive && !u.isDeleted
}
function getActiveUsers()  { return users.filter(isActiveUser) }
function getActiveAdmins() { return users.filter(u => isActiveUser(u) && u.role === 'admin') }
function getActiveEditors() { return users.filter(u => isActiveUser(u) && u.role === 'editor') }
```

---

### Refactor before adding a feature
If the existing code makes a feature hard to add — clean it first, then add the feature.
Refactor the area you're about to change — this makes the feature easier to add.
This is Phase 4 (Cleanup) from dev-workflow, done before Phase 2 (Implementation).
Kent Beck: *"Make the change easy, then make the easy change."*

```
❌ Wrong order
1. Add feature to messy code → messy code + new messy code
2. Ship

✅ Right order
1. Refactor the area you're about to touch
2. Add the feature — now it fits cleanly
3. Ship
```

```bash
git commit -m "refactor: extract PaymentProcessor from OrderService"
git commit -m "feat: add PayPal payment method"
# The feature addition is now trivial because the structure is right
```

---

### Refactor after the Green phase in Test Driven Development
In Test Driven Development, the Green phase produces the minimum code to pass the test —
not clean code. The Refactor phase exists precisely for this.

```
🔴 Red   → write failing test
🟢 Green → make it pass (ugly is fine)
🔵 Blue  → now clean it up — this is mandatory, not optional
```

```ts
// Green — works but verbose
function isValidPassword(password: string): boolean {
  if (password.length < 8) return false
  let hasUpper = false
  for (let i = 0; i < password.length; i++) {
    if (password[i] >= 'A' && password[i] <= 'Z') hasUpper = true
  }
  if (!hasUpper) return false
  return true
}

// After Refactor phase — same behavior, cleaner structure
function isValidPassword(password: string): boolean {
  return password.length >= 8 && /[A-Z]/.test(password)
}
```

---

### Boy Scout Rule — refactor what you touch
You don't need to refactor an entire file. Clean up the code you're working on.
Small improvements compound into a significantly cleaner codebase over time.

```ts
// You're fixing a bug in processOrder()
// ❌ Leave surrounding mess untouched
function processOrder(o, f, s) {   // bad names, but "not my problem"
  ...
}

// ✅ Rename while you're here — zero risk, immediate improvement
function processOrder(order: Order, flags: OrderFlags, session: UserSession) {
  ...
}
```

Rule: **improve at least one thing** in every file you touch.
It can be a rename, a constant extraction, a comment — anything.

---

### Managing technical debt
Not all debt needs to be paid immediately. Classify it:

| Type | Description | When to fix |
|---|---|---|
| **Deliberate** | Known shortcut taken consciously | Before it blocks the next feature |
| **Accidental** | Discovered later, not intentional | When working in that area |
| **Bit rot** | Good code that aged poorly | Boy Scout — incrementally |
| **Reckless** | Written without care | As soon as possible — it compounds |

```ts
// ✅ Document deliberate debt explicitly
// TODO: this uses a linear scan — replace with an index when user count > 10k
function findUserByEmail(email: string) {
  return users.find(u => u.email === email)
}
```

Never let debt accumulate silently. A ticket is the answer, not a `TODO`:
many profiles run a comment policy that refuses a `TODO` carrying no linked
issue, precisely because a floating marker records an intention nobody owns.
If you leave one, it names a concrete next action and the issue that will
carry it.

---

### When NOT to refactor

- **Code you won't touch again**: YAGNI — don't clean up code that's stable and will stay that way
- **Before a deadline**: refactoring introduces risk — do it after shipping, not before
- **Without tests**: no safety net = high risk of silent regression
- **When you don't understand the code**: read and understand first, then refactor —
  never refactor code you don't fully understand