> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

> **Language/framework transposition**: the examples in this skill use Jest and
> TypeScript. Use this map to apply the same concepts in your project's language
> and test framework.

## Core TDD concepts

| Concept | Jest / TS | Python (pytest) | Go (testing) | Java (JUnit 5) | Rust (built-in) | .NET (xUnit) |
|---|---|---|---|---|---|---|
| Test function | `test('...', () => {})` | `def test_...():` | `func Test...(t *testing.T)` | `@Test void ...() {}` | `#[test] fn ...() {}` | `[Fact] public void ...() {}` |
| Assertion | `expect(x).toBe(y)` | `assert x == y` | `if x != y { t.Errorf(...) }` | `assertEquals(y, x)` | `assert_eq!(x, y)` | `Assert.Equal(y, x)` |
| Exception / error | `expect(() => ...).toThrow()` | `with pytest.raises(...)` | `if err == nil { t.Fatalf(...) }` | `assertThrows(...)` | `assert!(result.is_err())` | `Assert.Throws<T>(...)` |
| Parameterized test | `test.each([...])` | `@pytest.mark.parametrize` | table-driven test with loop | `@ParameterizedTest` + `@CsvSource` | `#[test_case(...)]` | `[Theory] + [InlineData]` |
| Setup before each test | `beforeEach` | `pytest` fixture with `function` scope | inside `Test...` function or helper | `@BeforeEach` | setup inside the test function | constructor / `[SetUp]` |
| Teardown after each test | `afterEach` | fixture `yield` then cleanup | `t.Cleanup` or defer | `@AfterEach` | RAII / drop | `Dispose` / `[TearDown]` |
| Setup once per suite | `beforeAll` | `pytest` fixture with `session` scope | `TestMain` or package init | `@BeforeAll` | `#[test]` cannot; use `lazy_static` cautiously | `IClassFixture<T>` / `[ClassInitialize]` |
| Mock / stub | `jest.fn()` | `unittest.mock` / `pytest-mock` | manual interfaces / `gomock` | Mockito / EasyMock | mock traits / hand-rolled fakes | Moq / NSubstitute |
| Spy | `jest.spyOn(obj, 'method')` | `unittest.mock` patch + call args | wrap real implementation | Mockito `spy()` | wrap and record manually | Moq `Verify` / callback |
| Fake / in-memory dependency | plain object with same shape | in-memory dict/list class | in-memory struct implementing interface | in-memory class implementing interface | in-memory struct implementing trait | in-memory class implementing interface |

## Notes by language

### TypeScript / JavaScript
- Use `test.each` for table-driven cases.
- Use `jest.spyOn` only when you must observe a real method; restore it with
  `mockRestore()` in `afterEach`.
- Prefer dependency injection over `jest.mock` module-level mocking — it keeps
  tests decoupled from module layout.

### Python
- `pytest` fixtures replace `beforeEach`/`beforeAll`. Scope carefully:
  `function` for fresh state, `session` for expensive read-only setup.
- Use `unittest.mock.Mock` for stubs/spies, `monkeypatch` for replacing
  module-level functions.
- `pytest.raises` is the idiomatic way to assert exceptions.

### Go
- Table-driven tests are idiomatic: a slice of test cases with a `for _, tc :=`
  loop.
- No built-in mocking; define interfaces for dependencies and inject fakes or
  generated mocks (`mockery`, `gomock`).
- Use `t.Fatalf` / `t.Errorf` for assertions; `t.Helper` for custom helpers.

### Java
- JUnit 5 + AssertJ is a common, readable combination.
- Use `@Nested` to group related tests and keep setup scoped.
- Mockito is standard; verify spies are reset in `@AfterEach`.

### Rust
- Tests live alongside code in `src/` or in `tests/` for integration tests.
- Use `rstest` for parameterized tests if you want Jest-like ergonomics.
- Mocking is less common than in other ecosystems; prefer traits + hand-rolled
  fakes or crates such as `mockall`.

### .NET
- xUnit's constructor runs before each test (like `beforeEach`). Use
  `IClassFixture` or `ICollectionFixture` for shared expensive setup.
- `Moq` or `NSubstitute` for mocking; ensure mocks are verified or reset.
- `FluentAssertions` provides readable assertions.
