> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Interface Design

> **Language note:** Examples use JavaScript/TypeScript. Apply the same principles in your project's language, following its idioms and conventions.

---

### Principle of Least Surprise
The code should behave exactly as its name suggests.
No hidden side effects, no unexpected mutations.

```js
// ❌ getUser() suggests a read — but it mutates lastSeen
function getUser(id) {
  const user = db.find(id);
  user.lastSeen = Date.now(); // ← unexpected side effect
  return user;
}

// ✅ Side effect is explicit and separate
function getUser(id) { return db.find(id); }
function recordLastSeen(id) { db.update(id, { lastSeen: Date.now() }); }
```

---

### Principle of Least Knowledge
Expose only what is necessary. Keep internals private.

The example below uses JavaScript private fields (`#`). Translate to your
language's mechanism for encapsulation:

| Language | Mechanism |
|---|---|
| TypeScript / JavaScript | `#field` private fields |
| Java | `private` modifier |
| C# | `private` / `internal` / `protected internal` |
| Python | `_prefix` convention, `__name` name mangling, or `@property` |
| Go | Unexported lowercase identifiers |
| Rust | Module privacy — `pub` only what is needed |
| PHP | `private` / `protected` |

```js
// ❌ Exposes internal structure — callers depend on implementation details
class OrderService {
  constructor() {
    this.repository = new OrderRepository();  // ← public, anyone can poke at it
    this.validator = new OrderValidator();    // ← same
  }
}
// Caller does: orderService.repository.db.find(id)  ← deep coupling

// ✅ Single public interface, internals hidden (JS private fields shown)
class OrderService {
  #repository = new OrderRepository();
  #validator = new OrderValidator();

  getOrder(id) { return this.#repository.find(id); }
  placeOrder(data) {
    this.#validator.validate(data);
    return this.#repository.save(data);
  }
}
```

---

### Narrow interfaces over wide ones (Interface Segregation)

```js
// ❌ One fat interface — implementors are forced to stub methods they don't need
class DataProcessor {
  readCSV() {}
  readJSON() {}
  readXML() {}    // ← not every processor needs XML
  writeCSV() {}
  writeJSON() {}
  generateReport() {}  // ← mixing concerns
}

// ✅ Split by concern — implement only what's relevant
class CSVReader { read(file) { ... } }
class JSONReader { read(file) { ... } }
class CSVWriter { write(data, file) { ... } }
class ReportGenerator { generate(data) { ... } }
```

---

### [TypeScript] Avoid weak types (all-optional interfaces)
A **weak type** is an interface or type whose every property is optional. TS gives weak types a special check (an object with none of the expected properties is rejected), but a weak type still signals an **under-specified contract**: callers can pass `{}` and your function can't rely on anything.

```ts
// ❌ Weak type — nothing is guaranteed, every field is optional
interface UpdateUserOptions {
  name?: string
  email?: string
  role?: string
}
function updateUser(id: number, opts: UpdateUserOptions) {
  // Every access needs a null check; the type promises nothing
  if (opts.name) { /* ... */ }
}

// ✅ Required where the function depends on it; optional only where it genuinely is
interface UpdateUserOptions {
  name: string        // the one thing updateUser actually requires
  email?: string
  role?: string
}
```

**In review:** an interface where *all* properties are `?` is usually a smell — either some fields should be required, or the type should be a discriminated union of the real shapes callers pass.

---

### Composition over deep abstraction
Prefer building a clear, flat interface rather than deep method chains.

```js
// ❌ Caller must know the entire object graph
const city = order.getCustomer().getAddress().getCity();

// ✅ Order exposes what callers actually need
class Order {
  getShippingCity() { return this.customer.address.city; }
}
const city = order.getShippingCity();
```