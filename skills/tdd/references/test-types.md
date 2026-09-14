> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

> **Language-agnostic**: Examples use Jest, TypeScript, and Playwright. Apply the same principles with your project's test framework and language. For framework-specific test equivalents, see `references/language-transposition.md`.

## Test Types

---

### The Testing Pyramid

```
        /\
       /e2e\        ← few, slow, expensive — test full user flows
      /------\
     /integra-\     ← some — test modules working together
    /  tion    \
   /------------\
  /    unit      \  ← many, fast, cheap — test isolated logic
 /________________\
```

Write mostly unit tests, some integration tests, and few e2e tests.
Inverting the pyramid (many e2e, few unit) leads to slow, brittle test suites.

---

### Unit tests — isolated logic

Test a single function or class in complete isolation.
All dependencies are stubbed or mocked.

```ts
// Pure function — no mocking needed
test('calculateTotal applies discount to subtotal', () => {
  expect(calculateTotal([{ price: 100 }], 0.1)).toBe(90)
})

// Function with dependencies — inject stubs
test('processOrder applies user discount', async () => {
  const db = { findUser: jest.fn().mockResolvedValue({ discount: 0.1 }) }
  const result = await processOrder({ userId: 1, items: [{ price: 100 }] }, { db })
  expect(result.total).toBe(90)
})
```

**Use unit tests for:**
- Business logic and computation
- Validation rules
- Data transformation
- Error handling paths

**Do not use unit tests for:**
- Verifying that a framework renders a component correctly — use integration or
  e2e tests for that.
- Testing that a database query returns rows — use integration tests.

---

### Integration tests — modules working together

Test how two or more real modules interact.
Use a real (but isolated) database, a real HTTP client, or a real file system.

```ts
// Tests the real repository against a test database
test('UserRepository.findById returns null for unknown id', async () => {
  const db = await createTestDatabase() // isolated test DB
  const repo = new UserRepository(db)

  const user = await repo.findById(999)
  expect(user).toBeNull()

  await db.close()
})

// Tests the API layer + service + repository together
test('POST /orders creates an order and returns 201', async () => {
  const res = await request(app)
    .post('/orders')
    .send({ userId: 1, items: [{ productId: 5, quantity: 2 }] })

  expect(res.status).toBe(201)
  expect(res.body).toMatchObject({ status: 'confirmed' })
})
```

**Use integration tests for:**
- Repository / database interactions
- API endpoints (controller + service + repository)
- Third-party service integrations

---

### E2E tests — full user flows

Test the entire application from the outside, simulating real user actions.
No mocks — everything is real.

**Use e2e tests for:**
- Critical user journeys (signup, checkout, login)
- Cross-service workflows
- Smoke tests in CI/CD before deployment

**Keep e2e tests to a minimum** — they are slow, flaky, and expensive to maintain.
For detailed e2e guidance, see the `e2e-testing` skill rather than duplicating
it here.

---

### Choosing the right type

| Scenario | Test type |
|---|---|
| Discount calculation logic | Unit |
| Password validation rules | Unit |
| `UserRepository.save()` against real DB | Integration |
| `POST /users` endpoint full stack | Integration |
| User signs up and receives welcome email | E2E |
| Checkout flow end-to-end | E2E |

When in doubt: **start with a unit test**. Add an integration test if the unit test
can't catch the real failure mode (e.g. a SQL query shape). Add e2e only for critical flows.
