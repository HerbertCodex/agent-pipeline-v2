> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Robustness

> **Language note:** Examples use JavaScript/TypeScript. Apply the same principles in your project's language, following its idioms and conventions.

---

### Fail Fast
Detect and report errors as early as possible.
Don't let invalid state propagate through the system.
**This is non-negotiable** — every function must fail loudly at the entry point rather than silently deep inside.

**Rule: guard clauses first, logic last.**
Place all precondition checks at the top of the function before any logic runs.

```js
// ❌ Invalid state silently flows through — error surfaces far from its cause
function processPayment(order) {
  const total = order.total; // could be undefined
  charge(total);             // fails here with a cryptic error
}

// ✅ All guards up front — logic is never reached with invalid input
function processPayment(order) {
  if (!order) throw new Error("processPayment: order is required");
  if (typeof order.total !== "number") throw new Error(`processPayment: invalid total "${order.total}"`);
  if (order.total <= 0) throw new Error(`processPayment: total must be positive, got ${order.total}`);
  charge(order.total);
}
```

**Guard clause pattern — always prefer early return over nested logic:**

```js
// ❌ Logic buried inside nested conditions
function getDiscount(user, cart) {
  if (user) {
    if (cart.items.length > 0) {
      if (user.isPremium) {
        return cart.total * 0.2;
      }
    }
  }
  return 0;
}

// ✅ Fail fast, then flat logic
function getDiscount(user, cart) {
  if (!user) return 0;
  if (cart.items.length === 0) return 0;
  if (!user.isPremium) return 0;
  return cart.total * 0.2;
}
```

**Never assume an external value is valid — check at the boundary:**

```js
// ❌ Assumes env var exists — will fail cryptically at runtime
const db = new Database(process.env.DATABASE_URL);

// ✅ Fail fast at startup with a clear message
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL env var is required but not set");
const db = new Database(DATABASE_URL);
```

**In async code, fail fast before any await:**

```js
// ❌ Makes a network call before checking input
async function sendEmail(to, subject, body) {
  const result = await mailer.send({ to, subject, body }); // fails inside mailer
}

// ✅ Validate synchronously first — no wasted I/O on bad input
async function sendEmail(to, subject, body) {
  if (!to || !to.includes("@")) throw new Error(`sendEmail: invalid recipient "${to}"`);
  if (!subject) throw new Error("sendEmail: subject is required");
  if (!body) throw new Error("sendEmail: body is required");
  const result = await mailer.send({ to, subject, body });
  return result;
}
```

---

### Never bypass null safety — across all languages

Every language has a way to say "trust me, this isn't null" — and every one of them
causes runtime crashes when you're wrong. **Never use them.** Always check explicitly.

**TypeScript — non-null assertion `!`:**
```ts
// ❌ Tells TypeScript to ignore null — crashes at runtime if user is null
const name = user!.name;

// ✅ Narrow the type explicitly — TypeScript and the runtime are both safe
if (!user) throw new Error("user is required");
const name = user.name;

// ✅ Or use optional chaining with a fallback
const name = user?.name ?? "Anonymous";
```

**Kotlin — non-null assertion `!!`:**
```kotlin
// ❌ Crashes with NullPointerException if user is null
val name = user!!.name

// ✅ Use safe call + Elvis operator
val name = user?.name ?: throw IllegalArgumentException("user is required")
```

**Swift — forced unwrap `!`:**
```swift
// ❌ Fatal error at runtime if user is nil
let name = user!.name

// ✅ Use guard let or if let
guard let user = user else { throw AppError.missingUser }
let name = user.name
```

**C# — null-forgiving operator `!`:**
```csharp
// ❌ Suppresses the nullable warning — NullReferenceException at runtime
var name = user!.Name;

// ✅ Guard first
if (user is null) throw new ArgumentNullException(nameof(user));
var name = user.Name;
```

**Rust — `.unwrap()` on Option/Result:**
```rust
// ❌ Panics at runtime if the value is None or Err
let name = user.unwrap().name;
let config = std::env::var("API_KEY").unwrap();

// ✅ Handle both cases explicitly
let user = get_user(id).ok_or(AppError::UserNotFound(id))?;
let api_key = std::env::var("API_KEY")
    .map_err(|_| AppError::MissingEnvVar("API_KEY"))?;
```

> `.expect("msg")` is slightly better than `.unwrap()` because it prints a message,
> but it still panics — only acceptable in one-off scripts or tests.

**PHP — array access without checking:**
```php
// ❌ Undefined index warning / null if key doesn't exist
$name = $data['name'];

// ✅ Use null coalescing or explicit check
$name = $data['name'] ?? throw new \InvalidArgumentException('name is required');
```

**Python — attribute/key access without checking:**
```python
# ❌ AttributeError or KeyError if value is None/missing
name = user.name
name = data['name']

# ✅ Guard first
if user is None:
    raise ValueError("user is required")
name = user.name

# ✅ Or use .get() with a default/exception
name = data.get('name') or raise_error('name is required in data')
```

**Java — no null safety by default:**
```java
// ❌ NullPointerException if user is null
String name = user.getName();

// ✅ Use Objects.requireNonNull at the entry point
String name = Objects.requireNonNull(user, "user is required").getName();

// ✅ Or use Optional
Optional<User> maybeUser = findUser(id);
String name = maybeUser
    .map(User::getName)
    .orElseThrow(() -> new IllegalArgumentException("user not found: " + id));
```

**The rule applies everywhere:** if a value can be null/None/nil/absent,
check it explicitly at the entry point. Never suppress the compiler warning
and never assume it's set. Fail fast with a clear message.

---

### Defensive Programming
Validate at the boundary of your system (API endpoints, user input, external data).
Inside the system, trust your own validated types — don't re-validate everywhere.

```js
// ❌ No validation — bad data silently enters the system
app.post("/users", (req, res) => {
  db.save({ email: req.body.email, age: req.body.age });
});

// ✅ Validate at the entry point, trust downstream
app.post("/users", (req, res) => {
  const { email, age } = req.body;
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Invalid email" });
  if (!Number.isInteger(age) || age < 0) return res.status(400).json({ error: "Invalid age" });
  db.save({ email, age }); // safe from here on
});
```

---

### Structured error handling
Use typed errors/exceptions for domain-specific failures — built-in exception types (`ValueError`, `KeyError`, `ArgumentException`, etc.) are acceptable for standard violations. Never throw raw strings.

```js
// ❌ Raw strings — impossible to catch selectively
throw 'User not found'
throw 'Invalid email'

// ✅ Custom error classes for domain-specific errors — use built-in exceptions for generic violations
class NotFoundError extends Error {
  constructor(resource, id) {
    super(`${resource} with id "${id}" not found`)
    this.name = 'NotFoundError'
  }
}

class ValidationError extends Error {
  constructor(field, message) {
    super(`Validation failed on "${field}": ${message}`)
    this.name = 'ValidationError'
  }
}

// Caller can now catch selectively
try {
  const user = await getUser(id)
} catch (error) {
  if (error instanceof NotFoundError) return res.status(404).json({ error: error.message })
  if (error instanceof ValidationError) return res.status(400).json({ error: error.message })
  throw error // re-throw unexpected errors — don't silently swallow them
}
```

---

### Result / Either pattern (TypeScript)
For operations that can fail in expected ways, consider returning a `Result` type
instead of throwing — this makes failure explicit in the function's signature.

> Result types are idiomatic in languages with sum types (Rust, TypeScript). In other languages, use your platform's error handling conventions.

```ts
type Result<T, E = Error> =
  | { ok: true;  value: T }
  | { ok: false; error: E }

async function getUser(id: number): Promise<Result<User, NotFoundError>> {
  const user = await db.find(id)
  if (!user) return { ok: false, error: new NotFoundError('User', id) }
  return { ok: true, value: user }
}

// Caller is forced to handle both cases
const result = await getUser(id)
if (!result.ok) {
  return res.status(404).json({ error: result.error.message })
}
const user = result.value // TypeScript knows this is User here
```

> Use `Result` for **expected** failures (not found, validation, auth).
> Use `throw` for **unexpected** failures (DB down, network error, programming mistakes).

---

### [TypeScript] Exhaustiveness checking — let the compiler fail fast for you
When you switch over a union, assign the result to the `never` type in the default branch. If a new variant is added to the union later and you forget a case, the compiler turns the silent gap into a build error — fail fast at compile time, before it reaches production.

```ts
type Event = { type: 'click'; x: number; y: number }
            | { type: 'scroll'; delta: number }
            | { type: 'focus' }

function handleEvent(event: Event) {
  switch (event.type) {
    case 'click':  return trackClick(event.x, event.y)
    case 'scroll': return trackScroll(event.delta)
    case 'focus':  return trackFocus()
    default:
      // If a new variant is added to Event, this line fails to compile:
      const _exhaustive: never = event
      throw new Error(`Unhandled event: ${JSON.stringify(event)}`)
  }
}
```

> This pairs with discriminated unions (the shared `type` tag) and is the TS-native way to make "I forgot a case" a compile error rather than a runtime bug.

### Never silently swallow errors
```js
// ❌ Error disappears — impossible to debug
try {
  await saveOrder(order)
} catch (error) {
  // nothing
}

// ❌ Logging but continuing as if nothing happened
try {
  await saveOrder(order)
} catch (error) {
  console.error(error) // logged but execution continues silently
}

// ✅ Handle, log, and decide explicitly
try {
  await saveOrder(order)
} catch (error) {
  logger.error('Failed to save order', { orderId: order.id, error })
  throw error // or return a Result, or show user feedback — but never ignore
}
```

---
Write correct, readable code first.
Only optimize after profiling proves a bottleneck exists.

```js
// ❌ Premature optimization — complex cache introduced before any evidence of slowness
function getUserById(id) {
  if (!this._cache) this._cache = {};
  if (this._cache[id]) return this._cache[id];
  const user = db.find(id);
  this._cache[id] = user;
  return user; // Was db.find() even slow? We don't know.
}

// ✅ Start simple — add caching only once profiling shows db.find() is the bottleneck
function getUserById(id) {
  return db.find(id);
}
```

---

### Comments: explain WHY, not WHAT

A comment must add information the code cannot say. If you are summarizing
the code, delete the comment and make the code clearer.

```js
// ❌ Restates the code — adds no value
// Increment i by 1
i++;

// ❌ Explains what, not why
// Filter users where age > 18
const adults = users.filter(u => u.age > 18);

// ❌ Section divider — the function should be split instead
// ======================
//   Payment processing
// ======================

// ❌ End-of-block or end-of-function marker — never use these
// End of processOrder

// ❌ AI sign-off / boilerplate — never leave these
// This function is now complete
// TODO: review later
// Main logic starts here

// ✅ Explains the non-obvious reason
// EU compliance: users under 18 cannot consent to data processing (GDPR Art. 8)
const eligibleUsers = users.filter(u => u.age >= GDPR_MINIMUM_CONSENT_AGE);
```

**If a block needs a comment to explain WHAT it does, extract it into a named function.** The function name becomes the explanation.

```js
// ❌ Needs a comment because the block is unnamed
function processOrder(order) {
  // Calculate discount
  let discount = 0;
  if (order.customer.isPremium) discount = order.total * 0.1;
  if (order.coupon) discount += order.coupon.amount;
  // ...
}

// ✅ Block becomes a function; the name replaces the comment
function processOrder(order) {
  const discount = calculateDiscount(order);
  // ...
}
```

**No section comments.** If you feel the urge to add `// Validation`, `// Helpers`, or `// Main logic`, the code has grouping problems — extract functions or reorganize.

**No end-of-function markers.** A closing brace needs no signature comment.
Leave every piece of code slightly cleaner than you found it.
Don't refactor the whole file — just improve what you touch.

```js
// You're adding a feature to this function:
// ❌ Leave the mess untouched
function processOrder(o, f, s) { // ← bad names, your new code fits right in
  ...
}

// ✅ Rename while you're here — small improvement, zero risk
function processOrder(order, flags, session) {
  ...
}
```