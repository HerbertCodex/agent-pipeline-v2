> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Functions & Classes

> **Language note:** Examples use JavaScript/TypeScript. Apply the same principles in your project's language, following its idioms and conventions.

---

### Documenting functions (docstrings)
Document a public function when any of the following is true:

1. It has a side effect (mutates state, writes to disk, sends a request, updates cache, emits an event).
2. It accepts a value with a valid range, format, or precondition that isn't enforced by the type system.
3. It returns something other than what the name implies, or can return `null` / an empty result.
4. It throws / errors in specific, recoverable situations.
5. It behaves differently from a similarly named function in the codebase.

If none of the above apply and the function name + types tell the whole story, skip the docstring — don't document the obvious.

Use the convention of your language — the structure is the same across all of them.

The goal: a caller should understand the function's contract without reading its body — but a docstring that restates the obvious is noise, not documentation.

```js
// JavaScript — JSDoc
/**
 * Calculates the total price of an order after applying a discount.
 *
 * @param {number} subtotal - The pre-discount amount in cents.
 * @param {number} discountRate - A value between 0 and 1 (e.g. 0.1 for 10%).
 * @returns {number} The final price in cents.
 * @throws {Error} If discountRate is outside [0, 1].
 */
function calculateDiscountedPrice(subtotal, discountRate) { ... }
```

```python
# Python — docstring (Google style)
def calculate_discounted_price(subtotal: int, discount_rate: float) -> int:
    """
    Calculates the total price of an order after applying a discount.

    Args:
        subtotal: The pre-discount amount in cents.
        discount_rate: A value between 0 and 1 (e.g. 0.1 for 10%).

    Returns:
        The final price in cents.

    Raises:
        ValueError: If discount_rate is outside [0, 1].
    """
```

```java
// Java — Javadoc
/**
 * Calculates the total price of an order after applying a discount.
 *
 * @param subtotal     The pre-discount amount in cents.
 * @param discountRate A value between 0 and 1 (e.g. 0.1 for 10%).
 * @return             The final price in cents.
 * @throws IllegalArgumentException If discountRate is outside [0, 1].
 */
public int calculateDiscountedPrice(int subtotal, double discountRate) { ... }
```

```csharp
// C# — XML doc
/// <summary>
/// Calculates the total price of an order after applying a discount.
/// </summary>
/// <param name="subtotal">The pre-discount amount in cents.</param>
/// <param name="discountRate">A value between 0 and 1 (e.g. 0.1 for 10%).</param>
/// <returns>The final price in cents.</returns>
/// <exception cref="ArgumentException">If discountRate is outside [0, 1].</exception>
public int CalculateDiscountedPrice(int subtotal, double discountRate) { ... }
```

### What to always include in a docstring
- **One-line summary** — what the function does (not how)
- **Each parameter** — name, expected type, meaning, valid range if relevant
- **Return value** — what it is, what it means
- **Exceptions/errors** — when they are thrown and why
- **Side effects** — if the function mutates state, writes to disk, sends a request, say so explicitly

### What NOT to document
```js
// ❌ Restates the code — adds zero value
/**
 * Gets the user.
 * @param {number} id - The id.
 * @returns {object} The user.
 */
function getUser(id) { return db.find(id); }

// ✅ Only document when it adds information the signature doesn't already give
/**
 * Retrieves an active user by ID.
 * Returns null if the user exists but has been soft-deleted.
 *
 * @param {number} id - The user's database ID.
 * @returns {User|null} The user, or null if not found or deactivated.
 */
function getUser(id) { ... }
```

---

### One responsibility per function

```js
// ❌ Does validation, computation, persistence AND notification
function processOrder(order) {
  if (!order.items.length) throw new Error("Empty order");
  order.total = order.items.reduce((s, i) => s + i.price, 0);
  db.save(order);
  emailService.send(order.customerEmail, "Order confirmed");
}

// ✅ Each step is named, isolated, and independently testable
function processOrder(order) {
  const validated = validateOrder(order);
  const priced    = calculateOrderTotal(validated);
  const saved     = saveOrder(priced);
  notifyCustomer(saved);
}
```

---

### Keep functions short
Aim for functions short enough to fit on a typical screen without scrolling — roughly 30 lines as a soft upper bound for the main body.
The real signal: if a function has distinct "sections" that each need a comment to explain them, split it into named functions.

For an agent: count lines excluding blank lines and single-line braces. If a function crosses 30 lines, justify each block above that limit — and extract the ones that don't need to be there.

```js
// ❌ Two mental sections inside one function
function handleUserLogin(credentials) {
  // Validate
  if (!credentials.email) throw new Error("Email required");
  if (!credentials.password) throw new Error("Password required");

  // Authenticate
  const user = db.findByEmail(credentials.email);
  if (!user || !bcrypt.compare(credentials.password, user.hash)) {
    throw new Error("Invalid credentials");
  }
  return generateToken(user);
}

// ✅ Each section becomes its own function
function handleUserLogin(credentials) {
  validateCredentials(credentials);
  const user = authenticateUser(credentials);
  return generateToken(user);
}
```

---

### Limit parameters — group into an object/struct when there are too many

When a function has many parameters (typically 4+), consider grouping them into an object or struct — the exact threshold depends on your language's conventions.

```js
// ❌ Hard to remember the order, easy to mix up arguments
function createUser(name, email, role, isActive, sendEmail) { ... }
createUser("Alice", "alice@x.com", "admin", true, false); // ← what is false?

// ✅ Self-documenting at the call site
function createUser({ name, email, role, isActive, sendWelcomeEmail }) { ... }
createUser({ name: "Alice", email: "alice@x.com", role: "admin", isActive: true, sendWelcomeEmail: false });
```

---

### No magic numbers — use named constants

```js
// ❌
if (user.loginAttempts > 5) lockAccount(user);
setTimeout(refreshToken, 3600000); // JavaScript-specific — adapt to your language

// ✅
const MAX_LOGIN_ATTEMPTS = 5;
const TOKEN_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

if (user.loginAttempts > MAX_LOGIN_ATTEMPTS) lockAccount(user);
setTimeout(refreshToken, TOKEN_REFRESH_INTERVAL_MS); // JavaScript-specific — adapt to your language
```

---

### CQS — Command Query Separation
A function either **does something** (command) or **returns something** (query). Never both.

```js
// ❌ Saves AND returns — hidden side effect
function saveAndGetUser(data) {
  db.save(data);
  return db.find(data.id);
}

// ✅ Separated — each function has a predictable contract
function saveUser(data) { db.save(data); }
function getUserById(id) { return db.find(id); }
```

> **Note:** ORM methods that return the saved object (e.g., `.save()` returning the entity with a generated ID) are acceptable — CQS applies to your own API design, not to framework/library conventions.

---

### Tell, Don't Ask
Don't ask for an object's state to make a decision for it — tell it what to do.

```js
// ❌ You're reaching into the object to make its decision
if (user.getAge() >= 18 && user.getStatus() === "active") {
  user.setAllowed(true);
}

// ✅ The object owns its own logic
user.checkEligibility(); // User decides internally
```

---

### Immutability — prefer not mutating parameters
Prefer returning new values over mutating inputs — be intentional about mutations and document them.

```js
// ❌ Mutates the original array — caller doesn't expect this
function addItem(cart, item) {
  cart.push(item) // ← side effect on the caller's data
  return cart
}

// ✅ Returns a new array — original is untouched
function addItem(cart, item) {
  return [...cart, item]
}

// ❌ Mutates the original object
function applyDiscount(order, rate) {
  order.total = order.total * (1 - rate) // ← mutates input
  return order
}

// ✅ Returns a new object
function applyDiscount(order, rate) {
  return { ...order, total: order.total * (1 - rate) }
}
```

---

### [JavaScript/TypeScript] Async / Await
Use your language's idiomatic async pattern consistently — in JavaScript, prefer `async/await` over `.then()` chains, as it reads linearly and errors are caught the same way as sync code.

```js
// ❌ .then() chains become hard to follow
function loadUserDashboard(userId) {
  return getUser(userId)
    .then(user => getOrders(user.id)
      .then(orders => ({ user, orders }))
    )
}

// ✅ async/await reads like synchronous code
async function loadUserDashboard(userId) {
  const user = await getUser(userId)
  const orders = await getOrders(user.id)
  return { user, orders }
}
```

Never mix `.then()` and `await` in the same function:
```js
// ❌
async function getUser(id) {
  return await fetch(`/api/users/${id}`)
    .then(res => res.json()) // mixing styles
}

// ✅
async function getUser(id) {
  const res = await fetch(`/api/users/${id}`)
  return res.json()
}
```

Always handle async errors explicitly — never let a Promise float unhandled:
```js
// ❌ Floating promise — errors silently swallowed
function handleSubmit() {
  saveOrder(order) // ← no await, no catch
}

// ✅ Error is handled
async function handleSubmit() {
  try {
    await saveOrder(order)
  } catch (error) {
    notifyUser('Failed to save order')
  }
}
```

When two async calls are independent, run them in parallel:
```js
// ❌ Sequential — unnecessarily slow
const user = await getUser(id)
const settings = await getSettings(id) // doesn't depend on user

// ✅ Parallel — both fire at the same time
const [user, settings] = await Promise.all([getUser(id), getSettings(id)])
```

---

### [TypeScript] Never use `any`
`any` disables all type checking — it defeats the entire purpose of TypeScript.
Use `unknown` instead, which forces you to check the type before using the value.

```ts
// ❌ any — TypeScript goes blind, no protection at all
function parseResponse(data: any) {
  return data.user.name // no error here even if user doesn't exist
}
```

For external data (API responses, user input, untyped third-party payloads), **use a validation library** (zod, valibot). Writing manual type guards by hand is verbose, error-prone, and violates KISS — the schema is the single source of truth for both the runtime check and the type.

```ts
// ✅ unknown + zod — the schema validates the shape and derives the type
import { z } from 'zod'

const ResponseSchema = z.object({ user: z.object({ name: z.string() }) })

function parseResponse(data: unknown) {
  return ResponseSchema.parse(data).user.name // throws with a clear message if invalid
}
```

> Manual `unknown` narrowing (cascading `typeof` checks and `as Record<string, unknown>` casts) is technically correct but unreadable and fragile. Avoid it for anything beyond a one-off primitive check — reach for a schema library instead.

```ts
// Full example: schema as single source of truth for type + validation
import { z } from 'zod'

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
})

type User = z.infer<typeof UserSchema> // type derived from schema — no separate interface to keep in sync

function parseUser(data: unknown): User {
  return UserSchema.parse(data) // throws a ValidationError with a clear message if invalid
}
```

Acceptable exceptions to avoid `any`:
- Migrating a large JS codebase to TS progressively → a temporary `any` may be the pragmatic step, but check the profile first: several profiles ban `any` outright with a gate, and a `TODO` without a linked issue is refused by the comment policy. A rule your project enforces beats a rule of thumb read here.
- Third-party libraries with no types and no `@types/` package available

---

### [TypeScript] Narrowing `unknown` safely — type guards & assertion functions
Once you've accepted `unknown`, you need to turn it into a concrete type before use. Two idiomatic mechanisms, each with a clear use case:

**Type guards** return a boolean and narrow the type *only inside the branch where the check passed*. Use them for conditional logic.

```ts
// Custom type guard — the `x is T` return type narrows in the truthy branch
function isApiError(e: unknown): e is ApiError {
  return typeof e === 'object' && e !== null && 'status' in e && 'message' in e
}

if (isApiError(err)) {
  console.log(err.status) // TS knows err is ApiError here
}
```

**Assertion functions** throw at runtime and narrow the type *for all code after the call*. Use them when a value must be a certain shape to proceed — a fail-fast boundary check expressed as a type.

```ts
// Assertion function — `asserts x is T` narrows after the call, throws if wrong
function assertUser(data: unknown): asserts data is User {
  if (!(typeof data === 'object' && data !== null && 'id' in data)) {
    throw new ValidationError('data', 'expected a User')
  }
}

assertUser(payload) // from here on, payload is User — no cast needed
```

**Choose between the two:**

| Need | Use |
|---|---|
| Branch on a type (handle both cases) | Type guard (`x is T`) |
| Fail fast if a value isn't the expected shape | Assertion function (`asserts x is T`) |
| Validate external data with a schema | zod / valibot (covers both at once) |

> **Avoid bare `as` casts.** `data as User` silently lies to the compiler — it narrows without any runtime check. Prefer an assertion function (checks + narrows + throws) or a schema. `as` is acceptable only in tests where you deliberately feed invalid data.

---

### DRY — extract duplicated logic

```js
// ❌ Same logic copy-pasted in two places
function getAdminFullName(id) {
  const user = db.find(id);
  return `${user.firstName} ${user.lastName}`;
}
function getCustomerFullName(id) {
  const user = db.find(id);
  return `${user.firstName} ${user.lastName}`;
}

// ✅ Single source of truth
function getFullName(id) {
  const user = db.find(id);
  return `${user.firstName} ${user.lastName}`;
}
```

---

### Pure functions & referential transparency
A **pure function** is deterministic (same input → same output) and has no side effects: it doesn't mutate its inputs, write to disk, send requests, or read mutable global state. A pure call can be replaced by its return value without changing the program — this is **referential transparency**, and it's what makes functions easy to test, cache, and reason about.

```js
// ❌ Referentially opaque — result depends on when you call it
function getDiscountRate() {
  return isBlackFriday(new Date()) ? 0.3 : 0.1 // hidden dependency on "now"
}

// ✅ Referentially transparent — same input, same output, every time
function getDiscountRate(today: Date): number {
  return isBlackFriday(today) ? 0.3 : 0.1
}
```

Aim for purity where it's cheap; push side effects to the edges of your system (I/O, DB, UI) so the core logic stays pure and testable. Not every function can or should be pure — but the ones that contain your business rules should be.

> **In code review:** flag hidden non-determinism (`Date.now()`, `Math.random()`, `process.env` read mid-logic, mutable module-level state) inside a function that looks like a pure calculation.