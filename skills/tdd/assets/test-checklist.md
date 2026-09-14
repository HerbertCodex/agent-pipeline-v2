> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Test Review Checklist

---

### Critical — block delivery if any fail
- [ ] Every new behavior has at least one test that fails before implementation
- [ ] Every bug fix has a regression test that reproduces the bug before the fix
- [ ] Tests cover: happy path + at least one edge case + at least one error case
- [ ] All tests pass — no failing or skipped tests without documented reason
- [ ] Tests are independent — no shared mutable state between tests
- [ ] No tests that always pass regardless of implementation (tautological tests)
- [ ] No tests of implementation details (internal structure, private helpers, call order of unobservable internals)

---

### Test Driven Development cycle
- [ ] Each new behavior started with a failing test (Red before Green)
- [ ] Each test was watched failing before implementation was written
- [ ] Implementation was minimal — no logic beyond what the tests demanded
- [ ] Refactoring happened only under green — not during Red or Green phases
- [ ] Untested code touched for this change has at least one characterization test

---

### Test structure
- [ ] Each test follows AAA — Arrange / Act / Assert with blank lines between phases
- [ ] One concept tested per test (one reason to fail)
- [ ] Minimal logic in tests (avoid if/for/while) — conditionals and loops can hide bugs in the test itself
- [ ] Repeated logic with different inputs uses parameterized tests (`test.each` or language equivalent)
- [ ] Test data built with factories or builders — no raw object literals scattered across tests
- [ ] `beforeEach` used by default — not `beforeAll` — to guarantee a clean slate per test
- [ ] `beforeAll` used only for expensive, read-only setup (DB connections)
- [ ] `afterEach` restores mocks and cleans up side effects
- [ ] Setup scoped to the block that needs it — not hoisted to top-level unnecessarily

---

### Naming
- [ ] Test names describe behavior: `[unit] [condition] [expected outcome]`
- [ ] No vague names (`test1`, `works correctly`, `handles data`)
- [ ] Failing test name alone tells you what broke and why

---

### What is tested
- [ ] Happy path covered
- [ ] Edge cases covered (empty input, zero, null, max boundaries)
- [ ] Error paths covered (what happens when it fails)
- [ ] Behavior tested, not implementation details
- [ ] No tests on trivial getters, setters, or pure framework glue
- [ ] Private/internal functions tested through the public API

---

### Mocking
- [ ] Mocks used only for dependencies with side effects (DB, HTTP, email, filesystem) or slow dependencies where speed matters for the feedback loop
- [ ] No mocking of pure logic functions
- [ ] Stubs return realistic data — not just `{}` or `true`
- [ ] Spies are restored after each test (`mockRestore` or language equivalent)
- [ ] No over-mocking — tests don't mirror the implementation step-by-step

---

### Test health
- [ ] Tests are independent — no shared mutable state between tests
- [ ] Tests run in any order without affecting each other
- [ ] No `setTimeout` or arbitrary `sleep` — use proper async/await or framework helpers
- [ ] Async tests await all assertions; no floating promises
- [ ] Test database / filesystem cleaned up after each test
- [ ] No permanently skipped tests — temporary skips have a comment explaining why and a plan to re-enable
