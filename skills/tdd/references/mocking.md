> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

> **Language-agnostic**: Examples use Jest and TypeScript. Adapt mock/stub/spy syntax to your test framework's mocking API. See `references/language-transposition.md` for common equivalents.

## Mocking

---

### The three types of test doubles

| Type | What it does | Use when |
|---|---|---|
| **Stub** | Returns a fixed value | You need to control what a dependency returns |
| **Mock** | Records calls + verifiable | You need to assert a side effect happened |
| **Spy** | Wraps the real function + records calls | You want real behavior but also observe calls |

---

### Stub — control return values

```ts
// You want to test order processing without hitting the real DB
const userRepository = {
  findById: jest.fn().mockResolvedValue({ id: 1, name: 'Alice', discount: 0.1 })
}

test('processOrder applies the user discount', async () => {
  const result = await processOrder({ userId: 1, items: [{ price: 100 }] }, userRepository)
  expect(result.total).toBe(90)
})
```

---

### Mock — verify a side effect occurred

```ts
// You want to verify a confirmation email was sent
const emailService = { send: jest.fn() }

test('processOrder sends a confirmation email', async () => {
  // Arrange
  await processOrder(order, { emailService })

  // Assert the side effect
  expect(emailService.send).toHaveBeenCalledOnce()
  expect(emailService.send).toHaveBeenCalledWith({
    to: order.customerEmail,
    subject: 'Order confirmed',
  })
})
```

---

### Spy — observe without replacing

```ts
// You want real behavior but need to verify the call happened
const spy = jest.spyOn(logger, 'error')

test('getUser logs an error when user is not found', async () => {
  await getUser(999) // non-existent ID
  expect(spy).toHaveBeenCalledWith('User not found', { id: 999 })
})

afterEach(() => spy.mockRestore()) // always restore spies
```

---

### When to mock

```
✅ Mock when:
- The dependency has side effects (DB, email, HTTP, filesystem)
- The dependency is slow (network calls, heavy computation)
- You need to simulate an error or edge case that's hard to reproduce
- You want to isolate the unit from its collaborators

❌ Don't mock when:
- The dependency is pure logic with no side effects (just call it)
- You end up mocking the thing you're actually testing
- Mocking makes the test harder to read than the code itself
```

---

### Prefer dependency injection to make mocking easy

```ts
// ❌ Hardcoded dependency — impossible to mock without module-level tricks
async function getUser(id: number) {
  return await MySQLDatabase.getInstance().findUser(id) // ← tightly coupled
}

// ✅ Injected dependency — easy to stub in tests
async function getUser(id: number, db: UserRepository) {
  return await db.findUser(id)
}

// In tests
const db = { findUser: jest.fn().mockResolvedValue({ id: 1, name: 'Alice' }) }
const user = await getUser(1, db)

// In production
const user = await getUser(1, new MySQLUserRepository())
```

---

### Don't over-mock — it creates brittle tests

```ts
// ❌ Over-mocked — the test mirrors the implementation exactly
// Any internal refactor breaks this, even if behavior is unchanged
test('processOrder calls repository.save with correct data', () => {
  const repo = { save: jest.fn() }
  processOrder(order, repo)
  expect(repo.save).toHaveBeenCalledWith({
    ...order,
    total: 90,
    status: 'pending',
    createdAt: expect.any(Date),
  })
})

// ✅ Tests the observable outcome, not the internal call
test('processOrder returns a confirmed order with correct total', async () => {
  const result = await processOrder(order, repo)
  expect(result.total).toBe(90)
  expect(result.status).toBe('confirmed')
})
```