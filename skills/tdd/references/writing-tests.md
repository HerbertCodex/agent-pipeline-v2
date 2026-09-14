> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

> **Language-agnostic**: Examples use Jest and TypeScript. Apply the same principles with your project's test framework and language. For framework equivalents, see `references/language-transposition.md`.

## Writing Tests

---

### AAA — Arrange / Act / Assert
Every test follows three distinct phases. Separate them visually with a blank line.

```ts
test('applies a discount to the order total', () => {
  // Arrange — set up the data and context
  const items = [{ price: 100 }, { price: 50 }]
  const discountRate = 0.1

  // Act — call the unit under test
  const total = calculateTotal(items, discountRate)

  // Assert — verify the outcome
  expect(total).toBe(135)
})
```

Never mix Arrange and Assert — the test becomes hard to read and debug.

---

### Test naming — describe behavior, not implementation
A good test name reads like a sentence describing what the system does.
Format: `[unit] [condition] [expected outcome]`

```ts
// ❌ Describes implementation — tells you nothing if it fails
test('calculateTotal function', () => { ... })
test('test discount logic', () => { ... })

// ✅ Describes behavior — failing test is self-explanatory
test('calculateTotal returns 0 for an empty cart', () => { ... })
test('calculateTotal applies percentage discount to subtotal', () => { ... })
test('isValidPassword rejects passwords shorter than 8 characters', () => { ... })
test('isValidPassword accepts passwords with at least one digit and one uppercase', () => { ... })
```

---

### Test one concept per test
One test = one reason to fail. Not one assertion — one *concept*.

```ts
// ❌ Multiple concepts — which one failed?
test('processes order', () => {
  const result = processOrder(order)
  expect(result.total).toBe(90)
  expect(result.status).toBe('confirmed')
  expect(result.emailSent).toBe(true)
})

// ✅ Each concept gets its own test
test('processOrder calculates discounted total', () => {
  expect(processOrder(order).total).toBe(90)
})
test('processOrder sets status to confirmed', () => {
  expect(processOrder(order).status).toBe('confirmed')
})
test('processOrder triggers a confirmation email', () => {
  expect(processOrder(order).emailSent).toBe(true)
})
```

---

### What to test

**Test behavior and outcomes — not implementation details.**

```ts
// ❌ Tests internal structure — breaks on every refactor
test('calls the discount formula', () => {
  const spy = jest.spyOn(math, 'multiply')
  calculateTotal(items, 0.1)
  expect(spy).toHaveBeenCalledWith(150, 0.9) // internal detail
})

// ✅ Tests the observable outcome
test('applies a 10% discount to the total', () => {
  expect(calculateTotal(items, 0.1)).toBe(135)
})
```

**Test edge cases and boundaries — not just the happy path.**

```ts
// Happy path
test('calculates total for multiple items', () => { ... })

// Edge cases
test('returns 0 for an empty cart', () => { ... })
test('handles items with a price of 0', () => { ... })
test('throws when discount rate is greater than 1', () => { ... })
test('handles a single item', () => { ... })
```

---

### What NOT to test

- **Private / internal functions** — test them through the public API
- **Third-party libraries** — assume they work (they have their own tests)
- **Framework internals** — don't test that React renders a `<div>`
- **Trivial getters/setters** — unless they contain logic

```ts
// ❌ Testing a trivial getter — no logic, no value
test('getName returns the name', () => {
  const user = new User('Alice')
  expect(user.getName()).toBe('Alice')
})

// ✅ Testing logic inside a getter
test('getDisplayName returns "Anonymous" when name is empty', () => {
  const user = new User('')
  expect(user.getDisplayName()).toBe('Anonymous')
})
```

---

### Parameterized tests — test.each
<!-- Adapt syntax to your test framework: pytest.mark.parametrize, @DataProvider, [Theory], etc. -->
When the same logic needs to be verified with multiple inputs, use `test.each`
(or your framework's equivalent) instead of duplicating tests. Duplication in tests is as bad as in production code.

```ts
// ❌ Copy-pasted tests — hard to maintain, easy to miss a case
test('rejects password "Ab1"', () => {
  expect(isValidPassword('Ab1')).toBe(false)
})
test('rejects password "abcdefg1"', () => {
  expect(isValidPassword('abcdefg1')).toBe(false)
})
test('rejects password "Abcdefgh"', () => {
  expect(isValidPassword('Abcdefgh')).toBe(false)
})

// ✅ Parameterized — one test, all cases, clear failure messages
test.each([
  ['too short',          'Ab1',      false],
  ['no uppercase',       'abcdefg1', false],
  ['no digit',          'Abcdefgh', false],
  ['valid password',     'Abcdefg1', true ],
  ['minimum length',     'Abcdef1A', true ],
])(
  'isValidPassword: %s → %s',
  (_, password, expected) => {
    expect(isValidPassword(password)).toBe(expected)
  }
)
```

Use `test.each` when:
- The same function is tested with more than 2-3 different inputs
- The only difference between tests is the data, not the behavior being tested
- You're testing boundary values (0, -1, max, min, empty, null)

```ts
// Boundary values — ideal for test.each
test.each([
  [0,   0  ],
  [1,   0.9],
  [0.5, 50 ],
  [1.1, null], // invalid — should throw
])(
  'calculateDiscount: rate %d → total %s',
  (rate, expected) => {
    if (expected === null) {
      expect(() => calculateDiscount(100, rate)).toThrow(ValidationError)
    } else {
      expect(calculateDiscount(100, rate)).toBe(expected)
    }
  }
)
```

---

### Test data — factories and builders
Hard-coded objects scattered across tests are fragile — a schema change breaks
every test that builds the object manually. Centralize test data creation.

**Object Mother** — a factory function that returns a valid default object,
with optional overrides for the properties you care about:

```ts
// factories/user.factory.ts
export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    name: 'Alice',
    email: 'alice@example.com',
    role: 'customer',
    isActive: true,
    createdAt: new Date('2024-01-01'),
    ...overrides,  // override only what matters for this test
  }
}

// In tests — each test only specifies what's relevant
test('deactivated users cannot place orders', () => {
  const user = makeUser({ isActive: false })
  expect(() => placeOrder(user, cart)).toThrow(ForbiddenError)
})

test('admin users can access the dashboard', () => {
  const user = makeUser({ role: 'admin' })
  expect(canAccessDashboard(user)).toBe(true)
})
```

**Builder pattern** — for complex objects with many optional fields:

```ts
// factories/order.builder.ts
export class OrderBuilder {
  private order: Order = {
    id: 1,
    customerId: 1,
    items: [{ productId: 1, quantity: 1, price: 100 }],
    status: 'pending',
    discountRate: 0,
  }

  withDiscount(rate: number): this {
    this.order.discountRate = rate
    return this
  }
  withItems(items: OrderItem[]): this {
    this.order.items = items
    return this
  }
  withStatus(status: OrderStatus): this {
    this.order.status = status
    return this
  }
  build(): Order {
    return { ...this.order }
  }
}

// In tests — reads like a sentence
test('cancelled orders cannot be refunded', () => {
  const order = new OrderBuilder()
    .withStatus('cancelled')
    .withItems([{ productId: 1, quantity: 2, price: 50 }])
    .build()

  expect(() => refundOrder(order)).toThrow(InvalidOperationError)
})
```

Use factories when:
- The same object is built in more than 2 tests
- Tests only care about 1-2 properties but the object has many required fields
- A schema change would otherwise require updating every test

---

### Setup & Teardown
Use setup and teardown hooks to avoid repeating Arrange code across tests.
Choose the right hook for the right scope — using the wrong one creates hidden dependencies.

| Hook | Runs | Use for |
|---|---|---|
| `beforeEach` | before **every** test | reset state, create fresh instances |
| `afterEach` | after **every** test | clean up side effects, restore mocks |
| `beforeAll` | once before **all** tests in the block | expensive one-time setup (DB connection) |
| `afterAll` | once after **all** tests in the block | close connections, release resources |

**Prefer `beforeEach` for test isolation** — use `beforeAll` only for expensive, truly read-only setup. `beforeEach` guarantees each test starts with a clean slate:

```ts
// ❌ beforeAll — tests share state, order-dependent failures
let user: User

beforeAll(() => {
  user = makeUser()         // one instance shared across all tests
})

test('activates the user', () => {
  user.activate()
  expect(user.isActive).toBe(true)
})
test('deactivates the user', () => {
  user.deactivate()
  expect(user.isActive).toBe(false) // may fail depending on test order
})

// ✅ beforeEach — each test gets a fresh instance, no shared state
let user: User

beforeEach(() => {
  user = makeUser({ isActive: false }) // fresh for every test
})

test('activates the user', () => {
  user.activate()
  expect(user.isActive).toBe(true)
})
test('deactivates the user', () => {
  user.deactivate()
  expect(user.isActive).toBe(false) // always passes regardless of order
})
```

**Async setup:** when setup is asynchronous, return the promise or use `async` so
frameworks wait for completion. Never leave a floating promise in a setup hook.

```ts
// ✅ Await async setup
beforeEach(async () => {
  await db.seed(testFixtures)
})
```

**Use `beforeAll` only for expensive, truly read-only setup:**

```ts
// ✅ beforeAll is fine here — DB connection is shared but never mutated
let db: Database

beforeAll(async () => {
  db = await createTestDatabase()
})

afterAll(async () => {
  await db.close() // always clean up in afterAll
})

beforeEach(async () => {
  await db.seed(testFixtures) // reset data before each test
})
```

**Use `afterEach` to restore mocks and clean up side effects:**

```ts
const emailSpy = jest.spyOn(emailService, 'send')

afterEach(() => {
  emailSpy.mockClear()    // reset call count between tests
  // or:
  emailSpy.mockRestore()  // fully restore original implementation
})
```

**Keep setup close to the tests that need it** — don't put everything in a top-level
`beforeEach` if only one `describe` block needs it:

```ts
// ❌ Top-level setup that only 2 out of 10 tests use
beforeEach(() => {
  seedAdminFixtures() // slow, irrelevant for most tests
})

// ✅ Scoped setup inside the describe block that needs it
describe('admin actions', () => {
  beforeEach(() => {
    seedAdminFixtures() // only runs for tests in this block
  })

  test('admin can delete a post', () => { ... })
  test('admin can ban a user', () => { ... })
})
```

---

### Hard to test = design problem
If a function is hard to test, it's a signal — not an excuse to skip the test.

| Symptom | Likely design problem |
|---|---|
| Need to set up a lot of state | Function does too much (SRP) |
| Need to mock many dependencies | High coupling |
| Can't control inputs | Hidden global state or hardcoded dependency |
| Tests break on every refactor | Testing implementation details |

Fix the design first, then write the test.