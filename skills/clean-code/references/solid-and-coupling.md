> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## SOLID & Coupling

> **Language note:** Examples use JavaScript/TypeScript. Apply the same principles in your project's language, following its idioms and conventions.

> **Language-agnostic:** SOLID is universally applicable — only the *mechanism* differs by language. Java/C# express abstractions via `interface`, Python via duck typing or `abc.ABC`, Rust via `trait`, Go via implicit interfaces, Kotlin/Swift via `protocol`. Dependency Injection in particular: use constructor injection (Java, C#, TS), trait/protocol bounds (Rust, Swift), or implicit interface satisfaction (Go). The examples below use JS classes for brevity; translate to your language's construct.

---

### S — Single Responsibility
One class = one reason to change.

```js
// ❌ Handles data, formatting AND persistence
class Invoice {
  calculate() { ... }
  formatAsPDF() { ... }
  saveToDatabase() { ... }
}

// ✅ Each class has one job
class Invoice {
  calculate() { ... }
}
class InvoicePDFFormatter {
  format(invoice) { ... }
}
class InvoiceRepository {
  save(invoice) { ... }
}
```

---

### O — Open/Closed
Open for extension, closed for modification.
Add behavior by adding code, not by editing existing code.

```js
// ❌ Every new discount type requires editing this function
function applyDiscount(order, type) {
  if (type === "student") return order.total * 0.9;
  if (type === "senior") return order.total * 0.8;
  // adding "vip" means editing here → risky
}

// ✅ Each strategy is isolated, core logic untouched
class StudentDiscount {
  apply(total) { return total * 0.9; }
}
class SeniorDiscount {
  apply(total) { return total * 0.8; }
}
class VIPDiscount {
  apply(total) { return total * 0.7; }
}

function applyDiscount(order, discountStrategy) {
  return discountStrategy.apply(order.total);
}
```

The same pattern in Python uses no classes — duck typing is enough:

```python
# ✅ Each strategy is a small function with the same shape; core logic untouched
def student_discount(total: float) -> float:
    return total * 0.9

def senior_discount(total: float) -> float:
    return total * 0.8

def apply_discount(order, discount_strategy) -> float:
    return discount_strategy(order.total)

# Adding "vip" = one new function, zero edits to apply_discount
def vip_discount(total: float) -> float:
    return total * 0.7
```

---

### L — Liskov Substitution
A subclass must be usable anywhere the parent is used, without breaking behavior.

```js
// ❌ Square breaks Rectangle's contract
class Rectangle {
  setWidth(w) { this.width = w; }
  setHeight(h) { this.height = h; }
  area() { return this.width * this.height; }
}

class Square extends Rectangle {
  setWidth(w) { this.width = w; this.height = w; } // ← breaks expectations
  setHeight(h) { this.width = h; this.height = h; }
}

const r = new Square();
r.setWidth(4);
r.setHeight(5);
r.area(); // expected 20, got 25 ← Liskov violated

// ✅ Don't force the inheritance — use a common interface instead
class Shape {
  area() { throw new Error("Not implemented"); }
}
class Rectangle extends Shape {
  constructor(w, h) { super(); this.w = w; this.h = h; }
  area() { return this.w * this.h; }
}
class Square extends Shape {
  constructor(s) { super(); this.s = s; }
  area() { return this.s * this.s; }
}
```

---

### I — Interface Segregation
No class should be forced to implement methods it doesn't need.
Prefer several focused interfaces over one fat interface.

```js
// ❌ Printer is forced to implement fax() and scan() it doesn't support
class OldPrinter {
  print(doc) { ... }
  fax(doc) { throw new Error("Not supported"); }    // ← forced stub
  scan(doc) { throw new Error("Not supported"); }   // ← forced stub
}

// ✅ Split into focused interfaces
class Printer {
  print(doc) { ... }
}
class Scanner {
  scan(doc) { ... }
}
class MultiFunctionPrinter extends Printer {
  scan(doc) { ... }
  fax(doc) { ... }
}
```

> Split interfaces when implementations are forced to stub unused methods — don't split for the sake of splitting.
```

---

### D — Dependency Inversion
Depend on abstractions, not on concrete implementations.
High-level modules should not import low-level details directly.

> Inject dependencies when you need testability or flexibility. For stable, unlikely-to-change dependencies, direct usage is acceptable.

```js
// ❌ OrderService is tightly coupled to MySQL
class OrderService {
  constructor() {
    this.db = new MySQLDatabase(); // ← hardcoded dependency
  }
  save(order) { this.db.save(order); }
}

// ✅ Inject the dependency — any storage works
class OrderService {
  constructor(database) {
    this.db = database; // ← depends on abstraction
  }
  save(order) { this.db.save(order); }
}

// Usage — swap without touching OrderService
const service = new OrderService(new MySQLDatabase());
const testService = new OrderService(new InMemoryDatabase());
```

---

### Low Coupling / High Cohesion

**High Cohesion**: things that change together, live together.
```js
// ❌ UserService handles auth, email AND billing → low cohesion
class UserService {
  login() { ... }
  sendWelcomeEmail() { ... }
  chargeSubscription() { ... }
}

// ✅ Each service owns its domain
class AuthService { login() { ... } }
class NotificationService { sendWelcomeEmail() { ... } }
class BillingService { chargeSubscription() { ... } }
```

**Low Coupling**: modules don't need to know each other's internals.
```js
// ❌ OrderService reaches into UserService's internals
class OrderService {
  process(order) {
    const user = this.userService.repository.db.find(order.userId); // ← deep coupling
  }
}

// ✅ UserService exposes a clean interface
class UserService {
  findById(id) { return this.repository.find(id); } // ← single entry point
}
class OrderService {
  process(order) {
    const user = this.userService.findById(order.userId); // ← only touches the interface
  }
}
```

---

### Law of Demeter
A method should only call methods on: itself, its parameters, objects it creates, its direct fields.

```js
// ❌ OrderService knows too much about the object graph
order.getCustomer().getAddress().getCity();

// ✅ Delegate — Order knows its own customer city
class Order {
  getCustomerCity() {
    return this.customer.getCity();
  }
}
order.getCustomerCity();
```

---

### Composition over Inheritance

Prefer composition over inheritance — use inheritance for genuine IS-A relationships or when your framework requires it.

```js
// ❌ Deep inheritance becomes brittle fast
class Animal {}
class Pet extends Animal {}
class Dog extends Pet {}
class TrainedDog extends Dog {} // ← what if we need TrainedCat too?

// ✅ Compose behaviors independently
const canBark = (base) => ({ ...base, bark: () => "Woof!" });
const canFetch = (base) => ({ ...base, fetch: () => "Fetching!" });
const canSit = (base) => ({ ...base, sit: () => "Sitting!" });

const trainedDog = canSit(canFetch(canBark({ name: "Rex" })));
```

---

## When to introduce an abstraction (agent decision guide)

**YAGNI beats SOLID** means don't add abstractions "just in case". Apply SOLID
principles when they solve a concrete problem. Use these signals instead of gut
feeling:

**Introduce the abstraction when:**
- You have ≥ 3 call sites duplicating the same conditional or shape (e.g.
  `if (type === "student" || type === "senior" || ...)` scattered in multiple
  places) — the duplication itself is the concrete problem.
- A dependency is hard to test without mocking — inject it (Dependency Inversion).
- A class grows beyond its natural domain and you can name a second class that
  owns the extracted piece cleanly (Single Responsibility).
- Adding a new variant currently requires editing an existing function/class —
  that's the concrete signal for Open/Closed.

**Do NOT introduce the abstraction when:**
- There is only one call site, and the extraction would create a one-off module
  no one else will use.
- The "abstraction" is a wrapper around a single external library with no
  likely replacement.
- You can explain the behavior in plain language more easily than the abstraction.

**For agents:** prefer extracting a small, pure function first. If that function
is reused or the caller becomes cleaner, keep it. If it sits alone and complicates
the call site, inline it.